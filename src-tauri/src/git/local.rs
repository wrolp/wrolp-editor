//! State that belongs to this machine rather than to the repository's history: a path ignored
//! through the repository's own `info/exclude`, and the index's assume-unchanged bit.
//!
//! Both are local by construction. `info/exclude` is a text file next to the repository's
//! configuration, shared by the worktrees of one clone but never committed; assume-unchanged is
//! one flag on an index entry, and the index is per working copy. Neither is visible from another
//! clone, which is exactly what makes them useful for files that are only noise on this machine.

use git2::{Index, IndexEntry, IndexEntryExtendedFlag, IndexEntryFlag};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use tauri::State;

use super::{abs_of, discover, fail, git_path, rel_of, GitLocks, Opened};

/// How many patterns or assumed paths one answer carries. The dialog is a list to act on, not a
/// registry; a hand-written exclude file with thousands of lines still gets a usable answer.
const MAX_LOCAL_ENTRIES: usize = 500;

/// The conflict stage lives in the top two bits of an entry's `flags`; stage 0 is the normal one.
const STAGE_MASK: u16 = 0x3000;

/// The bit `git update-index --assume-unchanged` sets.
const ASSUME_VALID: u16 = IndexEntryFlag::VALID.bits();

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalFile {
  pub path: String,
  pub abs: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalView {
  pub repo_root: String,
  pub exclude_path: String,
  pub exclude_exists: bool,
  /// Non-empty, non-comment lines of `info/exclude`, in file order.
  pub ignores: Vec<String>,
  /// Stage-0 index entries carrying the assume-unchanged bit.
  pub assumed: Vec<LocalFile>,
  pub truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathState {
  pub repo_root: String,
  /// The path has an index entry at some stage, so ignore rules cannot make it disappear.
  pub tracked: bool,
  /// The stage-0 entry carries assume-unchanged.
  pub assumed: bool,
  /// The stage-0 entry carries skip-worktree. Read-only for now: this feature does not write it.
  pub skip_worktree: bool,
  pub ignored: bool,
  /// The line in `info/exclude` that covers this path, when the app can name one.
  pub local_pattern: Option<String>,
  pub exclude_path: String,
}

#[tauri::command]
pub fn git_local_ignore(path: String, locks: State<'_, GitLocks>) -> Result<(), String> {
  local_ignore(&path, &locks)
}

/// Add a path to the repository's own `.gitignore` — the tracked file, shared with every clone.
/// `git_local_ignore` is the other half: same pattern, written to `.git/info/exclude` instead.
#[tauri::command]
pub fn git_repo_ignore(path: String, locks: State<'_, GitLocks>) -> Result<(), String> {
  repo_ignore(&path, &locks)
}

#[tauri::command]
pub fn git_local_unignore(
  root: String,
  pattern: String,
  locks: State<'_, GitLocks>,
) -> Result<(), String> {
  local_unignore(&root, &pattern, &locks)
}

#[tauri::command]
pub fn git_assume_unchanged(
  root: String,
  paths: Vec<String>,
  enabled: bool,
  locks: State<'_, GitLocks>,
) -> Result<usize, String> {
  assume_unchanged(&root, &paths, enabled, &locks)
}

#[tauri::command]
pub fn git_local_view(root: String) -> Result<LocalView, String> {
  local_view(&root)
}

#[tauri::command]
pub fn git_local_state(path: String) -> Result<LocalPathState, String> {
  local_state(&path)
}

#[tauri::command]
pub fn git_exclude_open(root: String) -> Result<String, String> {
  exclude_open(&root)
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/// Find the repository a path belongs to. A file is looked up from its parent, a directory from
/// itself: a nested repository is only found when discovery starts inside it, and walking up from
/// the group folder would find the repository above it instead.
fn discover_at(path: &str) -> Result<Opened, String> {
  let normalized = crate::draft::normalize_path(path);
  if normalized.is_empty() {
    return Err("git_no_folder".into());
  }
  let target = PathBuf::from(&normalized);
  if target.is_dir() {
    return discover(&normalized);
  }
  let parent = target.parent().ok_or_else(|| "git_no_folder".to_string())?;
  discover(&parent.to_string_lossy())
}

/// Where this working copy keeps its own ignore file. `commondir` is the repository's shared
/// `.git` even for a linked worktree; `path` would point into `worktrees/<name>` there.
fn exclude_path(opened: &Opened) -> PathBuf {
  opened.repo.commondir().join("info").join("exclude")
}

fn io_error(stage: &str, e: std::io::Error) -> String {
  let message: String = e.to_string().chars().take(160).collect();
  format!("git_{stage}:{message}")
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/// The line this path would add to `info/exclude`, anchored to the repository root so it cannot
/// match a same-named path somewhere else, and escaped so a file named `a[1].txt` is a literal.
fn pattern_for(rel: &Path, is_dir: bool) -> String {
  let mut out = String::from("/");
  let mut first = true;
  for component in rel.components() {
    let Component::Normal(part) = component else {
      continue;
    };
    if !first {
      out.push('/');
    }
    first = false;
    for ch in part.to_string_lossy().chars() {
      if matches!(ch, '\\' | '*' | '?' | '[' | ']') {
        out.push('\\');
      }
      out.push(ch);
    }
  }
  if is_dir {
    out.push('/');
  }
  out
}

/// The path itself, then each ancestor as a directory pattern, nearest first. A file inside a
/// locally ignored directory is covered by the directory's line, not by one of its own.
fn candidate_patterns(rel: &Path, is_dir: bool) -> Vec<String> {
  let mut out = vec![pattern_for(rel, is_dir)];
  let parts: Vec<Component<'_>> = rel
    .components()
    .filter(|component| matches!(component, Component::Normal(_)))
    .collect();
  for len in (1..parts.len()).rev() {
    let ancestor: PathBuf = parts[..len].iter().collect();
    out.push(pattern_for(&ancestor, true));
  }
  out
}

fn line_of<'a>(bytes: &'a [u8], index: usize, end: usize) -> &'a [u8] {
  let raw = &bytes[index..end];
  raw.strip_suffix(b"\r").unwrap_or(raw)
}

/// Whether an exact line is already present. Compared as bytes: the file may carry comments in an
/// encoding this app cannot decode, and rewriting those would be worse than leaving them alone.
fn has_line(bytes: &[u8], wanted: &str) -> bool {
  let target = wanted.as_bytes();
  let mut start = 0;
  for (index, byte) in bytes.iter().enumerate() {
    if *byte == b'\n' {
      if line_of(bytes, start, index) == target {
        return true;
      }
      start = index + 1;
    }
  }
  line_of(bytes, start, bytes.len()) == target
}

fn local_pattern(bytes: &[u8], rel: &Path, is_dir: bool) -> Option<String> {
  candidate_patterns(rel, is_dir)
    .into_iter()
    .find(|pattern| has_line(bytes, pattern))
}

fn append_pattern(path: &Path, bytes: &[u8], pattern: &str) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| io_error("exclude", e))?;
  }
  let mut addition = String::new();
  // A file that does not end in a newline would otherwise glue the new pattern to its last line.
  if !bytes.is_empty() && !bytes.ends_with(b"\n") {
    addition.push('\n');
  }
  addition.push_str(pattern);
  addition.push('\n');
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(path)
    .map_err(|e| io_error("exclude", e))?;
  file
    .write_all(addition.as_bytes())
    .map_err(|e| io_error("exclude", e))?;
  Ok(())
}

