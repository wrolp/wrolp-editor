//! Draft storage: unsaved editor content is mapped to a standalone draft file named after
//! the file it belongs to and keyed by the SHA-256 of that file's normalized absolute path.
//!
//! A draft of an encrypted file is sealed with that file's key before it is written, so
//! the text never reaches the disk in the clear next to a document the user encrypted.
//! When no key is available the draft is not written at all, and an existing sealed draft
//! is left on disk unread rather than deleted: it becomes readable again the moment the
//! file is unlocked.

use crate::crypto::{self, KEY_LEN};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

/// Contents of a draft file. Serialized as camelCase so it maps 1:1 to the frontend type.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
  /// Original file path, kept as the user sees it.
  pub path: String,
  /// Unsaved content.
  pub content: String,
  /// Cursor offset within the document (Monaco model offset).
  pub cursor: usize,
  /// Last update time, ISO-8601 UTC.
  pub updated_at: String,
}

/// What a draft file holds for an encrypted file: the `Draft` JSON, sealed.
///
/// The path stays outside the ciphertext on purpose. It is not a secret — it is the name
/// of a file sitting in a directory listing — and keeping it readable is what lets a
/// rename move a sealed draft to its new key without the key being present.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SealedDraft {
  /// 2. A version 1 draft is a bare `Draft` with no wrapper, and stays readable.
  v: u8,
  path: String,
  /// Hex, 12 bytes.
  nonce: String,
  /// Hex of the sealed `Draft` JSON.
  data: String,
}

const SEALED_VERSION: u8 = 2;

/// Whether a draft may be written as it stands, has to be sealed first, or must not be
/// written at all.
///
/// The key is owned, not borrowed: it arrives by value out of the session cache, so there
/// is nothing for it to borrow from.
pub enum DraftKey {
  /// The file is not encrypted.
  Plain,
  /// The file is encrypted and unlocked.
  Sealed([u8; KEY_LEN]),
  /// The file is encrypted and locked. Writing the text out anyway would leave the
  /// document's contents in the clear beside an encrypted file, which is the one thing
  /// encrypting it was meant to prevent.
  Locked,
}

impl Drop for DraftKey {
  fn drop(&mut self) {
    if let DraftKey::Sealed(key) = self {
      key.zeroize();
    }
  }
}

fn to_hex(bytes: &[u8]) -> String {
  bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
  if text.len() % 2 != 0 {
    return None;
  }
  (0..text.len())
    .step_by(2)
    .map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok())
    .collect()
}

fn wrolp_dir(app: &AppHandle, sub: &str) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|e| e.to_string())?
    .join("wrolp")
    .join(sub);
  std::fs::create_dir_all(&dir).map_err(|e| format!("dir_create:{e}"))?;
  Ok(dir)
}

pub fn drafts_dir(app: &AppHandle) -> Result<PathBuf, String> {
  wrolp_dir(app, "drafts")
}

pub fn store_dir(app: &AppHandle) -> Result<PathBuf, String> {
  wrolp_dir(app, "state")
}

/// Where configuration snapshots live when the user has not chosen another folder.
///
/// A sibling of `state` rather than inside it: the live files and their history share an app
/// data root, but not one directory, so nothing that scans one can mistake the other's files.
pub fn backups_dir(app: &AppHandle) -> Result<PathBuf, String> {
  wrolp_dir(app, "backups")
}

/// Where the text of a file that was deleted while it was open is parked.
///
/// Not a draft: this is a whole file with the name it had, kept so it can be opened again
/// like any other, rather than a note about edits that were never saved.
pub fn kept_dir(app: &AppHandle) -> Result<PathBuf, String> {
  wrolp_dir(app, "kept")
}

/// Strip the Windows `\\?\` / `\\.\` verbatim prefix that canonicalize() adds.
fn strip_verbatim(path: &str) -> String {
  if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
    return format!(r"\\{rest}");
  }
  if let Some(rest) = path.strip_prefix(r"\\?\") {
    return rest.to_string();
  }
  path.to_string()
}

/// Purely lexical normalization: collapse `.` and `..`, keep the leading root.
fn lexically_normalize(path: &Path) -> PathBuf {
  let mut out = PathBuf::new();
  for comp in path.components() {
    match comp {
      Component::CurDir => {}
      Component::ParentDir => {
        if !out.pop() {
          out.push(Component::ParentDir);
        }
      }
      other => out.push(other),
    }
  }
  out
}

