//! Remotes: fetch, pull, push, and the conflict resolution that a pull can leave behind.
//!
//! All of this is blocking libgit2 work; the commands run it on a blocking thread and stream
//! progress through a channel. Cancellation is cooperative — the transfer callback returns false
//! as soon as the flag is set — because libgit2 has no other way to stop a transfer.
//!
//! Credentials and host keys are read before the operation starts and captured by the callbacks.
//! A missing credential aborts with `git_auth_required:<host>` and an unknown host key with
//! `git_host_untrusted:<host>|<sha256>`; the panel turns either into a dialog and retries.

use git2::build::CheckoutBuilder;
use git2::cert::Cert;
use git2::{
  BranchType, CertificateCheckStatus, Cred, CredentialType, ErrorCode, FetchOptions, PushOptions,
  RemoteCallbacks, Repository, ResetType,
};
use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::Channel;
use tauri::{AppHandle, State};

use super::auth::{self, AuthStore, Identity};
use super::merge;
use super::status::is_dirty;
use super::{
  conflict_paths, discover, fail, git_path, rel_of, repo_info, signature, GitLocks, GitOps,
  RepoInfo, MAX_DIFF_BYTES,
};
use crate::commands::{self, SavedFile};
use crate::file_settings;
use crate::encoding;

pub(crate) type Sink = Arc<dyn Fn(GitProgress) + Send + Sync>;

