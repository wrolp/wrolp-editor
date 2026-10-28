//! Repository discovery under the group's folder.
//!
//! The Source Control panel can show more than one repository: the one the folder sits in
//! (possibly above it), repositories in its subdirectories, and repositories the user added by
//! hand. This module owns the first two.
//!
//! Rules, in the order they matter:
//!
//! - `depth` counts directory levels below the group folder: 0 is the folder itself, 1 its
//!   direct children, 2 children of those (the default).
//! - At level 0 a repository does not stop the walk, so a repository that itself contains other
//!   repositories still has them found. From level 1 on, a repository is a boundary and is not
//!   entered: a vendored clone inside a dependency is not a project.
//! - Only a `.git` **directory** is recognised while scanning. Submodules and linked worktrees
//!   use a `.git` file; they are left to "add repository" rather than listed as separate projects
//!   and confused with the parent repository they belong to.
//! - Bare repositories, ignored folders (`node_modules`, `target`, `dist`) and links/junctions
//!   are skipped. Links are skipped to keep cycles and duplicates out of the walk.
//!
//! The result is cosmetic and disposable: it is never persisted. Manual repositories are stored
//! with their group and merged in by the frontend.

use git2::{ErrorCode, Repository};
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};

use super::fail;

/// How many directories one scan may visit. A workspace on a network share can hold more
/// directories than a person can need; the panel says the answer was cut short instead of
/// freezing.
pub const MAX_SCAN_DIRS: usize = 5000;
/// How many repositories one scan returns.
pub const MAX_SCAN_REPOS: usize = 50;
/// The highest depth the settings accept; the frontend clamps too.
pub const MAX_SCAN_DEPTH: u32 = 5;

