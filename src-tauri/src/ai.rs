//! The AI surface: a few Settings fields, one key kept in the settings file, a read-only chat
//! panel, and turning staged changes into a commit message.
//!
//! Both features share the same endpoint list and the same streaming shape: one request per
//! click or message, a `Channel` of events, and an `op_id` the caller can cancel. The chat is
//! deliberately read-only — it is given the context the reader attaches to a message and can
//! change nothing on its own.
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
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
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

/// What the chat is told it is. It says "read-only" because the panel has no way to change a
/// file, and a model that believes otherwise writes as if its answer had already landed.
const CHAT_SYSTEM_PROMPT: &str = "You are an assistant inside WROLP Editor, a local text \
editor. You can read only the context the reader attaches to a message; you cannot open other \
files, run commands, or change anything yourself. Answer in the language of the question. Be \
concrete and concise, and use Markdown for code.";

/// The character budget for the file or selection a chat message carries.
const CHAT_CONTEXT_LIMIT: usize = 32_768;
/// One message (history or question) beyond this is cut rather than sent.
const CHAT_TURN_LIMIT: usize = 48_000;
/// The oldest turns are dropped until the whole conversation fits this budget.
const CHAT_HISTORY_BUDGET: usize = 120_000;
/// Never send more turns than this, even when each is small.
const CHAT_TURN_COUNT: usize = 40;

/// What an inline completion is asked for. The answer is inserted at the caret, so anything
/// but the continuation itself — a fence, a preamble — would be typed into the document.
const COMPLETE_SYSTEM_PROMPT: &str = "You are an inline code completion engine inside a text \
editor. Continue the text at the cursor. Reply with only the text to insert: no explanation, no \
code fences, no quotes. Keep it short. If nothing useful can be continued, reply with an empty \
string.";

/// What the caret can see: 2,000 characters behind it and 500 ahead.
const COMPLETE_PREFIX_LIMIT: usize = 2_000;
const COMPLETE_SUFFIX_LIMIT: usize = 500;
/// A completion longer than this is cut rather than inserted into the document.
const COMPLETE_MAX_CHARS: usize = 2_000;

/// What an inline edit is told it is. The answer replaces the selection on `Enter`, so a fence
/// or a sentence about the change would be written into the document.
const EDIT_SYSTEM_PROMPT: &str = "You are an inline code editor inside a text editor. Rewrite \
only the selected text according to the instruction. Reply with only the replacement text: no \
explanation and no code fences. Keep the indentation the selection had. If the selection is \
already what the instruction asks for, reply with it unchanged.";

/// Everything the edit prompt may carry: the selection plus its neighbourhood. A selection
/// larger than this is refused rather than cut, because replacing half of it would be wrong.
const EDIT_BUDGET: usize = 16_384;
/// Lines of context kept on each side of the selection, before the character budget applies.
const EDIT_CONTEXT_LINES: usize = 100;
/// The instruction itself is short; a novel is cut.
const EDIT_INSTRUCTION_LIMIT: usize = 2_000;

/// The two tools the chat may propose. Both act on the file the reader has open and nowhere
/// else; the frontend asks for approval and never lets the model name a path.
const FILES_SYSTEM_PROMPT: &str = "You are an assistant inside WROLP Editor. You can work only \
with the one file the reader has open: you cannot list folders, open other files, run commands, \
or touch anything else. Call read_current_file whenever you need the file's text — the reader is \
asked before every read, and may decline. Call replace_in_current_file for changes; the reader \
sees the old and new text and approves each one. Use the smallest exact passage that does the \
job, copied verbatim including indentation. Never say a change is made until the tool reports \
it was applied. Answer in the language of the question.";

/// A tool turn is short; these caps keep a loop from growing without bound.
const FILES_MAX_MESSAGES: usize = 40;
const FILES_MAX_CHARS: usize = 160_000;
const FILES_MAX_TOOL_CALLS: usize = 12;

/// One tool call as the provider wrote it, with the arguments left as the JSON string it sent.
#[derive(Clone, Debug, Serialize)]
pub struct AiToolCall {
  pub id: String,
  pub name: String,
  pub arguments: String,
}

/// What one tool-enabled turn produced: prose for the reader, and the actions it wants to take.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiFilesTurn {
  pub text: String,
  pub tool_calls: Vec<AiToolCall>,
}

/// Sessions the store keeps, and messages one session keeps. Older entries are dropped on save.
const MAX_SESSIONS: usize = 20;
const MAX_SESSION_MESSAGES: usize = 100;

/// One event pushed over the channel while the message is written.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiCommitEvent {
  Delta { text: String },
  Done { text: String },
  Error { code: String, detail: String },
}

/// One event pushed over the channel while a chat answer is written.
///
/// `Done.reason` is `stop`, `length` or `canceled`; a failure after the first delta is an
/// `Error` and the caller keeps whatever text already arrived.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AiChatEvent {
  Delta {
    text: String,
  },
  Done {
    text: String,
    reason: String,
  },
  #[serde(rename_all = "camelCase")]
  Error {
    code: String,
    detail: String,
    retryable: bool,
  },
}

/// One chat request: the visible conversation plus the context attached to this message.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatRequest {
  pub op_id: String,
  #[serde(default)]
  pub messages: Vec<AiChatTurn>,
  /// The active file or selection, already captured when the send button was pressed.
  #[serde(default)]
  pub context: Option<String>,
  /// What the context is, shown to the model as a heading (`src/lib.rs, lines 4-9`).
  #[serde(default)]
  pub context_label: Option<String>,
}

