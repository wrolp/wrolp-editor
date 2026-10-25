//! Renaming a file or a folder, and re-homing everything the app keys by its path.
//!
//! A path is the identity of a document across the whole store: drafts are named by the
//! SHA-256 of it, the per-file overrides are keyed by it, and so are the recent-files list,
//! the tabs of every group and the folder the Explorer is showing. Renaming only the
//! filesystem would leave all of those pointing at a file that no longer exists, so the
//! command moves the entry and then moves the state that follows it.

use crate::commands::{self, protected_roots, refused_by_scope, HistoryEntry};
use crate::draft;
use crate::file_settings;
use crate::group::GroupStore;
use crate::unlock::{self, UnlockStore};
use crate::versioning;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use zeroize::Zeroize;

/// What moved. Both sides are normalized, because that is how every store keys them.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Renamed {
  pub old_path: String,
  pub path: String,
}

/// Longest single name segment Windows will take.
pub(crate) const MAX_NAME_LEN: usize = 255;

/// Names Windows reserves at the top of a segment, extension or not.
const RESERVED: [&str; 22] = [
  "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
  "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];

fn is_sep(byte: u8) -> bool {
  byte == b'\\' || byte == b'/'
}

/// True when `path` is `root` itself or sits inside it. Both are normalized.
pub(crate) fn under(path: &str, root: &str) -> bool {
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

/// Why what the user typed is not usable as the name of one path segment.
///
/// Said apart from the error code on purpose: the rules belong to every command that has to
/// turn typed text into a name, and each of those reports a refusal in its own words.
pub enum NameError {
  Empty,
  Invalid,
}

/// Turn what the user typed into one path segment, or say why it is not one.
///
/// Only a bare name is accepted: a separator would move the entry out of the folder it was
/// renamed from, and a leading dot would let it land somewhere the user is not looking at.
pub fn check_name(raw: &str) -> Result<String, NameError> {
  let name = raw.trim().trim_matches('"').trim();
  if name.is_empty() {
    return Err(NameError::Empty);
  }
  if name.chars().count() > MAX_NAME_LEN {
    return Err(NameError::Invalid);
  }
  if name.contains(|c: char| {
    matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c as u32 <= 31
  }) {
    return Err(NameError::Invalid);
  }
  // Windows drops a trailing dot when it creates the entry, so the name typed is not the
  // name got. A trailing space is already gone: the trim above takes it, which is what
  // Windows would have done anyway.
  if name.ends_with('.') {
    return Err(NameError::Invalid);
  }
  // Nothing above separates segments, so these two are the only way a name can be a
  // pointer rather than an entry — and a dotfile is still a name worth allowing.
  if name == "." || name == ".." {
    return Err(NameError::Invalid);
  }
  let stem = name.split('.').next().unwrap_or(name).to_ascii_lowercase();
  if RESERVED.contains(&stem.as_str()) {
    return Err(NameError::Invalid);
  }
  Ok(name.to_string())
}

/// `check_name` reported the way the rename says it, which is what the existing UI text
/// covers. Other commands map the same two failures onto their own codes.
pub fn validate_name(raw: &str) -> Result<String, String> {
  check_name(raw).map_err(|e| match e {
    NameError::Empty => "rename_name_empty".to_string(),
    NameError::Invalid => "rename_name_invalid".to_string(),
  })
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

/// One rename asked for as part of a batch: the entry at `path` takes the bare name `name`.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameRequest {
  pub path: String,
  pub name: String,
}

/// One entry a batch will move, plus the name it waits under when its target is still
/// occupied by another entry of the same batch.
struct Planned {
  old: String,
  new: String,
  /// True when another planned entry is moving out of `new`, so that name is only free once
  /// that entry has moved. Such an entry steps aside first and lands in the second pass.
  waits: bool,
  /// The temporary name it steps aside to, filled in while the batch runs.
  bridge: String,
}

/// Rename several entries, and re-home the state that follows each of them.
///
/// A batch is what makes one name depend on the whole list: numbering that shifts every file
/// by one has targets still occupied by entries waiting their turn. The disk work therefore
/// runs in two passes — the entries whose target is occupied step aside to a temporary name,
/// then everything lands — and a failure in either pass puts back what had already moved.
///
/// Everything is checked before anything moves, so a refused batch leaves the disk alone.
#[tauri::command]
pub fn rename_entries(app: AppHandle, items: Vec<RenameRequest>) -> Result<Vec<Renamed>, String> {
  let mut planned = plan_batch(&items)?;
  apply_batch(&mut planned)?;
  rekey_batch(&app, &planned)?;
  Ok(
    planned
      .into_iter()
      .map(|item| Renamed {
        old_path: item.old,
        path: item.new,
      })
      .collect(),
  )
}

/// Read a batch against the disk: every name usable, every source there, no two entries
/// landing on one name, and nothing the rename would have to overwrite.
fn plan_batch(items: &[RenameRequest]) -> Result<Vec<Planned>, String> {
  if items.is_empty() {
    return Err("rename_batch_empty".into());
  }
  let mut planned = Vec::with_capacity(items.len());
  let mut sources = HashSet::with_capacity(items.len());
  for item in items {
    let clean = validate_name(&item.name)?;
    let old = draft::normalize_path(&item.path);
    if old.is_empty() {
      return Err("path_empty".into());
    }
    // The same entry twice: the second rename would look for a file the first one moved.
    if !sources.insert(old.clone()) {
      return Err("rename_batch_duplicate".into());
    }
    let source = Path::new(&old);
    source
      .metadata()
      .map_err(|e| format!("rename_not_found:{e}"))?;
    if refused_by_scope(source, &protected_roots()) {
      return Err("rename_refused".into());
    }
    let parent = source.parent().ok_or("rename_no_parent")?;
    let new = draft::normalize_path(&parent.join(&clean).to_string_lossy());
    if new.is_empty() {
      return Err("path_unresolvable".into());
    }
    planned.push(Planned {
      old,
      new,
      waits: false,
      bridge: String::new(),
    });
  }
  // A folder carries its subtree, so renaming it together with something inside it would move
  // one entry twice, and the inner path is gone by the time it is its turn.
  for outer in &planned {
    for inner in &planned {
      if inner.old != outer.old && under(&inner.old, &outer.old) {
        return Err("rename_batch_nested".into());
      }
    }
  }
  // Two entries may not land on one name, whether they are in one folder or rely on the same
  // name in different ones only by accident.
  let mut targets = HashSet::new();
  for item in planned.iter().filter(|item| item.new != item.old) {
    if !targets.insert(item.new.clone()) {
      return Err("rename_batch_duplicate".into());
    }
  }
  // An occupied target is only fine when the entry occupying it is one of this batch's own
  // sources; anything else would be overwritten rather than moved.
  let vacated: HashSet<String> = planned
    .iter()
    .filter(|item| item.new != item.old)
    .map(|item| item.old.clone())
    .collect();
  for item in planned.iter_mut().filter(|item| item.new != item.old) {
    if vacated.contains(&item.new) {
      item.waits = true;
    } else if Path::new(&item.new).exists() {
      return Err("rename_exists".into());
    }
  }
  Ok(planned)
}

/// Do the moves `plan_batch` approved, and nothing else.
fn apply_batch(planned: &mut [Planned]) -> Result<(), String> {
  let mut bridged = Vec::new();
  for index in 0..planned.len() {
    if !planned[index].waits {
      continue;
    }
    let parent = Path::new(&planned[index].old)
      .parent()
      .ok_or("rename_no_parent")?;
    let bridge = free_bridge(parent);
    if let Err(e) = std::fs::rename(&planned[index].old, &bridge) {
      undo_batch(planned, &[], &bridged);
      return Err(format!("rename_failed:{e}"));
    }
    planned[index].bridge = bridge.to_string_lossy().to_string();
    bridged.push(index);
  }
  // The entries whose name was already free go first, so a waiting entry's target has been
  // vacated by the time it lands.
  let mut landed: Vec<usize> = Vec::new();
  for index in 0..planned.len() {
    if planned[index].waits || planned[index].new == planned[index].old {
      continue;
    }
    if let Err(e) = std::fs::rename(&planned[index].old, &planned[index].new) {
      undo_batch(planned, &landed, &bridged);
      return Err(format!("rename_failed:{e}"));
    }
    landed.push(index);
  }
  for &index in &bridged {
    if let Err(e) = std::fs::rename(&planned[index].bridge, &planned[index].new) {
      undo_batch(planned, &landed, &bridged);
      return Err(format!("rename_failed:{e}"));
    }
    landed.push(index);
  }
  Ok(())
}

/// Put back what a failed batch had already moved, best effort.
///
/// Each index appears at exactly one of the two names it could have reached, so the undo asks
/// for the final name first and the bridge second; an entry still waiting under its bridge is
/// the one the second rename finds. A rollback that itself fails is not reported — the error
/// that stopped the batch is the one worth saying, and a second one would only bury it.
fn undo_batch(planned: &[Planned], landed: &[usize], bridged: &[usize]) {
  for &index in landed.iter().rev() {
    let _ = std::fs::rename(&planned[index].new, &planned[index].old);
  }
  for &index in bridged.iter().rev() {
    let _ = std::fs::rename(&planned[index].bridge, &planned[index].old);
  }
}

/// A name no entry is using, in the folder the entry came from.
///
/// Short on purpose: the entry's own name may already sit at the length Windows allows, and a
/// temporary name derived from it would be one character too long to move to.
fn free_bridge(parent: &Path) -> PathBuf {
  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|since| since.as_nanos())
    .unwrap_or(0);
  for attempt in 0..1000u32 {
    let candidate = parent.join(format!(".wrolp-rename-{stamp:x}-{attempt}"));
    if !candidate.exists() {
      return candidate;
    }
  }
  parent.join(format!(".wrolp-rename-{stamp:x}"))
}

/// Move every stored path that pointed at an old name to the new one.
///
/// Two passes when anything had to wait: the state has to leave the old names before any of it
/// is stored under a new one, or a swap would have the first side overwrite the second's
/// records while they are still under their original paths.
fn rekey_batch(app: &AppHandle, planned: &[Planned]) -> Result<(), String> {
  let waits: Vec<&Planned> = planned
    .iter()
    .filter(|item| item.new != item.old && !item.bridge.is_empty())
    .collect();
  for item in &waits {
    rekey_state(app, &item.old, &item.bridge)?;
  }
  for item in &waits {
    rekey_state(app, &item.bridge, &item.new)?;
  }
  for item in planned
    .iter()
    .filter(|item| item.new != item.old && item.bridge.is_empty())
  {
    rekey_state(app, &item.old, &item.new)?;
  }
  Ok(())
}

/// Move every stored path that pointed at `old` or inside it.
fn rekey_state(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  draft::rekey_prefix(app, old, new)?;
  file_settings::rekey_prefix(app, old, new)?;
  // Each version history stands for one path, recorded in the repository's own metadata, so a
  // rename walks the store instead of reading a single commit.
  versioning::rekey_prefix(&versioning::base_dir(app)?, old, new)?;
  // The groups store carries both the tab paths and each group's Explorer folder.
  rekey_groups(app, old, new)?;
  rekey_history(app, old, new)?;
  rekey_unlock(app, old, new);
  Ok(())
}

/// What a rename does to the two halves of the unlock state.
///
/// The session key moves with the file. It was derived from the document's own header, which
/// a rename does not touch, so it is as valid under the new name as under the old — and
/// locking a document because of a rename would be a surprise that has nothing to do with
/// encryption, arriving in the middle of somebody editing it.
///
/// A remembered password does not move. Both halves are keyed by a digest of the path, and a
/// digest cannot be walked back to the path it came from, so after a *folder* rename there is
/// no way to tell which entries moved and which did not. Forgetting the two paths this rename
/// names is the honest half of that: for a single file it clears the entry that would
/// otherwise linger, and entries under a renamed folder stay unreachable until "clear all
/// remembered" is used. What the user sees is being asked for the password again, which is
/// the recoverable direction.
fn rekey_unlock(app: &AppHandle, old: &str, new: &str) {
  let unlock = app.state::<UnlockStore>();
  let idle = unlock::idle_limit(app);
  if let Some(mut key) = unlock.get(old, idle) {
    unlock.remove(old);
    unlock.put(new, key, idle);
    key.zeroize();
  }
  let _ = unlock.forget(old);
  let _ = unlock.forget(new);
}

fn rekey_groups(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let Some(mut store) = commands::read_json::<GroupStore>(app, commands::GROUPS_FILE)? else {
    return Ok(());
  };
  store.rekey_prefix(old, new);
  commands::write_json(app, commands::GROUPS_FILE, &store)
}

fn rekey_history(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let Some(mut history) = commands::read_json::<Vec<HistoryEntry>>(app, "history.json")? else {
    return Ok(());
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

  /// A fresh folder per test, named after it so two tests cannot share one.
  fn sandbox(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("wrolp-rename-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn ask(dir: &Path, from: &str, to: &str) -> RenameRequest {
    RenameRequest {
      path: dir.join(from).to_string_lossy().to_string(),
      name: to.to_string(),
    }
  }

  #[test]
  fn a_batch_moves_every_entry_and_lands_the_new_names() {
    let dir = sandbox("plain");
    std::fs::write(dir.join("a.txt"), "a").unwrap();
    std::fs::write(dir.join("b.txt"), "b").unwrap();
    let items = [ask(&dir, "a.txt", "one.txt"), ask(&dir, "b.txt", "two.txt")];
    let mut planned = plan_batch(&items).unwrap();
    apply_batch(&mut planned).unwrap();
    assert!(dir.join("one.txt").exists() && dir.join("two.txt").exists());
    assert!(!dir.join("a.txt").exists() && !dir.join("b.txt").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Each target is occupied for the whole of the batch, which is what the two passes are for.
  #[test]
  fn a_swap_goes_through_a_temporary_name() {
    let dir = sandbox("swap");
    std::fs::write(dir.join("a.txt"), "A").unwrap();
    std::fs::write(dir.join("b.txt"), "B").unwrap();
    let items = [ask(&dir, "a.txt", "b.txt"), ask(&dir, "b.txt", "a.txt")];
    let mut planned = plan_batch(&items).unwrap();
    assert!(planned.iter().all(|item| item.waits));
    apply_batch(&mut planned).unwrap();
    assert_eq!(std::fs::read_to_string(dir.join("b.txt")).unwrap(), "A");
    assert_eq!(std::fs::read_to_string(dir.join("a.txt")).unwrap(), "B");
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A target occupied by an entry the batch is not moving would be overwritten, so the whole
  /// batch is refused before anything on disk changes.
  #[test]
  fn a_target_another_entry_is_not_leaving_is_refused_before_anything_moves() {
    let dir = sandbox("taken");
    std::fs::write(dir.join("a.txt"), "a").unwrap();
    std::fs::write(dir.join("taken.txt"), "t").unwrap();
    let items = [ask(&dir, "a.txt", "taken.txt")];
    assert!(matches!(plan_batch(&items), Err(code) if code == "rename_exists"));
    assert!(dir.join("a.txt").exists() && dir.join("taken.txt").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn two_entries_may_not_land_on_one_name() {
    let dir = sandbox("same-target");
    std::fs::write(dir.join("a.txt"), "a").unwrap();
    std::fs::write(dir.join("b.txt"), "b").unwrap();
    let items = [ask(&dir, "a.txt", "same.txt"), ask(&dir, "b.txt", "same.txt")];
    assert!(matches!(plan_batch(&items), Err(code) if code == "rename_batch_duplicate"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn one_entry_named_twice_is_refused() {
    let dir = sandbox("twice");
    std::fs::write(dir.join("a.txt"), "a").unwrap();
    let items = [ask(&dir, "a.txt", "one.txt"), ask(&dir, "a.txt", "two.txt")];
    assert!(matches!(plan_batch(&items), Err(code) if code == "rename_batch_duplicate"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// A folder carries its subtree, so the inner path would be gone when its turn came.
  #[test]
  fn a_folder_and_its_child_cannot_move_in_one_batch() {
    let dir = sandbox("nested");
    std::fs::create_dir_all(dir.join("sub")).unwrap();
    std::fs::write(dir.join("sub").join("x.txt"), "x").unwrap();
    let items = [
      ask(&dir, "sub", "renamed"),
      ask(&dir, "sub/x.txt", "y.txt"),
    ];
    assert!(matches!(plan_batch(&items), Err(code) if code == "rename_batch_nested"));
    let _ = std::fs::remove_dir_all(&dir);
  }

  /// Windows folds case, so a batch that only changes the spelling asks for nothing.
  #[test]
  fn a_name_that_only_changes_case_moves_nothing() {
    let dir = sandbox("case");
    std::fs::write(dir.join("a.txt"), "a").unwrap();
    let items = [ask(&dir, "a.txt", "A.txt")];
    let mut planned = plan_batch(&items).unwrap();
    assert_eq!(planned[0].old, planned[0].new);
    apply_batch(&mut planned).unwrap();
    assert!(dir.join("a.txt").exists());
    let _ = std::fs::remove_dir_all(&dir);
  }
}
