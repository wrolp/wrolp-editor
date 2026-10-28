//! Branch list and checkout.
//!
//! Switching is refused while the index or the working tree has changes. A safe checkout would
//! usually refuse by itself, but only for the files that actually collide; a branch switch that
//! half-succeeds is worse than one that says "commit or discard first", so the whole operation is
//! gated on a clean tree.

use git2::build::CheckoutBuilder;
use git2::{BranchType, Repository};
use serde::Serialize;
use tauri::State;

use super::status::is_dirty;
use super::{discover, fail, short_oid, GitLocks};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
  /// `main` for a local branch, `origin/main` for a remote-tracking one.
  pub name: String,
  pub remote: bool,
  pub current: bool,
  pub short: Option<String>,
  pub upstream: Option<String>,
}

#[tauri::command]
pub fn git_branches(root: String) -> Result<Vec<BranchInfo>, String> {
  branches_of(&root)
}

pub(crate) fn branches_of(root: &str) -> Result<Vec<BranchInfo>, String> {
  let opened = discover(root)?;
  let current = opened
    .repo
    .head()
    .ok()
    .and_then(|head| head.shorthand().ok().map(str::to_string));
  let mut out = Vec::new();
  for kind in [BranchType::Local, BranchType::Remote] {
    let branches = opened
      .repo
      .branches(Some(kind))
      .map_err(|e| fail("branches", e))?;
    for item in branches {
      let (branch, _) = item.map_err(|e| fail("branches", e))?;
      let Ok(Some(name)) = branch.name() else {
        continue;
      };
      // `origin/HEAD` is a pointer to another remote branch, not a branch to check out.
      if kind == BranchType::Remote && name.ends_with("/HEAD") {
        continue;
      }
      let short = branch.get().target().map(short_oid);
      let upstream = branch
        .upstream()
        .ok()
        .and_then(|up| up.get().name().ok().map(str::to_string))
        .and_then(|full| full.strip_prefix("refs/remotes/").map(str::to_string));
      out.push(BranchInfo {
        name: name.to_string(),
        remote: kind == BranchType::Remote,
        current: kind == BranchType::Local && current.as_deref() == Some(name),
        short,
        upstream,
      });
    }
  }
  out.sort_by(|a, b| (a.remote, &a.name).cmp(&(b.remote, &b.name)));
  Ok(out)
}

#[tauri::command]
pub fn git_create_branch(
  root: String,
  name: String,
  checkout: bool,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  create_branch(&root, &name, checkout, &locks)
}

pub(crate) fn create_branch(
  root: &str,
  name: &str,
  checkout: bool,
  locks: &GitLocks,
) -> Result<(), String> {
  let name = name.trim();
  if name.is_empty() {
    return Err("git_branch_name".into());
  }
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  if checkout {
    if opened.repo.state() != git2::RepositoryState::Clean {
      return Err("git_state_busy".into());
    }
    if is_dirty(&opened.repo)? {
      return Err("git_dirty".into());
    }
  }
  let head = opened
    .repo
    .head()
    .and_then(|reference| reference.peel_to_commit())
    .map_err(|e| {
      if e.code() == git2::ErrorCode::UnbornBranch {
        "git_unborn".to_string()
      } else {
        fail("branch", e)
      }
    })?;
  opened
    .repo
    .branch(name, &head, false)
    .map_err(|e| fail("branch", e))?;
  if checkout {
    switch_to(&opened.repo, name)?;
  }
  Ok(())
}

#[tauri::command]
pub fn git_switch_branch(
  root: String,
  name: String,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  switch_branch(&root, &name, &locks)
}

pub(crate) fn switch_branch(root: &str, name: &str, locks: &GitLocks) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  if opened.repo.state() != git2::RepositoryState::Clean {
    return Err("git_state_busy".into());
  }
  if let Ok(branch) = opened.repo.find_branch(name, BranchType::Local) {
    if branch.is_head() {
      return Ok(());
    }
    if is_dirty(&opened.repo)? {
      return Err("git_dirty".into());
    }
    return switch_to(&opened.repo, name);
  }
  // A name like `origin/feature` is a remote-tracking branch: checking it out means making
  // a local branch of its own and pointing it at the remote one.
  checkout_remote(&opened.repo, name)
}

