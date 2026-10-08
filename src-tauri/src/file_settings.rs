//! Per-file overrides for the editor view settings and the encoding preference.
//!
//! The values in `settings.json` are the defaults that apply to every file. A file may
//! override any of them, which matters in two real cases: a file that is *almost*
//! UTF-8 and needs GBK forced on it, and a user who wants word wrap everywhere except
//! in one enormous log file.
//!
//! Keyed by the same normalized path as drafts and the version store, so one path means
//! one thing across every feature.

use crate::encoding;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::AppHandle;

const FILE: &str = "file-settings.json";
/// Bounded like `history.json` (50) and the group store: a forgotten entry must not
/// grow without limit.
const MAX_FILES: usize = 200;
const WHITESPACE: [&str; 5] = ["none", "boundary", "selection", "all", "trailing"];

/// The overrides for one file. `None` means "follow the global default".
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", default)]
pub struct FileSettings {
  #[serde(skip_serializing_if = "Option::is_none")]
  pub render_whitespace: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub word_wrap: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub sticky_scroll: Option<bool>,
  /// Minimap is per file: it helps in code and only wastes space in a log.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub minimap: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub tab_size: Option<u32>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub insert_spaces: Option<bool>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub detect_indentation: Option<bool>,
  /// Overrides the decode preference. The encoding actually used is still reported
  /// back per tab, so a save always writes back what the file was read in.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub encoding: Option<String>,
}

impl FileSettings {
  /// True when nothing is overridden, so the entry can be dropped entirely.
  pub fn is_empty(&self) -> bool {
    self.render_whitespace.is_none()
      && self.word_wrap.is_none()
      && self.sticky_scroll.is_none()
      && self.minimap.is_none()
      && self.tab_size.is_none()
      && self.insert_spaces.is_none()
      && self.detect_indentation.is_none()
      && self.encoding.is_none()
  }

