//! Version history kept in a shadow git repository.
//!
//! Each tracked file gets its own bare repository in the application's data directory, and each
//! hand save becomes a commit in it. Nothing is written into the folders the user edits: this is a
//! private history store that happens to use git's object format, which buys content-addressed
//! dedup (a file saved ten times with two unchanged saves in between costs two blobs rather than
//! three copies of the whole text), a real timeline, and a folder `git log` can be pointed at — and
//! costs the ability to drop one version out of the middle, because that means rewriting history
//! and an editor should not do that quietly.
//!
//! One repository per file rather than one per project, so that renaming a file inside the editor
//! moves a folder instead of rewriting every commit that names it. A project's history then spans
//! one folder per file, which is the price; drafts and per-file settings pay it for the same
//! reason — this editor opens loose files, not projects.
//!
//! The user never sees a commit, a branch, or the word git.

use crate::draft;
use chrono::{TimeZone, Utc};
use git2::{Repository, Tree};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

/// The branch the shadow history is written to. Never `master` or `main`: a name this specific says
/// the repository belongs to the editor, and leaves the two common names free for whoever points
/// real git tooling at the folder.
const BRANCH: &str = "refs/heads/wrolp";

/// The name the history is filed under. Not a person — a real identity here would only invite the
/// assumption that these commits get pushed somewhere.
const AUTHOR_NAME: &str = "WROLP Editor";
const AUTHOR_EMAIL: &str = "wrolp@localhost";

/// What a repository stands for: where the file lives now, and the name it is filed under in every
/// commit. The second half never changes, because renaming it would mean rewriting history — the
/// file's path is what gets updated when it moves.
const META_FILE: &str = "wrolp-meta.json";

const MODE_FILE: i32 = 0o100644;
const MODE_TREE: i32 = 0o040000;
const MODE_TYPE: i32 = 0o170000;

/// Returned when a read is asked about a file with no repository yet. Not an error the user sees:
/// it is the answer to "does this file have versions", which is "no".
const MISSING: &str = "version_missing";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Meta {
  /// The file's current path, in the case the filesystem spells it. Display only.
  pub path: String,
  /// The tree entry every commit files this history under. Fixed at the first commit.
  pub entry: String,
}

/// One entry of a file's timeline: a commit, without its content.
///
/// The content stays in the repository and is fetched by `oid` when a diff is opened or a version
/// restored, so listing a long history never ships whole files over IPC.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionEntry {
  /// Hex commit id — the handle every later call needs.
  pub oid: String,
  /// Commit time, ISO-8601 UTC.
  pub ts: String,
  /// What the user called this version, in the language it was written in.
  pub message: Option<String>,
}

/// A file that has at least one version, as [`list`] reports it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSummary {
  pub path: String,
  pub name: String,
  /// Time of the newest version.
  pub latest_ts: String,
}

/// What a commit attempt did.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", tag = "status", content = "oid")]
pub enum AppendOutcome {
  Created(String),
  Skipped,
}

/// The limits the caller read out of the settings. Passed in rather than looked up here, so the
/// policy stays in one place and this layer can be tested without an application.
pub struct Policy {
  /// Files bigger than this are refused, counted in UTF-8 bytes.
  pub max_file_size: u64,
}

/// The store's base folder. Deliberately not created here: with versioning off the folder must not
/// appear at all.
pub fn base_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .app_config_dir()
      .map_err(|e| e.to_string())?
      .join("wrolp")
      .join("shadow"),
  )
}

/// Whether a file is tracked, from its own override and the global default.
///
/// Three states, and anything unrecognised follows the default — the same shape the other per-file
/// overrides have, so the frontend never decides which of the two wins.
pub fn tracking_on(override_value: Option<&str>, default: bool) -> bool {
  match override_value {
    Some("on") => true,
    Some("off") => false,
    _ => default,
  }
}

/// Whether a save is to be recorded at all.
///
/// A tracked file is the first condition; the second is about who asked. The timer runs whether or
/// not anybody is at the keyboard, so recording its writes fills the timeline with half-typed
/// lines — and that is a choice the user makes, not something the recording path assumes either
/// way. Kept apart from `tracking_on` because the two questions are asked together but by
/// different switches, and a caller that folds them gets one setting where the interface promises
/// two.
pub fn records(automatic: bool, auto_save_versions: bool, tracking: bool) -> bool {
  tracking && (!automatic || auto_save_versions)
}

/// Windows folds case for the whole filesystem; elsewhere a name is exactly what it says.
fn name_eq(a: &str, b: &str) -> bool {
  if cfg!(windows) {
    a.eq_ignore_ascii_case(b)
  } else {
    a == b
  }
}

fn is_tree_mode(mode: i32) -> bool {
  mode & MODE_TYPE == MODE_TREE
}

fn git_err(stage: &str, e: git2::Error) -> String {
  let cut: String = e.message().chars().take(120).collect();
  format!("version_git:{stage}:{cut}")
}

