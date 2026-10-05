//! Workspace storage: a workspace is a **named group of open tabs**, not a folder.
//! Which folder the Explorer shows is a global view setting (`Settings.sidebar_root`),
//! so two groups may sit on the same directory and the same directory is never a group.

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
  /// Label chosen by the user; the only thing that distinguishes one group from another.
  pub name: String,
  pub tabs: Vec<WorkspaceTab>,
  /// `WorkspaceTab::key()` of the selected tab, empty when none.
  pub active: String,
  pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct WorkspaceStore {
  pub version: u32,
  /// Id of the group shown in the window, empty when the session starts clean.
  pub active: String,
  pub items: Vec<Workspace>,
}

/// Tab keys are compared the way the backend normalizes paths: separators unified,
/// case ignored on the assumption that Windows paths are what we mostly store.
fn keys_equal(a: &str, b: &str) -> bool {
  a.replace('\\', "/").to_lowercase() == b.replace('\\', "/").to_lowercase()
}

impl WorkspaceStore {
  /// Normalize and bound whatever the frontend sent: drop unusable tabs, cap sizes, and
  /// repair dangling pointers. Reads use it too, so a hand-edited or half-written file
  /// cannot push the app into a state it would not produce itself.
  ///
  /// Names are labels, not identity: two groups may carry the same name or point at the
  /// same folder, and nothing here merges them.
  pub fn filled(self) -> Self {
    let mut items: Vec<Workspace> = Vec::new();

    for item in self.items {
      if item.id.is_empty() {
        continue;
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
      // Only a hand-edited or empty record can lack a name; the UI always supplies one.
      let name = if item.name.trim().is_empty() {
        format!("Group {}", items.len() + 1)
      } else {
        item.name.trim().to_string()
      };

      items.push(Workspace {
        id: item.id,
        name,
        tabs,
        active,
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

  /// Record the write time of the group actually in use, which is what makes the overflow
  /// rule above "drop the least recently used" instead of "drop the last saved".
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

/// Move or copy tabs between two groups of the same store.
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

  fn ws(id: &str, name: &str, tabs: Vec<WorkspaceTab>) -> Workspace {
    Workspace {
      id: id.to_string(),
      name: name.to_string(),
      tabs,
      ..Default::default()
    }
  }

  fn store(items: Vec<Workspace>) -> WorkspaceStore {
    WorkspaceStore {
      active: "a".into(),
      items,
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
  fn same_name_is_not_merged_because_a_name_is_only_a_label() {
    let filled = store(vec![
      ws("a", "notes", vec![tab(r"C:\notes\a.txt")]),
      ws("b", "notes", vec![tab(r"C:\other\b.txt")]),
    ])
    .filled();
    assert_eq!(filled.items.len(), 2);
    assert_eq!(filled.items[1].tabs.len(), 1);
  }

  #[test]
  fn a_missing_name_falls_back_to_a_placeholder() {
    let filled = store(vec![ws("a", "   ", vec![]), ws("b", "scratch", vec![])]).filled();
    assert_eq!(filled.items[0].name, "Group 1");
    assert_eq!(filled.items[1].name, "scratch");
    assert_eq!(filled.items[0].id, "a");
  }

  #[test]
  fn records_without_an_id_are_dropped() {
    let filled = store(vec![
      ws("", "no id", vec![tab(r"C:\a.txt")]),
      ws("b", "ok", vec![]),
    ])
    .filled();
    assert_eq!(filled.items.len(), 1);
    assert_eq!(filled.items[0].id, "b");
  }

  #[test]
  fn dangling_pointers_are_repaired() {
    let filled = WorkspaceStore {
      active: "gone".into(),
      items: vec![Workspace {
        active: r"C:\notes\missing.txt".into(),
        ..ws("a", "notes", vec![tab(r"C:\notes\a.txt")])
      }],
      ..Default::default()
    }
    .filled();
    assert_eq!(filled.active, "");
    assert_eq!(filled.items[0].active, "");
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
    let filled = store(vec![ws(
      "a",
      "notes",
      vec![
        untitled("Untitled-1", &big),
        untitled("Untitled-2", "short"),
      ],
    )])
    .filled();
    assert_eq!(filled.items[0].tabs.len(), 2);
    assert_eq!(filled.items[0].tabs[0].content, "");
    assert_eq!(filled.items[0].tabs[0].untitled, "Untitled-1");
    assert_eq!(filled.items[0].tabs[1].content, "short");
  }

  #[test]
  fn untitled_tabs_never_carry_a_path_and_file_tabs_never_carry_content() {
    let filled = store(vec![ws(
      "a",
      "notes",
      vec![WorkspaceTab {
        // A file tab must not smuggle a second copy of unsaved text.
        path: r"C:\notes\a.txt".into(),
        untitled: "Untitled-1".into(),
        content: "stale".into(),
        cursor: 4,
      }],
    )])
    .filled();
    let t = &filled.items[0].tabs[0];
    assert_eq!(t.untitled, "");
    assert_eq!(t.content, "");
    assert_eq!(t.cursor, 4);
  }

  #[test]
  fn duplicate_tabs_and_blank_entries_are_dropped() {
    let filled = store(vec![ws(
      "a",
      "notes",
      vec![
        tab(r"C:\notes\a.txt"),
        tab("c:/NOTES/A.TXT"),
        WorkspaceTab::default(),
        tab(r"C:\notes\b.txt"),
      ],
    )])
    .filled();
    assert_eq!(filled.items[0].tabs.len(), 2);
  }

  #[test]
  fn tab_and_workspace_counts_are_bounded() {
    let many = Workspace {
      tabs: (0..MAX_TABS + 40)
        .map(|i| tab(&format!(r"C:\notes\f{i}.txt")))
        .collect(),
      ..ws("a", "notes", vec![])
    };
    let filled = store(vec![many]).filled();
    assert_eq!(filled.items[0].tabs.len(), MAX_TABS);

    let mut items = Vec::new();
    for i in 0..MAX_WORKSPACES + 1 {
      items.push(Workspace {
        updated_at: format!("2026-01-01T00:00:{i:02}Z"),
        ..ws(
          &format!("w{i}"),
          &format!("group {i}"),
          vec![tab(r"C:\a.txt")],
        )
      });
    }
    let filled = WorkspaceStore {
      items,
      ..Default::default()
    }
    .filled();
    assert_eq!(filled.items.len(), MAX_WORKSPACES);
    // The oldest timestamp lost the tie-break, not the newest.
    assert!(filled.workspace("w0").is_none());
    assert!(filled.workspace("w32").is_some());
  }

  #[test]
  fn only_the_active_group_is_retimestamped() {
    let stamped = WorkspaceStore {
      active: "a".into(),
      items: vec![
        Workspace {
          updated_at: "2026-01-01T00:00:00Z".into(),
          ..ws("a", "one", vec![])
        },
        Workspace {
          updated_at: "2026-01-01T00:00:00Z".into(),
          ..ws("b", "two", vec![])
        },
      ],
      ..Default::default()
    }
    .stamp_active();
    assert_ne!(stamped.items[0].updated_at, "2026-01-01T00:00:00Z");
    assert_eq!(stamped.items[1].updated_at, "2026-01-01T00:00:00Z");
  }

  fn two_groups() -> WorkspaceStore {
    store(vec![
      Workspace {
        active: r"C:\a\x.txt".into(),
        tabs: vec![
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
        ..ws("a", "first", vec![])
      },
      Workspace {
        tabs: vec![WorkspaceTab {
          path: r"C:\b\z.txt".into(),
          cursor: 1,
          ..Default::default()
        }],
        ..ws("b", "second", vec![])
      },
    ])
    .filled()
  }

  fn move_one(from: &str, to: &str, key: &str) -> WorkspaceStore {
    apply_transfer(
      two_groups(),
      &TabTransfer::Move {
        from: from.into(),
        to: to.into(),
        tab: Some(key.into()),
      },
    )
  }

  #[test]
  fn moving_a_tab_moves_exactly_one_and_keeps_the_total() {
    let filled = move_one("a", "b", "c:\\a\\x.txt");
    let a = filled.workspace("a").unwrap();
    let b = filled.workspace("b").unwrap();
    assert_eq!(a.tabs.len(), 1);
    assert_eq!(b.tabs.len(), 2);
    assert!(b.tabs.iter().any(|t| t.path == r"c:\a\x.txt"));
  }

  #[test]
  fn moving_the_active_tab_falls_back_and_an_empty_group_has_no_active() {
    let filled = move_one("a", "b", "c:\\a\\x.txt");
    // x.txt was active in a, so a now points at what is left.
    assert_eq!(filled.workspace("a").unwrap().active, r"c:\a\y.txt");

    let emptied = apply_transfer(
      filled,
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
    let prepared = store(vec![
      Workspace {
        tabs: vec![WorkspaceTab {
          path: r"C:\b\z.txt".into(),
          cursor: 42,
          ..Default::default()
        }],
        ..ws("a", "first", vec![])
      },
      Workspace {
        tabs: vec![WorkspaceTab {
          path: r"C:\b\z.txt".into(),
          cursor: 1,
          ..Default::default()
        }],
        ..ws("b", "second", vec![])
      },
    ])
    .filled();
    let filled = apply_transfer(
      prepared,
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: Some(r"c:\b\z.txt".into()),
      },
    );
    let b = filled.workspace("b").unwrap();
    assert_eq!(b.tabs.len(), 1);
    // The incoming caret wins over the stale one.
    assert_eq!(b.tabs[0].cursor, 42);
  }

  #[test]
  fn scratch_text_travels_with_its_tab() {
    let prepared = store(vec![
      ws(
        "a",
        "first",
        vec![
          untitled("Untitled-1", "half-written note"),
          tab(r"C:\a\x.txt"),
        ],
      ),
      ws("b", "second", vec![]),
    ])
    .filled();
    let filled = apply_transfer(
      prepared,
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: Some("untitled://Untitled-1".into()),
      },
    );
    assert_eq!(filled.workspace("a").unwrap().tabs.len(), 1);
    let b = filled.workspace("b").unwrap();
    assert_eq!(b.tabs[0].untitled, "Untitled-1");
    assert_eq!(b.tabs[0].content, "half-written note");
    // The group that had no selection now shows the tab that arrived.
    assert_eq!(b.active, "untitled://Untitled-1");
  }

  #[test]
  fn moving_all_appends_in_source_order_and_empties_the_source() {
    let filled = apply_transfer(
      two_groups(),
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: None,
      },
    );
    let b = filled.workspace("b").unwrap();
    assert!(filled.workspace("a").unwrap().tabs.is_empty());
    assert_eq!(
      b.tabs.iter().map(|t| t.key()).collect::<Vec<_>>(),
      vec![r"c:\b\z.txt", r"c:\a\x.txt", r"c:\a\y.txt"]
    );
  }

  #[test]
  fn copying_leaves_the_source_untouched() {
    let filled = apply_transfer(
      two_groups(),
      &TabTransfer::Copy {
        from: "a".into(),
        to: "b".into(),
        tab: Some(r"c:\a\x.txt".into()),
      },
    );
    assert_eq!(filled.workspace("a").unwrap().tabs.len(), 2);
    assert_eq!(filled.workspace("b").unwrap().tabs.len(), 2);
  }

  #[test]
  fn nonsense_transfers_return_the_store_unchanged() {
    let same = apply_transfer(
      two_groups(),
      &TabTransfer::Move {
        from: "a".into(),
        to: "a".into(),
        tab: None,
      },
    );
    assert_eq!(same.workspace("a").unwrap().tabs.len(), 2);

    let missing = apply_transfer(
      two_groups(),
      &TabTransfer::Move {
        from: "nope".into(),
        to: "b".into(),
        tab: None,
      },
    );
    assert_eq!(missing.workspace("b").unwrap().tabs.len(), 1);

    let absent = apply_transfer(
      two_groups(),
      &TabTransfer::Move {
        from: "a".into(),
        to: "b".into(),
        tab: Some(r"c:\a\gone.txt".into()),
      },
    );
    assert_eq!(absent.workspace("a").unwrap().tabs.len(), 2);
  }
}