/// Normalize into a comparable absolute path; lowercased on Windows because its
/// filesystem is case-insensitive. Falls back to lexical absolutization when the
/// file does not exist yet (e.g. a "Save as" destination).
pub fn normalize_path(raw: &str) -> String {
  normalize_to(raw, cfg!(windows))
}

/// The same normalization with the case kept, for a path that is shown to a person rather
/// than compared to another path. Identity always goes through [`normalize_path`], so two
/// spellings of one file stay one entry; the case-preserving form is what lets a stored
/// name read like the file it names.
pub(crate) fn normalize_path_preserved(raw: &str) -> String {
  normalize_to(raw, false)
}

fn normalize_to(raw: &str, lowercase: bool) -> String {
  let trimmed = raw.trim().trim_matches('"').trim_matches('\'');
  if trimmed.is_empty() {
    return String::new();
  }
  let candidate = Path::new(trimmed);
  let absolutized: PathBuf = if candidate.is_absolute() {
    candidate.to_path_buf()
  } else {
    std::env::current_dir()
      .map(|cwd| cwd.join(candidate))
      .unwrap_or_else(|_| candidate.to_path_buf())
  };
  let resolved = match absolutized.canonicalize() {
    Ok(p) => p,
    Err(_) => lexically_normalize(&absolutized),
  };
  let text = strip_verbatim(&resolved.to_string_lossy());
  let text = if cfg!(windows) {
    text.replace('/', "\\")
  } else {
    text
  };
  if lowercase {
    text.to_lowercase()
  } else {
    text
  }
}

fn digest(normalized: &str) -> String {
  let mut hasher = Sha256::new();
  hasher.update(normalized.as_bytes());
  let value = hasher.finalize();
  value.iter().map(|b| format!("{b:02x}")).collect()
}

/// The digest that identifies a path: the tail of every draft file's name, the key of the
/// per-file overrides, the credential-manager account a remembered password is stored
/// under, and the name of a shadow repository. One derivation, so a path means the same
/// thing in all four.
///
/// The override store and the credential account carry nothing but this digest, because both
/// are places a name goes where the file it names is not wanted. A draft file is the one
/// exception: it leads with the file's own name, which is already stored in plain text inside
/// the draft and inside the sealed envelope's path, so putting it in the file name tells a
/// person browsing the folder something they could already read.
pub(crate) fn path_key(raw: &str) -> String {
  let normalized = normalize_path(raw);
  if normalized.is_empty() {
    return String::new();
  }
  digest(&normalized)
}

/// The most of a draft file's name given to the file's own name. The digest is 64 characters
/// on its own and the folder sits well inside the profile, so a name that runs to two hundred
/// characters is cut rather than followed.
const LABEL_MAX: usize = 48;