  /// Drop values the editor would not accept. A stale or hand-edited file must not be
  /// able to put a bad whitespace mode or an unknown encoding into the frontend.
  pub fn cleaned(self) -> Self {
    Self {
      render_whitespace: self
        .render_whitespace
        .filter(|v| WHITESPACE.contains(&v.as_str())),
      word_wrap: self.word_wrap,
      sticky_scroll: self.sticky_scroll,
      minimap: self.minimap,
      // 0 or a wildly large value would fight the editor, so bound it the same way
      // the global setting is bounded.
      tab_size: self.tab_size.filter(|n| (1..=8).contains(n)),
      insert_spaces: self.insert_spaces,
      detect_indentation: self.detect_indentation,
      encoding: self.encoding.filter(|v| encoding::is_known(v)),
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FileSettingsStore {
  pub version: u32,
  pub items: BTreeMap<String, FileSettings>,
}

impl FileSettingsStore {
  /// Normalize every key, drop empty entries, and cap the map.
  fn filled(mut self) -> Self {
    self.version = 1;
    let items = std::mem::take(&mut self.items);
    self.items = items
      .into_iter()
      .map(|(path, settings)| (crate::draft::normalize_path(&path), settings.cleaned()))
      .filter(|(path, settings)| !path.is_empty() && !settings.is_empty())
      .collect();
    if self.items.len() > MAX_FILES {
      // BTreeMap iterates in key order, so the tail is the alphabetically last paths.
      // Keeping those is arbitrary but deterministic, which is all a cap needs.
      let skip = self.items.len() - MAX_FILES;
      self.items = self.items.into_iter().skip(skip).collect();
    }
    self
  }

  pub fn get(&self, raw: &str) -> FileSettings {
    let key = crate::draft::normalize_path(raw);
    self.items.get(&key).cloned().unwrap_or_default()
  }
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  Ok(crate::draft::store_dir(app)?.join(FILE))
}

pub fn load_store(app: &AppHandle) -> Result<FileSettingsStore, String> {
  let path = store_path(app)?;
  match std::fs::read(&path) {
    Ok(bytes) => serde_json::from_slice::<FileSettingsStore>(&bytes)
      .map(|s| s.filled())
      // A broken store must not block opening files: drop it and start clean.
      .map_err(|e| format!("state_parse:{FILE}: {e}")),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileSettingsStore {
      version: 1,
      items: BTreeMap::new(),
    }),
    Err(e) => Err(format!("state_read:{FILE}: {e}")),
  }
}

fn write_store(app: &AppHandle, store: &FileSettingsStore) -> Result<(), String> {
  let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
  crate::commands::write_atomic(&store_path(app)?, &json)
    .map_err(|e| format!("state_write:{FILE}: {e}"))
}

pub fn get(app: &AppHandle, path: &str) -> Result<FileSettings, String> {
  Ok(load_store(app)?.get(path))
}

/// Replace the overrides for one file. An all-default entry is removed rather than
/// stored, so "reset to global" is the same as never having overridden it.
pub fn save(app: &AppHandle, path: &str, settings: FileSettings) -> Result<FileSettings, String> {
  let mut store = load_store(app)?;
  let key = crate::draft::normalize_path(path);
  if key.is_empty() {
    return Err("path_empty".into());
  }
  let cleaned = settings.cleaned();
  if cleaned.is_empty() {
    store.items.remove(&key);
  } else {
    store.items.insert(key, cleaned.clone());
  }
  let store = store.filled();
  write_store(app, &store)?;
  Ok(cleaned)
}

pub fn clear(app: &AppHandle, path: &str) -> Result<(), String> {
  save(app, path, FileSettings::default()).map(|_| ())
}

/// Re-home the overrides of `old` and of everything inside it after a rename moved them.
///
/// The keys are normalized paths, so a folder rename carries the overrides of its whole
/// subtree along rather than stranding them on a path that no longer exists.
pub fn rekey_prefix(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let mut store = load_store(app)?;
  let items = std::mem::take(&mut store.items);
  store.items = items
    .into_iter()
    .map(|(path, settings)| (crate::rename::rekey(&path, old, new), settings))
    .collect();
  write_store(app, &store)
}

/// The encoding preference for one file: its override first, then the global setting.
/// Called from `open_file` so a forced encoding is honoured before decoding.
pub fn encoding_for(app: &AppHandle, path: &str, fallback: &str) -> String {
  load_store(app)
    .ok()
    .and_then(|store| store.get(path).encoding)
    .unwrap_or_else(|| fallback.to_string())
}

/// Everything the per-file panel needs: the global defaults plus this file's overrides.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSettingsView {
  pub defaults: FileSettings,
  pub overrides: FileSettings,
  /// `(value, i18n key suffix)`, so the menu cannot drift from what decode accepts.
  pub encodings: Vec<(String, String)>,
  pub whitespace: Vec<String>,
}

#[tauri::command]
pub fn file_settings_view(app: AppHandle, path: String) -> Result<FileSettingsView, String> {
  // Read settings.json once: it is a full parse and this is a panel opening.
  let settings = crate::commands::settings_of(&app).filled();
  let defaults = FileSettings {
    render_whitespace: Some(settings.render_whitespace),
    word_wrap: Some(settings.word_wrap),
    sticky_scroll: Some(settings.sticky_scroll),
    minimap: Some(settings.minimap),
    tab_size: Some(settings.tab_size),
    insert_spaces: Some(settings.insert_spaces),
    detect_indentation: Some(settings.detect_indentation),
    encoding: Some(settings.encoding),
  };
  Ok(FileSettingsView {
    overrides: load_store(&app)?.get(&path),
    encodings: encoding::CHOICES
      .iter()
      .map(|(value, key)| (value.to_string(), key.to_string()))
      .collect(),
    whitespace: WHITESPACE.iter().map(|s| s.to_string()).collect(),
    defaults,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn store(pairs: &[(&str, FileSettings)]) -> FileSettingsStore {
    FileSettingsStore {
      version: 1,
      items: pairs
        .iter()
        .map(|(p, s)| (p.to_string(), s.clone()))
        .collect(),
    }
  }

  #[test]
  fn an_all_default_entry_is_dropped() {
    let s = store(&[("c:\\a.txt", FileSettings::default())]).filled();
    assert!(s.items.is_empty());
  }

  /// Every field has to appear in `is_empty`. A field added to the struct but forgotten
  /// there makes a file that sets only that field look empty, and the entry is dropped.
  #[test]
  fn a_single_field_is_enough_to_keep_the_entry() {
    for (field, settings) in [
      (
        "minimap",
        FileSettings {
          minimap: Some(false),
          ..Default::default()
        },
      ),
      (
        "tab_size",
        FileSettings {
          tab_size: Some(4),
          ..Default::default()
        },
      ),
      (
        "insert_spaces",
        FileSettings {
          insert_spaces: Some(false),
          ..Default::default()
        },
      ),
      (
        "sticky_scroll",
        FileSettings {
          sticky_scroll: Some(true),
          ..Default::default()
        },
      ),
      (
        "word_wrap",
        FileSettings {
          word_wrap: Some(true),
          ..Default::default()
        },
      ),
      (
        "detect_indentation",
        FileSettings {
          detect_indentation: Some(false),
          ..Default::default()
        },
      ),
    ] {
      assert!(!settings.is_empty(), "{field} missing from is_empty");
      let s = store(&[("c:\\a.txt", settings)]).filled();
      assert!(!s.items.is_empty(), "{field}-only entry was dropped");
    }
  }

  #[test]
  fn an_out_of_range_tab_size_is_dropped() {
    let s = store(&[
      (
        "c:\\zero.txt",
        FileSettings {
          tab_size: Some(0),
          ..Default::default()
        },
      ),
      (
        "c:\\big.txt",
        FileSettings {
          tab_size: Some(99),
          ..Default::default()
        },
      ),
      (
        "c:\\ok.txt",
        FileSettings {
          tab_size: Some(4),
          ..Default::default()
        },
      ),
    ])
    .filled();
    assert!(s.items.get("c:\\zero.txt").is_none());
    assert!(s.items.get("c:\\big.txt").is_none());
    assert_eq!(s.items.get("c:\\ok.txt").and_then(|f| f.tab_size), Some(4));
  }

  #[test]
  fn bad_values_are_stripped_but_good_ones_survive() {
    let s = store(&[(
      "C:\\a.txt",
      FileSettings {
        render_whitespace: Some("sideways".into()),
        word_wrap: Some(true),
        sticky_scroll: Some(false),
        minimap: Some(true),
        tab_size: Some(4),
        insert_spaces: Some(false),
        detect_indentation: Some(false),
        encoding: Some("klingon".into()),
      },
    )])
    .filled();
    let got = s.get("c:\\A.TXT");
    assert_eq!(got.render_whitespace, None);
    assert_eq!(got.encoding, None);
    assert_eq!(got.word_wrap, Some(true));
    assert_eq!(got.sticky_scroll, Some(false));
    assert_eq!(got.minimap, Some(true));
  }

  #[test]
  fn a_known_encoding_override_is_kept() {
    let s = store(&[(
      "C:\\a.txt",
      FileSettings {
        encoding: Some("gbk".into()),
        ..Default::default()
      },
    )])
    .filled();
    assert_eq!(s.get("C:\\a.txt").encoding.as_deref(), Some("gbk"));
  }

  #[test]
  fn the_map_is_capped() {
    let pairs: Vec<(String, FileSettings)> = (0..MAX_FILES + 20)
      .map(|i| {
        (
          format!("c:\\f{i}.txt"),
          FileSettings {
            word_wrap: Some(true),
            ..Default::default()
          },
        )
      })
      .collect();
    let mut s = FileSettingsStore {
      version: 1,
      items: pairs.into_iter().collect(),
    };
    s = s.filled();
    assert_eq!(s.items.len(), MAX_FILES);
  }
}
