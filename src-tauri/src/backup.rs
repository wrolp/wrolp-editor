//! Configuration backups: timestamped snapshots of the app's state files.
//!
//! The files are bundled into one JSON document rather than copied one by one, because a
//! group and the folder menu that belongs to it are tied together by the same group id.
//! Restoring one without the other would leave a menu pointing at a group that is not there.

use crate::commands::{read_json, write_atomic, Settings};
use crate::draft;
use chrono::{DateTime, Local, SecondsFormat};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// How many snapshots a fresh install keeps. Enough to step back through a few weeks of daily
/// automatic ones, without turning a configuration folder into an archive.
pub(crate) const DEFAULT_RETAIN: u32 = 20;
pub(crate) const MAX_RETAIN: u32 = 100;

const BUNDLE_VERSION: u32 = 1;
const FILE_PREFIX: &str = "wrolp-backup-";
const FILE_SUFFIX: &str = ".json";
/// The state files a snapshot carries.
///
/// Drafts and the version store are deliberately absent: they are user data rather than
/// configuration, and copying them would let a snapshot grow to the size of the work it was
/// meant to protect. The order is also the restore order, which means settings land first.
const STATE_FILES: [&str; 5] = [
  "settings.json",
  "groups.json",
  "file-settings.json",
  "history.json",
  "folder-history.json",
];

/// What one snapshot holds, in the shape it is written to disk.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Bundle {
  version: u32,
  created_at: String,
  #[serde(default)]
  app_version: String,
  #[serde(default)]
  kind: String,
  /// File name to its exact text. Keeping text rather than parsed values lets a restore put
  /// back a file this build would refuse to parse, which is often the thing worth recovering.
  files: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
  pub path: String,
  pub file: String,
  pub created_at: String,
  /// `auto`, `manual` or `pre-restore`.
  pub kind: String,
  pub bytes: u64,
  /// How many groups the snapshot held, for the one-line summary in the list.
  pub groups: usize,
  pub tabs: usize,
  /// How many state files went into the bundle.
  pub files: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupList {
  /// The folder actually in use, after applying the default for an empty setting.
  pub dir: String,
  pub dir_exists: bool,
  /// Newest first.
  pub backups: Vec<BackupInfo>,
}

/// The folder snapshots go to: the setting when it has one, `wrolp/backups` otherwise.
///
/// The default is a sibling of the state folder, one place over from `groups.json` — close
/// enough to find while looking at the configuration, separate enough that the live files and
/// their history never share a directory.
fn backup_dir(app: &AppHandle, settings: &Settings) -> Result<PathBuf, String> {
  let custom = settings.backup_dir.trim();
  if custom.is_empty() {
    return draft::backups_dir(app);
  }
  let path = PathBuf::from(custom);
  if !path.is_absolute() {
    return Err("backup_dir:a relative path cannot be used".into());
  }
  std::fs::create_dir_all(&path).map_err(|e| format!("backup_dir:{e}"))?;
  Ok(path)
}

/// Settings read for a backup operation.
///
/// A settings file that cannot be parsed must not block taking a snapshot — a broken state is
/// exactly when one is worth having — so this falls back to the defaults and lets the bundle
/// carry the bad file as it is.
fn current_settings(app: &AppHandle) -> Settings {
  read_json::<Settings>(app, "settings.json")
    .ok()
    .flatten()
    .unwrap_or_default()
    .filled()
}

/// The state files that exist right now, as text.
///
/// A file that is not UTF-8 is left out rather than restored with replacement characters
/// later: every one of these files is JSON this app wrote.
fn read_state(dir: &Path) -> BTreeMap<String, String> {
  let mut files = BTreeMap::new();
  for name in STATE_FILES {
    let Ok(bytes) = std::fs::read(dir.join(name)) else {
      continue;
    };
    if let Ok(text) = String::from_utf8(bytes) {
      files.insert(name.to_string(), text);
    }
  }
  files
}

fn state_has_files(dir: &Path) -> bool {
  STATE_FILES.iter().any(|name| dir.join(name).is_file())
}

/// Snapshots in `dir`, newest first. Only files this module named are considered.
fn backup_files(dir: &Path) -> Vec<(String, PathBuf)> {
  let Ok(entries) = std::fs::read_dir(dir) else {
    return Vec::new();
  };
  let mut files: Vec<(String, PathBuf)> = entries
    .flatten()
    .filter_map(|entry| {
      let name = entry.file_name().to_string_lossy().into_owned();
      if !name.starts_with(FILE_PREFIX) || !name.ends_with(FILE_SUFFIX) {
        return None;
      }
      let path = entry.path();
      path.is_file().then_some((name, path))
    })
    .collect();
  // The timestamp leads the name, so sorting the name is sorting the time.
  files.sort_by(|a, b| b.0.cmp(&a.0));
  files
}