/// The readable half of a draft file's name: the last component of the path, with what no
/// filesystem takes removed and the length capped. A shadow repository directory is named the
/// same way, so both folders can be browsed by a person.
pub(crate) fn label_of(normalized: &str) -> String {
  let name = normalized.rsplit(['/', '\\']).next().unwrap_or_default();
  // A control character would make the name unusable in a shell, and none of these survive as
  // a Windows file name. A reserved name like `CON` cannot come out of this either: those are
  // matched exactly, and every draft stem has `-` and 64 more characters behind it.
  let cleaned: String = name
    .chars()
    .filter(|c| !matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    .filter(|c| !c.is_control())
    .collect();
  // NTFS will not take a file name ending in a dot or a space.
  let cleaned = cleaned
    .trim_end_matches(|c| c == '.' || c == ' ')
    .to_string();
  if cleaned.is_empty() {
    return "unnamed".into();
  }
  if cleaned.chars().count() <= LABEL_MAX {
    return cleaned;
  }
  // Cut the stem and keep the extension: the extension is what tells two capped names apart at
  // a glance, and the digest behind them already makes the name unique.
  let path = Path::new(&cleaned);
  let stem = path
    .file_stem()
    .and_then(|s| s.to_str())
    .unwrap_or(&cleaned);
  let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
  let keep = LABEL_MAX.saturating_sub(ext.chars().count() + 1).max(1);
  let taken: String = stem.chars().take(keep).collect();
  if ext.is_empty() {
    taken
  } else {
    format!("{taken}.{ext}")
  }
}

/// The whole stem of a draft file's name: the file's own name, then the digest of its
/// normalized path. The name is there to be read — a folder of bare digests says nothing about
/// which document has edits waiting — and the digest is what it is keyed by, because two
/// `notes.md` files in two folders must not answer to one draft.
fn draft_stem(raw: &str) -> Option<String> {
  let normalized = normalize_path(raw);
  if normalized.is_empty() {
    return None;
  }
  Some(format!("{}-{}", label_of(&normalized), digest(&normalized)))
}

fn draft_file(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
  let stem = draft_stem(raw).ok_or_else(|| "path_unresolvable".to_string())?;
  Ok(drafts_dir(app)?.join(format!("{stem}.draft")))
}

/// The name every draft carried before the file's own name went into it: the bare digest. Still
/// read, and retired as it is read, because an upgrade must not look like lost edits.
fn legacy_draft_file(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
  let key = path_key(raw);
  if key.is_empty() {
    return Err("path_unresolvable".into());
  }
  Ok(drafts_dir(app)?.join(format!("{key}.draft")))
}

/// Read a draft, preferring the current name and falling back to the bare-digest name. It
/// reports which file the bytes came from, so the caller can retire the old name rather than
/// leave a second draft for the same path behind.
fn read_draft(
  app: &AppHandle,
  raw: &str,
  file: &Path,
) -> Result<Option<(PathBuf, Vec<u8>)>, String> {
  match std::fs::read(file) {
    Ok(bytes) => return Ok(Some((file.to_path_buf(), bytes))),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
    Err(e) => return Err(format!("draft_read:{e}")),
  }
  let legacy = legacy_draft_file(app, raw)?;
  match std::fs::read(&legacy) {
    Ok(bytes) => Ok(Some((legacy, bytes))),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("draft_read:{e}")),
  }
}

pub fn load(app: &AppHandle, raw: &str, key: DraftKey) -> Result<Option<Draft>, String> {
  let file = draft_file(app, raw)?;
  let (source, bytes) = match read_draft(app, raw, &file)? {
    Some(found) => found,
    None => return Ok(None),
  };
  let outcome = match parse_stored(&bytes) {
    Ok(Stored::Plain(draft)) => Ok(Some(draft)),
    Ok(Stored::Sealed(sealed)) => {
      let DraftKey::Sealed(key) = &key else {
        // Locked, or the file is not encrypted any more. Either way the draft is not
        // broken, only unreadable right now, so it stays on disk: deleting it would throw
        // away edits that come back the moment the file is unlocked.
        return Ok(None);
      };
      match open_sealed(&sealed, key) {
        Ok(mut draft) => {
          // The path outside the ciphertext says where a draft belongs, so a rename can
          // move a sealed draft without the key that seals it.
          draft.path = sealed.path;
          Ok(Some(draft))
        }
        // The key is the one this file is unlocked under, so a payload that will not open
        // is damaged beyond use. It cannot be recovered by waiting.
        Err(e) => Err(e),
      }
    }
    Err(e) => Err(e),
  };
  if outcome.is_err() {
    // A broken draft must not block opening the file; drop it.
    let _ = std::fs::remove_file(&source);
    return outcome;
  }
  if source != file {
    // One draft per path, in one name: what was read under the old name moves up to the new.
    // Not failing the open if the move does not work — the draft is already in hand.
    let _ = std::fs::rename(&source, &file);
  }
  outcome
}

enum Stored {
  Plain(Draft),
  Sealed(SealedDraft),
}

/// A draft file is either a bare version 1 `Draft` or a sealed version 2 wrapper, and the
/// two cannot be confused: each has fields the other lacks and neither fills in defaults.
fn parse_stored(bytes: &[u8]) -> Result<Stored, String> {
  if let Ok(sealed) = serde_json::from_slice::<SealedDraft>(bytes) {
    return Ok(Stored::Sealed(sealed));
  }
  serde_json::from_slice::<Draft>(bytes)
    .map(Stored::Plain)
    .map_err(|e| format!("draft_corrupt:{e}"))
}

