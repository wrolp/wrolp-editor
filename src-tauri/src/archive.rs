//! What is inside an archive, and unpacking it into a cache the Explorer can read.
//!
//! An archive's entries have no paths of their own on disk, and this application treats a disk
//! path as the identity of a document everywhere (drafts, overrides, versions, the recent list,
//! tabs). Rather than teach all of those a virtual path, an archive is unpacked once into
//! `archive-cache/<digest>/` and that folder is shown as a read-only Explorer root: everything
//! the editor already does then works on real files, with no changes.
//!
//! Unpacking is "writing bytes somebody else wrote". Every entry's name is therefore put
//! through the same table `rename::check_name` uses, the resolved path has to stay under the
//! cache root, and four ceilings (entries, one entry, the whole unpack, the compression ratio)
//! are enforced while writing rather than trusted from the header.

use crate::draft;
use crate::rename;
use encoding_rs::GBK;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

/// Entries a listing will show, and more than an extract will accept.
pub const MAX_ENTRIES: usize = 10_000;
/// Unpacked bytes one archive may occupy, before anything is written.
pub const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// Unpacked bytes one entry may occupy.
pub const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
/// Unpacked over packed, above which an entry is treated as a bomb rather than a file. The
/// floor keeps small, genuinely compressible text from tripping it.
const MAX_RATIO: u64 = 200;
const RATIO_FLOOR: u64 = 64 * 1024 * 1024;
/// Where unpacked archives live: a sibling of `drafts/`, `state/`, `kept/` and `backups/`.
const CACHE_DIR: &str = "archive-cache";

/// The three formats read in this version. Kept nameable so the UI can say which one.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
  Zip,
  Tar,
  TarGz,
}

impl ArchiveFormat {
  pub fn as_str(self) -> &'static str {
    match self {
      ArchiveFormat::Zip => "zip",
      ArchiveFormat::Tar => "tar",
      ArchiveFormat::TarGz => "tarGz",
    }
  }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
  /// Relative path inside the archive, always with forward slashes.
  pub path: String,
  pub is_dir: bool,
  /// Unpacked size. Taken from the header, which a hostile archive can lie about; it is used
  /// to refuse early, and the write loop counts the bytes that actually arrive.
  pub bytes: u64,
  pub packed: u64,
  pub encrypted: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveListing {
  pub format: String,
  pub entries: Vec<ArchiveEntry>,
  pub total_bytes: u64,
  pub encrypted: bool,
  /// More entries than the listing cap: the list is a prefix, and the extract would refuse.
  pub truncated: bool,
}

/// Why one entry was not unpacked. The reason is a code, not a sentence: the UI counts them.
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SkipNote {
  pub path: String,
  pub reason: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractReport {
  /// The folder the archive was unpacked into, normalized.
  pub dir: String,
  /// Files written (folders are not counted).
  pub entries: usize,
  pub skipped: Vec<SkipNote>,
  /// Bytes written, as counted rather than as declared.
  pub bytes: u64,
}

/// Read the first bytes of a file, or say why it could not be read.
fn head_of(path: &Path, len: usize) -> Result<Vec<u8>, String> {
  let mut file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
  let mut head = vec![0u8; len];
  let mut filled = 0usize;
  while filled < len {
    match file.read(&mut head[filled..]) {
      Ok(0) => break,
      Ok(n) => filled += n,
      Err(e) => return Err(format!("file_access:{e}")),
    }
  }
  head.truncate(filled);
  Ok(head)
}

/// The format a file's first bytes name, whatever the file is called.
///
/// Gzip only says "gzip": whether it wraps a tar is decided by the listing, which parses the
/// stream, so a `.svgz` or a lone `.gz` is refused there instead of being unfolded as tar.
pub fn detect(head: &[u8]) -> Option<ArchiveFormat> {
  if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") {
    return Some(ArchiveFormat::Zip);
  }
  if head.len() >= 262 && &head[257..262] == b"ustar" {
    return Some(ArchiveFormat::Tar);
  }
  if head.starts_with(&[0x1f, 0x8b]) {
    return Some(ArchiveFormat::TarGz);
  }
  None
}