#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitProgress {
  /// starting | receiving | message | merging | writing | done
  pub phase: String,
  pub received: u32,
  pub total: u32,
  pub bytes: u64,
  /// 0–100 for the transfer count; 100 for a phase that has no byte count.
  pub percent: u8,
  /// A line of server output (sideband), when there is one.
  pub text: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RemoteInfo {
  pub name: String,
  /// With any user info stripped: a URL shown on screen must not leak a token.
  pub url: String,
  pub host: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PullOutcome {
  /// up_to_date | fast_forward | merged | conflicted
  pub result: String,
  pub conflicted: Vec<String>,
  pub repo: RepoInfo,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PushOutcome {
  pub repo: RepoInfo,
  pub upstream: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConflictSides {
  pub path: String,
  pub base: Option<String>,
  pub ours: Option<String>,
  pub theirs: Option<String>,
  /// The working tree text, which is where git has already put the markers.
  pub merged: Option<String>,
  /// Any side (or the working tree) is binary: the graphical merge is not available.
  pub binary: bool,
  /// Canonical encoding name for the working tree, or the preference when it is gone.
  pub encoding: String,
  pub bom: bool,
  /// `lf`, `crlf`, or empty when the file has no break yet.
  pub eol: String,
  /// The working tree text is above the diff ceiling and was not carried.
  pub too_large: bool,
  /// What a three-way merge of the three sides produced, when it settled at least one region.
  /// Regions both sides changed differently are still marked, in git's spelling.
  pub auto_merged: Option<String>,
  /// How many regions the merge settled without asking.
  pub autosolved: usize,
}

#[tauri::command]
pub fn git_remotes(root: String) -> Result<Vec<RemoteInfo>, String> {
  let opened = discover(&root)?;
  let names = opened.repo.remotes().map_err(|e| fail("remote", e))?;
  let mut out = Vec::new();
  for index in 0..names.len() {
    let Ok(Some(name)) = names.get(index) else {
      continue;
    };
    let Ok(remote) = opened.repo.find_remote(name) else {
      continue;
    };
    let url = remote.url().map(str::to_string).unwrap_or_default();
    out.push(RemoteInfo {
      name: name.to_string(),
      host: auth::host_of(&url),
      url: display_url(&url),
    });
  }
  Ok(out)
}

#[tauri::command]
pub async fn git_fetch(
  app: AppHandle,
  ops: State<'_, GitOps>,
  locks: State<'_, GitLocks>,
  root: String,
  remote: Option<String>,
  op_id: String,
  on_progress: Channel<GitProgress>,
) -> Result<RepoInfo, String> {
  let auth = AuthStore::load(&app)?;
  let cancel = ops.begin(&op_id)?;
  let ops = ops.inner().clone();
  let locks = locks.inner().clone();
  let sink = channel_sink(on_progress);
  let joined = tauri::async_runtime::spawn_blocking(move || {
    fetch_core(&root, remote.as_deref(), &auth, &locks, cancel, sink)
  })
  .await;
  ops.end(&op_id);
  joined.map_err(|e| format!("git_fetch:{e}"))?
}

#[tauri::command]
pub async fn git_pull(
  app: AppHandle,
  ops: State<'_, GitOps>,
  locks: State<'_, GitLocks>,
  root: String,
  remote: Option<String>,
  op_id: String,
  on_progress: Channel<GitProgress>,
) -> Result<PullOutcome, String> {
  let auth = AuthStore::load(&app)?;
  let identity = auth.identity.clone();
  let cancel = ops.begin(&op_id)?;
  let ops = ops.inner().clone();
  let locks = locks.inner().clone();
  let sink = channel_sink(on_progress);
  let joined = tauri::async_runtime::spawn_blocking(move || {
    pull_core(
      &root,
      remote.as_deref(),
      &auth,
      identity.as_ref(),
      &locks,
      cancel,
      sink,
    )
  })
  .await;
  ops.end(&op_id);
  joined.map_err(|e| format!("git_pull:{e}"))?
}

#[tauri::command]
pub async fn git_push(
  app: AppHandle,
  ops: State<'_, GitOps>,
  locks: State<'_, GitLocks>,
  root: String,
  remote: Option<String>,
  op_id: String,
  on_progress: Channel<GitProgress>,
) -> Result<PushOutcome, String> {
  let auth = AuthStore::load(&app)?;
  let cancel = ops.begin(&op_id)?;
  let ops = ops.inner().clone();
  let locks = locks.inner().clone();
  let sink = channel_sink(on_progress);
  let joined = tauri::async_runtime::spawn_blocking(move || {
    push_core(&root, remote.as_deref(), &auth, &locks, cancel, sink)
  })
  .await;
  ops.end(&op_id);
  joined.map_err(|e| format!("git_push:{e}"))?
}

fn channel_sink(channel: Channel<GitProgress>) -> Sink {
  Arc::new(move |progress| {
    let _ = channel.send(progress);
  })
}

pub(crate) fn fetch_core(
  root: &str,
  remote: Option<&str>,
  auth: &AuthStore,
  locks: &GitLocks,
  cancel: Arc<AtomicBool>,
  sink: Sink,
) -> Result<RepoInfo, String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let name = remote_name(&opened.repo, remote)?;
  sink(starting());
  fetch_into(&opened.repo, &name, auth, Arc::clone(&cancel), Arc::clone(&sink))?;
  sink(done());
  let _ = cancel;
  Ok(repo_info(&opened, root))
}

pub(crate) fn pull_core(
  root: &str,
  remote: Option<&str>,
  auth: &AuthStore,
  identity: Option<&Identity>,
  locks: &GitLocks,
  cancel: Arc<AtomicBool>,
  sink: Sink,
) -> Result<PullOutcome, String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  // A pull writes into the work tree. During another unfinished merge/rebase that is a second
  // operation on top of the first, which this panel cannot finish or explain afterwards.
  if opened.repo.state() != git2::RepositoryState::Clean {
    return Err("git_state_busy".into());
  }
  // A merge would write into the work tree, and a dirty file makes that a question this panel
  // has no way to ask per file. Fetching alone would be safe; pulling is not.
  if is_dirty(&opened.repo)? {
    return Err("git_dirty".into());
  }
  let name = remote_name(&opened.repo, remote)?;
  sink(starting());
  fetch_into(&opened.repo, &name, auth, Arc::clone(&cancel), Arc::clone(&sink))?;
  if cancel.load(Ordering::Relaxed) {
    return Err("git_canceled".into());
  }

  let repo = &opened.repo;
  let branch = repo
    .head()
    .ok()
    .and_then(|head| head.shorthand().ok().map(str::to_string))
    .ok_or_else(|| "git_detached".to_string())?;
  let refname = format!("refs/remotes/{name}/{branch}");
  let reference = repo
    .find_reference(&refname)
    .map_err(|_| "git_no_upstream".to_string())?;
  let annotated = repo
    .reference_to_annotated_commit(&reference)
    .map_err(|e| fail("rev", e))?;
  let (analysis, _) = repo
    .merge_analysis(&[&annotated])
    .map_err(|e| fail("merge", e))?;

  if analysis.is_up_to_date() {
    sink(done());
    return Ok(PullOutcome {
      result: "up_to_date".into(),
      conflicted: Vec::new(),
      repo: repo_info(&opened, root),
    });
  }

  if analysis.is_fast_forward() {
    sink(phase("writing"));
    let target = annotated.id();
    let object = repo
      .find_object(target, None)
      .map_err(|e| fail("rev", e))?;
    let mut checkout = CheckoutBuilder::new();
    checkout.safe();
    repo
      .checkout_tree(&object, Some(&mut checkout))
      .map_err(|e| fail("checkout", e))?;
    let mut branch_ref = repo
      .find_reference(&format!("refs/heads/{branch}"))
      .map_err(|e| fail("head", e))?;
    branch_ref
      .set_target(target, "pull: fast-forward")
      .map_err(|e| fail("merge", e))?;
    sink(done());
    return Ok(PullOutcome {
      result: "fast_forward".into(),
      conflicted: Vec::new(),
      repo: repo_info(&opened, root),
    });
  }

  if !analysis.is_normal() {
    return Err("git_pull_unsupported".into());
  }

  sink(phase("merging"));
  let mut checkout = CheckoutBuilder::new();
  checkout.safe().conflict_style_merge(true);
  repo
    .merge(&[&annotated], None, Some(&mut checkout))
    .map_err(|e| fail("merge", e))?;
  let mut index = repo.index().map_err(|e| fail("index", e))?;
  let conflicted = conflict_paths(&index)?;
  if !conflicted.is_empty() {
    sink(done());
    return Ok(PullOutcome {
      result: "conflicted".into(),
      conflicted,
      repo: repo_info(&opened, root),
    });
  }
  let tree_oid = index.write_tree().map_err(|e| fail("merge", e))?;
  let tree = repo.find_tree(tree_oid).map_err(|e| fail("tree", e))?;
  let head_commit = repo
    .head()
    .and_then(|head| head.peel_to_commit())
    .map_err(|e| fail("head", e))?;
  let merge_commit = repo
    .find_commit(annotated.id())
    .map_err(|e| fail("rev", e))?;
  let author = signature(repo, identity)?;
  let message = format!("Merge remote-tracking branch '{name}/{branch}'");
  repo
    .commit(
      Some("HEAD"),
      &author,
      &author,
      &message,
      &tree,
      &[&head_commit, &merge_commit],
    )
    .map_err(|e| fail("commit", e))?;
  repo.cleanup_state().map_err(|e| fail("merge", e))?;
  sink(done());
  Ok(PullOutcome {
    result: "merged".into(),
    conflicted: Vec::new(),
    repo: repo_info(&opened, root),
  })
}

pub(crate) fn push_core(
  root: &str,
  remote: Option<&str>,
  auth: &AuthStore,
  locks: &GitLocks,
  cancel: Arc<AtomicBool>,
  sink: Sink,
) -> Result<PushOutcome, String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let repo = &opened.repo;
  if repo.head_detached().unwrap_or(false) {
    return Err("git_detached".into());
  }
  let head = repo.head().map_err(|e| fail("head", e))?;
  let branch = head
    .shorthand()
    .ok()
    .map(str::to_string)
    .ok_or_else(|| "git_detached".to_string())?;
  let oid = head.target().ok_or_else(|| "git_detached".to_string())?;
  let name = remote_name(repo, remote)?;
  let upstream = upstream_of(repo, &branch);
  // The branch name a push updates is the upstream's only when pushing to the remote that
  // upstream names. Pushing a copy to a second remote must not carry the first remote's branch
  // name — or take its upstream away afterwards.
  let target_branch = match &upstream {
    Some((remote, target)) if remote == &name => target.clone(),
    _ => branch.clone(),
  };
  let refspec = format!("refs/heads/{branch}:refs/heads/{target_branch}");
  let mut remote = repo.find_remote(&name).map_err(|e| fail("remote", e))?;

  let rejected: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
  let hostkey: HostKeyNote = Arc::new(Mutex::new(None));
  let mut callbacks = callbacks(
    auth,
    Arc::clone(&cancel),
    sink.clone(),
    Arc::clone(&hostkey),
  );
  {
    let rejected = Arc::clone(&rejected);
    callbacks.push_update_reference(move |refname, status| {
      if let Some(status) = status {
        if let Ok(mut list) = rejected.lock() {
          list.push(format!("{refname}: {status}"));
        }
      }
      Ok(())
    });
  }
  preflight(remote.url().unwrap_or_default(), &cancel)?;
  let mut options = PushOptions::new();
  options.remote_callbacks(callbacks);
  sink(starting());
  // A host key the panel should ask about wins over what the transport wrote in its place;
  // `remote_fail` still handles everything else, including authentication.
  if let Err(e) = remote.push(&[refspec.as_str()], Some(&mut options)) {
    return Err(hostkey_note(&hostkey).unwrap_or_else(|| remote_fail("push", e, &cancel)));
  }
  if let Some(reason) = rejected.lock().ok().and_then(|list| list.first().cloned()) {
    return Err(format!("git_push_rejected:{reason}"));
  }

  // The remote branch now holds what the local one does. Recording that locally makes
  // ahead/behind right immediately instead of on the next fetch.
  let tracking = format!("refs/remotes/{name}/{target_branch}");
  let _ = repo.reference(&tracking, oid, true, "push");
  let claims_upstream = upstream
    .as_ref()
    .map(|(remote, target)| remote == &name && target == &target_branch)
    .unwrap_or(true);
  if claims_upstream {
    if let Ok(mut branch_ref) = repo.find_branch(&branch, BranchType::Local) {
      let _ = branch_ref.set_upstream(Some(&format!("{name}/{target_branch}")));
    }
  }
  sink(done());
  Ok(PushOutcome {
    repo: repo_info(&opened, root),
    upstream: Some(format!("{name}/{target_branch}")),
  })
}

