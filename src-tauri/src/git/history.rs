//! Commit log and the file list of one commit.
//!
//! The log is read page by page: a repository with a long history must not make the panel wait
//! for all of it, and the first screen only ever needs the newest commits.

use git2::{Commit, Delta, Oid, ReferenceType, Repository, Revwalk, Sort};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

use super::{abs_of, discover, fail, git_path, iso_time, short_oid, MAX_STATUS_ENTRIES};

/// A name pointing at a commit, so a graph can label its tips.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RefLabel {
  pub name: String,
  /// `head`, `local`, `remote` or `tag`.
  pub kind: String,
}

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
  /// What points here, HEAD first, then local branches, remotes and tags. Empty is ordinary: a
  /// commit in the middle of a history carries no name at all.
  pub refs: Vec<RefLabel>,
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
  all: Option<bool>,
) -> Result<Vec<LogEntry>, String> {
  log_page(&root, limit, skip, all.unwrap_or(false))
}

/// One page of the log.
///
/// `all` decides what the walk starts from: HEAD alone, or every branch, tag and remote-tracking
/// ref. The default stays HEAD-only because that is what the panel has always shown; a graph needs
/// the rest, or a merge has a second parent that was never loaded and nothing to join.
pub(crate) fn log_page(
  root: &str,
  limit: Option<u32>,
  skip: Option<u32>,
  all: bool,
) -> Result<Vec<LogEntry>, String> {
  let opened = discover(root)?;
  let limit = limit.unwrap_or(50).clamp(1, 200) as usize;
  let skip = skip.unwrap_or(0) as usize;
  let mut walk = opened.repo.revwalk().map_err(|e| fail("log", e))?;
  if !push_points(&opened.repo, &mut walk, all) {
    // Unborn HEAD and nothing else to walk: an empty timeline, not an error.
    return Ok(Vec::new());
  }
  // Time alone leaves commits made within the same second in whatever order the walker
  // reached them; topology keeps a linear history strictly parent-after-child, so `git log`
  // order is the one the user expects even for a burst of commits. A graph leans on this too:
  // a row only ever draws edges to rows below it.
  walk
    .set_sorting(Sort::TOPOLOGICAL | Sort::TIME)
    .map_err(|e| fail("log", e))?;

  let labels = ref_labels(&opened.repo);
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
    out.push(entry(
      &commit,
      labels.get(&oid).cloned().unwrap_or_default(),
    ));
  }
  Ok(out)
}

/// Every starting point of the walk: HEAD alone, or every branch, tag and remote-tracking ref.
///
/// Returns false when nothing could be pushed, which is how an unborn repository reads as an
/// empty timeline. A reference that cannot be peeled — a tag on a blob, a damaged ref — is
/// skipped rather than failing the whole page.
fn push_points(repo: &Repository, walk: &mut Revwalk<'_>, all: bool) -> bool {
  let mut pushed = walk.push_head().is_ok();
  if !all {
    return pushed;
  }
  let Ok(references) = repo.references() else {
    return pushed;
  };
  for reference in references.flatten() {
    // `origin/HEAD` and friends are symbolic: they name another ref rather than a commit, and
    // pushing one would only add a second chip to the same tip.
    if reference.kind() != Some(ReferenceType::Direct) {
      continue;
    }
    let Ok(name) = reference.name() else {
      continue;
    };
    if !(name.starts_with("refs/heads/")
      || name.starts_with("refs/remotes/")
      || name.starts_with("refs/tags/"))
    {
      continue;
    }
    // Annotated tags point at a tag object; the walk needs the commit behind it.
    let Ok(commit) = reference.peel_to_commit() else {
      continue;
    };
    if walk.push(commit.id()).is_ok() {
      pushed = true;
    }
  }
  pushed
}

/// The names each commit carries, keyed by id. Built once per call: asking per commit would walk
/// every reference once per row.
fn ref_labels(repo: &Repository) -> HashMap<Oid, Vec<RefLabel>> {
  let mut map: HashMap<Oid, Vec<RefLabel>> = HashMap::new();
  // HEAD is its own label even when it is attached: the graph draws its ring on this commit, and
  // a detached HEAD has no branch label at all to fall back on.
  if let Ok(head) = repo.head() {
    if let Ok(commit) = head.peel_to_commit() {
      push_label(&mut map, commit.id(), "HEAD", "head");
    }
  }
  if let Ok(references) = repo.references() {
    for reference in references.flatten() {
      if reference.kind() != Some(ReferenceType::Direct) {
        continue;
      }
      let Ok(name) = reference.name() else {
        continue;
      };
      let (kind, short) = if let Some(rest) = name.strip_prefix("refs/heads/") {
        ("local", rest)
      } else if let Some(rest) = name.strip_prefix("refs/remotes/") {
        ("remote", rest)
      } else if let Some(rest) = name.strip_prefix("refs/tags/") {
        ("tag", rest)
      } else {
        continue;
      };
      let Ok(commit) = reference.peel_to_commit() else {
        continue;
      };
      push_label(&mut map, commit.id(), short, kind);
    }
  }
  for labels in map.values_mut() {
    labels.sort_by(|a, b| {
      rank(&a.kind)
        .cmp(&rank(&b.kind))
        .then_with(|| a.name.cmp(&b.name))
    });
  }
  map
}

fn push_label(map: &mut HashMap<Oid, Vec<RefLabel>>, oid: Oid, name: &str, kind: &str) {
  map.entry(oid).or_default().push(RefLabel {
    name: name.to_string(),
    kind: kind.to_string(),
  });
}

/// Chip order on a row: HEAD, then the branches, then what is further away.
fn rank(kind: &str) -> u8 {
  match kind {
    "head" => 0,
    "local" => 1,
    "remote" => 2,
    _ => 3,
  }
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
  let parent_tree = commit.parent(0).ok().and_then(|parent| parent.tree().ok());
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
    let old_path = delta
      .old_file()
      .path()
      .map(git_path)
      .filter(|old| old != &path);
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

fn entry(commit: &Commit<'_>, refs: Vec<RefLabel>) -> LogEntry {
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
    refs,
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