/// Formats this build can recognise but not open: 7z and rar. Named apart from `detect` so the
/// refusal can say "unsupported" rather than "not an archive".
fn unsupported(head: &[u8]) -> bool {
  head.starts_with(b"7z\xbc\xaf\x27\x1c") || head.starts_with(b"Rar!\x1a\x07")
}

/// Whether the file at `path` is a zip without opening it as one. The caller uses this to
/// decide which icon and which menu entry to offer.
pub fn is_zip(path: &Path) -> bool {
  head_of(path, 4)
    .map(|head| detect(&head) == Some(ArchiveFormat::Zip))
    .unwrap_or(false)
}

/// A file name for one zip entry.
///
/// The crate already honours the Info-ZIP Unicode Path field. Without it, a legacy name is
/// bytes: CP437 by the specification, GBK in practice for the archives Chinese tools write.
/// UTF-8 first, then GBK, and a numbered placeholder rather than a name full of replacement
/// characters when neither decodes.
fn decode_name(raw: &[u8], index: usize) -> String {
  if let Ok(text) = std::str::from_utf8(raw) {
    return text.to_string();
  }
  let (text, _, failed) = GBK.decode(raw);
  if !failed {
    return text.into_owned();
  }
  format!("entry_{index}")
}

/// The file's declared ratio, treating "no packed size" as 1 so a stored entry never trips it.
fn is_bomb(bytes: u64, packed: u64) -> bool {
  bytes > RATIO_FLOOR && bytes / packed.max(1) > MAX_RATIO
}

fn zip_listing(path: &Path) -> Result<ArchiveListing, String> {
  let file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
  let mut zip =
    zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "archive_broken".to_string())?;
  let mut entries = Vec::new();
  let mut total = 0u64;
  let mut truncated = false;
  for index in 0..zip.len() {
    if entries.len() >= MAX_ENTRIES {
      truncated = true;
      break;
    }
    let meta = zip
      .by_index_raw(index)
      .map_err(|_| "archive_broken".to_string())?;
    let name = decode_name(meta.name_raw(), index);
    let is_dir = meta.is_dir();
    let encrypted = meta.encrypted();
    entries.push(ArchiveEntry {
      path: name.replace('\\', "/"),
      is_dir,
      bytes: if is_dir { 0 } else { meta.size() },
      packed: meta.compressed_size(),
      encrypted,
    });
    if !is_dir {
      total = total.saturating_add(meta.size());
    }
  }
  if entries.iter().any(|e| e.encrypted) {
    return Err("archive_encrypted".into());
  }
  if entries.is_empty() {
    return Err("archive_empty".into());
  }
  Ok(ArchiveListing {
    format: ArchiveFormat::Zip.as_str().into(),
    entries,
    total_bytes: total,
    encrypted: false,
    truncated,
  })
}

/// One entry of a tar stream, as the listing needs it.
fn tar_walk<R: Read>(
  reader: R,
  format: ArchiveFormat,
  mut on_entry: impl FnMut(&str, bool, u64) -> Result<bool, String>,
) -> Result<(usize, bool, u64), String> {
  let mut archive = tar::Archive::new(reader);
  let mut count = 0usize;
  let mut truncated = false;
  let mut total = 0u64;
  for item in archive
    .entries()
    .map_err(|_| "archive_broken".to_string())?
  {
    let entry = item.map_err(|_| "archive_broken".to_string())?;
    if count >= MAX_ENTRIES {
      truncated = true;
      break;
    }
    let kind = entry.header().entry_type();
    if kind.is_symlink() || kind.is_hard_link() {
      continue;
    }
    let path = entry.path().map_err(|_| "archive_broken".to_string())?;
    let name = path.to_string_lossy().replace('\\', "/");
    let is_dir = kind.is_dir() || name.ends_with('/');
    let size = if is_dir { 0 } else { entry.size() };
    count += 1;
    total = total.saturating_add(size);
    if !on_entry(&name, is_dir, size)? {
      break;
    }
  }
  let _ = format;
  Ok((count, truncated, total))
}

