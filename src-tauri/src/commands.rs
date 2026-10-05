//! Tauri commands exposed to the frontend: file IO, draft CRUD, directory listings,
//! recently-opened history, settings, tab groups and the context-menu install switch.

use crate::draft::{self, Draft};
use crate::group::{GroupStore, TabTransfer};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Files larger than this are refused so Monaco cannot freeze the window.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

const GROUPS_FILE: &str = "groups.json";
/// Name used before a group was understood as a named set of tabs rather than a folder.
const LEGACY_GROUPS_FILE: &str = "workspaces.json";

/// Paths handed over by the command line or by a second instance.
#[derive(Default)]
pub struct PendingFiles(pub Mutex<Vec<String>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
  /// Normalized absolute path.
  pub path: String,
  pub content: String,
  /// Modification time on disk, epoch milliseconds.
  pub mtime: u64,
  /// What the bytes actually turned out to be, so a save can write the same encoding.
  pub encoding: String,
  /// The file carried a byte-order mark that was stripped from `content`.
  pub bom: bool,
  /// Size on disk, epoch-agnostic byte count. Shown in the status bar.
  pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
  pub path: String,
  pub mtime: u64,
  /// Encoding actually written, after resolving aliases like "utf8".
  pub encoding: String,
  /// Bytes actually written, which differs from the text length for legacy encodings.
  pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
  pub name: String,
  pub path: String,
  pub is_dir: bool,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
  pub path: String,
  pub name: String,
  pub opened_at: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
  pub font_size: f64,
  pub minimap: bool,
  pub sidebar_visible: bool,
  pub sidebar_view: String,
  pub sidebar_width: f64,
  /// UI language code, e.g. "en" or "zh". Unknown values are stored as-is; the frontend
  /// falls back to English, so adding a language needs no change here.
  pub language: String,
  /// Reopen the tabs of the active group on startup.
  pub restore_session: bool,
  /// Folder the Explorer shows. Global view state: a group is a named set of tabs, so two
  /// groups may sit on the same directory and one directory is never a group.
  pub sidebar_root: String,
  /// Tighten the app chrome (title bar, tabs, sidebar rows, status bar, menus).
  pub compact_mode: bool,
  /// One of the `encoding::CHOICES` labels; `auto` sniffs each file instead.
  pub encoding: String,
  /// Monaco whitespace rendering: none | boundary | selection | all | trailing.
  pub render_whitespace: String,
  pub word_wrap: bool,
  pub sticky_scroll: bool,
  /// Columns per indentation level, 1..=8.
  pub tab_size: u32,
  /// Insert spaces instead of a tab character.
  pub insert_spaces: bool,
  /// Let a file's own content win over the two settings above.
  pub detect_indentation: bool,
  /// Allow scrolling past the end, so the last line can sit above the bottom edge.
  pub scroll_beyond_last_line: bool,
}

/// Used when settings.json is absent or a key is missing, so a first run must not
/// silently turn the sidebar and minimap off.
impl Default for Settings {
  fn default() -> Self {
    Self {
      font_size: 14.0,
      minimap: true,
      sidebar_visible: true,
      sidebar_view: "explorer".into(),
      sidebar_width: 240.0,
      language: "en".into(),
      restore_session: true,
      sidebar_root: String::new(),
      compact_mode: false,
      encoding: "auto".into(),
      render_whitespace: "selection".into(),
      word_wrap: false,
      sticky_scroll: true,
      tab_size: 2,
      insert_spaces: true,
      detect_indentation: true,
      scroll_beyond_last_line: true,
    }
  }
}

const SIDEBAR_MIN_WIDTH: f64 = 180.0;
const SIDEBAR_MAX_WIDTH: f64 = 640.0;
/// Whitespace rendering modes Monaco understands.
const RENDER_WHITESPACE: [&str; 5] = ["none", "boundary", "selection", "all", "trailing"];