fn read_bundle(path: &Path) -> Result<Bundle, String> {
  let text = std::fs::read_to_string(path).map_err(|_| "backup_path".to_string())?;
  let bundle: Bundle = serde_json::from_str(&text).map_err(|e| format!("backup_parse:{e}"))?;
  if bundle.version > BUNDLE_VERSION {
    return Err(format!("backup_parse:version {}", bundle.version));
  }
  Ok(bundle)
}

/// Group and tab counts read from the snapshot itself, so the list describes what restoring
/// it would bring back rather than what is on disk now.
fn counts(bundle: &Bundle) -> (usize, usize) {
  let Some(text) = bundle.files.get("groups.json") else {
    return (0, 0);
  };
  let Ok(value) = serde_json::from_str::<serde_json::Value>(text) else {
    return (0, 0);
  };
  let Some(items) = value.get("items").and_then(|v| v.as_array()) else {
    return (0, 0);
  };
  let tabs = items
    .iter()
    .map(|group| {
      group
        .get("tabs")
        .and_then(|v| v.as_array())
        .map_or(0, Vec::len)
    })
    .sum();
  (items.len(), tabs)
}

fn info_of(path: &Path, file: &str, bundle: &Bundle, bytes: u64) -> BackupInfo {
  let (groups, tabs) = counts(bundle);
  BackupInfo {
    path: path.to_string_lossy().into_owned(),
    file: file.to_string(),
    created_at: bundle.created_at.clone(),
    kind: bundle.kind.clone(),
    bytes,
    groups,
    tabs,
    files: bundle.files.len(),
  }
}

fn info_from_file(path: &Path, file: &str) -> Option<BackupInfo> {
  let bytes = std::fs::metadata(path).ok()?.len();
  let bundle = read_bundle(path).ok()?;
  Some(info_of(path, file, &bundle, bytes))
}

fn list_in(dir: &Path) -> Vec<BackupInfo> {
  backup_files(dir)
    .into_iter()
    .filter_map(|(file, path)| info_from_file(&path, &file))
    .collect()
}

/// Delete the oldest snapshots beyond `retain`.
///
/// Best effort: a file that cannot be removed is left for the next backup rather than failing
/// the one that was just written.
fn prune_to(dir: &Path, retain: usize) {
  for (_, path) in backup_files(dir).into_iter().skip(retain.max(1)) {
    let _ = std::fs::remove_file(path);
  }
}

fn is_today(created_at: &str) -> bool {
  DateTime::parse_from_rfc3339(created_at)
    .map(|ts| ts.with_timezone(&Local).date_naive() == Local::now().date_naive())
    .unwrap_or(false)
}

fn auto_exists_today(dir: &Path) -> bool {
  list_in(dir)
    .iter()
    .any(|info| info.kind == "auto" && is_today(&info.created_at))
}

/// Drop every automatic snapshot from today except `keep`.
///
/// The day gets one automatic record that follows the configuration, not one per open and
/// close. A manual snapshot taken today, or an automatic one from another day, is left alone.
fn keep_only_auto(dir: &Path, keep: &Path) {
  for info in list_in(dir) {
    if info.kind == "auto" && Path::new(&info.path) != keep && is_today(&info.created_at) {
      let _ = std::fs::remove_file(&info.path);
    }
  }
}

fn write_bundle(
  dir: &Path,
  kind: &str,
  files: BTreeMap<String, String>,
  app_version: &str,
) -> Result<BackupInfo, String> {
  if files.is_empty() {
    return Err("backup_nothing".into());
  }
  let now = Local::now();
  let stamp = format!(
    "{}-{:03}",
    now.format("%Y%m%d-%H%M%S"),
    now.timestamp_subsec_millis()
  );
  // Two backups in the same millisecond are unlikely but not impossible — the manual button
  // and the automatic check can land together — and a suffix is cheaper than losing one.
  let mut nth = 0;
  let (path, file) = loop {
    let tail = if nth == 0 {
      String::new()
    } else {
      format!("-{nth}")
    };
    let file = format!("{FILE_PREFIX}{stamp}-{kind}{tail}{FILE_SUFFIX}");
    let path = dir.join(&file);
    if !path.exists() {
      break (path, file);
    }
    nth += 1;
  };
  let bundle = Bundle {
    version: BUNDLE_VERSION,
    created_at: now.to_rfc3339_opts(SecondsFormat::Secs, false),
    app_version: app_version.to_string(),
    kind: kind.to_string(),
    files,
  };
  let bytes = serde_json::to_vec_pretty(&bundle).map_err(|e| format!("backup_write:{e}"))?;
  write_atomic(&path, &bytes).map_err(|e| format!("backup_write:{e}"))?;
  Ok(info_of(&path, &file, &bundle, bytes.len() as u64))
}