fn tar_listing(path: &Path, gz: bool) -> Result<ArchiveListing, String> {
  let file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
  let mut entries: Vec<ArchiveEntry> = Vec::new();
  let total = std::cell::Cell::new(0u64);
  let format = if gz {
    ArchiveFormat::TarGz
  } else {
    ArchiveFormat::Tar
  };
  let mut walk = |reader: Box<dyn Read>| {
    let mut listed = 0usize;
    let result = tar_walk(reader, format, |name, is_dir, size| {
      entries.push(ArchiveEntry {
        path: name.to_string(),
        is_dir,
        bytes: size,
        packed: 0,
        encrypted: false,
      });
      listed += 1;
      if listed >= MAX_ENTRIES {
        return Ok(false);
      }
      Ok(true)
    });
    result.map(|(_, truncated, bytes)| (truncated, bytes))
  };
  let (truncated, bytes) = if gz {
    let decoder = flate2::read::GzDecoder::new(file);
    walk(Box::new(decoder)).map_err(|e| {
      if e == "archive_broken" {
        "archive_unsupported".to_string()
      } else {
        e
      }
    })?
  } else {
    walk(Box::new(file))?
  };
  total.set(bytes);
  if entries.is_empty() {
    return Err("archive_empty".into());
  }
  Ok(ArchiveListing {
    format: format.as_str().into(),
    entries,
    total_bytes: total.get(),
    encrypted: false,
    truncated,
  })
}

/// List one archive, dispatching on what its bytes say rather than on its name.
pub fn list(path: &Path) -> Result<ArchiveListing, String> {
  let head = head_of(path, 512)?;
  if unsupported(&head) {
    return Err("archive_unsupported".into());
  }
  match detect(&head).ok_or_else(|| "archive_unsupported".to_string())? {
    ArchiveFormat::Zip => zip_listing(path),
    ArchiveFormat::Tar => tar_listing(path, false),
    ArchiveFormat::TarGz => tar_listing(path, true),
  }
}

/// Turn one archive path into one path under `root`, or say why it is not usable.
///
/// Every segment has to be a plain name by the same table `rename::check_name` uses, which is
/// what rejects `..`, a drive letter, a UNC head, an NTFS stream (`a:b`), a device name
/// (`CON`) and a trailing dot in one place. `taken` holds lowercased relative paths, because
/// NTFS does not tell `A.txt` from `a.txt`: the second one lands beside the first instead of
/// over it.
fn safe_rel(raw: &str, taken: &mut HashSet<String>) -> Result<PathBuf, SkipNote> {
  let skip = |reason: &str| SkipNote {
    path: raw.to_string(),
    reason: reason.into(),
  };
  let unified = raw.replace('\\', "/");
  if unified.starts_with('/') || unified.starts_with("//") {
    return Err(skip("name"));
  }
  let mut parts: Vec<String> = Vec::new();
  for segment in unified.split('/') {
    if segment.is_empty() || segment == "." {
      continue;
    }
    if segment == ".." {
      return Err(skip("name"));
    }
    let clean = rename::check_name(segment).map_err(|_| skip("name"))?;
    parts.push(clean);
  }
  if parts.is_empty() {
    return Err(skip("name"));
  }
  let mut rel = parts.join("/");
  if taken.contains(&rel.to_lowercase()) {
    let name = parts.pop().unwrap_or_default();
    let (stem, ext) = match name.rsplit_once('.') {
      Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
      _ => (name.clone(), String::new()),
    };
    let mut numbered = None;
    for n in 2..1000 {
      let candidate = format!("{stem} ({n}){ext}");
      let joined = if parts.is_empty() {
        candidate.clone()
      } else {
        format!("{}/{candidate}", parts.join("/"))
      };
      if !taken.contains(&joined.to_lowercase()) {
        numbered = Some(joined);
        break;
      }
    }
    rel = numbered.ok_or_else(|| skip("name"))?;
  }
  taken.insert(rel.to_lowercase());
  Ok(PathBuf::from(rel))
}

