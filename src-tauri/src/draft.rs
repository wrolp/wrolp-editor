//! Draft storage: unsaved editor content is mapped to a standalone draft file
//! keyed by the SHA-256 of the normalized absolute path.

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager};

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
  if cfg!(windows) {
    text.replace('/', "\\").to_lowercase()
  } else {
    text
  }
}

fn draft_key(raw: &str) -> String {
  let normalized = normalize_path(raw);
  if normalized.is_empty() {
    return String::new();
  }
  let mut hasher = Sha256::new();
  hasher.update(normalized.as_bytes());
  let digest = hasher.finalize();
  digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn draft_file(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
  let key = draft_key(raw);
  if key.is_empty() {
    return Err("path_unresolvable".into());
  }
  Ok(drafts_dir(app)?.join(format!("{key}.draft")))
}

pub fn load(app: &AppHandle, raw: &str) -> Result<Option<Draft>, String> {
  let file = draft_file(app, raw)?;
  let bytes = match std::fs::read(&file) {
    Ok(b) => b,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("draft_read:{e}")),
  };
  match serde_json::from_slice::<Draft>(&bytes) {
    Ok(d) => Ok(Some(d)),
    Err(e) => {
      // A broken draft must not block opening the file; drop it.
      let _ = std::fs::remove_file(&file);
      Err(format!("draft_corrupt:{e}"))
    }
  }
}

pub fn save(app: &AppHandle, raw: &str, content: &str, cursor: usize) -> Result<Draft, String> {
  let file = draft_file(app, raw)?;
  let draft = Draft {
    path: raw.to_string(),
    content: content.to_string(),
    cursor,
    updated_at: Utc::now().to_rfc3339(),
  };
  let json = serde_json::to_vec(&draft).map_err(|e| e.to_string())?;
  // Write a temp file first, then swap: an interrupted write cannot leave half a JSON behind.
  let tmp = file.with_extension("tmp");
  std::fs::write(&tmp, &json).map_err(|e| format!("draft_write:{e}"))?;
  if file.exists() {
    std::fs::remove_file(&file).map_err(|e| format!("draft_replace:{e}"))?;
  }
  std::fs::rename(&tmp, &file).map_err(|e| format!("draft_replace:{e}"))?;
  Ok(draft)
}

pub fn clear(app: &AppHandle, raw: &str) -> Result<bool, String> {
  let file = draft_file(app, raw)?;
  match std::fs::remove_file(&file) {
    Ok(()) => Ok(true),
    // Nothing there to begin with counts as cleared.
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
    Err(e) => Err(format!("draft_delete:{e}")),
  }
}

/// Move the drafts of `old` and of everything inside it to the paths they now belong to.
///
/// A draft file is named by the hash of the path it was written for, so a rename cannot edit
/// it in place: it has to be re-created under the new key and the old file removed. The
/// `path` stored inside each one is what says where it belongs, since the name is opaque.
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
    let Ok(bytes) = std::fs::read(&file) else { continue };
    let Ok(stored) = serde_json::from_slice::<Draft>(&bytes) else { continue };
    let before = normalize_path(&stored.path);
    let moved = crate::rename::rekey(&before, old, new);
    if moved == before {
      continue;
    }
    let target = draft_file(app, &moved)?;
    let draft = Draft {
      path: moved,
      ..stored
    };
    let json = serde_json::to_vec(&draft).map_err(|e| e.to_string())?;
    crate::commands::write_atomic(&target, &json)?;
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
    let a = draft_key(r"C:\Users\x\a.txt");
    let b = draft_key("c:/users/X/A.TXT");
    assert_eq!(a, b);
    assert_eq!(a.len(), 64);
  }

  #[test]
  fn key_resolves_dot_segments() {
    assert_eq!(
      draft_key(r"C:\Users\x\a.txt"),
      draft_key(r"C:\Users\x\sub\..\a.txt")
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
    assert_eq!(draft_key("   "), "");
  }
}