fn create_with(app: &AppHandle, settings: &Settings, kind: &str) -> Result<BackupInfo, String> {
  let dir = backup_dir(app, settings)?;
  let files = read_state(&draft::store_dir(app)?);
  let version = app.package_info().version.to_string();
  let info = write_bundle(&dir, kind, files, &version)?;
  prune_to(&dir, settings.backup_retain as usize);
  Ok(info)
}

/// Validate a path as a snapshot in `dir` and read it.
///
/// The frontend hands back a path the list gave it, and a string from the webview is not a
/// reason to read or write wherever it points.
fn load_backup(dir: &Path, target: &Path) -> Result<Bundle, String> {
  let dir = std::fs::canonicalize(dir).map_err(|e| format!("backup_dir:{e}"))?;
  let target = std::fs::canonicalize(target).map_err(|_| "backup_path".to_string())?;
  let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("");
  if target.parent() != Some(dir.as_path())
    || !name.starts_with(FILE_PREFIX)
    || !name.ends_with(FILE_SUFFIX)
  {
    return Err("backup_path".into());
  }
  read_bundle(&target)
}

fn apply_bundle(state: &Path, bundle: &Bundle) -> Result<usize, String> {
  let mut written = 0;
  for name in STATE_FILES {
    let Some(text) = bundle.files.get(name) else {
      continue;
    };
    write_atomic(&state.join(name), text.as_bytes()).map_err(|e| format!("backup_write:{e}"))?;
    written += 1;
  }
  Ok(written)
}

/// The two steps the command keeps separate — parse, keep a safety copy, apply — joined for
/// the tests that only care about the round trip.
#[cfg(test)]
fn restore_from(state: &Path, dir: &Path, target: &Path) -> Result<usize, String> {
  let bundle = load_backup(dir, target)?;
  apply_bundle(state, &bundle)
}

#[tauri::command]
pub fn create_config_backup(app: AppHandle) -> Result<BackupInfo, String> {
  let settings = current_settings(&app);
  create_with(&app, &settings, "manual")
}

/// Open the backup folder in the system file manager.
///
/// The webview's `openPath` is scoped to the three folders Settings → About names for itself,
/// and this is not one of them — nor can it be: a folder the user picked can be anywhere, while
/// the capability is compiled in. The path is resolved here from the app's own setting, so
/// handing it to the shell needs no permission from the webview.
#[tauri::command]
pub fn open_backup_folder(app: AppHandle) -> Result<(), String> {
  let settings = current_settings(&app);
  let dir = backup_dir(&app, &settings)?;
  tauri_plugin_opener::open_path(&dir, None::<&str>).map_err(|e| format!("backup_open:{e}"))
}

#[tauri::command]
pub fn list_config_backups(app: AppHandle) -> Result<BackupList, String> {
  let settings = current_settings(&app);
  let dir = backup_dir(&app, &settings)?;
  Ok(BackupList {
    dir: dir.to_string_lossy().into_owned(),
    dir_exists: dir.is_dir(),
    backups: list_in(&dir),
  })
}

#[tauri::command]
pub fn restore_config_backup(app: AppHandle, path: String) -> Result<usize, String> {
  let settings = current_settings(&app);
  let dir = backup_dir(&app, &settings)?;
  let state = draft::store_dir(&app)?;
  // Read the snapshot before taking the safety one: when the retention count is one, the
  // safety file is the newest and pruning would remove the very file this was asked to
  // restore. The parsed copy does not need the file to still exist.
  let bundle = load_backup(&dir, Path::new(&path))?;
  // Keep what is on disk now before replacing it. A restore needs a way back too, and this is
  // also what preserves a broken state as evidence instead of overwriting it.
  if state_has_files(&state) {
    create_with(&app, &settings, "pre-restore")?;
  }
  apply_bundle(&state, &bundle)
}