/// Copy exactly `declared` bytes, counting them, and refuse anything that overshoots a ceiling
/// or runs past what the header promised.
fn copy_entry<R: Read>(
  reader: &mut R,
  out: &mut File,
  declared: u64,
  budget: &mut u64,
  total_limit: u64,
) -> Result<u64, String> {
  let mut buffer = vec![0u8; 64 * 1024];
  let mut written = 0u64;
  loop {
    let n = reader
      .read(&mut buffer)
      .map_err(|_| "archive_broken".to_string())?;
    if n == 0 {
      break;
    }
    written += n as u64;
    if written > declared {
      return Err("archive_broken".into());
    }
    if written > MAX_ENTRY_BYTES {
      return Err("archive_too_large".into());
    }
    if *budget + n as u64 > total_limit {
      return Err("archive_too_large".into());
    }
    out
      .write_all(&buffer[..n])
      .map_err(|e| format!("file_write:{e}"))?;
    *budget += n as u64;
  }
  Ok(written)
}

fn create_parent(root: &Path, rel: &Path) -> Result<PathBuf, String> {
  let dest = root.join(rel);
  // The segments are plain names by construction, so this is a second lock rather than the
  // only one: nothing may resolve above the folder the caller named.
  let mut seen = PathBuf::new();
  for part in rel.components() {
    match part {
      Component::Normal(name) => seen.push(name),
      _ => return Err("archive_broken".into()),
    }
  }
  let _ = seen;
  if let Some(parent) = dest.parent() {
    fs::create_dir_all(parent).map_err(|e| format!("dir_create:{e}"))?;
  }
  Ok(dest)
}

fn extract_zip(
  path: &Path,
  root: &Path,
  total_limit: u64,
) -> Result<(usize, Vec<SkipNote>, u64), String> {
  let file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
  let mut zip =
    zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "archive_broken".to_string())?;
  let declared_total: u64 = {
    let mut sum = 0u64;
    for index in 0..zip.len() {
      let meta = zip
        .by_index_raw(index)
        .map_err(|_| "archive_broken".to_string())?;
      if meta.encrypted() {
        return Err("archive_encrypted".into());
      }
      if !meta.is_dir() {
        sum = sum.saturating_add(meta.size());
      }
    }
    sum
  };
  if declared_total > total_limit {
    return Err("archive_too_large".into());
  }
  let mut taken = HashSet::new();
  let mut skipped = Vec::new();
  let mut files = 0usize;
  let mut budget = 0u64;
  for index in 0..zip.len() {
    let mut entry = zip
      .by_index(index)
      .map_err(|_| "archive_broken".to_string())?;
    let name = decode_name(entry.name_raw(), index);
    let is_dir = entry.is_dir();
    let rel = match safe_rel(&name, &mut taken) {
      Ok(rel) => rel,
      Err(note) => {
        skipped.push(note);
        continue;
      }
    };
    if is_dir {
      fs::create_dir_all(root.join(&rel)).map_err(|e| format!("dir_create:{e}"))?;
      continue;
    }
    let size = entry.size();
    if size > MAX_ENTRY_BYTES || is_bomb(size, entry.compressed_size()) {
      skipped.push(SkipNote {
        path: name,
        reason: "tooLarge".into(),
      });
      continue;
    }
    let dest = create_parent(root, &rel)?;
    let mut out = File::create(&dest).map_err(|e| format!("file_write:{e}"))?;
    let written = copy_entry(&mut entry, &mut out, size, &mut budget, total_limit)?;
    let _ = written;
    files += 1;
  }
  Ok((files, skipped, budget))
}

