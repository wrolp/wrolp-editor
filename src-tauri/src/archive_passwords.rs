//! Passwords for encrypted archives: where they come from, and how one is chosen.
//!
//! Three layers, tried in a fixed order and never shown to the front end: what this session
//! already used, a rule whose pattern matches the archive's name, and finally the default. A
//! zip that none of them opens is answered with `archive_password_required`, which is the
//! front end's cue to ask; the typed answer is then verified here and, on success, cached for
//! the rest of the session.
//!
//! Nothing is written to the Windows credential store: an archive password the user typed is
//! kept in memory until the idle window closes, and the two layers that do outlive the session
//! are the ones the user set up on purpose, in the settings page.
//!
//! The rules and the default are stored in `archive-passwords.json` as DPAPI blobs, beside
//! `settings.json`, and deliberately not inside it: settings are round-tripped by every
//! control in the settings page, and a secret there would be one careless patch away from
//! being written back in the clear.

use crate::archive;
use crate::commands;
use crate::draft;
use crate::unlock::idle_limit;
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;
use zeroize::Zeroizing;

/// Sibling of `settings.json`; see the module note for why it is not the same file.
const FILE: &str = "archive-passwords.json";
/// Bounds that keep the file small and a pattern cheap to evaluate.
const MAX_RULES: usize = 32;
const MAX_PATTERN: usize = 200;
const MAX_PASSWORD: usize = 256;
/// After this many failed automatic attempts for one archive, stop trying and just ask. Three
/// is low enough that a wrong default does not cost a second of decryption per click, and high
/// enough that a rule set that almost matches still gets its chance.
const MAX_AUTO_FAILURES: u32 = 3;

/// One rule as stored: the pattern, what it is matched against, and the password sealed by
/// DPAPI. Only `id`, `pattern`, `flags`, `enabled`, `note` and `target` ever leave this module.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct StoredRule {
  pub id: String,
  pub pattern: String,
  /// The permitted subset of `i`, `m`, `s`. Filtered on the way in, so a file edited by hand
  /// cannot introduce a flag this app does not understand.
  pub flags: String,
  pub secret: String,
  pub enabled: bool,
  /// Matched against the file name or the whole path, per rule rather than globally: two
  /// folders can want different answers for the same person.
  pub target: String,
  pub note: String,
}

impl Default for StoredRule {
  fn default() -> Self {
    Self {
      id: String::new(),
      pattern: String::new(),
      flags: String::new(),
      secret: String::new(),
      enabled: true,
      target: "name".into(),
      note: String::new(),
    }
  }
}

#[derive(Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
struct StoreFile {
  version: u32,
  default: Option<String>,
  rules: Vec<StoredRule>,
}

/// What the settings page gets: the shape of the rules and whether a default exists, never a
/// password and never a ciphertext it could try to replay somewhere else.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleView {
  pub id: String,
  pub pattern: String,
  pub flags: String,
  pub enabled: bool,
  pub target: String,
  pub note: String,
}

