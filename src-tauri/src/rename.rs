//! Renaming a file or a folder, and re-homing everything the app keys by its path.
//!
//! A path is the identity of a document across the whole store: drafts are named by the
//! SHA-256 of it, the per-file overrides are keyed by it, and so are the recent-files list,
//! the tabs of every group and the folder the Explorer is showing. Renaming only the
//! filesystem would leave all of those pointing at a file that no longer exists, so the
//! command moves the entry and then moves the state that follows it.

use crate::commands::{self, protected_roots, refused_by_scope, HistoryEntry, Settings};
use crate::draft;
use crate::file_settings;
use crate::group::GroupStore;
use serde::Serialize;
use std::path::Path;
use tauri::AppHandle;

/// What moved. Both sides are normalized, because that is how every store keys them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
  pub old_path: String,
  pub path: String,
}

/// Longest single name segment Windows will take.
const MAX_NAME_LEN: usize = 255;

/// Names Windows reserves at the top of a segment, extension or not.
const RESERVED: [&str; 22] = [
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
  "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn is_sep(byte: u8) -> bool {
  byte == b'\\' || byte == b'/'
}

/// True when `path` is `root` itself or sits inside it. Both are normalized.
fn under(path: &str, root: &str) -> bool {
  if path == root {
    return true;
  }
  // The boundary has to be a separator: `C:\ab` is not inside `C:\a`.
  path.len() > root.len() && path.starts_with(root) && is_sep(path.as_bytes()[root.len()])
}

/// Swap the leading `old` for `new`, leaving the rest of the path alone.
///
/// A file rename only ever matches the exact path, while a folder rename carries its whole
/// subtree along, which is why the one rule below covers both.
pub(crate) fn rekey(path: &str, old: &str, new: &str) -> String {
  if path == old {
    return new.to_string();
  }
  if under(path, old) {
    // `old` ends before an ASCII separator, so the byte offset is a character boundary.
    return format!("{new}{}", &path[old.len()..]);
  }
  path.to_string()
}

/// Turn what the user typed into one path segment, or say why it is not one.
///
/// Only a bare name is accepted: a separator would move the entry out of the folder it was
/// renamed from, and a leading dot would let it land somewhere the user is not looking at.
pub fn validate_name(raw: &str) -> Result<String, String> {
  let name = raw.trim().trim_matches('"').trim();
  if name.is_empty() {
    return Err("rename_name_empty".into());
  }
  if name.chars().count() > MAX_NAME_LEN {
    return Err("rename_name_invalid".into());
  }
  if name.contains(|c: char| {
    matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c as u32 <= 31
  }) {
    return Err("rename_name_invalid".into());
  }
  // Windows drops a trailing dot when it creates the entry, so the name typed is not the
  // name got. A trailing space is already gone: the trim above takes it, which is what
  // Windows would have done anyway.
  if name.ends_with('.') {
    return Err("rename_name_invalid".into());
  }
  // Nothing above separates segments, so these two are the only way a name can be a
  // pointer rather than an entry — and a dotfile is still a name worth allowing.
  if name == "." || name == ".." {
    return Err("rename_name_invalid".into());
  }
  let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
  if RESERVED.contains(&stem.as_str()) {
    return Err("rename_name_invalid".into());
  }
  Ok(name.to_string())
}

#[tauri::command]
pub fn rename_path(app: AppHandle, path: String, name: String) -> Result<Renamed, String> {
  let clean = validate_name(&name)?;
  let old = draft::normalize_path(&path);
  if old.is_empty() {
    return Err("path_empty".into());
  }
  let source = Path::new(&old);
  source
    .metadata()
    .map_err(|e| format!("rename_not_found:{e}"))?;
  // The same line the asset scope draws: a folder that holds a whole drive, the system
  // directory or the user's profile is not this app's to rename.
  if refused_by_scope(source, &protected_roots()) {
    return Err("rename_refused".into());
  }
  let parent = source.parent().ok_or("rename_no_parent")?;
  let new = draft::normalize_path(&parent.join(&clean).to_string_lossy());
  if new.is_empty() {
    return Err("path_unresolvable".into());
  }
  // Everything the app keeps is spelled lowercase on Windows, so a rename that only changes
  // case cannot be stored. Say nothing and move nothing rather than half-doing it.
  if new != old {
    if Path::new(&new).exists() {
      return Err("rename_exists".into());
    }
    std::fs::rename(source, &new).map_err(|e| format!("rename_failed:{e}"))?;
    rekey_state(&app, &old, &new)?;
  }
  Ok(Renamed {
    old_path: old,
    path: new,
  })
}

/// Move every stored path that pointed at `old` or inside it.
fn rekey_state(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  draft::rekey_prefix(app, old, new)?;
  file_settings::rekey_prefix(app, old, new)?;
  rekey_groups(app, old, new)?;
  rekey_history(app, old, new)?;
  rekey_sidebar_root(app, old, new)
}