/// Where a file's shadow repository lives: its digest, led by the file's own name so the store
/// reads like something a person put there rather than like a cache. The same digest drafts use.
///
/// The label comes from the case-folded path, not the spelling that reached here: two spellings of
/// one file have to land on one folder, and a folder named after whichever spelling arrived first
/// would be two folders and two histories.
pub fn repo_dir(base: &Path, path: &str) -> PathBuf {
  let normalized = draft::normalize_path(path);
  let key = draft::path_key(path);
  base.join(format!("{}-{key}.git", draft::label_of(&normalized)))
}

fn read_meta(dir: &Path) -> Option<Meta> {
  let bytes = std::fs::read(dir.join(META_FILE)).ok()?;
  serde_json::from_slice::<Meta>(&bytes).ok()
}

fn write_meta(dir: &Path, meta: &Meta) -> Result<(), String> {
  let json = serde_json::to_vec_pretty(meta).map_err(|e| e.to_string())?;
  crate::commands::write_atomic(&dir.join(META_FILE), &json).map_err(|e| format!("state_write:{e}"))
}

/// The name a file's history is filed under: the name it had when it was first versioned.
///
/// A rename updates the metadata and leaves this alone, so the timeline a person reads after
/// renaming a file is the timeline they were reading before.
fn entry_name(path: &str) -> String {
  let preserved = draft::normalize_path_preserved(path);
  let name = preserved.rsplit(['/', '\\']).next().unwrap_or_default();
  // Git takes no entry called nothing, `.` or `..`. A path with no usable last component still
  // needs a name, and nothing else can collide with it: every other entry name came from a file.
  if name.is_empty() || name == "." || name == ".." {
    return "file".into();
  }
  name.to_string()
}

/// Open a file's repository.
///
/// `create` is a parameter because reading must not leave an empty repository behind: listing what
/// is tracked should not grow a folder for a file that was only ever opened.
fn open(base: &Path, path: &str, create: bool) -> Result<(Repository, Meta), String> {
  let dir = repo_dir(base, path);
  let current = || Meta {
    path: draft::normalize_path_preserved(path),
    entry: entry_name(path),
  };
  if dir.exists() {
    if let Ok(repo) = Repository::open(&dir) {
      // A repository that lost its metadata still holds its history, and the entry name is what
      // finds the file inside it. Reading that history under the *current* name is a guess, but it
      // keeps saving working, and a wrong guess shows up as a short timeline rather than a failure.
      let meta = read_meta(&dir).unwrap_or_else(current);
      return Ok((repo, meta));
    }
    // Half-deleted, or not a repository at all. The history is gone either way and the next save
    // starts a new one: a folder that fails every save would be the worse outcome.
    let _ = std::fs::remove_dir_all(&dir);
  }
  if !create {
    return Err(MISSING.into());
  }
  std::fs::create_dir_all(&dir).map_err(|e| format!("dir_create:{e}"))?;
  let repo = Repository::init_bare(&dir).map_err(|e| git_err("init", e))?;
  // A bare repository starts on the default branch; every write goes to one name instead.
  repo.set_head(BRANCH).map_err(|e| git_err("head", e))?;
  let meta = current();
  write_meta(&dir, &meta)?;
  Ok((repo, meta))
}

fn head_oid(repo: &Repository) -> Option<git2::Oid> {
  repo
    .find_reference(BRANCH)
    .ok()
    .and_then(|r| r.target())
    .or_else(|| repo.head().ok().and_then(|h| h.target()))
}

/// The object a name holds in a tree, matched the way the filesystem would on Windows.
///
/// Walking by hand rather than with `get_name` is what keeps one file's history in one line even if
/// the name reached here with different case.
fn child(tree: &Tree<'_>, name: &str) -> Option<(String, git2::Oid)> {
  for entry in tree.iter() {
    let text = String::from_utf8_lossy(entry.name_bytes()).into_owned();
    if name_eq(&text, name) {
      return if is_tree_mode(entry.filemode()) {
        None
      } else {
        Some((text, entry.id()))
      };
    }
  }
  None
}

/// The blob a commit holds for this file, `None` when the commit does not have it.
fn entry_oid(repo: &Repository, commit_oid: git2::Oid, name: &str) -> Option<git2::Oid> {
  let tree = repo.find_commit(commit_oid).ok()?.tree().ok()?;
  child(&tree, name).map(|(_, oid)| oid)
}

/// A new tree, holding `blob` under the name the file has always been filed under.
///
/// Everything else in the old tree is carried over: a history in which the file vanishes between
/// two saves would be a history nobody can read.
fn put_blob(
  repo: &Repository,
  base: Option<git2::Oid>,
  name: &str,
  blob: git2::Oid,
) -> Result<git2::Oid, String> {
  let mut builder = repo.treebuilder(None).map_err(|e| git_err("builder", e))?;
  let mut kept: Option<String> = None;
  if let Some(oid) = base {
    let tree = repo.find_tree(oid).map_err(|e| git_err("tree", e))?;
    for entry in tree.iter() {
      let text = String::from_utf8_lossy(entry.name_bytes());
      if name_eq(&text, name) {
        // The spelling already in the tree wins, so a name that arrives with different case does
        // not split the history in two.
        kept = Some(text.into_owned());
        continue;
      }
      builder
        .insert(entry.name_bytes(), entry.id(), entry.filemode())
        .map_err(|e| git_err("insert", e))?;
    }
  }
  builder
    .insert(
      kept.unwrap_or_else(|| name.to_string()).as_bytes(),
      blob,
      MODE_FILE,
    )
    .map_err(|e| git_err("insert", e))?;
  builder.write().map_err(|e| git_err("write", e))
}