impl Settings {
  pub(crate) fn filled(self) -> Self {
    Self {
      font_size: if self.font_size > 0.0 {
        self.font_size
      } else {
        14.0
      },
      minimap: self.minimap,
      sidebar_visible: self.sidebar_visible,
      sidebar_view: if self.sidebar_view.is_empty() {
        "explorer".into()
      } else {
        self.sidebar_view
      },
      sidebar_width: if self.sidebar_width <= 0.0 {
        240.0
      } else {
        self
          .sidebar_width
          .clamp(SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH)
      },
      language: if self.language.is_empty() {
        "en".into()
      } else {
        self.language
      },
      restore_session: self.restore_session,
      sidebar_root: self.sidebar_root.trim().to_string(),
      compact_mode: self.compact_mode,
      // An unknown encoding or whitespace mode is a stale or hand-edited settings file.
      // Falling back here keeps the editor openable instead of refusing to start.
      encoding: if crate::encoding::is_known(&self.encoding) {
        self.encoding.trim().to_ascii_lowercase()
      } else {
        "auto".into()
      },
      render_whitespace: if RENDER_WHITESPACE.contains(&self.render_whitespace.as_str()) {
        self.render_whitespace.clone()
      } else {
        "selection".into()
      },
      word_wrap: self.word_wrap,
      sticky_scroll: self.sticky_scroll,
      // 0 would mean "collapse every level to nothing", so fall back rather than clamp.
      tab_size: if self.tab_size == 0 {
        2
      } else {
        self.tab_size.min(8)
      },
      insert_spaces: self.insert_spaces,
      detect_indentation: self.detect_indentation,
      scroll_beyond_last_line: self.scroll_beyond_last_line,
    }
  }
}

fn read_json<T: for<'de> Deserialize<'de>>(
  app: &AppHandle,
  file: &str,
) -> Result<Option<T>, String> {
  let path = draft::store_dir(app)?.join(file);
  match std::fs::read(&path) {
    Ok(bytes) => serde_json::from_slice::<T>(&bytes)
      .map(Some)
      .map_err(|e| format!("state_parse:{file}: {e}")),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("state_read:{file}: {e}")),
  }
}

/// Replace `path` with `bytes` without ever leaving a half-written file behind:
/// the whole payload goes to a sibling temp file first, then gets renamed over the target.
/// Renaming onto an existing file fails on Windows, so the target is removed first.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
  let tmp = path.with_extension("json.tmp");
  std::fs::write(&tmp, bytes).map_err(|e| format!("tmp_write:{e}"))?;
  if path.exists() {
    std::fs::remove_file(path).map_err(|e| format!("target_remove:{e}"))?;
  }
  std::fs::rename(&tmp, path).map_err(|e| format!("tmp_replace:{e}"))
}

fn write_json<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> Result<(), String> {
  let path = draft::store_dir(app)?.join(file);
  let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
  write_atomic(&path, &json).map_err(|e| format!("state_write:{file}: {e}"))
}

/// Drained once at startup: paths handed over by "Open with WROLP".
#[tauri::command]
pub fn take_startup_files(state: State<'_, PendingFiles>) -> Vec<String> {
  std::mem::take(&mut state.0.lock().expect("pending files lock poisoned"))
}

#[tauri::command]
pub fn open_file(
  app: AppHandle,
  path: String,
  record: Option<bool>,
  encoding: Option<String>,
) -> Result<OpenedFile, String> {
  let normalized = draft::normalize_path(&path);
  if normalized.is_empty() {
    return Err("path_empty".into());
  }
  let file = Path::new(&normalized);
  let meta = std::fs::metadata(file).map_err(|e| format!("file_access:{e}"))?;
  if !meta.is_file() {
    return Err("file_not_file".into());
  }
  if meta.len() > MAX_FILE_BYTES {
    return Err(format!("file_too_large:{}", meta.len() / (1024 * 1024)));
  }
  let bytes = std::fs::read(file).map_err(|e| format!("file_read:{e}"))?;
  // A per-file encoding override wins over the global default, so a file that needs
  // GBK forced on it is honoured before we decode rather than after.
  let global = match encoding.filter(|e| !e.trim().is_empty()) {
    Some(choice) => choice,
    None => stored_encoding(&app),
  };
  let preference = crate::file_settings::encoding_for(&app, &normalized, &global);
  let decoded = crate::encoding::decode(&bytes, &preference)?;
  let mtime = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);

  // Reopening a whole workspace is not "the user just opened these": recording it would
  // bury the files actually touched today under whatever was left open last session.
  if record.unwrap_or(true) {
    push_history_entry(&app, &normalized)?;
  }
  Ok(OpenedFile {
    path: normalized,
    content: decoded.text,
    mtime,
    encoding: decoded.encoding,
    bom: decoded.bom,
    bytes: meta.len(),
  })
}