fn fetch_into(
  repo: &Repository,
  name: &str,
  auth: &AuthStore,
  cancel: Arc<AtomicBool>,
  sink: Sink,
) -> Result<(), String> {
  let mut remote = repo.find_remote(name).map_err(|e| fail("remote", e))?;
  preflight(remote.url().unwrap_or_default(), &cancel)?;
  let hostkey: HostKeyNote = Arc::new(Mutex::new(None));
  let mut options = FetchOptions::new();
  options.remote_callbacks(callbacks(
    auth,
    Arc::clone(&cancel),
    sink,
    Arc::clone(&hostkey),
  ));
  // Same as push: the refusal recorded by the callback outranks libgit2's replacement string.
  if let Err(e) = remote.fetch::<&str>(&[], Some(&mut options), None) {
    return Err(hostkey_note(&hostkey).unwrap_or_else(|| remote_fail("fetch", e, &cancel)));
  }
  Ok(())
}

/// The remote to talk to: the one asked for, else the current branch's, else `origin`, else the
/// first configured one.
pub(crate) fn remote_name(repo: &Repository, wanted: Option<&str>) -> Result<String, String> {
  if let Some(name) = wanted.map(str::trim).filter(|name| !name.is_empty()) {
    return Ok(name.to_string());
  }
  if let Some(name) = upstream_remote(repo) {
    return Ok(name);
  }
  if repo.find_remote("origin").is_ok() {
    return Ok("origin".into());
  }
  let names = repo.remotes().map_err(|e| fail("remote", e))?;
  names
    .get(0)
    .ok()
    .flatten()
    .map(str::to_string)
    .ok_or_else(|| "git_no_remote".to_string())
}

fn upstream_remote(repo: &Repository) -> Option<String> {
  let head = repo.head().ok()?;
  let branch = repo
    .find_branch(head.shorthand().ok()?, BranchType::Local)
    .ok()?;
  let upstream = branch.upstream().ok()?;
  let name = upstream.get().name().ok()?.to_string();
  let rest = name.strip_prefix("refs/remotes/")?;
  rest.split('/').next().map(str::to_string)
}

/// The remote and branch a local branch tracks, from `refs/remotes/<remote>/<branch>`.
fn upstream_of(repo: &Repository, branch: &str) -> Option<(String, String)> {
  let branch = repo.find_branch(branch, BranchType::Local).ok()?;
  let upstream = branch.upstream().ok()?;
  let name = upstream.get().name().ok()?.to_string();
  let rest = name.strip_prefix("refs/remotes/")?;
  let (remote, target) = rest.split_once('/')?;
  Some((remote.to_string(), target.to_string()))
}

/// What the certificate callback refused, if it refused.
///
/// libgit2 does not carry a callback's error text out of the SSH transport: when the check fails
/// the transport sets its own `invalid or unknown remote ssh hostkey` (`ssh_libssh2.c`), which
/// names neither the host nor the fingerprint the panel needs to ask about. The callback leaves
/// its answer in this slot instead, and the operation reports that in preference to the string
/// libgit2 put in its place.
type HostKeyNote = Arc<Mutex<Option<String>>>;

/// The refusal the certificate callback recorded, if any.
fn hostkey_note(slot: &HostKeyNote) -> Option<String> {
  slot.lock().ok().and_then(|note| note.clone())
}

