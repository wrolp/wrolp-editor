//! The minimal AI surface: a few Settings fields, one key kept in the settings file, and one
//! feature — turning staged changes into a commit message.
//!
//! Kept deliberately narrow. The panel is not a chat client: it makes exactly one request per
//! click, streams the answer into the commit box, and the user still reviews and commits. The
//! streaming shape reuses the `Channel` + `op_id` pattern the git commands already use.
//!
//! The key is not stored as plain text in `settings.json`: it goes in as Windows DPAPI
//! ciphertext, which only the current Windows account can read back. That is what lets the
//! settings page show the key again instead of merely saying one exists, and it is also why a
//! configuration backup can carry the file: the copy cannot be decrypted elsewhere.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine as _;
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

/// Extra entropy both directions mix in. Not a secret of its own; it keeps this app's blob from
/// being the same bytes another program would get for the same text.
const ENTROPY: &[u8] = b"wrolp-ai-key";

/// Encrypt a secret for this Windows account.
#[cfg(windows)]
fn protect(plain: &str) -> Result<String, String> {
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
  };

  let mut data = plain.as_bytes().to_vec();
  let mut entropy = ENTROPY.to_vec();
  let input = CRYPT_INTEGER_BLOB {
    cbData: data.len() as u32,
    pbData: data.as_mut_ptr(),
  };
  let extra = CRYPT_INTEGER_BLOB {
    cbData: entropy.len() as u32,
    pbData: entropy.as_mut_ptr(),
  };
  let mut output = CRYPT_INTEGER_BLOB {
    cbData: 0,
    pbData: std::ptr::null_mut(),
  };
  // No prompt: the key is being saved by this user, and a dialog here would be a second way to
  // fail in the middle of a save.
  let ok = unsafe {
    CryptProtectData(
      &input,
      std::ptr::null(),
      &extra,
      std::ptr::null(),
      std::ptr::null(),
      CRYPTPROTECT_UI_FORBIDDEN,
      &mut output,
    )
  };
  if ok == 0 {
    return Err("ai_key_protect".into());
  }
  let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
  unsafe { LocalFree(output.pbData as _) };
  Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The plaintext behind a blob written by [`protect`]. An error here means this account cannot
/// read it: another machine, another user, or a blob that is not ours.
#[cfg(windows)]
fn unprotect(blob: &str) -> Result<String, String> {
  use windows_sys::Win32::Foundation::LocalFree;
  use windows_sys::Win32::Security::Cryptography::{
    CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
  };

  let mut data = base64::engine::general_purpose::STANDARD
    .decode(blob.trim())
    .map_err(|_| "ai_key_unreadable".to_string())?;
  let mut entropy = ENTROPY.to_vec();
  let input = CRYPT_INTEGER_BLOB {
    cbData: data.len() as u32,
    pbData: data.as_mut_ptr(),
  };
  let extra = CRYPT_INTEGER_BLOB {
    cbData: entropy.len() as u32,
    pbData: entropy.as_mut_ptr(),
  };
  let mut output = CRYPT_INTEGER_BLOB {
    cbData: 0,
    pbData: std::ptr::null_mut(),
  };
  let mut description: *mut u16 = std::ptr::null_mut();
  let ok = unsafe {
    CryptUnprotectData(
      &input,
      &mut description,
      &extra,
      std::ptr::null(),
      std::ptr::null(),
      CRYPTPROTECT_UI_FORBIDDEN,
      &mut output,
    )
  };
  if ok == 0 {
    return Err("ai_key_unreadable".into());
  }
  let bytes = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
  unsafe {
    LocalFree(output.pbData as _);
    if !description.is_null() {
      LocalFree(description as _);
    }
  }
  String::from_utf8(bytes).map_err(|_| "ai_key_unreadable".into())
}

#[cfg(not(windows))]
fn protect(_plain: &str) -> Result<String, String> {
  Err("ai_key_unsupported".into())
}

#[cfg(not(windows))]
fn unprotect(_blob: &str) -> Result<String, String> {
  Err("ai_key_unsupported".into())
}

/// The account an earlier build used in the credential store, so its key can be moved out. A
/// digest rather than a readable name, and the `ai-` prefix keeps it out of the encrypted-file
/// store's own bookkeeping.
fn legacy_account() -> String {
  let digest = Sha256::digest(b"ai-key");
  format!(
    "ai-{}",
    digest
      .iter()
      .map(|b| format!("{b:02x}"))
      .collect::<String>()
  )
}