/// The timestamp a version gets: `at` for a baseline standing for content that was already on disk,
/// the current time for anything the user just saved.
fn signature(at: Option<i64>) -> Result<git2::Signature<'static>, String> {
  match at {
    Some(seconds) => {
      let time = git2::Time::new(seconds, 0);
      git2::Signature::new(AUTHOR_NAME, AUTHOR_EMAIL, &time).map_err(|e| git_err("signature", e))
    }
    None => git2::Signature::now(AUTHOR_NAME, AUTHOR_EMAIL).map_err(|e| git_err("signature", e)),
  }
}

fn iso(seconds: i64) -> String {
  Utc
    .timestamp_opt(seconds, 0)
    .single()
    .map(|dt| dt.to_rfc3339())
    .unwrap_or_default()
}

/// The mtime a baseline should carry, so the first row of a timeline is dated when the file last
/// changed on disk rather than when the editor happened to be looking at it.
pub fn modified_epoch(path: &str) -> Option<i64> {
  std::fs::metadata(draft::normalize_path(path))
    .ok()
    .and_then(|m| m.modified().ok())
    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
    .map(|d| d.as_secs() as i64)
}

/// Record one save.
pub fn commit(
  base: &Path,
  path: &str,
  content: &str,
  message: Option<&str>,
  at: Option<i64>,
  policy: &Policy,
) -> Result<AppendOutcome, String> {
  let bytes = content.len() as u64;
  if bytes > policy.max_file_size {
    return Err(format!("version_too_large:{bytes}"));
  }
  if draft::path_key(path).is_empty() {
    return Err("path_unresolvable".into());
  }
  let (repo, meta) = open(base, path, true)?;
  let head = head_oid(&repo);
  let blob = repo
    .blob(content.as_bytes())
    .map_err(|e| git_err("blob", e))?;
  if head.and_then(|oid| entry_oid(&repo, oid, &meta.entry)) == Some(blob) {
    // Same content as the last version: recording it again would fill the timeline with rows that
    // all restore to the same text.
    return Ok(AppendOutcome::Skipped);
  }
  let base_tree = match head {
    Some(oid) => Some(
      repo
        .find_commit(oid)
        .map_err(|e| git_err("commit", e))?
        .tree()
        .map_err(|e| git_err("tree", e))?
        .id(),
    ),
    None => None,
  };
  let tree_oid = put_blob(&repo, base_tree, &meta.entry, blob)?;
  let tree = repo.find_tree(tree_oid).map_err(|e| git_err("tree", e))?;
  let author = signature(at)?;
  let parents: Vec<git2::Commit<'_>> = match head {
    Some(oid) => vec![repo.find_commit(oid).map_err(|e| git_err("commit", e))?],
    None => Vec::new(),
  };
  let refs: Vec<&git2::Commit<'_>> = parents.iter().collect();
  let none = String::new();
  let oid = repo
    .commit(
      Some(BRANCH),
      &author,
      &author,
      message.unwrap_or(&none),
      &tree,
      &refs,
    )
    .map_err(|e| git_err("commit", e))?;
  // The file may have moved on disk without the editor being told; the metadata is where the
  // current path lives.
  let wanted = draft::normalize_path_preserved(path);
  if meta.path != wanted {
    write_meta(
      &repo_dir(base, path),
      &Meta {
        path: wanted,
        entry: meta.entry,
      },
    )?;
  }
  Ok(AppendOutcome::Created(oid.to_string()))
}

/// The timeline of one file, newest first, stopping at `limit`.
pub fn entries(base: &Path, path: &str, limit: usize) -> Result<Vec<VersionEntry>, String> {
  if limit == 0 || draft::path_key(path).is_empty() || !repo_dir(base, path).exists() {
    return Ok(Vec::new());
  }
  let (repo, meta) = match open(base, path, false) {
    Ok(opened) => opened,
    // A repository that turned out to be unusable was removed by `open`: the answer to "what
    // versions does this file have" is then the same as for a file nobody has versioned.
    Err(e) if e == MISSING => return Ok(Vec::new()),
    Err(e) => return Err(e),
  };
  let head = match head_oid(&repo) {
    Some(oid) => oid,
    None => return Ok(Vec::new()),
  };
  let mut walk = repo.revwalk().map_err(|e| git_err("walk", e))?;
  walk.push(head).map_err(|e| git_err("walk", e))?;
  let mut out = Vec::new();
  for oid in walk {
    let oid = oid.map_err(|e| git_err("walk", e))?;
    if entry_oid(&repo, oid, &meta.entry).is_none() {
      continue;
    }
    let commit = repo.find_commit(oid).map_err(|e| git_err("commit", e))?;
    out.push(VersionEntry {
      oid: oid.to_string(),
      ts: iso(commit.time().seconds()),
      message: commit
        .summary()
        .map_err(|e| git_err("commit", e))?
        .map(str::to_string)
        .filter(|s| !s.is_empty()),
    });
    if out.len() >= limit {
      break;
    }
  }
  Ok(out)
}

