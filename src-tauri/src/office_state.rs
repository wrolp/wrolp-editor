//! Where an Office document was left: the view it was in, how that view was set up, and the
//! item it was showing.
//!
//! A spreadsheet is read rather than edited, so "where it was left" is not a text offset: it is
//! a sheet and a record within it, plus the settings of the record view that shows them. Keyed
//! by the same normalized path as drafts, versions and `pdf-positions.json`, so one file means
//! one thing wherever it is opened: the place belongs to the document, not to the tab that
//! happened to show it.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::AppHandle;

const FILE: &str = "office-states.json";
/// Bounded like `pdf-positions.json`: a forgotten document must not grow the store forever.
const MAX_FILES: usize = 200;
/// The ceiling the viewer puts on a title row. A stored row past it names a file that shrank.
const MAX_TITLE_ROW: u32 = 2000;
/// The narrowest and widest a dragged title column can be, matching the drag's own limits.
const MIN_LABEL_WIDTH: f64 = 40.0;
const MAX_LABEL_WIDTH: f64 = 2000.0;

/// One document's view, as the viewer can restore it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct OfficeState {
  /// The records view rather than the grid.
  pub records: bool,
  /// The record view's title block: drawn or not, the row it starts at, how many rows it takes.
  pub show_titles: bool,
  pub title_row: u32,
  pub title_rows: u32,
  /// The dragged width of the title column, in CSS pixels; `None` when it was never dragged.
  pub label_width: Option<f64>,
  /// The sheet on screen and the item within it, zero-based as the viewer counts them.
  pub sheet: u32,
  pub record: u32,
}

impl Default for OfficeState {
  fn default() -> Self {
    Self {
      records: false,
      // Titles on and one title row: a sheet with a header is the common case, and hiding the
      // header by default would misread the first record as data on every file.
      show_titles: true,
      title_row: 1,
      title_rows: 1,
      label_width: None,
      sheet: 0,
      record: 0,
    }
  }
}

impl OfficeState {
  /// What the viewer can honour.
  ///
  /// Out-of-range numbers are clamped rather than rejected: a remembered view that no longer
  /// fits the document should open at the nearest place that does, not be thrown away. The
  /// record is left as written — only the viewer knows how many rows the sheet has, and it
  /// clamps while drawing.
  fn cleaned(self) -> Option<Self> {
    let cleaned = Self {
      title_row: self.title_row.clamp(1, MAX_TITLE_ROW),
      title_rows: self.title_rows.min(MAX_TITLE_ROW),
      label_width: self.label_width.filter(|w| w.is_finite()).map(|w| {
        if w < MIN_LABEL_WIDTH {
          MIN_LABEL_WIDTH
        } else if w > MAX_LABEL_WIDTH {
          MAX_LABEL_WIDTH
        } else {
          w
        }
      }),
      ..self
    };
    // The defaults are the absence of a state: a file nobody changed takes no entry, which is
    // also what keeps the cap for files somebody did change.
    if cleaned == Self::default() {
      None
    } else {
      Some(cleaned)
    }
  }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct OfficeStateStore {
  pub version: u32,
  pub items: BTreeMap<String, OfficeState>,
}

impl OfficeStateStore {
  /// Normalize every key, drop the entries the viewer cannot use, and cap the map.
  fn filled(self) -> Self {
    self.rekeyed("", "")
  }

  /// Move the views of `old` and of everything inside it, after a rename put them elsewhere.
  ///
  /// An empty `old` is the no-renames case, which makes this the one normalizing pass every
  /// write goes through.
  fn rekeyed(mut self, old: &str, new: &str) -> Self {
    self.version = 1;
    let items = std::mem::take(&mut self.items);
    self.items = items
      .into_iter()
      .filter_map(|(path, state)| {
        let moved = if old.is_empty() {
          path
        } else {
          crate::rename::rekey(&path, old, new)
        };
        let key = crate::draft::normalize_path(&moved);
        if key.is_empty() {
          return None;
        }
        state.cleaned().map(|state| (key, state))
      })
      .collect();
    if self.items.len() > MAX_FILES {
      // The cap keeps the alphabetically last paths, as everywhere else: arbitrary, but
      // deterministic, which is all a cap needs.
      let skip = self.items.len() - MAX_FILES;
      self.items = self.items.into_iter().skip(skip).collect();
    }
    self
  }
}

fn store_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
  Ok(crate::draft::store_dir(app)?.join(FILE))
}

/// What a store file's bytes say, cleaned; unreadable bytes say "no states at all".
///
/// A broken file is not a broken document: the worst it can cost is opening at the first
/// record of the first sheet, while refusing it would leave every later write unreadable —
/// all writes read the store first, so one bad byte would switch the feature off for good.
fn store_of(bytes: &[u8]) -> OfficeStateStore {
  serde_json::from_slice::<OfficeStateStore>(bytes)
    .map(|store| store.filled())
    .unwrap_or_default()
}