/// Record a refused host key and fail the check with the same text.
fn refuse(slot: &HostKeyNote, message: String) -> Result<CertificateCheckStatus, git2::Error> {
  if let Ok(mut note) = slot.lock() {
    *note = Some(message.clone());
  }
  Err(git2::Error::from_str(&message))
}

fn callbacks(
  auth: &AuthStore,
  cancel: Arc<AtomicBool>,
  sink: Sink,
  hostkey_slot: HostKeyNote,
) -> RemoteCallbacks<'static> {
  let mut callbacks = RemoteCallbacks::new();
  let auth = auth.clone();

  {
    let auth = auth.clone();
    callbacks.credentials(move |url, username, allowed| {
      let host = auth::host_of(url).unwrap_or_default();
      if allowed.contains(CredentialType::USERNAME) {
        let user = username
          .map(str::to_string)
          .or_else(|| lookup(&auth.https, &host).map(|c| c.username.clone()))
          .unwrap_or_else(|| "git".to_string());
        return Cred::username(&user);
      }
      if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
        if let Some(credential) = lookup(&auth.https, &host) {
          return Cred::userpass_plaintext(&credential.username, &credential.secret);
        }
        return Err(git2::Error::from_str(&format!("git_auth_required:{host}")));
      }
      if allowed.contains(CredentialType::SSH_KEY) {
        if let Some(credential) = lookup(&auth.ssh, &host) {
          return Cred::ssh_key(
            username.unwrap_or("git"),
            None,
            Path::new(&credential.key_path),
            credential.passphrase.as_deref(),
          );
        }
        return Err(git2::Error::from_str(&format!("git_auth_required:{host}")));
      }
      Cred::default()
    });
  }

  {
    let auth = auth.clone();
    callbacks.certificate_check(move |cert: &Cert<'_>, host| {
      let Some(hostkey) = cert.as_hostkey() else {
        return Ok(CertificateCheckStatus::CertificatePassthrough);
      };
      let Some(hash) = hostkey.hash_sha256() else {
        return Ok(CertificateCheckStatus::CertificatePassthrough);
      };
      let fingerprint: String = hash.iter().map(|byte| format!("{byte:02x}")).collect();
      let key = host.to_ascii_lowercase();
      let trusted = auth
        .known_hosts
        .get(&key)
        .or_else(|| key.split(':').next().and_then(|bare| auth.known_hosts.get(bare)));
      match trusted {
        Some(trusted) if trusted.eq_ignore_ascii_case(&fingerprint) => {
          Ok(CertificateCheckStatus::CertificateOk)
        }
        Some(_) => refuse(
          &hostkey_slot,
          format!("git_host_changed:{host}|{fingerprint}"),
        ),
        None => refuse(
          &hostkey_slot,
          format!("git_host_untrusted:{host}|{fingerprint}"),
        ),
      }
    });
  }

  {
    let sink = Arc::clone(&sink);
    let cancel = Arc::clone(&cancel);
    let last = Arc::new(AtomicU64::new(0));
    callbacks.transfer_progress(move |stats| {
      if cancel.load(Ordering::Relaxed) {
        return false;
      }
      let total = stats.total_objects() as u32;
      let received = stats.received_objects() as u32;
      let percent = if total > 0 {
        ((received.min(total) as u64 * 100) / total as u64) as u8
      } else {
        0
      };
      emit(
        &sink,
        &last,
        GitProgress {
          phase: "receiving".into(),
          received,
          total,
          bytes: stats.received_bytes() as u64,
          percent,
          text: None,
        },
      );
      true
    });
  }

  {
    let sink = Arc::clone(&sink);
    let cancel = Arc::clone(&cancel);
    let last = Arc::new(AtomicU64::new(0));
    callbacks.sideband_progress(move |data| {
      if cancel.load(Ordering::Relaxed) {
        return false;
      }
      let text = String::from_utf8_lossy(data).trim().to_string();
      if !text.is_empty() {
        emit(
          &sink,
          &last,
          GitProgress {
            phase: "message".into(),
            text: Some(text),
            ..GitProgress::default()
          },
        );
      }
      true
    });
  }

  callbacks
}

fn lookup<'a, T>(map: &'a BTreeMap<String, T>, host: &str) -> Option<&'a T> {
  let host = host.to_ascii_lowercase();
  map
    .get(&host)
    .or_else(|| host.split(':').next().and_then(|bare| map.get(bare)))
}

fn emit(sink: &Sink, last: &AtomicU64, progress: GitProgress) {
  let now = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0);
  let previous = last.load(Ordering::Relaxed);
  if progress.percent >= 100 || now.saturating_sub(previous) >= 120 {
    last.store(now, Ordering::Relaxed);
    sink(progress);
  }
}

fn starting() -> GitProgress {
  GitProgress {
    phase: "starting".into(),
    ..GitProgress::default()
  }
}

fn phase(name: &str) -> GitProgress {
  GitProgress {
    phase: name.into(),
    percent: 100,
    ..GitProgress::default()
  }
}

fn done() -> GitProgress {
  GitProgress {
    phase: "done".into(),
    percent: 100,
    ..GitProgress::default()
  }
}

