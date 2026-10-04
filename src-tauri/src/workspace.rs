//! Workspace storage: a workspace is the sidebar root plus the tabs opened in it,
//! so switching workspaces swaps the whole editing context inside the one window.

use crate::draft::normalize_path;
use chrono::Utc;
use serde::{Deserialize, Serialize};

/// Bounded so the state file stays cheap to read and diff.
const MAX_WORKSPACES: usize = 32;
const MAX_TABS: usize = 200;
/// Scratch text lives in the state file (an untitled tab has no draft key), so cap it.
const MAX_UNTITLED_BYTES: usize = 64 * 1024;

pub const STORE_VERSION: u32 = 1;

/// One restored tab. Either file-backed (`path`) or scratch (`untitled` + `content`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceTab {
  /// Normalized absolute path; empty for untitled tabs.
  pub path: String,
  /// Monaco model offset, same unit the drafts use.
  pub cursor: usize,
  /// Display name of an untitled tab, e.g. "Untitled-2"; empty for file-backed tabs.
  pub untitled: String,
  /// Unsaved text of an untitled tab. File-backed tabs never store content here:
  /// their unsaved text belongs to the draft file, and two copies would disagree.
  pub content: String,
}

impl WorkspaceTab {
  /// Identity within a workspace, matching what the frontend keys tabs by.
  pub fn key(&self) -> String {
    if !self.path.is_empty() {
      return self.path.clone();
    }
    if !self.untitled.is_empty() {
      return format!("untitled://{}", self.untitled);
    }
    String::new()
  }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Workspace {
  pub id: String,
  pub name: String,
  /// True while the name follows the root; a manual rename must survive root changes.
  pub auto_name: bool,
  /// Normalized directory shown by the Explorer, or empty when none.
  pub root: String,
  pub tabs: Vec<WorkspaceTab>,
  /// `WorkspaceTab::key()` of the selected tab, empty when none.
  pub active: String,
  pub sidebar_view: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceStore {
  pub version: u32,
  /// Id of the workspace shown in the window, empty when the session starts clean.
  pub active: String,
  pub items: Vec<Workspace>,
}

/// Tab keys are compared the way the backend normalizes paths: separators unified,
/// case ignored on the assumption that Windows paths are what we mostly store.
fn keys_equal(a: &str, b: &str) -> bool {
  a.replace('\\', "/").to_lowercase() == b.replace('\\', "/").to_lowercase()
}

/// Last path segment of a directory path, for auto-naming a workspace.
fn basename(path: &str) -> String {
  let trimmed = path.trim_end_matches(|c| c == '\\' || c == '/');
  trimmed
    .rsplit(|c| c == '\\' || c == '/')
    .next()
    .unwrap_or(trimmed)
    .to_string()
}

impl WorkspaceStore {
  /// Normalize and bound whatever the frontend sent: dedupe roots, drop unusable tabs,
  /// cap sizes, and repair dangling pointers. Reads use it too, so a hand-edited or
  /// half-written file cannot push the app into a state it would not produce itself.
  pub fn filled(self) -> Self {
    let mut items: Vec<Workspace> = Vec::new();
    let mut roots: Vec<String> = Vec::new();

    for item in self.items {
      if item.id.is_empty() {
        continue;
      }
      let root = if item.root.is_empty() {
        String::new()
      } else {
        normalize_path(&item.root)
      };
      if !root.is_empty() {
        // Two workspaces on the same folder are one workspace with a duplicate entry.
        if roots.iter().any(|r| r == &root) {
          continue;
        }
        roots.push(root.clone());
      }

      let mut tabs: Vec<WorkspaceTab> = Vec::new();
      let mut seen: Vec<String> = Vec::new();
      for tab in item.tabs {
        let mut tab = tab;
        if !tab.path.is_empty() {
          tab.path = normalize_path(&tab.path);
          tab.untitled = String::new();
          tab.content = String::new();
          if tab.path.is_empty() {
            continue;
          }
        } else {
          tab.untitled = tab.untitled.trim().to_string();
          if tab.untitled.is_empty() {
            continue;
          }
          if tab.content.len() > MAX_UNTITLED_BYTES {
            // Keep the tab, drop the oversized scratch text rather than the whole file.
            tab.content = String::new();
          }
        }
        let key = tab.key();
        if seen.iter().any(|k| keys_equal(k, &key)) {
          continue;
        }
        seen.push(key);
        tabs.push(tab);
      }
      tabs.truncate(MAX_TABS);

      // Rewritten to the stored tab's own spelling so later exact comparisons hold.
      let active = match tabs.iter().find(|t| keys_equal(&t.key(), &item.active)) {
        Some(t) => t.key(),
        None => String::new(),
      };
      let name = if item.auto_name || item.name.trim().is_empty() {
        if root.is_empty() {
          format!("Workspace {}", item.id)
        } else {
          basename(&root)
        }
      } else {
        item.name.trim().to_string()
      };

      items.push(Workspace {
        id: item.id,
        name,
        auto_name: item.auto_name,
        root,
        tabs,
        active,
        sidebar_view: if item.sidebar_view.is_empty() {
          "explorer".into()
        } else {
          item.sidebar_view
        },
        updated_at: if item.updated_at.is_empty() {
          Utc::now().to_rfc3339()
        } else {
          item.updated_at
        },
      });
    }

    if items.len() > MAX_WORKSPACES {
      // Keep the most recently touched ones, in their existing order.
      let mut ranked: Vec<String> = items.iter().map(|w| w.updated_at.clone()).collect();
      ranked.sort_by(|a, b| b.cmp(a));
      let cutoff = ranked[MAX_WORKSPACES - 1].clone();
      items.retain(|w| w.updated_at >= cutoff);
      items.truncate(MAX_WORKSPACES);
    }

    let ids: Vec<String> = items.iter().map(|w| w.id.clone()).collect();
    let active = if ids.contains(&self.active) {
      self.active
    } else {
      String::new()
    };

    Self {
      version: STORE_VERSION,
      active,
      items,
    }
  }

  /// Record the write time of the workspace actually in use, which is what makes the
  /// overflow rule above "drop the least recently used" instead of "drop the last saved".
  pub fn stamp_active(mut self) -> Self {
    let now = Utc::now().to_rfc3339();
    for item in &mut self.items {
      if item.id == self.active {
        item.updated_at = now.clone();
      }
    }
    self
  }

  pub fn workspace(&self, id: &str) -> Option<&Workspace> {
    self.items.iter().find(|w| w.id == id)
  }
}

/// What the "Move tab to workspace" menu asks for. `tab` is a tab key; `None` means all
/// of them. Nothing here touches the disk: a transfer re-homes the *opened* file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "action")]
pub enum TabTransfer {
  #[serde(rename_all = "camelCase")]
  Move {
    from: String,
    to: String,
    tab: Option<String>,
  },
  #[serde(rename_all = "camelCase")]
  Copy {
    from: String,
    to: String,
    tab: Option<String>,
  },
}

/// Move or copy tabs between two workspaces of the same store.
///
/// Takes the whole store and returns the whole store, so the caller writes once: a
/// two-step "remove from A" then "add to B" could fail in between and lose the tab.
pub fn apply_transfer(store: WorkspaceStore, transfer: &TabTransfer) -> WorkspaceStore {
  let (action, from_id, to_id, tab_key) = match transfer {
    TabTransfer::Move { from, to, tab } => ("move", from, to, tab),
    TabTransfer::Copy { from, to, tab } => ("copy", from, to, tab),
  };
  if from_id == to_id {
    return store;
  }

  let mut store = store;
  let (taken, remaining_tabs) = match store.workspace(from_id) {
    Some(source) => {
      let picked: Vec<WorkspaceTab> = source
        .tabs
        .iter()
        .filter(|t| match tab_key {
          Some(key) => keys_equal(&t.key(), key),
          None => true,
        })
        .cloned()
        .collect();
      (picked, source.tabs.clone())
    }
    None => return store,
  };
  if taken.is_empty() {
    return store;
  }

  let mut next_items: Vec<Workspace> = Vec::new();
  for item in store.items.clone() {
    if item.id == *from_id && action == "move" {
      let taken_keys: Vec<String> = taken.iter().map(|t| t.key()).collect();
      let tabs: Vec<WorkspaceTab> = remaining_tabs
        .iter()
        .filter(|t| !taken_keys.iter().any(|k| keys_equal(k, &t.key())))
        .cloned()
        .collect();
      let active = match tabs.iter().find(|t| keys_equal(&t.key(), &item.active)) {
        Some(t) => t.key(),
        None => tabs.last().map(|t| t.key()).unwrap_or_default(),
      };
      next_items.push(Workspace {
        tabs,
        active,
        ..item
      });
    } else if item.id == *to_id {
      let mut tabs = item.tabs.clone();
      for tab in &taken {
        let key = tab.key();
        match tabs.iter_mut().find(|t| keys_equal(&t.key(), &key)) {
          // Already open there: one tab wins, and it takes the incoming caret position.
          Some(existing) => existing.cursor = tab.cursor,
          None => tabs.push(tab.clone()),
        }
      }
      let active = if item.active.is_empty() {
        taken.last().map(|t| t.key()).unwrap_or_default()
      } else {
        item.active
      };
      next_items.push(Workspace {
        tabs,
        active,
        ..item
      });
    } else {
      next_items.push(item);
    }
  }

  store.items = next_items;
  store
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tab(path: &str) -> WorkspaceTab {
    WorkspaceTab {
      path: path.to_string(),
      ..Default::default()
    }
  }

  fn untitled(name: &str, content: &str) -> WorkspaceTab {
    WorkspaceTab {
      untitled: name.to_string(),
      content: content.to_string(),
      ..Default::default()
    }
  }

  fn ws(id: &str, root: &str, tabs: Vec<WorkspaceTab>) -> Workspace {
    Workspace {
      id: id.to_string(),
      root: root.to_string(),
      auto_name: true,
      tabs,
      ..Default::default()
    }
  }

  #[test]
  fn empty_store_is_not_an_error() {
    let filled = WorkspaceStore::default().filled();
    assert_eq!(filled.version, STORE_VERSION);
    assert_eq!(filled.active, "");
    assert!(filled.items.is_empty());
  }

  #[test]
  fn same_root_collapses_to_the_first_entry() {
    let store = WorkspaceStore {
      active: "b".into(),
      items: vec![
        ws("a", r"C:\notes", vec![tab(r"C:\notes\a.txt")]),
        // Same folder, different spelling and separator style.
        ws("b", "c:/NOTES/", vec![tab(r"C:\notes\b.txt")]),
      ],
      ..Default::default()
    }
    .filled();
    assert_eq!(store.items.len(), 1);
    assert_eq!(store.items[0].id, "a");
    assert_eq!(store.items[0].name, "notes");
    // The dangling pointer was repaired to the surviving entry, not left as "b".
    assert_eq!(store.active, "");
  }

  #[test]
  fn dangling_pointers_are_repaired() {
    let store = WorkspaceStore {
      active: "gone".into(),
      items: vec![Workspace {
        active: r"C:\notes\missing.txt".into(),
        ..ws("a", r"C:\notes", vec![tab(r"C:\notes\a.txt")])
      }],
      ..Default::default()
    }
    .filled();
    assert_eq!(store.active, "");
    assert_eq!(store.items[0].active, "");
  }

  #[test]
  fn tab_keys_separate_files_from_scratch_tabs() {
    assert_eq!(tab(r"C:\a.txt").key(), r"C:\a.txt");
    assert_eq!(untitled("Untitled-3", "").key(), "untitled://Untitled-3");
    assert_eq!(WorkspaceTab::default().key(), "");
  }

  #[test]
  fn oversized_scratch_text_is_dropped_but_the_tab_kept() {
    let big = "x".repeat(MAX_UNTITLED_BYTES + 1);
    let store = WorkspaceStore {
      items: vec![ws(
        "a",
        "",
        vec![
          untitled("Untitled-1", &big),
          untitled("Untitled-2", "short"),
        ],
      )],
      ..Default::default()
    }
    .filled();
    assert_eq!(store.items[0].tabs.len(), 2);
    assert_eq!(store.items[0].tabs[0].content, "");
    assert_eq!(store.items[0].tabs[0].untitled, "Untitled-1");
    assert_eq!(store.items[0].tabs[1].content, "short");
  }

  #[test]
  fn untitled_tabs_never_carry_a_path_and_file_tabs_never_carry_content() {
    let store = WorkspaceStore {
      items: vec![ws(
        "a",
        "",
        vec![WorkspaceTab {
          // A file tab must not smuggle a second copy of unsaved text.
          path: r"C:\notes\a.txt".into(),
          untitled: "Untitled-1".into(),
          content: "stale".into(),
          cursor: 4,
        }],
      )],
      ..Default::default()
    }
    .filled();
    let t = &store.items[0].tabs[0];
    assert_eq!(t.untitled, "");
    assert_eq!(t.content, "");
    assert_eq!(t.cursor, 4);
  }

  #[test]
  fn duplicate_tabs_and_blank_entries_are_dropped() {
    let store = WorkspaceStore {
      items: vec![ws(
        "a",
        "",
        vec![
          tab(r"C:\notes\a.txt"),
          tab("c:/NOTES/A.TXT"),
          WorkspaceTab::default(),
          tab(r"C:\notes\b.txt"),
        ],
      )],
      ..Default::default()
    }
    .filled();
    assert_eq!(store.items[0].tabs.len(), 2);
  }

  #[test]
  fn tab_and_workspace_counts_are_bounded() {
    let many = Workspace {
      tabs: (0..MAX_TABS + 40)
        .map(|i| tab(&format!(r"C:\notes\f{i}.txt")))
        .collect(),
      ..ws("a", r"C:\notes", vec![])
    };
    let store = WorkspaceStore {
      items: vec![many],
      ..Default::default()
    }
    .filled();
    assert_eq!(store.items[0].tabs.len(), MAX_TABS);

    // 33 workspaces, each with a distinct root and a monotonically newer timestamp.
    let mut items = Vec::new();
    for i in 0..MAX_WORKSPACES + 1 {
      items.push(Workspace {
        updated_at: format!("2026-01-01T00:00:{i:02}Z"),
        ..ws(
          &format!("w{i}"),
          &format!(r"C:\root{i}"),
          vec![tab(&format!(r"C:\root{i}\a.txt"))],
        )
      });
    }
    let store = WorkspaceStore {
      items,
      ..Default::default()
    }
    .filled();
    assert_eq!(store.items.len(), MAX_WORKSPACES);
    // The oldest timestamp lost the tie-break, not the newest.
    assert!(store.workspace("w0").is_none());
    assert!(store.workspace("w32").is_some());
  }

  #[test]
  fn manual_names_survive_a_root_change() {
    let renamed = Workspace {
      name: "scratchpad".into(),
      auto_name: false,
      ..ws("a", r"C:\notes", vec![])
    };
    let store = WorkspaceStore {
      items: vec![renamed],
      ..Default::default()
    }
    .filled();
    assert_eq!(store.items[0].name, "scratchpad");
  }

  #[test]
  fn only_the_active_workspace_is_retimestamped() {
    let store = WorkspaceStore {
      active: "a".into(),
      items: vec![
        Workspace {
          updated_at: "2026-01-01T00:00:00Z".into(),
          ..ws("a", r"C:\a", vec![])
        },
        Workspace {
          updated_at: "2026-01-01T00:00:00Z".into(),
          ..ws("b", r"C:\b", vec![])
        },
      ],
      ..Default::default()
    }
    .stamp_active();
    assert_ne!(store.items[0].updated_at, "2026-01-01T00:00:00Z");
    assert_eq!(store.items[1].updated_at, "2026-01-01T00:00:00Z");
  }

  #[test]
  fn basename_handles_both_separators_and_trailing_slashes() {
    assert_eq!(basename(r"C:\Users\x\wrolp-editor\"), "wrolp-editor");
    assert_eq!(basename("C:/Users/x/wrolp-editor"), "wrolp-editor");
    assert_eq!(basename("C:\\"), "C:");
  }

  fn two_workspaces() -> WorkspaceStore {
    WorkspaceStore {
      active: "a".into(),
      items: vec![
        Workspace {
          active: r"C:\a\x.txt".into(),
          ..ws(
            "a",
            r"C:\a",
            vec![
              WorkspaceTab {
                path: r"C:\a\x.txt".into(),
                cursor: 9,
                ..Default::default()
              },
              WorkspaceTab {
                path: r"C:\a\y.txt".into(),
                cursor: 3,
                ..Default::default()
              },
            ],
          )
        },
        Workspace {
          ..ws(
            "b",
            r"C:\b",
            vec![WorkspaceTab {
              path: r"C:\b\z.txt".into(),
              cursor: 1,
              ..Default::default()
            }],
          )
        },
      ],
      ..Default::default()
    }
    .filled()
  }

  fn move_one(from: &str, to: &str, tab: &str) -> WorkspaceStore {
    apply_transfer(
      two_workspaces(),
      &TabTransfer::Move {
        from: from.into(),
        to: to.into(),
        tab: Some(tab.into()),
      },
    )
  }

  #[test]
  fn moving_a_tab_moves_exactly_one_and_keeps_the_total() {
    let store = move_one("a", "b", r"C:\a\x.txt");
    let a = store.workspace("a").unwrap();
    let b = store.workspace("b").unwrap();
    assert_eq!(a.tabs.len(), 1);
    assert_eq!(b.tabs.len(), 2);
    assert!(b.tabs.iter().any(|t| t.path == r"c:\a\x.txt"));
  }

  #[test]
  fn moving_the_active_tab_falls_back_and_an_empty_workspace_has_no_active() {
    let store = move_one("a", "b", r"C:\a\x.txt");
    // x.txt was active in a, so a now points at what is left.
    assert_eq!(store.workspace("a").unwrap().active, r"c:\a\y.txt");

    let emptied = apply_transfer(
      store,
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: None,
      },
    );
    assert!(emptied.workspace("a").unwrap().tabs.is_empty());
    assert_eq!(emptied.workspace("a").unwrap().active, "");
  }

  #[test]
  fn a_tab_already_open_downstairs_is_not_duplicated() {
    let store = {
      let mut s = two_workspaces();
      s.items[0].tabs[0].path = r"C:\b\z.txt".into();
      s.items[0].tabs[0].cursor = 42;
      s.filled()
    };
    let moved = apply_transfer(
      store,
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: Some(r"c:\b\z.txt".into()),
      },
    );
    let b = moved.workspace("b").unwrap();
    assert_eq!(b.tabs.len(), 1);
    // The incoming caret wins over the stale one.
    assert_eq!(b.tabs[0].cursor, 42);
  }

  #[test]
  fn scratch_text_travels_with_its_tab() {
    let store = WorkspaceStore {
      active: "a".into(),
      items: vec![
        ws(
          "a",
          r"C:\a",
          vec![
            untitled("Untitled-1", "half-written note"),
            tab(r"C:\a\x.txt"),
          ],
        ),
        ws("b", r"C:\b", vec![]),
      ],
      ..Default::default()
    }
    .filled();
    let moved = apply_transfer(
      store,
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: Some("untitled://Untitled-1".into()),
      },
    );
    assert_eq!(moved.workspace("a").unwrap().tabs.len(), 1);
    let b = moved.workspace("b").unwrap();
    assert_eq!(b.tabs[0].untitled, "Untitled-1");
    assert_eq!(b.tabs[0].content, "half-written note");
    // The workspace that had no selection now shows the tab that arrived.
    assert_eq!(b.active, "untitled://Untitled-1");
  }

  #[test]
  fn moving_all_appends_in_source_order_and_empties_the_source() {
    let store = apply_transfer(
      two_workspaces(),
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: None,
      },
    );
    let b = store.workspace("b").unwrap();
    assert!(store.workspace("a").unwrap().tabs.is_empty());
    assert_eq!(
      b.tabs.iter().map(|t| t.key()).collect::<Vec<_>>(),
      vec![r"c:\b\z.txt", r"c:\a\x.txt", r"c:\a\y.txt"]
    );
  }

  #[test]
  fn copying_leaves_the_source_untouched() {
    let store = apply_transfer(
      two_workspaces(),
      &TabTransfer::Copy {
        from: "a".into(),
        to: "b".into(),
        tab: Some(r"c:\a\x.txt".into()),
      },
    );
    assert_eq!(store.workspace("a").unwrap().tabs.len(), 2);
    assert_eq!(store.workspace("b").unwrap().tabs.len(), 2);
  }

  #[test]
  fn nonsense_transfers_return_the_store_unchanged() {
    let same = apply_transfer(
      two_workspaces(),
      &TabTransfer::Move {
        from: "a".into(),
        to: "a".into(),
        tab: None,
      },
    );
    assert_eq!(same.workspace("a").unwrap().tabs.len(), 2);

    let missing = apply_transfer(
      two_workspaces(),
      &TabTransfer::Move {
        from: "nope".into(),
        to: "b".into(),
        tab: None,
      },
    );
    assert_eq!(missing.workspace("b").unwrap().tabs.len(), 1);

    let absent_tab = apply_transfer(
      two_workspaces(),
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: Some(r"c:\a\gone.txt".into()),
      },
    );
    assert_eq!(absent_tab.workspace("a").unwrap().tabs.len(), 2);
  }
}