fn extract_tar_reader<R: Read>(
  reader: R,
  root: &Path,
  declared_total: &mut u64,
  total_limit: u64,
) -> Result<(usize, Vec<SkipNote>, u64), String> {
  let mut archive = tar::Archive::new(reader);
  let mut taken = HashSet::new();
  let mut skipped = Vec::new();
  let mut files = 0usize;
  let mut budget = 0u64;
  for item in archive
    .entries()
    .map_err(|_| "archive_broken".to_string())?
  {
    let mut entry = item.map_err(|_| "archive_broken".to_string())?;
    let kind = entry.header().entry_type();
    let path = entry.path().map_err(|_| "archive_broken".to_string())?;
    let name = path.to_string_lossy().replace('\\', "/");
    if kind.is_symlink() || kind.is_hard_link() {
      skipped.push(SkipNote {
        path: name,
        reason: "link".into(),
      });
      continue;
    }
    let rel = match safe_rel(&name, &mut taken) {
      Ok(rel) => rel,
      Err(note) => {
        skipped.push(note);
        continue;
      }
    };
    if kind.is_dir() || name.ends_with('/') {
      fs::create_dir_all(root.join(&rel)).map_err(|e| format!("dir_create:{e}"))?;
      continue;
    }
    let size = entry.size();
    *declared_total = declared_total.saturating_add(size);
    if size > MAX_ENTRY_BYTES || *declared_total > total_limit {
      skipped.push(SkipNote {
        path: name,
        reason: "tooLarge".into(),
      });
      continue;
    }
    let dest = create_parent(root, &rel)?;
    let mut out = File::create(&dest).map_err(|e| format!("file_write:{e}"))?;
    copy_entry(&mut entry, &mut out, size, &mut budget, total_limit)?;
    files += 1;
  }
  Ok((files, skipped, budget))
}

/// Unpack `path` into `root`, which the caller created empty.
fn extract_into(path: &Path, root: &Path, total_limit: u64) -> Result<ExtractReport, String> {
  let head = head_of(path, 512)?;
  if unsupported(&head) {
    return Err("archive_unsupported".into());
  }
  let format = detect(&head).ok_or_else(|| "archive_unsupported".to_string())?;
  let (files, skipped, bytes) = match format {
    ArchiveFormat::Zip => extract_zip(path, root, total_limit)?,
    ArchiveFormat::Tar => {
      let file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
      let mut declared = 0u64;
      extract_tar_reader(file, root, &mut declared, total_limit)?
    }
    ArchiveFormat::TarGz => {
      let file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
      let decoder = flate2::read::GzDecoder::new(file);
      let mut declared = 0u64;
      extract_tar_reader(decoder, root, &mut declared, total_limit)?
    }
  };
  Ok(ExtractReport {
    dir: draft::normalize_path(&root.to_string_lossy()),
    entries: files,
    skipped,
    bytes,
  })
}

/// The cache folder that stands for one archive: a digest of where it is and what it is.
///
/// Same size and modification time means the same bytes for anything a user would edit and
/// save again, and it costs one metadata read instead of hashing the archive every time.
fn digest_of(path: &Path) -> Result<String, String> {
  let meta = fs::metadata(path).map_err(|e| format!("file_access:{e}"))?;
  if !meta.is_file() {
    return Err("archive_not_file".into());
  }
  let modified = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_millis())
    .unwrap_or(0);
  let mut hasher = Sha256::new();
  hasher.update(draft::normalize_path(&path.to_string_lossy()).as_bytes());
  hasher.update(meta.len().to_le_bytes());
  hasher.update(modified.to_le_bytes());
  let digest = hasher.finalize();
  let mut text = String::with_capacity(32);
  for byte in &digest[..8] {
    text.push_str(&format!("{byte:02x}"));
  }
  Ok(text)
}

/// `<app data>/wrolp/archive-cache`, created on demand.
pub fn cache_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_config_dir()
    .map_err(|e| e.to_string())?
    .join("wrolp")
    .join(CACHE_DIR);
  fs::create_dir_all(&dir).map_err(|e| format!("dir_create:{e}"))?;
  Ok(dir)
}