/// A bounded connection check before libgit2 starts.
///
/// libgit2 has no connect timeout, and its cancel callbacks only run once a transfer is under
/// way: a route that silently drops packets leaves the panel on "connecting" for minutes with a
/// Cancel button that cannot do anything. This opens one TCP connection with a deadline first.
/// It is skipped for local paths and when a system proxy is configured, because in that case the
/// proxy — not a direct socket — is what has to answer.
fn preflight(url: &str, cancel: &AtomicBool) -> Result<(), String> {
  let Some((host, port)) = socket_target(url) else {
    return Ok(());
  };
  // A configured system proxy only carries HTTP(S); SSH still needs a direct socket.
  let proxied_http = (url.starts_with("http://") || url.starts_with("https://"))
    && system_proxy_configured();
  if proxied_http {
    return Ok(());
  }
  if cancel.load(Ordering::Relaxed) {
    return Err("git_canceled".into());
  }
  let target = socket_address(&host, port);
  let addresses = match resolve(&target) {
    Ok(addresses) => addresses,
    Err(error) => {
      return if cancel.load(Ordering::Relaxed) {
        Err("git_canceled".into())
      } else {
        Err(error)
      };
    }
  };
  for address in addresses {
    if TcpStream::connect_timeout(&address, Duration::from_secs(4)).is_ok() {
      return Ok(());
    }
    if cancel.load(Ordering::Relaxed) {
      return Err("git_canceled".into());
    }
  }
  if cancel.load(Ordering::Relaxed) {
    return Err("git_canceled".into());
  }
  Err(format!("git_network:{host}"))
}

/// `host:port`, with IPv6 hosts bracketed so `to_socket_addrs` can parse them.
fn socket_address(host: &str, port: u16) -> String {
  if host.contains(':') {
    format!("[{host}]:{port}")
  } else {
    format!("{host}:{port}")
  }
}

fn resolve(target: &str) -> Result<Vec<SocketAddr>, String> {
  let (sender, receiver) = mpsc::channel();
  let owned = target.to_string();
  std::thread::spawn(move || {
    let result = owned
      .to_socket_addrs()
      .map(|addresses| addresses.collect::<Vec<_>>());
    let _ = sender.send(result);
  });
  match receiver.recv_timeout(Duration::from_secs(4)) {
    Ok(Ok(addresses)) if !addresses.is_empty() => Ok(addresses),
    _ => Err(format!(
      "git_network:{}",
      target.rsplit_once(':').map(|(host, _)| host).unwrap_or(target)
    )),
  }
}

/// The `host:port` a remote URL talks to, or `None` for a local path.
fn socket_target(url: &str) -> Option<(String, u16)> {
  if url.is_empty() || url.starts_with("file://") || Path::new(url).is_absolute() {
    return None;
  }
  if let Some(rest) = url.strip_prefix("https://") {
    return Some(host_port(rest, 443));
  }
  if let Some(rest) = url.strip_prefix("http://") {
    return Some(host_port(rest, 80));
  }
  if let Some(rest) = url.strip_prefix("ssh://") {
    return Some(host_port(rest, 22));
  }
  // scp-like `[user@]host:path`. A Windows drive path never reaches here: `D:/x` is absolute.
  let after_at = url.rsplit_once('@')?.1;
  let (host, _) = after_at.split_once(':')?;
  if host.is_empty() || host.contains('/') {
    return None;
  }
  Some((host.to_string(), 22))
}

fn host_port(rest: &str, default_port: u16) -> (String, u16) {
  let authority = rest.split('/').next().unwrap_or(rest);
  let host = authority.rsplit('@').next().unwrap_or(authority);
  match host.rsplit_once(':') {
    Some((name, port)) if port.parse::<u16>().is_ok() => (
      name.trim_start_matches('[').trim_end_matches(']').to_string(),
      port.parse().unwrap_or(default_port),
    ),
    _ => (host.trim_start_matches('[').trim_end_matches(']').to_string(), default_port),
  }
}

#[cfg(windows)]
fn system_proxy_configured() -> bool {
  use winreg::enums::HKEY_CURRENT_USER;
  use winreg::RegKey;
  RegKey::predef(HKEY_CURRENT_USER)
    .open_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings")
    .and_then(|key| key.get_value::<u32, _>("ProxyEnable"))
    .map(|enabled| enabled == 1)
    .unwrap_or(false)
}

#[cfg(not(windows))]
fn system_proxy_configured() -> bool {
  false
}

/// Errors raised inside a callback keep their structured code; everything else is a transport
/// failure with the stage name the frontend localizes.
fn remote_fail(stage: &str, error: git2::Error, cancel: &AtomicBool) -> String {
  let message = error.message().to_string();
  for code in [
    "git_auth_required:",
    "git_auth_failed",
    "git_host_untrusted:",
    "git_host_changed:",
  ] {
    if let Some(position) = message.find(code) {
      return message[position..].to_string();
    }
  }
  if cancel.load(Ordering::Relaxed)
    || message
      .to_ascii_lowercase()
      .contains("callback returned error")
  {
    return "git_canceled".into();
  }
  // libgit2 reports a credential it has already tried as "too many redirects or
  // authentication replays", not as an Auth error. It is a rejected credential all the same,
  // and the panel should reopen the form rather than show a transport failure.
  let lower = message.to_ascii_lowercase();
  if error.code() == ErrorCode::Auth
    || lower.contains("authentication replays")
    || lower.contains("authentication required")
    || lower.contains("failed to authenticate")
  {
    return "git_auth_failed".into();
  }
  // libgit2 refuses a non-fast-forward push itself, before the per-ref callback reports the
  // server's answer. It is still a rejection, and the panel should say so rather than show a
  // transport failure for the one case users meet most.
  if stage == "push" {
    let lower = message.to_ascii_lowercase();
    if lower.contains("not present locally")
      || lower.contains("non-fast-forward")
      || lower.contains("non-fastforwardable")
      || lower.contains("non fast forward")
      || lower.contains("fetch first")
      || lower.contains("failed to update ref")
    {
      let cut: String = message.chars().take(160).collect();
      return format!("git_push_rejected:{cut}");
    }
  }
  fail(stage, error)
}

fn display_url(url: &str) -> String {
  if let Some((scheme, rest)) = url.split_once("://") {
    let (authority, tail) = match rest.split_once('/') {
      Some((authority, tail)) => (authority, Some(tail)),
      None => (rest, None),
    };
    let host = authority.rsplit('@').next().unwrap_or(authority);
    return match tail {
      Some(tail) => format!("{scheme}://{host}/{tail}"),
      None => format!("{scheme}://{host}"),
    };
  }
  url
    .split_once('@')
    .map(|(_, rest)| rest.to_string())
    .unwrap_or_else(|| url.to_string())
}