/// One message as the frontend sends it. The role is checked against a whitelist in Rust; the
/// frontend never gets to put its own string into the request body unchecked.
#[derive(Deserialize)]
pub struct AiChatTurn {
  pub role: String,
  pub content: String,
}

/// One inline-edit request: what to change, what is selected, and the text around it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiEditRequest {
  pub op_id: String,
  pub instruction: String,
  pub selected: String,
  /// Everything in the document before the selection; the backend keeps the nearest 100 lines.
  #[serde(default)]
  pub before: String,
  /// Everything after the selection; the backend keeps the nearest 100 lines.
  #[serde(default)]
  pub after: String,
  #[serde(default)]
  pub language: String,
}

/// The chat history on disk. Whole-file read and write, like the group and history stores.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSessionStore {
  pub active: String,
  pub items: Vec<AiSession>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiSession {
  pub id: String,
  /// Derived from the first question when the frontend leaves it empty.
  pub title: String,
  pub created_at: String,
  pub updated_at: String,
  pub messages: Vec<AiStoredMessage>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AiStoredMessage {
  pub role: String,
  pub content: String,
  pub at: String,
  /// The answer was stopped, cut off or interrupted; the text is what did arrive.
  pub partial: bool,
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
pub(crate) fn protect(plain: &str) -> Result<String, String> {
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
pub(crate) fn unprotect(blob: &str) -> Result<String, String> {
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

/// The chat history as it was last saved. A missing file is an empty store, not an error: a
/// fresh install has simply never opened the panel.
#[tauri::command(async)]
pub fn ai_sessions(app: AppHandle) -> Result<AiSessionStore, String> {
  let store =
    crate::commands::read_json::<AiSessionStore>(&app, "ai-sessions.json")?.unwrap_or_default();
  Ok(normalized_sessions(store))
}

/// Write the whole store back. The caller saves on session switches and when an answer ends,
/// not on every token, so this stays a rare, complete write.
#[tauri::command(async)]
pub fn ai_save_sessions(app: AppHandle, sessions: AiSessionStore) -> Result<(), String> {
  let sessions = normalized_sessions(sessions);
  crate::commands::write_json(&app, "ai-sessions.json", &sessions)
    .map_err(|e| format!("ai_session_write:{e}"))
}

/// Drop what the store must not carry (unknown roles, empty messages), cap it at 20 sessions of
/// 100 messages, and move the active pointer to a session that exists.
fn normalized_sessions(mut store: AiSessionStore) -> AiSessionStore {
  store.items.retain(|session| !session.id.trim().is_empty());
  for session in &mut store.items {
    session.messages.retain(|message| {
      matches!(message.role.as_str(), "user" | "assistant") && !message.content.trim().is_empty()
    });
    if session.messages.len() > MAX_SESSION_MESSAGES {
      session
        .messages
        .drain(..session.messages.len() - MAX_SESSION_MESSAGES);
    }
    if session.title.trim().is_empty() {
      session.title = title_from_messages(&session.messages);
    }
  }
  store.items.truncate(MAX_SESSIONS);
  if !store.items.iter().any(|session| session.id == store.active) {
    store.active = store
      .items
      .first()
      .map(|session| session.id.clone())
      .unwrap_or_default();
  }
  store
}

/// The first line of the first question, short enough for a dropdown.
fn title_from_messages(messages: &[AiStoredMessage]) -> String {
  let Some(text) = messages
    .iter()
    .find(|message| message.role == "user")
    .map(|message| message.content.trim())
  else {
    return String::new();
  };
  let line = text.lines().next().unwrap_or("").trim();
  let mut title: String = line.chars().take(48).collect();
  if line.chars().count() > 48 {
    title.push('…');
  }
  title
}

#[tauri::command(async)]
pub fn ai_cancel(state: State<'_, AiState>, op_id: String) {
  if let Some(flag) = state
    .cancels
    .lock()
    .expect("ai cancel lock poisoned")
    .get(&op_id)
  {
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

  let result = stream_message(
    &base_url,
    &model,
    key.as_deref(),
    &patch,
    timeout_ms,
    &cancel,
    &on_event,
  )
  .await;

  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .remove(&op_id);
  result
}

/// Stream an answer for one chat message.
///
/// The conversation is bounded before it leaves: the oldest turns are dropped and the attached
/// context is cut, so a long session cannot grow into a request the service refuses. A failure
/// before the stream starts rejects; one after the first delta arrives as an `Error` event and
/// whatever text already arrived stays in the caller's hands.
#[tauri::command]
pub async fn ai_chat(
  app: AppHandle,
  state: State<'_, AiState>,
  request: AiChatRequest,
  on_event: Channel<AiChatEvent>,
) -> Result<(), String> {
  if request.op_id.trim().is_empty() {
    return Err("ai_bad_request".into());
  }
  let settings = commands::settings_of(&app);
  if !settings.ai_enabled {
    return Err("ai_disabled".into());
  }
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

  let loopback = base_url.starts_with("http://");
  let key = stored_key(&app, &endpoint_id);
  if !loopback && key.is_none() {
    return Err("ai_key_missing".into());
  }
  let key = if loopback { None } else { key };

  let messages = chat_messages(&request)?;

  let cancel = Arc::new(AtomicBool::new(false));
  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .insert(request.op_id.clone(), cancel.clone());

  let result = stream_chat(
    &base_url,
    &model,
    key.as_deref(),
    &messages,
    timeout_ms,
    &cancel,
    &on_event,
    None,
    false,
  )
  .await;

  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .remove(&request.op_id);
  result
}

/// One non-streaming inline completion.
///
/// The frontend sends the text around the caret in full; the cutting to the two windows the
/// model sees happens here, next to the prompt that says what they are. The request is short
/// by design — a completion is inserted into the buffer, so a long answer is a long edit.
#[tauri::command]
pub async fn ai_complete(
  app: AppHandle,
  state: State<'_, AiState>,
  op_id: String,
  prefix: String,
  suffix: String,
  language: String,
) -> Result<String, String> {
  if op_id.trim().is_empty() {
    return Err("ai_bad_request".into());
  }
  let settings = commands::settings_of(&app);
  if !settings.ai_enabled {
    return Err("ai_disabled".into());
  }
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

  let loopback = base_url.starts_with("http://");
  let key = stored_key(&app, &endpoint_id);
  if !loopback && key.is_none() {
    return Err("ai_key_missing".into());
  }
  let key = if loopback { None } else { key };

  let cancel = Arc::new(AtomicBool::new(false));
  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .insert(op_id.clone(), cancel.clone());

  let result = complete(
    &base_url,
    &model,
    key.as_deref(),
    &prefix,
    &suffix,
    &language,
    timeout_ms,
    &cancel,
  )
  .await;

  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .remove(&op_id);
  result
}

/// Stream a replacement for the selected text.
///
/// The answer is previewed by the frontend and only written on `Enter`, so this command never
/// touches the buffer. An empty answer is valid: it means the selection is deleted.
#[tauri::command]
pub async fn ai_edit(
  app: AppHandle,
  state: State<'_, AiState>,
  request: AiEditRequest,
  on_event: Channel<AiChatEvent>,
) -> Result<(), String> {
  if request.op_id.trim().is_empty() {
    return Err("ai_bad_request".into());
  }
  let settings = commands::settings_of(&app);
  if !settings.ai_enabled {
    return Err("ai_disabled".into());
  }
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

  let loopback = base_url.starts_with("http://");
  let key = stored_key(&app, &endpoint_id);
  if !loopback && key.is_none() {
    return Err("ai_key_missing".into());
  }
  let key = if loopback { None } else { key };

  let messages = edit_messages(&request)?;

  let cancel = Arc::new(AtomicBool::new(false));
  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .insert(request.op_id.clone(), cancel.clone());

  let result = stream_chat(
    &base_url,
    &model,
    key.as_deref(),
    &messages,
    timeout_ms,
    &cancel,
    &on_event,
    Some(EDIT_BUDGET),
    true,
  )
  .await;

  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .remove(&request.op_id);
  result
}

/// The system and user messages for one edit, with the context cut to the nearest lines and
/// the character budget. The selection alone is never cut: half a selection is a wrong edit.
fn edit_messages(request: &AiEditRequest) -> Result<Vec<Value>, String> {
  let instruction = request.instruction.trim();
  if instruction.is_empty() {
    return Err("ai_no_instruction".into());
  }
  let instruction = truncate(instruction, EDIT_INSTRUCTION_LIMIT);
  let selected_chars = request.selected.chars().count();
  if selected_chars > EDIT_BUDGET {
    return Err("ai_selection_too_large".into());
  }
  let room = EDIT_BUDGET - selected_chars;
  let before = truncate_tail(&last_lines(&request.before, EDIT_CONTEXT_LINES), room / 2);
  let after_room = room.saturating_sub(before.chars().count());
  let after = truncate(&first_lines(&request.after, EDIT_CONTEXT_LINES), after_room);
  let empty_note = if request.selected.trim().is_empty() {
    "\nThe selected text is empty; write what should go in its place."
  } else {
    ""
  };
  let prompt = format!(
    "Language: {}\nInstruction: {}\n\n<before_selection>\n{}\n</before_selection>\n\
     <selected_text>\n{}\n</selected_text>\n<after_selection>\n{}\n</after_selection>\n\n\
     Rewrite only <selected_text> according to the instruction. Reply with only the \
     replacement text, without code fences or explanation.{}",
    request.language.trim(),
    instruction,
    before,
    request.selected,
    after,
    empty_note
  );
  Ok(vec![
    json!({ "role": "system", "content": EDIT_SYSTEM_PROMPT }),
    json!({ "role": "user", "content": prompt }),
  ])
}

/// The last `count` lines, which are the ones nearest a selection that sits below them.
fn last_lines(text: &str, count: usize) -> String {
  let lines: Vec<&str> = text.lines().collect();
  let start = lines.len().saturating_sub(count);
  lines[start..].join("\n")
}

/// The first `count` lines, which are the ones nearest a selection that sits above them.
fn first_lines(text: &str, count: usize) -> String {
  text.lines().take(count).collect::<Vec<_>>().join("\n")
}

/// One tool-enabled chat turn.
///
/// This command only talks to the model. It does not read, write, or even name a file: the
/// frontend holds the one open document, asks the reader before every read, and applies an
/// approved replacement itself. That is what keeps the model away from every other path.
#[tauri::command]
pub async fn ai_files_turn(
  app: AppHandle,
  state: State<'_, AiState>,
  op_id: String,
  messages: Vec<Value>,
) -> Result<AiFilesTurn, String> {
  if op_id.trim().is_empty() {
    return Err("ai_bad_request".into());
  }
  let settings = commands::settings_of(&app);
  if !settings.ai_enabled {
    return Err("ai_disabled".into());
  }
  if !settings.ai_files_enabled {
    return Err("ai_files_disabled".into());
  }
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

  let loopback = base_url.starts_with("http://");
  let key = stored_key(&app, &endpoint_id);
  if !loopback && key.is_none() {
    return Err("ai_key_missing".into());
  }
  let key = if loopback { None } else { key };

  validate_files_messages(&messages)?;
  let mut full = Vec::with_capacity(messages.len() + 1);
  full.push(json!({ "role": "system", "content": FILES_SYSTEM_PROMPT }));
  full.extend(messages);

  let body = json!({
    "model": model,
    "messages": full,
    "tools": file_tools(),
    "tool_choice": "auto",
    "stream": false,
    "temperature": 0.2,
    "max_tokens": 4096,
  });

  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .timeout(Duration::from_millis(u64::from(timeout_ms)))
    .build()
    .map_err(map_network)?;
  let mut request = client
    .post(format!("{base_url}/chat/completions"))
    .json(&body);
  if let Some(key) = key.as_deref() {
    request = request.bearer_auth(key);
  }

  let cancel = Arc::new(AtomicBool::new(false));
  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .insert(op_id.clone(), cancel.clone());

  let result = async {
    if cancel.load(Ordering::SeqCst) {
      return Err("ai_canceled".into());
    }
    let response = request.send().await.map_err(map_network)?;
    if !response.status().is_success() {
      return Err(map_status(response.status()));
    }
    if cancel.load(Ordering::SeqCst) {
      return Err("ai_canceled".into());
    }
    let value: Value = response
      .json()
      .await
      .map_err(|e| format!("ai_files:{}", e.without_url()))?;
    parse_files_response(&value)
  }
  .await;

  state
    .cancels
    .lock()
    .expect("ai state lock poisoned")
    .remove(&op_id);
  result
}

/// The two function definitions sent with a file-access turn. Neither carries a path.
fn file_tools() -> Value {
  json!([
    {
      "type": "function",
      "function": {
        "name": "read_current_file",
        "description": "Read the file the reader currently has open. The reader is asked to \
  approve every read. Returns the text, truncated to 32 KB.",
        "parameters": {
          "type": "object",
          "properties": {},
          "additionalProperties": false
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "replace_in_current_file",
        "description": "Propose replacing one exact passage in the current file. The reader \
  sees the old and new text and approves it. old_text must appear exactly once in the file.",
        "parameters": {
          "type": "object",
          "properties": {
            "old_text": {
              "type": "string",
              "description": "Exact text from the file, copied verbatim including indentation."
            },
            "new_text": {
              "type": "string",
              "description": "The text to put in its place. An empty string deletes the passage."
            }
          },
          "required": ["old_text", "new_text"],
          "additionalProperties": false
        }
      }
    }
  ])
}

/// The message shapes the provider accepts in a tool loop: the visible conversation, the
/// assistant turns that carried tool calls, and their results. Anything else is refused here
/// rather than sent.
fn validate_files_messages(messages: &[Value]) -> Result<(), String> {
  if messages.is_empty() {
    return Err("ai_no_messages".into());
  }
  if messages.len() > FILES_MAX_MESSAGES {
    return Err("ai_context_too_large".into());
  }
  let mut total = 0usize;
  for message in messages {
    let role = message["role"].as_str().unwrap_or("");
    match role {
      "user" => {
        let content = message["content"].as_str().unwrap_or("");
        if content.trim().is_empty() {
          return Err("ai_no_messages".into());
        }
        total += content.chars().count();
      }
      "assistant" => {
        if let Some(content) = message["content"].as_str() {
          total += content.chars().count();
        }
        if let Some(calls) = message["tool_calls"].as_array() {
          if calls.len() > FILES_MAX_TOOL_CALLS {
            return Err("ai_bad_tool".into());
          }
          for call in calls {
            let name = call["function"]["name"].as_str().unwrap_or("");
            if !matches!(name, "read_current_file" | "replace_in_current_file") {
              return Err("ai_bad_tool".into());
            }
            if call["id"].as_str().unwrap_or("").is_empty() {
              return Err("ai_bad_tool".into());
            }
            total += call["function"]["arguments"]
              .as_str()
              .unwrap_or("")
              .chars()
              .count();
          }
        }
      }
      "tool" => {
        if message["tool_call_id"].as_str().unwrap_or("").is_empty() {
          return Err("ai_bad_tool".into());
        }
        total += message["content"].as_str().unwrap_or("").chars().count();
      }
      _ => return Err("ai_bad_role".into()),
    }
    if total > FILES_MAX_CHARS {
      return Err("ai_context_too_large".into());
    }
  }
  // A turn ends with the reader's question or with the result of a tool. Ending on an
  // assistant message would ask the model to continue from its own unfinished turn.
  if !matches!(
    messages.last().unwrap()["role"].as_str(),
    Some("user") | Some("tool")
  ) {
    return Err("ai_last_not_user".into());
  }
  Ok(())
}

/// Read one `message` out of a non-streaming completion. Unknown tool names are refused here:
/// the two below are the whole surface this feature has.
fn parse_files_response(value: &Value) -> Result<AiFilesTurn, String> {
  let message = &value["choices"][0]["message"];
  let text = message["content"].as_str().unwrap_or("").to_string();
  let mut calls = Vec::new();
  if let Some(rows) = message["tool_calls"].as_array() {
    if rows.len() > FILES_MAX_TOOL_CALLS {
      return Err("ai_bad_tool".into());
    }
    for row in rows {
      let name = row["function"]["name"].as_str().unwrap_or("");
      if !matches!(name, "read_current_file" | "replace_in_current_file") {
        return Err("ai_bad_tool".into());
      }
      let id = row["id"].as_str().unwrap_or("").to_string();
      if id.is_empty() {
        return Err("ai_bad_tool".into());
      }
      let arguments = match &row["function"]["arguments"] {
        Value::String(arguments) => arguments.clone(),
        Value::Null => "{}".into(),
        other => other.to_string(),
      };
      calls.push(AiToolCall {
        id,
        name: name.into(),
        arguments,
      });
    }
  }
  if text.trim().is_empty() && calls.is_empty() {
    return Err("ai_empty".into());
  }
  Ok(AiFilesTurn {
    text,
    tool_calls: calls,
  })
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
    .timeout(Duration::from_millis(u64::from(
      settings.ai_timeout_ms.min(30_000),
    )))
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
    // The URL can carry a token in its query string, and the reader cannot act on it anyway.
    format!("ai_network:{}", error.without_url())
  }
}

/// Build the JSON messages for one chat request.
///
/// The whitelist is what keeps the frontend from putting an arbitrary role into the body. The
/// attached context rides on the last question, and the budget drops the oldest turns first:
/// a conversation that no longer fits is shortened, never rejected.
fn chat_messages(request: &AiChatRequest) -> Result<Vec<Value>, String> {
  if request.messages.is_empty() {
    return Err("ai_no_messages".into());
  }
  let mut messages = vec![json!({ "role": "system", "content": CHAT_SYSTEM_PROMPT })];
  let first = request.messages.len().saturating_sub(CHAT_TURN_COUNT);
  for turn in &request.messages[first..] {
    if !matches!(turn.role.as_str(), "system" | "user" | "assistant") {
      return Err("ai_bad_role".into());
    }
    let content = turn.content.trim();
    if content.is_empty() {
      continue;
    }
    messages.push(json!({
      "role": turn.role,
      "content": truncate(content, CHAT_TURN_LIMIT),
    }));
  }
  if messages.last().and_then(|message| message["role"].as_str()) != Some("user") {
    return Err("ai_last_not_user".into());
  }
  if let Some(context) = request
    .context
    .as_deref()
    .map(str::trim)
    .filter(|text| !text.is_empty())
  {
    let label = request
      .context_label
      .as_deref()
      .map(str::trim)
      .filter(|text| !text.is_empty())
      .unwrap_or("attached context");
    let block = format!(
      "<context>\n{}\n{}\n</context>",
      label,
      truncate(context, CHAT_CONTEXT_LIMIT)
    );
    if let Some(last) = messages
      .iter_mut()
      .rev()
      .find(|message| message["role"].as_str() == Some("user"))
    {
      let content = format!("{}\n\n{}", last["content"].as_str().unwrap_or(""), block);
      last["content"] = Value::String(content);
    }
  }
  loop {
    let total: usize = messages
      .iter()
      .map(|message| message["content"].as_str().map(str::len).unwrap_or(0))
      .sum();
    if total <= CHAT_HISTORY_BUDGET || messages.len() <= 3 {
      break;
    }
    messages.remove(1);
  }
  Ok(messages)
}

/// One SSE event frame. Lines are split on `\n`; a blank line closes the frame, `data:` lines
/// inside one frame are joined with a newline, comment lines are ignored, and a CR before the
/// newline is dropped. Anything that is not `data:` is not ours and is skipped.
#[derive(Default)]
struct SseDecoder {
  pending: String,
  data: Vec<String>,
}

impl SseDecoder {
  fn push(&mut self, chunk: &str) -> Vec<String> {
    self.pending.push_str(chunk);
    let mut events = Vec::new();
    loop {
      let Some(position) = self.pending.find('\n') else {
        break;
      };
      let mut line = self.pending[..position].to_string();
      self.pending.drain(..=position);
      if line.ends_with('\r') {
        line.pop();
      }
      if line.is_empty() {
        if !self.data.is_empty() {
          events.push(self.data.join("\n"));
          self.data.clear();
        }
        continue;
      }
      if line.starts_with(':') {
        continue;
      }
      if let Some(rest) = line.strip_prefix("data:") {
        self
          .data
          .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
      }
    }
    events
  }

  /// The frame a stream closed without a final blank line, including a last line that arrived
  /// without its newline.
  fn finish(&mut self) -> Option<String> {
    if !self.pending.is_empty() {
      let mut line = std::mem::take(&mut self.pending);
      if line.ends_with('\r') {
        line.pop();
      }
      if let Some(rest) = line.strip_prefix("data:") {
        self
          .data
          .push(rest.strip_prefix(' ').unwrap_or(rest).to_string());
      }
    }
    if self.data.is_empty() {
      return None;
    }
    Some(std::mem::take(&mut self.data).join("\n"))
  }
}

/// The incremental text inside one `chat/completions` event, if it carries any.
fn delta_text(event: &str) -> Option<String> {
  let value: Value = serde_json::from_str(event).ok()?;
  value["choices"].as_array()?.first()?["delta"]["content"]
    .as_str()
    .map(str::to_string)
}

/// The reason the service gives on its last event: `stop` or `length`.
fn finish_reason(event: &str) -> Option<String> {
  let value: Value = serde_json::from_str(event).ok()?;
  value["choices"].as_array()?.first()?["finish_reason"]
    .as_str()
    .map(str::to_string)
}

/// Ask for one completion and return the text to insert. The prefix keeps the part nearest
/// the caret, the suffix the part just after it; both are cut here.
async fn complete(
  base_url: &str,
  model: &str,
  key: Option<&str>,
  prefix: &str,
  suffix: &str,
  language: &str,
  timeout_ms: u32,
  cancel: &AtomicBool,
) -> Result<String, String> {
  if cancel.load(Ordering::SeqCst) {
    return Err("ai_canceled".into());
  }
  let prompt = format!(
    "Language: {}\n\n<prefix>\n{}\n</prefix>\n<text_after_cursor>\n{}\n</text_after_cursor>\n\n\
     Continue the text. Reply with only the text to insert, or nothing.",
    language.trim(),
    truncate_tail(prefix, COMPLETE_PREFIX_LIMIT),
    truncate(suffix, COMPLETE_SUFFIX_LIMIT)
  );
  let body = json!({
    "model": model,
    "messages": [
      { "role": "system", "content": COMPLETE_SYSTEM_PROMPT },
      { "role": "user", "content": prompt },
    ],
    "stream": false,
    "temperature": 0.2,
    "max_tokens": 256,
  });

  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    // A completion is short; waiting the chat timeout for it would leave the caret hanging.
    .timeout(Duration::from_millis(u64::from(timeout_ms.min(30_000))))
    .build()
    .map_err(map_network)?;
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
  if cancel.load(Ordering::SeqCst) {
    return Err("ai_canceled".into());
  }
  let value: Value = response
    .json()
    .await
    .map_err(|e| format!("ai_complete:{}", e.without_url()))?;
  let text = value["choices"]
    .as_array()
    .and_then(|choices| choices.first())
    .and_then(|choice| choice["message"]["content"].as_str())
    .unwrap_or("");
  Ok(clean_completion(text))
}

/// The last `limit` characters, which is the part of the prefix the caret can see. The marker
/// is at the front because the cut is behind the remaining text.
fn truncate_tail(text: &str, limit: usize) -> String {
  let count = text.chars().count();
  if count <= limit {
    return text.to_string();
  }
  let mut out: String = text.chars().skip(count - limit).collect();
  out.insert_str(0, "[truncated]\n");
  out
}

/// A completion cleaned to the inline-completion limit.
fn clean_completion(text: &str) -> String {
  clean_streamed(text, COMPLETE_MAX_CHARS)
}

/// The text to insert, with a fence the model added anyway taken off, a trailing newline
/// removed, and the length capped. Leading whitespace is kept: it is the indentation the
/// text will sit at.
fn clean_streamed(text: &str, limit: usize) -> String {
  let trimmed = text.trim_start();
  let mut out = if trimmed.starts_with("```") {
    let mut lines = trimmed.lines();
    lines.next();
    let mut body: Vec<&str> = lines.collect();
    if body.last().map(|line| line.trim()) == Some("```") {
      body.pop();
    }
    body.join("\n")
  } else {
    text.to_string()
  };
  out = out.trim_end_matches(['\r', '\n']).to_string();
  if out.chars().count() > limit {
    out = out.chars().take(limit).collect();
  }
  out
}

/// Stream one chat answer. The timeout is per chunk rather than for the whole answer: a long
/// answer is expected to take a while, and a service that has gone quiet is the failure worth
/// naming.
async fn stream_chat(
  base_url: &str,
  model: &str,
  key: Option<&str>,
  messages: &[Value],
  timeout_ms: u32,
  cancel: &AtomicBool,
  on_event: &Channel<AiChatEvent>,
  // The final text is cleaned to this many characters when set (a fence is stripped either
  // way); an empty answer is a valid result for an edit that deletes the selection.
  final_limit: Option<usize>,
  allow_empty: bool,
) -> Result<(), String> {
  let body = json!({
    "model": model,
    "messages": messages,
    "stream": true,
    "temperature": 0.3,
  });

  let client = reqwest::Client::builder()
    .connect_timeout(Duration::from_secs(15))
    .build()
    .map_err(map_network)?;
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
  let mut decoder = SseDecoder::default();
  let idle = Duration::from_millis(u64::from(timeout_ms.clamp(10_000, 180_000)));
  let mut full = String::new();
  let mut finish: Option<String> = None;
  let mut done = false;

  loop {
    if cancel.load(Ordering::SeqCst) {
      let _ = on_event.send(AiChatEvent::Done {
        text: full,
        reason: "canceled".into(),
      });
      return Ok(());
    }
    let chunk = match tokio::time::timeout(idle, stream.next()).await {
      Err(_) => {
        let _ = on_event.send(AiChatEvent::Error {
          code: "ai_timeout".into(),
          detail: String::new(),
          retryable: full.is_empty(),
        });
        return Ok(());
      }
      Ok(None) => break,
      Ok(Some(Err(error))) => {
        let _ = on_event.send(AiChatEvent::Error {
          code: "ai_network".into(),
          detail: error.without_url().to_string(),
          retryable: full.is_empty(),
        });
        return Ok(());
      }
      Ok(Some(Ok(chunk))) => chunk,
    };

    for event in decoder.push(&String::from_utf8_lossy(&chunk)) {
      if event.trim() == "[DONE]" {
        done = true;
        break;
      }
      if let Some(reason) = finish_reason(&event) {
        finish = Some(reason);
      }
      if let Some(text) = delta_text(&event) {
        if !text.is_empty() {
          full.push_str(&text);
          let _ = on_event.send(AiChatEvent::Delta { text });
        }
      }
    }
    if done {
      break;
    }
  }

  if !done {
    if let Some(event) = decoder.finish() {
      if event.trim() != "[DONE]" {
        if let Some(reason) = finish_reason(&event) {
          finish = Some(reason);
        }
        if let Some(text) = delta_text(&event) {
          if !text.is_empty() {
            full.push_str(&text);
            let _ = on_event.send(AiChatEvent::Delta { text });
          }
        }
      }
    }
  }

  if full.is_empty() && !allow_empty {
    let _ = on_event.send(AiChatEvent::Error {
      code: "ai_empty".into(),
      detail: String::new(),
      retryable: false,
    });
  } else {
    let text = match final_limit {
      Some(limit) => clean_streamed(&full, limit),
      None => full,
    };
    let _ = on_event.send(AiChatEvent::Done {
      text,
      reason: finish.unwrap_or_else(|| "stop".into()),
    });
  }
  Ok(())
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
  let mut decoder = SseDecoder::default();
  let mut full = String::new();
  let mut done = false;

  while let Some(chunk) = stream.next().await {
    if cancel.load(Ordering::SeqCst) {
      break;
    }
    let chunk = chunk.map_err(map_network)?;
    for event in decoder.push(&String::from_utf8_lossy(&chunk)) {
      if event.trim() == "[DONE]" {
        done = true;
        break;
      }
      if let Some(text) = delta_text(&event) {
        if !text.is_empty() {
          full.push_str(&text);
          let _ = on_event.send(AiCommitEvent::Delta { text });
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
  fn truncate_tail_keeps_the_part_near_the_caret() {
    assert_eq!(truncate_tail("abc", 10), "abc");
    let cut = truncate_tail(&format!("{}{}", "x".repeat(100), "END"), 5);
    assert!(cut.ends_with("xEND"));
    assert!(cut.starts_with("[truncated]"));
  }

  #[test]
  fn clean_completion_keeps_indentation_and_strips_fences() {
    assert_eq!(clean_completion("    return 1;\n"), "    return 1;");
    assert_eq!(
      clean_completion("```ts\n  const x = 1;\n```"),
      "  const x = 1;"
    );
    assert_eq!(
      clean_completion(&format!("{}\n", "y".repeat(COMPLETE_MAX_CHARS + 10)))
        .chars()
        .count(),
      COMPLETE_MAX_CHARS
    );
  }

  #[test]
  fn files_messages_accept_tool_turns_and_refuse_strangers() {
    let user = json!({"role":"user","content":"what does this do?"});
    assert!(validate_files_messages(&[user.clone()]).is_ok());
    let assistant = json!({
      "role":"assistant",
      "content":"",
      "tool_calls":[{"id":"c1","type":"function","function":{"name":"read_current_file","arguments":"{}"}}]
    });
    let tool = json!({"role":"tool","tool_call_id":"c1","content":"fn main() {}"});
    assert!(validate_files_messages(&[user.clone(), assistant, tool]).is_ok());
    assert_eq!(
      validate_files_messages(&[json!({"role":"system","content":"x"})]),
      Err("ai_bad_role".to_string())
    );
    assert_eq!(
      validate_files_messages(&[
        user.clone(),
        json!({"role":"assistant","content":"unfinished"})
      ]),
      Err("ai_last_not_user".to_string())
    );
    assert_eq!(
      validate_files_messages(&[
        user,
        json!({"role":"assistant","content":"","tool_calls":[{"id":"c1","type":"function","function":{"name":"open_file","arguments":"{}"}}]})
      ]),
      Err("ai_bad_tool".to_string())
    );
  }

  #[test]
  fn files_response_reads_text_and_tool_calls() {
    let value = json!({"choices":[{"message":{
      "content":"Let me look.",
      "tool_calls":[{"id":"c1","type":"function","function":{"name":"read_current_file","arguments":"{}"}}]
    }}]});
    let turn = parse_files_response(&value).expect("turn");
    assert_eq!(turn.text, "Let me look.");
    assert_eq!(turn.tool_calls.len(), 1);
    assert_eq!(turn.tool_calls[0].name, "read_current_file");
    assert!(
      parse_files_response(&json!({"choices":[{"message":{"content":"","tool_calls":[]}}]}))
        .is_err()
    );
    let tools = file_tools().to_string();
    assert!(tools.contains("read_current_file"));
    assert!(tools.contains("replace_in_current_file"));
  }

  #[test]
  fn edit_messages_refuse_an_empty_instruction_and_a_huge_selection() {
    let base = AiEditRequest {
      op_id: "op".into(),
      instruction: "  ".into(),
      selected: "x".into(),
      before: String::new(),
      after: String::new(),
      language: "rust".into(),
    };
    assert_eq!(edit_messages(&base), Err("ai_no_instruction".to_string()));
    assert_eq!(
      edit_messages(&AiEditRequest {
        instruction: "rename it".into(),
        selected: "x".repeat(EDIT_BUDGET + 1),
        ..base
      }),
      Err("ai_selection_too_large".to_string())
    );
  }

  #[test]
  fn edit_messages_keep_the_nearest_context_within_the_budget() {
    let before = (1..=300)
      .map(|line| format!("before line {line}"))
      .collect::<Vec<_>>()
      .join("\n");
    let after = (1..=300)
      .map(|line| format!("after line {line}"))
      .collect::<Vec<_>>()
      .join("\n");
    let messages = edit_messages(&AiEditRequest {
      op_id: "op".into(),
      instruction: "make it shorter".into(),
      selected: "SELECTED".into(),
      before,
      after,
      language: "rust".into(),
    })
    .expect("messages");
    let prompt = messages[1]["content"].as_str().expect("prompt");
    assert!(prompt.contains("before line 300"));
    assert!(!prompt.contains("before line 1\n"));
    assert!(prompt.contains("after line 1"));
    assert!(!prompt.contains("after line 300"));
    assert!(prompt.chars().count() <= EDIT_BUDGET + EDIT_INSTRUCTION_LIMIT + 600);
  }

  #[test]
  fn line_windows_take_the_side_nearest_the_selection() {
    assert_eq!(last_lines("a\nb\nc", 2), "b\nc");
    assert_eq!(first_lines("a\nb\nc", 2), "a\nb");
    assert_eq!(last_lines("a", 5), "a");
    assert_eq!(first_lines("", 5), "");
  }

  #[test]
  fn sse_decoder_frames_events() {
    let mut decoder = SseDecoder::default();
    assert_eq!(
      decoder.push("data: {\"a\":1}\n\ndata: second\n\n"),
      vec!["{\"a\":1}", "second"]
    );
  }

  #[test]
  fn sse_decoder_joins_multiline_data_and_skips_comments() {
    let mut decoder = SseDecoder::default();
    let events = decoder.push(": keepalive\n\ndata: one\ndata: two\n\n");
    assert_eq!(events, vec!["one\ntwo"]);
  }

  #[test]
  fn sse_decoder_handles_split_chunks_and_crlf() {
    let mut decoder = SseDecoder::default();
    assert!(decoder.push("data: {\"cho").is_empty());
    assert_eq!(
      decoder.push("ices\":[]}\r\n\r\ndata: [DONE]"),
      vec!["{\"choices\":[]}"]
    );
    assert_eq!(decoder.finish().as_deref(), Some("[DONE]"));
  }

  #[test]
  fn chat_messages_only_accept_known_roles() {
    let request = AiChatRequest {
      op_id: "op".into(),
      messages: vec![AiChatTurn {
        role: "tool".into(),
        content: "x".into(),
      }],
      context: None,
      context_label: None,
    };
    assert_eq!(chat_messages(&request), Err("ai_bad_role".to_string()));
  }

  #[test]
  fn chat_messages_require_a_question_last() {
    let request = AiChatRequest {
      op_id: "op".into(),
      messages: vec![AiChatTurn {
        role: "assistant".into(),
        content: "hello".into(),
      }],
      context: None,
      context_label: None,
    };
    assert_eq!(chat_messages(&request), Err("ai_last_not_user".to_string()));
  }

  #[test]
  fn chat_messages_put_context_on_the_last_question() {
    let request = AiChatRequest {
      op_id: "op".into(),
      messages: vec![
        AiChatTurn {
          role: "user".into(),
          content: "first".into(),
        },
        AiChatTurn {
          role: "assistant".into(),
          content: "answer".into(),
        },
        AiChatTurn {
          role: "user".into(),
          content: "explain".into(),
        },
      ],
      context: Some("fn main() {}".into()),
      context_label: Some("src/main.rs".into()),
    };
    let messages = chat_messages(&request).expect("messages");
    assert_eq!(messages.len(), 4);
    assert_eq!(messages[1]["role"], "user");
    assert_eq!(messages[1]["content"], "first");
    assert_eq!(messages[2]["role"], "assistant");
    let last = messages[3]["content"].as_str().expect("content");
    assert!(last.starts_with("explain\n\n<context>"));
    assert!(last.contains("src/main.rs"));
    assert!(last.contains("fn main() {}"));
  }

  #[test]
  fn chat_drops_the_oldest_turns_to_fit_the_budget() {
    let mut turns = Vec::new();
    for index in 0..12 {
      turns.push(AiChatTurn {
        role: if index % 2 == 0 { "user" } else { "assistant" }.into(),
        content: "x".repeat(20_000),
      });
    }
    turns.push(AiChatTurn {
      role: "user".into(),
      content: "final question".into(),
    });
    let messages = chat_messages(&AiChatRequest {
      op_id: "op".into(),
      messages: turns,
      context: None,
      context_label: None,
    })
    .expect("messages");
    let total: usize = messages
      .iter()
      .map(|message| message["content"].as_str().map(str::len).unwrap_or(0))
      .sum();
    assert!(total <= CHAT_HISTORY_BUDGET);
    assert_eq!(messages.last().expect("last")["content"], "final question");
    assert!(messages.len() < 13);
  }

  #[test]
  fn sessions_keep_the_caps_and_move_the_active_pointer() {
    let mut store = AiSessionStore::default();
    for index in 0..25 {
      store.items.push(AiSession {
        id: format!("s{index}"),
        messages: (0..105)
          .map(|line| AiStoredMessage {
            role: "user".into(),
            content: format!("line {line}"),
            at: String::new(),
            partial: false,
          })
          .collect(),
        ..Default::default()
      });
    }
    store.active = "gone".into();
    let store = normalized_sessions(store);
    assert_eq!(store.items.len(), MAX_SESSIONS);
    assert_eq!(store.items[0].messages.len(), MAX_SESSION_MESSAGES);
    assert_eq!(store.active, "s0");
    assert_eq!(store.items[0].title, "line 5");
  }

  #[test]
  fn a_session_title_comes_from_the_first_line_of_the_first_question() {
    let messages = vec![
      AiStoredMessage {
        role: "assistant".into(),
        content: "hello".into(),
        ..Default::default()
      },
      AiStoredMessage {
        role: "user".into(),
        content: format!("  {}\nsecond", "x".repeat(60)),
        ..Default::default()
      },
    ];
    let title = title_from_messages(&messages);
    assert_eq!(title.chars().count(), 49);
    assert!(title.ends_with('…'));
  }

  #[test]
  fn ai_context_scope_falls_back_to_selection() {
    let scope = |value: &str| {
      Settings {
        ai_context_scope: value.into(),
        ..Default::default()
      }
      .filled()
      .ai_context_scope
    };
    assert_eq!(scope("file"), "file");
    assert_eq!(scope("none"), "none");
    assert_eq!(scope("bogus"), "selection");
    assert_eq!(scope(""), "selection");
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
    assert_eq!(
      base("https://api.deepseek.com/v1"),
      "https://api.deepseek.com/v1"
    );
    assert_eq!(
      base("http://localhost:11434/v1"),
      "http://localhost:11434/v1"
    );
    assert_eq!(
      base("http://evil.example.com/v1"),
      "https://api.openai.com/v1"
    );
    assert_eq!(base("ftp://x"), "https://api.openai.com/v1");
    assert_eq!(base(""), "https://api.openai.com/v1");
  }
}