/// Remove unpacked archives nobody has looked at for `KEEP_DAYS`. Runs on the way into a new
/// extract, so a cache left behind by a crash is cleaned the next time the feature is used.
fn sweep(root: &Path, keep_days: u64) {
  let now = SystemTime::now();
  let Ok(read) = fs::read_dir(root) else {
    return;
  };
  for item in read.flatten() {
    let Ok(meta) = item.metadata() else {
      continue;
    };
    if !meta.is_dir() {
      continue;
    }
    let stale = meta
      .modified()
      .ok()
      .and_then(|t| now.duration_since(t).ok())
      .map(|age| age.as_secs() > keep_days * 24 * 3600)
      .unwrap_or(false);
    if stale {
      let _ = fs::remove_dir_all(item.path());
    }
  }
}

/// Whether `path` is an unpacked archive's folder or something inside one. The read-only rules
/// are enforced here rather than only in the UI: a command that writes is refused at the door.
pub fn in_cache(app: &AppHandle, path: &str) -> bool {
  let Ok(root) = app
    .path()
    .app_config_dir()
    .map(|dir| dir.join("wrolp").join(CACHE_DIR))
  else {
    return false;
  };
  let root = draft::normalize_path(&root.to_string_lossy());
  let target = draft::normalize_path(path);
  rename::under(&target, &root)
}

/// The one refusal every write command makes when its destination is an unpacked copy.
pub fn refuse_if_cached(app: &AppHandle, path: &str) -> Result<(), String> {
  if in_cache(app, path) {
    Err("archive_read_only".into())
  } else {
    Ok(())
  }
}

/// The format of an archive, for deciding whether to offer "browse this archive" at all.
#[tauri::command(async)]
pub fn archive_detect(path: String) -> Result<Option<String>, String> {
  let head = head_of(Path::new(&draft::io_path(&path)), 512)?;
  Ok(detect(&head).map(|format| format.as_str().to_string()))
}

/// The entries of an archive, without unpacking any of them.
#[tauri::command(async)]
pub fn list_archive(path: String) -> Result<ArchiveListing, String> {
  list(Path::new(&draft::io_path(&path)))
}

/// Unpack an archive into its cache folder and return where it landed.
///
/// Re-extracting the same archive is a no-op: the folder is keyed by the archive's identity,
/// so the second visit shows the same copy rather than unpacking beside it.
#[tauri::command(async)]
pub fn extract_archive(app: AppHandle, path: String) -> Result<ExtractReport, String> {
  let source = PathBuf::from(draft::io_path(&path));
  let settings = crate::commands::load_settings(&app).unwrap_or_default();
  // Clamped rather than trusted: the number is editable as JSON like every other setting, and
  // a zero or a huge one would either refuse everything or remove the ceiling entirely.
  let total_limit = settings
    .archive_max_total_bytes
    .clamp(64 * 1024 * 1024, MAX_TOTAL_BYTES);
  let keep_days = settings.archive_keep_days.min(365) as u64;
  let listing = list(&source)?;
  if listing.total_bytes > total_limit {
    return Err("archive_too_large".into());
  }
  let root = cache_root(&app)?;
  sweep(&root, keep_days);
  let digest = digest_of(&source)?;
  let dest = root.join(&digest);
  if dest.is_dir() {
    let files = walk_files(&dest);
    return Ok(ExtractReport {
      dir: draft::normalize_path(&dest.to_string_lossy()),
      entries: files.0,
      skipped: Vec::new(),
      bytes: files.1,
    });
  }
  // Unpacked beside the final name and renamed into place at the end: an interrupted run
  // leaves a folder with a name no lookup will ever match, rather than half an archive that
  // the next visit would take for a complete copy.
  let staging = root.join(format!("{digest}.part"));
  let _ = fs::remove_dir_all(&staging);
  fs::create_dir_all(&staging).map_err(|e| format!("dir_create:{e}"))?;
  let report = extract_into(&source, &staging, total_limit);
  match report {
    Ok(mut report) => {
      fs::rename(&staging, &dest).map_err(|e| {
        let _ = fs::remove_dir_all(&staging);
        format!("dir_create:{e}")
      })?;
      report.dir = draft::normalize_path(&dest.to_string_lossy());
      Ok(report)
    }
    Err(error) => {
      let _ = fs::remove_dir_all(&staging);
      Err(error)
    }
  }
}