/// The content of one version, fetched only when it is about to be shown or restored.
pub fn content_at(base: &Path, path: &str, oid: &str) -> Result<String, String> {
  let oid = git2::Oid::from_str(oid).map_err(|_| "version_git:bad_oid".to_string())?;
  let (repo, meta) = open(base, path, false)?;
  let blob = entry_oid(&repo, oid, &meta.entry)
    .ok_or_else(|| git_err("blob", git2::Error::from_str("no such version")))?;
  let blob = repo.find_blob(blob).map_err(|e| git_err("blob", e))?;
  Ok(String::from_utf8_lossy(blob.content()).into_owned())
}

/// Which files carry history, newest first across the whole store.
///
/// One repository open and one commit read per file: the metadata already knows the path, so
/// nothing has to walk a history just to fill in a list.
pub fn list(base: &Path) -> Result<Vec<VersionSummary>, String> {
  let mut out = Vec::new();
  let dirs = match std::fs::read_dir(base) {
    Ok(rd) => rd,
    // No folder yet means nothing has ever been versioned, which is the normal first run.
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(out),
    Err(e) => return Err(format!("dir_read:{e}")),
  };
  for entry in dirs.flatten() {
    let dir = entry.path();
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
      continue;
    }
    let Some(meta) = read_meta(&dir) else {
      continue;
    };
    let repo = match Repository::open(&dir) {
      Ok(r) => r,
      Err(_) => continue,
    };
    let head = match head_oid(&repo) {
      Some(oid) => oid,
      None => continue,
    };
    let commit = match repo.find_commit(head) {
      Ok(c) => c,
      Err(_) => continue,
    };
    let name = meta
      .path
      .rsplit(['/', '\\'])
      .next()
      .unwrap_or_default()
      .to_string();
    out.push(VersionSummary {
      path: meta.path,
      name,
      latest_ts: iso(commit.time().seconds()),
    });
  }
  out.sort_by(|a, b| {
    b.latest_ts
      .cmp(&a.latest_ts)
      .then_with(|| a.path.cmp(&b.path))
  });
  Ok(out)
}

/// Whether this file has any history — the question the save path asks before it writes a baseline.
pub fn has_versions(base: &Path, path: &str) -> Result<bool, String> {
  Ok(!entries(base, path, 1)?.is_empty())
}

/// True when `path` is `root` itself or sits inside it, comparing the way Windows does.
///
/// `old` and `new` arrive folded — that is how every store keys a path — while the path kept in a
/// repository's metadata is spelled the way the filesystem spells it. The match has to cross that
/// difference, and only the tail is carried over verbatim so the file's own name keeps its case.
fn rekeyed(current: &str, old: &str, new: &str) -> Option<String> {
  if old.is_empty() || !current.is_char_boundary(old.len()) {
    return None;
  }
  if name_eq(current, old) {
    return Some(new.to_string());
  }
  let inside = current.len() > old.len()
    && name_eq(&current[..old.len()], old)
    && matches!(current.as_bytes()[old.len()], b'\\' | b'/');
  if inside {
    return Some(format!("{}{}", new, &current[old.len()..]));
  }
  None
}

/// Re-home every history that pointed at `old` or inside it, after the editor renamed them.
///
/// A folder rename moves every file under it, so this walks the store rather than being handed the
/// two paths. Each repository keeps the path it stands for in its metadata, which is what makes the
/// walk possible without reading a single commit. Returns how many moved.
pub fn rekey_prefix(base: &Path, old: &str, new: &str) -> Result<u32, String> {
  if !base.exists() {
    return Ok(0);
  }
  let dirs = std::fs::read_dir(base).map_err(|e| format!("dir_read:{e}"))?;
  let mut moved = 0;
  for entry in dirs.flatten() {
    let dir = entry.path();
    if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
      continue;
    }
    let Some(meta) = read_meta(&dir) else {
      continue;
    };
    let Some(wanted) = rekeyed(&meta.path, old, new) else {
      continue;
    };
    if wanted == meta.path {
      continue;
    }
    let target = repo_dir(base, &wanted);
    if target.exists() {
      // The destination has its own history, which outranks the one being carried over: joining two
      // lines would mean inventing a parent for the first commit of one of them.
      continue;
    }
    std::fs::rename(&dir, &target).map_err(|e| format!("state_write:{e}"))?;
    write_meta(
      &target,
      &Meta {
        path: wanted,
        entry: meta.entry,
      },
    )?;
    moved += 1;
  }
  Ok(moved)
}

