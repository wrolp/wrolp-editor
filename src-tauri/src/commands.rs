//! Tauri commands exposed to the frontend: file IO, draft CRUD, directory listings,
//! recently-opened history, settings, tab groups and the context-menu install switch.

use crate::crypto::{self, KEY_LEN};
use crate::draft::{self, Draft, DraftKey};
use crate::group::{GroupStore, TabTransfer};
use crate::unlock::UnlockStore;
use crate::window::{MonitorRect, Placement, WindowState};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Manager, State};
use zeroize::Zeroize;

/// Files larger than this are refused so Monaco cannot freeze the window.
pub(crate) const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) const GROUPS_FILE: &str = "groups.json";
/// Where the window was last left. Separate from settings: it changes on every drag.
const WINDOW_FILE: &str = "window.json";
/// Raster images: bytes with no text in them, so decoding them as text fails and the file
/// could not be opened at all. SVG is deliberately absent — it is text, and is edited as
/// source.
const BINARY_EXT: [&str; 11] = [
  "png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "tif", "tiff", "heic",
];

fn is_binary_ext(path: &str) -> bool {
  match path.rsplit_once('.') {
    Some((_, ext)) => BINARY_EXT.contains(&ext.to_ascii_lowercase().as_str()),
    None => false,
  }
}
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
  /// The file is a picture, so `content` is empty and nothing on screen is text. The
  /// frontend shows the image itself and keeps the editor out of the way, so a stray
  /// keystroke cannot write a decoded picture back over the original.
  pub binary: bool,
  /// The file on disk is an encrypted container. `mtime` and `bytes` then describe the
  /// ciphertext, which is what a save has to beat.
  pub encrypted: bool,
  /// Encrypted and no key is available, so `content` is empty because nothing has been
  /// decrypted. The frontend shows a lock instead of an empty buffer: an empty buffer
  /// looks like a file that can be typed into and saved over.
  pub locked: bool,
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

/// What a file currently is on disk, without reading a byte of it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileStat {
  pub path: String,
  pub mtime: u64,
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
  /// Text size in the sidebar's list content: the file tree, the recent files and the folder
  /// menu, which are the rules that read `--sidebar-font`. Its own setting because a file name is
  /// read, not edited, and a smaller one of those fits a lot more of the folder on screen.
  /// Defaults to the 12 px the tree was pinned at before this existed, so installing the build
  /// changes nothing until somebody moves the number.
  pub sidebar_font: f64,
  /// UI language code, e.g. "en" or "zh". Unknown values are stored as-is; the frontend
  /// falls back to English, so adding a language needs no change here.
  pub language: String,
  /// Reopen the tabs of the active group on startup.
  pub restore_session: bool,
  /// What a reopened session does with a draft that differs from the file on disk: `auto`
  /// loads it without asking, `ask` raises the Restore / Discard dialog for each file.
  /// `auto` is the default because the draft is the only copy of that typing, and a dialog
  /// that can be dismissed by reflex throws it away.
  pub draft_restore: String,
  /// Folder the Explorer shows. Global view state: a group is a named set of tabs, so two
  /// groups may sit on the same directory and one directory is never a group.
  pub sidebar_root: String,
  /// Expand folders in the Explorer when a directory is opened. Off by default: a tree
  /// that is already showing what it holds leaves no clue how deep the folder goes.
  pub expand_folders: bool,
  /// How many levels `expand_folders` opens: 1 is the folders directly under the root,
  /// 2 adds their children, and so on. Only read while `expand_folders` is on.
  pub expand_depth: u32,
  /// File types that must not show the "Open with WROLP" verb, as extensions without the
  /// dot (`"png"`). Normalized on save, so what lands in settings.json is what is used.
  pub excluded_extensions: Vec<String>,
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
  /// Strike out spaces and tabs at the end of a line as the file is saved. Off by default:
  /// markdown means something by two of them, and a file nobody asked to tidy should come back
  /// byte for byte. The editor applies this to the buffer, so the screen shows the saved text.
  pub trim_trailing_whitespace: bool,
  /// Add the line break a file is missing when it is saved. Off by default for the same reason,
  /// and the break that gets added is the one that file already uses.
  pub insert_final_newline: bool,
  /// Write dirty files back on a timer, without being asked. Off by default, and it only ever
  /// touches a file that already exists: an untitled buffer would have to be asked for a name,
  /// which is not a decision a background task gets to make.
  pub auto_save: bool,
  /// Seconds the file on screen must go without an edit before the automatic save writes it. Only
  /// read while `auto_save` is on. A quiet period rather than a polling interval, and counted for
  /// the active tab: an edit starts this file's countdown again, so the write lands on the first
  /// pause instead of in the middle of a sentence.
  pub auto_save_interval: u32,
  /// The line ending for a document that has none of its own: a new file, or one read with no
  /// break in it. A file that came with breaks is written back with those unless its own entry
  /// in `file-settings.json` says otherwise, so this setting never rewrites somebody's
  /// repository underneath them. One of `encoding::LINE_ENDINGS`; the editor applies the choice
  /// to the text, so a save always writes what it showed.
  pub line_ending: String,
  /// Allow scrolling past the end, so the last line can sit above the bottom edge.
  pub scroll_beyond_last_line: bool,
  /// How a file that has a preview opens: auto | text | split | preview. `text` is the
  /// default because a document is opened to be read and written; the preview is one
  /// keystroke away, whereas a preview nobody asked for costs a pane. A picture is not
  /// covered by this choice — its bytes are not text, so it always opens as the picture.
  pub preview_layout: String,
  /// How wide the markdown preview body is inside its pane: narrow | wide | full.
  /// `narrow` and `wide` cap the line length so text stays readable and centre it; `full`
  /// runs the text the width of the pane. A line length is worth capping because a
  /// paragraph that spans a wide window is hard to track back to its next line.
  pub preview_width: String,
  /// The layout each previewable file was last left in, keyed by absolute path:
  /// text | split | preview. A file with no entry follows `preview_layout`, so only explicit
  /// choices are stored. A rename rewrites the key; an entry for a file since deleted is
  /// harmless and is simply never read.
  pub preview_modes: HashMap<String, String>,
  /// Which side the markdown outline takes in preview-only mode: left | right. Right by
  /// default, so the column does not sit against the Explorer.
  pub toc_side: String,
  /// Colour scheme: system | dark | light. `system` follows the OS preference at runtime,
  /// so a machine that switches at dusk does not need the app restarted.
  pub theme: String,
  /// Minutes an encrypted file stays unlocked without being touched. 0 means never lock
  /// automatically, which is a deliberate choice rather than a missing value, so it is
  /// kept as written.
  pub encrypt_idle_minutes: u32,
  /// Record a version of a file each time it is saved by hand. Off by default: versioning writes
  /// to the disk every save and never cleans up on its own, and an editor that fills a drive
  /// without being asked has spent the trust that made it worth opening.
  pub versioning_enabled: bool,
  /// How many versions of one file the list reads. Not a retention limit — history is not trimmed
  /// from the middle, so this only bounds how far the timeline is walked and what crosses IPC.
  pub versioning_show_limit: u32,
  /// Files bigger than this are left out of versioning, in UTF-8 bytes. A whole copy of a large
  /// file every save is not a history, it is a backup with worse ergonomics.
  pub versioning_max_file_size: u64,
  /// Whether a write the automatic save made also records a version. Off by default, and it only
  /// ever matters for a file versioning already covers: the timer runs whether or not anybody is
  /// at the keyboard, so recording it fills the timeline with half-typed lines.
  pub auto_save_versions: bool,
  /// Whether a save asked for by hand is stopped first, to ask what that version is for. Off by
  /// default: a box in the way of `Ctrl+S` is only tolerable when somebody chose it, which is why
  /// this is a separate switch rather than part of versioning itself.
  pub ask_note_on_save: bool,
  /// Where configuration backups are written. Empty means `wrolp/backups`, beside the state
  /// folder; a path the user picked is kept as given. The folder is created when a backup is
  /// taken or the list is read, so a choice that cannot be reached yet is still remembered.
  pub backup_dir: String,
  /// How many backups are kept. Older snapshots are deleted when a newer one is written, which is
  /// also what keeps an automatic snapshot from growing the folder without bound.
  pub backup_retain: u32,
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
      sidebar_font: 12.0,
      language: "en".into(),
      restore_session: true,
      draft_restore: "auto".into(),
      sidebar_root: String::new(),
      expand_folders: false,
      expand_depth: 1,
      excluded_extensions: Vec::new(),
      compact_mode: false,
      encoding: "auto".into(),
      render_whitespace: "selection".into(),
      word_wrap: false,
      sticky_scroll: true,
      tab_size: 2,
      insert_spaces: true,
      detect_indentation: true,
      trim_trailing_whitespace: false,
      insert_final_newline: false,
      auto_save: false,
      auto_save_interval: AUTO_SAVE_DEFAULT_SECONDS,
      line_ending: "lf".into(),
      scroll_beyond_last_line: true,
      preview_layout: "text".into(),
      preview_width: "narrow".into(),
      preview_modes: HashMap::new(),
      toc_side: "right".into(),
      theme: "system".into(),
      encrypt_idle_minutes: ENCRYPT_IDLE_DEFAULT_MINUTES,
      versioning_enabled: false,
      versioning_show_limit: VERSIONING_DEFAULT_SHOW_LIMIT,
      versioning_max_file_size: VERSIONING_DEFAULT_MAX_FILE_SIZE,
      auto_save_versions: false,
      ask_note_on_save: false,
      // Empty means `wrolp/backups`, a sibling of the state folder: next to the configuration,
      // without mixing snapshots into the files the app reads as its current state.
      backup_dir: String::new(),
      backup_retain: crate::backup::DEFAULT_RETAIN,
    }
  }
}