/// Remove every line equal to `pattern`, preserving the rest byte for byte. The replacement is
/// written beside the file and renamed over it, so a failure halfway never leaves an empty
/// exclude file behind.
fn remove_pattern(path: &Path, pattern: &str) -> Result<(), String> {
  let bytes = match fs::read(path) {
    Ok(bytes) => bytes,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err("git_no_local_ignore".into()),
    Err(e) => return Err(io_error("exclude", e)),
  };
  let target = pattern.as_bytes();
  let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
  let mut removed = false;
  let mut start = 0;
  for index in 0..=bytes.len() {
    if index == bytes.len() || bytes[index] == b'\n' {
      if line_of(&bytes, start, index) == target {
        removed = true;
      } else {
        out.extend_from_slice(&bytes[start..index]);
        if index < bytes.len() {
          out.push(b'\n');
        }
      }
      start = index + 1;
    }
  }
  if !removed {
    return Err("git_no_local_ignore".into());
  }
  let tmp = path.with_file_name(".exclude.tmp");
  {
    let mut file = fs::File::create(&tmp).map_err(|e| io_error("exclude", e))?;
    file.write_all(&out).map_err(|e| io_error("exclude", e))?;
  }
  fs::rename(&tmp, path).map_err(|e| {
    let _ = fs::remove_file(&tmp);
    io_error("exclude", e)
  })
}

// ---------------------------------------------------------------------------
// Index helpers
// ---------------------------------------------------------------------------

