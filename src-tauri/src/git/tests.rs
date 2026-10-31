//! Repository-level tests against real temporary work trees.
//!
//! No mocks: the behaviours worth pinning here — what `git status` reports after an edit, what
//! discard puts back, which branch a checkout lands on — are all libgit2's answers, and a fake
//! would only test the fake. Remotes are exercised in the transport tests where they appear.

use super::auth::AuthStore;
use super::branch::{branches_of, create_branch, delete_branch, switch_branch};
use super::diff::diff_of;
use super::history::{commit_files, head_commit, log_page};
use super::index::{amend_commit, commit, discard, stage, unstage};
use super::local::{
  assume_unchanged, local_ignore, local_state, local_unignore, local_view, repo_ignore,
};
use super::remote::{
  clone_core, conflict_sides_of, delete_resolution, fetch_core, merge_abort, pull_core, push_core,
  remove_remote, resolve_conflict, save_remote, write_resolution, Sink,
};
use super::repos::scan_repos;
use super::status::{status_of, summary_of};
use super::{rel_of, GitLocks};
use git2::build::CheckoutBuilder;
use git2::{IndexAddOption, Repository};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use crate::encoding;

struct Fixture {
  dir: PathBuf,
}

impl Drop for Fixture {
  fn drop(&mut self) {
    let _ = fs::remove_dir_all(&self.dir);
  }
}

fn fixture(name: &str) -> Fixture {
  let dir = std::env::temp_dir().join(format!("wrolp-git-{}-{}", std::process::id(), name));
  let _ = fs::remove_dir_all(&dir);
  fs::create_dir_all(&dir).unwrap();
  Fixture { dir }
}

fn init(fixture: &Fixture) -> Repository {
  let repo = Repository::init(&fixture.dir).unwrap();
  let mut config = repo.config().unwrap();
  config.set_str("user.name", "Test").unwrap();
  config.set_str("user.email", "test@example.com").unwrap();
  // The machine's global `core.autocrlf` must not decide what these byte-level tests see.
  config.set_bool("core.autocrlf", false).unwrap();
  drop(config);
  repo
}

fn root(fixture: &Fixture) -> String {
  fixture.dir.to_string_lossy().into_owned()
}

fn write(fixture: &Fixture, name: &str, text: &str) -> String {
  let path = fixture.dir.join(name);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).unwrap();
  }
  fs::write(&path, text).unwrap();
  path.to_string_lossy().into_owned()
}

fn locks() -> GitLocks {
  GitLocks::default()
}

#[test]
fn unborn_repository_reports_no_branch_commits_or_changes() {
  let fixture = fixture("unborn");
  let _repo = init(&fixture);

  let status = status_of(&root(&fixture)).unwrap();
  assert!(status.repo.head.unborn);
  assert!(status.repo.head.branch.is_some());
  assert!(status.files.is_empty());
  assert!(log_page(&root(&fixture), None, None, false)
    .unwrap()
    .is_empty());
  assert!(status.repo.state == "clean");
}

#[test]
fn stage_commit_and_log_a_new_file() {
  let fixture = fixture("first-commit");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");

  stage(&root(&fixture), &[file], &locks()).unwrap();
  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.staged, 1);
  assert_eq!(status.files[0].index.as_deref(), Some("A"));

  let result = commit(&root(&fixture), "first", None, &locks()).unwrap();
  assert_eq!(result.summary, "first");
  assert_eq!(result.short.len(), 8);

  let status = status_of(&root(&fixture)).unwrap();
  assert!(!status.repo.head.unborn);
  assert!(status.files.is_empty());

  let log = log_page(&root(&fixture), None, None, false).unwrap();
  assert_eq!(log.len(), 1);
  assert_eq!(log[0].summary, "first");
  assert_eq!(log[0].author, "Test");
  let files = commit_files(&root(&fixture), &result.oid).unwrap();
  assert_eq!(files.len(), 1);
  assert_eq!(files[0].path, "a.txt");
  assert_eq!(files[0].status, "A");
}

#[test]
fn empty_message_and_nothing_staged_are_refused() {
  let fixture = fixture("empty");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  assert_eq!(commit(&root(&fixture), "  ", None, &locks()).unwrap_err(), "git_empty_message");
  assert_eq!(commit(&root(&fixture), "first", None, &locks()).unwrap_err(), "git_nothing_staged");
  stage(&root(&fixture), &[file], &locks()).unwrap();
  commit(&root(&fixture), "first", None, &locks()).unwrap();
  assert_eq!(commit(&root(&fixture), "again", None, &locks()).unwrap_err(), "git_nothing_staged");
}

#[test]
fn diff_and_discard_both_sides_of_an_edit() {
  let fixture = fixture("diff");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  stage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  commit(&root(&fixture), "first", None, &locks()).unwrap();

  write(&fixture, "a.txt", "two\n");
  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.files[0].workdir.as_deref(), Some("M"));

  let diff = diff_of(&root(&fixture), &file, None, "workdir", None, "auto").unwrap();
  assert_eq!(diff.left.text, "one\n");
  assert_eq!(diff.right.text, "two\n");
  assert!(!diff.binary);

  discard(&root(&fixture), &[file.clone()], &locks()).unwrap();
  assert_eq!(fs::read_to_string(PathBuf::from(&file)).unwrap(), "one\n");
  assert!(status_of(&root(&fixture)).unwrap().files.is_empty());

  // Staged text is the right-hand side of the index diff, while HEAD is the left.
  write(&fixture, "a.txt", "three\n");
  stage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  let diff = diff_of(&root(&fixture), &file, None, "index", None, "auto").unwrap();
  assert_eq!(diff.left.text, "one\n");
  assert_eq!(diff.right.text, "three\n");
  unstage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.staged, 0);
  assert_eq!(status.files[0].workdir.as_deref(), Some("M"));
}

#[test]
fn untracked_file_is_deleted_by_discard() {
  let fixture = fixture("untracked");
  let _repo = init(&fixture);
  let file = write(&fixture, "notes/new.txt", "scratch\n");

  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.untracked, 1);
  assert_eq!(status.files[0].kind, "untracked");
  assert_eq!(status.files[0].workdir.as_deref(), Some("?"));

  diff_of(&root(&fixture), &file, None, "workdir", None, "auto").unwrap();

  discard(&root(&fixture), &[file.clone()], &locks()).unwrap();
  assert!(!PathBuf::from(&file).exists());
  assert!(status_of(&root(&fixture)).unwrap().files.is_empty());
}

#[test]
fn unstage_in_an_unborn_repository_keeps_the_file() {
  let fixture = fixture("unstage-unborn");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  stage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  assert_eq!(status_of(&root(&fixture)).unwrap().staged, 1);

  unstage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.staged, 0);
  assert_eq!(status.untracked, 1);
  assert!(PathBuf::from(&file).exists());
}