const SIDEBAR_MIN_WIDTH: f64 = 180.0;
const SIDEBAR_MAX_WIDTH: f64 = 640.0;
/// Sidebar text sizes, in CSS pixels. The low end is the smallest a file name is still read at
/// rather than recognised by shape; the high end is where the tree stops fitting its own column.
const SIDEBAR_FONT_MIN: f64 = 11.0;
const SIDEBAR_FONT_MAX: f64 = 20.0;
/// The automatic save is off by default, so this is only the pause a fresh install starts with once
/// somebody turns it on: long enough that typing is not interrupted by a write every other second,
/// short enough that leaving the window for a coffee saves the file anyway.
const AUTO_SAVE_DEFAULT_SECONDS: u32 = 5;
const AUTO_SAVE_MAX_SECONDS: u32 = 3600;
/// Whitespace rendering modes Monaco understands.
const RENDER_WHITESPACE: [&str; 5] = ["none", "boundary", "selection", "all", "trailing"];
/// Colour schemes the frontend knows how to apply.
const THEMES: [&str; 3] = ["system", "dark", "light"];
/// What startup does with a draft the file on disk does not have.
const DRAFT_RESTORE: [&str; 2] = ["auto", "ask"];
/// Preview layouts a file can open in. `auto` is the per-kind behaviour the frontend used
/// to hardcode: markdown and SVG side by side, pictures as the picture.
const PREVIEW_LAYOUT: [&str; 4] = ["auto", "text", "split", "preview"];
/// Per-file layouts. `auto` is deliberately absent: an entry exists only because somebody
/// picked a layout for that file, and the fallback stays in `preview_layout`.
const PER_FILE_PREVIEW: [&str; 3] = ["text", "split", "preview"];
/// Widths the markdown preview body can take, as capped reading measures. The numbers
/// themselves live in the stylesheet; this only names the three choices.
const PREVIEW_WIDTH: [&str; 3] = ["narrow", "wide", "full"];
/// Sides the markdown outline can take. Right by default: the Explorer is on the left, and a
/// contents column against it would read as a second sidebar.
const TOC_SIDES: [&str; 2] = ["left", "right"];
/// A key left in memory for a day is not an idle lock any more, so the setting stops there.
const ENCRYPT_IDLE_DEFAULT_MINUTES: u32 = 10;
const ENCRYPT_IDLE_MAX_MINUTES: u32 = 1440;
/// How many versions of one file a list reads. Nothing is deleted when the count is passed — git
/// history is not trimmed from the middle — so this is the depth of a walk and of one IPC payload.
const VERSIONING_DEFAULT_SHOW_LIMIT: u32 = 30;
const VERSIONING_MAX_SHOW_LIMIT: u32 = 500;
/// Half a megabyte of text is a long document, and a version store that takes a whole copy of
/// every save of something bigger stops being a history and becomes a backup.
const VERSIONING_DEFAULT_MAX_FILE_SIZE: u64 = 524_288;
/// The ceiling on that setting. A value above it is either a typo or an intent to version binary
/// files, and neither is what a text editor's history is for.
const VERSIONING_MAX_FILE_SIZE_CEILING: u64 = 33_554_432;

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
      sidebar_font: if self.sidebar_font > 0.0 {
        self.sidebar_font.clamp(SIDEBAR_FONT_MIN, SIDEBAR_FONT_MAX)
      } else {
        12.0
      },
      language: if self.language.is_empty() {
        "en".into()
      } else {
        self.language
      },
      restore_session: self.restore_session,
      draft_restore: if DRAFT_RESTORE.contains(&self.draft_restore.as_str()) {
        self.draft_restore.clone()
      } else {
        "auto".into()
      },
      sidebar_root: self.sidebar_root.trim().to_string(),
      expand_folders: self.expand_folders,
      // 0 would mean "expand nothing", which is the same as having the setting off at all.
      expand_depth: if self.expand_depth == 0 {
        1
      } else {
        self.expand_depth.min(8)
      },
      // Normalized here rather than trusted: this list reaches the registry as key names.
      excluded_extensions: {
        let mut out: Vec<String> = Vec::new();
        for ext in self.excluded_extensions {
          if let Some(clean) = crate::context_menu::sanitize(&ext) {
            if !out.contains(&clean) {
              out.push(clean);
            }
          }
        }
        out.truncate(64);
        out
      },
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
      trim_trailing_whitespace: self.trim_trailing_whitespace,
      insert_final_newline: self.insert_final_newline,
      auto_save: self.auto_save,
      // One second is already eager; an hour is as good as switching it off, so anything past
      // that is read as a typo rather than an intention.
      auto_save_interval: self.auto_save_interval.clamp(1, AUTO_SAVE_MAX_SECONDS),
      // Same rule as the encoding above: a value the editor cannot use is a stale or
      // hand-edited key, and the safe reading of that is the convention the app started with.
      line_ending: if crate::encoding::is_line_ending(&self.line_ending) {
        crate::encoding::normalize_line_ending(&self.line_ending)
      } else {
        "lf".into()
      },
      scroll_beyond_last_line: self.scroll_beyond_last_line,
      // Hand-edited or older settings can carry anything; an unknown layout would leave the
      // frontend with no mode to show, so fall back to the default rather than trust it.
      preview_layout: if PREVIEW_LAYOUT.contains(&self.preview_layout.as_str()) {
        self.preview_layout.clone()
      } else {
        "text".into()
      },
      preview_width: if PREVIEW_WIDTH.contains(&self.preview_width.as_str()) {
        self.preview_width.clone()
      } else {
        "narrow".into()
      },
      // An entry is an explicit choice, so anything this build cannot show is dropped rather
      // than carried around forever — the file then falls back to `preview_layout`.
      preview_modes: {
        let mut out = HashMap::new();
        for (path, mode) in self.preview_modes {
          if !path.is_empty() && PER_FILE_PREVIEW.contains(&mode.as_str()) {
            out.insert(path, mode);
          }
        }
        out
      },
      toc_side: if TOC_SIDES.contains(&self.toc_side.as_str()) {
        self.toc_side.clone()
      } else {
        "right".into()
      },
      // Same reasoning as the layout above: an unknown theme would leave the frontend with
      // no palette to apply, and an app with no palette is worse than one that ignores it.
      theme: if THEMES.contains(&self.theme.as_str()) {
        self.theme.clone()
      } else {
        "system".into()
      },
      // 0 is "never lock" and must survive as written; only the upper end is clamped, since
      // a huge value there is a typo rather than an intention.
      encrypt_idle_minutes: self.encrypt_idle_minutes.min(ENCRYPT_IDLE_MAX_MINUTES),
      versioning_enabled: self.versioning_enabled,
      // 0 would ask for a list that is always empty, which is a mis-click rather than a wish to
      // see no history.
      versioning_show_limit: if self.versioning_show_limit == 0 {
        VERSIONING_DEFAULT_SHOW_LIMIT
      } else {
        self.versioning_show_limit.min(VERSIONING_MAX_SHOW_LIMIT)
      },
      // Same: 0 would refuse every file, so the default is the reading of a stray zero.
      versioning_max_file_size: if self.versioning_max_file_size == 0 {
        VERSIONING_DEFAULT_MAX_FILE_SIZE
      } else {
        self
          .versioning_max_file_size
          .min(VERSIONING_MAX_FILE_SIZE_CEILING)
      },
      auto_save_versions: self.auto_save_versions,
      ask_note_on_save: self.ask_note_on_save,
      backup_dir: self.backup_dir.trim().to_string(),
      // A zero would leave no snapshot at all after the next write, and a hundred is already more
      // history than a configuration needs.
      backup_retain: if self.backup_retain == 0 {
        crate::backup::DEFAULT_RETAIN
      } else {
        self.backup_retain.min(crate::backup::MAX_RETAIN)
      },
    }
  }
}

