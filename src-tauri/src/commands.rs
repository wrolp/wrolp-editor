//! Tauri commands exposed to the frontend: file IO, draft CRUD, directory listings,
//! recently-opened history, settings and the context-menu install switch.

use crate::draft::{self, Draft};
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
    }
  }
}

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
      .map_err(|e| format!("Cannot parse {file}: {e}")),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
    Err(e) => Err(format!("Cannot read {file}: {e}")),
  }
}

fn write_json<T: Serialize>(app: &AppHandle, file: &str, value: &T) -> Result<(), String> {
  let path = draft::store_dir(app)?.join(file);
  let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
  std::fs::write(&path, json).map_err(|e| format!("Cannot write {file}: {e}"))
}

/// Drained once at startup: paths handed over by "Open with WROLP".
#[tauri::command]
pub fn take_startup_files(state: State<'_, PendingFiles>) -> Vec<String> {
  std::mem::take(&mut state.0.lock().expect("pending files lock poisoned"))
}

#[tauri::command]
pub fn open_file(app: AppHandle, path: String) -> Result<OpenedFile, String> {
  let normalized = draft::normalize_path(&path);
  if normalized.is_empty() {
    return Err("Empty file path".into());
  }
  let file = Path::new(&normalized);
  let meta = std::fs::metadata(file).map_err(|e| format!("Cannot access file: {e}"))?;
  if !meta.is_file() {
    return Err("Not a file".into());
  }
  if meta.len() > MAX_FILE_BYTES {
    return Err(format!(
      "File too large ({} MB); this editor does not support it yet",
      meta.len() / (1024 * 1024)
    ));
  }
  let bytes = std::fs::read(file).map_err(|e| format!("Read failed: {e}"))?;
  let content =
    String::from_utf8(bytes).map_err(|_| "Only UTF-8 text files are supported".to_string())?;
  let mtime = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0);

  push_history_entry(&app, &normalized)?;
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
    return Err("Empty file path".into());
  }
  let file = Path::new(&normalized);
  if let Some(parent) = file.parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("Cannot create directory: {e}"))?;
  }
  std::fs::write(file, content.as_bytes()).map_err(|e| format!("Write failed: {e}"))?;
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
    return Err("Not a directory".into());
  }
  let read = std::fs::read_dir(dir).map_err(|e| format!("Cannot read directory: {e}"))?;
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

#[tauri::command]
pub fn is_context_menu_installed() -> Result<bool, String> {
  crate::context_menu::is_installed()
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
}