#[tauri::command]
pub fn git_conflict_sides(
  app: AppHandle,
  root: String,
  path: String,
) -> Result<ConflictSides, String> {
  let normalized = crate::draft::normalize_path(&path);
  let preference = file_settings::encoding_for(
    &app,
    &normalized,
    &crate::commands::stored_encoding(&app),
  );
  let default_eol = commands::settings_of(&app).line_ending;
  conflict_sides_of(&root, &path, &preference, &default_eol)
}

pub(crate) fn conflict_sides_of(
  root: &str,
  path: &str,
  preference: &str,
  default_eol: &str,
) -> Result<ConflictSides, String> {
  let opened = discover(root)?;
  let rel = rel_of(&opened.workdir, path)?;
  let rel_text = git_path(&rel);
  let abs = opened.workdir.join(&rel);
  let index = opened.repo.index().map_err(|e| fail("index", e))?;
  let mut sides = ConflictSides {
    path: rel_text.clone(),
    base: None,
    ours: None,
    theirs: None,
    merged: None,
    binary: false,
    encoding: preference.to_string(),
    bom: false,
    eol: default_eol.to_string(),
    too_large: false,
    auto_merged: None,
    autosolved: 0,
  };
  let mut found = false;
  let conflicts = index.conflicts().map_err(|e| fail("index", e))?;
  for conflict in conflicts {
    let conflict = conflict.map_err(|e| fail("index", e))?;
    let entry = conflict
      .our
      .as_ref()
      .or(conflict.their.as_ref())
      .or(conflict.ancestor.as_ref());
    let Some(entry) = entry else { continue };
    if String::from_utf8_lossy(&entry.path).replace('\\', "/") != rel_text {
      continue;
    }
    found = true;
    let (base, base_binary) =
      decode_blob(&opened.repo, conflict.ancestor.as_ref(), preference)?;
    let (ours, ours_binary) = decode_blob(&opened.repo, conflict.our.as_ref(), preference)?;
    let (theirs, theirs_binary) =
      decode_blob(&opened.repo, conflict.their.as_ref(), preference)?;
    sides.base = base;
    sides.ours = ours;
    sides.theirs = theirs;
    sides.binary = base_binary || ours_binary || theirs_binary;
    break;
  }
  if !found {
    return Err("git_not_conflicted".into());
  }

  // The working tree is what Apply overwrites, so its encoding, BOM and line endings are the
  // ones that matter — the blobs only contribute their text.
  match fs::read(&abs) {
    Ok(bytes) => {
      if bytes.len() > MAX_DIFF_BYTES {
        sides.too_large = true;
      } else if bytes.iter().take(8000).any(|byte| *byte == 0) {
        sides.binary = true;
      } else if !sides.binary {
        let decoded = encoding::decode(&bytes, preference)?;
        sides.merged = Some(decoded.text);
        sides.encoding = decoded.encoding;
        sides.bom = decoded.bom;
        let detected = detect_eol(&bytes);
        if !detected.is_empty() {
          sides.eol = detected;
        }
      }
    }
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => return Err(format!("git_conflict_read:{error}")),
  }
  if sides.binary {
    sides.merged = None;
  }

  // Most conflicts are not disagreements: the two sides touched different regions, and git
  // only wrote markers because neither was applied. Merging against the base settles those
  // here, so the view opens on the few regions that really need an answer. A binary or
  // oversized file, or one whose working tree is gone, is left exactly as git wrote it.
  if !sides.binary && !sides.too_large && sides.merged.is_some() {
    if let (Some(base), Some(ours), Some(theirs)) = (&sides.base, &sides.ours, &sides.theirs) {
      if let Some((text, settled)) = merge::merge3(base, ours, theirs) {
        if settled > 0 {
          sides.auto_merged = Some(text);
          sides.autosolved = settled;
        }
      }
    }
  }
  Ok(sides)
}

fn decode_blob(
  repo: &Repository,
  entry: Option<&git2::IndexEntry>,
  preference: &str,
) -> Result<(Option<String>, bool), String> {
  let Some(entry) = entry else {
    return Ok((None, false));
  };
  let blob = repo.find_blob(entry.id).map_err(|e| fail("blob", e))?;
  if blob.is_binary() {
    return Ok((None, true));
  }
  Ok((
    Some(encoding::decode(blob.content(), preference)?.text),
    false,
  ))
}

/// `lf` / `crlf` from the first break a file contains, or empty when it has none.
fn detect_eol(bytes: &[u8]) -> String {
  // Conflict markers are written by libgit2 with LF even when the content around them is
  // CRLF, so a marker line is not evidence of the file's own line endings.
  let mut start = 0;
  while start < bytes.len() {
    let mut end = start;
    while end < bytes.len() && bytes[end] != b'\n' && bytes[end] != b'\r' {
      end += 1;
    }
    if end == bytes.len() {
      return String::new();
    }
    let line = &bytes[start..end];
    let marker = line.starts_with(b"<<<<<<<")
      || line.starts_with(b"=======")
      || line.starts_with(b">>>>>>>")
      || line.starts_with(b"|||||||");
    if !marker {
      return if bytes[end] == b'\r' && bytes.get(end + 1) == Some(&b'\n') {
        "crlf".into()
      } else if bytes[end] == b'\n' {
        "lf".into()
      } else {
        String::new()
      };
    }
    if bytes[end] == b'\r' && bytes.get(end + 1) == Some(&b'\n') {
      start = end + 2;
    } else {
      start = end + 1;
    }
  }
  String::new()
}