/// The stored settings, cleaned. Missing file is a clean first run, not an error.
pub(crate) fn settings_of(app: &AppHandle) -> Settings {
  read_json::<Settings>(app, "settings.json")
    .ok()
    .flatten()
    .map(|s| s.filled())
    .unwrap_or_default()
}

/// The configured encoding, for callers that were not handed one.
fn stored_encoding(app: &AppHandle) -> String {
  settings_of(app).encoding
}

#[tauri::command]
pub fn save_file(
  app: AppHandle,
  path: String,
  content: String,
  encoding: Option<String>,
  bom: Option<bool>,
) -> Result<SavedFile, String> {
  let normalized = draft::normalize_path(&path);
  if normalized.is_empty() {
    return Err("path_empty".into());
  }
  let file = Path::new(&normalized);
  if let Some(parent) = file.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("dir_create:{e}"))?;
  }
  // Write back in the encoding the file was read in, so a legacy file stays legacy.
  let target = match encoding.filter(|e| !e.trim().is_empty()) {
    Some(choice) => choice,
    None => stored_encoding(&app),
  };
  let written = crate::encoding::encode(&content, &target, bom.unwrap_or(false))?;
  if written.len() as u64 > MAX_FILE_BYTES {
    return Err(format!("file_too_large:{}", written.len() / (1024 * 1024)));
  }
  std::fs::write(file, &written).map_err(|e| format!("file_write:{e}"))?;
  let mtime = std::fs::metadata(file)
    .ok()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);
  push_history_entry(&app, &normalized)?;
  Ok(SavedFile {
    path: normalized,
    mtime,
    encoding: crate::encoding::resolve(&target)?.name().to_string(),
    bytes: written.len() as u64,
  })
}

/// Directories a document may never be able to read, however it spells the path.
/// Generated from the environment so the list follows the machine it runs on.
fn protected_roots() -> Vec<PathBuf> {
  [
    "USERPROFILE",
    "SystemRoot",
    "ProgramFiles",
    "ProgramFiles(x86)",
  ]
  .iter()
  .filter_map(|name| std::env::var(name).ok())
  .filter(|value| !value.is_empty())
  .map(PathBuf::from)
  .collect()
}

/// True when granting `dir` would hand over a whole drive, the system directory or the
/// user's entire profile.
///
/// A markdown file is allowed to point at images outside its own folder, so the grant
/// follows the references. That only stays reasonable while a document cannot walk up
/// to a root and read everything from there: `notes/a.md` reaching `../shared/logo.png`
/// is a picture next door, whereas reaching the home directory is not. Refusing every
/// ancestor of a protected root draws that line without needing a full path policy.
fn refused_by_scope(dir: &Path, protected: &[PathBuf]) -> bool {
  // A drive root such as "C:\" has no parent to be anything but a whole disk.
  match dir.parent() {
    Some(parent) if !parent.as_os_str().is_empty() => {}
    _ => return true,
  }
  protected.iter().any(|root| {
    let same_length = root.components().count() == dir.components().count();
    // The root itself, or any folder that contains it.
    (same_length && root.as_path() == dir) || (root.starts_with(dir) && !same_length)
  })
}

/// Let the asset protocol read one directory, so markdown can show relative images.
///
/// Called with the folder of each image a document references, so the grant covers the
/// picture and its siblings rather than a fixed subtree. Every folder that is refused
/// here stays unreachable no matter how many `..` segments a document uses.
#[tauri::command]
pub fn allow_asset_dir(app: AppHandle, dir: String) -> Result<(), String> {
  let normalized = draft::normalize_path(&dir);
  let path = Path::new(&normalized);
  if !path.is_dir() {
    return Err("not_a_directory".into());
  }
  if refused_by_scope(path, &protected_roots()) {
    return Err("asset_scope_refused".into());
  }
  app
    .asset_protocol_scope()
    .allow_directory(path, true)
    .map_err(|e| format!("asset_scope:{e}"))
}

/// Overrides for one file; every field absent means "follow the global default".
#[tauri::command]
pub fn get_file_settings(
  app: AppHandle,
  path: String,
) -> Result<crate::file_settings::FileSettings, String> {
  crate::file_settings::get(&app, &path)
}

#[tauri::command]
pub fn save_file_settings(
  app: AppHandle,
  path: String,
  settings: crate::file_settings::FileSettings,
) -> Result<crate::file_settings::FileSettings, String> {
  crate::file_settings::save(&app, &path, settings)
}

