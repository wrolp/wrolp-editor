//! Session unlock state for encrypted files.
//!
//! Two halves, kept deliberately apart. The in-memory cache holds *keys*, dies with the
//! process, and expires on its own after a configurable idle period. The credential store
//! holds *passwords*, survives a reboot, and is written only when the user ticks "remember"
//! on a specific file. Neither half ever returns its secret to the frontend: a password
//! travels in one direction only, and what comes back is the decrypted document.
//!
//! Expiry is lazy — no timer, no background thread. Every cache access sweeps what has
//! gone stale first, which costs one pass over a map that holds a handful of entries. The
//! trade is that a key nobody touches again is never reclaimed; since it lives in this
//! process's memory and the process is the thing being left idle, that is acceptable.

use crate::commands::{self, OpenedFile};
use crate::crypto::{self, KEY_LEN};
use crate::draft;
use keyring_core::{CredentialStore, Entry};
use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use zeroize::Zeroize;

/// Credential Manager service. One owner for everything this app keeps, so the store shows
/// a single application rather than one unrelated entry per feature.
const SERVICE: &str = "com.wrolp.editor";
/// Account prefix; the full account is `enc-` plus the path digest, so a readable path
/// never lands in a store the user can browse.
const ACCOUNT_PREFIX: &str = "enc-";
/// Hex digits in a SHA-256 digest, which is what follows the prefix.
const DIGEST_LEN: usize = 64;
/// Bound on remembered passwords. Not a security limit — the credential store is encrypted
/// per user either way — but an abandoned file must not leave an entry behind forever
/// without anybody noticing how many have piled up.
const MAX_REMEMBERED: usize = 64;

/// True for the entries this app wrote. Both halves have to match: the service separates us
/// from every other application in the store, and the account shape separates encrypted
/// file entries from anything else this app may one day keep under the same service.
fn is_ours(entry: &Entry) -> bool {
  entry.get_specifiers().is_some_and(|(service, account)| {
    service == SERVICE
      && account.len() == ACCOUNT_PREFIX.len() + DIGEST_LEN
      && account.starts_with(ACCOUNT_PREFIX)
      // The prefix is ASCII, so this byte offset is a character boundary.
      && account[ACCOUNT_PREFIX.len()..]
        .chars()
        .all(|c| c.is_ascii_hexdigit())
  })
}

/// The idle window from settings, or `None` when the user set it to 0 and asked for keys to
/// stay put. Called on every cache access, which reads settings.json each time; that file
/// is a few hundred bytes and the access is user-paced, so caching it would only add a
/// second place for the value to go stale.
pub(crate) fn idle_limit(app: &AppHandle) -> Option<Duration> {
  let minutes = commands::settings_of(app).encrypt_idle_minutes;
  if minutes == 0 {
    None
  } else {
    Some(Duration::from_secs(u64::from(minutes) * 60))
  }
}

struct CachedKey {
  key: [u8; KEY_LEN],
  last_used: Instant,
}

impl Drop for CachedKey {
  fn drop(&mut self) {
    self.key.zeroize();
  }
}

/// Managed state. Keyed by the same normalized path as drafts and per-file overrides, so
/// one path means one thing across every feature.
pub struct UnlockStore {
  keys: Mutex<HashMap<String, CachedKey>>,
  /// `None` when this platform has no credential store to use. Remembering then fails
  /// loudly instead of writing the password somewhere weaker; reading still works, because
  /// "nothing remembered" and "cannot look" lead to the same next step — ask the user.
  keyring: Option<Arc<CredentialStore>>,
}

impl Default for UnlockStore {
  fn default() -> Self {
    Self::new(system_store())
  }
}

#[cfg(windows)]
fn system_store() -> Option<Arc<CredentialStore>> {
  windows_native_keyring_store::Store::new()
    .ok()
    .map(|store| -> Arc<CredentialStore> { store })
}

#[cfg(not(windows))]
fn system_store() -> Option<Arc<CredentialStore>> {
  None
}

impl UnlockStore {
  /// Takes the store explicitly so tests can hand in a stand-in instead of the real
  /// Credential Manager.
  pub(crate) fn new(keyring: Option<Arc<CredentialStore>>) -> Self {
    Self {
      keys: Mutex::new(HashMap::new()),
      keyring,
    }
  }

