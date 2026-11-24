//! Notes: top-level markdown files in one folder, plus a small front-matter header.
//!
//! A note is not a new kind of document. It is an ordinary `.md` file the editor opens like
//! any other; the header only gives the sidebar a few things to sort and colour by. The
//! parser is deliberately shallow (no YAML dependency): one broken key loses that key, not
//! the note, and unknown keys are carried through untouched when the header is rewritten.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use chrono::{Local, NaiveDate};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::commands;
use crate::draft;

/// How much of a file the list reads. The header is at the top and so is the first heading;
/// a note whose title is past this point falls back to its file name.
const HEAD_BYTES: u64 = 4_096;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
  pub path: String,
  pub title: String,
  pub pinned: bool,
  pub tags: Vec<String>,
  /// `YYYY-MM-DD`, or absent.
  pub due: Option<String>,
  pub modified_at: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMetaUpdate {
  #[serde(default)]
  pub pinned: bool,
  #[serde(default)]
  pub tags: Vec<String>,
  #[serde(default)]
  pub due: Option<String>,
}

/// The effective notes folder: the chosen one, or the app's own; created on demand.
fn effective_notes_dir(app: &AppHandle) -> Result<PathBuf, String> {
  let settings = commands::settings_of(app);
  let chosen = settings.notes_dir.trim();
  let dir = if chosen.is_empty() {
    app
      .path()
      .app_config_dir()
      .map_err(|e| e.to_string())?
      .join("wrolp")
      .join("notes")
  } else {
    PathBuf::from(chosen)
  };
  fs::create_dir_all(&dir).map_err(|e| format!("dir_create:{e}"))?;
  Ok(dir)
}

fn notes_dir_string(app: &AppHandle) -> Result<String, String> {
  Ok(effective_notes_dir(app)?.to_string_lossy().to_string())
}

/// The current folder, for the empty state and the settings page.
#[tauri::command(async)]
pub fn notes_dir(app: AppHandle) -> Result<String, String> {
  notes_dir_string(&app)
}

#[tauri::command(async)]
pub fn list_notes(app: AppHandle) -> Result<Vec<NoteMeta>, String> {
  let dir = effective_notes_dir(&app)?;
  let entries = fs::read_dir(&dir).map_err(|e| format!("note_read:{e}"))?;
  let mut notes = Vec::new();
  for entry in entries.flatten() {
    let path = entry.path();
    if !path.is_file() || !is_markdown(&path) {
      continue;
    }
    if let Some(note) = read_note(&path) {
      notes.push(note);
    }
  }
  notes.sort_by(|a, b| b.modified_at.cmp(&a.modified_at));
  Ok(notes)
}

#[tauri::command(async)]
pub fn create_note(app: AppHandle, title: String) -> Result<NoteMeta, String> {
  let title = clean_title(&title);
  if title.is_empty() {
    return Err("note_unnamed".into());
  }
  let dir = effective_notes_dir(&app)?;
  let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
  let slug = slug_of(&title);
  let mut path = dir.join(format!("{slug}-{stamp}.md"));
  let mut suffix = 2;
  let mut file = loop {
    match OpenOptions::new().write(true).create_new(true).open(&path) {
      Ok(file) => break file,
      Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && suffix <= 100 => {
        path = dir.join(format!("{slug}-{stamp}-{suffix}.md"));
        suffix += 1;
      }
      Err(e) => return Err(format!("note_write:{e}")),
    }
  };
  let body = format!("# {title}\n\n");
  if let Err(e) = file.write_all(body.as_bytes()) {
    let _ = fs::remove_file(&path);
    return Err(format!("note_write:{e}"));
  }
  drop(file);
  read_note(&path).ok_or_else(|| "note_read:new note".to_string())
}

#[tauri::command(async)]
pub fn set_note_meta(
  app: AppHandle,
  path: String,
  meta: NoteMetaUpdate,
) -> Result<NoteMeta, String> {
  let file = note_path(&app, &path)?;
  // A note with unsaved text must not have its header changed underneath the editor. The
  // frontend also refuses a dirty open tab before calling; this is the copy that survives a
  // restart or a draft written while that tab was closed.
  if draft::load(&app, &file.to_string_lossy(), draft::DraftKey::Plain)?.is_some() {
    return Err("note_dirty".into());
  }
  let due = match meta
    .due
    .as_deref()
    .map(str::trim)
    .filter(|due| !due.is_empty())
  {
    Some(due) => {
      NaiveDate::parse_from_str(due, "%Y-%m-%d").map_err(|_| "note_due".to_string())?;
      Some(due.to_string())
    }
    None => None,
  };
  let tags = clean_tags(meta.tags);
  let bytes = fs::read(&file).map_err(|e| format!("note_read:{e}"))?;
  let text = String::from_utf8(bytes).map_err(|_| "note_read:not utf-8".to_string())?;
  let next = rewrite_meta(&text, meta.pinned, &tags, due.as_deref())?;
  commands::write_atomic(&file, next.as_bytes())?;
  read_note(&file).ok_or_else(|| "note_read:after write".to_string())
}