pub(crate) fn read_json<T: for<'de> Deserialize<'de>>(
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
///
/// Nothing is deleted on the way. `rename` replaces an existing file on Windows (std passes
/// `MOVEFILE_REPLACE_EXISTING`), so removing the target first would only open a window in
/// which the file does not exist at all — and for an encrypted document a crash inside that
/// window is not a damaged file to be repaired by hand, it is a lost one.
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
  // `.tmp` is appended rather than swapped in for the extension: `with_extension` would turn
  // `notes.md` and `notes.txt` into the same temp file in the same directory.
  let tmp = path.with_file_name(format!(
    "{}.tmp",
    path
      .file_name()
      .map(|n| n.to_string_lossy())
      .unwrap_or_default()
  ));
  std::fs::write(&tmp, bytes).map_err(|e| format!("tmp_write:{e}"))?;
  std::fs::rename(&tmp, path).map_err(|e| format!("tmp_replace:{e}"))
}

pub(crate) fn write_json<T: Serialize>(
  app: &AppHandle,
  file: &str,
  value: &T,
) -> Result<(), String> {
  let path = draft::store_dir(app)?.join(file);
  let json = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
  write_atomic(&path, &json).map_err(|e| format!("state_write:{file}: {e}"))
}

/// Drained once at startup: paths handed over by "Open with WROLP".
#[tauri::command]
pub fn take_startup_files(state: State<'_, PendingFiles>) -> Vec<String> {
  std::mem::take(&mut state.0.lock().expect("pending files lock poisoned"))
}

/// Modification time as epoch milliseconds, the unit the frontend compares against.
/// A filesystem that reports none yields 0, so it can never look like a change happened.
pub(crate) fn mtime_ms(meta: &std::fs::Metadata) -> u64 {
  meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_millis() as u64)
    .unwrap_or(0)
}

/// A file read off disk past the checks every reader needs: it resolves, it is a file
/// rather than a directory, and it is not bigger than the editor will hold in memory.
/// Shared by the plain and the encrypted open paths so the two cannot drift apart on what
/// counts as openable.
pub(crate) struct SourceFile {
  pub path: String,
  pub meta: std::fs::Metadata,
  pub bytes: Vec<u8>,
}

pub(crate) fn read_source(raw: &str) -> Result<SourceFile, String> {
  let path = draft::normalize_path(raw);
  if path.is_empty() {
    return Err("path_empty".into());
  }
  let file = Path::new(&path);
  let meta = std::fs::metadata(file).map_err(|e| format!("file_access:{e}"))?;
  if !meta.is_file() {
    return Err("file_not_file".into());
  }
  if meta.len() > MAX_FILE_BYTES {
    return Err(format!("file_too_large:{}", meta.len() / (1024 * 1024)));
  }
  let bytes = std::fs::read(file).map_err(|e| format!("file_read:{e}"))?;
  Ok(SourceFile { path, meta, bytes })
}

/// The leading bytes of a file — enough to recognize a container — without reading the rest.
///
/// Drafting and saving ask this of a file they are not otherwise going to read, and the
/// answer has to be cheap because drafting happens while the user types. `None` when there
/// is no file at that path, which for a save is a first write rather than an error.
fn read_head(raw: &str) -> Result<Option<Vec<u8>>, String> {
  let normalized = draft::normalize_path(raw);
  if normalized.is_empty() {
    return Err("path_empty".into());
  }
  let mut file = match std::fs::File::open(Path::new(&normalized)) {
    Ok(f) => f,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("file_read:{e}")),
  };
  let mut head = vec![0u8; crypto::HEADER_LEN];
  let read = file.read(&mut head).map_err(|e| format!("file_read:{e}"))?;
  head.truncate(read);
  Ok(Some(head))
}

/// How the draft of `path` may be written: as it stands, sealed under a cached key, or not
/// at all because the file is a container this session cannot open.
///
/// The disk decides, not a flag handed in by the caller. What a tab believes about its file
/// goes stale — encryption removed in another window, the file replaced underneath us — and
/// asking the disk each time is what keeps the two agreeing. It is self-correcting in both
/// directions: once the encryption goes, the next draft overwrites the sealed one with a
/// plain one at the same file name.
pub(crate) fn draft_key_for(
  app: &AppHandle,
  state: &UnlockStore,
  path: &str,
) -> Result<DraftKey, String> {
  let encrypted = read_head(path)?.is_some_and(|head| crypto::is_container(&head));
  if !encrypted {
    return Ok(DraftKey::Plain);
  }
  let idle = crate::unlock::idle_limit(app);
  Ok(match state.get(path, idle) {
    Some(key) => DraftKey::Sealed(key),
    // Not written at all. Sealing needs a key, and writing the text in the clear next to a
    // document the user encrypted is the one thing encryption was supposed to prevent.
    None => DraftKey::Locked,
  })
}

/// The `OpenedFile` of a container that has just been decrypted. Shared by the open path and
/// by `unlock_file` so the two cannot drift on what an unlocked document reports.
pub(crate) fn decrypted_file(source: SourceFile, content: String) -> OpenedFile {
  OpenedFile {
    path: source.path,
    content,
    mtime: mtime_ms(&source.meta),
    // The plaintext of a container is UTF-8 by definition. There is no encoding field in
    // the format: a file decrypted here was written by this editor.
    encoding: "UTF-8".into(),
    bom: false,
    // The ciphertext size, which is what a later save has to beat when it checks whether
    // somebody else wrote the file in between.
    bytes: source.meta.len(),
    binary: false,
    encrypted: true,
    locked: false,
  }
}

/// The `OpenedFile` of a container with no key behind it. Nothing was decrypted, so there is
/// no text and no encoding to report.
pub(crate) fn locked_file(source: SourceFile) -> OpenedFile {
  OpenedFile {
    path: source.path,
    content: String::new(),
    mtime: mtime_ms(&source.meta),
    encoding: String::new(),
    bom: false,
    bytes: source.meta.len(),
    binary: false,
    encrypted: true,
    locked: true,
  }
}

/// Open a container with whatever this session already has: a cached key, or a password the
/// user asked to be remembered.
///
/// A container nobody has unlocked opens *locked* instead of failing. The tab exists and
/// shows a lock, and the password is asked for when its contents are wanted, which is what
/// lets a session of encrypted files come back without a wall of dialogs first.
fn open_container(
  app: &AppHandle,
  state: &UnlockStore,
  source: SourceFile,
  record: Option<bool>,
) -> Result<OpenedFile, String> {
  let idle = crate::unlock::idle_limit(app);
  match state.decrypt_if_possible(&source.path, &source.bytes, idle) {
    Some(Ok(plaintext)) => {
      // Strict: a tag that verifies but yields invalid UTF-8 is a damaged file, and showing
      // the replacement characters would invite the user to save them over the original.
      let content = String::from_utf8(plaintext).map_err(|_| "encrypted_corrupt".to_string())?;
      if record.unwrap_or(true) {
        push_history_entry(app, &source.path)?;
      }
      Ok(decrypted_file(source, content))
    }
    Some(Err(e)) => Err(e),
    // No history entry for a locked open. The file was found, not opened; the entry is made
    // by `unlock_file`, at the moment it actually is.
    None => Ok(locked_file(source)),
  }
}

