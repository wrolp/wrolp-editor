//! Index and working-tree edits: stage, unstage, discard.
//!
//! Every command here takes repository paths from the status list, so a path outside the work
//! tree is refused rather than acted on. Discarding a tracked file checks the index version back
//! out over the working copy, which is exactly `git checkout -- <path>`; an untracked file is
//! deleted. Neither ever runs on a conflicted path — those go through the merge resolution flow,
//! where the user chooses a side.

use git2::build::CheckoutBuilder;
use git2::{Commit, Repository, Status as GitStatus, StatusOptions};
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use tauri::{AppHandle, State};

use super::auth::{AuthStore, Identity};
use super::{conflict_paths, discover, fail, git_path, rel_of, short_oid, signature, GitLocks};

#[tauri::command]
pub fn git_stage(
  root: String,
  paths: Vec<String>,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  stage(&root, &paths, &locks)
}

pub(crate) fn stage(root: &str, paths: &[String], locks: &GitLocks) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let mut index = opened.repo.index().map_err(|e| fail("index", e))?;
  for path in paths {
    let rel = rel_of(&opened.workdir, path)?;
    let abs = opened.workdir.join(&rel);
    // A path that is gone is a deletion, and exists() on a broken symlink is false: both are
    // staged by removing the entry rather than adding a file that is not there.
    if abs.exists() {
      index.add_path(&rel).map_err(|e| fail("stage", e))?;
    } else {
      index.remove_path(&rel).map_err(|e| fail("stage", e))?;
    }
  }
  index.write().map_err(|e| fail("stage", e))?;
  Ok(())
}

#[tauri::command]
pub fn git_unstage(
  root: String,
  paths: Vec<String>,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  unstage(&root, &paths, &locks)
}

pub(crate) fn unstage(root: &str, paths: &[String], locks: &GitLocks) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let head = opened
    .repo
    .head()
    .ok()
    .and_then(|reference| reference.peel_to_commit().ok());

  match head {
    Some(commit) => {
      let object = commit.as_object();
      // A staged rename is two index entries: the add at the new path and the delete at the
      // old one. Resetting only the row the panel clicked would leave the deletion staged and
      // the rename half undone, so both sides are reset together.
      let renames = staged_renames(&opened.repo);
      for path in paths {
        let rel = rel_of(&opened.workdir, path)?;
        let rel_text = git_path(&rel);
        let mut targets = vec![rel_text.clone()];
        if let Some(old) = renames.get(&rel_text) {
          targets.push(old.clone());
        }
        for target in targets {
          opened
            .repo
            .reset_default(Some(object), [Path::new(&target)])
            .map_err(|e| fail("unstage", e))?;
        }
      }
      // reset_default rewrites the index of the repository, not the copy taken above, and an
      // unborn repository has no tree to reset to at all.
      let mut index = opened.repo.index().map_err(|e| fail("index", e))?;
      index.write().map_err(|e| fail("unstage", e))?;
    }
    None => {
      let mut index = opened.repo.index().map_err(|e| fail("index", e))?;
      for path in paths {
        let rel = rel_of(&opened.workdir, path)?;
        let rel_text = git_path(&rel);
        index
          .remove_path(Path::new(&rel_text))
          .map_err(|e| fail("unstage", e))?;
      }
      index.write().map_err(|e| fail("unstage", e))?;
    }
  }
  Ok(())
}

/// Staged renames as `new path -> old path`, read from the same status the panel shows.
fn staged_renames(repo: &Repository) -> HashMap<String, String> {
  let mut out = HashMap::new();
  let mut options = StatusOptions::new();
  options
    .include_untracked(false)
    .include_ignored(false)
    .renames_head_to_index(true);
  let Ok(statuses) = repo.statuses(Some(&mut options)) else {
    return out;
  };
  for entry in statuses.iter() {
    if !entry.status().contains(GitStatus::INDEX_RENAMED) {
      continue;
    }
    let Some(delta) = entry.head_to_index() else {
      continue;
    };
    if delta.status() != git2::Delta::Renamed {
      continue;
    }
    let (Some(new), Some(old)) = (delta.new_file().path(), delta.old_file().path()) else {
      continue;
    };
    out.insert(git_path(new), git_path(old));
  }
  out
}

/// Throw away the working-tree side of a change. The staged side is left alone: the panel only
/// offers this on the unstaged list, and keeping it to one meaning means a user who wanted both
/// can discard twice with the unstage in between and see what happened.
#[tauri::command]
pub fn git_discard(
  root: String,
  paths: Vec<String>,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  discard(&root, &paths, &locks)
}