fn legacy_entry() -> Option<Entry> {
  let store = crate::unlock::system_store()?;
  store
    .build(crate::unlock::CREDENTIAL_SERVICE, &legacy_account(), None)
    .ok()
}

fn legacy_key() -> Option<String> {
  legacy_entry()?
    .get_password()
    .ok()
    .filter(|key| !key.is_empty())
}

fn forget_legacy() {
  if let Some(entry) = legacy_entry() {
    let _ = entry.delete_credential();
  }
}

/// The key of one endpoint, decrypted for a caller. `None` covers both "never saved" and "saved
/// somewhere this account cannot read": the settings page shows the same empty field either way.
fn stored_key(app: &AppHandle, endpoint_id: &str) -> Option<String> {
  let settings = commands::settings_of(app);
  let endpoint = settings
    .ai_endpoints
    .iter()
    .find(|endpoint| endpoint.id == endpoint_id)?;
  if !endpoint.key.trim().is_empty() {
    return unprotect(&endpoint.key).ok().filter(|key| !key.is_empty());
  }
  // An earlier build kept the key in the Windows credential store, for the single endpoint that
  // build had. Only the endpoint carried over from those settings may claim it; an endpoint
  // added afterwards has a key of its own or none. The old copy is dropped only once the new
  // one is on disk: a write that failed must not leave the key in neither place.
  if endpoint_id != "default" {
    return None;
  }
  let key = legacy_key()?;
  let mut settings = settings;
  if let Ok(blob) = protect(&key) {
    if let Some(endpoint) = settings
      .ai_endpoints
      .iter_mut()
      .find(|endpoint| endpoint.id == endpoint_id)
    {
      endpoint.key = blob;
    }
    if crate::commands::write_json(app, "settings.json", &settings).is_ok() {
      forget_legacy();
    }
  }
  Some(key)
}

/// The stored key of one endpoint, for the settings page to show back. Empty when none is
/// stored, or when the blob was written on another machine or account.
#[tauri::command(async)]
pub fn ai_key(app: AppHandle, endpoint_id: String) -> Result<String, String> {
  Ok(stored_key(&app, &endpoint_id).unwrap_or_default())
}

#[tauri::command(async)]
pub fn ai_set_key(app: AppHandle, endpoint_id: String, key: String) -> Result<(), String> {
  let key = key.trim();
  if key.is_empty() {
    return Err("ai_key_empty".into());
  }
  let mut settings = commands::settings_of(&app);
  let endpoint = settings
    .ai_endpoints
    .iter_mut()
    .find(|endpoint| endpoint.id == endpoint_id)
    .ok_or_else(|| "ai_endpoint_missing".to_string())?;
  endpoint.key = protect(key)?;
  crate::commands::write_json(&app, "settings.json", &settings)?;
  forget_legacy();
  Ok(())
}