/// Whether the index still holds conflict stages for a repository-relative path.
fn conflict_entry(index: &git2::Index, rel: &str) -> Result<bool, String> {
  if !index.has_conflicts() {
    return Ok(false);
  }
  let conflicts = index.conflicts().map_err(|e| fail("index", e))?;
  for conflict in conflicts {
    let conflict = conflict.map_err(|e| fail("index", e))?;
    let entry = conflict
      .our
      .as_ref()
      .or(conflict.their.as_ref())
      .or(conflict.ancestor.as_ref());
    let Some(entry) = entry else { continue };
    if String::from_utf8_lossy(&entry.path).replace('\\', "/") == rel {
      return Ok(true);
    }
  }
  Ok(false)
}

/// Write the merge result over the working copy and mark the path resolved.
#[tauri::command]
pub fn git_write_resolution(
  app: AppHandle,
  root: String,
  path: String,
  content: String,
  locks: State<'_, GitLocks>,
) -> Result<SavedFile, String> {
  let normalized = crate::draft::normalize_path(&path);
  let preference = file_settings::encoding_for(
    &app,
    &normalized,
    &commands::stored_encoding(&app),
  );
  let default_eol = commands::settings_of(&app).line_ending;
  write_resolution(&root, &path, &content, &preference, &default_eol, &locks)
}

pub(crate) fn write_resolution(
  root: &str,
  path: &str,
  content: &str,
  preference: &str,
  default_eol: &str,
  locks: &GitLocks,
) -> Result<SavedFile, String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let rel = rel_of(&opened.workdir, path)?;
  let rel_text = git_path(&rel);
  let abs = opened.workdir.join(&rel);
  let repo = &opened.repo;
  let mut index = repo.index().map_err(|e| fail("index", e))?;
  if !conflict_entry(&index, &rel_text)? {
    return Err("git_not_conflicted".into());
  }

  let existing = fs::read(&abs).ok();
  let (encoding_name, bom, eol) = match existing.as_ref() {
    Some(bytes) => {
      let decoded = encoding::decode(bytes, preference)?;
      let detected = detect_eol(bytes);
      (
        decoded.encoding,
        decoded.bom,
        if detected.is_empty() {
          default_eol.to_string()
        } else {
          detected
        },
      )
    }
    None => (
      encoding::resolve_for_write(preference)?.name().to_string(),
      false,
      default_eol.to_string(),
    ),
  };
  // Monaco models are LF; the file gets the breaks it had.
  let lf = content.replace("\r\n", "\n").replace('\r', "\n");
  let text = if eol == "crlf" {
    lf.replace('\n', "\r\n")
  } else {
    lf
  };
  let bytes = encoding::encode(&text, &encoding_name, bom)?;
  if bytes.len() as u64 > commands::MAX_FILE_BYTES {
    return Err(format!("file_too_large:{}", bytes.len() / (1024 * 1024)));
  }
  if let Some(parent) = abs.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("dir_create:{e}"))?;
  }
  commands::write_atomic(&abs, &bytes)?;
  index
    .add_path(Path::new(&rel_text))
    .map_err(|e| fail("resolve", e))?;
  index.write().map_err(|e| fail("resolve", e))?;
  let mtime = fs::metadata(&abs)
    .map(|meta| commands::mtime_ms(&meta))
    .unwrap_or(0);
  Ok(SavedFile {
    path: crate::draft::normalize_path(&abs.to_string_lossy()),
    mtime,
    encoding: encoding::resolve_for_write(&encoding_name)?.name().to_string(),
    bytes: bytes.len() as u64,
  })
}

/// Remove a file as the resolution (the chosen side does not exist) and mark it resolved.
#[tauri::command]
pub fn git_delete_resolution(
  root: String,
  path: String,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  delete_resolution(&root, &path, &locks)
}

pub(crate) fn delete_resolution(
  root: &str,
  path: &str,
  locks: &GitLocks,
) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let rel = rel_of(&opened.workdir, path)?;
  let rel_text = git_path(&rel);
  let abs = opened.workdir.join(&rel);
  let repo = &opened.repo;
  let mut index = repo.index().map_err(|e| fail("index", e))?;
  if !conflict_entry(&index, &rel_text)? {
    return Err("git_not_conflicted".into());
  }
  match fs::remove_file(&abs) {
    Ok(()) => {}
    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
    Err(error) => return Err(format!("git_resolve:{error}")),
  }
  index
    .remove_path(Path::new(&rel_text))
    .map_err(|e| fail("resolve", e))?;
  index.write().map_err(|e| fail("resolve", e))?;
  Ok(())
}

/// Write one side over the working copy and mark the path resolved in the index. `markers`
/// leaves both texts between conflict markers for hand editing; `ours`/`theirs` take that side
/// whole. A delete/delete conflict removes the file.
#[tauri::command]
pub fn git_resolve_conflict(
  root: String,
  path: String,
  choice: String,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  resolve_conflict(&root, &path, &choice, &locks)
}

