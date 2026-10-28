//! One file's two texts for the diff editor.
//!
//! The panel does not show a patch: it opens the same read-only Monaco comparison the rest of the
//! editor uses, which needs both full texts. A side can be missing (an added file has no old
//! side, a deleted one no new side), binary, encrypted or too large; those are answers the panel
//! renders as a sentence instead of as an empty buffer that looks like a deletion.

use git2::{ObjectType, Oid, Repository, Tree};
use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::AppHandle;

use super::{abs_of, discover, fail, git_path, rel_of, MAX_DIFF_BYTES};
use crate::{commands, crypto, encoding, file_settings};

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffSide {
  pub path: String,
  pub name: String,
  pub text: String,
  pub oid: Option<String>,
  pub missing: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DiffText {
  pub left: DiffSide,
  pub right: DiffSide,
  pub binary: bool,
  pub too_large: bool,
  pub submodule: bool,
  pub encrypted: bool,
}

/// `scope` is `workdir` (index → working tree), `index` (HEAD → index) or `commit` (first parent
/// → that commit, with `rev` naming the commit). `old_path` is the repository path a rename came
/// from, used only for the left-hand lookup; it is never written to.
#[tauri::command]
pub fn git_diff(
  app: AppHandle,
  root: String,
  path: String,
  old_path: Option<String>,
  scope: String,
  rev: Option<String>,
) -> Result<DiffText, String> {
  let normalized = crate::draft::normalize_path(&path);
  let preference = file_settings::encoding_for(
    &app,
    &normalized,
    &commands::stored_encoding(&app),
  );
  diff_of(
    &root,
    &path,
    old_path.as_deref(),
    &scope,
    rev.as_deref(),
    &preference,
  )
}

pub(crate) fn diff_of(
  root: &str,
  path: &str,
  old_path: Option<&str>,
  scope: &str,
  rev: Option<&str>,
  preference: &str,
) -> Result<DiffText, String> {
  let opened = discover(root)?;
  let rel = rel_of(&opened.workdir, path)?;
  let rel_text = git_path(&rel);
  let rel_path = Path::new(&rel_text);
  let abs = abs_of(&opened, &rel);
  let name = rel_path
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .unwrap_or_else(|| rel_text.clone());

  let (left_bytes, left_oid, left_missing, left_submodule) =
    left_side(&opened.repo, rel_path, old_path, scope, rev)?;
  let (right_bytes, right_oid, right_missing, right_submodule) =
    right_side(&opened.repo, rel_path, &abs, scope, rev)?;

  let submodule = left_submodule || right_submodule;
  let encrypted = left_bytes
    .as_deref()
    .map(crypto::is_container)
    .unwrap_or(false)
    || right_bytes
      .as_deref()
      .map(crypto::is_container)
      .unwrap_or(false);
  let too_large = left_bytes
    .as_ref()
    .map(|b| b.len() > MAX_DIFF_BYTES)
    .unwrap_or(false)
    || right_bytes
      .as_ref()
      .map(|b| b.len() > MAX_DIFF_BYTES)
      .unwrap_or(false);
  let binary = !submodule
    && !encrypted
    && (left_bytes.as_deref().map(looks_binary).unwrap_or(false)
      || right_bytes.as_deref().map(looks_binary).unwrap_or(false));

  let blocked = submodule || encrypted || binary || too_large;
  let (left_text, right_text) = if blocked {
    (String::new(), String::new())
  } else {
    (
      decode(left_bytes, preference)?,
      decode(right_bytes, preference)?,
    )
  };

  Ok(DiffText {
    left: DiffSide {
      path: abs.clone(),
      name: name.clone(),
      text: left_text,
      oid: left_oid,
      missing: left_missing,
    },
    right: DiffSide {
      path: abs,
      name,
      text: right_text,
      oid: right_oid,
      missing: right_missing,
    },
    binary,
    too_large,
    submodule,
    encrypted,
  })
}

type SideBytes = (Option<Vec<u8>>, Option<String>, bool, bool);

fn left_side(
  repo: &Repository,
  rel: &Path,
  old_path: Option<&str>,
  scope: &str,
  rev: Option<&str>,
) -> Result<SideBytes, String> {
  let lookup = old_rel(old_path).unwrap_or_else(|| rel.to_path_buf());
  match scope {
    "workdir" => index_side(repo, rel),
    "index" => match head_tree(repo) {
      Some(tree) => tree_side(repo, &tree, &lookup),
      None => Ok((None, None, true, false)),
    },
    "commit" => {
      let commit = find_commit(repo, rev)?;
      match commit.parent(0).ok().and_then(|p| p.tree().ok()) {
        Some(tree) => tree_side(repo, &tree, &lookup),
        None => Ok((None, None, true, false)),
      }
    }
    _ => Err("git_scope_unknown".into()),
  }
}

fn right_side(
  repo: &Repository,
  rel: &Path,
  abs: &str,
  scope: &str,
  rev: Option<&str>,
) -> Result<SideBytes, String> {
  match scope {
    "workdir" => workdir_side(abs),
    "index" => index_side(repo, rel),
    "commit" => {
      let commit = find_commit(repo, rev)?;
      let tree = commit.tree().map_err(|e| fail("tree", e))?;
      tree_side(repo, &tree, rel)
    }
    _ => Err("git_scope_unknown".into()),
  }
}

fn find_commit<'repo>(
  repo: &'repo Repository,
  rev: Option<&str>,
) -> Result<git2::Commit<'repo>, String> {
  let rev = rev.ok_or_else(|| "git_rev_missing".to_string())?;
  repo
    .revparse_single(rev)
    .and_then(|obj| obj.peel_to_commit())
    .map_err(|e| fail("rev", e))
}