#[tauri::command(async)]
pub fn ai_clear_key(app: AppHandle, endpoint_id: String) -> Result<(), String> {
  let mut settings = commands::settings_of(&app);
  let endpoint = settings
    .ai_endpoints
    .iter_mut()
    .find(|endpoint| endpoint.id == endpoint_id)
    .ok_or_else(|| "ai_endpoint_missing".to_string())?;
  endpoint.key.clear();
  crate::commands::write_json(&app, "settings.json", &settings)?;
  forget_legacy();
  Ok(())
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
  // The endpoint the settings page marked as in use; the first one when that id no longer
  // exists (a hand-edited file, or an endpoint removed mid-edit).
  let endpoint = settings
    .ai_endpoints
    .iter()
    .find(|endpoint| endpoint.id == settings.ai_active)
    .or_else(|| settings.ai_endpoints.first())
    .ok_or_else(|| "ai_endpoint_missing".to_string())?;
  let endpoint_id = endpoint.id.clone();
  let base_url = endpoint.base_url.trim_end_matches('/').to_string();
  let model = endpoint.model.clone();
  let timeout_ms = settings.ai_timeout_ms;

  // Local loopback needs no key; a remote host does. `http://` is only ever loopback, since
  // `filled()` drops any other plain-http endpoint.
  let loopback = base_url.starts_with("http://");
  let key = stored_key(&app, &endpoint_id);
  if !loopback && key.is_none() {
    return Err("ai_key_missing".into());
  }
  let key = if loopback { None } else { key };

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

/// The model ids the endpoint offers, from `GET /models` — the one read-only call every
/// OpenAI-compatible service answers. Sorted and deduplicated so the list reads the same on
/// every fetch.
#[tauri::command]
pub async fn ai_models(app: AppHandle, endpoint_id: String) -> Result<Vec<String>, String> {
  let settings = commands::settings_of(&app);
  if !settings.ai_enabled {
    return Err("ai_disabled".into());
  }
  // The endpoint the settings page is editing, which is not always the active one: the list is
  // asked for while the reader is already looking at that endpoint's fields.
  let endpoint = settings
    .ai_endpoints
    .iter()
    .find(|endpoint| endpoint.id == endpoint_id)
    .ok_or_else(|| "ai_endpoint_missing".to_string())?;
  let base_url = endpoint.base_url.trim_end_matches('/').to_string();
  let loopback = base_url.starts_with("http://");
  let key = stored_key(&app, &endpoint_id);
  if !loopback && key.is_none() {
    return Err("ai_key_missing".into());
  }

  let client = reqwest::Client::builder()
    // A list is a short answer; waiting the commit timeout for it would leave the button busy
    // for a minute and a half over a typo in the endpoint.
    .timeout(Duration::from_millis(u64::from(settings.ai_timeout_ms.min(30_000))))
    .build()
    .map_err(|e| format!("ai_network:{e}"))?;
  let mut request = client.get(format!("{base_url}/models"));
  if let Some(key) = key.as_deref() {
    request = request.bearer_auth(key);
  }
  let response = request.send().await.map_err(map_network)?;
  if !response.status().is_success() {
    return Err(map_status(response.status()));
  }
  let value: serde_json::Value = response
    .json()
    .await
    .map_err(|e| format!("ai_models:{e}"))?;
  let models = model_ids(&value);
  if models.is_empty() {
    return Err("ai_models_empty".into());
  }
  Ok(models)
}

/// `data[].id` out of an OpenAI-compatible model list; anything else is an empty list, which
/// the command turns into "the endpoint answered something else".
fn model_ids(value: &serde_json::Value) -> Vec<String> {
  let mut ids: Vec<String> = value["data"]
    .as_array()
    .map(|rows| {
      rows
        .iter()
        .filter_map(|row| row["id"].as_str().map(str::to_string))
        .collect()
    })
    .unwrap_or_default();
  ids.sort();
  ids.dedup();
  ids
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
  fn legacy_account_is_stable_and_prefixed() {
    let a = legacy_account();
    assert!(a.starts_with("ai-"));
    assert_eq!(a.len(), 3 + 64);
    assert_eq!(a, legacy_account());
  }

  /// The key must survive the round trip to the settings file and still be unreadable as
  /// stored: that is what "encrypted, and can be shown again" means. The blob is DPAPI-bound,
  /// so only Windows can run this.
  #[cfg(windows)]
  #[test]
  fn a_key_round_trips_through_dpapi() {
    let blob = protect("sk-test-123").expect("protect");
    assert_ne!(blob, "sk-test-123");
    assert!(!blob.contains("sk-test-123"));
    assert_eq!(unprotect(&blob).expect("unprotect"), "sk-test-123");
  }

  #[cfg(windows)]
  #[test]
  fn a_blob_from_elsewhere_reads_as_no_key() {
    assert!(unprotect("not base64").is_err());
    assert!(unprotect("aGVsbG8=").is_err());
  }

  #[test]
  fn model_ids_take_the_openai_list_shape() {
    let value = serde_json::json!({
      "data": [
        { "id": "gpt-4o-mini" },
        { "id": "deepseek-chat" },
        { "id": "gpt-4o-mini" },
        { "object": "model" }
      ]
    });
    assert_eq!(model_ids(&value), vec!["deepseek-chat", "gpt-4o-mini"]);
    assert!(model_ids(&serde_json::json!({ "models": [] })).is_empty());
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
        ai_endpoints: vec![crate::commands::AiEndpoint {
          base_url: url.to_string(),
          ..Default::default()
        }],
        ..Default::default()
      }
      .filled()
      .ai_endpoints[0]
        .base_url
        .clone()
    };
    assert_eq!(base("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1");
    assert_eq!(base("http://localhost:11434/v1"), "http://localhost:11434/v1");
    assert_eq!(base("http://evil.example.com/v1"), "https://api.openai.com/v1");
    assert_eq!(base("ftp://x"), "https://api.openai.com/v1");
    assert_eq!(base(""), "https://api.openai.com/v1");
  }
}