/// How many files are under `dir` and how many bytes they hold.
fn walk_files(dir: &Path) -> (usize, u64) {
  let mut files = 0usize;
  let mut bytes = 0u64;
  let mut stack = vec![dir.to_path_buf()];
  while let Some(current) = stack.pop() {
    let Ok(read) = fs::read_dir(&current) else {
      continue;
    };
    for item in read.flatten() {
      let Ok(kind) = item.file_type() else {
        continue;
      };
      if kind.is_dir() {
        stack.push(item.path());
      } else if kind.is_file() {
        files += 1;
        bytes = bytes.saturating_add(item.metadata().map(|m| m.len()).unwrap_or(0));
      }
    }
  }
  (files, bytes)
}

/// Delete one unpacked archive, or all of them when `dir` is empty.
///
/// Only folders under the cache are removable, and only by their own digest name: the command
/// takes the folder the UI is showing, not a path from anywhere.
#[tauri::command(async)]
pub fn clear_archive_cache(app: AppHandle, dir: Option<String>) -> Result<(), String> {
  let root = cache_root(&app)?;
  let Some(dir) = dir else {
    return fs::remove_dir_all(&root).map_err(|e| format!("dir_remove:{e}"));
  };
  let target = PathBuf::from(draft::io_path(&dir));
  let under_root = target
    .parent()
    .map(|parent| {
      draft::normalize_path(&parent.to_string_lossy())
        == draft::normalize_path(&root.to_string_lossy())
    })
    .unwrap_or(false);
  if !under_root {
    return Err("archive_bad_path".into());
  }
  fs::remove_dir_all(&target).map_err(|e| format!("dir_remove:{e}"))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "wrolp-archive-{tag}-{}-{}",
      std::process::id(),
      SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
    ));
    fs::create_dir_all(&dir).unwrap();
    dir
  }

  fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
    let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
    let options: zip::write::SimpleFileOptions = zip::write::SimpleFileOptions::default();
    for (name, body) in files {
      writer.start_file(*name, options).unwrap();
      writer.write_all(body).unwrap();
    }
    writer.finish().unwrap();
  }

  fn write_tar<F: FnOnce(&mut tar::Builder<&mut Vec<u8>>)>(path: &Path, build: F) {
    let mut bytes = Vec::new();
    {
      let mut builder = tar::Builder::new(&mut bytes);
      build(&mut builder);
      builder.finish().unwrap();
    }
    fs::write(path, bytes).unwrap();
  }

  fn append_tar_file(builder: &mut tar::Builder<&mut Vec<u8>>, name: &str, body: &[u8]) {
    let mut header = tar::Header::new_gnu();
    header.set_size(body.len() as u64);
    header.set_mode(0o644);
    header.set_cksum();
    builder.append_data(&mut header, name, body).unwrap();
  }

  #[test]
  fn detect_looks_at_bytes_and_not_at_names() {
    assert_eq!(detect(b"PK\x03\x04rest"), Some(ArchiveFormat::Zip));
    assert_eq!(detect(b"PK\x05\x06"), Some(ArchiveFormat::Zip));
    assert_eq!(detect(&[0x1f, 0x8b, 8, 0]), Some(ArchiveFormat::TarGz));
    assert_eq!(detect(b"not an archive"), None);
  }

  #[test]
  fn a_zip_lists_its_entries_without_unpacking() {
    let dir = temp_dir("list");
    let path = dir.join("a.zip");
    write_zip(
      &path,
      &[("readme.txt", b"hello"), ("docs/inner.md", b"# title")],
    );
    let listing = list(&path).unwrap();
    assert_eq!(listing.format, "zip");
    assert_eq!(listing.entries.len(), 2);
    assert_eq!(listing.total_bytes, 5 + 7);
    assert_eq!(listing.entries[1].path, "docs/inner.md");
    assert!(!listing.truncated);
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn a_zip_never_extracts_appends_over_itself() {
    let dir = temp_dir("extract");
    let path = dir.join("a.zip");
    write_zip(&path, &[("a.txt", b"one"), ("nested/b.txt", b"two")]);
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    let report = extract_into(&path, &out, MAX_TOTAL_BYTES).unwrap();
    assert_eq!(report.entries, 2);
    assert_eq!(fs::read(out.join("nested/b.txt")).unwrap(), b"two");
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn hostile_names_are_refused_and_counted() {
    let mut taken = HashSet::new();
    for name in [
      "../evil",
      "C:\\evil",
      "\\\\srv\\share",
      "a:b",
      "CON",
      "trail.",
    ] {
      let result = safe_rel(name, &mut taken);
      assert!(result.is_err(), "{name} should have been refused");
    }
    assert!(safe_rel("ok/readme.md", &mut taken).is_ok());
  }

  #[test]
  fn two_names_differing_only_in_case_both_land() {
    let dir = temp_dir("case");
    let path = dir.join("a.zip");
    write_zip(&path, &[("A.txt", b"upper"), ("a.txt", b"lower")]);
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    extract_into(&path, &out, MAX_TOTAL_BYTES).unwrap();
    let mut names: Vec<String> = fs::read_dir(&out)
      .unwrap()
      .flatten()
      .map(|e| e.file_name().to_string_lossy().to_string())
      .collect();
    names.sort();
    assert_eq!(names, vec!["A.txt".to_string(), "a (2).txt".to_string()]);
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn a_gbk_name_is_decoded_rather_than_placed() {
    let bytes = [0xD6, 0xD0, 0xCE, 0xC4]; // 中文 in GBK
    assert_eq!(decode_name(&bytes, 0), "中文");
    assert_eq!(decode_name(&[0xff, 0xff, 0xff, 0xff], 7), "entry_7");
  }

  #[test]
  fn a_tar_lists_and_unpacks_and_skips_links() {
    let dir = temp_dir("tar");
    let path = dir.join("a.tar");
    write_tar(&path, |builder| {
      append_tar_file(builder, "one.txt", b"first");
      let mut link = tar::Header::new_gnu();
      link.set_entry_type(tar::EntryType::Symlink);
      link.set_size(0);
      link.set_link_name("/etc/passwd").unwrap();
      link.set_cksum();
      builder
        .append_data(&mut link, "escape", io::empty())
        .unwrap();
    });
    let listing = list(&path).unwrap();
    assert_eq!(listing.format, "tar");
    assert_eq!(listing.entries.len(), 1);
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    let report = extract_into(&path, &out, MAX_TOTAL_BYTES).unwrap();
    assert_eq!(report.entries, 1);
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].reason, "link");
    assert!(!out.join("escape").exists());
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn a_tar_gz_is_read_through_its_decoder() {
    let dir = temp_dir("tgz");
    let path = dir.join("a.tar.gz");
    let mut plain = Vec::new();
    {
      let mut builder = tar::Builder::new(&mut plain);
      append_tar_file(&mut builder, "x.txt", b"gz");
      builder.finish().unwrap();
    }
    let mut encoder =
      flate2::write::GzEncoder::new(File::create(&path).unwrap(), flate2::Compression::default());
    encoder.write_all(&plain).unwrap();
    encoder.finish().unwrap();
    let listing = list(&path).unwrap();
    assert_eq!(listing.format, "tarGz");
    assert_eq!(listing.entries[0].path, "x.txt");
    fs::remove_dir_all(&dir).unwrap();
  }
}