fn load_store(app: &AppHandle) -> Result<OfficeStateStore, String> {
  match std::fs::read(store_path(app)?) {
    Ok(bytes) => Ok(store_of(&bytes)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(OfficeStateStore::default()),
    Err(e) => Err(format!("state_read:{FILE}: {e}")),
  }
}

fn write_store(app: &AppHandle, store: &OfficeStateStore) -> Result<(), String> {
  let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
  crate::commands::write_atomic(&store_path(app)?, &json)
    .map_err(|e| format!("state_write:{FILE}: {e}"))
}

/// This document's view, `None` when it has never been changed here.
pub fn get(app: &AppHandle, path: &str) -> Result<Option<OfficeState>, String> {
  let key = crate::draft::normalize_path(path);
  Ok(load_store(app)?.items.get(&key).cloned())
}

/// Replace one document's view. The defaults clear it rather than storing a state that says
/// nothing.
pub fn save(app: &AppHandle, path: &str, state: OfficeState) -> Result<(), String> {
  let key = crate::draft::normalize_path(path);
  if key.is_empty() {
    return Err("path_empty".into());
  }
  let mut store = load_store(app)?.rekeyed("", "");
  match state.cleaned() {
    Some(state) => store.items.insert(key, state),
    None => store.items.remove(&key),
  };
  let store = store.filled();
  write_store(app, &store)
}

/// Re-home the views of `old` and of everything inside it after a rename moved them.
pub fn rekey_prefix(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let store = load_store(app)?.rekeyed(old, new);
  write_store(app, &store)
}

/// The view one document was last left in: `null` when it has never been changed here.
#[tauri::command]
pub fn get_office_state(app: AppHandle, path: String) -> Result<Option<OfficeState>, String> {
  get(&app, &path)
}

#[tauri::command]
pub fn save_office_state(app: AppHandle, path: String, state: OfficeState) -> Result<(), String> {
  save(&app, &path, state)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn state(sheet: u32, record: u32) -> OfficeState {
    OfficeState {
      records: true,
      sheet,
      record,
      ..OfficeState::default()
    }
  }

  fn store(pairs: &[(&str, OfficeState)]) -> OfficeStateStore {
    OfficeStateStore {
      version: 1,
      items: pairs
        .iter()
        .map(|(path, state)| (path.to_string(), state.clone()))
        .collect(),
    }
  }

  /// A file nobody changed says nothing, and an entry that says nothing is not worth keeping.
  #[test]
  fn the_default_state_is_no_state() {
    assert!(OfficeState::default().cleaned().is_none());
    let changed = OfficeState {
      records: true,
      ..OfficeState::default()
    };
    assert!(changed.cleaned().is_some());
  }

  /// Numbers a viewer cannot honour are brought back into range rather than thrown away.
  #[test]
  fn out_of_range_numbers_are_brought_back() {
    let cleaned = OfficeState {
      title_row: 0,
      title_rows: 9000,
      label_width: Some(-10.0),
      ..state(0, 0)
    }
    .cleaned()
    .expect("a state with a record is still a state");
    assert_eq!(cleaned.title_row, 1);
    assert_eq!(cleaned.title_rows, MAX_TITLE_ROW);
    assert_eq!(cleaned.label_width, Some(MIN_LABEL_WIDTH));

    let wide = OfficeState {
      label_width: Some(1e9),
      ..state(0, 0)
    };
    assert_eq!(wide.cleaned().unwrap().label_width, Some(MAX_LABEL_WIDTH));

    let broken = OfficeState {
      label_width: Some(f64::INFINITY),
      ..state(0, 0)
    };
    assert_eq!(broken.cleaned().unwrap().label_width, None);
  }

  /// The keys are the same normalized paths the drafts and the PDF positions use.
  #[test]
  fn one_file_is_one_entry() {
    let filled = store(&[(r"C:\Books\a.xlsx", state(2, 7))]).filled();
    assert_eq!(
      filled.items.get(r"c:\books\a.xlsx"),
      Some(&state(2, 7)),
      "the path is folded to the identity the rest of the store uses"
    );
  }

  #[test]
  fn a_rename_carries_the_view_with_the_file() {
    let filled = store(&[
      (r"c:\books\a.xlsx", state(1, 3)),
      (r"c:\other\b.xlsx", state(0, 4)),
    ])
    .rekeyed(r"c:\books", r"c:\kept");
    assert_eq!(filled.items.get(r"c:\kept\a.xlsx"), Some(&state(1, 3)));
    assert_eq!(filled.items.get(r"c:\other\b.xlsx"), Some(&state(0, 4)));
    assert!(filled.items.get(r"c:\books\a.xlsx").is_none());
  }

  /// One stray byte must not switch the feature off: the next write replaces the file whole.
  #[test]
  fn a_broken_file_reads_as_no_states() {
    assert!(store_of(b"not json").items.is_empty());
    let good =
      store_of(br#"{"version":1,"items":{"c:\\a.xlsx":{"records":true,"sheet":2,"record":9}}}"#);
    let found = good.items.get(r"c:\a.xlsx").expect("the entry survived");
    assert_eq!(found.sheet, 2);
    assert_eq!(found.record, 9);
    assert!(
      found.show_titles,
      "a missing field takes the viewer's default"
    );
  }

  #[test]
  fn the_map_is_capped() {
    let pairs: Vec<(String, OfficeState)> = (0..MAX_FILES + 20)
      .map(|i| (format!(r"c:\f{i}.xlsx"), state(0, i as u32)))
      .collect();
    let filled = OfficeStateStore {
      version: 1,
      items: pairs.into_iter().collect(),
    }
    .filled();
    assert_eq!(filled.items.len(), MAX_FILES);
  }
}