  fn map(&self) -> std::sync::MutexGuard<'_, HashMap<String, CachedKey>> {
    self.keys.lock().expect("unlock store lock poisoned")
  }

  fn sweep(&self, idle: Option<Duration>) {
    let Some(idle) = idle else { return };
    let now = Instant::now();
    self
      .map()
      .retain(|_, cached| now.duration_since(cached.last_used) < idle);
  }

  /// Cache a key, replacing any older one for the same path.
  pub(crate) fn put(&self, path: &str, key: [u8; KEY_LEN], idle: Option<Duration>) {
    self.sweep(idle);
    let normalized = draft::normalize_path(path);
    if normalized.is_empty() {
      return;
    }
    self.map().insert(
      normalized,
      CachedKey {
        key,
        last_used: Instant::now(),
      },
    );
  }

  /// The cached key, or `None` when the file is locked. A hit counts as use, so an open
  /// file is not locked out from under somebody who is still working in it.
  pub(crate) fn get(&self, path: &str, idle: Option<Duration>) -> Option<[u8; KEY_LEN]> {
    self.sweep(idle);
    let normalized = draft::normalize_path(path);
    let mut map = self.map();
    let cached = map.get_mut(&normalized)?;
    cached.last_used = Instant::now();
    Some(cached.key)
  }

  pub(crate) fn remove(&self, path: &str) {
    let normalized = draft::normalize_path(path);
    self.map().remove(&normalized);
  }

  /// Drop every key. Used by the idle lock and on the way out; the tabs stay as they are,
  /// because the text on screen was decrypted while the file was legitimately unlocked.
  pub(crate) fn clear(&self) {
    self.map().clear();
  }

  /// Verify a password against a container, cache the key it derives, and return the
  /// plaintext bytes. UTF-8 is the caller's business: a tag that verifies but yields
  /// invalid text is a damaged file, not a wrong password, and the two read differently.
  pub(crate) fn unlock_with_password(
    &self,
    path: &str,
    bytes: &[u8],
    password: &str,
    idle: Option<Duration>,
  ) -> Result<Vec<u8>, String> {
    let header = crypto::parse_header(bytes)?;
    let mut key = crypto::derive_key(password, &header.salt, header.params)?;
    let plaintext = crypto::decrypt(bytes, &key);
    // Only a key that opened the file is worth caching: caching a wrong one would make the
    // next attempt fail in a place that no longer has the password to compare against.
    if plaintext.is_ok() {
      self.put(path, key, idle);
    } else {
      key.zeroize();
    }
    plaintext
  }

  /// Decrypt with whatever this session already holds: the cached key first, then a password
  /// the user asked to be remembered. `None` means neither was usable and the caller has to
  /// ask; `Some(Err(_))` means the file itself is the problem and asking would not help.
  ///
  /// A key or password that no longer opens the file is dropped rather than reported as a
  /// wrong password. The user typed nothing, so "wrong password" would be a lie about
  /// something they did not do, and the usual cause is a file that was re-encrypted
  /// somewhere else. What is left behind is a file that asks to be unlocked, which is true.
  pub(crate) fn decrypt_if_possible(
    &self,
    path: &str,
    bytes: &[u8],
    idle: Option<Duration>,
  ) -> Option<Result<Vec<u8>, String>> {
    if let Some(key) = self.get(path, idle) {
      match crypto::decrypt(bytes, &key) {
        Ok(plaintext) => return Some(Ok(plaintext)),
        Err(e) if e == "encrypted_bad_password" => self.remove(path),
        Err(e) => return Some(Err(e)),
      }
    }
    let password = self.recall(path)?;
    match self.unlock_with_password(path, bytes, &password, idle) {
      Ok(plaintext) => Some(Ok(plaintext)),
      // Forgetting it is the point: keeping a password known not to work would make every
      // later open try it and fail before asking.
      Err(e) if e == "encrypted_bad_password" => {
        let _ = self.forget(path);
        None
      }
      Err(e) => Some(Err(e)),
    }
  }

  /// The password for this path, if the user asked for it to be remembered. Best effort by
  /// design: a store that cannot be read is indistinguishable from an empty one here, and
  /// both lead to asking for the password, which is the safe answer.
  pub(crate) fn recall(&self, path: &str) -> Option<String> {
    let entry = self.entry(path).ok()?;
    entry.get_password().ok().filter(|p| !p.is_empty())
  }

  fn account(path: &str) -> Result<String, String> {
    let digest = draft::draft_key(path);
    if digest.is_empty() {
      return Err("path_unresolvable".into());
    }
    Ok(format!("{ACCOUNT_PREFIX}{digest}"))
  }

  fn entry(&self, path: &str) -> Result<Entry, String> {
    let keyring = self
      .keyring
      .as_ref()
      .ok_or_else(|| "encrypted_keyring_unavailable".to_string())?;
    let account = Self::account(path)?;
    keyring
      .build(SERVICE, &account, None)
      .map_err(|e| format!("encrypted_keyring_unavailable:{e}"))
  }

  /// Everything this app has remembered. Enumerating the store and keeping our own entries
  /// gives an exact count, where the alternative — an index file listing what was
  /// remembered — would be a second copy of the truth that can disagree with the first.
  ///
  /// Matching is on the service and account a store reports, not on a pattern over the
  /// entry name: how a store spells that name is its business, and the Windows store
  /// materialises every credential of the user before filtering anyway, so pushing the
  /// filter down buys nothing.
  fn remembered(&self) -> Result<Vec<Entry>, String> {
    let keyring = self
      .keyring
      .as_ref()
      .ok_or_else(|| "encrypted_keyring_unavailable".to_string())?;
    let found = keyring
      .search(&HashMap::new())
      .map_err(|e| format!("encrypted_keyring_unavailable:{e}"))?;
    Ok(found.into_iter().filter(is_ours).collect())
  }

  /// Store the password for one file. Fails rather than falling back to something weaker:
  /// a password the user believes is in the credential store but is actually in a file
  /// next to the document would be worse than no remembering at all.
  pub(crate) fn remember(&self, path: &str, password: &str) -> Result<(), String> {
    if password.is_empty() {
      return Err("encrypted_weak_password".into());
    }
    let account = Self::account(path)?;
    let existing = self.remembered()?;
    let mine = existing.iter().any(|e| {
      e.get_specifiers()
        .is_some_and(|(_, stored)| stored == account)
    });
    // Replacing the password of a file already remembered does not grow the store, so the
    // cap only bites on a genuinely new one.
    if !mine && existing.len() >= MAX_REMEMBERED {
      return Err("encrypted_remembered_full".into());
    }
    self
      .entry(path)?
      .set_password(password)
      .map_err(|e| format!("encrypted_keyring_unavailable:{e}"))
  }

  /// Stop remembering one file. Forgetting something that was never remembered is what the
  /// user asked for anyway, so a missing entry is a success.
  pub(crate) fn forget(&self, path: &str) -> Result<(), String> {
    match self.entry(path)?.delete_credential() {
      Ok(()) => Ok(()),
      Err(keyring_core::Error::NoEntry) => Ok(()),
      Err(e) => Err(format!("encrypted_keyring_unavailable:{e}")),
    }
  }

  /// Drop every remembered password and report how many went. Used by the settings panel,
  /// which shows the count, and by a user who wants the machine clean.
  pub(crate) fn clear_remembered(&self) -> Result<u32, String> {
    let entries = self.remembered()?;
    let mut cleared = 0u32;
    for entry in &entries {
      if entry.delete_credential().is_ok() {
        cleared += 1;
      }
    }
    Ok(cleared)
  }

  pub(crate) fn remembered_count(&self) -> Result<u32, String> {
    Ok(self.remembered()?.len() as u32)
  }
}