const IGNORED: [&str; 4] = [".git", "node_modules", "target", "dist"];

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoEntry {
  /// The work tree, in the spelling the filesystem uses.
  pub root: String,
  pub git_dir: String,
  /// The work tree's own folder name.
  pub name: String,
  /// Where it sits relative to the group folder: `.`, `../name`, or `packages/app`.
  pub relative: String,
  /// `root`, `parent` or `scan`. Manual entries are merged in by the frontend.
  pub source: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GitScanView {
  pub repos: Vec<GitRepoEntry>,
  /// The walk hit a directory or repository limit before finishing.
  pub truncated: bool,
  pub scanned_dirs: usize,
  /// Directories that could not be read or opened; never a failure of the whole scan.
  pub skipped: usize,
}

#[tauri::command]
pub async fn git_scan_repos(root: String, depth: u32) -> Result<GitScanView, String> {
  tauri::async_runtime::spawn_blocking(move || scan_repos(&root, depth))
    .await
    .map_err(|e| format!("git_scan:{e}"))?
}

pub(crate) fn scan_repos(root: &str, depth: u32) -> Result<GitScanView, String> {
  if root.trim().is_empty() {
    return Err("git_no_folder".into());
  }
  let root_path = PathBuf::from(crate::draft::normalize_path_preserved(root));
  if !root_path.is_dir() {
    return Err("git_no_folder".into());
  }
  let depth = depth.min(MAX_SCAN_DEPTH);

  let mut entries: Vec<GitRepoEntry> = Vec::new();
  let mut seen: HashSet<String> = HashSet::new();
  let mut truncated = false;
  let mut skipped = 0usize;

  // The folder itself, or the repository above it. This preserves the single-repository
  // behaviour for a group whose folder is a subfolder of a repository.
  match Repository::discover(&root_path) {
    Ok(repo) if !repo.is_bare() => {
      if let Some(workdir) = repo.workdir() {
        let same = path_key(workdir) == path_key(&root_path);
        let source = if same { "root" } else { "parent" };
        if let Some(entry) = entry_for(&repo, workdir, &root_path, source) {
          if seen.insert(path_key(workdir)) {
            entries.push(entry);
          }
        }
      }
    }
    Ok(_) => {}
    Err(error) if error.code() == ErrorCode::NotFound => {}
    Err(error) => return Err(fail("scan", error)),
  }

  let mut queue: VecDeque<(PathBuf, u32)> = VecDeque::new();
  queue.push_back((root_path.clone(), 0));
  let mut scanned_dirs = 0usize;

  'walk: while let Some((dir, level)) = queue.pop_front() {
    if scanned_dirs >= MAX_SCAN_DIRS {
      truncated = true;
      break;
    }
    scanned_dirs += 1;

    let git_meta = dir.join(".git");
    if level > 0 && git_meta.exists() {
      // A `.git` file means a submodule or linked worktree: boundary, but not a project of its
      // own here. A directory is a repository this scan should list.
      if git_meta.is_dir() {
        match Repository::open(&dir) {
          Ok(repo) if !repo.is_bare() => {
            if let Some(workdir) = repo.workdir() {
              if let Some(entry) = entry_for(&repo, workdir, &root_path, "scan") {
                if seen.insert(path_key(workdir)) {
                  if entries.len() >= MAX_SCAN_REPOS {
                    truncated = true;
                    break 'walk;
                  }
                  entries.push(entry);
                }
              }
            }
          }
          Ok(_) => {}
          Err(_) => skipped += 1,
        }
      }
      continue;
    }

    if level >= depth {
      continue;
    }

    let Ok(read) = fs::read_dir(&dir) else {
      skipped += 1;
      continue;
    };
    let mut children: Vec<PathBuf> = Vec::new();
    for item in read.flatten() {
      let name = item.file_name().to_string_lossy().to_string();
      if IGNORED.iter().any(|ignored| name.eq_ignore_ascii_case(ignored)) {
        continue;
      }
      let path = item.path();
      let Ok(metadata) = fs::symlink_metadata(&path) else {
        continue;
      };
      if !metadata.is_dir() || link_like(&metadata) {
        continue;
      }
      children.push(path);
    }
    children.sort_by(|a, b| {
      crate::name_order::natural_cmp(
        &a.file_name().unwrap_or_default().to_string_lossy(),
        &b.file_name().unwrap_or_default().to_string_lossy(),
      )
    });
    for child in children {
      if queue.len() + scanned_dirs >= MAX_SCAN_DIRS {
        truncated = true;
        break 'walk;
      }
      queue.push_back((child, level + 1));
    }
  }

  entries.sort_by(|a, b| {
    let rank = source_rank(&a.source).cmp(&source_rank(&b.source));
    rank.then_with(|| crate::name_order::natural_cmp(&a.relative, &b.relative))
  });
  Ok(GitScanView {
    repos: entries,
    truncated,
    scanned_dirs,
    skipped,
  })
}

fn entry_for(repo: &Repository, workdir: &Path, root: &Path, source: &str) -> Option<GitRepoEntry> {
  let root_text = crate::draft::normalize_path_preserved(&workdir.to_string_lossy());
  let name = workdir
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .unwrap_or_else(|| root_text.clone());
  let relative = match source {
    "parent" => format!("../{name}"),
    "root" => ".".to_string(),
    _ => workdir
      .strip_prefix(root)
      .ok()
      .map(|tail| {
        let text = tail.to_string_lossy().replace('\\', "/");
        if text.is_empty() {
          ".".to_string()
        } else {
          text
        }
      })
      .unwrap_or_else(|| root_text.clone()),
  };
  let git_dir = crate::draft::normalize_path_preserved(&repo.path().to_string_lossy());
  Some(GitRepoEntry {
    root: root_text,
    git_dir,
    name,
    relative,
    source: source.to_string(),
  })
}

fn source_rank(source: &str) -> u8 {
  match source {
    "parent" => 0,
    "root" => 1,
    _ => 2,
  }
}

fn path_key(path: &Path) -> String {
  crate::draft::normalize_path(&path.to_string_lossy())
}

/// A symlink or a Windows reparse point (junction included). Walking either can loop or list
/// the same repository twice under two spellings.
fn link_like(metadata: &fs::Metadata) -> bool {
  if metadata.file_type().is_symlink() {
    return true;
  }
  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
      return true;
    }
  }
  false
}
