//! The minimal AI surface: a few Settings fields, one key in the credential store, and one
//! feature — turning staged changes into a commit message.
//!
//! Kept deliberately narrow. The panel is not a chat client: it makes exactly one request per
//! click, streams the answer into the commit box, and the user still reviews and commits. The
//! network call lives here rather than in the webview so the key never enters the page, and the
//! streaming shape reuses the `Channel` + `op_id` pattern the git commands already use.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use keyring_core::Entry;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use crate::commands;

/// What a staged diff is asked to become. The first line is a Conventional Commit subject, then a
/// blank line and a short body; nothing else, and no fences around the answer.
const SYSTEM_PROMPT: &str = "You are a git commit message writer. Write a Conventional Commit \
message for the staged diff below: a first line `<type>(<scope>): <subject>` at most 72 \
characters, then a blank line, then a short body of the key changes. Reply with only the commit \
message. Do not explain, do not add a preamble, do not wrap it in code fences.";

/// The character budget for the staged patch inside the request.
const CONTEXT_LIMIT: usize = 48_000;

/// One event pushed over the channel while the message is written.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiCommitEvent {
  Delta { text: String },
  Done { text: String },
  Error { code: String, detail: String },
}

/// Shared state: the table of cancellable streaming requests, mirroring `GitOps`.
pub struct AiState {
  cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

impl Default for AiState {
  fn default() -> Self {
    Self {
      cancels: Mutex::new(HashMap::new()),
    }
  }
}

/// The one account every AI key lives under. A digest rather than a readable name, so the
/// credential store never spells out what the secret is for — and the `ai-` prefix keeps it out
/// of the encrypted-file store's own bookkeeping.
fn account() -> String {
  let digest = Sha256::digest(b"ai-key");
  format!(
    "ai-{}",
    digest.iter().map(|b| format!("{b:02x}")).collect::<String>()
  )
}

fn entry() -> Result<Entry, String> {
  let store = crate::unlock::system_store().ok_or("ai_keyring_unavailable")?;
  store
    .build(crate::unlock::CREDENTIAL_SERVICE, &account(), None)
    .map_err(|e| format!("ai_keyring_unavailable:{e}"))
}

fn has_key() -> bool {
  entry()
    .ok()
    .and_then(|e| e.get_password().ok())
    .is_some_and(|secret| !secret.is_empty())
}

#[tauri::command(async)]
pub fn ai_key_status() -> Result<bool, String> {
  Ok(has_key())
}

#[tauri::command(async)]
pub fn ai_set_key(key: String) -> Result<(), String> {
  let key = key.trim();
  if key.is_empty() {
    return Err("ai_key_empty".into());
  }
  entry()?
    .set_password(key)
    .map_err(|e| format!("ai_keyring_unavailable:{e}"))
}

#[tauri::command(async)]
pub fn ai_clear_key() -> Result<(), String> {
  match entry()?.delete_credential() {
    Ok(()) => Ok(()),
    Err(keyring_core::Error::NoEntry) => Ok(()),
    Err(e) => Err(format!("ai_keyring_unavailable:{e}")),
  }
}

#[tauri::command(async)]
pub fn ai_cancel(state: State<'_, AiState>, op_id: String) {
  if let Some(flag) = state.cancels.lock().expect("ai cancel lock poisoned").get(&op_id) {
    flag.store(true, Ordering::SeqCst);
  }
}

/// Stream a commit message for what is staged.
///
/// Validation failures reject before any bytes move; a failure once the stream has started is an
/// `Error` event instead, so the caller can still keep the half-written message.
#[tauri::command]
pub async fn ai_commit_message(
  app: AppHandle,
  state: State<'_, AiState>,
  root: String,
  op_id: String,
  on_event: Channel<AiCommitEvent>,
) -> Result<(), String> {
  let settings = commands::settings_of(&app);
  if !settings.ai_enabled {
    return Err("ai_disabled".into());
  }
  let base_url = settings.ai_base_url.trim_end_matches('/').to_string();
  let model = settings.ai_model;
  let timeout_ms = settings.ai_timeout_ms;

  // Local loopback needs no key; a remote host does. `http://` is only ever loopback, since
  // `filled()` drops any other plain-http endpoint.
  let loopback = base_url.starts_with("http://");
  if !loopback && !has_key() {
    return Err("ai_key_missing".into());
  }
  let key = if loopback {
    None
  } else {
    entry().ok().and_then(|e| e.get_password().ok())
  };

  let patch = crate::git::diff::staged_patch(&root)?;
  if patch.trim().is_empty() {
    return Err("ai_no_staged".into());
  }

  let cancel = Arc::new(AtomicBool::new(false));
  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .insert(op_id.clone(), cancel.clone());

  let result = stream_message(&base_url, &model, key.as_deref(), &patch, timeout_ms, &cancel, &on_event).await;

  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .remove(&op_id);
  result
}

fn truncate(text: &str, limit: usize) -> String {
  if text.chars().count() <= limit {
    return text.to_string();
  }
  let mut out: String = text.chars().take(limit).collect();
  out.push_str("\n[truncated]");
  out
}

fn map_status(status: reqwest::StatusCode) -> String {
  match status.as_u16() {
    401 | 403 => "ai_auth_failed".into(),
    429 => "ai_rate_limited".into(),
    other => format!("ai_http:{other}"),
  }
}

fn map_network(error: reqwest::Error) -> String {
  if error.is_timeout() {
    "ai_timeout".into()
  } else {
    format!("ai_network:{error}")
  }
}

async fn stream_message(
  base_url: &str,
  model: &str,
  key: Option<&str>,
  patch: &str,
  timeout_ms: u32,
  cancel: &AtomicBool,
  on_event: &Channel<AiCommitEvent>,
) -> Result<(), String> {
  let messages = serde_json::json!([
    { "role": "system", "content": SYSTEM_PROMPT },
    { "role": "user", "content": format!("<diff>\n{}\n</diff>", truncate(patch, CONTEXT_LIMIT)) }
  ]);
  let body = serde_json::json!({
    "model": model,
    "messages": messages,
    "stream": true,
    "temperature": 0.2,
  });

  let client = reqwest::Client::builder()
    .timeout(Duration::from_millis(u64::from(timeout_ms)))
    .build()
    .map_err(|e| format!("ai_network:{e}"))?;

  let mut request = client
    .post(format!("{base_url}/chat/completions"))
    .json(&body);
  if let Some(key) = key {
    request = request.bearer_auth(key);
  }

  let response = request.send().await.map_err(map_network)?;
  if !response.status().is_success() {
    return Err(map_status(response.status()));
  }

  use futures_util::StreamExt;
  let mut stream = response.bytes_stream();
  let mut pending = String::new();
  let mut full = String::new();
  let mut done = false;

  while let Some(chunk) = stream.next().await {
    if cancel.load(Ordering::SeqCst) {
      break;
    }
    let chunk = chunk.map_err(|e| format!("ai_network:{e}"))?;
    pending.push_str(&String::from_utf8_lossy(&chunk));

    // Split on line boundaries, keeping a possibly-partial last line for the next chunk.
    loop {
      let Some(pos) = pending.find('\n') else { break };
      let mut line = pending[..pos].to_string();
      pending.drain(..=pos);
      if line.ends_with('\r') {
        line.pop();
      }
      if line.is_empty() {
        continue;
      }
      let Some(data) = line.strip_prefix("data:") else {
        continue;
      };
      let data = data.trim_start();
      if data == "[DONE]" {
        done = true;
        break;
      }
      if let Ok(value) = serde_json::from_str::<serde_json::Value>(data) {
        if let Some(text) = value["choices"][0]["delta"]["content"].as_str() {
          if !text.is_empty() {
            full.push_str(text);
            let _ = on_event.send(AiCommitEvent::Delta { text: text.to_string() });
          }
        }
      }
    }
    if done {
      break;
    }
  }

  let _ = on_event.send(AiCommitEvent::Done { text: full });
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::commands::Settings;

  #[test]
  fn account_is_stable_and_prefixed() {
    let a = account();
    assert!(a.starts_with("ai-"));
    assert_eq!(a.len(), 3 + 64);
    assert_eq!(a, account());
  }

  #[test]
  fn truncate_caps_and_marks() {
    assert_eq!(truncate("abc", 10), "abc");
    let long = truncate(&"x".repeat(100), 10);
    assert!(long.ends_with("[truncated]"));
    assert_eq!(long.chars().count(), 10 + "\n[truncated]".chars().count());
  }

  #[test]
  fn url_rules_keep_https_and_loopback_only() {
    let base = |url: &str| {
      Settings {
        ai_base_url: url.to_string(),
        ..Default::default()
      }
      .filled()
      .ai_base_url
    };
    assert_eq!(base("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1");
    assert_eq!(base("http://localhost:11434/v1"), "http://localhost:11434/v1");
    assert_eq!(base("http://evil.example.com/v1"), "https://api.openai.com/v1");
    assert_eq!(base("ftp://x"), "https://api.openai.com/v1");
    assert_eq!(base(""), "https://api.openai.com/v1");
  }
}