/// Decrypt a file with a password and hand back the opened document. The password is not
/// returned and not stored anywhere except the credential store, and only if the caller
/// separately asks for that: an unlock that fails because the optional "remember" write
/// failed would be a worse outcome than an unlock that reports the failure separately.
#[tauri::command]
pub fn unlock_file(
  app: AppHandle,
  state: State<'_, UnlockStore>,
  path: String,
  password: String,
) -> Result<OpenedFile, String> {
  let source = commands::read_source(&path)?;
  if !crypto::is_container(&source.bytes) {
    return Err("encrypted_not_container".into());
  }
  let idle = idle_limit(&app);
  let plaintext = state.unlock_with_password(&source.path, &source.bytes, &password, idle)?;
  // Strict, like every other read of decrypted bytes: a tag that verifies but yields invalid
  // UTF-8 is a damaged file, and showing replacement characters would invite the user to
  // save them over the original.
  let content = String::from_utf8(plaintext).map_err(|_| "encrypted_corrupt".to_string())?;

  // A locked open deliberately records nothing, so the history entry is made here instead:
  // this is the moment the file was actually opened.
  commands::push_history_entry(&app, &source.path)?;
  Ok(commands::decrypted_file(source, content))
}

/// Put a file under a new password.
///
/// The document is decrypted and re-encrypted whole, which is affordable because the editor
/// refuses files bigger than its limit anyway. The cost parameters stay the file's own — a
/// password change is not a moment to quietly lower the work factor — and the salt is fresh,
/// so two files that once shared a password do not go on sharing a key.
#[tauri::command]
pub fn change_password(
  app: AppHandle,
  state: State<'_, UnlockStore>,
  path: String,
  old_password: String,
  new_password: String,
) -> Result<commands::SavedFile, String> {
  if new_password.is_empty() {
    return Err("encrypted_weak_password".into());
  }
  let source = commands::read_source(&path)?;
  if !crypto::is_container(&source.bytes) {
    return Err("encrypted_not_container".into());
  }
  let header = crypto::parse_header(&source.bytes)?;
  // Verified against the old password rather than against a cached key. The user is
  // asserting what the old password is, and acting on a wrong assertion here would hand them
  // a file they can no longer open.
  let mut old_key = crypto::derive_key(&old_password, &header.salt, header.params)?;
  let plaintext = crypto::decrypt(&source.bytes, &old_key);
  old_key.zeroize();
  let mut plaintext = plaintext?;

  let salt = crypto::random_salt()?;
  let mut new_key = crypto::derive_key(&new_password, &salt, header.params)?;
  let written = (|| {
    let bytes = crypto::encrypt_under(&plaintext, &new_key, salt, header.params)?;
    if bytes.len() as u64 > commands::MAX_FILE_BYTES {
      return Err(format!("file_too_large:{}", bytes.len() / (1024 * 1024)));
    }
    commands::write_atomic(Path::new(&source.path), &bytes)?;
    Ok(bytes.len() as u64)
  })();
  plaintext.zeroize();
  let idle = idle_limit(&app);
  if written.is_ok() {
    // From here the new key is the one that opens the file, so the cache has to agree before
    // the next save looks at it.
    state.put(&source.path, new_key, idle);
  }
  new_key.zeroize();
  let bytes = written?;

  // A remembered password has to follow the file, or the next launch would try the old one.
  // If the store will not take the new one, the old entry goes instead of staying behind to
  // fail: being asked for the password beats remembering one that does not work.
  if state.recall(&source.path).is_some() && state.remember(&source.path, &new_password).is_err() {
    let _ = state.forget(&source.path);
  }

  let mtime = std::fs::metadata(&source.path)
    .map(|m| commands::mtime_ms(&m))
    .unwrap_or(0);
  Ok(commands::SavedFile {
    path: source.path,
    mtime,
    encoding: "UTF-8".into(),
    bytes,
  })
}

/// Take the encryption off a file: verify the password, then write the plaintext back over
/// the container.
///
/// The text goes out as UTF-8, which is what the container held. A document that was GBK
/// before it was encrypted comes back as UTF-8: the encoding is not carried in the format,
/// and guessing it back would be worse than the one honest answer.
#[tauri::command]
pub fn remove_encryption(
  state: State<'_, UnlockStore>,
  path: String,
  password: String,
) -> Result<commands::SavedFile, String> {
  let source = commands::read_source(&path)?;
  if !crypto::is_container(&source.bytes) {
    return Err("encrypted_not_container".into());
  }
  let header = crypto::parse_header(&source.bytes)?;
  // Derived here rather than taken from the cache: the user has just typed the password, and
  // a key that is cached but stale would write a file that no longer matches it.
  let mut key = crypto::derive_key(&password, &header.salt, header.params)?;
  let plaintext = crypto::decrypt(&source.bytes, &key);
  key.zeroize();
  let mut plaintext = plaintext?;
  // Checked before anything is written: replacing an encrypted file with bytes that are not
  // text destroys the only copy that could still be read.
  if std::str::from_utf8(&plaintext).is_err() {
    plaintext.zeroize();
    return Err("encrypted_corrupt".into());
  }
  if plaintext.len() as u64 > commands::MAX_FILE_BYTES {
    plaintext.zeroize();
    return Err(format!(
      "file_too_large:{}",
      plaintext.len() / (1024 * 1024)
    ));
  }
  let written = commands::write_atomic(Path::new(&source.path), &plaintext);
  let bytes = plaintext.len() as u64;
  plaintext.zeroize();
  written?;

  // Neither the key nor the password has anything left to open. Drafting is unblocked from
  // here by the file on disk, not by anything said here: the next draft is written plain
  // over the sealed one because the container is gone.
  state.remove(&source.path);
  let _ = state.forget(&source.path);

  let mtime = std::fs::metadata(&source.path)
    .map(|m| commands::mtime_ms(&m))
    .unwrap_or(0);
  Ok(commands::SavedFile {
    path: source.path,
    mtime,
    encoding: "UTF-8".into(),
    bytes,
  })
}