#[tauri::command]
pub fn open_file(
  app: AppHandle,
  state: State<'_, UnlockStore>,
  path: String,
  record: Option<bool>,
  encoding: Option<String>,
) -> Result<OpenedFile, String> {
  let source = read_source(&path)?;
  // Both encrypted checks come before any decoding. Ciphertext is not text in any encoding,
  // and a buffer decoded from it would be mojibake that must never be written back; a
  // foreign format gets named rather than shown as garbage.
  if crypto::looks_foreign(&source.bytes) {
    return Err("encrypted_foreign_format".into());
  }
  if crypto::is_container(&source.bytes) {
    return open_container(&app, &state, source, record);
  }
  let normalized = source.path;
  // A picture is not text: decoding one either fails outright (which used to make the file
  // unopenable) or succeeds into a mojibake buffer that must never be written back. It is
  // read for its metadata only, and the frontend renders it through the preview.
  let binary = is_binary_ext(&normalized);
  // A per-file encoding override wins over the global default, so a file that needs
  // GBK forced on it is honoured before we decode rather than after.
  let global = match encoding.filter(|e| !e.trim().is_empty()) {
    Some(choice) => choice,
    None => stored_encoding(&app),
  };
  let preference = crate::file_settings::encoding_for(&app, &normalized, &global);
  let decoded = if binary {
    None
  } else {
    Some(crate::encoding::decode(&source.bytes, &preference)?)
  };
  let mtime = mtime_ms(&source.meta);

  // Reopening a whole workspace is not "the user just opened these": recording it would
  // bury the files actually touched today under whatever was left open last session.
  if record.unwrap_or(true) {
    push_history_entry(&app, &normalized)?;
  }
  Ok(OpenedFile {
    path: normalized,
    content: decoded.as_ref().map(|d| d.text.clone()).unwrap_or_default(),
    mtime,
    encoding: decoded
      .as_ref()
      .map(|d| d.encoding.clone())
      .unwrap_or_default(),
    bom: decoded.as_ref().is_some_and(|d| d.bom),
    bytes: source.meta.len(),
    binary,
    encrypted: false,
    locked: false,
  })
}