#[test]
fn log_lists_a_linear_history_newest_first() {
  let fixture = fixture("log-order");
  let repo = init(&fixture);
  for index in 1..=5 {
    write(&fixture, "a.txt", &format!("{index}
"));
    commit_all(&repo, &format!("c{index}"));
  }
  let log = log_page(&root(&fixture), None, None, false).unwrap();
  let summaries: Vec<&str> = log.iter().map(|entry| entry.summary.as_str()).collect();
  assert_eq!(summaries, vec!["c5", "c4", "c3", "c2", "c1"]);
}

#[test]
fn ignored_paths_are_reported_but_not_counted_as_changes() {
  let fixture = fixture("status-ignored");
  let repo = init(&fixture);
  write(&fixture, ".gitignore", "*.log\nbuild/\n");
  write(&fixture, "kept.txt", "one\n");
  commit_all(&repo, "first");

  write(&fixture, "debug.log", "x\n");
  write(&fixture, "build/out.bin", "x\n");
  write(&fixture, "new.txt", "x\n");

  let status = status_of(&root(&fixture)).unwrap();
  // The ignored file and the ignored directory are reported for the Explorer's decoration…
  assert!(status
    .files
    .iter()
    .any(|file| file.path == "debug.log" && file.kind == "ignored"));
  assert!(status
    .files
    .iter()
    .any(|file| file.path.starts_with("build") && file.kind == "ignored"));
  // …and an ignored directory arrives as one path, not one per file inside it.
  assert!(!status
    .files
    .iter()
    .any(|file| file.path.contains("out.bin")));
  // They are not changes: the counters and the untracked file are unaffected.
  assert!(status
    .files
    .iter()
    .any(|file| file.path == "new.txt" && file.kind == "untracked"));
  assert_eq!(status.untracked, 1);
  // `changed` counts the working-tree half, and a new file has one (`?`); the two ignored paths
  // are still not part of it.
  assert_eq!(status.changed, 1);
  assert_eq!(status.staged, 0);
}

#[test]
fn paging_walks_the_same_history_once() {
  let fixture = fixture("log-pages");
  let repo = init(&fixture);
  for index in 1..=5 {
    write(&fixture, "a.txt", &format!("{index}\n"));
    commit_all(&repo, &format!("c{index}"));
  }

  let whole = log_page(&root(&fixture), None, None, false).unwrap();
  let expected = vec!["c5", "c4", "c3", "c2", "c1"];
  let summaries: Vec<&str> = whole.iter().map(|entry| entry.summary.as_str()).collect();
  assert_eq!(summaries, expected);

  // What "load all" leans on: skip counts rows already read, and the order does not depend on
  // the page boundaries. Two rows at a time must concatenate to the same list.
  let mut paged: Vec<String> = Vec::new();
  let mut skip = 0u32;
  while paged.len() < whole.len() {
    let page = log_page(&root(&fixture), Some(2), Some(skip), false).unwrap();
    if page.is_empty() {
      break;
    }
    skip += page.len() as u32;
    paged.extend(page.into_iter().map(|entry| entry.summary));
  }
  assert_eq!(paged, expected);
}

#[test]
fn every_ref_can_be_walked_and_its_tip_is_labelled() {
  let fixture = fixture("log-refs");
  let repo = init(&fixture);
  write(&fixture, "a.txt", "one\n");
  commit_all(&repo, "first");
  let base = repo.head().unwrap().shorthand().unwrap().to_string();
  let first = repo.head().unwrap().peel_to_commit().unwrap();
  let tree = first.tree().unwrap();
  let signature = repo.signature().unwrap();
  // Two branches off one commit, created without a checkout: the graph is about refs, not files.
  repo
    .commit(
      Some("refs/heads/side"),
      &signature,
      &signature,
      "side work",
      &tree,
      &[&first],
    )
    .unwrap();
  repo
    .commit(
      Some("HEAD"),
      &signature,
      &signature,
      "main work",
      &tree,
      &[&first],
    )
    .unwrap();

  // HEAD alone still shows one branch, which is what the panel has always done.
  let head_only = log_page(&root(&fixture), None, None, false).unwrap();
  assert_eq!(head_only.len(), 2);
  assert!(!head_only.iter().any(|entry| entry.summary == "side work"));

  // Every ref: the other branch is in the list, and its tip carries the name.
  let all = log_page(&root(&fixture), None, None, true).unwrap();
  assert_eq!(all.len(), 3);
  let side = all
    .iter()
    .find(|entry| entry.summary == "side work")
    .unwrap();
  assert!(side
    .refs
    .iter()
    .any(|label| label.name == "side" && label.kind == "local"));
  let tip = all
    .iter()
    .find(|entry| entry.summary == "main work")
    .unwrap();
  assert_eq!(
    tip.refs.first().map(|label| label.kind.as_str()),
    Some("head")
  );
  assert!(tip.refs.iter().any(|label| label.name == "HEAD"));
  assert!(tip
    .refs
    .iter()
    .any(|label| label.name == base && label.kind == "local"));
  assert!(side.refs.iter().all(|label| label.kind != "head"));
}

#[test]
fn a_merge_keeps_both_parents_and_tags_name_their_tip() {
  let fixture = fixture("log-merge");
  let repo = init(&fixture);
  write(&fixture, "a.txt", "one\n");
  commit_all(&repo, "first");
  let first = repo.head().unwrap().peel_to_commit().unwrap();
  let tree = first.tree().unwrap();
  let signature = repo.signature().unwrap();
  let side = repo
    .commit(
      Some("refs/heads/side"),
      &signature,
      &signature,
      "side work",
      &tree,
      &[&first],
    )
    .unwrap();
  let side = repo.find_commit(side).unwrap();
  let main = repo
    .commit(
      Some("HEAD"),
      &signature,
      &signature,
      "main work",
      &tree,
      &[&first],
    )
    .unwrap();
  let main = repo.find_commit(main).unwrap();
  repo
    .commit(
      Some("HEAD"),
      &signature,
      &signature,
      "merge side",
      &tree,
      &[&main, &side],
    )
    .unwrap();

  let tip = repo.head().unwrap().peel(git2::ObjectType::Any).unwrap();
  repo.tag_lightweight("v1", &tip, false).unwrap();
  repo
    .tag("v2", &tip, &signature, "annotated", false)
    .unwrap();

  let all = log_page(&root(&fixture), None, None, true).unwrap();
  assert_eq!(all.len(), 4);
  let merge = all
    .iter()
    .find(|entry| entry.summary == "merge side")
    .unwrap();
  assert_eq!(merge.parents.len(), 2);
  // Both tags point at the merge, lightweight and annotated alike.
  assert!(merge
    .refs
    .iter()
    .any(|label| label.name == "v1" && label.kind == "tag"));
  assert!(merge
    .refs
    .iter()
    .any(|label| label.name == "v2" && label.kind == "tag"));
  // The branch that was only reachable through the merge is in the list.
  assert!(all.iter().any(|entry| entry.summary == "side work"));
}

#[test]
fn unstaging_a_rename_restores_both_paths() {
  let fixture = fixture("rename-unstage");
  let _repo = init(&fixture);
  let old = write(&fixture, "a.txt", "one
");
  stage(&root(&fixture), &[old.clone()], &locks()).unwrap();
  commit(&root(&fixture), "first", None, &locks()).unwrap();

  let renamed = fixture.dir.join("b.txt");
  fs::rename(&old, &renamed).unwrap();
  let renamed = renamed.to_string_lossy().into_owned();
  stage(&root(&fixture), &[old.clone(), renamed.clone()], &locks()).unwrap();
  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.staged, 1);
  assert_eq!(status.files[0].index.as_deref(), Some("R"));
  assert_eq!(status.files[0].old_path.as_deref(), Some("a.txt"));

  unstage(&root(&fixture), &[renamed], &locks()).unwrap();
  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.staged, 0);
  let paths: Vec<(&str, &str, Option<&str>)> = status
    .files
    .iter()
    .map(|file| (file.path.as_str(), file.kind.as_str(), file.workdir.as_deref()))
    .collect();
  assert_eq!(
    paths,
    vec![("a.txt", "tracked", Some("D")), ("b.txt", "untracked", Some("?"))]
  );
}

#[test]
fn branching_switches_and_refuses_to_lose_changes() {
  let fixture = fixture("branches");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  stage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  commit(&root(&fixture), "first", None, &locks()).unwrap();
  let base = status_of(&root(&fixture))
    .unwrap()
    .repo
    .head
    .branch
    .unwrap();

  create_branch(&root(&fixture), "feature", true, &locks()).unwrap();
  assert_eq!(
    status_of(&root(&fixture)).unwrap().repo.head.branch.as_deref(),
    Some("feature")
  );
  assert!(branches_of(&root(&fixture))
    .unwrap()
    .iter()
    .any(|b| b.name == "feature" && b.current));

  write(&fixture, "a.txt", "dirty\n");
  assert_eq!(
    switch_branch(&root(&fixture), &base, &locks()).unwrap_err(),
    "git_dirty"
  );
  discard(&root(&fixture), &[file], &locks()).unwrap();
  switch_branch(&root(&fixture), &base, &locks()).unwrap();
  assert_eq!(
    status_of(&root(&fixture)).unwrap().repo.head.branch.as_deref(),
    Some(base.as_str())
  );

  assert_eq!(
    delete_branch(&root(&fixture), &base, false, &locks()).unwrap_err(),
    "git_branch_current"
  );
  delete_branch(&root(&fixture), "feature", false, &locks()).unwrap();
  assert!(!branches_of(&root(&fixture))
    .unwrap()
    .iter()
    .any(|b| b.name == "feature"));
  assert_eq!(
    switch_branch(&root(&fixture), "feature", &locks()).unwrap_err(),
    "git_branch_missing"
  );

  // A branch with work of its own is not deleted on the ordinary confirmation.
  create_branch(&root(&fixture), "unmerged", true, &locks()).unwrap();
  let extra = write(&fixture, "u.txt", "unmerged work
");
  stage(&root(&fixture), &[extra], &locks()).unwrap();
  commit(&root(&fixture), "unmerged work", None, &locks()).unwrap();
  switch_branch(&root(&fixture), &base, &locks()).unwrap();
  assert_eq!(
    delete_branch(&root(&fixture), "unmerged", false, &locks()).unwrap_err(),
    "git_branch_unmerged"
  );
  delete_branch(&root(&fixture), "unmerged", true, &locks()).unwrap();
  assert!(!branches_of(&root(&fixture))
    .unwrap()
    .iter()
    .any(|branch| branch.name == "unmerged"));
}

#[test]
fn a_canceled_fetch_reports_cancellation() {
  let remote = Fixture {
    dir: {
      let dir = std::env::temp_dir().join(format!("wrolp-git-cancel-{}", std::process::id()));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).unwrap();
      Repository::init_bare(&dir).unwrap();
      dir
    },
  };
  let url = remote.dir.to_string_lossy().into_owned();

  let a = fixture("cancel-a");
  let repo_a = Repository::init(&a.dir).unwrap();
  set_identity(&repo_a);
  add_remote(&repo_a, "origin", &url);
  write(&a, "a.txt", "one
");
  commit_all(&repo_a, "base");
  push_now(&root(&a));
  let branch = repo_a.head().unwrap().shorthand().unwrap().to_string();
  Repository::open_bare(&remote.dir)
    .unwrap()
    .set_head(&format!("refs/heads/{branch}"))
    .unwrap();

  let b = fixture("cancel-b");
  let repo_b = Repository::clone(&url, &b.dir).unwrap();
  set_identity(&repo_b);
  write(&b, "a.txt", "two
");
  commit_all(&repo_b, "second");
  push_now(&root(&b));

  // The flag is already set, so the first transfer callback must stop the fetch. This pins the
  // half of cancellation the panel owns: `git_cancel` sets this same flag on the same operation.
  let cancel = Arc::new(AtomicBool::new(true));
  let (sink, _) = quiet();
  let result = fetch_core(
    &root(&a),
    None,
    &AuthStore::default(),
    &GitLocks::default(),
    Arc::clone(&cancel),
    sink,
  );
  let error = match result {
    Ok(_) => panic!("a canceled fetch must not report success"),
    Err(error) => error,
  };
  assert_eq!(error, "git_canceled");
}

#[test]
fn a_remote_tracking_branch_checks_out_as_a_local_one() {
  let fixture = fixture("remote-checkout");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one
");
  stage(&root(&fixture), &[file], &locks()).unwrap();
  commit(&root(&fixture), "first", None, &locks()).unwrap();
  let base = status_of(&root(&fixture))
    .unwrap()
    .repo
    .head
    .branch
    .unwrap();

  let repo = Repository::open(&fixture.dir).unwrap();
  add_remote(&repo, "origin", "D:/nowhere.git");
  let oid = repo.head().unwrap().target().unwrap();
  repo
    .reference("refs/remotes/origin/feature", oid, true, "test")
    .unwrap();

  switch_branch(&root(&fixture), "origin/feature", &locks()).unwrap();
  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.repo.head.branch.as_deref(), Some("feature"));
  assert_eq!(
    status.repo.head.upstream.as_deref(),
    Some("origin/feature")
  );

  // The local branch now exists; asking again is a name clash, not a second checkout.
  assert_eq!(
    switch_branch(&root(&fixture), "origin/feature", &locks()).unwrap_err(),
    "git_branch_exists"
  );

  switch_branch(&root(&fixture), &base, &locks()).unwrap();
  assert_eq!(
    status_of(&root(&fixture)).unwrap().repo.head.branch.as_deref(),
    Some(base.as_str())
  );
}

#[test]
fn paths_outside_the_work_tree_are_refused() {
  let fixture = fixture("outside");
  let _repo = init(&fixture);
  let workdir = fixture.dir.clone();
  let outside = fixture.dir.parent().unwrap().join("elsewhere.txt");
  let outside = outside.to_string_lossy().into_owned();
  assert_eq!(
    rel_of(&workdir, &outside).unwrap_err(),
    "git_path_outside"
  );
  assert_eq!(
    stage(&root(&fixture), &[outside], &locks()).unwrap_err(),
    "git_path_outside"
  );
}

fn set_identity(repo: &Repository) {
  let mut config = repo.config().unwrap();
  config.set_str("user.name", "Test").unwrap();
  config.set_str("user.email", "test@example.com").unwrap();
}

fn add_remote(repo: &Repository, name: &str, url: &str) {
  repo.remote(name, url).unwrap();
  let mut config = repo.config().unwrap();
  config
    .set_str(
      &format!("remote.{name}.fetch"),
      &format!("+refs/heads/*:refs/remotes/{name}/*"),
    )
    .unwrap();
}

fn repo_in(dir: &Path) -> Repository {
  fs::create_dir_all(dir).unwrap();
  Repository::init(dir).unwrap()
}

fn commit_all(repo: &Repository, message: &str) {
  let mut index = repo.index().unwrap();
  index
    .add_all(["*"].iter(), IndexAddOption::DEFAULT, None)
    .unwrap();
  index.write().unwrap();
  let tree_id = index.write_tree().unwrap();
  drop(index);
  let tree = repo.find_tree(tree_id).unwrap();
  let signature = repo.signature().unwrap();
  let head = repo
    .head()
    .ok()
    .and_then(|head| head.peel_to_commit().ok());
  let parents: Vec<&git2::Commit<'_>> = head.iter().collect();
  repo
    .commit(
      Some("HEAD"),
      &signature,
      &signature,
      message,
      &tree,
      &parents,
    )
    .unwrap();
}

fn quiet() -> (Sink, Arc<Mutex<Vec<String>>>) {
  let phases = Arc::new(Mutex::new(Vec::new()));
  let captured = Arc::clone(&phases);
  (
    Arc::new(move |progress| {
      if let Ok(mut list) = captured.lock() {
        list.push(progress.phase);
      }
    }),
    phases,
  )
}

fn not_canceled() -> Arc<AtomicBool> {
  Arc::new(AtomicBool::new(false))
}

fn push_now(root: &str) {
  let (sink, phases) = quiet();
  push_core(
    root,
    None,
    &AuthStore::default(),
    &GitLocks::default(),
    not_canceled(),
    sink,
  )
  .unwrap();
  assert!(phases.lock().unwrap().iter().any(|phase| phase == "done"));
}

#[test]
fn local_remote_fetch_fast_forward_merge_conflict_and_push() {
  let remote = Fixture {
    dir: {
      let dir = std::env::temp_dir().join(format!("wrolp-git-remote-{}", std::process::id()));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).unwrap();
      Repository::init_bare(&dir).unwrap();
      dir
    },
  };
  let url = remote.dir.to_string_lossy().into_owned();

  let a = fixture("work-a");
  let repo_a = Repository::init(&a.dir).unwrap();
  set_identity(&repo_a);
  add_remote(&repo_a, "origin", &url);
  write(&a, "shared.txt", "base
");
  commit_all(&repo_a, "base");
  push_now(&root(&a));
  let branch = repo_a
    .head()
    .unwrap()
    .shorthand()
    .unwrap()
    .to_string();
  Repository::open_bare(&remote.dir)
    .unwrap()
    .set_head(&format!("refs/heads/{branch}"))
    .unwrap();

  let b = fixture("work-b");
  let repo_b = Repository::clone(&url, &b.dir).unwrap();
  set_identity(&repo_b);
  write(&b, "shared.txt", "theirs
");
  commit_all(&repo_b, "theirs");
  push_now(&root(&b));

  let (sink, phases) = quiet();
  let outcome = pull_core(
    &root(&a),
    None,
    &AuthStore::default(),
    None,
    &GitLocks::default(),
    not_canceled(),
    sink,
  )
  .unwrap();
  assert_eq!(outcome.result, "fast_forward");
  assert_eq!(
    fs::read_to_string(a.dir.join("shared.txt")).unwrap(),
    "theirs
"
  );
  assert!(phases.lock().unwrap().iter().any(|phase| phase == "done"));

  write(&a, "shared.txt", "ours
");
  commit_all(&repo_a, "ours");
  write(&b, "shared.txt", "theirs again
");
  commit_all(&repo_b, "theirs again");
  push_now(&root(&b));

  let (sink, _) = quiet();
  let outcome = pull_core(
    &root(&a),
    None,
    &AuthStore::default(),
    None,
    &GitLocks::default(),
    not_canceled(),
    sink,
  )
  .unwrap();
  assert_eq!(outcome.result, "conflicted");
  assert_eq!(outcome.conflicted, vec!["shared.txt".to_string()]);
  let status = status_of(&root(&a)).unwrap();
  assert_eq!(status.conflicted, 1);
  assert_eq!(status.repo.state, "merge");

  let abs = a.dir.join("shared.txt").to_string_lossy().into_owned();
  let sides = conflict_sides_of(&root(&a), &abs, "auto", "lf").unwrap();
  assert_eq!(sides.eol, "lf");
  assert!(!sides.binary);
  assert!(sides.merged.as_deref().unwrap().contains("<<<<<<<"));
  assert_eq!(sides.ours.as_deref(), Some("ours
"));
  assert_eq!(sides.theirs.as_deref(), Some("theirs again
"));

  merge_abort(&root(&a), &GitLocks::default()).unwrap();
  assert_eq!(status_of(&root(&a)).unwrap().repo.state, "clean");
  assert_eq!(fs::read_to_string(&abs).unwrap(), "ours
");

  let (sink, _) = quiet();
  let outcome = pull_core(
    &root(&a),
    None,
    &AuthStore::default(),
    None,
    &GitLocks::default(),
    not_canceled(),
    sink,
  )
  .unwrap();
  assert_eq!(outcome.result, "conflicted");
  resolve_conflict(&root(&a), &abs, "ours", &GitLocks::default()).unwrap();
  let status = status_of(&root(&a)).unwrap();
  assert_eq!(status.conflicted, 0);
  assert_eq!(status.repo.state, "merge");
  // With the conflicts gone the tree looks clean, but the merge still owns the repository:
  // switching away or pulling again would stack a second operation on it.
  assert_eq!(
    switch_branch(&root(&a), &branch, &GitLocks::default()).unwrap_err(),
    "git_state_busy"
  );
  let (sink, _) = quiet();
  let pull_error = match pull_core(
    &root(&a),
    None,
    &AuthStore::default(),
    None,
    &GitLocks::default(),
    not_canceled(),
    sink,
  ) {
    Ok(_) => panic!("a pull during a merge must be refused"),
    Err(error) => error,
  };
  assert_eq!(pull_error, "git_state_busy");
  commit(&root(&a), "merge", None, &GitLocks::default()).unwrap();
  assert_eq!(status_of(&root(&a)).unwrap().repo.state, "clean");
  let head = repo_a.head().unwrap().target().unwrap();
  assert_eq!(repo_a.find_commit(head).unwrap().parent_count(), 2);

  push_now(&root(&a));

  let (sink, _) = quiet();
  pull_core(
    &root(&b),
    None,
    &AuthStore::default(),
    None,
    &GitLocks::default(),
    not_canceled(),
    sink,
  )
  .unwrap();
  write(&b, "other.txt", "b side
");
  commit_all(&repo_b, "b side");
  push_now(&root(&b));

  write(&a, "other.txt", "a side
");
  commit_all(&repo_a, "a side");
  let (sink, _) = quiet();
  let error = match push_core(
    &root(&a),
    None,
    &AuthStore::default(),
    &GitLocks::default(),
    not_canceled(),
    sink,
  ) {
    Ok(_) => panic!("expected the push to be rejected"),
    Err(error) => error,
  };
  assert!(error.starts_with("git_push_rejected"), "{error}");
}

#[test]
fn scanning_reports_nested_repositories_up_to_the_depth() {
  let workspace = fixture("scan-depth");
  repo_in(&workspace.dir);
  repo_in(&workspace.dir.join("x/repo-one"));
  repo_in(&workspace.dir.join("x/y/repo-two"));

  let shallow = scan_repos(&workspace.dir.to_string_lossy(), 2).unwrap();
  let relatives: Vec<&str> = shallow
    .repos
    .iter()
    .map(|entry| entry.relative.as_str())
    .collect();
  assert_eq!(relatives, vec![".", "x/repo-one"]);
  assert_eq!(shallow.repos[0].source, "root");

  let deep = scan_repos(&workspace.dir.to_string_lossy(), 3).unwrap();
  let relatives: Vec<&str> = deep
    .repos
    .iter()
    .map(|entry| entry.relative.as_str())
    .collect();
  assert_eq!(relatives, vec![".", "x/repo-one", "x/y/repo-two"]);
}

#[test]
fn depth_zero_reports_only_the_folder_itself() {
  let workspace = fixture("scan-zero");
  repo_in(&workspace.dir.join("sub"));

  let scan = scan_repos(&workspace.dir.to_string_lossy(), 0).unwrap();
  assert!(scan.repos.is_empty());

  repo_in(&workspace.dir);
  let scan = scan_repos(&workspace.dir.to_string_lossy(), 0).unwrap();
  assert_eq!(scan.repos.len(), 1);
  assert_eq!(scan.repos[0].source, "root");
}

#[test]
fn a_parent_repository_comes_before_nested_ones() {
  let parent = fixture("scan-parent");
  repo_in(&parent.dir);
  let workspace = parent.dir.join("work/sub");
  fs::create_dir_all(&workspace).unwrap();
  repo_in(&workspace.join("inner"));

  let scan = scan_repos(&workspace.to_string_lossy(), 2).unwrap();
  let sources: Vec<&str> = scan.repos.iter().map(|entry| entry.source.as_str()).collect();
  assert_eq!(sources, vec!["parent", "scan"]);
  assert!(scan.repos[0].relative.starts_with("../"));
  assert_eq!(scan.repos[1].relative, "inner");
}

#[test]
fn ignored_bare_and_git_file_folders_are_not_listed() {
  let workspace = fixture("scan-ignored");
  repo_in(&workspace.dir.join("node_modules/pkg"));
  repo_in(&workspace.dir.join("target/pkg"));
  fs::create_dir_all(workspace.dir.join("bare.git")).unwrap();
  Repository::init_bare(workspace.dir.join("bare.git")).unwrap();
  let linked = workspace.dir.join("linked");
  fs::create_dir_all(linked.join("inside")).unwrap();
  fs::write(linked.join(".git"), "gitdir: elsewhere
").unwrap();
  repo_in(&linked.join("inside"));

  let scan = scan_repos(&workspace.dir.to_string_lossy(), 2).unwrap();
  assert!(scan.repos.is_empty(), "{:?}", scan.repos);
}

#[test]
fn a_found_repository_is_a_boundary() {
  let workspace = fixture("scan-boundary");
  repo_in(&workspace.dir.join("repo"));
  repo_in(&workspace.dir.join("repo/vendor"));

  let scan = scan_repos(&workspace.dir.to_string_lossy(), 3).unwrap();
  let relatives: Vec<&str> = scan
    .repos
    .iter()
    .map(|entry| entry.relative.as_str())
    .collect();
  assert_eq!(relatives, vec!["repo"]);
}

#[test]
fn the_summary_counts_the_same_changes_as_status() {
  let fixture = fixture("summary-counts");
  let _repo = init(&fixture);
  let tracked = write(&fixture, "a.txt", "one
");
  stage(&root(&fixture), &[tracked.clone()], &locks()).unwrap();
  commit(&root(&fixture), "first", None, &locks()).unwrap();
  write(&fixture, "a.txt", "two
");
  write(&fixture, "staged.txt", "staged
");
  stage(&root(&fixture), &[write(&fixture, "staged.txt", "staged
")], &locks()).unwrap();
  write(&fixture, "new.txt", "new
");

  let status = status_of(&root(&fixture)).unwrap();
  let summary = summary_of(&root(&fixture)).unwrap();
  assert_eq!(summary.staged, status.staged);
  assert_eq!(summary.changed, status.changed);
  assert_eq!(summary.untracked, status.untracked);
  assert_eq!(summary.conflicted, status.conflicted);
  assert_eq!(summary.files, status.files.len());
}

fn merge_branch(repo: &Repository, name: &str) {
  let reference = repo
    .find_reference(&format!("refs/heads/{name}"))
    .unwrap();
  let annotated = repo.reference_to_annotated_commit(&reference).unwrap();
  let mut checkout = CheckoutBuilder::new();
  checkout.conflict_style_merge(true);
  repo.merge(&[&annotated], None, Some(&mut checkout)).unwrap();
}

fn commit_path(root: &str, path: &str, message: &str) {
  stage(root, &[path.to_string()], &locks()).unwrap();
  commit(root, message, None, &locks()).unwrap();
}

fn conflict_fixture(name: &str, base: &[u8], ours: &[u8], theirs: &[u8]) -> Fixture {
  let fixture = fixture(name);
  let repo = init(&fixture);
  let file = fixture.dir.join("a.txt");
  let file_text = file.to_string_lossy().into_owned();
  let root = root(&fixture);
  fs::write(&file, base).unwrap();
  commit_path(&root, &file_text, "base");
  let base_branch = status_of(&root).unwrap().repo.head.branch.unwrap();
  let head = repo.head().unwrap().peel_to_commit().unwrap();
  repo.branch("theirs", &head, false).unwrap();
  drop(head);
  switch_branch(&root, "theirs", &locks()).unwrap();
  fs::write(&file, theirs).unwrap();
  commit_path(&root, &file_text, "theirs");
  switch_branch(&root, &base_branch, &locks()).unwrap();
  fs::write(&file, ours).unwrap();
  commit_path(&root, &file_text, "ours");
  merge_branch(&repo, "theirs");
  fixture
}

#[test]
fn a_merge_result_is_written_in_the_files_own_encoding_and_crlf() {
  let base = encoding::encode("first\r\nsecond\r\nthird\r\n", "gbk", false).unwrap();
  let ours = encoding::encode("first\r\nours\r\nthird\r\n", "gbk", false).unwrap();
  let theirs = encoding::encode("first\r\ntheirs\r\nthird\r\n", "gbk", false).unwrap();
  let fixture = conflict_fixture("merge-write-gbk", &base, &ours, &theirs);
  let root = root(&fixture);
  let abs = fixture.dir.join("a.txt").to_string_lossy().into_owned();

  let sides = conflict_sides_of(&root, &abs, "gbk", "lf").unwrap();
  assert!(!sides.binary);
  assert_eq!(sides.eol, "crlf");
  assert_eq!(sides.encoding, encoding::resolve_for_write("gbk").unwrap().name());
  assert!(sides.merged.as_deref().unwrap().contains("<<<<<<<"));

  let saved = write_resolution(&root, &abs, "first\nours\nthird\n", "gbk", "lf", &locks()).unwrap();
  assert_eq!(saved.encoding, encoding::resolve_for_write("gbk").unwrap().name());
  assert_eq!(
    fs::read(&abs).unwrap(),
    encoding::encode("first\r\nours\r\nthird\r\n", "gbk", false).unwrap()
  );
  let status = status_of(&root).unwrap();
  assert_eq!(status.conflicted, 0);
  assert!(status.files.iter().all(|file| file.kind != "conflicted"));
}

#[test]
fn a_bom_and_crlf_survive_the_merge_write() {
  let base = encoding::encode("one\r\ntwo\r\n", "utf-8", true).unwrap();
  let ours = encoding::encode("one\r\nmine\r\n", "utf-8", true).unwrap();
  let theirs = encoding::encode("one\r\nyours\r\n", "utf-8", true).unwrap();
  let fixture = conflict_fixture("merge-write-bom", &base, &ours, &theirs);
  let root = root(&fixture);
  let abs = fixture.dir.join("a.txt").to_string_lossy().into_owned();

  let sides = conflict_sides_of(&root, &abs, "utf-8", "lf").unwrap();
  assert!(sides.bom);
  assert_eq!(sides.eol, "crlf");
  write_resolution(&root, &abs, "one\nboth\n", "utf-8", "lf", &locks()).unwrap();
  assert_eq!(
    fs::read(&abs).unwrap(),
    encoding::encode("one\r\nboth\r\n", "utf-8", true).unwrap()
  );
  assert_eq!(status_of(&root).unwrap().conflicted, 0);
}

#[test]
fn a_deleted_side_can_be_resolved_by_deleting_the_file() {
  let fixture = fixture("merge-delete");
  let repo = init(&fixture);
  let root = root(&fixture);
  let file = fixture.dir.join("a.txt");
  let file_text = file.to_string_lossy().into_owned();
  fs::write(&file, "one\n").unwrap();
  commit_path(&root, &file_text, "base");
  let base_branch = status_of(&root).unwrap().repo.head.branch.unwrap();
  let head = repo.head().unwrap().peel_to_commit().unwrap();
  repo.branch("theirs", &head, false).unwrap();
  drop(head);
  switch_branch(&root, "theirs", &locks()).unwrap();
  fs::remove_file(&file).unwrap();
  commit_path(&root, &file_text, "theirs deletes");
  switch_branch(&root, &base_branch, &locks()).unwrap();
  fs::write(&file, "two\n").unwrap();
  commit_path(&root, &file_text, "ours edits");
  merge_branch(&repo, "theirs");

  let sides = conflict_sides_of(&root, &file_text, "auto", "lf").unwrap();
  assert!(sides.theirs.is_none());
  delete_resolution(&root, &file_text, &locks()).unwrap();
  assert!(!file.exists());
  let status = status_of(&root).unwrap();
  assert_eq!(status.conflicted, 0);
  assert!(status
    .files
    .iter()
    .any(|entry| entry.path == "a.txt" && entry.index.as_deref() == Some("D")));
}

#[test]
fn choosing_a_missing_side_deletes_instead_of_writing_an_empty_file() {
  let fixture = fixture("merge-delete-resolve");
  let repo = init(&fixture);
  let root = root(&fixture);
  let file = fixture.dir.join("a.txt");
  let file_text = file.to_string_lossy().into_owned();
  fs::write(&file, "one\n").unwrap();
  commit_path(&root, &file_text, "base");
  let base_branch = status_of(&root).unwrap().repo.head.branch.unwrap();
  let head = repo.head().unwrap().peel_to_commit().unwrap();
  repo.branch("theirs", &head, false).unwrap();
  drop(head);
  switch_branch(&root, "theirs", &locks()).unwrap();
  fs::remove_file(&file).unwrap();
  commit_path(&root, &file_text, "theirs deletes");
  switch_branch(&root, &base_branch, &locks()).unwrap();
  fs::write(&file, "two\n").unwrap();
  commit_path(&root, &file_text, "ours edits");
  merge_branch(&repo, "theirs");

  resolve_conflict(&root, &file_text, "theirs", &locks()).unwrap();
  assert!(!file.exists());
  assert_eq!(status_of(&root).unwrap().conflicted, 0);
}

#[test]
fn writing_a_resolution_needs_a_conflict() {
  let fixture = fixture("merge-not-conflicted");
  let _repo = init(&fixture);
  let root = root(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root, &file, "base");
  let error = match write_resolution(&root, &file, "two\n", "utf-8", "lf", &locks()) {
    Ok(_) => panic!("a non-conflicted path must be refused"),
    Err(error) => error,
  };
  assert_eq!(error, "git_not_conflicted");
  assert_eq!(
    delete_resolution(&root, &file, &locks()).unwrap_err(),
    "git_not_conflicted"
  );
}

fn exclude_file(fixture: &Fixture) -> PathBuf {
  fixture.dir.join(".git").join("info").join("exclude")
}

fn exclude_text(fixture: &Fixture) -> String {
  fs::read_to_string(exclude_file(fixture)).unwrap_or_default()
}

#[test]
fn local_ignore_hides_untracked_paths_and_stays_idempotent() {
  let fixture = fixture("local-ignore-file");
  let _repo = init(&fixture);
  let file = write(&fixture, "local.config.json", "{}\n");

  local_ignore(&file, &locks()).unwrap();
  assert!(exclude_text(&fixture)
    .lines()
    .any(|line| line == "/local.config.json"));

  let status = status_of(&root(&fixture)).unwrap();
  assert_eq!(status.untracked, 0);
  assert!(status
    .files
    .iter()
    .any(|entry| entry.path == "local.config.json" && entry.kind == "ignored"));

  local_ignore(&file, &locks()).unwrap();
  assert_eq!(
    exclude_text(&fixture).matches("/local.config.json").count(),
    1
  );
}

#[test]
fn local_ignore_of_a_directory_leaves_tracked_files_alone() {
  let fixture = fixture("local-ignore-dir");
  let _repo = init(&fixture);
  let kept = write(&fixture, "build/kept.txt", "one\n");
  commit_path(&root(&fixture), &kept, "first");
  write(&fixture, "build/out.txt", "x\n");
  write(&fixture, "build/kept.txt", "two\n");

  let dir = fixture.dir.join("build");
  local_ignore(&dir.to_string_lossy(), &locks()).unwrap();
  assert!(exclude_text(&fixture).lines().any(|line| line == "/build/"));

  let status = status_of(&root(&fixture)).unwrap();
  assert!(!status
    .files
    .iter()
    .any(|entry| entry.path == "build/out.txt" && entry.kind == "untracked"));
  // Ignore rules never apply to a tracked file: its change is still a change.
  assert!(status
    .files
    .iter()
    .any(|entry| entry.path == "build/kept.txt" && entry.workdir.as_deref() == Some("M")));
}

#[test]
fn local_ignore_refuses_a_tracked_path() {
  let fixture = fixture("local-ignore-tracked");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first");

  assert_eq!(local_ignore(&file, &locks()).unwrap_err(), "git_tracked");
  assert!(!exclude_text(&fixture).contains("/a.txt"));
}

#[test]
fn local_ignore_does_not_duplicate_a_gitignore_rule() {
  let fixture = fixture("local-ignore-gitignore");
  let _repo = init(&fixture);
  write(&fixture, ".gitignore", "*.log\n");
  let file = write(&fixture, "debug.log", "x\n");

  assert_eq!(
    local_ignore(&file, &locks()).unwrap_err(),
    "git_already_ignored"
  );
  assert!(!exclude_text(&fixture).contains("debug.log"));
}

#[test]
fn local_ignore_separates_its_line_from_an_unterminated_file() {
  let fixture = fixture("local-ignore-newline");
  let _repo = init(&fixture);
  fs::create_dir_all(fixture.dir.join(".git").join("info")).unwrap();
  fs::write(
    exclude_file(&fixture),
    "# a comment without a final newline",
  )
  .unwrap();
  let file = write(&fixture, "a.txt", "x\n");

  local_ignore(&file, &locks()).unwrap();
  assert!(exclude_text(&fixture).contains("\n/a.txt\n"));
  assert_eq!(status_of(&root(&fixture)).unwrap().untracked, 0);
}

#[test]
fn local_unignore_removes_only_the_named_line_and_keeps_the_rest() {
  let fixture = fixture("local-unignore");
  let _repo = init(&fixture);
  fs::create_dir_all(fixture.dir.join(".git").join("info")).unwrap();
  fs::write(exclude_file(&fixture), "# keep\r\n/a.txt\r\n/nested/\r\n").unwrap();

  local_unignore(&root(&fixture), "/a.txt", &locks()).unwrap();
  assert_eq!(exclude_text(&fixture), "# keep\r\n/nested/\r\n");
  assert_eq!(
    local_unignore(&root(&fixture), "/a.txt", &locks()).unwrap_err(),
    "git_no_local_ignore"
  );
  assert_eq!(
    local_unignore(&root(&fixture), "", &locks()).unwrap_err(),
    "git_pattern_invalid"
  );
}

#[test]
fn local_ignore_escapes_pattern_characters_and_anchors_the_path() {
  let fixture = fixture("local-ignore-chars");
  let _repo = init(&fixture);
  let bracket = write(&fixture, "a[1].txt", "x\n");
  let hash = write(&fixture, "#note.txt", "x\n");

  local_ignore(&bracket, &locks()).unwrap();
  local_ignore(&hash, &locks()).unwrap();
  let text = exclude_text(&fixture);
  assert!(text.lines().any(|line| line == "/a\\[1\\].txt"));
  assert!(text.lines().any(|line| line == "/#note.txt"));
  assert_eq!(status_of(&root(&fixture)).unwrap().untracked, 0);
}

#[test]
fn assume_unchanged_hides_edits_and_can_be_cleared() {
  let fixture = fixture("assume-unchanged");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first");
  write(&fixture, "a.txt", "two\n");
  let entry = &status_of(&root(&fixture)).unwrap().files[0];
  assert_eq!(entry.workdir.as_deref(), Some("M"));

  assert_eq!(
    assume_unchanged(&root(&fixture), &[file.clone()], true, &locks()).unwrap(),
    1
  );
  assert!(status_of(&root(&fixture)).unwrap().files.is_empty());
  // The worktree is untouched: only the index's opinion of it changed.
  assert_eq!(fs::read_to_string(&file).unwrap(), "two\n");

  // The bit lives in the index file, so a fresh repository handle still sees it.
  let reopened = Repository::open(&fixture.dir).unwrap();
  let index = reopened.index().unwrap();
  let entry = index.get_path(Path::new("a.txt"), 0).unwrap();
  assert!(entry.flags & git2::IndexEntryFlag::VALID.bits() != 0);

  assert_eq!(
    assume_unchanged(&root(&fixture), &[file.clone()], false, &locks()).unwrap(),
    1
  );
  let entry = &status_of(&root(&fixture)).unwrap().files[0];
  assert_eq!(entry.workdir.as_deref(), Some("M"));
}

#[test]
fn assume_unchanged_keeps_the_staged_half_visible() {
  let fixture = fixture("assume-staged");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first");
  write(&fixture, "a.txt", "two\n");
  stage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  write(&fixture, "a.txt", "three\n");

  assume_unchanged(&root(&fixture), &[file.clone()], true, &locks()).unwrap();
  let status = status_of(&root(&fixture)).unwrap();
  let entry = status
    .files
    .iter()
    .find(|file| file.path == "a.txt")
    .expect("the staged half is still a change");
  assert_eq!(entry.index.as_deref(), Some("M"));
  assert_eq!(entry.workdir, None);
}

#[test]
fn assume_unchanged_refuses_untracked_paths_and_an_empty_enable() {
  let fixture = fixture("assume-untracked");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");

  assert_eq!(
    assume_unchanged(&root(&fixture), &[file], true, &locks()).unwrap_err(),
    "git_untracked"
  );
  assert_eq!(
    assume_unchanged(&root(&fixture), &[], true, &locks()).unwrap_err(),
    "git_paths_empty"
  );
}

#[test]
fn local_view_and_state_describe_both_kinds_of_local_state() {
  let fixture = fixture("local-state");
  let _repo = init(&fixture);
  let tracked = write(&fixture, "kept.txt", "one\n");
  commit_path(&root(&fixture), &tracked, "first");
  write(&fixture, "kept.txt", "two\n");
  assume_unchanged(&root(&fixture), &[tracked.clone()], true, &locks()).unwrap();

  let ignored_dir = fixture.dir.join("build");
  fs::create_dir_all(&ignored_dir).unwrap();
  write(&fixture, "build/out.txt", "x\n");
  local_ignore(&ignored_dir.to_string_lossy(), &locks()).unwrap();

  let view = local_view(&root(&fixture)).unwrap();
  assert!(view.ignores.iter().any(|line| line == "/build/"));
  assert_eq!(view.assumed.len(), 1);
  assert_eq!(view.assumed[0].path, "kept.txt");
  assert!(!view.truncated);

  let state = local_state(&tracked).unwrap();
  assert!(state.tracked);
  assert!(state.assumed);
  assert!(!state.ignored);
  assert_eq!(state.local_pattern, None);

  let inside = fixture.dir.join("build").join("out.txt");
  let state = local_state(&inside.to_string_lossy()).unwrap();
  assert!(!state.tracked);
  assert!(state.ignored);
  assert_eq!(state.local_pattern.as_deref(), Some("/build/"));

  let state = local_state(&ignored_dir.to_string_lossy()).unwrap();
  assert!(!state.tracked);
  assert!(state.ignored);
  assert_eq!(state.local_pattern.as_deref(), Some("/build/"));
}

#[test]
fn local_view_caps_its_pattern_list() {
  let fixture = fixture("local-view-cap");
  let _repo = init(&fixture);
  fs::create_dir_all(fixture.dir.join(".git").join("info")).unwrap();
  let text: String = (0..501).map(|n| format!("/file-{n}.txt\n")).collect();
  fs::write(exclude_file(&fixture), text).unwrap();

  let view = local_view(&root(&fixture)).unwrap();
  assert_eq!(view.ignores.len(), 500);
  assert!(view.truncated);
}

#[test]
fn amend_replaces_the_head_and_keeps_the_original_author() {
  let fixture = fixture("amend-author");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first");

  // The amend runs as someone else: the author must still be the person who wrote the commit,
  // while the committer records who rewrote it.
  let reopened = Repository::open(&fixture.dir).unwrap();
  let mut config = reopened.config().unwrap();
  config.set_str("user.name", "Later").unwrap();
  config.set_str("user.email", "later@example.com").unwrap();
  drop(config);

  write(&fixture, "a.txt", "two\n");
  stage(&root(&fixture), &[file.clone()], &locks()).unwrap();
  let result = amend_commit(&root(&fixture), "second", None, &locks()).unwrap();

  let repo = Repository::open(&fixture.dir).unwrap();
  let head = repo.head().unwrap().peel_to_commit().unwrap();
  assert_eq!(head.id().to_string(), result.oid);
  assert_eq!(
    head.message().ok().map(|text| text.trim_end()),
    Some("second")
  );
  assert_eq!(head.author().name().ok(), Some("Test"));
  assert_eq!(head.committer().name().ok(), Some("Later"));
  assert_eq!(head.parent_count(), 0);
  let blob = head
    .tree()
    .unwrap()
    .get_path(Path::new("a.txt"))
    .unwrap()
    .to_object(&repo)
    .unwrap();
  assert_eq!(blob.as_blob().unwrap().content(), b"two\n");
}

#[test]
fn amend_can_change_only_the_message() {
  let fixture = fixture("amend-message");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first");
  let before = head_commit(&root(&fixture)).unwrap().unwrap();
  let before_tree = Repository::open(&fixture.dir)
    .unwrap()
    .head()
    .unwrap()
    .peel_to_commit()
    .unwrap()
    .tree_id();

  let result = amend_commit(&root(&fixture), "first, reworded", None, &locks()).unwrap();
  let after = head_commit(&root(&fixture)).unwrap().unwrap();
  assert_eq!(after.oid, result.oid);
  assert_ne!(after.oid, before.oid);
  assert_eq!(after.message.trim_end(), "first, reworded");

  let after_tree = Repository::open(&fixture.dir)
    .unwrap()
    .head()
    .unwrap()
    .peel_to_commit()
    .unwrap()
    .tree_id();
  assert_eq!(before_tree, after_tree);
}

#[test]
fn amend_keeps_the_parent_of_a_non_root_commit() {
  let fixture = fixture("amend-parent");
  let _repo = init(&fixture);
  let first = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &first, "first");
  let first_oid = head_commit(&root(&fixture)).unwrap().unwrap().oid;
  let second = write(&fixture, "b.txt", "two\n");
  commit_path(&root(&fixture), &second, "second");

  let result = amend_commit(&root(&fixture), "second, reworded", None, &locks()).unwrap();
  let repo = Repository::open(&fixture.dir).unwrap();
  let head = repo.head().unwrap().peel_to_commit().unwrap();
  assert_eq!(head.id().to_string(), result.oid);
  assert_eq!(head.parent_count(), 1);
  assert_eq!(head.parent_id(0).unwrap().to_string(), first_oid);
}

#[test]
fn amend_with_nothing_to_change_is_refused() {
  let fixture = fixture("amend-noop");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first");

  assert_eq!(
    amend_commit(&root(&fixture), "first", None, &locks()).unwrap_err(),
    "git_nothing_to_amend"
  );
}

#[test]
fn amend_on_an_unborn_branch_is_refused() {
  let fixture = fixture("amend-unborn");
  let _repo = init(&fixture);

  assert!(head_commit(&root(&fixture)).unwrap().is_none());
  assert_eq!(
    amend_commit(&root(&fixture), "first", None, &locks()).unwrap_err(),
    "git_no_head"
  );
}

#[test]
fn amend_during_a_merge_is_refused() {
  let fixture = fixture("amend-merge");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first");
  let head = Repository::open(&fixture.dir)
    .unwrap()
    .head()
    .unwrap()
    .peel_to_commit()
    .unwrap()
    .id();
  fs::write(
    fixture.dir.join(".git").join("MERGE_HEAD"),
    format!("{head}\n"),
  )
  .unwrap();

  assert_eq!(
    amend_commit(&root(&fixture), "first", None, &locks()).unwrap_err(),
    "git_amend_merge"
  );
}

#[test]
fn head_commit_reports_the_message_the_amend_box_prefills() {
  let fixture = fixture("head-commit");
  let _repo = init(&fixture);
  let file = write(&fixture, "a.txt", "one\n");
  commit_path(&root(&fixture), &file, "first line\n\nbody");

  let head = head_commit(&root(&fixture)).unwrap().unwrap();
  assert_eq!(head.message.trim_end(), "first line\n\nbody");
  assert_eq!(head.short.len(), 8);
}

#[test]
fn remotes_can_be_added_edited_and_removed() {
  let fixture = fixture("remotes-manage");
  let _repo = init(&fixture);
  let added = save_remote(
    &root(&fixture),
    "origin",
    "https://example.com/a.git",
    &locks(),
  )
  .unwrap();
  assert_eq!(added.len(), 1);
  assert_eq!(added[0].name, "origin");
  assert_eq!(added[0].url, "https://example.com/a.git");
  assert_eq!(added[0].host.as_deref(), Some("example.com"));

  // The same name is an edit, not a second remote.
  let edited = save_remote(&root(&fixture), "origin", "git@example.com:b.git", &locks()).unwrap();
  assert_eq!(edited.len(), 1);
  // User info is stripped from what the panel displays, but the config keeps the exact URL.
  assert_eq!(edited[0].url, "example.com:b.git");
  let reopened = Repository::open(&fixture.dir).unwrap();
  assert_eq!(
    reopened.find_remote("origin").unwrap().url().unwrap(),
    "git@example.com:b.git"
  );
  drop(reopened);

  let removed = remove_remote(&root(&fixture), "origin", &locks()).unwrap();
  assert!(removed.is_empty());
  assert!(Repository::open(&fixture.dir)
    .unwrap()
    .find_remote("origin")
    .is_err());
}

#[test]
fn adding_a_path_to_gitignore_writes_one_anchored_line() {
  let fixture = fixture("repo-ignore");
  let _repo = init(&fixture);
  let file = write(&fixture, "build.log", "noise
");
  let tracked = write(&fixture, "a.txt", "one
");
  stage(&root(&fixture), &[tracked.clone()], &locks()).unwrap();
  let ignore_file = fixture.dir.join(".gitignore");

  repo_ignore(&file, &locks()).unwrap();
  let text = fs::read_to_string(&ignore_file).unwrap();
  assert!(text.lines().any(|line| line == "/build.log"), "{text}");

  // Clicking twice is one wish: the line is not written again.
  repo_ignore(&file, &locks()).unwrap();
  let again = fs::read_to_string(&ignore_file).unwrap();
  assert_eq!(again.matches("/build.log").count(), 1, "{again}");

  // A path in the index belongs to the repository, not to an ignore file.
  assert_eq!(
    repo_ignore(&tracked, &locks()).unwrap_err(),
    "git_tracked"
  );
}

#[test]
fn a_clone_lands_in_the_named_folder_and_refuses_an_existing_one() {
  let origin = fixture("clone-origin");
  let _repo = init(&origin);
  let file = write(&origin, "a.txt", "from the remote
");
  stage(&root(&origin), &[file], &locks()).unwrap();
  commit(&root(&origin), "first", None, &locks()).unwrap();

  let dest = fixture("clone-dest");
  let (sink, phases) = quiet();
  let out = clone_core(
    &root(&origin),
    &root(&dest),
    "copy",
    &AuthStore::default(),
    &GitLocks::default(),
    not_canceled(),
    sink,
  )
  .unwrap();
  assert_eq!(
    fs::read_to_string(Path::new(&out).join("a.txt")).unwrap(),
    "from the remote
"
  );
  assert!(phases.lock().unwrap().iter().any(|phase| phase == "done"));

  // The name is the folder: a second clone into it is refused rather than merged into it.
  let (sink, _) = quiet();
  assert_eq!(
    clone_core(
      &root(&origin),
      &root(&dest),
      "copy",
      &AuthStore::default(),
      &GitLocks::default(),
      not_canceled(),
      sink,
    )
    .unwrap_err(),
    "git_clone_exists"
  );
}

#[test]
fn a_remote_needs_a_valid_name_and_a_url() {
  let fixture = fixture("remotes-invalid");
  let _repo = init(&fixture);
  for name in ["", "a b", "-origin", "a/b"] {
    assert_eq!(
      save_remote(&root(&fixture), name, "https://example.com/a.git", &locks()).unwrap_err(),
      "git_remote_name"
    );
  }
  assert_eq!(
    save_remote(&root(&fixture), "origin", "   ", &locks()).unwrap_err(),
    "git_remote_url"
  );
  assert_eq!(
    remove_remote(&root(&fixture), "origin", &locks()).unwrap_err(),
    "git_remote_missing"
  );
}
