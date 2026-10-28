//! The changed-file list: git's porcelain status, split into the index and working-tree halves
//! the panel shows separately.

use git2::{FileMode, Status as GitStatus, StatusOptions};
use serde::Serialize;
use std::path::PathBuf;

use super::{
  abs_of, discover, fail, git_path, repo_info, RepoInfo, MAX_STATUS_ENTRIES,
};

/// How many ignored paths are reported. They are decoration for the Explorer rather than a list to
/// act on, and a project with a hand-written ignore file can have thousands; the changed paths
/// must still fit in the same answer, so this is a separate, smaller ceiling.
const MAX_IGNORED_ENTRIES: usize = 1000;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusEntry {
  /// Repository-relative, forward slashes, as git reports it and as every git command takes it.
  pub path: String,
  /// Absolute path for opening, revealing or diffing the file.
  pub abs: String,
  /// Where a rename came from, when the entry is one.
  pub old_path: Option<String>,
  /// One letter for the index half: A, M, D, R or T.
  pub index: Option<String>,
  /// One letter for the working-tree half: ?, M, D, R or T.
  pub workdir: Option<String>,
  /// tracked | untracked | conflicted | ignored
  pub kind: String,
  pub submodule: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
  pub repo: RepoInfo,
  pub files: Vec<StatusEntry>,
  /// Entries with something staged.
  pub staged: usize,
  /// Entries with a working-tree change (tracked, non-conflicted).
  pub changed: usize,
  pub untracked: usize,
  pub conflicted: usize,
  /// True when the repository had more changed paths than this answer carried.
  pub truncated: bool,
}

#[tauri::command]
pub fn git_status(root: String) -> Result<StatusView, String> {
  status_of(&root)
}

pub(crate) fn status_of(root: &str) -> Result<StatusView, String> {
  let opened = discover(root)?;
  let info = repo_info(&opened, root);
  let mut opts = StatusOptions::new();
  opts.include_untracked(true)
    .recurse_untracked_dirs(true)
    // Ignored paths are wanted for the Explorer's decoration, not for the panel's two lists, and
    // they are reported one entry per ignored *directory* rather than one per file inside it —
    // `recurse_ignored_dirs` stays off, which is what keeps `node_modules` a single path.
    .include_ignored(true)
    .recurse_ignored_dirs(false)
    // A staged rename is cheap to detect and makes the staged list read like `git status`.
    // Working-tree renames are not asked for: they cost a full content comparison on every
    // refresh, and a delete plus an add is an honest answer for a change not staged yet.
    .renames_head_to_index(true)
    .renames_index_to_workdir(false);
  let statuses = opened
    .repo
    .statuses(Some(&mut opts))
    .map_err(|e| fail("status", e))?;

  let mut files = Vec::new();
  let mut staged = 0;
  let mut changed = 0;
  let mut untracked = 0;
  let mut conflicted = 0;
  let mut ignored = 0;
  let mut truncated = false;

  for entry in statuses.iter() {
    let flags = entry.status();
    if flags.is_empty() {
      continue;
    }
    if files.len() >= MAX_STATUS_ENTRIES {
      truncated = true;
      break;
    }
    let rel = String::from_utf8_lossy(entry.path_bytes()).replace('\\', "/");
    let conflicted_entry = flags.contains(GitStatus::CONFLICTED);
    let kind = if flags.contains(GitStatus::IGNORED) {
      ignored += 1;
      "ignored"
    } else if conflicted_entry {
      conflicted += 1;
      "conflicted"
    } else if flags.contains(GitStatus::WT_NEW) && !flags.contains(GitStatus::INDEX_NEW) {
      untracked += 1;
      "untracked"
    } else {
      "tracked"
    };
    if kind == "ignored" && ignored > MAX_IGNORED_ENTRIES {
      // Counted but not carried: the ceiling exists so a large ignore file cannot crowd the
      // changed paths out of the same answer.
      continue;
    }
    let index = index_letter(flags);
    let workdir = workdir_letter(flags);
    if index.is_some() {
      staged += 1;
    }
    if workdir.is_some() && !conflicted_entry {
      changed += 1;
    }
    let old_path = rename_from(&entry, flags);
    let submodule = entry
      .head_to_index()
      .map(|d| delta_is_submodule(&d))
      .or_else(|| entry.index_to_workdir().map(|d| delta_is_submodule(&d)))
      .unwrap_or(false);
    let path = PathBuf::from(&rel);
    files.push(StatusEntry {
      abs: abs_of(&opened, &path),
      path: git_path(&path),
      old_path,
      index,
      workdir,
      kind: kind.to_string(),
      submodule,
    });
  }

  files.sort_by(|a, b| a.path.cmp(&b.path));
  Ok(StatusView {
    repo: info,
    files,
    staged,
    changed,
    untracked,
    conflicted,
    truncated,
  })
}

fn delta_is_submodule(delta: &git2::DiffDelta<'_>) -> bool {
  delta.old_file().mode() == FileMode::Commit || delta.new_file().mode() == FileMode::Commit
}

fn rename_from(entry: &git2::StatusEntry<'_>, flags: GitStatus) -> Option<String> {
  if !flags.intersects(GitStatus::INDEX_RENAMED | GitStatus::WT_RENAMED) {
    return None;
  }
  let delta = entry
    .head_to_index()
    .filter(|d| d.status() == git2::Delta::Renamed)
    .or_else(|| {
      entry
        .index_to_workdir()
        .filter(|d| d.status() == git2::Delta::Renamed)
    })?;
  let old = delta.old_file().path()?;
  Some(git_path(old))
}

fn index_letter(flags: GitStatus) -> Option<String> {
  let letter = if flags.contains(GitStatus::INDEX_RENAMED) {
    "R"
  } else if flags.contains(GitStatus::INDEX_NEW) {
    "A"
  } else if flags.contains(GitStatus::INDEX_MODIFIED) {
    "M"
  } else if flags.contains(GitStatus::INDEX_DELETED) {
    "D"
  } else if flags.contains(GitStatus::INDEX_TYPECHANGE) {
    "T"
  } else {
    return None;
  };
  Some(letter.to_string())
}

fn workdir_letter(flags: GitStatus) -> Option<String> {
  let letter = if flags.contains(GitStatus::WT_NEW) {
    "?"
  } else if flags.contains(GitStatus::WT_RENAMED) {
    "R"
  } else if flags.contains(GitStatus::WT_MODIFIED) {
    "M"
  } else if flags.contains(GitStatus::WT_DELETED) {
    "D"
  } else if flags.contains(GitStatus::WT_TYPECHANGE) {
    "T"
  } else {
    return None;
  };
  Some(letter.to_string())
}

/// Whether the working tree has changes that a checkout or merge could collide with.
/// Untracked files do not count: they do not belong to any tree yet, and a safe checkout will
/// refuse only if one of them is actually in the way.
pub(crate) fn is_dirty(repo: &git2::Repository) -> Result<bool, String> {
  let mut opts = StatusOptions::new();
  opts.include_untracked(false).include_ignored(false);
  let statuses = repo
    .statuses(Some(&mut opts))
    .map_err(|e| fail("status", e))?;
  Ok(!statuses.is_empty())
}
