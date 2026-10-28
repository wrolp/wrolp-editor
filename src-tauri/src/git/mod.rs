//! Real git repositories, for the Source Control panel.
//!
//! Kept apart from [`crate::versioning`]: that module keeps a private shadow store with one bare
//! repository per file, and the user never sees a commit from it. This module is the opposite —
//! the repository the user's own `git status` would show. Nothing here reads or writes the shadow
//! store, and the version history never sees these operations.
//!
//! One repository per panel: [`discover`] walks up from the group's folder like `git` itself
//! does. Nested repositories and submodules are not aggregated; a nested repository is shown the
//! way git shows it, as one changed path.

pub mod auth;
pub mod branch;
pub mod diff;
pub mod history;
pub mod index;
pub mod remote;
pub mod repos;
pub mod status;

#[cfg(test)]
mod tests;

use chrono::{TimeZone, Utc};
use git2::{BranchType, ErrorCode, Oid, Repository, RepositoryState};
use serde::Serialize;
use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

/// How many changed paths one status answer carries. A folder that is not a repository but sits
/// inside one (a home directory opened as a group, say) can produce tens of thousands of
/// untracked entries; the panel is a list to act on, not a filesystem census.
pub(crate) const MAX_STATUS_ENTRIES: usize = 5000;

/// A diff side past this size is not sent over IPC. Monaco would happily render it, but the
/// transfer and the editor models cost more than reading the two files in a terminal.
pub(crate) const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;

pub(crate) const SHORT_OID: usize = 8;

/// Repository-level mutual exclusion. Staging, committing, checking out and merging all rewrite
/// the index or the working tree, and two of those at once corrupt each other. The frontend also
/// disables buttons while an operation runs; this is the half that a second window or a stray
/// double-click cannot get around.
#[derive(Clone, Default)]
pub struct GitLocks(Arc<Mutex<HashSet<String>>>);

impl GitLocks {
  pub fn acquire(&self, workdir: &Path) -> Result<GitGuard, String> {
    let key = crate::draft::normalize_path(&workdir.to_string_lossy());
    let mut busy = self.0.lock().map_err(|_| "git_busy".to_string())?;
    if !busy.insert(key.clone()) {
      return Err("git_busy".into());
    }
    Ok(GitGuard {
      key,
      busy: Arc::clone(&self.0),
    })
  }
}

pub struct GitGuard {
  key: String,
  busy: Arc<Mutex<HashSet<String>>>,
}

impl Drop for GitGuard {
  fn drop(&mut self) {
    if let Ok(mut busy) = self.busy.lock() {
      busy.remove(&self.key);
    }
  }
}

/// An open work tree: the repository, where its files are, and the spelling of that folder the
/// panel shows. The repository is kept alive for the whole command, so the paths below are copied
/// when they are needed instead of borrowed.
pub struct Opened {
  pub repo: Repository,
  pub workdir: PathBuf,
  pub display_root: String,
}

/// Find the repository for a folder. `git_not_repo` is an answer the panel renders as an empty
/// state with an init button, not a failure the user has to decode.
pub fn discover(root: &str) -> Result<Opened, String> {
  if root.trim().is_empty() {
    return Err("git_no_folder".into());
  }
  let dir = PathBuf::from(crate::draft::normalize_path(root));
  if !dir.is_dir() {
    return Err("git_no_folder".into());
  }
  let repo = Repository::discover(&dir).map_err(|e| {
    if e.code() == ErrorCode::NotFound {
      "git_not_repo".to_string()
    } else {
      fail("discover", e)
    }
  })?;
  if repo.is_bare() {
    return Err("git_bare".into());
  }
  let workdir = repo
    .workdir()
    .ok_or_else(|| "git_bare".to_string())?
    .to_path_buf();
  let display_root = crate::draft::normalize_path_preserved(&workdir.to_string_lossy());
  Ok(Opened {
    repo,
    workdir,
    display_root,
  })
}

/// One error shape for every git call: `git_<stage>:<message>`. The frontend localizes the stage
/// (see `translateError`) and appends the message after the colon, so the stage name is the part
/// worth choosing carefully.
pub(crate) fn fail(stage: &str, e: git2::Error) -> String {
  let message = e.message().to_string();
  // A lock left by another git process is not a corrupted repository and must never be deleted
  // by this app. It gets its own sentence instead.
  if message.to_ascii_lowercase().contains("index.lock") {
    return "git_index_locked".into();
  }
  let cut: String = message.chars().take(160).collect();
  format!("git_{stage}:{cut}")
}

