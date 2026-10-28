//! Commit log and the file list of one commit.
//!
//! The log is read page by page: a repository with a long history must not make the panel wait
//! for all of it, and the first screen only ever needs the newest commits.

use git2::{Commit, Delta, Sort};
use serde::Serialize;
use std::path::Path;

use super::{abs_of, discover, fail, git_path, iso_time, short_oid, MAX_STATUS_ENTRIES};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
  pub oid: String,
  pub short: String,
  pub summary: String,
  pub message: String,
  pub author: String,
  pub email: String,
  /// ISO-8601 in UTC, formatted by the same reader as the version timeline.
  pub time: String,
  pub parents: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitFile {
  pub path: String,
  pub old_path: Option<String>,
  /// A, M, D, R, C, T, U or X.
  pub status: String,
  pub abs: String,
}

#[tauri::command]
pub fn git_log(
  root: String,
  limit: Option<u32>,
  skip: Option<u32>,
) -> Result<Vec<LogEntry>, String> {
  log_page(&root, limit, skip)
}

pub(crate) fn log_page(
  root: &str,
  limit: Option<u32>,
  skip: Option<u32>,
) -> Result<Vec<LogEntry>, String> {
  let opened = discover(root)?;
  let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
  let skip = skip.unwrap_or(0) as usize;
  let mut walk = opened.repo.revwalk().map_err(|e| fail("log", e))?;
  if walk.push_head().is_err() {
    // Unborn HEAD: there is no first commit yet, which is an empty timeline, not an error.
    return Ok(Vec::new());
  }
  // Time alone leaves commits made within the same second in whatever order the walker
  // reached them; topology keeps a linear history strictly parent-after-child, so `git log`
  // order is the one the user expects even for a burst of commits.
  walk
    .set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
    .map_err(|e| fail("log", e))?;

  let mut out = Vec::new();
  for (index, oid) in walk.enumerate() {
    if index < skip {
      continue;
    }
    if out.len() >= limit {
      break;
    }
    let oid = oid.map_err(|e| fail("log", e))?;
    let commit = opened.repo.find_commit(oid).map_err(|e| fail("log", e))?;
    out.push(entry(&commit));
  }
  Ok(out)
}

/// The paths a commit changed against its first parent. A root commit has no parent to be
/// compared with, so every path it holds is shown as added.
#[tauri::command]
pub fn git_commit_files(root: String, rev: String) -> Result<Vec<CommitFile>, String> {
  commit_files(&root, &rev)
}

pub(crate) fn commit_files(root: &str, rev: &str) -> Result<Vec<CommitFile>, String> {
  let opened = discover(root)?;
  let commit = opened
    .repo
    .revparse_single(rev)
    .and_then(|object| object.peel_to_commit())
    .map_err(|e| fail("rev", e))?;
  let tree = commit.tree().map_err(|e| fail("tree", e))?;
  let parent_tree = commit
    .parent(0)
    .ok()
    .and_then(|parent| parent.tree().ok());
  let diff = opened
    .repo
    .diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), None)
    .map_err(|e| fail("diff", e))?;

  let mut files = Vec::new();
  for (index, delta) in diff.deltas().enumerate() {
    if index >= MAX_STATUS_ENTRIES {
      break;
    }
    let Some(path) = delta.new_file().path().map(git_path) else {
      continue;
    };
    let old_path = delta.old_file().path().map(git_path).filter(|old| old != &path);
    files.push(CommitFile {
      abs: abs_of(&opened, Path::new(&path)),
      status: delta_letter(delta.status()).to_string(),
      old_path,
      path,
    });
  }
  files.sort_by(|a, b| a.path.cmp(&b.path));
  Ok(files)
}

fn entry(commit: &Commit<'_>) -> LogEntry {
  let author = commit.author();
  LogEntry {
    oid: commit.id().to_string(),
    short: short_oid(commit.id()),
    summary: commit
      .summary()
      .ok()
      .flatten()
      .unwrap_or_default()
      .to_string(),
    message: commit.message().unwrap_or_default().to_string(),
    author: author.name().unwrap_or("").to_string(),
    email: author.email().unwrap_or("").to_string(),
    time: iso_time(commit.time().seconds()),
    parents: commit.parent_ids().map(|id| id.to_string()).collect(),
  }
}

fn delta_letter(delta: Delta) -> &'static str {
  match delta {
    Delta::Added | Delta::Untracked => "A",
    Delta::Deleted => "D",
    Delta::Modified => "M",
    Delta::Renamed => "R",
    Delta::Copied => "C",
    Delta::Typechange => "T",
    Delta::Conflicted => "U",
    _ => "X",
  }
}