pub(crate) fn resolve_conflict(
  root: &str,
  path: &str,
  choice: &str,
  locks: &GitLocks,
) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let rel = rel_of(&opened.workdir, path)?;
  let rel_text = git_path(&rel);
  let abs = opened.workdir.join(&rel);
  let repo = &opened.repo;
  let mut index = repo.index().map_err(|e| fail("index", e))?;

  let mut ours: Option<Vec<u8>> = None;
  let mut theirs: Option<Vec<u8>> = None;
  let mut found = false;
  let conflicts = index.conflicts().map_err(|e| fail("index", e))?;
  for conflict in conflicts {
    let conflict = conflict.map_err(|e| fail("index", e))?;
    let entry = conflict
      .our
      .as_ref()
      .or(conflict.their.as_ref())
      .or(conflict.ancestor.as_ref());
    let Some(entry) = entry else { continue };
    if String::from_utf8_lossy(&entry.path).replace('\\', "/") != rel_text {
      continue;
    }
    found = true;
    ours = read_entry(repo, conflict.our.as_ref())?;
    theirs = read_entry(repo, conflict.their.as_ref())?;
    break;
  }
  if !found {
    return Err("git_not_conflicted".into());
  }

  let both_missing = ours.is_none() && theirs.is_none();
  let (bytes, remove) = match choice {
    // A side that does not exist means the resolution is that the file is not there. Writing
    // an empty file instead would turn "they deleted it" into "they emptied it".
    "ours" => (ours.clone(), ours.is_none()),
    "theirs" => (theirs.clone(), theirs.is_none()),
    "markers" => (
      if both_missing {
        None
      } else {
        Some(markers(ours.as_deref(), theirs.as_deref()))
      },
      both_missing,
    ),
    _ => return Err("git_resolve_unknown".into()),
  };
  if remove {
    // Both sides deleted the file, or the chosen side did: the resolution is the file not
    // existing.
    match fs::remove_file(&abs) {
      Ok(()) => {}
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => return Err(format!("git_resolve:{e}")),
    }
    index
      .remove_path(Path::new(&rel_text))
      .map_err(|e| fail("resolve", e))?;
  } else {
    fs::write(&abs, bytes.unwrap_or_default()).map_err(|e| format!("git_resolve:{e}"))?;
    // add_path also drops the conflict stages for this path (libgit2 records the old stages in
    // its resolve-undo section), so there is no second index edit to forget.
    index
      .add_path(Path::new(&rel_text))
      .map_err(|e| fail("resolve", e))?;
  }
  index.write().map_err(|e| fail("resolve", e))?;
  Ok(())
}

fn read_entry(
  repo: &Repository,
  entry: Option<&git2::IndexEntry>,
) -> Result<Option<Vec<u8>>, String> {
  let Some(entry) = entry else {
    return Ok(None);
  };
  let blob = repo.find_blob(entry.id).map_err(|e| fail("blob", e))?;
  Ok(Some(blob.content().to_vec()))
}

fn markers(ours: Option<&[u8]>, theirs: Option<&[u8]>) -> Vec<u8> {
  match (ours, theirs) {
    (Some(ours), Some(theirs)) => {
      let mut out = Vec::new();
      out.extend_from_slice(b"<<<<<<< HEAD\n");
      out.extend_from_slice(ours);
      if !ours.ends_with(b"\n") {
        out.push(b'\n');
      }
      out.extend_from_slice(b"=======\n");
      out.extend_from_slice(theirs);
      if !theirs.ends_with(b"\n") {
        out.push(b'\n');
      }
      out.extend_from_slice(b">>>>>>> MERGE_HEAD\n");
      out
    }
    (Some(one), None) | (None, Some(one)) => one.to_vec(),
    (None, None) => Vec::new(),
  }
}

#[tauri::command]
pub fn git_merge_abort(root: String, locks: State<'_, GitLocks>) -> Result<(), String> {
  merge_abort(&root, &locks)
}

pub(crate) fn merge_abort(root: &str, locks: &GitLocks) -> Result<(), String> {
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let repo = &opened.repo;
  if repo.state() != git2::RepositoryState::Merge {
    return Err("git_no_merge".into());
  }
  let head = repo
    .head()
    .and_then(|head| head.peel_to_commit())
    .map_err(|e| fail("head", e))?;
  repo.cleanup_state().map_err(|e| fail("merge", e))?;
  repo
    .reset(head.as_object(), ResetType::Hard, None)
    .map_err(|e| fail("merge", e))?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  /// The slot exists because libgit2 overwrites the callback's error text with its own
  /// "invalid or unknown remote ssh hostkey"; what the callback recorded has to survive for the
  /// panel to learn which host and fingerprint to ask about.
  #[test]
  fn a_refused_host_key_is_kept_for_the_caller() {
    let slot: HostKeyNote = Arc::new(Mutex::new(None));
    assert_eq!(hostkey_note(&slot), None);

    let refused = refuse(&slot, "git_host_untrusted:github.com|abcd".into());
    assert!(refused.is_err());
    if let Err(error) = refused {
      assert_eq!(error.message(), "git_host_untrusted:github.com|abcd");
    }
    assert_eq!(
      hostkey_note(&slot).as_deref(),
      Some("git_host_untrusted:github.com|abcd")
    );
  }

  #[test]
  fn urls_are_shown_without_credentials() {
    assert_eq!(
      display_url("https://user:token@github.com/a/b.git"),
      "https://github.com/a/b.git"
    );
    assert_eq!(display_url("git@github.com:a/b.git"), "github.com:a/b.git");
  }

  #[test]
  fn only_remote_urls_get_a_socket_preflight() {
    assert_eq!(socket_target("https://github.com/a/b.git"), Some(("github.com".into(), 443)));
    assert_eq!(socket_target("https://host:8443/a"), Some(("host".into(), 8443)));
    assert_eq!(socket_target("ssh://git@host/a"), Some(("host".into(), 22)));
    assert_eq!(socket_target("git@host:owner/repo.git"), Some(("host".into(), 22)));
    assert_eq!(socket_target("https://[::1]:8443/x"), Some(("::1".into(), 8443)));
    assert_eq!(socket_address("::1", 443), "[::1]:443");
    assert_eq!(socket_address("github.com", 22), "github.com:22");
    assert_eq!(socket_target("D:/wrolp/remote.git"), None);
    assert_eq!(socket_target(r"D:\wrolp\remote.git"), None);
    assert_eq!(socket_target("/srv/remote.git"), None);
    assert_eq!(socket_target("file:///tmp/remote.git"), None);
  }

  #[test]
  fn markers_hold_both_sides() {
    let text = String::from_utf8(markers(Some(b"one\n"), Some(b"two\n"))).unwrap();
    assert_eq!(
      text,
      "<<<<<<< HEAD\none\n=======\ntwo\n>>>>>>> MERGE_HEAD\n"
    );
    assert_eq!(markers(Some(b"one"), None), b"one");
  }
}