impl From<&StoredRule> for RuleView {
  fn from(rule: &StoredRule) -> Self {
    Self {
      id: rule.id.clone(),
      pattern: rule.pattern.clone(),
      flags: rule.flags.clone(),
      enabled: rule.enabled,
      target: rule.target.clone(),
      note: rule.note.clone(),
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordState {
  pub default_set: bool,
  pub rules: Vec<RuleView>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleInput {
  pub id: String,
  pub pattern: String,
  pub flags: String,
  pub enabled: bool,
  pub target: String,
  pub note: String,
  /// `None` or empty keeps the rule's current password, so the panel can rename a rule
  /// without ever reading — or needing — its secret.
  pub password: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleTest {
  /// The rule the name would hit, or `None` when the default is the next thing to try.
  pub rule: Option<RuleView>,
  pub default_set: bool,
}

struct Cached {
  password: Zeroizing<String>,
  last_used: Instant,
}

/// Session memory, keyed by the archive's identity. Neither half touches the disk; the
/// failures map is what stops a wrong default from re-running on every click.
#[derive(Default)]
pub struct ArchivePasswords {
  session: Mutex<HashMap<String, Cached>>,
  failures: Mutex<HashMap<String, u32>>,
}

fn to_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The identity of an archive: its normalized path, its size and its modification time.
///
/// Cheap and explainable. Moving or rewriting the archive changes the identity, so a stale
/// password is never applied to different bytes; the cost is one extra ask after a move,
/// which the rules and the default usually answer without the user noticing.
pub(crate) fn digest_of(path: &Path) -> String {
  let normalized = draft::normalize_path(&path.to_string_lossy());
  let meta = std::fs::metadata(path).ok();
  let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
  let mtime = meta
    .as_ref()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  let mut hasher = Sha256::new();
  hasher.update(normalized.as_bytes());
  hasher.update(size.to_le_bytes());
  hasher.update(mtime.to_le_bytes());
  to_hex(&hasher.finalize())
}

impl ArchivePasswords {
  fn sweep(&self, idle: Option<Duration>) {
    let Some(idle) = idle else { return };
    let now = Instant::now();
    self
      .session
      .lock()
      .expect("archive password lock")
      .retain(|_, cached| now.duration_since(cached.last_used) < idle);
  }

  fn recall(&self, digest: &str, idle: Option<Duration>) -> Option<String> {
    self.sweep(idle);
    let mut session = self.session.lock().expect("archive password lock");
    let cached = session.get_mut(digest)?;
    cached.last_used = Instant::now();
    Some(cached.password.to_string())
  }

  fn remember(&self, digest: &str, password: &str, idle: Option<Duration>) {
    self.sweep(idle);
    self.session.lock().expect("archive password lock").insert(
      digest.to_string(),
      Cached {
        password: Zeroizing::new(password.to_string()),
        last_used: Instant::now(),
      },
    );
    self
      .failures
      .lock()
      .expect("archive failure lock")
      .remove(digest);
  }

  fn failures(&self, digest: &str) -> u32 {
    self
      .failures
      .lock()
      .expect("archive failure lock")
      .get(digest)
      .copied()
      .unwrap_or(0)
  }

  fn note_failure(&self, digest: &str) {
    *self
      .failures
      .lock()
      .expect("archive failure lock")
      .entry(digest.to_string())
      .or_insert(0) += 1;
  }
}

fn read_store(app: &AppHandle) -> Result<StoreFile, String> {
  Ok(commands::read_json::<StoreFile>(app, FILE)?.unwrap_or_default())
}

fn write_store(app: &AppHandle, store: &StoreFile) -> Result<(), String> {
  commands::write_json(app, FILE, store)
}

fn clean_flags(flags: &str) -> String {
  flags
    .chars()
    .filter(|c| matches!(c, 'i' | 'm' | 's'))
    .collect()
}

fn clean_target(target: &str) -> String {
  if target == "path" {
    "path".into()
  } else {
    "name".into()
  }
}

/// The rule's pattern as a matcher, or `None` when the stored pattern no longer compiles
/// (a file edited by hand). A broken rule is skipped rather than stopping the chain.
fn compile(rule: &StoredRule) -> Option<Regex> {
  let mut builder = regex::RegexBuilder::new(&rule.pattern);
  for flag in clean_flags(&rule.flags).chars() {
    match flag {
      'i' => builder.case_insensitive(true),
      'm' => builder.multi_line(true),
      's' => builder.dot_matches_new_line(true),
      _ => continue,
    };
  }
  builder.size_limit(1 << 20).build().ok()
}

/// The first enabled rule that matches, in the order the user arranged.
fn matching_rule<'a>(store: &'a StoreFile, name: &str, path: &str) -> Option<&'a StoredRule> {
  store.rules.iter().find(|rule| {
    if !rule.enabled {
      return false;
    }
    let subject = if clean_target(&rule.target) == "path" {
      path
    } else {
      name
    };
    compile(rule).is_some_and(|regex| regex.is_match(subject))
  })
}

fn unseal(blob: &str) -> Option<String> {
  crate::ai::unprotect(blob).ok().filter(|p| !p.is_empty())
}

/// Resolve the password for one archive, or say that asking is the next step.
///
/// `manual` is the answer the user just typed. It is tried on its own and never mixed with the
/// automatic chain: if it does not open the archive, the honest answer is "that one is wrong",
/// not a silent retry of four other candidates.
pub(crate) fn resolve(
  app: &AppHandle,
  state: &ArchivePasswords,
  path: &Path,
  manual: Option<&str>,
) -> Result<Option<String>, String> {
  if !archive::needs_password(path) {
    return Ok(None);
  }
  let digest = digest_of(path);
  let idle = idle_limit(app);
  if let Some(manual) = manual {
    if manual.is_empty() || manual.chars().count() > MAX_PASSWORD {
      return Err("archive_bad_password".into());
    }
    if archive::password_works(path, manual)? {
      state.remember(&digest, manual, idle);
      return Ok(Some(manual.to_string()));
    }
    return Err("archive_bad_password".into());
  }
  if state.failures(&digest) >= MAX_AUTO_FAILURES {
    return Err("archive_password_required".into());
  }
  if let Some(password) = state.recall(&digest, idle) {
    return Ok(Some(password));
  }
  let store = read_store(app)?;
  let remember = |password: &str| -> Result<Option<String>, String> {
    state.remember(&digest, password, idle);
    Ok(Some(password.to_string()))
  };
  let name = path
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_default();
  let full = path.to_string_lossy();
  if let Some(rule) = matching_rule(&store, &name, &full) {
    if let Some(password) = unseal(&rule.secret) {
      if archive::password_works(path, &password)? {
        return remember(&password);
      }
    }
  }
  if let Some(blob) = &store.default {
    if let Some(password) = unseal(blob) {
      if archive::password_works(path, &password)? {
        return remember(&password);
      }
    }
  }
  // Every candidate was tried. The count only rises here, so a file opened successfully once
  // does not carry earlier misses into the rest of the session.
  state.note_failure(&digest);
  Err("archive_password_required".into())
}

#[tauri::command(async)]
pub fn archive_password_state(app: AppHandle) -> Result<PasswordState, String> {
  let store = read_store(&app)?;
  Ok(PasswordState {
    default_set: store
      .default
      .as_deref()
      .is_some_and(|blob| !blob.is_empty()),
    rules: store.rules.iter().map(RuleView::from).collect(),
  })
}

#[tauri::command(async)]
pub fn archive_set_default_password(app: AppHandle, password: String) -> Result<(), String> {
  if password.is_empty() {
    return Err("archive_password_empty".into());
  }
  if password.chars().count() > MAX_PASSWORD {
    return Err("archive_password_too_long".into());
  }
  let mut store = read_store(&app)?;
  store.version = 1;
  store.default = Some(crate::ai::protect(&password)?);
  write_store(&app, &store)
}

#[tauri::command(async)]
pub fn archive_clear_default_password(app: AppHandle) -> Result<(), String> {
  let mut store = read_store(&app)?;
  store.default = None;
  write_store(&app, &store)
}

/// Add a rule, or change one in place. An empty `id` means "new"; an empty `password` on an
/// existing rule keeps its secret, which is what lets the panel edit a pattern without ever
/// holding the password.
#[tauri::command(async)]
pub fn archive_save_password_rule(app: AppHandle, rule: RuleInput) -> Result<RuleView, String> {
  let pattern = rule.pattern.trim().to_string();
  if pattern.is_empty() {
    return Err("archive_pattern_invalid".into());
  }
  if pattern.chars().count() > MAX_PATTERN {
    return Err("archive_pattern_too_long".into());
  }
  let flags = clean_flags(&rule.flags);
  let mut store = read_store(&app)?;
  let password = rule.password.as_deref().filter(|p| !p.is_empty());
  if let Some(password) = password {
    if password.chars().count() > MAX_PASSWORD {
      return Err("archive_password_too_long".into());
    }
  }
  // Compiled before anything is written: a pattern the matcher rejects here would be skipped
  // silently on every open, which looks like the rule doing nothing rather than like a typo.
  {
    let probe = StoredRule {
      pattern: pattern.clone(),
      flags: flags.clone(),
      ..Default::default()
    };
    if compile(&probe).is_none() {
      return Err("archive_pattern_invalid".into());
    }
  }
  let secret = match password {
    Some(password) => crate::ai::protect(password)?,
    None => String::new(),
  };
  let existing = store
    .rules
    .iter()
    .position(|stored| !rule.id.is_empty() && stored.id == rule.id);
  let view = match existing {
    Some(index) => {
      let stored = &mut store.rules[index];
      stored.pattern = pattern;
      stored.flags = flags;
      stored.enabled = rule.enabled;
      stored.target = clean_target(&rule.target);
      stored.note = rule.note;
      if !secret.is_empty() {
        stored.secret = secret;
      }
      RuleView::from(&*stored)
    }
    None => {
      if store.rules.len() >= MAX_RULES {
        return Err("archive_rule_full".into());
      }
      if secret.is_empty() {
        return Err("archive_password_empty".into());
      }
      let stored = StoredRule {
        id: new_id(&store),
        pattern,
        flags,
        secret,
        enabled: rule.enabled,
        target: clean_target(&rule.target),
        note: rule.note,
      };
      let view = RuleView::from(&stored);
      store.rules.push(stored);
      view
    }
  };
  store.version = 1;
  write_store(&app, &store)?;
  Ok(view)
}

/// A short id nothing else in the file holds. Rule ids are only ever compared for equality, so
/// "first unused number spelled out" is enough and stays readable in the JSON.
fn new_id(store: &StoreFile) -> String {
  for n in 1..=MAX_RULES + 1 {
    let id = format!("r{n}");
    if !store.rules.iter().any(|rule| rule.id == id) {
      return id;
    }
  }
  format!("r{}", store.rules.len() + 1)
}

#[tauri::command(async)]
pub fn archive_delete_password_rule(app: AppHandle, id: String) -> Result<(), String> {
  let mut store = read_store(&app)?;
  store.rules.retain(|rule| rule.id != id);
  write_store(&app, &store)
}

#[tauri::command(async)]
pub fn archive_move_password_rule(app: AppHandle, id: String, delta: i32) -> Result<(), String> {
  let mut store = read_store(&app)?;
  let Some(index) = store.rules.iter().position(|rule| rule.id == id) else {
    return Ok(());
  };
  let target = index as i64 + i64::from(delta.clamp(-1, 1));
  if target < 0 || target as usize >= store.rules.len() {
    return Ok(());
  }
  store.rules.swap(index, target as usize);
  write_store(&app, &store)
}

/// Which rule a name would hit, and whether a default exists. Passwords stay in Rust; the
/// panel only needs to know whether the answer is "rule r3" or "the default".
#[tauri::command(async)]
pub fn archive_test_password_rule(
  app: AppHandle,
  name: String,
  path: String,
) -> Result<RuleTest, String> {
  let store = read_store(&app)?;
  Ok(RuleTest {
    rule: matching_rule(&store, &name, &path).map(RuleView::from),
    default_set: store
      .default
      .as_deref()
      .is_some_and(|blob| !blob.is_empty()),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn rule(id: &str, pattern: &str, target: &str, enabled: bool) -> StoredRule {
    StoredRule {
      id: id.into(),
      pattern: pattern.into(),
      target: target.into(),
      enabled,
      ..Default::default()
    }
  }

  #[test]
  fn the_first_matching_rule_wins_and_disabled_ones_are_skipped() {
    let store = StoreFile {
      version: 1,
      default: None,
      rules: vec![
        rule("r1", "never", "name", true),
        rule("r2", "invoice", "name", false),
        rule("r3", "invoice", "name", true),
        rule("r4", "invoice", "path", true),
      ],
    };
    let hit = matching_rule(&store, "2026-invoice.zip", r"D:\packs\2026-invoice.zip").unwrap();
    assert_eq!(hit.id, "r3");
    assert!(matching_rule(&store, "plain.zip", r"D:\packs\plain.zip").is_none());
  }

  #[test]
  fn a_rule_can_match_the_path_instead_of_the_name() {
    let store = StoreFile {
      version: 1,
      default: None,
      rules: vec![rule("r1", r"finance", "path", true)],
    };
    assert!(matching_rule(&store, "a.zip", r"D:\finance\a.zip").is_some());
    assert!(matching_rule(&store, "a.zip", r"D:\work\a.zip").is_none());
  }

  #[test]
  fn flags_outside_ims_are_dropped_and_i_makes_the_match_case_insensitive() {
    let mut stored = rule("r1", "invoice", "name", true);
    stored.flags = "ixm".into();
    assert_eq!(clean_flags(&stored.flags), "im");
    stored.flags = "i".into();
    let store = StoreFile {
      version: 1,
      default: None,
      rules: vec![stored],
    };
    assert!(matching_rule(&store, "INVOICE.zip", "INVOICE.zip").is_some());
  }

  #[test]
  fn a_pattern_that_does_not_compile_is_rejected_rather_than_stored() {
    let probe = StoredRule {
      pattern: "([a-".into(),
      ..Default::default()
    };
    assert!(compile(&probe).is_none());
  }

  #[test]
  fn a_new_rule_gets_an_id_no_other_rule_holds() {
    let store = StoreFile {
      version: 1,
      default: None,
      rules: vec![rule("r1", "a", "name", true), rule("r3", "b", "name", true)],
    };
    assert_eq!(new_id(&store), "r2");
  }

  #[test]
  fn the_session_cache_forgets_after_the_idle_window() {
    let state = ArchivePasswords::default();
    state.remember("d", "pw", None);
    assert_eq!(state.recall("d", None).as_deref(), Some("pw"));
    state.remember("d", "pw", None);
    {
      let mut session = state.session.lock().unwrap();
      let cached = session.get_mut("d").unwrap();
      cached.last_used -= Duration::from_secs(600);
    }
    assert!(state.recall("d", Some(Duration::from_secs(60))).is_none());
  }

  #[test]
  fn a_success_clears_the_failure_count() {
    let state = ArchivePasswords::default();
    state.note_failure("d");
    state.note_failure("d");
    assert_eq!(state.failures("d"), 2);
    state.remember("d", "pw", None);
    assert_eq!(state.failures("d"), 0);
  }
}