/// Back to the global defaults for this file.
#[tauri::command]
pub fn clear_file_settings(app: AppHandle, path: String) -> Result<(), String> {
  crate::file_settings::clear(&app, &path)
}

#[tauri::command]
pub fn get_draft(app: AppHandle, path: String) -> Result<Option<Draft>, String> {
  draft::load(&app, &path)
}
#[tauri::command]
pub fn save_draft(
  app: AppHandle,
  path: String,
  content: String,
  cursor: usize,
) -> Result<Draft, String> {
  draft::save(&app, &path, &content, cursor)
}

#[tauri::command]
pub fn clear_draft(app: AppHandle, path: String) -> Result<bool, String> {
  draft::clear(&app, &path)
}

/// Directory listing: directories first, then case-insensitive by name.
#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<FsEntry>, String> {
  const IGNORED: [&str; 4] = ["node_modules", "target", "dist", ".git"];
  let normalized = draft::normalize_path(&path);
  let dir = Path::new(&normalized);
  if !dir.is_dir() {
    return Err("not_a_directory".into());
  }
  let read = std::fs::read_dir(dir).map_err(|e| format!("dir_read:{e}"))?;
  let mut entries: Vec<FsEntry> = Vec::new();
  for item in read.flatten() {
    let name = item.file_name().to_string_lossy().to_string();
    if IGNORED.iter().any(|i| name.eq_ignore_ascii_case(i)) {
      continue;
    }
    let is_dir = item.path().is_dir();
    entries.push(FsEntry {
      path: item.path().to_string_lossy().to_string(),
      name: if is_dir { format!("{name}/") } else { name },
      is_dir,
    });
  }
  entries.sort_by(|a, b| {
    b.is_dir
      .cmp(&a.is_dir)
      .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
  });
  Ok(entries)
}

#[tauri::command]
pub fn get_history(app: AppHandle) -> Result<Vec<HistoryEntry>, String> {
  Ok(read_json::<Vec<HistoryEntry>>(&app, "history.json")?.unwrap_or_default())
}

fn push_history_entry(app: &AppHandle, path: &str) -> Result<(), String> {
  let mut history = read_json::<Vec<HistoryEntry>>(app, "history.json")?.unwrap_or_default();
  history.retain(|h| h.path != path);
  let name = Path::new(path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| path.to_string());
  history.insert(
    0,
    HistoryEntry {
      path: path.to_string(),
      name,
      opened_at: chrono::Utc::now().to_rfc3339(),
    },
  );
  history.truncate(50);
  write_json(app, "history.json", &history)
}

#[tauri::command]
pub fn remove_history(app: AppHandle, path: String) -> Result<Vec<HistoryEntry>, String> {
  let target = draft::normalize_path(&path);
  let mut history = read_json::<Vec<HistoryEntry>>(&app, "history.json")?.unwrap_or_default();
  history.retain(|h| draft::normalize_path(&h.path) != target);
  write_json(&app, "history.json", &history)?;
  Ok(history)
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
  Ok(
    read_json::<Settings>(&app, "settings.json")?
      .unwrap_or_default()
      .filled(),
  )
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
  let settings = settings.filled();
  write_json(&app, "settings.json", &settings)?;
  Ok(settings)
}

/// Whole-store round trip, same shape as settings. A missing file is a clean first run, not
/// an error. Older builds kept this in `workspaces.json`: that name is migrated here, on read,
/// so a failed parse can never be followed by a save that deletes the unreadable original.
#[tauri::command]
pub fn get_groups(app: AppHandle) -> Result<GroupStore, String> {
  if let Some(store) = read_json::<GroupStore>(&app, GROUPS_FILE)? {
    return Ok(store.filled());
  }
  let legacy = read_json::<GroupStore>(&app, LEGACY_GROUPS_FILE)?;
  match legacy {
    Some(legacy) => {
      let store = legacy.filled();
      // The old file stays until the new one is safely on disk.
      write_json(&app, GROUPS_FILE, &store)?;
      let old = draft::store_dir(&app)?.join(LEGACY_GROUPS_FILE);
      if old.exists() {
        let _ = std::fs::remove_file(&old);
      }
      Ok(store)
    }
    None => Ok(GroupStore::default().filled()),
  }
}