/// Forget every version the editor made.
pub fn clear(base: &Path) -> Result<(), String> {
  match std::fs::remove_dir_all(base) {
    Ok(()) => Ok(()),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
    Err(e) => Err(format!("state_write:{e}")),
  }
}

/// The content a file had before the editor changed it, sent along with the save it belongs to.
///
/// The caller has it and the store cannot: by the time this arrives, the file on disk holds the
/// new text. Without a baseline the first row of a timeline is the first save, and the state a
/// file was *found in* is the row a person most often wants to diff against.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionBaseline {
  pub content: String,
  pub message: Option<String>,
  /// When the file last changed on disk, in epoch seconds — taken before the save overwrote it.
  /// Absent means "use the mtime still on the file", which after a save is the save itself.
  pub at: Option<i64>,
}

/// What the versioning rules say about one file right now.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionState {
  /// Whether this file's saves are recorded as versions.
  pub tracking: bool,
  /// `on` / `off`, or null while the file follows the global default.
  #[serde(rename = "override")]
  pub overridden: Option<String>,
}

fn state_of(app: &AppHandle, path: &str) -> Result<VersionState, String> {
  let settings = crate::commands::settings_of(app);
  let overridden = crate::file_settings::versioning_for(app, path);
  Ok(VersionState {
    tracking: tracking_on(overridden.as_deref(), settings.versioning_enabled),
    overridden,
  })
}

/// Which of the two rules a file is under, and which one it is following.
///
/// Asked rather than computed in the frontend: the override beats the default, and a rule spelled
/// out in two places is a rule that drifts.
#[tauri::command]
pub fn versioning_state(app: AppHandle, path: String) -> Result<VersionState, String> {
  state_of(&app, &path)
}

/// Force a file on or off, or let it follow the default again with `None`.
#[tauri::command]
pub fn set_version_override(
  app: AppHandle,
  path: String,
  mode: Option<String>,
) -> Result<VersionState, String> {
  crate::file_settings::set_versioning(&app, &path, mode.as_deref())?;
  state_of(&app, &path)
}

/// Record a save, with the file's original content as the first row when there is no history yet.
///
/// Tracking is checked here rather than trusted from the caller: the same rule that decides what
/// the sidebar shows has to decide what gets written, or a stale frontend records a file the user
/// just switched off. `automatic` says the write came from the timer, which is off by default.
#[tauri::command]
pub fn add_version(
  app: AppHandle,
  path: String,
  content: String,
  message: Option<String>,
  baseline: Option<VersionBaseline>,
  automatic: bool,
) -> Result<AppendOutcome, String> {
  let settings = crate::commands::settings_of(&app);
  let state = state_of(&app, &path)?;
  if !records(automatic, settings.auto_save_versions, state.tracking) {
    return Ok(AppendOutcome::Skipped);
  }
  let base = base_dir(&app)?;
  let policy = Policy {
    max_file_size: settings.versioning_max_file_size,
  };
  if !has_versions(&base, &path)? {
    if let Some(first) = baseline {
      let at = first.at.or_else(|| modified_epoch(&path));
      commit(
        &base,
        &path,
        &first.content,
        first.message.as_deref(),
        at,
        &policy,
      )?;
    }
  }
  commit(&base, &path, &content, message.as_deref(), None, &policy)
}

/// A file's timeline, newest first, as deep as the setting allows.
#[tauri::command]
pub fn get_versions(app: AppHandle, path: String) -> Result<Vec<VersionEntry>, String> {
  let settings = crate::commands::settings_of(&app);
  let base = base_dir(&app)?;
  entries(&base, &path, settings.versioning_show_limit as usize)
}

/// One version's text, read only when it is about to be shown or restored.
#[tauri::command]
pub fn get_version_content(app: AppHandle, path: String, oid: String) -> Result<String, String> {
  let base = base_dir(&app)?;
  content_at(&base, &path, &oid)
}

/// Every file with history, newest first.
#[tauri::command]
pub fn list_versions(app: AppHandle) -> Result<Vec<VersionSummary>, String> {
  let base = base_dir(&app)?;
  list(&base)
}

