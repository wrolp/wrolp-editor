//! Creating and deleting files and folders, and letting go of the state that only existed
//! while they did.
//!
//! A path is the identity of a document across the whole store (see `rename`), so neither end
//! of this is only a filesystem operation: a typed name has to be one this app is willing to
//! put on disk, and a delete has to stop the store pointing at something that is gone.
//!
//! What a delete deliberately does *not* do is throw the drafts away. Those hold the unsaved
//! text of files that were open when the entry went; a file deleted by mistake and created
//! again should still be offered its own edits back, which is the one thing left that can be.

use crate::commands::{self, protected_roots, refused_by_scope, FsEntry, HistoryEntry, Settings};
use crate::draft;
use crate::group::{GroupStore, GroupTab};
use crate::rename::{check_name, under, NameError};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Extension given to a new file typed without one.
///
/// It is a text file by intent, and naming it as one keeps it out of the "unknown binary"
/// hole every other tool has for an extensionless name.
const DEFAULT_EXT: &str = "txt";

fn name_error(e: NameError) -> String {
  match e {
    NameError::Empty => "create_name_empty".to_string(),
    NameError::Invalid => "create_name_invalid".to_string(),
  }
}

/// The name an entry will be created under, extension included.
///
/// A name that carries any dot at all is left as typed: that covers a real extension and a
/// dotfile such as `.gitignore` alike, and appending to those would invent a name the user
/// did not ask for. Only a bare word gets `.txt`.
fn entry_name(typed: &str) -> String {
  if typed.contains('.') {
    typed.to_string()
  } else {
    format!("{typed}.{DEFAULT_EXT}")
  }
}

/// Where the entry will live, or why it cannot be created there.
///
/// The parent has to be a directory that is there now. Recreating the chain instead would
/// turn a folder the tree has just lost into a brand new one, several levels up from where
/// the user is looking.
fn target_of(parent: &str, name: &str) -> Result<PathBuf, String> {
  let dir = draft::normalize_path(parent);
  if dir.is_empty() {
    return Err("path_empty".into());
  }
  let dir = Path::new(&dir);
  if !dir.is_dir() {
    return Err("create_no_parent".into());
  }
  let path = draft::normalize_path(&dir.join(name).to_string_lossy());
  if path.is_empty() {
    return Err("path_unresolvable".into());
  }
  Ok(PathBuf::from(path))
}

/// Create an empty file inside `parent`.
///
/// The file starts empty: it is a file the user asked to exist, not one with anything in it,
/// and an editor that invented content would be writing text nobody typed.
#[tauri::command]
pub fn create_file(parent: String, name: String) -> Result<FsEntry, String> {
  let typed = check_name(&name).map_err(name_error)?;
  let named = entry_name(&typed);
  // The extension is part of the segment, so the finished name has to face the limit again.
  if check_name(&named).is_err() {
    return Err("create_name_too_long".into());
  }
  let path = target_of(&parent, &named)?;
  if path.exists() {
    return Err("create_exists".into());
  }
  // `create_new` rather than a plain write: it refuses a name that was taken between the
  // check above and here, so the one file that must never be destroyed by a "create" is
  // never truncated by one.
  std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&path)
    .map_err(|e| format!("create_failed:{e}"))?;
  let path = draft::normalize_path(&path.to_string_lossy());
  Ok(FsEntry {
    name: named,
    path,
    is_dir: false,
  })
}

/// Create a folder inside `parent`.
#[tauri::command]
pub fn create_dir(parent: String, name: String) -> Result<FsEntry, String> {
  let named = check_name(&name).map_err(name_error)?;
  let path = target_of(&parent, &named)?;
  if path.exists() {
    return Err("create_exists".into());
  }
  std::fs::create_dir(&path).map_err(|e| format!("create_failed:{e}"))?;
  let path = draft::normalize_path(&path.to_string_lossy());
  Ok(FsEntry {
    // The trailing separator is how a listing says "this is a folder", and the tree reads
    // the name rather than the flag when it draws one.
    name: format!("{named}/"),
    path,
    is_dir: true,
  })
}