fn open_sealed(sealed: &SealedDraft, key: &[u8; KEY_LEN]) -> Result<Draft, String> {
  let hex_nonce =
    from_hex(&sealed.nonce).ok_or_else(|| "draft_corrupt:nonce is not hex".to_string())?;
  if hex_nonce.len() != crypto::NONCE_LEN {
    return Err("draft_corrupt:nonce has the wrong length".into());
  }
  let mut nonce = [0u8; crypto::NONCE_LEN];
  nonce.copy_from_slice(&hex_nonce);
  let payload =
    from_hex(&sealed.data).ok_or_else(|| "draft_corrupt:payload is not hex".to_string())?;
  let json = crypto::unseal(&payload, key, &nonce)?;
  serde_json::from_slice::<Draft>(&json).map_err(|e| format!("draft_corrupt:{e}"))
}

/// The bytes of a draft file for an encrypted document: the `Draft` JSON sealed under the
/// file's key, in an envelope that carries the nonce and the path in the clear.
fn seal_envelope(raw: &str, json: &[u8], key: &[u8; KEY_LEN]) -> Result<Vec<u8>, String> {
  let nonce = crypto::random_nonce()?;
  let sealed = SealedDraft {
    v: SEALED_VERSION,
    path: raw.to_string(),
    data: to_hex(&crypto::seal(json, key, &nonce)?),
    nonce: to_hex(&nonce),
  };
  serde_json::to_vec(&sealed).map_err(|e| e.to_string())
}

/// Write the draft, sealed when the file it belongs to is encrypted.
///
/// `Ok(None)` means nothing was written because the file is locked. That is not an error
/// and must not be reported as one: drafting happens in the background while the user
/// types, and a dialog for something they did not ask for would be noise. Saving the file
/// itself does fail loudly, so nothing is silently lost.
pub fn save(
  app: &AppHandle,
  raw: &str,
  content: &str,
  cursor: usize,
  key: DraftKey,
) -> Result<Option<Draft>, String> {
  let file = draft_file(app, raw)?;
  let draft = Draft {
    path: raw.to_string(),
    content: content.to_string(),
    cursor,
    updated_at: Utc::now().to_rfc3339(),
  };
  let json = serde_json::to_vec(&draft).map_err(|e| e.to_string())?;
  let bytes = match &key {
    DraftKey::Locked => return Ok(None),
    DraftKey::Plain => json,
    DraftKey::Sealed(key) => seal_envelope(raw, &json, key)?,
  };
  // Write a temp file first, then swap: an interrupted write cannot leave half a JSON
  // behind. Nothing is removed on the way, because `rename` already replaces the target on
  // Windows and deleting it first would leave a moment in which the draft is simply gone.
  let tmp = file.with_extension("tmp");
  std::fs::write(&tmp, &bytes).map_err(|e| format!("draft_write:{e}"))?;
  std::fs::rename(&tmp, &file).map_err(|e| format!("draft_replace:{e}"))?;
  if let Ok(legacy) = legacy_draft_file(app, raw) {
    // The new name is the draft now. Leaving the digest-only file behind would keep a second,
    // older copy of the same draft one lookup away.
    let _ = std::fs::remove_file(legacy);
  }
  Ok(Some(draft))
}

pub fn clear(app: &AppHandle, raw: &str) -> Result<bool, String> {
  let file = draft_file(app, raw)?;
  let removed = match std::fs::remove_file(&file) {
    Ok(()) => true,
    // Nothing there to begin with counts as cleared.
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
    Err(e) => return Err(format!("draft_delete:{e}")),
  };
  // Both names, because a draft written before the file's name went into it is still the draft
  // of this path, and `load` falls back to that name whenever the current one is missing:
  // clearing only the new one would bring the old text back on the next open.
  let legacy = legacy_draft_file(app, raw)?;
  match std::fs::remove_file(&legacy) {
    Ok(()) => Ok(true),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(removed),
    Err(e) => Err(format!("draft_delete:{e}")),
  }
}