/// A frontend path turned into a path relative to the work tree, refusing anything outside it.
/// The comparison is case-insensitive on Windows because the caller's spelling of the drive or a
/// folder can differ from git's, and Windows would treat the two as the same file anyway.
pub(crate) fn rel_of(workdir: &Path, path: &str) -> Result<PathBuf, String> {
  let target = PathBuf::from(crate::draft::normalize_path_preserved(path));
  let base: Vec<Component> = workdir.components().collect();
  let all: Vec<Component> = target.components().collect();
  if all.len() <= base.len() {
    return Err("git_path_outside".into());
  }
  for (a, b) in base.iter().zip(all.iter()) {
    if !same_component(a, b) {
      return Err("git_path_outside".into());
    }
  }
  let rel: PathBuf = all[base.len()..].iter().collect();
  // `.` and `..` are not file names; a path carrying one is not a repository path.
  if rel
    .components()
    .any(|c| !matches!(c, Component::Normal(_)))
  {
    return Err("git_path_outside".into());
  }
  Ok(rel)
}

fn same_component(a: &Component<'_>, b: &Component<'_>) -> bool {
  #[cfg(windows)]
  {
    a.as_os_str()
      .to_string_lossy()
      .eq_ignore_ascii_case(&b.as_os_str().to_string_lossy())
  }
  #[cfg(not(windows))]
  {
    a == b
  }
}

/// A repository path as a key the frontend can hand back: forward slashes, as git reports them.
pub(crate) fn git_path(rel: &Path) -> String {
  rel.to_string_lossy().replace('\\', "/")
}

/// The absolute path the editor opens for a repository path, in the folder's own spelling.
pub(crate) fn abs_of(opened: &Opened, rel: &Path) -> String {
  let abs = opened.workdir.join(rel);
  crate::draft::normalize_path_preserved(&abs.to_string_lossy())
}

pub(crate) fn short_oid(oid: Oid) -> String {
  oid.to_string().chars().take(SHORT_OID).collect()
}

/// The author/committer of a commit this app creates. The repository's own `user.name` and
/// `user.email` win; the app-level identity is only a fallback for a repository configured with
/// neither, and no commit is invented under a made-up person when both are absent.
pub(crate) fn signature(
  repo: &Repository,
  fallback: Option<&auth::Identity>,
) -> Result<git2::Signature<'static>, String> {
  if let Ok(signature) = repo.signature() {
    return Ok(signature);
  }
  match fallback {
    Some(identity) => git2::Signature::now(&identity.name, &identity.email)
      .map_err(|_| "git_no_identity".to_string()),
    None => Err("git_no_identity".into()),
  }
}

/// Paths the index holds conflict stages for, as repository paths.
pub(crate) fn conflict_paths(index: &git2::Index) -> Result<Vec<String>, String> {
  if !index.has_conflicts() {
    return Ok(Vec::new());
  }
  let mut out = Vec::new();
  let conflicts = index.conflicts().map_err(|e| fail("index", e))?;
  for conflict in conflicts {
    let conflict = conflict.map_err(|e| fail("index", e))?;
    let entry = conflict
      .our
      .as_ref()
      .or(conflict.their.as_ref())
      .or(conflict.ancestor.as_ref());
    if let Some(entry) = entry {
      out.push(String::from_utf8_lossy(&entry.path).replace('\\', "/"));
    }
  }
  Ok(out)
}

/// Network operations in flight, so the panel's Cancel button can reach the transfer callback.
/// Keyed by an id the frontend generates per invocation.
#[derive(Clone, Default)]
pub struct GitOps(Arc<Mutex<std::collections::HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>);

impl GitOps {
  pub fn begin(&self, id: &str) -> Result<Arc<std::sync::atomic::AtomicBool>, String> {
    let mut map = self.0.lock().map_err(|_| "git_busy".to_string())?;
    if map.contains_key(id) {
      return Err("git_busy".into());
    }
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    map.insert(id.to_string(), Arc::clone(&flag));
    Ok(flag)
  }

  pub fn end(&self, id: &str) {
    if let Ok(mut map) = self.0.lock() {
      map.remove(id);
    }
  }

  pub fn cancel(&self, id: &str) {
    if let Ok(map) = self.0.lock() {
      if let Some(flag) = map.get(id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
      }
    }
  }
}

#[tauri::command]
pub fn git_cancel(ops: tauri::State<'_, GitOps>, op_id: String) {
  ops.cancel(&op_id);
}