#[tauri::command]
pub fn clear_versions(app: AppHandle) -> Result<(), String> {
  let base = base_dir(&app)?;
  clear(&base)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicU32, Ordering};

  static SEQ: AtomicU32 = AtomicU32::new(0);

  /// A scratch area outside the repository under test, with a `project` folder standing in for
  /// somewhere the user keeps files and a `shadow` folder standing in for the store.
  fn scratch(tag: &str) -> (PathBuf, PathBuf) {
    let n = SEQ.fetch_add(1, Ordering::SeqCst);
    let root =
      std::env::temp_dir().join(format!("wrolp-versioning-{}-{tag}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let project = root.join("project");
    std::fs::create_dir_all(&project).expect("project");
    (project, root.join("shadow"))
  }

  fn policy() -> Policy {
    Policy {
      max_file_size: 524_288,
    }
  }

  fn write_file(dir: &Path, rel: &str, text: &str) -> String {
    let path = dir.join(rel);
    if let Some(parent) = path.parent() {
      std::fs::create_dir_all(parent).expect("parent");
    }
    std::fs::write(&path, text).expect("write");
    path.to_string_lossy().into_owned()
  }

  /// With versioning off nothing calls this, but a read must not be able to create the store
  /// either: listing what is tracked should not grow a folder for a file only ever opened.
  #[test]
  fn a_read_never_creates_the_store() {
    let (project, base) = scratch("read-only");
    let file = write_file(&project, "a.txt", "hello");
    assert!(entries(&base, &file, 10).expect("entries").is_empty());
    assert!(!has_versions(&base, &file).expect("ask"));
    assert!(list(&base).expect("list").is_empty());
    assert!(!base.exists());
  }

  #[test]
  fn the_same_content_twice_is_one_version() {
    let (project, base) = scratch("dup");
    let file = write_file(&project, "a.txt", "one\n");
    assert!(matches!(
      commit(&base, &file, "one\n", None, None, &policy()).expect("first"),
      AppendOutcome::Created(_)
    ));
    assert!(matches!(
      commit(&base, &file, "one\n", None, None, &policy()).expect("again"),
      AppendOutcome::Skipped
    ));
    assert_eq!(entries(&base, &file, 10).expect("entries").len(), 1);
    commit(&base, &file, "two\n", None, None, &policy()).expect("second");
    let after = entries(&base, &file, 10).expect("entries");
    assert_eq!(after.len(), 2);
    assert_eq!(
      content_at(&base, &file, &after[0].oid).expect("newest"),
      "two\n"
    );
    assert_eq!(
      content_at(&base, &file, &after[1].oid).expect("oldest"),
      "one\n"
    );
  }

  #[test]
  fn a_baseline_keeps_the_time_the_file_had() {
    let (project, base) = scratch("baseline");
    let file = write_file(&project, "a.txt", "disk\n");
    let then = 1_700_000_000;
    commit(
      &base,
      &file,
      "disk\n",
      Some("初始版本"),
      Some(then),
      &policy(),
    )
    .expect("baseline");
    commit(&base, &file, "saved\n", None, None, &policy()).expect("save");
    let entries = entries(&base, &file, 10).expect("entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[1].message.as_deref(), Some("初始版本"));
    assert!(
      entries[1].ts.starts_with("2023-11-14"),
      "the baseline row is dated when the file was, not now: {}",
      entries[1].ts
    );
    assert!(entries[0].ts > entries[1].ts);
  }

  /// Two files in one folder are two histories, and neither mentions the other.
  #[test]
  fn one_files_history_does_not_mention_another() {
    let (project, base) = scratch("twofiles");
    let a = write_file(&project, "a.txt", "a1\n");
    let b = write_file(&project, "b.txt", "b1\n");
    for (file, text) in [(&a, "a2\n"), (&b, "b2\n"), (&a, "a3\n"), (&b, "b3\n")] {
      commit(&base, file, text, None, None, &policy()).expect("commit");
    }
    assert_eq!(entries(&base, &a, 10).expect("a").len(), 2);
    assert_eq!(entries(&base, &b, 10).expect("b").len(), 2);
    let newest = &entries(&base, &a, 10).unwrap()[0];
    assert_eq!(content_at(&base, &a, &newest.oid).expect("content"), "a3\n");
    let summaries = list(&base).expect("list");
    assert_eq!(summaries.len(), 2, "one file, one history");
    assert!(
      summaries[0].latest_ts >= summaries[1].latest_ts,
      "newest first"
    );
    assert!(
      summaries.iter().all(|s| s.path.ends_with(".txt")),
      "{summaries:?}"
    );
  }

  /// The read limit is what keeps a long history from being walked for a list of thirty.
  #[test]
  fn a_limit_stops_at_the_newest_versions() {
    let (project, base) = scratch("limit-read");
    let file = write_file(&project, "a.txt", "v1\n");
    for i in 1..8 {
      commit(&base, &file, &format!("v{i}\n"), None, None, &policy()).expect("commit");
    }
    assert_eq!(entries(&base, &file, 3).expect("three").len(), 3);
    assert_eq!(entries(&base, &file, 99).expect("all").len(), 7);
    assert!(entries(&base, &file, 0).expect("none").is_empty());
  }

  /// A file three folders down is versioned like a file on its own: the path is only a label, and
  /// the history hangs off the file.
  #[test]
  fn a_deep_file_is_versioned_like_a_shallow_one() {
    let (project, base) = scratch("deep");
    let deep = write_file(&project, "src/deep/file.rs", "v1");
    commit(&base, &deep, "v1", None, None, &policy()).expect("v1");
    commit(&base, &deep, "v2", None, None, &policy()).expect("v2");
    let entries = entries(&base, &deep, 10).expect("entries");
    assert_eq!(entries.len(), 2);
    assert_eq!(
      content_at(&base, &deep, &entries[1].oid).expect("old"),
      "v1"
    );
    let listed = list(&base).expect("list");
    assert_eq!(listed[0].name, "file.rs");
    assert!(listed[0].path.replace('\\', "/").contains("src/deep"));
  }

  /// Renaming inside the editor is the reason a file has its own repository: moving the folder
  /// moves the history, while the commits keep the name they were written with.
  #[test]
  fn a_rename_keeps_the_history_and_the_name_it_was_written_under() {
    let (project, base) = scratch("rename");
    let old = write_file(&project, "draft.txt", "v1");
    commit(&base, &old, "v1", None, None, &policy()).expect("v1");
    commit(&base, &old, "v2", None, None, &policy()).expect("v2");
    let entry = read_meta(&repo_dir(&base, &old)).expect("meta").entry;
    std::fs::rename(&old, project.join("final.txt")).expect("move on disk");
    let new = project.join("final.txt").to_string_lossy().into_owned();
    let old_key = draft::normalize_path(&old);
    let new_key = draft::normalize_path(&new);
    assert_eq!(rekey_prefix(&base, &old_key, &new_key).expect("rekey"), 1);
    assert!(!repo_dir(&base, &old).exists(), "the old key is gone");
    let after = entries(&base, &new, 10).expect("entries");
    assert_eq!(after.len(), 2, "the timeline came with the file");
    assert_eq!(content_at(&base, &new, &after[1].oid).expect("v1"), "v1");
    let meta = read_meta(&repo_dir(&base, &new)).expect("meta");
    assert_eq!(
      meta.entry, entry,
      "the commits keep the name they were written under"
    );
    assert!(
      meta.path.replace('\\', "/").ends_with("final.txt"),
      "{meta:?}"
    );
    // Saving under the new name continues the same line rather than starting a second one.
    commit(&base, &new, "v3", None, None, &policy()).expect("v3");
    assert_eq!(entries(&base, &new, 10).expect("entries").len(), 3);
  }

  /// A folder rename carries every file under it, which is why the store is walked rather than
  /// being handed the two paths.
  #[test]
  fn a_folder_rename_carries_every_file_under_it() {
    let (project, base) = scratch("rename-dir");
    let a = write_file(&project, "notes/a.txt", "a1");
    let b = write_file(&project, "notes/b.txt", "b1");
    commit(&base, &a, "a1", None, None, &policy()).expect("a");
    commit(&base, &b, "b1", None, None, &policy()).expect("b");
    std::fs::rename(project.join("notes"), project.join("kept")).expect("move on disk");
    let moved = rekey_prefix(
      &base,
      &draft::normalize_path(&project.join("notes").to_string_lossy()),
      &draft::normalize_path(&project.join("kept").to_string_lossy()),
    )
    .expect("rekey");
    assert_eq!(moved, 2, "both files followed the folder");
    let a2 = project.join("kept/a.txt").to_string_lossy().into_owned();
    let b2 = project.join("kept/b.txt").to_string_lossy().into_owned();
    assert_eq!(entries(&base, &a2, 10).expect("a").len(), 1);
    assert_eq!(entries(&base, &b2, 10).expect("b").len(), 1);
    // Files outside the renamed folder are nobody's business.
    let other = write_file(&project, "top.txt", "t1");
    commit(&base, &other, "t1", None, None, &policy()).expect("other");
    assert_eq!(
      rekey_prefix(&base, "z:\\nothing", "z:\\else").expect("no match"),
      0
    );
    assert_eq!(entries(&base, &other, 10).expect("still there").len(), 1);
  }

  /// A rename onto a name that already has history keeps that history: two lines cannot be joined
  /// without inventing a parent for the first commit of one of them.
  #[test]
  fn a_rename_onto_a_versioned_name_leaves_both_histories_alone() {
    let (project, base) = scratch("rename-onto");
    let a = write_file(&project, "a.txt", "a1");
    let b = write_file(&project, "b.txt", "b1");
    commit(&base, &a, "a1", None, None, &policy()).expect("a");
    commit(&base, &b, "b1", None, None, &policy()).expect("b");
    assert_eq!(
      rekey_prefix(
        &base,
        &draft::normalize_path(&a),
        &draft::normalize_path(&b)
      )
      .expect("refuse"),
      0,
      "nothing moved"
    );
    assert_eq!(entries(&base, &a, 10).expect("a").len(), 1);
    assert_eq!(entries(&base, &b, 10).expect("b").len(), 1);
  }

  /// A repository the user half-deleted is a repository with no history, not a save that fails
  /// forever.
  #[test]
  fn a_broken_store_is_restarted_by_the_next_save() {
    let (project, base) = scratch("broken");
    let file = write_file(&project, "a.txt", "one\n");
    commit(&base, &file, "one\n", None, None, &policy()).expect("first");
    let dir = repo_dir(&base, &file);
    // Objects are what a timeline is made of, so taking them away takes the timeline away.
    std::fs::remove_dir_all(dir.join("objects")).expect("objects");
    // The unusable folder is taken away rather than left to fail every save, so the file reads as
    // having no history until the next save starts a new one.
    assert!(entries(&base, &file, 10).expect("entries").is_empty());
    assert!(
      !repo_dir(&base, &file).exists(),
      "the half-deleted repository went away"
    );
    assert!(matches!(
      commit(&base, &file, "two\n", None, None, &policy()).expect("rebuild"),
      AppendOutcome::Created(_)
    ));
    assert_eq!(entries(&base, &file, 10).expect("entries").len(), 1);
    let oid = entries(&base, &file, 1).unwrap()[0].oid.clone();
    assert_eq!(content_at(&base, &file, &oid).expect("text"), "two\n");
  }

  /// Nothing about versioning may touch the folders being edited: the repository is an application
  /// artefact, not a project artefact.
  #[test]
  fn the_users_folder_is_not_written_to() {
    let (project, base) = scratch("clean");
    let file = write_file(&project, "notes/a.txt", "one\n");
    let before = listing_of(&project);
    assert!(!before.is_empty(), "the fixture has files in it");
    commit(&base, &file, "one\n", None, None, &policy()).expect("commit");
    commit(&base, &file, "two\n", None, None, &policy()).expect("commit");
    entries(&base, &file, 10).expect("entries");
    list(&base).expect("list");
    assert_eq!(listing_of(&project), before, "no .git, no .wrolp, nothing");
  }

  fn listing_of(dir: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
      for entry in std::fs::read_dir(&current).expect("read") {
        let path = entry.expect("entry").path();
        if path.is_dir() {
          stack.push(path.clone());
        }
        out.push(path.to_string_lossy().into_owned());
      }
    }
    out.sort();
    out
  }

  /// The repository is keyed by the same digest the drafts use, so one path is one identity in both
  /// stores.
  #[test]
  fn the_key_is_the_one_drafts_use() {
    let file = r"C:\Notes\work\report.md";
    let name = repo_dir(Path::new("X"), file)
      .file_name()
      .expect("name")
      .to_string_lossy()
      .into_owned();
    let digest = name
      .strip_suffix(".git")
      .expect("a git suffix")
      .rsplit('-')
      .next()
      .expect("a digest")
      .to_string();
    assert_eq!(digest, draft::path_key(file));
    assert!(name.starts_with("report.md-"), "{name}");
    assert_eq!(
      repo_dir(Path::new("X"), file),
      repo_dir(Path::new("X"), &file.to_uppercase())
    );
  }

  #[test]
  fn a_path_bigger_than_the_limit_is_refused_before_it_is_written() {
    let (project, base) = scratch("limit-size");
    let file = write_file(&project, "a.txt", "small\n");
    let policy = Policy { max_file_size: 16 };
    let big = "x".repeat(1_000);
    let err = commit(&base, &file, &big, None, None, &policy).expect_err("too large");
    assert!(err.starts_with("version_too_large:1000"), "{err}");
    assert!(!base.exists(), "a refusal must not create the store");
  }

  #[test]
  fn the_override_wins_over_the_default() {
    assert!(tracking_on(Some("on"), false));
    assert!(!tracking_on(Some("off"), true));
    assert!(tracking_on(None, true));
    assert!(!tracking_on(None, false));
    // Anything the store does not recognise follows the default rather than guessing.
    assert!(tracking_on(Some(""), true));
  }

  /// The timer is a second source of writes over the same file, and it is a separate switch:
  /// recording it by default would fill a timeline with whatever the interval happened to catch.
  #[test]
  fn an_untracked_or_unasked_save_records_nothing() {
    assert!(records(false, false, true), "a hand save of a tracked file");
    assert!(
      records(true, true, true),
      "the timer, when the user allowed it"
    );
    assert!(
      !records(true, false, true),
      "the timer records nothing by default"
    );
    assert!(
      !records(false, true, false),
      "neither switch records a file that is not tracked"
    );
    assert!(!records(true, true, false), "and neither does the timer");
  }

  #[test]
  fn a_name_that_git_cannot_hold_is_replaced() {
    assert_eq!(entry_name(" "), "file");
    assert_eq!(entry_name(r"C:\"), "file");
    assert_eq!(entry_name(r"C:\x\notes.md"), "notes.md");
  }

  #[test]
  fn a_saved_file_reports_a_time_for_its_baseline() {
    let (project, _base) = scratch("mtime");
    let file = write_file(&project, "a.txt", "one\n");
    assert!(modified_epoch(&file).expect("mtime") > 1_500_000_000);
    assert_eq!(modified_epoch(r"Z:\no\such\file.txt"), None);
  }

  #[test]
  fn clearing_takes_the_whole_store_with_it() {
    let (project, base) = scratch("clear");
    let file = write_file(&project, "a.txt", "one\n");
    commit(&base, &file, "one\n", None, None, &policy()).expect("commit");
    assert!(base.exists());
    clear(&base).expect("clear");
    assert!(!base.exists());
    clear(&base).expect("clearing twice is fine");
  }
}