/// Current mtime and size, for the check that asks whether another program wrote the file.
/// `None` when there is no such file any more.
///
/// Answering that by reading the file would make a background poll expensive, so this looks
/// at metadata only. Two very different things come out of it, and they are kept apart:
/// "there is no file there" is an answer the caller can act on, while a failure to *look* —
/// a share that is not answering, a permission that is not granted — is not, and is still an
/// error so the caller keeps what it already has rather than inventing a change.
#[tauri::command]
pub fn stat_file(path: String) -> Result<Option<FileStat>, String> {
  let normalized = draft::normalize_path(&path);
  if normalized.is_empty() {
    return Err("path_empty".into());
  }
  let file = Path::new(&normalized);
  let meta = match std::fs::metadata(file) {
    Ok(m) => m,
    // Deleted, moved, or never written: what the tab was built on is gone.
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
    Err(e) => return Err(format!("file_access:{e}")),
  };
  // Something else is there now — a folder, most likely — so there is no text to compare.
  if !meta.is_file() {
    return Ok(None);
  }
  Ok(Some(FileStat {
    path: normalized,
    mtime: mtime_ms(&meta),
    bytes: meta.len(),
  }))
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
pub(crate) fn stored_encoding(app: &AppHandle) -> String {
  settings_of(app).encoding
}

#[tauri::command]
pub fn save_file(
  app: AppHandle,
  state: State<'_, UnlockStore>,
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
  // Whether this save is encrypted is settled by the file on disk, not by anything the
  // caller says: writing ciphertext over a plain file, or plaintext over a container, would
  // both be silent damage. Only a container on disk keeps a file encrypted, which is also
  // what makes removing the encryption stick — the next save writes it plain.
  if read_head(&normalized)?.is_some_and(|head| crypto::is_container(&head)) {
    return save_container(&app, &state, &normalized, &content);
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
  let mtime = std::fs::metadata(file).map(|m| mtime_ms(&m)).unwrap_or(0);
  push_history_entry(&app, &normalized)?;
  Ok(SavedFile {
    path: normalized,
    mtime,
    encoding: crate::encoding::resolve(&target)?.name().to_string(),
    bytes: written.len() as u64,
  })
}

/// Re-encrypt and replace a container.
///
/// The write always goes through the temp file and rename. A plain text file cut short by a
/// crash can be salvaged by hand; a container cut short verifies to nothing and is simply
/// gone, so there is no trade to make here.
fn save_container(
  app: &AppHandle,
  state: &UnlockStore,
  normalized: &str,
  content: &str,
) -> Result<SavedFile, String> {
  let source = read_source(normalized)?;
  let idle = crate::unlock::idle_limit(app);
  let mut key = state
    .get(normalized, idle)
    .ok_or_else(|| "encrypted_locked".to_string())?;
  let written = encrypt_over(&source, &key, content);
  key.zeroize();
  // A key that will not open the file it is about to replace is no key at all: drop it so
  // the next attempt asks for the password instead of failing the same way again.
  if matches!(written, Err(ref e) if e == "encrypted_locked") {
    state.remove(normalized);
  }
  let written = written?;
  write_atomic(Path::new(normalized), &written)?;
  let mtime = std::fs::metadata(normalized)
    .map(|m| mtime_ms(&m))
    .unwrap_or(0);
  push_history_entry(app, normalized)?;
  Ok(SavedFile {
    path: normalized.to_string(),
    mtime,
    encoding: "UTF-8".into(),
    bytes: written.len() as u64,
  })
}

/// The ciphertext for `content` under a key that has to open `source` first.
///
/// Verifying is not redundant. Keys are cached per path, and a path can come to hold a
/// different document — replaced by another program, restored from a backup, re-encrypted
/// elsewhere. Writing a cached key into that document's header, whose salt the key was never
/// derived from, produces a file no password can open. Being asked to unlock again is
/// recoverable; that is not.
///
/// The salt and the cost parameters are the file's own, so a save changes neither what
/// password opens the document nor how long deriving it takes.
fn encrypt_over(
  source: &SourceFile,
  key: &[u8; KEY_LEN],
  content: &str,
) -> Result<Vec<u8>, String> {
  let header = crypto::parse_header(&source.bytes)?;
  crypto::decrypt(&source.bytes, key).map_err(|_| "encrypted_locked".to_string())?;
  let written = crypto::encrypt_under(content.as_bytes(), key, header.salt, header.params)?;
  // Checked on the ciphertext, which is what has to fit when the file is read back: the
  // header and the tag make it slightly bigger than the text that went in.
  if written.len() as u64 > MAX_FILE_BYTES {
    return Err(format!("file_too_large:{}", written.len() / (1024 * 1024)));
  }
  Ok(written)
}

/// Directories a document may never be able to read, however it spells the path.
/// Generated from the environment so the list follows the machine it runs on.
pub(crate) fn protected_roots() -> Vec<PathBuf> {
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
pub(crate) fn refused_by_scope(dir: &Path, protected: &[PathBuf]) -> bool {
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

/// Renders a diagram with a locally installed program, returning SVG.
///
/// The two supported tools are Graphviz and PlantUML, and they are invoked directly — no
/// shell, ever. `Command::new` does not interpret metacharacters, and the document text
/// reaches the program only as the *contents of a file*, never as an argument, so a diagram
/// containing quotes, semicolons or `$(...)` has nothing to escape into. The program name
/// comes from the literal table below rather than from `kind`, so the frontend cannot talk
/// this into running something else.
///
/// Neither tool is required. A missing program is reported as an error the preview shows
/// above the source, which is the whole of the contract: the document stays readable whether
/// or not the user has these installed.
#[tauri::command(async)]
pub fn render_diagram(kind: String, source: String) -> Result<String, String> {
  // `(program, input extension, args)`. Args are fixed strings except for the two paths,
  // which are generated here and never contain anything from `source`.
  let (program, input_ext, args): (&str, &str, &[&str]) = match kind.as_str() {
    "graphviz" => ("dot", "gv", &["-Tsvg"]),
    "plantuml" => ("plantuml", "puml", &["-tsvg", "-charset", "UTF-8"]),
    _ => return Err("diagram_kind_unknown".into()),
  };

  let stamp = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  let dir = std::env::temp_dir().join(format!("wrolp-diagram-{}-{stamp}", std::process::id()));
  std::fs::create_dir_all(&dir).map_err(|e| format!("diagram_temp:{e}"))?;
  // Every exit path below has to remove this, including the error ones.
  let result = run_diagram(program, input_ext, args, &source, &dir);
  let _ = std::fs::remove_dir_all(&dir);
  result
}

fn run_diagram(
  program: &str,
  input_ext: &str,
  args: &[&str],
  source: &str,
  dir: &Path,
) -> Result<String, String> {
  let input = dir.join(format!("in.{input_ext}"));
  let output = dir.join("out.svg");
  let errors = dir.join("err.txt");
  // UTF-8 with no BOM: PlantUML rejects a byte order mark outright.
  std::fs::write(&input, source.as_bytes()).map_err(|e| format!("diagram_write:{e}"))?;

  let mut command = std::process::Command::new(program);
  command.args(args).arg("-o").arg(&output).arg(&input);
  // Files rather than pipes: the tool writes the SVG itself, so there is no pipe buffer to
  // fill and deadlock on, and stderr goes to a file for the same reason.
  command
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::null())
    .stderr(std::process::Stdio::from(
      std::fs::File::create(&errors).map_err(|e| format!("diagram_stderr:{e}"))?,
    ));

  let mut child = command.spawn().map_err(|e| {
    if e.kind() == std::io::ErrorKind::NotFound {
      format!("diagram_missing:{program}")
    } else {
      format!("diagram_spawn:{e}")
    }
  })?;

  // Bounded without a crate: poll for the exit status until the deadline. PlantUML in
  // particular will sit there indefinitely on a diagram that never terminates.
  let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
  let status = loop {
    match child.try_wait() {
      Ok(Some(status)) => break status,
      Ok(None) if std::time::Instant::now() < deadline => {
        std::thread::sleep(std::time::Duration::from_millis(20));
      }
      Ok(None) => {
        let _ = child.kill();
        let _ = child.wait();
        return Err("diagram_timeout".into());
      }
      Err(e) => return Err(format!("diagram_wait:{e}")),
    }
  };

  let stderr = std::fs::read_to_string(&errors).unwrap_or_default();
  let stderr = stderr.trim();
  let svg = std::fs::read(&output).unwrap_or_default();
  let svg = String::from_utf8_lossy(&svg).into_owned();

  // PlantUML exits 0 on a syntax error and simply draws the error, so the exit code alone
  // would report success for a diagram that did not render.
  let looks_broken = svg.contains("syntax error") || svg.contains("Syntax Error");
  if !status.success() || looks_broken || svg.trim().is_empty() {
    let reason = if !stderr.is_empty() {
      stderr
    } else {
      "diagram_failed"
    };
    let trimmed: String = reason.chars().take(400).collect();
    return Err(if trimmed.is_empty() {
      format!("diagram_exit:{}", status.code().unwrap_or(-1))
    } else {
      trimmed.to_string()
    });
  }

  Ok(strip_xml_preamble(&svg))
}

/// Removes the XML declaration and doctype, which are meaningless once the SVG is embedded
/// in a document that has its own.
fn strip_xml_preamble(svg: &str) -> String {
  let mut rest = svg.trim_start();
  for _ in 0..2 {
    if rest.starts_with("<?xml") {
      match rest.find("?>") {
        Some(at) => rest = rest[at + 2..].trim_start(),
        None => break,
      }
    } else if rest.starts_with("<!DOCTYPE") {
      match rest.find('>') {
        Some(at) => rest = rest[at + 1..].trim_start(),
        None => break,
      }
    } else {
      break;
    }
  }
  rest.to_string()
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

/// The draft of `path`, or `None` when there is none to read.
///
/// A sealed draft of a locked file also answers `None`, and deliberately stays on disk: it
/// is not broken, only unreadable until the file is unlocked, and the edits in it come back
/// at that point.
#[tauri::command]
pub fn get_draft(
  app: AppHandle,
  state: State<'_, UnlockStore>,
  path: String,
) -> Result<Option<Draft>, String> {
  let key = draft_key_for(&app, &state, &path)?;
  draft::load(&app, &path, key)
}

/// Write the draft of `path`.
///
/// `Ok(None)` means nothing was written because the file is encrypted and locked. Drafting
/// runs in the background while the user types, so that is not reported as an error: a
/// dialog about something nobody asked for is noise, and saving the document itself fails
/// loudly, so no text is lost without the user being told.
#[tauri::command]
pub fn save_draft(
  app: AppHandle,
  state: State<'_, UnlockStore>,
  path: String,
  content: String,
  cursor: usize,
) -> Result<Option<Draft>, String> {
  let key = draft_key_for(&app, &state, &path)?;
  draft::save(&app, &path, &content, cursor, key)
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

pub(crate) fn push_history_entry(app: &AppHandle, path: &str) -> Result<(), String> {
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

/// A folder the Explorer has been pointed at, newest first within its group.
///
/// Separate from the file history in `history.json` because the two answer different
/// questions and are pruned differently: a file that has been closed is still a file, whereas
/// a folder on an unplugged drive is not a folder at all. Keeping them apart also means a
/// forward/back pair cannot evict a folder the Explorer is showing.
///
/// Kept in its own file rather than inside the group record because it is written on a best-
/// effort basis: pointing the Explorer somewhere must never fail, and it must not have to share
/// a write with the tabs it is not part of. Which folder the Explorer is *on* stays global.
#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FolderHistoryEntry {
  pub path: String,
  pub name: String,
  pub opened_at: String,
  /// Whether the folder still exists. Recorded rather than filtered on read, so a folder that
  /// comes back (a drive replugged, a sync folder finished catching up) un-greys itself
  /// instead of having been dropped from the list in the meantime.
  pub exists: bool,
}

/// The most folders kept for one group. Deeper than the file history's fifty because a folder
/// list is a menu of places to go, not a record of what was read, and a project tree rarely
/// lives under one parent.
const FOLDER_HISTORY_MAX: usize = 30;

/// One group's folders, newest first, keyed by group id.
type FolderBuckets = std::collections::BTreeMap<String, Vec<FolderHistoryEntry>>;

/// The bucket for folders opened while no group was on screen.
const FOLDER_BUCKET_NONE: &str = "";

/// `folder-history.json`, in both shapes it has had.
///
/// The list was one history shared by the whole app until each group got its own. `Shared` is
/// still read, so an upgrade does not blank a menu that had entries in it a moment ago.
#[derive(Deserialize)]
#[serde(untagged)]
enum FolderHistoryFile {
  Shared(Vec<FolderHistoryEntry>),
  Scoped(FolderBuckets),
}

/// The buckets on disk, plus the pre-scoping list while the file still holds one.
///
/// A file that cannot be read at all is an empty history rather than an error: the menu is a
/// shortcut, and the folders themselves are on disk regardless of this side file.
fn read_folder_buckets(app: &AppHandle) -> (FolderBuckets, Vec<FolderHistoryEntry>) {
  match read_json::<FolderHistoryFile>(app, "folder-history.json").unwrap_or_default() {
    Some(FolderHistoryFile::Scoped(buckets)) => (buckets, Vec::new()),
    Some(FolderHistoryFile::Shared(shared)) => (FolderBuckets::new(), shared),
    None => (FolderBuckets::new(), Vec::new()),
  }
}

/// The list belonging to `group`, taking over the shared one when this is the first group to
/// have anything recorded. Handing it to the group in use rather than copying it to every
/// group keeps the other groups' menus empty, which is what "each its own" means.
fn bucket_of<'a>(
  buckets: &'a mut FolderBuckets,
  shared: &mut Vec<FolderHistoryEntry>,
  group: &str,
) -> &'a mut Vec<FolderHistoryEntry> {
  let history = buckets.entry(group.to_string()).or_default();
  if history.is_empty() {
    history.append(shared);
  }
  history
}

/// Set `exists` from the disk rather than trusting the file, since a folder can be deleted
/// while the app is closed — the whole point of greying it out rather than dropping it.
fn mark_existing(history: &mut [FolderHistoryEntry]) {
  for entry in history {
    entry.exists = Path::new(&entry.path).is_dir();
  }
}

/// Forget a group's folders when the group itself is gone, so removing a group does not leave
/// its list sitting in the file forever. Read from the store on disk rather than from anything
/// the frontend sends, since this runs while writing a different file.
fn retain_live_groups(app: &AppHandle, buckets: &mut FolderBuckets) {
  let Ok(Some(store)) = read_json::<GroupStore>(app, GROUPS_FILE) else {
    return;
  };
  buckets.retain(|group, _| {
    group == FOLDER_BUCKET_NONE || store.items.iter().any(|item| item.id == *group)
  });
}

#[tauri::command]
pub fn get_folder_history(
  app: AppHandle,
  group: String,
) -> Result<Vec<FolderHistoryEntry>, String> {
  let (mut buckets, shared) = read_folder_buckets(&app);
  // A group with no bucket of its own reads as the shared list for as long as the file has not
  // been scoped, which is exactly what the menu was before this was per group. The first
  // folder recorded converts the file, and from then on an empty bucket is really empty.
  let mut history = buckets.remove(&group).unwrap_or_default();
  if history.is_empty() {
    history = shared;
  }
  mark_existing(&mut history);
  Ok(history)
}

/// Note that the Explorer of group `group` moved to `dir`.
///
/// Best-effort: a history that cannot be written must not stop the folder from opening, so
/// the error is dropped. Nothing in the UI depends on the write having happened, and a toast
/// about a side file would be worse than a folder missing from the menu.
#[tauri::command]
pub fn record_folder_history(app: AppHandle, group: String, dir: String) {
  push_folder_history(&app, &group, &dir);
}

pub(crate) fn push_folder_history(app: &AppHandle, group: &str, dir: &str) {
  let (mut buckets, mut shared) = read_folder_buckets(app);
  let normalized = draft::normalize_path(dir);
  let history = bucket_of(&mut buckets, &mut shared, group);
  // Compared normalized: the same folder reached as `C:\a` and `C:\a\` is one entry, not two
  // that trade places on every visit.
  history.retain(|h| draft::normalize_path(&h.path) != normalized);
  // A drive root has no file name of its own, so `file_name` answers None and the path is its
  // own label — the same fallback the file history uses.
  let name = Path::new(&normalized)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_else(|| normalized.clone());
  history.insert(
    0,
    FolderHistoryEntry {
      path: normalized,
      name,
      opened_at: chrono::Utc::now().to_rfc3339(),
      exists: true,
    },
  );
  history.truncate(FOLDER_HISTORY_MAX);
  retain_live_groups(app, &mut buckets);
  let _ = write_json(app, "folder-history.json", &buckets);
}

#[tauri::command]
pub fn remove_folder_history(
  app: AppHandle,
  group: String,
  path: String,
) -> Result<Vec<FolderHistoryEntry>, String> {
  let target = draft::normalize_path(&path);
  let (mut buckets, mut shared) = read_folder_buckets(&app);
  let history = bucket_of(&mut buckets, &mut shared, &group);
  history.retain(|h| draft::normalize_path(&h.path) != target);
  let mut out = history.clone();
  retain_live_groups(&app, &mut buckets);
  write_json(&app, "folder-history.json", &buckets)?;
  mark_existing(&mut out);
  Ok(out)
}

/// The settings every reader shares, including the commands that run before the frontend asks.
///
/// A settings file that cannot be parsed is still an error here: the editor must not silently
/// start with defaults and then save them back over whatever the user had. The backup path
/// tolerates it separately, because a broken file is exactly when a snapshot is worth taking.
pub(crate) fn load_settings(app: &AppHandle) -> Result<Settings, String> {
  Ok(
    read_json::<Settings>(app, "settings.json")?
      .unwrap_or_default()
      .filled(),
  )
}

#[tauri::command]
pub fn get_settings(app: AppHandle) -> Result<Settings, String> {
  load_settings(&app)
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: Settings) -> Result<Settings, String> {
  let settings = settings.filled();
  write_json(&app, "settings.json", &settings)?;
  Ok(settings)
}

/// The folders the user's own work lives in, one line each in Settings → About.
///
/// Asked for rather than assembled in the frontend: `wrolp_dir` is what decides where these
/// are, and a layout spelled out twice is a layout that can be wrong twice.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDirs {
  /// Settings, groups, history, window placement and the per-file overrides.
  pub state: String,
  /// The unsaved text of every file that has any.
  pub drafts: String,
  /// The version history, which only exists once something has been recorded.
  pub versions: String,
  /// Whether that last folder is there to open. Created on the first recorded save rather than on
  /// startup, so a build with versioning off leaves no trace — and a button that opens a folder
  /// which does not exist is a dead button.
  pub versions_present: bool,
}

#[tauri::command]
pub fn get_store_dirs(app: AppHandle) -> Result<StoreDirs, String> {
  let versions = crate::versioning::base_dir(&app)?;
  let versions_present = versions.exists();
  Ok(StoreDirs {
    state: draft::store_dir(&app)?.to_string_lossy().into_owned(),
    drafts: draft::drafts_dir(&app)?.to_string_lossy().into_owned(),
    versions: versions.to_string_lossy().into_owned(),
    versions_present,
  })
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

/// The rectangle the window was last left in, or `None` on a first run.
#[tauri::command]
pub fn get_window_state(app: AppHandle) -> Result<Option<WindowState>, String> {
  read_json::<WindowState>(&app, WINDOW_FILE)
}

#[tauri::command]
pub fn save_window_state(app: AppHandle, state: WindowState) -> Result<WindowState, String> {
  write_json(&app, WINDOW_FILE, &state)?;
  Ok(state)
}

/// Decide what to apply given the monitors that exist right now. The geometry judgement
/// lives here (and in `window.rs`) so the fallback rules are unit-tested rather than
/// re-implemented in the page.
#[tauri::command]
pub fn plan_window_placement(
  state: WindowState,
  monitors: Vec<MonitorRect>,
) -> Result<Placement, String> {
  Ok(state.plan(&monitors))
}

/// The verb covers every file, so these lists are about the exclusion masks and about
/// cleaning up what earlier builds wrote. The frontend owns both: the extensions are the
/// types it recognizes, the exclusions are the user's setting.
#[tauri::command]
pub fn context_menu_target(
  extensions: Vec<String>,
) -> Result<crate::context_menu::MenuTarget, String> {
  crate::context_menu::probe(&extensions)
}

#[tauri::command]
pub fn install_context_menu(
  extensions: Vec<String>,
  excluded: Vec<String>,
) -> Result<String, String> {
  crate::context_menu::install(&extensions, &excluded)
}

#[tauri::command]
pub fn uninstall_context_menu(extensions: Vec<String>) -> Result<(), String> {
  crate::context_menu::uninstall(&extensions)
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

  /// A folder read as missing is greyed out rather than dropped, so the same folder reached
  /// by two spellings must not show up twice.
  #[test]
  fn folder_history_dedupes_on_normalized_path() {
    let mut history = vec![FolderHistoryEntry {
      path: r"C:\a".into(),
      name: "a".into(),
      opened_at: "old".into(),
      exists: true,
    }];
    let target = draft::normalize_path(r"C:\a");
    history.retain(|h| draft::normalize_path(&h.path) != target);
    assert!(
      history.is_empty(),
      "the trailing separator is the same folder"
    );
  }

  /// The list is a menu of places, so it stays short enough to scan.
  #[test]
  fn folder_history_is_bounded() {
    let mut history: Vec<FolderHistoryEntry> = (0..FOLDER_HISTORY_MAX + 10)
      .map(|i| FolderHistoryEntry {
        path: format!(r"C:\d{i}"),
        name: format!("d{i}"),
        opened_at: "now".into(),
        exists: true,
      })
      .collect();
    history.truncate(FOLDER_HISTORY_MAX);
    assert_eq!(history.len(), FOLDER_HISTORY_MAX);
    // Truncation drops the oldest end, which is the far end of the list.
    assert_eq!(history[0].path, r"C:\d0");
  }

  /// A file history written before folders were recorded must still parse, and a folder
  /// entry that lost its `exists` flag (written by the first build) reads as missing rather
  /// than being offered as somewhere to go.
  #[test]
  fn folder_history_reads_an_older_file() {
    let legacy = r#"[{"path":"C:\\a","name":"a","opened_at":"then"}]"#;
    let parsed: Vec<FolderHistoryEntry> = serde_json::from_str(legacy).expect("legacy parses");
    assert_eq!(parsed.len(), 1);
    assert_eq!(parsed[0].path, r"C:\a");
    assert!(
      !parsed[0].exists,
      "a missing flag means unknown, which greys the row"
    );
  }

  /// The two file shapes are told apart by their own JSON: an array was the whole app's list,
  /// an object is one list per group. Reading the wrong one as empty would blank a menu.
  #[test]
  fn folder_history_reads_both_file_shapes() {
    let scoped = r#"{"grp-1":[{"path":"C:\\a","name":"a","openedAt":"then","exists":true}]}"#;
    match serde_json::from_str::<FolderHistoryFile>(scoped).expect("scoped parses") {
      FolderHistoryFile::Scoped(buckets) => assert_eq!(buckets["grp-1"].len(), 1),
      FolderHistoryFile::Shared(_) => panic!("an object is not the shared shape"),
    }
    let shared = r#"[{"path":"C:\\a","name":"a","openedAt":"then","exists":true}]"#;
    match serde_json::from_str::<FolderHistoryFile>(shared).expect("shared parses") {
      FolderHistoryFile::Shared(history) => assert_eq!(history.len(), 1),
      FolderHistoryFile::Scoped(_) => panic!("an array is not the scoped shape"),
    }
  }

  fn folder(path: &str, name: &str) -> FolderHistoryEntry {
    FolderHistoryEntry {
      path: path.into(),
      name: name.into(),
      opened_at: "then".into(),
      exists: true,
    }
  }

  /// The old shared list is handed to the first group that records a folder, and to nobody
  /// else: an upgrade keeps the menu the user was reading without every new group inheriting it.
  #[test]
  fn folder_history_adopts_the_shared_list_once() {
    let mut shared = vec![folder(r"C:\a", "a")];
    let mut buckets = FolderBuckets::new();

    let first = bucket_of(&mut buckets, &mut shared, "grp-1");
    first.insert(0, folder(r"C:\b", "b"));
    assert!(shared.is_empty(), "the list moves rather than being copied");

    let second = bucket_of(&mut buckets, &mut shared, "grp-2");
    assert!(
      second.is_empty(),
      "a group that has not been anywhere shows nothing"
    );
    assert_eq!(
      buckets["grp-1"]
        .iter()
        .map(|e| e.path.as_str())
        .collect::<Vec<_>>(),
      vec![r"C:\b", r"C:\a"],
      "the newest folder leads, and the adopted one follows it"
    );
  }

  /// A group that already has its own list must not have the shared one appended to it, which
  /// is what keeps a folder the user removed from coming back on the next visit.
  #[test]
  fn folder_history_does_not_refill_a_group_that_has_its_own() {
    let mut shared = vec![folder(r"C:\gone", "gone")];
    let mut buckets = FolderBuckets::new();
    buckets.insert("grp-1".into(), vec![folder(r"C:\keep", "keep")]);
    let history = bucket_of(&mut buckets, &mut shared, "grp-1");
    assert_eq!(history.len(), 1);
    assert_eq!(history[0].path, r"C:\keep");
    assert_eq!(shared.len(), 1, "someone else can still claim it");
  }

  /// Pictures are read for their metadata only. SVG counts as text on purpose: it is edited
  /// as source, and it is the one image the editor can legitimately show both ways.
  #[test]
  fn only_raster_images_are_treated_as_binary() {
    for name in [
      r"C:\pics\no-extension",
      r"C:\pics\a.svg",
      r"C:\pics\a.md",
      r"C:\pics\a.txt",
    ] {
      assert!(!is_binary_ext(name), "{name} should be read as text");
    }
    // The extension decides, not the case of it: a PNG from a camera is still a PNG.
    for name in [
      r"C:\pics\a.png",
      r"C:\pics\a.JPEG",
      r"C:\pics\a.webp",
      r"C:\pics\a.PNG",
      r"C:\pics\a.gif",
    ] {
      assert!(is_binary_ext(name), "{name} should be treated as a picture");
    }
  }

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

  /// Every layout toggle writes this map into settings.json, which makes it state a hand edit
  /// can reach: a mode this build does not know, or an entry with no path, is dropped while
  /// real choices survive.
  #[test]
  fn per_file_preview_modes_keep_only_real_choices() {
    let filled = Settings {
      preview_modes: HashMap::from([
        (r"C:\a.md".into(), "split".into()),
        (r"C:\b.md".into(), "sideways".into()),
        ("".into(), "preview".into()),
      ]),
      ..Default::default()
    }
    .filled();
    assert_eq!(filled.preview_modes.len(), 1);
    assert_eq!(
      filled.preview_modes.get(r"C:\a.md").map(String::as_str),
      Some("split")
    );
  }

  /// Backups go beside the state folder unless another one was chosen, and the count is bounded
  /// so a daily snapshot cannot fill a drive. A zero is a mis-click, not a wish to keep none.
  #[test]
  fn backups_default_beside_the_state_and_keep_a_bounded_history() {
    let s = Settings::default();
    assert!(s.backup_dir.is_empty());
    assert_eq!(s.backup_retain, crate::backup::DEFAULT_RETAIN);
    let filled = Settings {
      backup_dir: "   ".into(),
      backup_retain: 0,
      ..Default::default()
    }
    .filled();
    assert_eq!(filled.backup_dir, "");
    assert_eq!(filled.backup_retain, crate::backup::DEFAULT_RETAIN);
    let filled = Settings {
      backup_dir: " D:\\backups ".into(),
      backup_retain: 9_999,
      ..Default::default()
    }
    .filled();
    assert_eq!(filled.backup_dir, "D:\\backups");
    assert_eq!(filled.backup_retain, crate::backup::MAX_RETAIN);
  }

  /// Versioning writes on every hand save and does not clean up afterwards, so a first run must
  /// not have it on — and the two numbers that bound what it costs have to be the ones the README
  /// tells people.
  #[test]
  fn versioning_starts_off_and_its_two_numbers_are_bounded() {
    let s = Settings::default();
    assert!(!s.versioning_enabled);
    assert_eq!(s.versioning_show_limit, 30);
    assert_eq!(s.versioning_max_file_size, 524_288);
    // A zero in either would ask for a list that is always empty or a store that refuses every
    // file, so a zero is read as a mis-click rather than as an intention.
    let filled = Settings {
      versioning_enabled: true,
      versioning_show_limit: 0,
      versioning_max_file_size: 0,
      ..Default::default()
    }
    .filled();
    assert!(filled.versioning_enabled);
    assert_eq!(filled.versioning_show_limit, 30);
    assert_eq!(filled.versioning_max_file_size, 524_288);
    let filled = Settings {
      versioning_show_limit: 9_999,
      versioning_max_file_size: 9_999_999_999,
      ..Default::default()
    }
    .filled();
    assert_eq!(filled.versioning_show_limit, 500);
    assert_eq!(filled.versioning_max_file_size, 33_554_432);
    // The automatic save is a second source of writes over the same setting, and it defaults off
    // too: turning on versioning must not silently mean every timer sweep adds a row.
    assert!(!s.auto_save_versions);
    let filled = Settings {
      auto_save: true,
      versioning_enabled: true,
      auto_save_versions: true,
      ..Default::default()
    }
    .filled();
    assert!(filled.auto_save_versions);
    // Being asked for a word on every hand save is the most intrusive thing versioning can do, so
    // it is its own switch and defaults off whoever has versioning on.
    assert!(!s.ask_note_on_save);
    let filled = Settings {
      versioning_enabled: true,
      ask_note_on_save: true,
      ..Default::default()
    }
    .filled();
    assert!(filled.ask_note_on_save);
  }

  /// The idle lock is the one setting where 0 is a choice rather than a missing value:
  /// it means the user asked for keys to stay in memory. Treating it as unset would
  /// silently re-enable locking, so the distinction is pinned here.
  #[test]
  fn encrypt_idle_minutes_keeps_zero_and_clamps_only_the_top() {
    assert_eq!(Settings::default().encrypt_idle_minutes, 10);
    assert_eq!(
      Settings {
        encrypt_idle_minutes: 0,
        ..Default::default()
      }
      .filled()
      .encrypt_idle_minutes,
      0
    );
    assert_eq!(
      Settings {
        encrypt_idle_minutes: 100_000,
        ..Default::default()
      }
      .filled()
      .encrypt_idle_minutes,
      1440
    );
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
  fn theme_defaults_to_system_and_an_unknown_value_falls_back() {
    assert_eq!(Settings::default().theme, "system");
    // A settings.json written before the key existed must not come back dark or light: the
    // container-level `#[serde(default)]` fills it from the same Default.
    let s: Settings = serde_json::from_str("{\"fontSize\":16.0}").expect("parse partial settings");
    assert_eq!(s.filled().theme, "system");
    for good in ["system", "dark", "light"] {
      assert_eq!(
        Settings {
          theme: good.into(),
          ..Default::default()
        }
        .filled()
        .theme,
        good
      );
    }
    // Hand-edited values must not leave the frontend without a palette to apply.
    assert_eq!(
      Settings {
        theme: "solarized".into(),
        ..Default::default()
      }
      .filled()
      .theme,
      "system"
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
  fn sidebar_font_is_clamped_to_the_readable_range() {
    assert_eq!(
      Settings {
        sidebar_font: 0.0,
        ..Default::default()
      }
      .filled()
      .sidebar_font,
      12.0
    );
    assert_eq!(
      Settings {
        sidebar_font: 6.0,
        ..Default::default()
      }
      .filled()
      .sidebar_font,
      11.0
    );
    assert_eq!(
      Settings {
        sidebar_font: 40.0,
        ..Default::default()
      }
      .filled()
      .sidebar_font,
      20.0
    );
    assert_eq!(
      Settings {
        sidebar_font: 13.0,
        ..Default::default()
      }
      .filled()
      .sidebar_font,
      13.0
    );
  }

  #[test]
  fn auto_save_interval_is_bounded_and_off_is_the_default() {
    assert!(!Settings::default().auto_save);
    // 0 would be a sweep every tick of the timer, which is what a typo looks like, not a plan.
    assert_eq!(
      Settings {
        auto_save_interval: 0,
        ..Default::default()
      }
      .filled()
      .auto_save_interval,
      1
    );
    assert_eq!(
      Settings {
        auto_save_interval: 999_999,
        ..Default::default()
      }
      .filled()
      .auto_save_interval,
      3600
    );
    assert_eq!(
      Settings {
        auto_save: true,
        auto_save_interval: 30,
        ..Default::default()
      }
      .filled()
      .auto_save_interval,
      30
    );
  }

  #[test]
  fn settings_defaults_are_applied() {
    let s = Settings {
      font_size: 0.0,
      sidebar_view: String::new(),
      draft_restore: "sometimes".into(),
      ..Default::default()
    }
    .filled();
    assert_eq!(s.font_size, 14.0);
    assert_eq!(s.sidebar_view, "explorer");
    // A draft mode nobody offered is a hand-edited key, and the safer half of the mistake
    // is to load the draft rather than to risk a dialog that gets dismissed by reflex.
    assert_eq!(s.draft_restore, "auto");
    // A line ending the save path cannot write falls back to the one a new buffer starts on.
    assert_eq!(
      Settings {
        line_ending: "martian".into(),
        ..Default::default()
      }
      .filled()
      .line_ending,
      "lf"
    );
    assert_eq!(
      Settings {
        line_ending: "CRLF".into(),
        ..Default::default()
      }
      .filled()
      .line_ending,
      "crlf"
    );
    assert_eq!(
      Settings {
        draft_restore: "ask".into(),
        ..Default::default()
      }
      .filled()
      .draft_restore,
      "ask"
    );
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
    // Same for a file written before the draft prompt became a choice: drafts load quietly.
    assert_eq!(s.draft_restore, "auto");
    // And for one written before line endings could be configured at all.
    assert_eq!(s.line_ending, "lf");
    // The sidebar text of an existing install keeps the 12 px the tree was pinned at.
    assert_eq!(s.sidebar_font, 12.0);
    // And a file it saves keeps the whitespace it was written with until somebody asks otherwise.
    assert!(!s.trim_trailing_whitespace);
    assert!(!s.insert_final_newline);
    // Nothing writes to disk on its own in an install that predates the setting.
    assert!(!s.auto_save);
    let filled = s.filled();
    assert_eq!(filled.sidebar_root, "");
    // And the interval it never had is the one a fresh build starts with.
    assert_eq!(filled.auto_save_interval, 5);
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

  /// Drafting and saving both ask whether a file is a container, and drafting happens while
  /// the user types, so the answer must not cost a read of the whole document.
  #[test]
  fn the_head_of_a_file_is_enough_to_recognize_a_container() {
    let dir = scratch_dir("read-head");
    let file = dir.join("secret.wrolpenc");
    let mut bytes = crypto::MAGIC.to_vec();
    bytes.extend_from_slice(&[7u8; 4096]);
    std::fs::write(&file, &bytes).expect("write");

    let head = read_head(&file.to_string_lossy())
      .expect("read")
      .expect("a file that is there");
    assert!(crypto::is_container(&head));
    assert_eq!(head.len(), crypto::HEADER_LEN);

    // No file at all is a first save rather than an error.
    let missing = dir.join("missing.wrolpenc");
    assert!(read_head(&missing.to_string_lossy())
      .expect("read")
      .is_none());

    // A short file is reported as itself, not padded into something it is not.
    let short = dir.join("short.txt");
    std::fs::write(&short, b"hi").expect("write");
    assert_eq!(
      read_head(&short.to_string_lossy())
        .expect("read")
        .expect("some"),
      b"hi"
    );
    assert!(!crypto::is_container(b"hi"));
    std::fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn an_unknown_diagram_kind_never_reaches_a_process() {
    // The program name is chosen from a literal table, so anything else has to be refused
    // before a temporary directory is even made.
    for kind in ["", "sh", "dot; rm -rf /", "C:\\Windows\\System32\\cmd.exe"] {
      assert_eq!(
        render_diagram(kind.to_string(), "digraph{a}".to_string()),
        Err("diagram_kind_unknown".to_string())
      );
    }
  }

  #[test]
  fn a_missing_diagram_program_is_reported_not_panicked() {
    // Nothing here can rely on what is installed, so this asks for a program that cannot
    // exist and checks the failure is a value rather than a panic.
    let err = run_diagram(
      "wrolp-no-such-diagram-program",
      "gv",
      &["-Tsvg"],
      "digraph{a}",
      &std::env::temp_dir(),
    );
    let reason = err.expect_err("a missing program must fail");
    assert!(
      reason.starts_with("diagram_missing:")
        || reason.starts_with("diagram_spawn:")
        || reason.starts_with("diagram_write:"),
      "unexpected reason: {reason}"
    );
  }

  #[test]
  fn the_xml_preamble_is_stripped_and_the_root_svg_is_kept() {
    let svg = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE svg PUBLIC \"-//W3C//DTD SVG 1.1//EN\" \"x.dtd\">\n<svg><g/></svg>";
    assert_eq!(strip_xml_preamble(svg), "<svg><g/></svg>");
    // A document that is only a preamble has nothing to show, which the caller treats as a
    // failure; stripping must not invent content.
    assert_eq!(strip_xml_preamble("<?xml version=\"1.0\"?>"), "");
    // Nothing to strip means nothing is touched.
    assert_eq!(strip_xml_preamble("<svg/>"), "<svg/>");
  }

  #[test]
  fn rendering_a_diagram_leaves_no_temporary_directory_behind() {
    let before = temp_diagram_dirs();
    let _ = render_diagram("graphviz".to_string(), "digraph{a}".to_string());
    // Success or failure, the scratch directory is gone either way.
    assert_eq!(temp_diagram_dirs(), before);
  }

  #[test]
  fn graphviz_renders_and_a_syntax_error_is_reported() {
    // Only meaningful where graphviz is installed; elsewhere the missing program is itself
    // the thing to assert, so both outcomes are checked rather than one being assumed.
    match render_diagram("graphviz".to_string(), "digraph{a}".to_string()) {
      Ok(svg) => {
        assert!(
          svg.contains("<svg"),
          "expected an svg element, got: {}",
          &svg[..svg.len().min(120)]
        );
        // The preamble is stripped so the drawing can be embedded directly.
        assert!(!svg.contains("<?xml"), "xml declaration should be gone");
        assert!(!svg.contains("<!DOCTYPE"), "doctype should be gone");
      }
      Err(reason) => assert!(
        reason.starts_with("diagram_missing:"),
        "graphviz should either render or be absent, not fail: {reason}"
      ),
    }
    // Broken source must never come back as a drawing, whichever tool produced it.
    if let Ok(svg) = render_diagram(
      "graphviz".to_string(),
      "this is not dot source!!".to_string(),
    ) {
      assert!(
        svg.contains("syntax error"),
        "a broken diagram drew something: {svg}"
      );
    }
  }

  fn temp_diagram_dirs() -> usize {
    std::fs::read_dir(std::env::temp_dir())
      .map(|entries| {
        entries
          .filter_map(|e| e.ok())
          .filter(|e| {
            e.file_name()
              .to_string_lossy()
              .starts_with("wrolp-diagram-")
          })
          .count()
      })
      .unwrap_or(0)
  }
}