/// Refresh the day's automatic snapshot.
///
/// `force` is the open/close path: write a new snapshot and drop the previous automatic ones
/// from today, so the day holds the configuration as it stood at that transition. Without it
/// (the hourly check) an existing snapshot is left alone and only a missing day is filled in.
#[tauri::command]
pub fn maybe_auto_backup(app: AppHandle, force: bool) -> Result<Option<BackupInfo>, String> {
  let settings = current_settings(&app);
  let dir = backup_dir(&app, &settings)?;
  if !force && auto_exists_today(&dir) {
    return Ok(None);
  }
  if !state_has_files(&draft::store_dir(&app)?) {
    return Ok(None);
  }
  let info = create_with(&app, &settings, "auto")?;
  if force {
    keep_only_auto(&dir, Path::new(&info.path));
  }
  Ok(Some(info))
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::time::{SystemTime, UNIX_EPOCH};

  fn temp_root(tag: &str) -> PathBuf {
    let nanos = SystemTime::now()
      .duration_since(UNIX_EPOCH)
      .unwrap()
      .as_nanos();
    let dir = std::env::temp_dir().join(format!(
      "wrolp-backup-test-{tag}-{}-{nanos}",
      std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn write(path: &Path, text: &str) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, text).unwrap();
  }

  fn sample_groups() -> &'static str {
    r#"{"version":1,"active":"g1","items":[{"id":"g1","name":"notes","tabs":[{"path":"C:\\a.txt"},{"path":"C:\\b.txt"}],"active":"C:\\a.txt"}]}"#
  }

  /// A snapshot with a chosen day and kind, so the clock-dependent rules can be tested
  /// without waiting for midnight.
  fn bundle_file(path: &Path, created_at: &str, kind: &str) {
    let mut files = BTreeMap::new();
    files.insert("settings.json".to_string(), "{}".to_string());
    let bundle = Bundle {
      version: BUNDLE_VERSION,
      created_at: created_at.to_string(),
      app_version: "test".into(),
      kind: kind.to_string(),
      files,
    };
    std::fs::write(path, serde_json::to_vec(&bundle).unwrap()).unwrap();
  }

  #[test]
  fn a_snapshot_restores_every_file_it_carried() {
    let root = temp_root("roundtrip");
    let state = root.join("state");
    let backups = root.join("backups");
    std::fs::create_dir_all(&backups).unwrap();
    write(&state.join("groups.json"), sample_groups());
    write(&state.join("settings.json"), r#"{"theme":"dark"}"#);
    write(&state.join("folder-history.json"), r#"{"g1":[]}"#);

    let info = write_bundle(&backups, "manual", read_state(&state), "1.0.0").unwrap();
    assert_eq!(info.groups, 1);
    assert_eq!(info.tabs, 2);
    assert_eq!(info.files, 3);

    write(
      &state.join("groups.json"),
      r#"{"version":1,"active":"","items":[]}"#,
    );
    std::fs::remove_file(state.join("folder-history.json")).unwrap();

    let target = backups.join(&info.file);
    assert_eq!(restore_from(&state, &backups, &target).unwrap(), 3);
    assert_eq!(
      std::fs::read_to_string(state.join("groups.json")).unwrap(),
      sample_groups()
    );
    assert_eq!(
      std::fs::read_to_string(state.join("folder-history.json")).unwrap(),
      r#"{"g1":[]}"#
    );
    let _ = std::fs::remove_dir_all(root);
  }

  /// The retention count can be one, and restoring must still work: the safety snapshot is
  /// written before the chosen one is applied, so at a count of one it prunes the chosen file
  /// from disk. Reading the snapshot first is what keeps that from becoming a failed restore.
  #[test]
  fn a_safety_snapshot_can_prune_the_file_being_restored_without_losing_it() {
    let root = temp_root("pruned-target");
    let state = root.join("state");
    let backups = root.join("backups");
    std::fs::create_dir_all(&backups).unwrap();
    write(&state.join("groups.json"), sample_groups());
    let chosen = write_bundle(&backups, "manual", read_state(&state), "1.0.0").unwrap();

    write(
      &state.join("groups.json"),
      r#"{"version":1,"active":"","items":[]}"#,
    );
    let newer = write_bundle(&backups, "manual", read_state(&state), "1.0.0").unwrap();
    assert_ne!(chosen.file, newer.file);

    let bundle = load_backup(&backups, &backups.join(&chosen.file)).unwrap();
    write_bundle(&backups, "pre-restore", read_state(&state), "1.0.0").unwrap();
    prune_to(&backups, 1);
    assert!(!backups.join(&chosen.file).exists());

    assert_eq!(apply_bundle(&state, &bundle).unwrap(), 1);
    assert_eq!(
      std::fs::read_to_string(state.join("groups.json")).unwrap(),
      sample_groups()
    );
    let _ = std::fs::remove_dir_all(root);
  }

  /// The day's automatic snapshot follows the configuration: a refresh removes the earlier
  /// automatic ones from the same day, while a manual snapshot and yesterday's automatic one
  /// stay where they are.
  #[test]
  fn a_refresh_keeps_one_auto_per_day_and_leaves_the_others_alone() {
    let dir = temp_root("daily");
    let today = Local::now().to_rfc3339_opts(SecondsFormat::Secs, false);
    let yesterday =
      (Local::now() - chrono::Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, false);
    let first = dir.join("wrolp-backup-20260101-000000-000-auto.json");
    let current = dir.join("wrolp-backup-20260101-000001-000-auto.json");
    let manual = dir.join("wrolp-backup-20260101-000002-000-manual.json");
    let older = dir.join("wrolp-backup-20251231-000000-000-auto.json");
    bundle_file(&first, &today, "auto");
    bundle_file(&current, &today, "auto");
    bundle_file(&manual, &today, "manual");
    bundle_file(&older, &yesterday, "auto");

    assert!(auto_exists_today(&dir));
    keep_only_auto(&dir, &current);
    assert!(!first.exists());
    assert!(current.exists());
    assert!(manual.exists());
    assert!(older.exists());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn a_manual_snapshot_today_does_not_count_as_the_days_auto() {
    let dir = temp_root("no-auto");
    let today = Local::now().to_rfc3339_opts(SecondsFormat::Secs, false);
    let yesterday =
      (Local::now() - chrono::Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, false);
    bundle_file(
      &dir.join("wrolp-backup-20260101-000002-000-manual.json"),
      &today,
      "manual",
    );
    bundle_file(
      &dir.join("wrolp-backup-20251231-000000-000-auto.json"),
      &yesterday,
      "auto",
    );
    assert!(!auto_exists_today(&dir));
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn retention_keeps_the_newest_and_leaves_foreign_files_alone() {
    let dir = temp_root("retain");
    write(
      &dir.join("wrolp-backup-20260101-000000-000-manual.json"),
      "{}",
    );
    write(
      &dir.join("wrolp-backup-20260102-000000-000-manual.json"),
      "{}",
    );
    write(
      &dir.join("wrolp-backup-20260103-000000-000-manual.json"),
      "{}",
    );
    write(&dir.join("notes.txt"), "keep me");

    prune_to(&dir, 2);
    let names: Vec<String> = backup_files(&dir)
      .into_iter()
      .map(|(name, _)| name)
      .collect();
    assert_eq!(names.len(), 2);
    assert!(names
      .iter()
      .all(|n| n.contains("20260103") || n.contains("20260102")));
    assert!(dir.join("notes.txt").is_file());
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn nothing_to_snapshot_is_an_error_rather_than_an_empty_file() {
    let dir = temp_root("empty");
    let err = write_bundle(&dir, "manual", BTreeMap::new(), "1.0.0").unwrap_err();
    assert_eq!(err, "backup_nothing");
    let _ = std::fs::remove_dir_all(dir);
  }

  #[test]
  fn a_restore_cannot_reach_outside_the_backup_folder() {
    let root = temp_root("guard");
    let state = root.join("state");
    let backups = root.join("backups");
    std::fs::create_dir_all(&backups).unwrap();
    write(&state.join("groups.json"), sample_groups());
    let outside = root.join("elsewhere.json");
    write(&outside, "{}");
    let err = restore_from(&state, &backups, &outside).unwrap_err();
    assert_eq!(err, "backup_path");
    let _ = std::fs::remove_dir_all(root);
  }

  #[test]
  fn a_damaged_snapshot_is_not_listed_and_cannot_be_restored() {
    let root = temp_root("damaged");
    let backups = root.join("backups");
    let state = root.join("state");
    std::fs::create_dir_all(&backups).unwrap();
    std::fs::create_dir_all(&state).unwrap();
    let broken = backups.join("wrolp-backup-20260101-000000-000-manual.json");
    write(&broken, "not json");
    assert!(list_in(&backups).is_empty());
    let err = restore_from(&state, &backups, &broken).unwrap_err();
    assert!(err.starts_with("backup_parse"));
    let _ = std::fs::remove_dir_all(root);
  }
}