/// Put a document under encryption for the first time, and cache the key that opens it.
///
/// Separate from saving a file that already is encrypted: that one goes through `save_file` and
/// keeps the container's own salt and cost parameters, because a cached key was derived under
/// them. There is no container here yet, so this draws a fresh salt at the current defaults.
/// Caching the result is what lets the tab that follows open unlocked instead of asking for the
/// password it was just handed.
fn write_new_container(
  state: &UnlockStore,
  normalized: &str,
  plaintext: &[u8],
  password: &str,
  idle: Option<Duration>,
) -> Result<u64, String> {
  let salt = crypto::random_salt()?;
  let params = crypto::KdfParams::default();
  let mut key = crypto::derive_key(password, &salt, params)?;
  // The atomic write, for the reason every other container write has it: a truncated ciphertext
  // verifies to nothing, so a half-written file here is not damaged but gone.
  let written = crypto::encrypt_under(plaintext, &key, salt, params).and_then(|bytes| {
    // A container is the text plus a header and a tag, so the limit is faced by what actually
    // lands on disk rather than by what the user typed.
    if bytes.len() as u64 > commands::MAX_FILE_BYTES {
      return Err(format!("file_too_large:{}", bytes.len() / (1024 * 1024)));
    }
    commands::write_atomic(Path::new(normalized), &bytes).map(|()| bytes.len() as u64)
  });
  // Only a key that is on disk somewhere is worth caching: caching one whose write failed would
  // leave the session believing it can save a file that was never created.
  if written.is_ok() {
    state.put(normalized, key, idle);
  }
  key.zeroize();
  written
}

/// Write text out as a new encrypted file, at a path the caller chose.
///
/// The text goes in as UTF-8 and nothing else. The format carries no encoding field, so a
/// legacy encoding written inside a container would produce a file this app itself could not
/// read back correctly — the one kind of damage encryption is supposed to prevent.
#[tauri::command]
pub fn save_file_as_encrypted(
  app: AppHandle,
  state: State<'_, UnlockStore>,
  path: String,
  content: String,
  password: String,
) -> Result<commands::SavedFile, String> {
  let normalized = draft::normalize_path(&path);
  if normalized.is_empty() {
    return Err("path_empty".into());
  }
  let target = Path::new(&normalized);
  if let Some(parent) = target.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("dir_create:{e}"))?;
  }
  let mut content = content;
  let written = write_new_container(
    &state,
    &normalized,
    content.as_bytes(),
    &password,
    idle_limit(&app),
  );
  content.zeroize();
  let bytes = written?;
  let mtime = std::fs::metadata(target)
    .map(|m| commands::mtime_ms(&m))
    .unwrap_or(0);
  commands::push_history_entry(&app, &normalized)?;
  Ok(commands::SavedFile {
    path: normalized,
    mtime,
    encoding: "UTF-8".into(),
    bytes,
  })
}

/// Create an empty encrypted file inside `parent`.
///
/// Empty rather than holding a placeholder, for the reason `create_file` has: it is a file the
/// user asked to exist, not one with anything in it. Text nobody typed would be worse here than
/// there, because it would arrive already encrypted.
#[tauri::command]
pub fn create_encrypted(
  app: AppHandle,
  state: State<'_, UnlockStore>,
  parent: String,
  name: String,
  password: String,
) -> Result<commands::FsEntry, String> {
  let (target, named) = crate::entry::new_entry_path(&parent, &name, crate::entry::ENCRYPTED_EXT)?;
  // Reserved before anything is written, so a name taken in between is refused rather than
  // overwritten. The reservation is an empty file, which is not a container and so reads as
  // corrupt rather than as somebody's document; it is replaced atomically a moment later, and
  // taken back out if that fails.
  std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&target)
    .map_err(|e| format!("create_failed:{e}"))?;
  let normalized = draft::normalize_path(&target.to_string_lossy());
  if let Err(e) = write_new_container(&state, &normalized, &[], &password, idle_limit(&app)) {
    let _ = std::fs::remove_file(&target);
    return Err(e);
  }
  Ok(commands::FsEntry {
    name: named,
    path: normalized,
    is_dir: false,
  })
}

#[tauri::command]
pub fn lock_file(state: State<'_, UnlockStore>, path: String) {
  state.remove(&path);
}

#[tauri::command]
pub fn lock_all(state: State<'_, UnlockStore>) {
  state.clear();
}

#[tauri::command]
pub fn remember_password(
  state: State<'_, UnlockStore>,
  path: String,
  password: String,
) -> Result<(), String> {
  state.remember(&path, &password)
}

#[tauri::command]
pub fn forget_password(state: State<'_, UnlockStore>, path: String) -> Result<(), String> {
  state.forget(&path)
}

/// Only ever answers whether a password is remembered. The password itself stays in Rust:
/// sending it to the frontend would put it in a JavaScript heap and a devtools console.
#[tauri::command]
pub fn recall_password(state: State<'_, UnlockStore>, path: String) -> bool {
  state.recall(&path).is_some()
}