/// Move the drafts of `old` and of everything inside it to the paths they now belong to.
///
/// A draft file is named for the path it was written for, so a rename cannot edit it in place:
/// it has to be re-created under the new name and the old file removed. The readable half of the
/// name is only the last component of the old path and the digest does not run backwards, so the
/// `path` stored inside each one is what says where it belongs.
/// A sealed draft keeps its payload untouched and only has that path rewritten, which is
/// why the path is not part of what the key protects.
pub fn rekey_prefix(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let read = match std::fs::read_dir(drafts_dir(app)?) {
    Ok(read) => read,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
    Err(e) => return Err(format!("dir_read:{e}")),
  };
  for item in read.flatten() {
    let file = item.path();
    if file.extension().and_then(|e| e.to_str()) != Some("draft") {
      continue;
    }
    // A draft that will not parse is left alone: opening its file drops it, and a rename
    // has no business destroying text it could not read.
    let Ok(bytes) = std::fs::read(&file) else {
      continue;
    };
    let Ok(stored) = parse_stored(&bytes) else {
      continue;
    };
    let (moved, rewritten) = match stored {
      Stored::Plain(draft) => {
        let before = normalize_path(&draft.path);
        let moved = crate::rename::rekey(&before, old, new);
        if moved == before {
          continue;
        }
        let draft = Draft {
          path: moved.clone(),
          ..draft
        };
        (
          moved,
          serde_json::to_vec(&draft).map_err(|e| e.to_string())?,
        )
      }
      Stored::Sealed(sealed) => {
        let before = normalize_path(&sealed.path);
        let moved = crate::rename::rekey(&before, old, new);
        if moved == before {
          continue;
        }
        let sealed = SealedDraft {
          path: moved.clone(),
          ..sealed
        };
        (
          moved,
          serde_json::to_vec(&sealed).map_err(|e| e.to_string())?,
        )
      }
    };
    let target = draft_file(app, &moved)?;
    crate::commands::write_atomic(&target, &rewritten)?;
    if target != file {
      let _ = std::fs::remove_file(&file);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn key_is_stable_across_separators_and_case() {
    let a = path_key(r"C:\Users\x\a.txt");
    let b = path_key("c:/users/X/A.TXT");
    assert_eq!(a, b);
    assert_eq!(a.len(), 64);
  }

  #[test]
  fn key_resolves_dot_segments() {
    assert_eq!(
      path_key(r"C:\Users\x\a.txt"),
      path_key(r"C:\Users\x\sub\..\a.txt")
    );
  }

  #[test]
  fn verbatim_prefix_is_stripped() {
    assert_eq!(strip_verbatim(r"\\?\C:\Users\x\a.txt"), r"C:\Users\x\a.txt");
    assert_eq!(
      strip_verbatim(r"\\?\UNC\server\share\a.txt"),
      r"\\server\share\a.txt"
    );
  }

  #[test]
  fn empty_path_yields_empty_key() {
    assert_eq!(path_key("   "), "");
  }

  /// A folder of bare digests is a folder of anonymous files. The name of the document whose
  /// edits are waiting goes in front, and the digest stays behind it because two `notes.md`
  /// files in two folders must never answer to one draft.
  #[test]
  fn a_draft_name_leads_with_the_file_and_ends_with_the_digest() {
    let stem = draft_stem(r"C:\Notes\work\report.pdf").expect("stem");
    assert!(stem.starts_with("report.pdf-"), "{stem}");
    assert_eq!(stem.len(), "report.pdf-".len() + 64);
    assert_eq!(
      stem["report.pdf-".len()..],
      path_key(r"C:\Notes\work\report.pdf")
    );
    // Every spelling of one path is one draft file, so the readable half cannot disagree with
    // the digest about which file this is.
    assert_eq!(
      stem,
      draft_stem(r"c:/notes/work/../work/REPORT.PDF").expect("other stem")
    );
  }

  #[test]
  fn a_label_is_cleaned_capped_and_never_empty() {
    assert_eq!(label_of(r"c:\x\co?lon:.txt"), "colon.txt");
    assert_eq!(label_of(r"c:\x\trailing... "), "trailing");
    assert_eq!(label_of(r"c:\x\???"), "unnamed");
    let long = format!(r"c:\x\{}.txt", "a".repeat(120));
    let label = label_of(&long);
    assert!(label.chars().count() <= LABEL_MAX, "{label}");
    assert!(label.ends_with(".txt"), "the extension outlives the cap");
    // A reserved device name is matched exactly, and every stem has `-` and a digest behind it.
    assert_eq!(label_of(r"c:\x\CON"), "CON");
  }

  /// The old name is still the same digest, so a draft folder written by an earlier build is
  /// one rename away from the new shape rather than a lost set of edits.
  #[test]
  fn the_old_name_is_still_derivable_from_the_path() {
    let raw = r"C:\Notes\work\report.pdf";
    let key = path_key(raw);
    assert_eq!(key.len(), 64);
    assert!(draft_stem(raw).expect("stem").ends_with(&key));
    assert_eq!(path_key("   "), String::new());
    assert_eq!(draft_stem("   "), None);
  }

  const KEY: [u8; KEY_LEN] = [9u8; KEY_LEN];
  const PATH: &str = r"C:\Users\x\notes.md";

  fn draft_json(content: &str) -> Vec<u8> {
    serde_json::to_vec(&Draft {
      path: PATH.to_string(),
      content: content.to_string(),
      cursor: 3,
      updated_at: "2026-01-01T00:00:00+00:00".to_string(),
    })
    .expect("draft json")
  }

  /// A draft written before encryption existed has no envelope. It has to stay readable:
  /// the alternative is throwing away unsaved edits on the first run of a new build.
  #[test]
  fn a_version_1_draft_still_parses() {
    match parse_stored(&draft_json("old text")).expect("parse") {
      Stored::Plain(draft) => assert_eq!(draft.content, "old text"),
      Stored::Sealed(_) => panic!("a bare Draft is not a sealed one"),
    }
  }

  #[test]
  fn a_sealed_draft_round_trips_under_its_key() {
    let bytes = seal_envelope(PATH, &draft_json("secret"), &KEY).expect("seal");
    match parse_stored(&bytes).expect("parse") {
      Stored::Sealed(sealed) => {
        let draft = open_sealed(&sealed, &KEY).expect("unseal");
        assert_eq!(draft.content, "secret");
        assert_eq!(draft.cursor, 3);
      }
      Stored::Plain(_) => panic!("an envelope is not a bare Draft"),
    }
  }

  #[test]
  fn a_sealed_draft_needs_the_key_it_was_sealed_with() {
    let bytes = seal_envelope(PATH, &draft_json("secret"), &KEY).expect("seal");
    let Stored::Sealed(sealed) = parse_stored(&bytes).expect("parse") else {
      panic!("expected an envelope");
    };
    let err = open_sealed(&sealed, &[1u8; KEY_LEN]).expect_err("must fail");
    assert_eq!(err, "encrypted_corrupt");
  }

  /// The path is what says where a draft belongs, and a rename has to be able to move one
  /// without the key that seals it. So it stays outside the ciphertext on purpose.
  #[test]
  fn the_path_of_a_sealed_draft_is_readable_without_the_key() {
    let bytes = seal_envelope(PATH, &draft_json("secret"), &KEY).expect("seal");
    let value: serde_json::Value = serde_json::from_slice(&bytes).expect("envelope json");
    assert_eq!(value["path"], PATH);
    assert_eq!(value["v"], SEALED_VERSION);
    assert!(
      !bytes.windows("secret".len()).any(|w| w == b"secret"),
      "the content must not appear in the clear"
    );
  }

  #[test]
  fn one_byte_of_damage_in_a_sealed_draft_is_caught() {
    let bytes = seal_envelope(PATH, &draft_json("secret"), &KEY).expect("seal");
    let Stored::Sealed(sealed) = parse_stored(&bytes).expect("parse") else {
      panic!("expected an envelope");
    };
    // One hex digit of the payload changed: what a draft looks like after something on disk
    // went wrong, with the envelope itself still intact.
    let mut data = sealed.data.clone();
    let tail = data.pop().expect("payload");
    data.push(if tail == '0' { '1' } else { '0' });
    let damaged = SealedDraft { data, ..sealed };
    assert_eq!(
      open_sealed(&damaged, &KEY).expect_err("must fail"),
      "encrypted_corrupt"
    );
  }

  #[test]
  fn garbage_is_reported_as_a_corrupt_draft() {
    match parse_stored(b"not json at all") {
      Err(e) => assert!(e.starts_with("draft_corrupt:"), "{e}"),
      Ok(_) => panic!("garbage must not parse as a draft"),
    }
  }

  #[test]
  fn hex_that_is_not_hex_or_is_the_wrong_length_is_refused() {
    assert_eq!(from_hex("zz"), None);
    assert_eq!(from_hex("abc"), None);
    assert_eq!(to_hex(&[0u8, 255]), "00ff");
  }
}
