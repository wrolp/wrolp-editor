//! Where the reader left off in each PDF.
//!
//! A PDF is drawn by the reader rather than edited, so its "position" is a page and how far down
//! that page the pane sits — not a text offset, which is what the group store keeps for every
//! other tab. Keyed by the same normalized path as drafts, versions and `file-settings.json`, so
//! one file means one thing wherever it is opened: the place belongs to the document, not to the
//! tab group or the window that happened to show it.
//!
//! The position is stored as a fraction of the page rather than as pixels because a page is
//! rendered at whatever size the pane and the zoom allow. A `scrollTop` taken in a narrow window
//! lands somewhere else entirely in a wide one, while "two thirds down page 12" is the same read
//! in either.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::AppHandle;

const FILE: &str = "pdf-positions.json";
/// Bounded like `file-settings.json`: a forgotten document must not grow the store forever.
const MAX_FILES: usize = 200;

/// One document's place: the page it was left open on, and how far down that page.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfPosition {
  /// 1-based, the way the reader counts pages.
  pub page: u32,
  /// `0.0` is the top of the page, `1.0` its bottom.
  pub ratio: f64,
}

impl PdfPosition {
  /// What the reader can actually honour: a page that does not exist is a file that changed
  /// underneath the reader, and a fraction outside the page is a hand-edited or overflowing
  /// number. A page of zero is neither, it is the absence of a place — `filled` drops the entry
  /// rather than inventing one, so the document opens at the top like any file never read here.
  fn cleaned(self) -> Option<Self> {
    if self.page == 0 {
      return None;
    }
    Some(Self {
      page: self.page,
      ratio: if self.ratio.is_finite() {
        self.ratio.clamp(0.0, 1.0)
      } else {
        0.0
      },
    })
  }
}

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct PdfPositionStore {
  pub version: u32,
  pub items: BTreeMap<String, PdfPosition>,
}

impl PdfPositionStore {
  /// Normalize every key, drop the entries the reader cannot use, and cap the map.
  fn filled(self) -> Self {
    self.rekeyed("", "")
  }