#[tauri::command]
pub fn remembered_password_count(state: State<'_, UnlockStore>) -> Result<u32, String> {
  state.remembered_count()
}

#[tauri::command]
pub fn clear_remembered_passwords(state: State<'_, UnlockStore>) -> Result<u32, String> {
  state.clear_remembered()
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::crypto::KdfParams;
  use keyring_core::api::{CredentialApi, CredentialStoreApi};
  use keyring_core::{Credential, Error as KeyError, Result as KeyResult};
  use std::any::Any;
  use std::sync::atomic::{AtomicBool, Ordering};

  /// Smallest legal parameters: the tests exercise the unlock logic, not Argon2, and the
  /// debug profile makes the default 64 MiB x 3 cost about a second per derivation.
  const FAST: KdfParams = KdfParams {
    m_cost: crypto::MIN_M_COST,
    t_cost: crypto::MIN_T_COST,
    p_cost: crypto::MIN_P_COST,
  };
  /// Stands in for the salt a real container carries.
  const SALT: [u8; 16] = *b"0123456789abcdef";

  /// An in-memory credential store.
  ///
  /// keyring-core ships a mock, but it keeps a credential after it has been deleted and
  /// ignores whatever filter a search is given, so it cannot express the two things this
  /// module depends on: a forgotten password is gone, and an enumeration lists only what
  /// is still there. This one holds passwords in a map keyed the way the Windows store
  /// keys them, `<account>.<service>`, and can be armed to fail one call.
  #[derive(Default)]
  struct TestStore {
    creds: Arc<Mutex<HashMap<String, String>>>,
    fail_next: Arc<AtomicBool>,
  }

  impl TestStore {
    fn new() -> Arc<Self> {
      Arc::new(Self::default())
    }

    /// The next call against any credential of this store fails once.
    fn arm_failure(&self) {
      self.fail_next.store(true, Ordering::SeqCst);
    }

    fn failure(&self) -> Option<KeyError> {
      if self.fail_next.swap(false, Ordering::SeqCst) {
        Some(KeyError::NoStorageAccess(Box::new(std::io::Error::other(
          "simulated store failure",
        ))))
      } else {
        None
      }
    }
  }

  struct TestCred {
    store: Arc<TestStore>,
    service: String,
    account: String,
  }

  impl TestCred {
    fn target(&self) -> String {
      format!("{}.{}", self.account, self.service)
    }
  }

  impl CredentialApi for TestCred {
    fn set_secret(&self, secret: &[u8]) -> KeyResult<()> {
      if let Some(err) = self.store.failure() {
        return Err(err);
      }
      let password =
        std::str::from_utf8(secret).map_err(|_| KeyError::BadEncoding(secret.to_vec()))?;
      self
        .store
        .creds
        .lock()
        .expect("test store lock")
        .insert(self.target(), password.to_string());
      Ok(())
    }

    fn get_secret(&self) -> KeyResult<Vec<u8>> {
      if let Some(err) = self.store.failure() {
        return Err(err);
      }
      match self
        .store
        .creds
        .lock()
        .expect("test store lock")
        .get(&self.target())
      {
        Some(password) => Ok(password.as_bytes().to_vec()),
        None => Err(KeyError::NoEntry),
      }
    }

    fn delete_credential(&self) -> KeyResult<()> {
      if let Some(err) = self.store.failure() {
        return Err(err);
      }
      match self
        .store
        .creds
        .lock()
        .expect("test store lock")
        .remove(&self.target())
      {
        Some(_) => Ok(()),
        None => Err(KeyError::NoEntry),
      }
    }

    fn get_credential(&self) -> KeyResult<Option<Arc<Credential>>> {
      Ok(None)
    }

    fn get_specifiers(&self) -> Option<(String, String)> {
      Some((self.service.clone(), self.account.clone()))
    }

    fn as_any(&self) -> &dyn Any {
      self
    }
  }

  impl CredentialStoreApi for TestStore {
    fn vendor(&self) -> String {
      "test".into()
    }

    fn id(&self) -> String {
      "in-memory".into()
    }

    fn build(
      &self,
      service: &str,
      user: &str,
      modifiers: Option<&HashMap<&str, &str>>,
    ) -> KeyResult<Entry> {
      if modifiers.is_some_and(|m| !m.is_empty()) {
        return Err(KeyError::NotSupportedByStore(
          "the test store takes no modifiers".into(),
        ));
      }
      let cred = Arc::new(TestCred {
        store: Arc::new(TestStore {
          creds: self.creds.clone(),
          fail_next: self.fail_next.clone(),
        }),
        service: service.into(),
        account: user.into(),
      });
      Ok(Entry::new_with_credential(cred))
    }

    fn search(&self, _spec: &HashMap<&str, &str>) -> KeyResult<Vec<Entry>> {
      let creds = self.creds.lock().expect("test store lock");
      let mut out = Vec::new();
      for target in creds.keys() {
        // The target name is `<account>.<service>`; the account never contains a dot.
        let (account, service) = match target.split_once('.') {
          Some(pair) => pair,
          None => continue,
        };
        let cred = Arc::new(TestCred {
          store: Arc::new(TestStore {
            creds: self.creds.clone(),
            fail_next: self.fail_next.clone(),
          }),
          service: service.into(),
          account: account.into(),
        });
        out.push(Entry::new_with_credential(cred));
      }
      Ok(out)
    }

    fn as_any(&self) -> &dyn Any {
      self
    }
  }

  fn store_with_keyring() -> (UnlockStore, Arc<TestStore>) {
    let keyring = TestStore::new();
    let unlock = UnlockStore::new(Some(keyring.clone() as Arc<CredentialStore>));
    (unlock, keyring)
  }

  fn store_without_keyring() -> UnlockStore {
    UnlockStore::new(None)
  }

  fn path(n: usize) -> String {
    std::env::temp_dir()
      .join(format!("wrolp-unlock-test-{n}.wrolpenc"))
      .to_string_lossy()
      .to_string()
  }

  /// A container that really does come from `password`: the salt in its header is the salt
  /// the key was derived from, which is what makes unlocking it by password possible.
  fn container(password: &str, plaintext: &[u8]) -> Vec<u8> {
    crypto::encrypt_with_salt(plaintext, password, &SALT, FAST).expect("encrypt")
  }

  #[test]
  fn a_key_that_was_put_is_found_and_one_that_was_not_is_not() {
    let unlock = store_without_keyring();
    let p = path(1);
    assert!(unlock.get(&p, None).is_none());
    unlock.put(&p, [7u8; KEY_LEN], None);
    assert_eq!(unlock.get(&p, None), Some([7u8; KEY_LEN]));
    // A different file must not inherit this one's key.
    assert!(unlock.get(&path(2), None).is_none());
  }

  #[test]
  fn the_same_path_in_any_spelling_is_the_same_key() {
    let unlock = store_without_keyring();
    let p = path(3);
    unlock.put(&p, [9u8; KEY_LEN], None);
    // Normalization is what makes drafts, overrides and keys agree on a path, so a lookup
    // that skipped it would silently lock a file the user has open.
    assert_eq!(unlock.get(&format!("  {p}  "), None), Some([9u8; KEY_LEN]));
  }

  #[test]
  fn an_idle_key_is_swept_and_a_fresh_one_survives() {
    let unlock = store_without_keyring();
    let stale = path(4);
    let fresh = path(5);
    unlock.put(&stale, [1u8; KEY_LEN], None);
    unlock.put(&fresh, [2u8; KEY_LEN], None);
    backdate(&unlock, &stale, Duration::from_secs(600));

    unlock.sweep(Some(Duration::from_secs(60)));
    assert!(unlock.get(&stale, None).is_none());
    assert_eq!(unlock.get(&fresh, None), Some([2u8; KEY_LEN]));
  }

  #[test]
  fn no_idle_limit_means_keys_are_never_swept() {
    let unlock = store_without_keyring();
    let p = path(6);
    unlock.put(&p, [3u8; KEY_LEN], None);
    backdate(&unlock, &p, Duration::from_secs(60 * 60 * 24));
    unlock.sweep(None);
    assert_eq!(unlock.get(&p, None), Some([3u8; KEY_LEN]));
  }

  #[test]
  fn a_get_counts_as_use_so_an_open_file_is_not_locked_out() {
    let unlock = store_without_keyring();
    let p = path(7);
    unlock.put(&p, [4u8; KEY_LEN], None);
    backdate(&unlock, &p, Duration::from_secs(50));
    // Under a 60 second limit, a read at 50 seconds refreshes the clock; the next sweep at
    // 50 more seconds still finds it.
    assert!(unlock.get(&p, Some(Duration::from_secs(60))).is_some());
    backdate(&unlock, &p, Duration::from_secs(50));
    assert!(unlock.get(&p, Some(Duration::from_secs(60))).is_some());
  }

  #[test]
  fn clear_drops_every_key() {
    let unlock = store_without_keyring();
    unlock.put(&path(8), [5u8; KEY_LEN], None);
    unlock.put(&path(9), [6u8; KEY_LEN], None);
    unlock.clear();
    assert!(unlock.get(&path(8), None).is_none());
    assert!(unlock.get(&path(9), None).is_none());
  }

  #[test]
  fn removing_one_key_leaves_the_others() {
    let unlock = store_without_keyring();
    let a = path(10);
    let b = path(11);
    unlock.put(&a, [7u8; KEY_LEN], None);
    unlock.put(&b, [8u8; KEY_LEN], None);
    unlock.remove(&a);
    assert!(unlock.get(&a, None).is_none());
    assert_eq!(unlock.get(&b, None), Some([8u8; KEY_LEN]));
  }

  #[test]
  fn the_right_password_unlocks_and_caches_the_key() {
    let unlock = store_without_keyring();
    let p = path(12);
    let bytes = container("correct horse", b"plaintext body");
    let out = unlock
      .unlock_with_password(&p, &bytes, "correct horse", None)
      .expect("unlock");
    assert_eq!(out, b"plaintext body");
    // The cache is what makes the next save and the next compare need no password.
    assert!(unlock.get(&p, None).is_some());
  }

  #[test]
  fn a_wrong_password_neither_unlocks_nor_caches_anything() {
    let unlock = store_without_keyring();
    let p = path(13);
    let bytes = container("correct horse", b"plaintext body");
    let err = unlock
      .unlock_with_password(&p, &bytes, "wrong horse", None)
      .expect_err("must fail");
    assert_eq!(err, "encrypted_bad_password");
    assert!(unlock.get(&p, None).is_none());
  }

  #[test]
  fn an_empty_password_is_weak_rather_than_wrong() {
    let unlock = store_without_keyring();
    let bytes = container("correct horse", b"x");
    let err = unlock
      .unlock_with_password(&path(14), &bytes, "", None)
      .expect_err("must fail");
    assert_eq!(err, "encrypted_weak_password");
  }

  #[test]
  fn a_file_that_is_not_a_container_says_so_instead_of_reporting_a_bad_password() {
    let unlock = store_without_keyring();
    let err = unlock
      .unlock_with_password(&path(15), b"just some text", "anything", None)
      .expect_err("must fail");
    assert_eq!(err, "encrypted_corrupt");
  }

  #[test]
  fn a_cached_key_opens_the_file_without_a_password() {
    let unlock = store_without_keyring();
    let p = path(30);
    let bytes = container("correct horse", b"plaintext body");
    let key = crypto::derive_key("correct horse", &SALT, FAST).expect("derive");
    unlock.put(&p, key, None);
    let answer = unlock
      .decrypt_if_possible(&p, &bytes, None)
      .expect("answer");
    assert_eq!(answer.expect("decrypt"), b"plaintext body");
  }

  /// The document at this path was replaced behind our back: the cached key belongs to the
  /// file that used to be here. Reporting a wrong password would blame the user for
  /// something they did not type, so the key goes and the file asks to be unlocked.
  #[test]
  fn a_stale_cached_key_is_dropped_rather_than_reported_as_a_wrong_password() {
    let unlock = store_without_keyring();
    let p = path(31);
    let bytes = container("correct horse", b"plaintext body");
    unlock.put(&p, [0u8; KEY_LEN], None);
    assert!(unlock.decrypt_if_possible(&p, &bytes, None).is_none());
    assert!(unlock.get(&p, None).is_none(), "the stale key must be gone");
  }

  #[test]
  fn a_remembered_password_opens_the_file_when_no_key_is_cached() {
    let (unlock, _) = store_with_keyring();
    let p = path(32);
    let bytes = container("correct horse", b"plaintext body");
    unlock.remember(&p, "correct horse").expect("remember");
    let answer = unlock
      .decrypt_if_possible(&p, &bytes, None)
      .expect("answer");
    assert_eq!(answer.expect("decrypt"), b"plaintext body");
    // Cached as well, so the save that follows does not go back to the credential store.
    assert!(unlock.get(&p, None).is_some());
  }

  #[test]
  fn a_remembered_password_that_stopped_working_is_forgotten() {
    let (unlock, _) = store_with_keyring();
    let p = path(33);
    let bytes = container("correct horse", b"plaintext body");
    unlock.remember(&p, "an older password").expect("remember");
    assert!(unlock.decrypt_if_possible(&p, &bytes, None).is_none());
    assert_eq!(unlock.recall(&p), None, "it must not be tried again");
    assert_eq!(unlock.remembered_count().expect("count"), 0);
  }

  #[test]
  fn with_nothing_to_try_the_answer_is_to_ask_the_user() {
    let (unlock, _) = store_with_keyring();
    let bytes = container("correct horse", b"plaintext body");
    assert!(unlock
      .decrypt_if_possible(&path(34), &bytes, None)
      .is_none());
  }

  /// Damage is a different answer from "locked": asking for a password would not repair a
  /// file this reader cannot make sense of, so the caller has to be told what is wrong.
  #[test]
  fn damage_in_a_container_is_reported_when_there_is_a_key_to_try_it_with() {
    let unlock = store_without_keyring();
    let p = path(35);
    let mut bytes = container("correct horse", b"plaintext body");
    bytes[8] = 99; // the format version
    unlock.put(&p, [0u8; KEY_LEN], None);
    let err = unlock
      .decrypt_if_possible(&p, &bytes, None)
      .expect("an answer")
      .expect_err("must fail");
    assert_eq!(err, "encrypted_version_unknown:99");
    // The file is the problem, not the key, so the key stays.
    assert!(unlock.get(&p, None).is_some());
  }

  #[test]
  fn remember_recall_and_forget_round_trip() {
    let (unlock, _) = store_with_keyring();
    let p = path(16);
    assert_eq!(unlock.recall(&p), None);
    unlock.remember(&p, "kept secret").expect("remember");
    assert_eq!(unlock.recall(&p).as_deref(), Some("kept secret"));
    assert_eq!(unlock.remembered_count().expect("count"), 1);
    unlock.forget(&p).expect("forget");
    assert_eq!(unlock.recall(&p), None);
    assert_eq!(unlock.remembered_count().expect("count"), 0);
  }

  #[test]
  fn two_files_do_not_share_a_remembered_password() {
    let (unlock, _) = store_with_keyring();
    unlock.remember(&path(17), "first").expect("remember");
    unlock.remember(&path(18), "second").expect("remember");
    assert_eq!(unlock.recall(&path(17)).as_deref(), Some("first"));
    assert_eq!(unlock.recall(&path(18)).as_deref(), Some("second"));
  }

  #[test]
  fn remembering_again_replaces_the_password() {
    let (unlock, _) = store_with_keyring();
    let p = path(19);
    unlock.remember(&p, "before").expect("remember");
    unlock.remember(&p, "after").expect("remember");
    assert_eq!(unlock.recall(&p).as_deref(), Some("after"));
    assert_eq!(unlock.remembered_count().expect("count"), 1);
  }

  #[test]
  fn forgetting_a_file_that_was_never_remembered_is_not_an_error() {
    let (unlock, _) = store_with_keyring();
    unlock.forget(&path(20)).expect("forget is idempotent");
  }

  #[test]
  fn an_empty_password_is_never_remembered() {
    let (unlock, _) = store_with_keyring();
    let err = unlock.remember(&path(21), "").expect_err("must fail");
    assert_eq!(err, "encrypted_weak_password");
    assert_eq!(unlock.recall(&path(21)), None);
  }

  #[test]
  fn clear_remembered_drops_every_file_and_reports_the_count() {
    let (unlock, _) = store_with_keyring();
    for n in 22..25 {
      unlock.remember(&path(n), "pw").expect("remember");
    }
    assert_eq!(unlock.clear_remembered().expect("clear"), 3);
    assert_eq!(unlock.remembered_count().expect("count"), 0);
    for n in 22..25 {
      assert_eq!(unlock.recall(&path(n)), None);
    }
  }

  #[test]
  fn without_a_store_remembering_fails_but_opening_still_works() {
    let unlock = store_without_keyring();
    let p = path(26);
    let err = unlock.remember(&p, "pw").expect_err("must fail");
    assert_eq!(err, "encrypted_keyring_unavailable");
    assert_eq!(
      unlock.clear_remembered().expect_err("must fail"),
      "encrypted_keyring_unavailable"
    );
    // Asking is always available, so a missing store degrades to a prompt rather than to a
    // plaintext copy of the password.
    assert_eq!(unlock.recall(&p), None);
  }

  #[test]
  fn a_store_that_fails_to_read_is_treated_as_nothing_remembered() {
    let (unlock, keyring) = store_with_keyring();
    let p = path(27);
    keyring.arm_failure();
    assert_eq!(unlock.recall(&p), None);
    // The failure is returned once and then clears, so what follows proves the read was
    // swallowed rather than the entry never having been written.
    unlock.remember(&p, "pw").expect("remember");
    assert_eq!(unlock.recall(&p).as_deref(), Some("pw"));
  }

  #[test]
  fn a_store_that_fails_to_write_reports_it_rather_than_pretending() {
    let (unlock, keyring) = store_with_keyring();
    let p = path(28);
    keyring.arm_failure();
    let err = unlock.remember(&p, "pw").expect_err("must fail");
    assert!(
      err.starts_with("encrypted_keyring_unavailable"),
      "unexpected error {err}"
    );
    assert_eq!(unlock.recall(&p), None);
  }

  #[test]
  fn the_cap_refuses_a_new_file_but_still_allows_replacing_a_remembered_one() {
    let (unlock, _) = store_with_keyring();
    for n in 0..MAX_REMEMBERED {
      unlock.remember(&path(1000 + n), "pw").expect("remember");
    }
    assert_eq!(
      unlock.remembered_count().expect("count") as usize,
      MAX_REMEMBERED
    );
    let err = unlock
      .remember(&path(9999), "pw")
      .expect_err("over the cap");
    assert_eq!(err, "encrypted_remembered_full");
    // A changed password for a file already in the store does not grow it.
    unlock
      .remember(&path(1000), "rotated")
      .expect("replace at the cap");
    assert_eq!(unlock.recall(&path(1000)).as_deref(), Some("rotated"));
    // Clearing one slot makes room again.
    unlock.forget(&path(1001)).expect("forget");
    unlock.remember(&path(9999), "pw").expect("now it fits");
  }

  #[test]
  fn the_account_name_carries_no_part_of_the_path() {
    // The credential store is browsable by the user and by anything running as them, so
    // the file a password belongs to must not be readable out of the entry name.
    let p = path(29);
    let account = UnlockStore::account(&p).expect("account");
    assert!(account.starts_with(ACCOUNT_PREFIX));
    assert_eq!(account.len(), ACCOUNT_PREFIX.len() + 64);
    let stem = std::path::Path::new(&p)
      .file_stem()
      .and_then(|s| s.to_str())
      .expect("stem")
      .to_lowercase();
    assert!(!account.contains(&stem));
    assert_ne!(account, UnlockStore::account(&path(30)).expect("account"));
  }

  #[test]
  fn an_unresolvable_path_has_no_account() {
    assert_eq!(
      UnlockStore::account("").expect_err("must fail"),
      "path_unresolvable"
    );
  }

  /// Age a cached entry without waiting: the sweep compares `last_used` against now, so
  /// moving the stamp back is the same thing as letting the clock run.
  fn backdate(unlock: &UnlockStore, path: &str, by: Duration) {
    let normalized = draft::normalize_path(path);
    let mut map = unlock.map();
    let cached = map
      .get_mut(&normalized)
      .unwrap_or_else(|| panic!("no cached key for {normalized}"));
    cached.last_used -= by;
  }

  #[test]
  fn a_new_container_is_written_and_its_key_cached() {
    let unlock = store_without_keyring();
    let p = path(31);
    let _ = std::fs::remove_file(&p);
    let plaintext = b"held under a password";
    let bytes =
      write_new_container(&unlock, &p, plaintext, "correct horse", None).expect("written");
    let on_disk = std::fs::read(&p).expect("read back");
    // The count returned is the ciphertext, which is what a tab has to compare against later.
    assert_eq!(bytes, on_disk.len() as u64);
    assert!(crypto::is_container(&on_disk));
    // The cached key opens what was written. That is the whole point of caching it here: a key
    // derived under a different salt than the header carries would leave the file locked at
    // birth, with no password that could ever open it.
    let key = unlock.get(&p, None).expect("cached key");
    assert_eq!(
      crypto::decrypt(&on_disk, &key).expect("decrypts"),
      plaintext
    );
    std::fs::remove_file(&p).expect("cleanup");
  }

  #[test]
  fn an_empty_password_is_weak_and_writes_nothing() {
    let unlock = store_without_keyring();
    let p = path(32);
    let _ = std::fs::remove_file(&p);
    let err = write_new_container(&unlock, &p, b"text", "", None).expect_err("must fail");
    assert_eq!(err, "encrypted_weak_password");
    assert!(!Path::new(&p).exists());
    assert!(unlock.get(&p, None).is_none());
  }

  #[test]
  fn a_key_is_cached_only_once_the_file_is_on_disk() {
    let unlock = store_without_keyring();
    // A directory that is not there, so the temp write fails. A key cached anyway would leave
    // the session believing it can save a file that was never created.
    let p = std::env::temp_dir()
      .join("wrolp-unlock-test-no-such-dir")
      .join("secret.wrolpenc")
      .to_string_lossy()
      .to_string();
    let err =
      write_new_container(&unlock, &p, b"text", "correct horse", None).expect_err("must fail");
    assert!(err.starts_with("tmp_write"), "unexpected error {err}");
    assert!(unlock.get(&p, None).is_none());
  }
}