/// Delete a file, or a folder and everything in it.
///
/// Nothing is moved and nothing is copied, so this cannot be taken back from inside the app
/// and does not reach the Recycle Bin. That is the whole reason the frontend asks first.
#[tauri::command]
pub fn remove_entry(app: AppHandle, path: String) -> Result<(), String> {
  let target = draft::normalize_path(&path);
  if target.is_empty() {
    return Err("path_empty".into());
  }
  let entry = Path::new(&target);
  // Read as the entry itself: a link is what it is, not what it points at.
  let link = std::fs::symlink_metadata(entry).map_err(|e| format!("remove_not_found:{e}"))?;
  let follows = std::fs::metadata(entry).map_err(|e| format!("remove_not_found:{e}"))?;
  // The same line the asset scope and the rename draw: a drive root, the system directory
  // or the user's profile is not this app's to delete.
  if refused_by_scope(entry, &protected_roots()) {
    return Err("remove_refused".into());
  }
  if link.file_type().is_symlink() {
    // Removed as the link it is, never followed. On Windows a link to a folder has to go
    // through RemoveDirectory, which is what makes the two branches necessary.
    if follows.is_dir() {
      std::fs::remove_dir(entry).map_err(|e| format!("remove_failed:{e}"))?;
    } else {
      std::fs::remove_file(entry).map_err(|e| format!("remove_failed:{e}"))?;
    }
  } else if follows.is_dir() {
    std::fs::remove_dir_all(entry).map_err(|e| format!("remove_failed:{e}"))?;
  } else {
    std::fs::remove_file(entry).map_err(|e| format!("remove_failed:{e}"))?;
  }
  // The entry is gone by now and cannot be brought back, so a state file that refuses to be
  // written is not a failed delete: it would be reported as one, and the caller would keep a
  // row on screen for a file that is not there. What a stale record costs is a tab that is
  // skipped on the next start, which is the same thing that happens to a file deleted on the
  // command line while the app was closed.
  let _ = drop_state(&app, &target);
  Ok(())
}

/// Let go of what the store kept only because the entry was there.
///
/// The drafts and the per-file overrides stay: they hold unsaved work, and a path that
/// nothing points at any more is not a corrupt record — it is one this app simply does not
/// offer. Everything that would try to *open* the entry is dropped instead, because that
/// fails, and a session that restores a list of failures is worse than one that restores a
/// shorter list.
fn drop_state(app: &AppHandle, gone: &str) -> Result<(), String> {
  drop_group_tabs(app, gone)?;
  drop_history(app, gone)?;
  lift_sidebar_root(app, gone)
}

/// The tabs a group keeps once `gone` is deleted, and the selection it is left pointing at.
/// Returns whether anything had to change, so an untouched store is not rewritten.
fn drop_tabs(tabs: &mut Vec<GroupTab>, active: &mut String, gone: &str) -> bool {
  let before = tabs.len();
  tabs.retain(|tab| tab.path.is_empty() || !under(&tab.path, gone));
  let selection_went = under(active, gone);
  if tabs.len() != before || selection_went {
    // A group whose selected tab was deleted has to land on something, or it opens with
    // nothing selected and the window looks empty.
    *active = tabs.last().map(|t| t.key()).unwrap_or_default();
    return true;
  }
  false
}

fn drop_group_tabs(app: &AppHandle, gone: &str) -> Result<(), String> {
  let Some(mut store) = commands::read_json::<GroupStore>(app, commands::GROUPS_FILE)? else {
    return Ok(());
  };
  let mut changed = false;
  for item in &mut store.items {
    let mut active = item.active.clone();
    if drop_tabs(&mut item.tabs, &mut active, gone) {
      item.active = active;
      changed = true;
    }
  }
  if changed {
    commands::write_json(app, commands::GROUPS_FILE, &store)?;
  }
  Ok(())
}

fn drop_history(app: &AppHandle, gone: &str) -> Result<(), String> {
  let Some(mut history) = commands::read_json::<Vec<HistoryEntry>>(app, "history.json")? else {
    return Ok(());
  };
  let before = history.len();
  history.retain(|item| !under(&draft::normalize_path(&item.path), gone));
  if history.len() != before {
    commands::write_json(app, "history.json", &history)?;
  }
  Ok(())
}

