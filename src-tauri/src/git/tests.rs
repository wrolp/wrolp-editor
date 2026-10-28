//! Repository-level tests against real temporary work trees.
//!
//! No mocks: the behaviours worth pinning here — what `git status` reports after an edit, what
//! discard puts back, which branch a checkout lands on — are all libgit2's answers, and a fake
//! would only test the fake. Remotes are exercised in the transport tests where they appear.

use super::auth::AuthStore;
use super::branch::{branches_of, create_branch, delete_branch, switch_branch};
use super::diff::diff_of;
use super::history::{commit_files, log_page};
use super::index::{commit, discard, stage, unstage};
use super::remote::{
  conflict_sides_of, fetch_core, merge_abort, pull_core, push_core, resolve_conflict, Sink,
};
use super::status::status_of;
use super::{rel_of, GitLocks};
use git2::{IndexAddOption, Repository};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

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
  let sides = conflict_sides_of(&root(&a), &abs, "auto").unwrap();
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