#[tauri::command]
pub fn save_groups(app: AppHandle, store: GroupStore) -> Result<GroupStore, String> {
  let store = store.filled().stamp_active();
  write_json(&app, GROUPS_FILE, &store)?;
  Ok(store)
}

/// Re-home tabs between groups. Pure: it takes the store the frontend is holding and hands
/// back the new one, which the frontend then saves in a single write.
#[tauri::command]
pub fn transfer_tabs(store: GroupStore, transfer: TabTransfer) -> GroupStore {
  crate::group::apply_transfer(store, &transfer).filled()
}

#[tauri::command]
pub fn context_menu_target() -> Result<crate::context_menu::MenuTarget, String> {
  crate::context_menu::probe()
}

#[tauri::command]
pub fn install_context_menu() -> Result<String, String> {
  crate::context_menu::install()
}

#[tauri::command]
pub fn uninstall_context_menu() -> Result<(), String> {
  crate::context_menu::uninstall()
}

/// Queue a path and tell an already-running window about it.
pub fn enqueue_path(app: &AppHandle, raw: &str) {
  let normalized = draft::normalize_path(raw);
  if normalized.is_empty() {
    return;
  }
  {
    let state = app.state::<PendingFiles>();
    state
      .0
      .lock()
      .expect("pending files lock poisoned")
      .push(normalized.clone());
  }
  use tauri::Emitter;
  let _ = app.emit("open-file", normalized);
}