/// Keep the Explorer pointing at a folder that exists.
///
/// The parent is the one place that is certain to be there: whatever the tree was showing has
/// just been deleted out from under it, and a root pointing at nothing is a dead sidebar.
fn lift_sidebar_root(app: &AppHandle, gone: &str) -> Result<(), String> {
  let Some(settings) = commands::read_json::<Settings>(app, "settings.json")? else {
    return Ok(());
  };
  let root = draft::normalize_path(&settings.sidebar_root);
  if root.is_empty() || !under(&root, gone) {
    return Ok(());
  }
  let lifted = Path::new(gone)
    .parent()
    .map(|p| draft::normalize_path(&p.to_string_lossy()))
    .unwrap_or_default();
  let settings = settings.filled();
  commands::write_json(
    app,
    "settings.json",
    &Settings {
      sidebar_root: lifted,
      ..settings
    },
  )
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scratch(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("wrolp-entry-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    draft::normalize_path(&dir.to_string_lossy())
  }

  fn tab(path: &str) -> GroupTab {
    GroupTab {
      path: path.to_string(),
      ..Default::default()
    }
  }

  #[test]
  fn a_bare_word_gets_a_text_extension_and_a_named_one_is_left_alone() {
    assert_eq!(entry_name("notes"), "notes.txt");
    assert_eq!(entry_name("notes.md"), "notes.md");
    assert_eq!(entry_name("archive.tar.gz"), "archive.tar.gz");
    // A dotfile is a whole name, not a stem missing its extension.
    assert_eq!(entry_name(".gitignore"), ".gitignore");
    assert_eq!(entry_name("v1.2"), "v1.2");
  }

  #[test]
  fn the_extension_counts_towards_the_name_limit() {
    let edge = "n".repeat(crate::rename::MAX_NAME_LEN);
    // Room for the extension is what makes this createable, one character more is not.
    assert!(check_name(&entry_name(&edge[..edge.len() - 4])).is_ok());
    assert!(check_name(&entry_name(&edge)).is_err());
  }

  #[test]
  fn a_created_file_is_empty_and_takes_its_name_as_given() {
    let dir = scratch("file");
    let made = create_file(dir.clone(), "notes".into()).expect("created");
    assert_eq!(made.name, "notes.txt");
    assert!(!made.is_dir);
    assert_eq!(
      std::fs::read_to_string(&made.path).expect("read"),
      "",
      "a new file starts empty rather than holding the editor's idea of a template"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_name_already_taken_is_refused_rather_than_overwritten() {
    let dir = scratch("exists");
    create_file(dir.clone(), "notes.md".into()).expect("first");
    // Even the name typed as it would be typed again, and even with the case spelled
    // differently: on Windows that is the same file.
    assert!(create_file(dir.clone(), "notes.md".into()).is_err());
    assert!(create_file(dir.clone(), "NOTES.MD".into()).is_err());
    assert!(create_dir(dir.clone(), "notes.md".into()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn nothing_is_created_inside_a_folder_that_is_not_there() {
    let dir = scratch("gone");
    let missing = format!("{dir}\\missing");
    assert!(create_file(missing.clone(), "notes".into()).is_err());
    assert!(create_dir(missing, "sub".into()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_name_that_could_reach_outside_its_folder_is_refused() {
    let dir = scratch("escape");
    for name in ["..", "../elsewhere", r"sub\file.txt", "a:b", ""] {
      assert!(
        create_file(dir.clone(), name.into()).is_err(),
        "{name} should be refused"
      );
    }
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A deleted folder takes its whole subtree with it, while a sibling sharing its prefix
  /// and any scratch tab stay exactly where they are.
  #[test]
  fn a_deleted_folder_takes_its_tabs_and_leaves_the_rest_alone() {
    let mut tabs = vec![
      tab(r"c:\notes\gone\a.txt"),
      tab(r"c:\notes\gone"),
      tab(r"c:\notes\goneful\b.txt"),
      tab(r"c:\notes\kept\c.txt"),
      GroupTab {
        untitled: "Untitled-1".into(),
        content: "scratch".into(),
        ..Default::default()
      },
    ];
    let mut active = r"c:\notes\gone\a.txt".into();
    assert!(drop_tabs(&mut tabs, &mut active, r"c:\notes\gone"));
    let paths: Vec<String> = tabs.iter().map(|t| t.path.clone()).collect();
    assert_eq!(
      paths,
      vec![r"c:\notes\goneful\b.txt", r"c:\notes\kept\c.txt", ""]
    );
    // The selection went with the tab it named, so it lands on what is left — the same
    // fallback a tab that was moved to another group gets.
    assert_eq!(active, "untitled://Untitled-1");
  }

  #[test]
  fn deleting_something_that_was_not_open_changes_nothing() {
    let mut tabs = vec![tab(r"c:\notes\a.txt")];
    let mut active = r"c:\notes\a.txt".into();
    assert!(!drop_tabs(&mut tabs, &mut active, r"c:\notes\other"));
    assert_eq!(active, r"c:\notes\a.txt");
  }

  #[test]
  fn the_last_tab_going_leaves_the_group_with_no_selection() {
    let mut tabs = vec![tab(r"c:\notes\a.txt")];
    let mut active = r"c:\notes\a.txt".into();
    assert!(drop_tabs(&mut tabs, &mut active, r"c:\notes\a.txt"));
    assert!(tabs.is_empty());
    assert_eq!(active, "");
  }
}