/// The entry at stage 0, else any conflict stage. Any stage means the path is tracked, which is
/// what decides whether an ignore rule can do anything for it.
fn index_any(index: &Index, rel: &Path) -> Option<IndexEntry> {
  (0..=3).find_map(|stage| index.get_path(rel, stage))
}

fn is_assumed(entry: &IndexEntry) -> bool {
  entry.flags & STAGE_MASK == 0 && entry.flags & ASSUME_VALID != 0
}

fn is_skip_worktree(entry: &IndexEntry) -> bool {
  entry.flags & STAGE_MASK == 0
    && entry.flags_extended & IndexEntryExtendedFlag::SKIP_WORKTREE.bits() != 0
}

// ---------------------------------------------------------------------------
// Ignore
// ---------------------------------------------------------------------------

pub(crate) fn local_ignore(path: &str, locks: &GitLocks) -> Result<(), String> {
  let opened = discover_at(path)?;
  let _guard = locks.acquire(opened.repo.commondir())?;
  let rel = rel_of(&opened.workdir, path)?;
  let rel_text = git_path(&rel);
  let is_dir = opened.workdir.join(&rel).is_dir();
  let index = opened.repo.index().map_err(|e| fail("index", e))?;
  if index_any(&index, &rel).is_some() {
    return Err("git_tracked".into());
  }
  // A directory-only rule (`/dir/`) matches a directory path only when it is spelled with its
  // trailing separator; the status list reports ignored directories that way for the same reason.
  let probe = if is_dir {
    format!("{rel_text}/")
  } else {
    rel_text.clone()
  };
  let file = exclude_path(&opened);
  let bytes = read_exclude(&file)?;
  let pattern = pattern_for(&rel, is_dir);
  // Already written by this app: clicking twice is one wish, not an error.
  if has_line(&bytes, &pattern) {
    return Ok(());
  }
  if opened
    .repo
    .is_path_ignored(Path::new(&probe))
    .map_err(|e| fail("ignore", e))?
  {
    return Err("git_already_ignored".into());
  }
  append_pattern(&file, &bytes, &pattern)
}

pub(crate) fn repo_ignore(path: &str, locks: &GitLocks) -> Result<(), String> {
  let opened = discover_at(path)?;
  let _guard = locks.acquire(opened.repo.commondir())?;
  let rel = rel_of(&opened.workdir, path)?;
  let is_dir = opened.workdir.join(&rel).is_dir();
  let index = opened.repo.index().map_err(|e| fail("index", e))?;
  if index_any(&index, &rel).is_some() {
    return Err("git_tracked".into());
  }
  // At the work tree root, not the git dir: this file is part of the repository's contents.
  let file = opened.workdir.join(".gitignore");
  let bytes = match fs::read(&file) {
    Ok(bytes) => bytes,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
    Err(e) => return Err(io_error("gitignore", e)),
  };
  let pattern = pattern_for(&rel, is_dir);
  // Already written by hand or by an earlier click: one wish, not an error.
  if has_line(&bytes, &pattern) {
    return Ok(());
  }
  append_pattern(&file, &bytes, &pattern)
}

pub(crate) fn local_unignore(root: &str, pattern: &str, locks: &GitLocks) -> Result<(), String> {
  if pattern.is_empty() || pattern.contains(['\n', '\r']) {
    return Err("git_pattern_invalid".into());
  }
  let opened = discover(root)?;
  let _guard = locks.acquire(opened.repo.commondir())?;
  remove_pattern(&exclude_path(&opened), pattern)
}

fn read_exclude(path: &Path) -> Result<Vec<u8>, String> {
  match fs::read(path) {
    Ok(bytes) => Ok(bytes),
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Vec::new()),
    Err(e) => Err(io_error("exclude", e)),
  }
}

pub(crate) fn local_view(root: &str) -> Result<LocalView, String> {
  let opened = discover(root)?;
  let file = exclude_path(&opened);
  let bytes = read_exclude(&file)?;
  let mut ignores = Vec::new();
  let mut truncated = false;
  let mut start = 0;
  for index in 0..=bytes.len() {
    if index == bytes.len() || bytes[index] == b'\n' {
      let line = line_of(&bytes, start, index);
      start = index + 1;
      if line.is_empty() || line[0] == b'#' {
        continue;
      }
      if ignores.len() >= MAX_LOCAL_ENTRIES {
        truncated = true;
        break;
      }
      ignores.push(String::from_utf8_lossy(line).into_owned());
    }
  }

  let index = opened.repo.index().map_err(|e| fail("index", e))?;
  let mut assumed = Vec::new();
  for entry in index.iter() {
    if !is_assumed(&entry) {
      continue;
    }
    if assumed.len() >= MAX_LOCAL_ENTRIES {
      truncated = true;
      break;
    }
    let path = String::from_utf8_lossy(&entry.path).replace('\\', "/");
    assumed.push(LocalFile {
      abs: abs_of(&opened, Path::new(&path)),
      path,
    });
  }
  assumed.sort_by(|a, b| a.path.cmp(&b.path));

  Ok(LocalView {
    repo_root: opened.display_root.clone(),
    exclude_exists: file.exists(),
    exclude_path: crate::draft::normalize_path_preserved(&file.to_string_lossy()),
    ignores,
    assumed,
    truncated,
  })
}