#[tauri::command(async)]
pub fn delete_note(app: AppHandle, path: String) -> Result<bool, String> {
  let file = note_path(&app, &path)?;
  let removed = match fs::remove_file(&file) {
    Ok(()) => true,
    Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
    Err(e) => return Err(format!("note_delete:{e}")),
  };
  // The note is a file, so its draft is the only other copy of unsaved text. Removing the
  // file and leaving the draft behind would offer it back the next time a file of that name
  // appeared; deleting the note is the whole of the decision.
  let _ = draft::clear(&app, &file.to_string_lossy());
  Ok(removed)
}

/// The path a meta/delete command may touch: a top-level `.md` inside the current notes
/// folder. A path elsewhere is refused rather than treated as a general file command.
fn note_path(app: &AppHandle, raw: &str) -> Result<PathBuf, String> {
  let dir = effective_notes_dir(app)?;
  let path = PathBuf::from(raw);
  if !is_markdown(&path) {
    return Err("note_out_of_scope".into());
  }
  let Some(parent) = path.parent() else {
    return Err("note_out_of_scope".into());
  };
  let dir_key = draft::normalize_path(&dir.to_string_lossy());
  let parent_key = draft::normalize_path(&parent.to_string_lossy());
  if dir_key.is_empty() || dir_key != parent_key {
    return Err("note_out_of_scope".into());
  }
  Ok(path)
}

fn is_markdown(path: &Path) -> bool {
  path
    .extension()
    .and_then(|ext| ext.to_str())
    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
}

fn read_note(path: &Path) -> Option<NoteMeta> {
  let metadata = fs::metadata(path).ok()?;
  let modified_at = commands::mtime_ms(&metadata);
  let mut file = fs::File::open(path).ok()?;
  let mut head = Vec::new();
  file.take(HEAD_BYTES).read_to_end(&mut head).ok()?;
  let text = String::from_utf8_lossy(&head);
  let parsed = parse_head(&text);
  let title = parsed
    .title
    .filter(|title| !title.trim().is_empty())
    .unwrap_or_else(|| {
      path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_default()
    });
  Some(NoteMeta {
    path: path.to_string_lossy().to_string(),
    title,
    pinned: parsed.pinned,
    tags: parsed.tags,
    due: parsed.due,
    modified_at,
  })
}

struct ParsedHead {
  pinned: bool,
  tags: Vec<String>,
  due: Option<String>,
  title: Option<String>,
}

fn parse_head(text: &str) -> ParsedHead {
  let (header, body) = split_header(text);
  let mut pinned = false;
  let mut tags = Vec::new();
  let mut due = None;
  for line in header {
    let Some((key, value)) = line.split_once(':') else {
      continue;
    };
    match key.trim().to_ascii_lowercase().as_str() {
      "pinned" => pinned = value.trim().eq_ignore_ascii_case("true"),
      "tags" => {
        tags = clean_tags(
          value
            .split([',', '，'])
            .map(str::trim)
            .map(str::to_string)
            .collect(),
        )
      }
      "due" => {
        if let Ok(date) = NaiveDate::parse_from_str(value.trim(), "%Y-%m-%d") {
          due = Some(date.format("%Y-%m-%d").to_string());
        }
      }
      _ => {}
    }
  }
  let title = body.lines().map(str::trim_start).find_map(|line| {
    line
      .strip_prefix("# ")
      .map(|title| title.trim().to_string())
  });
  ParsedHead {
    pinned,
    tags,
    due,
    title,
  }
}

/// Split a document into its header lines and its body. A header is only a header when it
/// opens and closes with `---` on their own lines; an unclosed one is simply part of the body.
fn split_header(text: &str) -> (Vec<String>, &str) {
  let start = if text.starts_with('\u{feff}') {
    '\u{feff}'.len_utf8()
  } else {
    0
  };
  let mut consumed = start;
  let rest = &text[start..];
  let mut lines = rest.split_inclusive('\n');
  let Some(first) = lines.next() else {
    return (Vec::new(), text);
  };
  if first.trim_end_matches(['\r', '\n']).trim() != "---" {
    return (Vec::new(), text);
  }
  consumed += first.len();
  let mut header = Vec::new();
  for line in lines {
    let clean = line.trim_end_matches(['\r', '\n']).to_string();
    if clean.trim() == "---" {
      consumed += line.len();
      return (header, &text[consumed..]);
    }
    header.push(clean);
    consumed += line.len();
  }
  (Vec::new(), text)
}

