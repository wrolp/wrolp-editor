//! Tauri commands exposed to the frontend: file IO, draft CRUD, directory listings,
//! recently-opened history, settings, workspace state and the context-menu install switch.

use crate::draft::{self, Draft};
use crate::workspace::WorkspaceStore;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};

/// Files larger than this are refused so Monaco cannot freeze the window.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedFile {
  pub path: String,
  pub mtime: u64,
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
  /// Reopen the tabs of the active workspace on startup.
  pub restore_session: bool,
  /// Folder the Explorer shows. Global view state: a workspace is a named group of tabs,
  /// not a folder, so two groups may sit on the same directory.
  pub sidebar_root: String,
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
    }
  }
}

const SIDEBAR_MIN_WIDTH: f64 = 180.0;
const SIDEBAR_MAX_WIDTH: f64 = 640.0;

impl Settings {
  fn filled(self) -> Self {
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
fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
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
pub fn open_file(app: AppHandle, path: String, record: Option<bool>) -> Result<OpenedFile, String> {
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
  let content = String::from_utf8(bytes).map_err(|_| "file_not_utf8".to_string())?;
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
    content,
    mtime,
  })
}

#[tauri::command]
pub fn save_file(app: AppHandle, path: String, content: String) -> Result<SavedFile, String> {
  let normalized = draft::normalize_path(&path);
  if normalized.is_empty() {
    return Err("path_empty".into());
  }
  let file = Path::new(&normalized);
  if let Some(parent) = file.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("dir_create:{e}"))?;
  }
  std::fs::write(file, content.as_bytes()).map_err(|e| format!("file_write:{e}"))?;
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
  })
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

/// Whole-store round trip, same shape as settings: a missing file is a clean first run,
/// not an error, and the returned store is always the cleaned one that was validated.
#[tauri::command]
pub fn get_workspaces(app: AppHandle) -> Result<WorkspaceStore, String> {
  Ok(
    read_json::<WorkspaceStore>(&app, "workspaces.json")?
      .unwrap_or_default()
      .filled(),
  )
}

#[tauri::command]
pub fn save_workspaces(app: AppHandle, store: WorkspaceStore) -> Result<WorkspaceStore, String> {
  let store = store.filled().stamp_active();
  write_json(&app, "workspaces.json", &store)?;
  Ok(store)
}

/// Re-home tabs between workspaces. Pure: it takes the store the frontend is holding and
/// hands back the new one, which the frontend then saves in a single write.
#[tauri::command]
pub fn transfer_tabs(
  store: WorkspaceStore,
  transfer: crate::workspace::TabTransfer,
) -> WorkspaceStore {
  crate::workspace::apply_transfer(store, &transfer).filled()
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