pub(crate) fn iso_time(seconds: i64) -> String {
  Utc.timestamp_opt(seconds, 0)
    .single()
    .map(|t| t.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
    .unwrap_or_default()
}

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HeadInfo {
  pub branch: Option<String>,
  pub oid: Option<String>,
  pub short: Option<String>,
  pub detached: bool,
  /// HEAD names a branch that has no commit yet: a repository right after `git init`.
  pub unborn: bool,
  pub upstream: Option<String>,
  pub ahead: usize,
  pub behind: usize,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RepoInfo {
  /// Where the work tree is, not where the panel looked: the two differ when the group's folder
  /// sits inside a repository.
  pub root: String,
  pub git_dir: String,
  /// The folder the panel asked about, so the header can say why the root is somewhere else.
  pub requested: String,
  pub head: HeadInfo,
  /// clean | merge | revert | cherry-pick | bisect | rebase | apply-mailbox
  pub state: String,
}

pub fn repo_info(opened: &Opened, requested: &str) -> RepoInfo {
  RepoInfo {
    root: opened.display_root.clone(),
    git_dir: crate::draft::normalize_path_preserved(&opened.repo.path().to_string_lossy()),
    requested: requested.to_string(),
    head: head_info(&opened.repo),
    state: state_name(&opened.repo),
  }
}

pub(crate) fn head_info(repo: &Repository) -> HeadInfo {
  let mut info = HeadInfo::default();
  match repo.head() {
    Ok(head) => {
      info.detached = repo.head_detached().unwrap_or(false);
      if let Some(oid) = head.target() {
        info.oid = Some(oid.to_string());
        info.short = Some(short_oid(oid));
      }
      if !info.detached {
        let name = head.shorthand().ok().map(str::to_string);
        if let Some(name) = &name {
          info.branch = Some(name.clone());
        }
        if let Some(name) = name {
          upstream_of(repo, &name, &mut info);
        }
      }
    }
    Err(e) if e.code() == ErrorCode::UnbornBranch => {
      info.unborn = true;
      // An unborn HEAD is still a symbolic ref; its target is the branch the first commit will
      // land on, and showing that name is more useful than showing nothing.
      if let Ok(head) = repo.find_reference("HEAD") {
        if let Some(target) = head.symbolic_target().ok().flatten() {
          if let Some(name) = target.strip_prefix("refs/heads/") {
            info.branch = Some(name.to_string());
          }
        }
      }
    }
    Err(_) => {
      info.unborn = repo.is_empty().unwrap_or(false);
    }
  }
  info
}

fn upstream_of(repo: &Repository, branch_name: &str, info: &mut HeadInfo) {
  let Ok(branch) = repo.find_branch(branch_name, BranchType::Local) else {
    return;
  };
  let Ok(upstream) = branch.upstream() else {
    return;
  };
  let full = upstream.get().name().ok().map(str::to_string);
  info.upstream = full
    .as_deref()
    .and_then(|name| name.strip_prefix("refs/remotes/"))
    .map(str::to_string)
    .or_else(|| upstream.name().ok().flatten().map(str::to_string));
  let (Some(local), Some(remote)) = (branch.get().target(), upstream.get().target()) else {
    return;
  };
  if let Ok((ahead, behind)) = repo.graph_ahead_behind(local, remote) {
    info.ahead = ahead;
    info.behind = behind;
  }
}

pub(crate) fn state_name(repo: &Repository) -> String {
  match repo.state() {
    RepositoryState::Clean => "clean",
    RepositoryState::Merge => "merge",
    RepositoryState::Revert | RepositoryState::RevertSequence => "revert",
    RepositoryState::CherryPick | RepositoryState::CherryPickSequence => "cherry-pick",
    RepositoryState::Bisect => "bisect",
    RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge => {
      "rebase"
    }
    RepositoryState::ApplyMailbox | RepositoryState::ApplyMailboxOrRebase => "apply-mailbox",
  }
  .to_string()
}

#[tauri::command]
pub fn git_repo_info(root: String) -> Result<RepoInfo, String> {
  let opened = discover(&root)?;
  Ok(repo_info(&opened, &root))
}

/// Create a repository in the folder the panel is pointed at. The default branch name comes from
/// git's own `init.defaultBranch`, exactly as `git init` in a terminal would choose it.
#[tauri::command]
pub fn git_init(root: String) -> Result<(), String> {
  let dir = crate::draft::normalize_path(&root);
  if dir.is_empty() || !Path::new(&dir).is_dir() {
    return Err("git_no_folder".into());
  }
  Repository::init(&dir).map_err(|e| fail("init", e))?;
  Ok(())
}