pub(crate) fn local_state(path: &str) -> Result<LocalPathState, String> {
  let opened = discover_at(path)?;
  let rel = rel_of(&opened.workdir, path)?;
  let rel_text = git_path(&rel);
  let is_dir = opened.workdir.join(&rel).is_dir();
  let index = opened.repo.index().map_err(|e| fail("index", e))?;
  let entry = index_any(&index, &rel);
  let probe = if is_dir {
    format!("{rel_text}/")
  } else {
    rel_text.clone()
  };
  let file = exclude_path(&opened);
  let bytes = read_exclude(&file)?;
  Ok(LocalPathState {
    repo_root: opened.display_root.clone(),
    tracked: entry.is_some(),
    assumed: entry.as_ref().map(is_assumed).unwrap_or(false),
    skip_worktree: entry.as_ref().map(is_skip_worktree).unwrap_or(false),
    ignored: opened
      .repo
      .is_path_ignored(Path::new(&probe))
      .map_err(|e| fail("ignore", e))?,
    local_pattern: local_pattern(&bytes, &rel, is_dir),
    exclude_path: crate::draft::normalize_path_preserved(&file.to_string_lossy()),
  })
}

/// Create the repository's own exclude file when it is missing, then hand back its path so the
/// frontend can open it like any other text file. Creation is what "open" means here: the user
/// asked to look at a file the repository is expected to have.
pub(crate) fn exclude_open(root: &str) -> Result<String, String> {
  let opened = discover(root)?;
  let path = exclude_path(&opened);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| io_error("exclude", e))?;
  }
  fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&path)
    .map_err(|e| io_error("exclude", e))?;
  Ok(crate::draft::normalize_path_preserved(
    &path.to_string_lossy(),
  ))
}

// ---------------------------------------------------------------------------
// Assume unchanged
// ---------------------------------------------------------------------------

/// Set or clear the assume-unchanged bit. `paths` empty means "every assumed entry" and is only
/// allowed while clearing: the dialog's "clear all" must not miss entries beyond its list cap.
pub(crate) fn assume_unchanged(
  root: &str,
  paths: &[String],
  enabled: bool,
  locks: &GitLocks,
) -> Result<usize, String> {
  if paths.is_empty() && enabled {
    return Err("git_paths_empty".into());
  }
  let opened = discover(root)?;
  let _guard = locks.acquire(&opened.workdir)?;
  let mut index = opened.repo.index().map_err(|e| fail("index", e))?;

  let targets: Vec<String> = if paths.is_empty() {
    index
      .iter()
      .filter(|entry| is_assumed(entry))
      .map(|entry| String::from_utf8_lossy(&entry.path).replace('\\', "/"))
      .collect()
  } else {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
      out.push(git_path(&rel_of(&opened.workdir, path)?));
    }
    out
  };

  // Validate every path before touching the index: a batch that fails halfway would leave a
  // state nobody asked for and no message that explains which half.
  let mut entries: Vec<IndexEntry> = Vec::with_capacity(targets.len());
  for rel_text in &targets {
    let rel = Path::new(rel_text);
    let Some(entry) = index.get_path(rel, 0) else {
      return Err(
        if (1..=3).any(|stage| index.get_path(rel, stage).is_some()) {
          "git_conflicted".into()
        } else {
          "git_untracked".into()
        },
      );
    };
    if entry.mode & 0o170000 == 0o160000 {
      return Err("git_submodule".into());
    }
    entries.push(entry);
  }

  let mut changed = 0usize;
  for mut entry in entries {
    let has = entry.flags & ASSUME_VALID != 0;
    if has == enabled {
      continue;
    }
    if enabled {
      entry.flags |= ASSUME_VALID;
    } else {
      entry.flags &= !ASSUME_VALID;
    }
    index.add(&entry).map_err(|e| fail("assume", e))?;
    changed += 1;
  }
  index.write().map_err(|e| fail("assume", e))?;
  Ok(changed)
}