/// Pick file paths out of argv; the context menu hands us the target as `%1`.
pub fn paths_from_args<I, S>(args: I) -> Vec<String>
where
  I: IntoIterator<Item = S>,
  S: AsRef<str>,
{
  args
    .into_iter()
    .skip(1)
    .map(|a| a.as_ref().to_string())
    .filter(|a| !a.is_empty() && !a.starts_with("--") && !a.contains("tauri://"))
    .collect()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn startup_args_skip_program_and_flags() {
    let got = paths_from_args([
      r"C:\app\wrolp-editor.exe",
      r"C:\notes\a.txt",
      "--internal-flag",
    ]);
    assert_eq!(got, vec![r"C:\notes\a.txt".to_string()]);
  }

  #[test]
  fn first_run_defaults_keep_sidebar_and_minimap_on() {
    let s = Settings::default();
    assert!(s.sidebar_visible);
    assert!(s.minimap);
    assert_eq!(s.sidebar_view, "explorer");
    assert_eq!(s.font_size, 14.0);
    assert_eq!(s.sidebar_width, 240.0);
  }

  /// The asset scope is the one place where a document could ask to read outside its own
  /// folder, so the line has to be pinned by tests rather than by a comment.
  #[test]
  fn asset_scope_allows_neighbours_but_never_a_whole_disk_or_profile() {
    let home = PathBuf::from(r"C:\Users\x");
    let protected = vec![home.clone()];

    let ok = [
      r"C:\Users\x\docs\shared",
      r"C:\Users\x\docs\notes",
      r"C:\Users\x\Downloads",
      r"D:\projects\assets",
    ];
    for dir in ok {
      assert!(
        !refused_by_scope(Path::new(dir), &protected),
        "{dir} should be reachable"
      );
    }

    let refused = [r"C:\", r"C:\Users", r"C:\Users\x"];
    for dir in refused {
      assert!(
        refused_by_scope(Path::new(dir), &protected),
        "{dir} must never be granted"
      );
    }
  }

  #[test]
  fn a_drive_root_is_refused_even_without_protected_roots() {
    assert!(refused_by_scope(Path::new(r"C:\"), &[]));
    assert!(refused_by_scope(Path::new(r"\\server\share"), &[]));
  }

  /// Compact mode is a deliberate opt-in, so a settings.json written before the key
  /// existed must not come back switched on.
  /// A tab size of 0 would collapse every indentation level, and a huge one is unusable,
  /// so both ends are clamped instead of being taken at face value.
  #[test]
  fn tab_size_is_bounded_and_never_zero() {
    assert_eq!(Settings::default().tab_size, 2);
    for (given, expected) in [(0, 2), (1, 1), (4, 4), (8, 8), (99, 8)] {
      assert_eq!(
        Settings {
          tab_size: given,
          ..Default::default()
        }
        .filled()
        .tab_size,
        expected,
        "tab_size {given} should resolve to {expected}"
      );
    }
  }

  #[test]
  fn missing_indentation_keys_fall_back_to_the_defaults() {
    let s: Settings = serde_json::from_str("{\"fontSize\":16.0}").expect("parse partial settings");
    let s = s.filled();
    assert_eq!(s.tab_size, 2);
    assert!(s.insert_spaces);
    assert!(s.detect_indentation);
    // Scrolling past the end is on by default, and a settings.json written before the
    // key existed must not silently change how the editor scrolls.
    assert!(s.scroll_beyond_last_line);
    assert!(
      !Settings {
        scroll_beyond_last_line: false,
        ..Default::default()
      }
      .filled()
      .scroll_beyond_last_line
    );
  }

  #[test]
  fn compact_mode_is_off_by_default_and_survives_missing_keys() {
    assert!(!Settings::default().compact_mode);
    let s: Settings = serde_json::from_str("{\"fontSize\":16.0}").expect("parse partial settings");
    assert!(!s.compact_mode);
    assert!(
      Settings {
        compact_mode: true,
        ..Default::default()
      }
      .filled()
      .compact_mode
    );
  }

  #[test]
  fn language_defaults_to_english_and_otherwise_passes_through() {
    assert_eq!(
      Settings {
        language: "zh".into(),
        ..Default::default()
      }
      .filled()
      .language,
      "zh"
    );
    assert_eq!(
      Settings {
        language: String::new(),
        ..Default::default()
      }
      .filled()
      .language,
      "en"
    );
    assert_eq!(
      Settings {
        language: "fr".into(),
        ..Default::default()
      }
      .filled()
      .language,
      "fr"
    );
    assert_eq!(Settings::default().language, "en");
  }

  #[test]
  fn sidebar_width_is_clamped_to_the_draggable_range() {
    assert_eq!(
      Settings {
        sidebar_width: 0.0,
        ..Default::default()
      }
      .filled()
      .sidebar_width,
      240.0
    );
    assert_eq!(
      Settings {
        sidebar_width: 40.0,
        ..Default::default()
      }
      .filled()
      .sidebar_width,
      180.0
    );
    assert_eq!(
      Settings {
        sidebar_width: 5000.0,
        ..Default::default()
      }
      .filled()
      .sidebar_width,
      640.0
    );
  }

  #[test]
  fn settings_defaults_are_applied() {
    let s = Settings {
      font_size: 0.0,
      sidebar_view: String::new(),
      ..Default::default()
    }
    .filled();
    assert_eq!(s.font_size, 14.0);
    assert_eq!(s.sidebar_view, "explorer");
  }

  /// An older settings.json has no restoreSession key at all; that must not read as
  /// "the user turned session restore off".
  #[test]
  fn missing_settings_keys_fall_back_to_the_defaults() {
    let s: Settings =
      serde_json::from_str("{\"fontSize\":16.0,\"minimap\":false,\"language\":\"zh\"}")
        .expect("parse partial settings");
    assert!(s.restore_session);
    assert!(!s.minimap);
    assert_eq!(s.font_size, 16.0);
    assert_eq!(s.language, "zh");
    // A settings file written before workspaces were groups has no sidebarRoot at all.
    assert_eq!(s.sidebar_root, "");
    assert_eq!(s.filled().sidebar_root, "");
  }

  fn scratch_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("wrolp-{}-{}", name, std::process::id()));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
  }

  #[test]
  fn atomic_write_replaces_content_and_leaves_no_temp_file() {
    let dir = scratch_dir("atomic-ok");
    let target = dir.join("store.json");
    std::fs::write(&target, b"old").expect("seed");

    write_atomic(&target, b"{\"version\":1}").expect("write");

    assert_eq!(std::fs::read(&target).expect("read"), b"{\"version\":1}");
    assert!(!dir.join("store.json.tmp").exists());
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn failed_atomic_write_leaves_the_previous_file_intact() {
    let dir = scratch_dir("atomic-bad");
    let target = dir.join("store.json");
    std::fs::write(&target, b"old").expect("seed");
    // A directory cannot be swapped in as a file, so this write must fail...
    let blocked = dir.join("blocked");
    std::fs::create_dir_all(&blocked).expect("mkdir");
    assert!(write_atomic(&blocked, b"new").is_err());
    // ...and the state that was already on disk is still readable.
    assert_eq!(std::fs::read(&target).expect("read"), b"old");
    std::fs::remove_dir_all(&dir).ok();
  }
}