fn head_tree(repo: &Repository) -> Option<Tree<'_>> {
  repo.head().ok()?.peel_to_tree().ok()
}

/// The index's stage-0 entry. A conflicted path has no stage 0, so this answers `missing` for it
/// and the conflict view is what shows its sides.
fn index_side(repo: &Repository, rel: &Path) -> Result<SideBytes, String> {
  let index = repo.index().map_err(|e| fail("index", e))?;
  let Some(entry) = index.get_path(rel, 0) else {
    return Ok((None, None, true, false));
  };
  let submodule = (entry.mode & 0o170000) == 0o160000;
  if submodule {
    return Ok((None, Some(entry.id.to_string()), false, true));
  }
  let bytes = blob_bytes(repo, entry.id)?;
  Ok((Some(bytes), Some(entry.id.to_string()), false, false))
}

fn tree_side(repo: &Repository, tree: &Tree<'_>, rel: &Path) -> Result<SideBytes, String> {
  let Ok(entry) = tree.get_path(rel) else {
    return Ok((None, None, true, false));
  };
  if entry.kind() == Some(ObjectType::Commit) {
    return Ok((None, Some(entry.id().to_string()), false, true));
  }
  let bytes = blob_bytes(repo, entry.id())?;
  Ok((Some(bytes), Some(entry.id().to_string()), false, false))
}

fn workdir_side(abs: &str) -> Result<SideBytes, String> {
  let path = Path::new(abs);
  match fs::symlink_metadata(path) {
    Ok(meta) if meta.is_dir() => Ok((None, None, false, true)),
    Ok(_) => match fs::read(path) {
      Ok(bytes) => Ok((Some(bytes), None, false, false)),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, None, true, false)),
      Err(e) => Err(format!("git_workdir:{e}")),
    },
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok((None, None, true, false)),
    Err(e) => Err(format!("git_workdir:{e}")),
  }
}

fn blob_bytes(repo: &Repository, oid: Oid) -> Result<Vec<u8>, String> {
  let blob = repo.find_blob(oid).map_err(|e| fail("blob", e))?;
  Ok(blob.content().to_vec())
}

fn decode(bytes: Option<Vec<u8>>, preference: &str) -> Result<String, String> {
  match bytes {
    Some(bytes) => Ok(encoding::decode(&bytes, preference)?.text),
    None => Ok(String::new()),
  }
}

/// The same heuristic git uses for its binary notice, trimmed to the start of the file: a NUL
/// byte in the first 8 KiB means the text is not text in any encoding this editor can write back.
fn looks_binary(bytes: &[u8]) -> bool {
  bytes.iter().take(8000).any(|b| *b == 0)
}

fn old_rel(old_path: Option<&str>) -> Option<PathBuf> {
  let raw = old_path?.trim();
  if raw.is_empty() {
    return None;
  }
  let path = PathBuf::from(raw.replace('\\', "/"));
  if path.is_absolute()
    || path
      .components()
      .any(|c| !matches!(c, Component::Normal(_)))
  {
    return None;
  }
  Some(path)
}