fn checkout_remote(repo: &Repository, name: &str) -> Result<(), String> {
  let remotes = repo.remotes().map_err(|e| fail("remote", e))?;
  let mut found: Option<(String, String)> = None;
  for index in 0..remotes.len() {
    let Ok(Some(remote)) = remotes.get(index) else {
      continue;
    };
    if let Some(short) = name.strip_prefix(&format!("{remote}/")) {
      found = Some((remote.to_string(), short.to_string()));
      break;
    }
  }
  let Some((remote, short)) = found else {
    return Err("git_branch_missing".into());
  };
  let tracking = format!("refs/remotes/{remote}/{short}");
  let reference = repo
    .find_reference(&tracking)
    .map_err(|_| "git_branch_missing".to_string())?;
  if repo.find_branch(&short, BranchType::Local).is_ok() {
    return Err("git_branch_exists".into());
  }
  if is_dirty(repo)? {
    return Err("git_dirty".into());
  }
  let commit = reference
    .peel_to_commit()
    .map_err(|e| fail("rev", e))?;
  let mut branch = repo
    .branch(&short, &commit, false)
    .map_err(|e| fail("branch", e))?;
  branch
    .set_upstream(Some(&format!("{remote}/{short}")))
    .map_err(|e| fail("branch", e))?;
  if let Err(error) = switch_to(repo, &short) {
    // The branch was made only for this checkout; a failed checkout should not leave it behind.
    let _ = branch.delete();
    return Err(error);
  }
  Ok(())
}

#[tauri::command]
pub fn git_delete_branch(
  root: String,
  name: String,
  force: bool,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  delete_branch(&root, &name, force, &locks)
}

pub(crate) fn delete_branch(
  root: &str,
  name: &str,
  force: bool,
  locks: &GitLocks,
) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let mut branch = opened
    .repo
    .find_branch(name, BranchType::Local)
    .map_err(|_| "git_branch_missing".to_string())?;
  if branch.is_head() {
    return Err("git_branch_current".into());
  }
  if !force && !is_merged(&opened.repo, &branch) {
    // `git branch -d` refuses this; deleting anyway is what `-D` means, and it should be a
    // second, explicit answer rather than one click on a generic confirmation.
    return Err("git_branch_unmerged".into());
  }
  branch.delete().map_err(|e| fail("branch", e))?;
  Ok(())
}

/// Whether a branch's tip is already reachable from HEAD or from its upstream. A branch with an
/// upstream counts as merged when the upstream contains its tip, which is the rule git uses.
fn is_merged(repo: &Repository, branch: &git2::Branch<'_>) -> bool {
  let Some(tip) = branch.get().target() else {
    return false;
  };
  if let Some(head) = repo.head().ok().and_then(|head| head.target()) {
    // Equality is not "descendant of": a branch sitting exactly on HEAD is merged.
    if head == tip || repo.graph_descendant_of(head, tip).unwrap_or(false) {
      return true;
    }
  }
  branch
    .upstream()
    .ok()
    .and_then(|upstream| upstream.get().target())
    .map(|upstream_tip| repo.graph_descendant_of(upstream_tip, tip).unwrap_or(false))
    .unwrap_or(false)
}

/// Move HEAD to a local branch and check its tree out. The old HEAD is restored if the checkout
/// fails partway, so a collision with an untracked file does not leave the repository on a branch
/// whose files are not on disk.
fn switch_to(repo: &Repository, name: &str) -> Result<(), String> {
  let refname = format!("refs/heads/{name}");
  let old = repo.head().ok().and_then(|h| h.name().ok().map(str::to_string));
  repo.set_head(&refname).map_err(|e| fail("switch", e))?;
  let mut checkout = CheckoutBuilder::new();
  checkout.safe();
  if let Err(e) = repo.checkout_head(Some(&mut checkout)) {
    if let Some(old) = old {
      let _ = repo.set_head(&old);
    }
    return Err(fail("switch", e));
  }
  Ok(())
}