/// Rewrite only the header. The body is returned byte for byte, and unknown keys keep their
/// original text and order after the three the sidebar understands.
fn rewrite_meta(
  text: &str,
  pinned: bool,
  tags: &[String],
  due: Option<&str>,
) -> Result<String, String> {
  let (header, body) = split_header(text);
  let unknown: Vec<String> = header
    .iter()
    .filter(|line| match line.split_once(':') {
      Some((key, _)) => !matches!(
        key.trim().to_ascii_lowercase().as_str(),
        "pinned" | "tags" | "due"
      ),
      None => true,
    })
    .cloned()
    .collect();
  let mut lines = Vec::new();
  if pinned {
    lines.push("pinned: true".to_string());
  }
  if !tags.is_empty() {
    lines.push(format!("tags: {}", tags.join(", ")));
  }
  if let Some(due) = due {
    lines.push(format!("due: {due}"));
  }
  lines.extend(unknown);
  if lines.is_empty() {
    return Ok(body.to_string());
  }
  let br = if text.contains("\r\n") { "\r\n" } else { "\n" };
  Ok(format!("---{br}{}{br}---{br}{body}", lines.join(br)))
}

fn clean_title(title: &str) -> String {
  title
    .lines()
    .next()
    .unwrap_or("")
    .trim()
    .trim_start_matches('#')
    .trim()
    .to_string()
}

fn clean_tags(tags: Vec<String>) -> Vec<String> {
  let mut out = Vec::new();
  for tag in tags {
    let tag = tag.trim();
    if tag.is_empty() || tag.chars().count() > 64 {
      continue;
    }
    if out
      .iter()
      .any(|kept: &String| kept.eq_ignore_ascii_case(tag))
    {
      continue;
    }
    out.push(tag.to_string());
    if out.len() >= 32 {
      break;
    }
  }
  out
}

/// A file-name-safe version of a title. Chinese names stay as they are; characters Windows
/// refuses become dashes, and the result is capped so the timestamp still fits.
fn slug_of(title: &str) -> String {
  let mut out = String::new();
  for ch in title.chars() {
    if ch.is_control() || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
      out.push('-');
    } else {
      out.push(ch);
    }
  }
  let out = out
    .trim_matches(|c: char| c.is_whitespace() || c == '.')
    .to_string();
  let out: String = out.chars().take(40).collect();
  if out.trim().is_empty() {
    "note".to_string()
  } else {
    out
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_known_keys_and_the_first_heading() {
    let text = "---\npinned: true\ntags: work, 本周\ndue: 2026-10-09\ncustom: kept\n---\n# Title here\n\nbody\n";
    let (header, body) = split_header(text);
    assert_eq!(header.len(), 4);
    assert_eq!(body, "# Title here\n\nbody\n");
    let parsed = parse_head(text);
    assert!(parsed.pinned);
    assert_eq!(parsed.tags, vec!["work", "本周"]);
    assert_eq!(parsed.due.as_deref(), Some("2026-10-09"));
    assert_eq!(parsed.title.as_deref(), Some("Title here"));
  }

  #[test]
  fn a_broken_key_does_not_lose_the_others() {
    let parsed = parse_head("---\npinned: true\ntags: a, b\ndue: tomorrow\n---\nno heading\n");
    assert!(parsed.pinned);
    assert_eq!(parsed.tags, vec!["a", "b"]);
    assert_eq!(parsed.due, None);
    assert_eq!(parsed.title, None);
  }

  #[test]
  fn an_unclosed_header_is_body() {
    let text = "---\npinned: true\nno closing line\n# Still a title\n";
    let (header, body) = split_header(text);
    assert!(header.is_empty());
    assert_eq!(body, text);
    assert_eq!(parse_head(text).title.as_deref(), Some("Still a title"));
  }

  #[test]
  fn rewrite_keeps_the_body_and_unknown_keys() {
    let text = "---\ntags: old\ncustom: kept\n---\n# Body\n";
    let next = rewrite_meta(text, true, &["new".to_string()], Some("2026-11-30")).unwrap();
    assert_eq!(
      next,
      "---\npinned: true\ntags: new\ndue: 2026-11-30\ncustom: kept\n---\n# Body\n"
    );
  }

  #[test]
  fn rewrite_removes_an_empty_header() {
    let text = "---\ntags: old\n---\n# Body\n";
    assert_eq!(rewrite_meta(text, false, &[], None).unwrap(), "# Body\n");
    assert_eq!(
      rewrite_meta("# Body\n", false, &[], None).unwrap(),
      "# Body\n"
    );
  }

  #[test]
  fn slugs_are_safe_and_keep_chinese() {
    assert_eq!(slug_of("周三前定稿：排期/接口"), "周三前定稿：排期-接口");
    assert_eq!(slug_of("  ...  "), "note");
    assert_eq!(slug_of(&"x".repeat(60)).chars().count(), 40);
  }

  #[test]
  fn tags_are_trimmed_deduped_and_capped() {
    let tags = clean_tags(vec![
      " work ".into(),
      "WORK".into(),
      "".into(),
      "本周".into(),
    ]);
    assert_eq!(tags, vec!["work", "本周"]);
  }
}