fn rekey_groups(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let Some(mut store) = commands::read_json::<GroupStore>(app, commands::GROUPS_FILE)? else {
    return Ok(())
  };
  store.rekey_prefix(old, new);
  commands::write_json(app, commands::GROUPS_FILE, &store)
}

fn rekey_history(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let Some(mut history) = commands::read_json::<Vec<HistoryEntry>>(app, "history.json")? else {
    return Ok(())
  };
  let mut changed = false;
  for item in &mut history {
    let moved = rekey(&item.path, old, new);
    if moved != item.path {
      item.path = moved;
      // The name is what the list shows, so it follows the path rather than staying stale.
      item.name = Path::new(&item.path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| item.path.clone());
      changed = true;
    }
  }
  // An untouched list needs no rewrite, and skipping it keeps a rename from being a save.
  if changed {
    commands::write_json(app, "history.json", &history)?;
  }
  Ok(())
}

fn rekey_sidebar_root(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let Some(settings) = commands::read_json::<Settings>(app, "settings.json")? else {
    return Ok(())
  };
  let root = draft::normalize_path(&settings.sidebar_root);
  if root.is_empty() {
    return Ok(());
  }
  let moved = rekey(&root, old, new);
  if moved == root {
    return Ok(());
  }
  let settings = settings.filled();
  commands::write_json(
    app,
    "settings.json",
    &Settings {
      sidebar_root: moved,
      ..settings
    },
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn a_bare_name_is_taken_as_written() {
    for name in [
      "notes.md",
      "a",
      "v1.2.3",
      "my file.txt",
      ".gitignore.bak",
      ".env",
      "1-2-3",
    ] {
      assert_eq!(validate_name(name).as_deref(), Ok(name), "{name} rejected");
    }
    assert_eq!(validate_name("  padded  ").as_deref(), Ok("padded"));
    assert_eq!(validate_name("\"quoted\"").as_deref(), Ok("quoted"));
  }

  /// A name carrying a separator is a different command: it moves the entry somewhere else
  /// rather than renaming it in place.
  #[test]
  fn a_name_cannot_reach_outside_its_folder() {
    for name in [
      ".",
      "..",
      "../elsewhere",
      r"..\..\wrolp\state\groups.json",
      r"sub\file.txt",
      "sub/file.txt",
      r"C:\Windows\notepad.exe",
      "a:b",
      "a|b",
      "a*b?c",
      "a<b>c",
      "",
      "   ",
      "trailing.",
      "dots.only.",
    ] {
      assert!(validate_name(name).is_err(), "{name} should be refused");
    }
  }

  #[test]
  fn windows_reserved_names_are_refused_whatever_the_extension() {
    for name in ["con", "CON", "nul.txt", "COM1.log", "lpt9", "aux.md"] {
      assert!(validate_name(name).is_err(), "{name} should be refused");
    }
    // Only the leading segment is reserved: a file that merely mentions one is fine.
    assert!(validate_name("console-notes.md").is_ok());
    assert!(validate_name("com10.txt").is_ok());
  }

  #[test]
  fn an_over_long_name_is_refused() {
    let edge = "n".repeat(MAX_NAME_LEN);
    assert!(validate_name(&edge).is_ok());
    assert!(validate_name(&format!("{edge}x")).is_err());
  }

  #[test]
  fn rekey_moves_the_entry_and_its_whole_subtree() {
    let old = r"c:\notes\project";
    let new = r"c:\notes\project-renamed";
    assert_eq!(rekey(old, old, new), new);
    assert_eq!(
      rekey(r"c:\notes\project\a.md", old, new),
      r"c:\notes\project-renamed\a.md"
    );
    assert_eq!(
      rekey(r"c:\notes\project\deep\b.md", old, new),
      r"c:\notes\project-renamed\deep\b.md"
    );
  }

  /// `C:\ab` must not be read as being inside `C:\a`, and a sibling that shares a prefix
  /// must not be dragged along with the folder that was renamed.
  #[test]
  fn rekey_leaves_everything_outside_the_renamed_path_alone() {
    let old = r"c:\notes\pro";
    let new = r"c:\notes\project";
    for other in [
      r"c:\notes\project\a.md",
      r"c:\notes\project",
      r"c:\notes",
      r"d:\other\a.md",
      "untitled://Untitled-1",
    ] {
      assert_eq!(rekey(other, old, new), other, "{other} should not move");
    }
  }

  #[test]
  fn the_file_case_only_differs_by_spelling() {
    // A renamed file keeps its subtree spelling, so a deeper path is not re-lowercased here.
    assert!(under(r"c:\a\b", r"c:\a"));
    assert!(!under(r"c:\a", r"c:\a\b"));
    assert!(under(r"c:\a", r"c:\a"));
    assert!(!under(r"c:\ab", r"c:\a"));
  }
}