pub(crate) fn discard(root: &str, paths: &[String], locks: &GitLocks) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let conflicts = conflict_paths(&opened.repo.index().map_err(|e| fail("index", e))?)?;
  let index = opened.repo.index().map_err(|e| fail("index", e))?;

  let mut checkout = CheckoutBuilder::new();
  checkout.force();
  let mut tracked = false;
  for path in paths {
    let rel = rel_of(&opened.workdir, path)?;
    let rel_text = git_path(&rel);
    if conflicts.iter().any(|c| c == &rel_text) {
      return Err("git_conflicted".into());
    }
    if index.get_path(Path::new(&rel_text), 0).is_some() {
      checkout.path(rel_text.as_str());
      tracked = true;
    } else {
      let abs = opened.workdir.join(&rel);
      match fs::symlink_metadata(&abs) {
        Ok(meta) if meta.is_dir() => return Err("git_discard_dir".into()),
        Ok(_) => fs::remove_file(&abs).map_err(|e| format!("git_discard:{e}"))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(format!("git_discard:{e}")),
      }
    }
  }
  if tracked {
    opened
      .repo
      .checkout_index(None, Some(&mut checkout))
      .map_err(|e| fail("discard", e))?;
  }
  Ok(())
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitResult {
  pub oid: String,
  pub short: String,
  pub summary: String,
}

/// Commit what is staged. Nothing is added on the way: a file the user did not stage stays out,
/// which is the whole reason the panel has two lists.
#[tauri::command]
pub fn git_commit(
  app: AppHandle,
  root: String,
  message: String,
  locks: State<'_, GitLocks>,
) -> Result<CommitResult, String> {
  // A damaged credential file must not stop a commit the repository itself can sign; the
  // fallback identity is a convenience, not a requirement.
  let identity = AuthStore::load(&app).ok().and_then(|store| store.identity);
  commit(&root, &message, identity.as_ref(), &locks)
}

pub(crate) fn commit(
  root: &str,
  message: &str,
  identity: Option<&Identity>,
  locks: &GitLocks,
) -> Result<CommitResult, String> {
  let message = message.trim();
  if message.is_empty() {
    return Err("git_empty_message".into());
  }
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let repo = &opened.repo;
  // A merge commit is the one state where committing is the way forward. Any other unfinished
  // operation (rebase, cherry-pick, …) has its own continuation this panel does not implement,
  // and a plain commit there would leave that state half-finished.
  if !matches!(
    repo.state(),
    git2::RepositoryState::Clean | git2::RepositoryState::Merge
  ) {
    return Err("git_state_busy".into());
  }

  let head = match repo.head() {
    Ok(reference) => Some(
      reference
        .peel_to_commit()
        .map_err(|e| fail("head", e))?,
    ),
    Err(e) if e.code() == git2::ErrorCode::UnbornBranch => None,
    Err(e) => return Err(fail("head", e)),
  };
  let merge = merge_head(repo)?;

  let mut index = repo.index().map_err(|e| fail("index", e))?;
  if index.has_conflicts() {
    return Err("git_conflicted".into());
  }
  if head.is_none() && merge.is_none() && index.is_empty() {
    return Err("git_nothing_staged".into());
  }
  let tree_oid = index.write_tree().map_err(|e| fail("commit", e))?;
  let tree = repo.find_tree(tree_oid).map_err(|e| fail("tree", e))?;
  // A hand commit that would not change the tree is almost always a forgotten `git add`; an
  // empty merge commit, on the other hand, is how git records that the branches met.
  if merge.is_none() {
    if let Some(head) = &head {
      if head.tree_id() == tree_oid {
        return Err("git_nothing_staged".into());
      }
    }
  }

  let author = signature(repo, identity)?;
  let mut parents: Vec<&Commit<'_>> = Vec::new();
  if let Some(head) = &head {
    parents.push(head);
  }
  if let Some(merge) = &merge {
    parents.push(merge);
  }
  let oid = repo
    .commit(Some("HEAD"), &author, &author, message, &tree, &parents)
    .map_err(|e| fail("commit", e))?;
  if merge.is_some() {
    // The commit exists now; failing to clear the state would only make the panel keep showing a
    // merge that is finished, so it is not allowed to turn a successful commit into an error.
    let _ = repo.cleanup_state();
  }
  let summary = message.lines().next().unwrap_or(message).to_string();
  Ok(CommitResult {
    oid: oid.to_string(),
    short: short_oid(oid),
    summary,
  })
}

/// The commit a merge in progress will take as its second parent. Only the first MERGE_HEAD is
/// read: an octopus merge is not something this panel can create, and pretending to finish one
/// would be worse than refusing it.
fn merge_head<'repo>(repo: &'repo Repository) -> Result<Option<Commit<'repo>>, String> {
  match repo.find_reference("MERGE_HEAD") {
    Ok(reference) => Ok(Some(
      reference.peel_to_commit().map_err(|e| fail("commit", e))?,
    )),
    Err(_) => Ok(None),
  }
}