  /// Move the places of `old` and of everything inside it, after a rename put them elsewhere.
  ///
  /// An empty `old` is the no-renames case, which makes this the one normalizing pass every
  /// write goes through.
  fn rekeyed(mut self, old: &str, new: &str) -> Self {
    self.version = 1;
    let items = std::mem::take(&mut self.items);
    self.items = items
      .into_iter()
      .filter_map(|(path, position)| {
        let moved = if old.is_empty() {
          path
        } else {
          crate::rename::rekey(&path, old, new)
        };
        let key = crate::draft::normalize_path(&moved);
        if key.is_empty() {
          return None;
        }
        position.cleaned().map(|position| (key, position))
      })
      .collect();
    if self.items.len() > MAX_FILES {
      // The cap keeps the alphabetically last paths, as in `file_settings`: arbitrary, but
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

/// What a store file's bytes say, cleaned; unreadable bytes say "no positions at all".
///
/// A broken file is not a broken PDF: the worst it can cost is starting at the top of every
/// document, while refusing it would leave the reader unable to write a position ever again —
/// downstream writes all go through this same read, so one bad byte would switch the feature off
/// for good. The next save rewrites the file in full, which is also the repair.
fn store_of(bytes: &[u8]) -> PdfPositionStore {
  serde_json::from_slice::<PdfPositionStore>(bytes)
    .map(|store| store.filled())
    .unwrap_or_default()
}

fn load_store(app: &AppHandle) -> Result<PdfPositionStore, String> {
  match std::fs::read(store_path(app)?) {
    Ok(bytes) => Ok(store_of(&bytes)),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(PdfPositionStore::default()),
    Err(e) => Err(format!("state_read:{FILE}: {e}")),
  }
}

fn write_store(app: &AppHandle, store: &PdfPositionStore) -> Result<(), String> {
  let json = serde_json::to_vec_pretty(store).map_err(|e| e.to_string())?;
  crate::commands::write_atomic(&store_path(app)?, &json)
    .map_err(|e| format!("state_write:{FILE}: {e}"))
}

/// This document's place, `None` when it has never been read here.
pub fn get(app: &AppHandle, path: &str) -> Result<Option<PdfPosition>, String> {
  let key = crate::draft::normalize_path(path);
  Ok(load_store(app)?.items.get(&key).copied())
}

/// Replace one document's place. A page of zero clears it rather than storing a place that
/// cannot be scrolled to.
pub fn save(app: &AppHandle, path: &str, page: u32, ratio: f64) -> Result<(), String> {
  let key = crate::draft::normalize_path(path);
  if key.is_empty() {
    return Err("path_empty".into());
  }
  let mut store = load_store(app)?.rekeyed("", "");
  match (PdfPosition { page, ratio }).cleaned() {
    Some(position) => store.items.insert(key, position),
    None => store.items.remove(&key),
  };
  let store = store.filled();
  write_store(app, &store)
}

/// Re-home the places of `old` and of everything inside it after a rename moved them.
pub fn rekey_prefix(app: &AppHandle, old: &str, new: &str) -> Result<(), String> {
  let store = load_store(app)?.rekeyed(old, new);
  write_store(app, &store)
}

/// The place one PDF was last left: `null` when this file has no reading history.
#[tauri::command]
pub fn get_pdf_position(app: AppHandle, path: String) -> Result<Option<PdfPosition>, String> {
  get(&app, &path)
}

#[tauri::command]
pub fn save_pdf_position(
  app: AppHandle,
  path: String,
  page: u32,
  ratio: f64,
) -> Result<(), String> {
  save(&app, &path, page, ratio)
}

#[cfg(test)]
mod tests {
  use super::*;

  fn store(pairs: &[(&str, PdfPosition)]) -> PdfPositionStore {
    PdfPositionStore {
      version: 1,
      items: pairs
        .iter()
        .map(|(p, position)| (p.to_string(), *position))
        .collect(),
    }
  }

  fn at(page: u32, ratio: f64) -> PdfPosition {
    PdfPosition { page, ratio }
  }

  /// A page of zero is not a place, and a fraction outside the page is a mistake rather than a
  /// scroll target: both are handled so the reader either has somewhere to go or starts at the top.
  #[test]
  fn positions_outside_the_document_are_brought_back() {
    let filled = store(&[
      (r"C:\zero.pdf", at(0, 0.5)),
      (r"C:\past.pdf", at(3, 1.8)),
      (r"C:\before.pdf", at(7, -0.4)),
      (r"C:\real.pdf", at(12, 0.48)),
    ])
    .filled();
    assert!(
      filled.items.get(r"c:\zero.pdf").is_none(),
      "page 0 is no place"
    );
    assert_eq!(filled.items.get(r"c:\past.pdf"), Some(&at(3, 1.0)));
    assert_eq!(filled.items.get(r"c:\before.pdf"), Some(&at(7, 0.0)));
    assert_eq!(filled.items.get(r"c:\real.pdf"), Some(&at(12, 0.48)));
  }

  /// The keys are the same normalized paths the drafts and overrides use, so one file is one
  /// entry however the frontend spelled its path.
  #[test]
  fn one_file_is_one_entry() {
    let filled = store(&[(r"C:\Notes\a.pdf", at(4, 0.25))]).filled();
    assert!(filled.items.get(r"c:\notes\a.pdf").is_some());
  }

  #[test]
  fn a_rename_carries_the_place_with_the_file() {
    let filled = store(&[
      (r"c:\notes\a.pdf", at(9, 0.6)),
      (r"c:\other\b.pdf", at(2, 0.1)),
    ])
    .rekeyed(r"c:\notes", r"c:\kept");
    assert_eq!(filled.items.get(r"c:\kept\a.pdf"), Some(&at(9, 0.6)));
    assert_eq!(filled.items.get(r"c:\other\b.pdf"), Some(&at(2, 0.1)));
    assert!(filled.items.get(r"c:\notes\a.pdf").is_none());
  }

  /// A file that cannot be parsed is not worth a refusal: the reader starts at the top and the
  /// next write replaces the file in full, so one stray byte cannot stop positions being kept.
  #[test]
  fn a_broken_file_reads_as_no_positions() {
    assert!(store_of(b"not json").items.is_empty());
    let good = store_of(br#"{"version":1,"items":{"c:\\a.pdf":{"page":3,"ratio":0.25}}}"#);
    assert_eq!(good.items.get(r"c:\a.pdf"), Some(&at(3, 0.25)));
  }

  #[test]
  fn the_map_is_capped() {
    let pairs: Vec<(String, PdfPosition)> = (0..MAX_FILES + 20)
      .map(|i| (format!(r"c:\f{i}.pdf"), at(1, 0.5)))
      .collect();
    let filled = PdfPositionStore {
      version: 1,
      items: pairs.into_iter().collect(),
    }
    .filled();
    assert_eq!(filled.items.len(), MAX_FILES);
  }
}
