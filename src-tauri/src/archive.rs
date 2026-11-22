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
use crate::gallery;
use crate::rename;
use encoding_rs::GBK;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File};
use std::io::{self, BufReader, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager, State};

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
/// Thumbnails made from archive pictures, a sibling of the unpacked copies.
const THUMB_DIR: &str = "archive-thumbs";
/// Edge of a thumbnail in pixels: large enough for a grid cell at 2× scaling, small enough
/// that a thousand of them is a few tens of megabytes on disk.
pub const THUMB_EDGE: u32 = 256;
/// Zip companions kept open. Scrolling a gallery would otherwise re-read the central directory
/// for every picture; four is enough for the archives a person actually moves between.
const OPEN_ARCHIVES: usize = 4;

/// What identifies the file a cached handle was opened from. A rewrite changes the size or the
/// modification time, so the old handle is dropped rather than answering with old contents.
type ArchiveKey = (String, u64, u128);

struct OpenZip {
  key: ArchiveKey,
  zip: zip::ZipArchive<BufReader<File>>,
  used: u64,
}

static OPEN_ZIPS: Mutex<Vec<OpenZip>> = Mutex::new(Vec::new());
static OPEN_ZIP_CLOCK: AtomicU64 = AtomicU64::new(0);

/// Thumbnails made from an encrypted archive stay here rather than in `archive-thumbs`: a
/// password-protected archive must not leave decrypted pictures on disk. Bounded and small —
/// these are sixty-kilobyte WebPs, not the pictures themselves.
const THUMB_MEMORY: usize = 128;
static THUMB_CACHE: Mutex<Vec<(String, Vec<u8>)>> = Mutex::new(Vec::new());

fn memory_thumb(key: &str) -> Option<Vec<u8>> {
  let mut cache = THUMB_CACHE.lock().unwrap_or_else(|e| e.into_inner());
  let index = cache.iter().position(|(stored, _)| stored == key)?;
  let hit = cache.remove(index);
  let bytes = hit.1.clone();
  cache.push(hit);
  Some(bytes)
}

fn remember_thumb(key: String, bytes: &[u8]) {
  let mut cache = THUMB_CACHE.lock().unwrap_or_else(|e| e.into_inner());
  cache.retain(|(stored, _)| stored != &key);
  cache.push((key, bytes.to_vec()));
  while cache.len() > THUMB_MEMORY {
    cache.remove(0);
  }
}

fn archive_lock() -> MutexGuard<'static, Vec<OpenZip>> {
  // A panic inside one picture read must not take the cache with it: the handles themselves
  // carry no invariant that a panic could leave half-updated.
  OPEN_ZIPS.lock().unwrap_or_else(|e| e.into_inner())
}

fn archive_key(path: &Path) -> Result<ArchiveKey, String> {
  let meta = fs::metadata(path).map_err(|e| format!("file_access:{e}"))?;
  let mtime = meta
    .modified()
    .ok()
    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
    .map(|d| d.as_nanos())
    .unwrap_or(0);
  Ok((
    draft::normalize_path(&path.to_string_lossy()),
    meta.len(),
    mtime,
  ))
}

/// A read-only handle that may be deleted or renamed while it is open. Without the delete share
/// bit, a cached handle would make the archive impossible to remove in Explorer for as long as
/// its gallery remained open.
fn open_archive_file(path: &Path) -> io::Result<File> {
  let mut options = fs::OpenOptions::new();
  options.read(true);
  #[cfg(windows)]
  {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    options.share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  }
  options.open(path)
}

/// Run `f` against a zip that stays open between calls.
///
/// The key is the normalized path plus the file's size and modification time, so a rewritten
/// archive is never read through a stale handle. The least recently used handle is dropped when
/// a fifth archive arrives.
fn with_zip<R>(
  path: &Path,
  f: impl FnOnce(&mut zip::ZipArchive<BufReader<File>>) -> Result<R, String>,
) -> Result<R, String> {
  let key = archive_key(path)?;
  let now = OPEN_ZIP_CLOCK.fetch_add(1, Ordering::Relaxed);
  let mut cache = archive_lock();
  if let Some(index) = cache.iter().position(|cached| cached.key == key) {
    let mut cached = cache.remove(index);
    cached.used = now;
    let out = f(&mut cached.zip);
    cache.push(cached);
    return out;
  }
  drop(cache);
  let file = open_archive_file(path).map_err(|e| format!("file_access:{e}"))?;
  let mut zip =
    zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "archive_broken".to_string())?;
  let out = f(&mut zip);
  let mut cache = archive_lock();
  cache.push(OpenZip {
    key,
    zip,
    used: now,
  });
  while cache.len() > OPEN_ARCHIVES {
    let oldest = cache
      .iter()
      .enumerate()
      .min_by_key(|(_, cached)| cached.used)
      .map(|(index, _)| index)
      .unwrap_or(0);
    cache.remove(oldest);
  }
  out
}

/// The formats read in this version. Kept nameable so the UI can say which one.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ArchiveFormat {
  Zip,
  Tar,
  TarGz,
  SevenZ,
}

impl ArchiveFormat {
  pub fn as_str(self) -> &'static str {
    match self {
      ArchiveFormat::Zip => "zip",
      ArchiveFormat::Tar => "tar",
      ArchiveFormat::TarGz => "tarGz",
      ArchiveFormat::SevenZ => "7z",
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
  if head.starts_with(b"7z\xbc\xaf\x27\x1c") {
    return Some(ArchiveFormat::SevenZ);
  }
  if head.len() >= 262 && &head[257..262] == b"ustar" {
    return Some(ArchiveFormat::Tar);
  }
  if head.starts_with(&[0x1f, 0x8b]) {
    return Some(ArchiveFormat::TarGz);
  }
  None
}

/// Formats this build can recognise but not open: rar, whose decoder is under a licence that
/// does not fit this application. Named apart from `detect` so the refusal can say
/// "unsupported" rather than "not an archive".
fn unsupported(head: &[u8]) -> bool {
  head.starts_with(b"Rar!\x1a\x07")
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

fn zip_listing(path: &Path, password: Option<&str>) -> Result<ArchiveListing, String> {
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
    match password {
      // Not `archive_encrypted`: a zip *can* be opened here once a password is offered, and
      // the front end tells the two apart to decide whether to ask.
      None => return Err("archive_password_required".into()),
      Some(password) if !password_works(path, password)? => {
        return Err("archive_bad_password".into());
      }
      Some(_) => {}
    }
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

/// Whether any folder in a 7z archive names the AES coder. A plain 7z header can list names
/// while the contents still ask for a password, so this is checked apart from a header error.
fn sevenz_encrypted(archive: &sevenz_rust::Archive) -> bool {
  archive
    .folders
    .iter()
    .flat_map(|folder| folder.coders.iter())
    .any(|coder| coder.decompression_method_id() == sevenz_rust::SevenZMethod::ID_AES256SHA256)
}

/// Map the crate's error onto the codes the rest of this module speaks.
fn sevenz_error(error: sevenz_rust::Error) -> String {
  use sevenz_rust::Error as E;
  match error {
    // No password was offered, so this is the same "needs a password" answer zip gives.
    E::PasswordRequired => "archive_encrypted".into(),
    E::UnsupportedCompressionMethod(method) if method == "AES256SHA256" => {
      "archive_encrypted".into()
    }
    E::Io(e, _) | E::FileOpen(e, _) => format!("file_access:{e}"),
    E::BadSignature(_)
    | E::UnsupportedVersion { .. }
    | E::Unsupported(_)
    | E::UnsupportedCompressionMethod(_) => "archive_unsupported".into(),
    _ => "archive_broken".into(),
  }
}

fn sevenz_listing(path: &Path) -> Result<ArchiveListing, String> {
  let archive = sevenz_rust::Archive::open(path).map_err(sevenz_error)?;
  if sevenz_encrypted(&archive) {
    return Err("archive_encrypted".into());
  }
  let mut entries = Vec::new();
  let mut total = 0u64;
  for file in &archive.files {
    if entries.len() >= MAX_ENTRIES {
      break;
    }
    let is_dir = file.is_directory();
    entries.push(ArchiveEntry {
      path: file.name().replace('\\', "/"),
      is_dir,
      bytes: if is_dir { 0 } else { file.size() },
      packed: file.compressed_size,
      encrypted: false,
    });
    if !is_dir {
      total = total.saturating_add(file.size());
    }
  }
  if entries.is_empty() {
    return Err("archive_empty".into());
  }
  Ok(ArchiveListing {
    format: ArchiveFormat::SevenZ.as_str().into(),
    truncated: archive.files.len() > entries.len(),
    entries,
    total_bytes: total,
    encrypted: false,
  })
}

/// List one archive without a password, for tests and for callers that have already decided
/// the archive is not encrypted.
#[cfg(test)]
pub fn list(path: &Path) -> Result<ArchiveListing, String> {
  list_with(path, None)
}

/// List one archive, dispatching on what its bytes say rather than on its name.
pub fn list_with(path: &Path, password: Option<&str>) -> Result<ArchiveListing, String> {
  let head = head_of(path, 512)?;
  if unsupported(&head) {
    return Err("archive_unsupported".into());
  }
  match detect(&head).ok_or_else(|| "archive_unsupported".to_string())? {
    ArchiveFormat::Zip => zip_listing(path, password),
    ArchiveFormat::Tar => tar_listing(path, false),
    ArchiveFormat::TarGz => tar_listing(path, true),
    ArchiveFormat::SevenZ => sevenz_listing(path),
  }
}

/// Whether this archive's bytes cannot be read without a password.
///
/// Only a zip has a password path in this build; a 7z with an encrypted header or contents
/// says so and there is nothing more to try, which is why it is not reported here.
pub fn needs_password(path: &Path) -> bool {
  let Ok(head) = head_of(path, 512) else {
    return false;
  };
  if detect(&head) != Some(ArchiveFormat::Zip) {
    return false;
  }
  // The password protocol asks this for every picture it serves, so it reads the central
  // directory through the same open handle the picture itself uses.
  with_zip(path, |zip| {
    Ok((0..zip.len()).any(|index| {
      zip
        .by_index_raw(index)
        .map(|entry| entry.encrypted())
        .unwrap_or(false)
    }))
  })
  .unwrap_or(false)
}

/// The byte strings a typed password may have been written as.
///
/// WinZip AES (method 99) carries the password as UTF-8; ZipCrypto, which Chinese archivers
/// have written for decades, carries whatever the local code page produced — GBK on a Chinese
/// Windows. Pure ASCII is the same bytes either way, so only a password with non-ASCII
/// characters gets a second candidate, and the UTF-8 one is tried first because that is what
/// the specification says.
fn password_candidates(password: &str) -> Vec<Vec<u8>> {
  let mut candidates = vec![password.as_bytes().to_vec()];
  if !password.is_ascii() {
    let (gbk, _, had_errors) = GBK.encode(password);
    if !had_errors
      && !candidates
        .iter()
        .any(|bytes| bytes.as_slice() == gbk.as_ref())
    {
      candidates.push(gbk.into_owned());
    }
  }
  candidates
}

/// Whether one candidate password opens the entry at `index`.
fn zip_entry_opens<R: Read + io::Seek>(
  zip: &mut zip::ZipArchive<R>,
  index: usize,
  password: &[u8],
) -> Result<bool, String> {
  let mut entry = match zip.by_index_decrypt(index, password) {
    Ok(entry) => entry,
    Err(zip::result::ZipError::InvalidPassword) => return Ok(false),
    Err(_) => return Err("archive_broken".into()),
  };
  let mut buffer = vec![0u8; 64 * 1024];
  loop {
    match entry.read(&mut buffer) {
      Ok(0) => return Ok(true),
      Ok(_) => {}
      Err(e)
        if matches!(
          e.kind(),
          io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData
        ) =>
      {
        return Ok(false);
      }
      Err(_) => return Err("archive_broken".into()),
    }
  }
}

/// Which bytes the typed password was stored as, or `None` when none of them open this zip.
///
/// The smallest encrypted entry is the one tried: verification has to read an entry to the
/// end (AES authenticates at EOF, ZipCrypto's CRC does too), and picking the small one keeps
/// a wrong candidate from costing a full large file each time. The candidate that works is
/// returned so the caller can decrypt the rest with it instead of guessing again.
fn zip_key(path: &Path, password: &str) -> Result<Option<Vec<u8>>, String> {
  let file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
  let mut zip =
    zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "archive_broken".to_string())?;
  let mut smallest: Option<(usize, u64)> = None;
  for index in 0..zip.len() {
    let meta = zip
      .by_index_raw(index)
      .map_err(|_| "archive_broken".to_string())?;
    if !meta.encrypted() {
      continue;
    }
    if smallest.is_none_or(|(_, size)| meta.size() < size) {
      smallest = Some((index, meta.size()));
    }
  }
  // Nothing is encrypted, so any bytes would do; the caller's password is never asked for.
  let Some((index, _)) = smallest else {
    return Ok(Some(password.as_bytes().to_vec()));
  };
  let mut error: Option<String> = None;
  for candidate in password_candidates(password) {
    match zip_entry_opens(&mut zip, index, &candidate) {
      Ok(true) => return Ok(Some(candidate)),
      Ok(false) => {}
      Err(e) => error = Some(e),
    }
  }
  match error {
    Some(e) => Err(e),
    None => Ok(None),
  }
}

fn zip_password_works(path: &Path, password: &str) -> Result<bool, String> {
  Ok(zip_key(path, password)?.is_some())
}

/// Whether one password opens this archive, whatever its format.
pub(crate) fn password_works(path: &Path, password: &str) -> Result<bool, String> {
  let head = head_of(path, 512)?;
  match detect(&head) {
    Some(ArchiveFormat::Zip) => zip_password_works(path, password),
    // A format with no password path: there is nothing to verify, and the caller only asks
    // after `needs_password` said yes, which for these formats is never.
    Some(_) => Ok(true),
    None => Err("archive_unsupported".into()),
  }
}

/// One picture inside an archive, addressed by its entry name.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveImageEntry {
  /// Relative path inside the archive; what the picture URL is built from.
  pub entry: String,
  /// Last segment, for a card's title.
  pub name: String,
  pub bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveImageList {
  pub items: Vec<ArchiveImageEntry>,
  pub truncated: bool,
  /// File entries examined to build the list, as the folder gallery counts them.
  pub scanned: usize,
}

/// Ceiling for one picture read out of an archive. Above this the card becomes a placeholder
/// rather than the window trying to decode a hundred-megapixel scan.
const MAX_IMAGE_BYTES: u64 = 64 * 1024 * 1024;

/// `inner` as an archive-relative folder: forward slashes, no leading or trailing one.
fn clean_inner(inner: &str) -> String {
  inner.replace('\\', "/").trim_matches('/').to_string()
}

/// The pictures under `inner` in one zip.
///
/// Ordering is (folder, natural): a flat name order would shuffle pictures from different
/// folders together, which reads as a random list once an archive has a tree.
fn zip_images(path: &Path, inner: &str, recursive: bool) -> Result<ArchiveImageList, String> {
  with_zip(path, |zip| {
    let root = clean_inner(inner);
    let prefix = if root.is_empty() {
      String::new()
    } else {
      format!("{root}/")
    };
    // (folder for ordering, file name, entry name, bytes): the entry keeps the whole path so a
    // picture in a subfolder can still be asked for by the name the listing handed out.
    let mut found: Vec<(String, String, String, u64)> = Vec::new();
    let mut scanned = 0usize;
    for index in 0..zip.len() {
      let meta = zip
        .by_index_raw(index)
        .map_err(|_| "archive_broken".to_string())?;
      if meta.is_dir() {
        continue;
      }
      scanned += 1;
      let name = decode_name(meta.name_raw(), index).replace('\\', "/");
      if !gallery::has_image_ext(&name) {
        continue;
      }
      let Some(rel) = name.strip_prefix(&prefix) else {
        continue;
      };
      if rel.is_empty() {
        continue;
      }
      let (dir, base) = match rel.rsplit_once('/') {
        Some((dir, base)) => (dir, base),
        None => ("", rel),
      };
      let folders: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
      if !recursive && !folders.is_empty() {
        continue;
      }
      if folders.len() > gallery::MAX_GALLERY_DEPTH {
        continue;
      }
      if folders.iter().any(|part| gallery::is_ignored(part)) {
        continue;
      }
      found.push((dir.to_string(), base.to_string(), name.clone(), meta.size()));
    }
    found.sort_by(|a, b| {
      crate::name_order::natural_cmp(&a.0, &b.0)
        .then_with(|| crate::name_order::natural_cmp(&a.1, &b.1))
        .then_with(|| a.2.cmp(&b.2))
    });
    let truncated = found.len() > gallery::MAX_GALLERY_IMAGES;
    found.truncate(gallery::MAX_GALLERY_IMAGES);
    if found.is_empty() {
      if scanned == 0 {
        return Err("archive_empty".into());
      }
      return Err("archive_no_images".into());
    }
    Ok(ArchiveImageList {
      items: found
        .into_iter()
        .map(|(_, name, entry, bytes)| ArchiveImageEntry { entry, name, bytes })
        .collect(),
      truncated,
      scanned,
    })
  })
}

/// The pictures under `inner` in one 7z.
///
/// A 7z header names every entry up front, so a listing needs no decoding at all — the same
/// reason a zip listing is cheap. The random access question only comes up when a picture is
/// actually read; see `read_sevenz_image`.
fn sevenz_images(path: &Path, inner: &str, recursive: bool) -> Result<ArchiveImageList, String> {
  let archive = sevenz_rust::Archive::open(path).map_err(sevenz_error)?;
  if sevenz_encrypted(&archive) {
    return Err("archive_encrypted".into());
  }
  let root = clean_inner(inner);
  let prefix = if root.is_empty() {
    String::new()
  } else {
    format!("{root}/")
  };
  let mut found: Vec<(String, String, String, u64)> = Vec::new();
  let mut scanned = 0usize;
  for entry in &archive.files {
    if entry.is_directory() {
      continue;
    }
    scanned += 1;
    let name = entry.name().replace('\\', "/");
    if !gallery::has_image_ext(&name) {
      continue;
    }
    let Some(rel) = name.strip_prefix(&prefix) else {
      continue;
    };
    if rel.is_empty() {
      continue;
    }
    let (dir, base) = match rel.rsplit_once('/') {
      Some((dir, base)) => (dir, base),
      None => ("", rel),
    };
    let folders: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    if !recursive && !folders.is_empty() {
      continue;
    }
    if folders.len() > gallery::MAX_GALLERY_DEPTH {
      continue;
    }
    if folders.iter().any(|part| gallery::is_ignored(part)) {
      continue;
    }
    found.push((dir.to_string(), base.to_string(), name, entry.size()));
  }
  found.sort_by(|a, b| {
    crate::name_order::natural_cmp(&a.0, &b.0)
      .then_with(|| crate::name_order::natural_cmp(&a.1, &b.1))
      .then_with(|| a.2.cmp(&b.2))
  });
  let truncated = found.len() > gallery::MAX_GALLERY_IMAGES;
  found.truncate(gallery::MAX_GALLERY_IMAGES);
  if found.is_empty() {
    if scanned == 0 {
      return Err("archive_empty".into());
    }
    return Err("archive_no_images".into());
  }
  Ok(ArchiveImageList {
    items: found
      .into_iter()
      .map(|(_, name, entry, bytes)| ArchiveImageEntry { entry, name, bytes })
      .collect(),
    truncated,
    scanned,
  })
}

/// Only a zip and a 7z answer "which pictures are inside" without unpacking the whole thing; a
/// tar.gz has to be read from its start, so it is refused rather than scanned on every open.
fn list_images_in(path: &Path, inner: &str, recursive: bool) -> Result<ArchiveImageList, String> {
  let head = head_of(path, 512)?;
  match detect(&head) {
    Some(ArchiveFormat::Zip) => zip_images(path, inner, recursive),
    Some(ArchiveFormat::SevenZ) => sevenz_images(path, inner, recursive),
    Some(_) => Err("archive_stream_only".into()),
    None => Err("archive_unsupported".into()),
  }
}

/// The bytes of one picture, found by the name the listing handed out.
///
/// Same format rule as the listing: only a zip answers without walking a stream.
///
/// The name is matched against the archive's own entries and never used as a path, so this
/// cannot become "read any file out of any zip". Only entries the gallery would list are
/// accepted, and the size ceilings are the image ones rather than the whole-archive ones.
fn read_zip_image(path: &Path, entry: &str, password: Option<&str>) -> Result<Vec<u8>, String> {
  // The same conversion the extractor uses: a Chinese password on a ZipCrypto archive is GBK
  // bytes, on an AES one UTF-8. Verified against a small entry before the picture is read.
  let key = match password {
    Some(password) => match zip_key(path, password)? {
      Some(key) => Some(key),
      None => return Err("archive_bad_password".into()),
    },
    None => None,
  };
  with_zip(path, |zip| {
    let mut found: Option<(usize, u64, u64)> = None;
    for index in 0..zip.len() {
      let meta = zip
        .by_index_raw(index)
        .map_err(|_| "archive_broken".to_string())?;
      if meta.is_dir() {
        continue;
      }
      let name = decode_name(meta.name_raw(), index).replace('\\', "/");
      if !gallery::has_image_ext(&name) {
        continue;
      }
      if name == entry || name.eq_ignore_ascii_case(entry) {
        if meta.encrypted() && key.is_none() {
          return Err("archive_password_required".into());
        }
        found = Some((index, meta.size(), meta.compressed_size()));
        break;
      }
    }
    let Some((index, size, packed)) = found else {
      return Err("archive_bad_path".into());
    };
    if size > MAX_IMAGE_BYTES || (packed > 0 && is_bomb(size, packed)) {
      return Err("archive_too_large".into());
    }
    let mut item = match &key {
      Some(key) => zip.by_index_decrypt(index, key).map_err(|e| match e {
        zip::result::ZipError::InvalidPassword => "archive_bad_password".to_string(),
        _ => "archive_broken".to_string(),
      })?,
      None => zip
        .by_index(index)
        .map_err(|_| "archive_broken".to_string())?,
    };
    let mut out = Vec::with_capacity((size as usize).min(MAX_IMAGE_BYTES as usize));
    copy_entry_bytes(&mut item, &mut out, size, key.is_some())?;
    Ok(out)
  })
}

/// Copy an entry's bytes into `out`, holding both the declared size and the image ceiling.
///
/// `password_checked` says whether a failing read is more likely a wrong key than damage: a zip
/// entry that was opened with a key reports its failure through these two error kinds, while a
/// 7z entry that got this far is decoded through a verified block.
fn copy_entry_bytes(
  reader: &mut dyn Read,
  out: &mut Vec<u8>,
  declared: u64,
  password_checked: bool,
) -> Result<(), String> {
  let mut buffer = vec![0u8; 64 * 1024];
  loop {
    let n = reader.read(&mut buffer).map_err(|e| match e.kind() {
      io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData if password_checked => {
        "archive_bad_password".to_string()
      }
      _ => "archive_broken".to_string(),
    })?;
    if n == 0 {
      return Ok(());
    }
    if out.len() as u64 + n as u64 > declared.min(MAX_IMAGE_BYTES) {
      return Err("archive_too_large".into());
    }
    out.extend_from_slice(&buffer[..n]);
  }
}

/// One picture out of a 7z.
///
/// A 7z is decoded block by block, so "random access" here means decoding only the block that
/// holds the wanted entry instead of walking the whole archive. A non-solid archive puts each
/// file in its own block, which makes this one picture's worth of work; a solid one still has
/// to be walked up to the entry, and no reader can avoid that.
fn read_sevenz_image(path: &Path, entry: &str) -> Result<Vec<u8>, String> {
  let password = sevenz_rust::Password::empty().to_vec();
  let mut file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
  let len = file
    .metadata()
    .map_err(|e| format!("file_access:{e}"))?
    .len();
  let archive = sevenz_rust::Archive::read(&mut file, len, &password).map_err(sevenz_error)?;
  if sevenz_encrypted(&archive) {
    return Err("archive_encrypted".into());
  }
  let Some(index) = archive.files.iter().position(|item| {
    !item.is_directory()
      && gallery::has_image_ext(item.name())
      && item.name().replace('\\', "/").eq_ignore_ascii_case(entry)
  }) else {
    return Err("archive_bad_path".into());
  };
  let size = archive.files[index].size();
  if size > MAX_IMAGE_BYTES {
    return Err("archive_too_large".into());
  }
  let Some(folder) = archive.stream_map.file_folder_index[index] else {
    // No block means no bytes: an empty entry is not something to hand to a decoder.
    return Err("archive_bad_path".into());
  };
  let wanted = archive.files[index].name().to_string();
  let mut found: Option<Vec<u8>> = None;
  let mut failure: Option<String> = None;
  let mut each = |candidate: &sevenz_rust::SevenZArchiveEntry,
                  reader: &mut dyn Read|
   -> Result<bool, sevenz_rust::Error> {
    if !candidate.has_stream || candidate.name() != wanted {
      return Ok(true);
    }
    let mut out = Vec::with_capacity((size as usize).min(MAX_IMAGE_BYTES as usize));
    match copy_entry_bytes(reader, &mut out, size, false) {
      Ok(()) => found = Some(out),
      Err(e) => failure = Some(e),
    }
    Ok(false)
  };
  let decoder = sevenz_rust::BlockDecoder::new(folder, &archive, &password, &mut file);
  decoder.for_each_entries(&mut each).map_err(sevenz_error)?;
  if let Some(error) = failure {
    return Err(error);
  }
  found.ok_or_else(|| "archive_bad_path".into())
}

fn read_image_from(path: &Path, entry: &str, password: Option<&str>) -> Result<Vec<u8>, String> {
  let head = head_of(path, 512)?;
  match detect(&head) {
    Some(ArchiveFormat::Zip) => read_zip_image(path, entry, password),
    Some(ArchiveFormat::SevenZ) => read_sevenz_image(path, entry),
    Some(_) => Err("archive_stream_only".into()),
    None => Err("archive_unsupported".into()),
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
fn copy_entry(
  reader: &mut dyn Read,
  out: &mut File,
  declared: u64,
  budget: &mut u64,
  total_limit: u64,
) -> Result<u64, String> {
  let mut buffer = vec![0u8; 64 * 1024];
  let mut written = 0u64;
  loop {
    // A wrong password surfaces here rather than at open: ZipCrypto checks its header byte on
    // the first read, WinZip AES checks its authentication code at the end.
    let n = reader.read(&mut buffer).map_err(|e| match e.kind() {
      // ZipCrypto says `InvalidInput` when its check byte does not match; AES says
      // `InvalidData` when the authentication code at the end does not. A CRC that fails
      // after a password that slipped past ZipCrypto's one-byte check lands here too, which
      // is why the message for this code names both causes.
      io::ErrorKind::InvalidInput | io::ErrorKind::InvalidData => {
        "archive_bad_password".to_string()
      }
      _ => "archive_broken".to_string(),
    })?;
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
  password: Option<&str>,
) -> Result<(usize, Vec<SkipNote>, u64), String> {
  let file = File::open(path).map_err(|e| format!("file_access:{e}"))?;
  let mut zip =
    zip::ZipArchive::new(BufReader::new(file)).map_err(|_| "archive_broken".to_string())?;
  // Resolve the typed password to the bytes this archive was written with, once: AES carries
  // UTF-8, the ZipCrypto Chinese archivers produce carries GBK. Every entry then opens the
  // same way instead of each one guessing again.
  let key = match password {
    Some(password) => match zip_key(path, password)? {
      Some(key) => Some(key),
      None => return Err("archive_bad_password".into()),
    },
    None => None,
  };
  let declared_total: u64 = {
    let mut sum = 0u64;
    for index in 0..zip.len() {
      let meta = zip
        .by_index_raw(index)
        .map_err(|_| "archive_broken".to_string())?;
      if meta.encrypted() && key.is_none() {
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
    // The password, when one was resolved, is used only for entries that carry it; a plain
    // entry beside an encrypted one reads exactly as before.
    let mut entry = match &key {
      Some(key) => match zip.by_index_decrypt(index, key) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::InvalidPassword) => {
          return Err("archive_bad_password".into());
        }
        Err(_) => return Err("archive_broken".into()),
      },
      None => zip
        .by_index(index)
        .map_err(|_| "archive_broken".to_string())?,
    };
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

/// Read one entry to its end without keeping the bytes.
///
/// A 7z folder is often solid: the next file can only be decoded from where the previous one
/// stopped, so a skipped entry still has to be read through rather than stepped over.
fn drain_entry(reader: &mut dyn Read) -> Result<(), String> {
  io::copy(reader, &mut io::sink())
    .map(|_| ())
    .map_err(|_| "archive_broken".to_string())
}

fn extract_sevenz(
  path: &Path,
  root: &Path,
  total_limit: u64,
) -> Result<(usize, Vec<SkipNote>, u64), String> {
  let mut reader =
    sevenz_rust::SevenZReader::open(path, sevenz_rust::Password::empty()).map_err(sevenz_error)?;
  if sevenz_encrypted(reader.archive()) {
    return Err("archive_encrypted".into());
  }
  let declared: u64 = reader
    .archive()
    .files
    .iter()
    .filter(|file| !file.is_directory())
    .fold(0u64, |sum, file| sum.saturating_add(file.size()));
  if declared > total_limit {
    return Err("archive_too_large".into());
  }
  let mut taken = HashSet::new();
  let mut skipped = Vec::new();
  let mut files = 0usize;
  let mut budget = 0u64;
  // The callback cannot return this module's error codes, so the first failure is parked here
  // and the walk stops; the outer function returns it once the crate has unwound.
  let mut failure: Option<String> = None;
  let walked = reader.for_each_entries(|entry, input| {
    if failure.is_some() {
      return Ok(false);
    }
    let name = entry.name().replace('\\', "/");
    let rel = match safe_rel(entry.name(), &mut taken) {
      Ok(rel) => rel,
      Err(note) => {
        skipped.push(note);
        if let Err(e) = drain_entry(input) {
          failure = Some(e);
        }
        return Ok(failure.is_none());
      }
    };
    if entry.is_directory() {
      if let Err(e) = fs::create_dir_all(root.join(&rel)) {
        failure = Some(format!("dir_create:{e}"));
        return Ok(false);
      }
      return Ok(true);
    }
    let size = entry.size();
    let packed = entry.compressed_size;
    // `compressed_size` is filled in only on the first file of a solid block; a zero there
    // says nothing about the ratio, so only a known packed size is weighed.
    if size > MAX_ENTRY_BYTES || (packed > 0 && is_bomb(size, packed)) {
      skipped.push(SkipNote {
        path: name,
        reason: "tooLarge".into(),
      });
      if let Err(e) = drain_entry(input) {
        failure = Some(e);
      }
      return Ok(failure.is_none());
    }
    let dest = match create_parent(root, &rel) {
      Ok(dest) => dest,
      Err(e) => {
        failure = Some(e);
        return Ok(false);
      }
    };
    let mut out = match File::create(&dest) {
      Ok(out) => out,
      Err(e) => {
        failure = Some(format!("file_write:{e}"));
        return Ok(false);
      }
    };
    match copy_entry(input, &mut out, size, &mut budget, total_limit) {
      Ok(_) => files += 1,
      Err(e) => {
        failure = Some(e);
        return Ok(false);
      }
    }
    Ok(true)
  });
  if let Err(e) = walked {
    return Err(sevenz_error(e));
  }
  if let Some(e) = failure {
    return Err(e);
  }
  Ok((files, skipped, budget))
}

/// Unpack `path` into `root`, which the caller created empty.
fn extract_into(
  path: &Path,
  root: &Path,
  total_limit: u64,
  password: Option<&str>,
) -> Result<ExtractReport, String> {
  let head = head_of(path, 512)?;
  if unsupported(&head) {
    return Err("archive_unsupported".into());
  }
  let format = detect(&head).ok_or_else(|| "archive_unsupported".to_string())?;
  let (files, skipped, bytes) = match format {
    ArchiveFormat::Zip => extract_zip(path, root, total_limit, password)?,
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
    ArchiveFormat::SevenZ => extract_sevenz(path, root, total_limit)?,
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

/// `<app data>/wrolp/archive-thumbs`, created on demand. A sibling of the unpacked copies, so
/// the same "stale after N days" sweep can cover both.
fn thumb_dir(app: &AppHandle) -> Result<PathBuf, String> {
  Ok(
    app
      .path()
      .app_config_dir()
      .map_err(|e| e.to_string())?
      .join("wrolp")
      .join(THUMB_DIR),
  )
}

fn thumb_root(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = thumb_dir(app)?;
  fs::create_dir_all(&dir).map_err(|e| format!("dir_create:{e}"))?;
  Ok(dir)
}

fn short_hash(text: &str) -> String {
  let digest = Sha256::digest(text.as_bytes());
  let mut out = String::with_capacity(16);
  for byte in &digest[..8] {
    out.push_str(&format!("{byte:02x}"));
  }
  out
}

/// Where one entry's thumbnail lives. The folder is the archive's identity (path + size +
/// mtime), so a rewritten archive gets new files instead of serving the old picture.
fn thumb_file(app: &AppHandle, archive: &Path, entry: &str, edge: u32) -> Result<PathBuf, String> {
  Ok(
    thumb_root(app)?
      .join(digest_of(archive)?)
      .join(format!("{}-{edge}.webp", short_hash(entry))),
  )
}

/// Shrink one picture to fit `edge` pixels on its long side, encoded losslessly.
///
/// Lossless WebP keeps a screenshot's text readable, which is most of what an archive holds,
/// and at 256 pixels the file is tens of kilobytes either way.
fn make_thumbnail(raw: &[u8], edge: u32) -> Result<Vec<u8>, String> {
  let picture = image::load_from_memory(raw).map_err(|_| "archive_thumb_failed".to_string())?;
  // `thumbnail` scales up as well as down, and an icon blown up to 256 pixels is worse than
  // the icon itself, so the small case is left alone.
  let thumb = if picture.width() > edge || picture.height() > edge {
    picture.thumbnail(edge, edge)
  } else {
    picture
  };
  let mut out = Vec::new();
  let encoder = image::codecs::webp::WebPEncoder::new_lossless(&mut out);
  thumb
    .write_with_encoder(encoder)
    .map_err(|_| "archive_thumb_failed".to_string())?;
  Ok(out)
}

/// The thumbnail for one entry, from disk when it is already there.
///
/// An archive that needs a password never writes its pictures beside `drafts/`: those bytes
/// were protected on purpose, so their thumbnails live in memory only and are rebuilt after a
/// restart. An unencrypted archive's thumbnails are no more secret than the archive itself.
fn thumbnail_of(
  app: &AppHandle,
  archive: &Path,
  entry: &str,
  raw: &[u8],
  edge: u32,
) -> Result<Vec<u8>, String> {
  let path = thumb_file(app, archive, entry, edge)?;
  let key = path.to_string_lossy().into_owned();
  let secret = needs_password(archive);
  if secret {
    if let Some(hit) = memory_thumb(&key) {
      return Ok(hit);
    }
  } else if let Ok(cached) = fs::read(&path) {
    if !cached.is_empty() {
      return Ok(cached);
    }
  }
  let thumb = make_thumbnail(raw, edge)?;
  if secret {
    remember_thumb(key, &thumb);
    return Ok(thumb);
  }
  if let Some(dir) = path.parent() {
    // The first thumbnail of an archive is the moment to clear out folders nobody has looked
    // at for a while — once per archive, not once per picture.
    if !dir.exists() {
      if let Ok(root) = thumb_dir(app) {
        let keep_days = crate::commands::load_settings(app)
          .unwrap_or_default()
          .archive_keep_days
          .min(365) as u64;
        if keep_days > 0 {
          sweep(&root, keep_days);
        }
      }
    }
    fs::create_dir_all(dir).map_err(|e| format!("dir_create:{e}"))?;
    let part = path.with_extension("webp.part");
    fs::write(&part, &thumb).map_err(|e| format!("file_write:{e}"))?;
    fs::rename(&part, &path).map_err(|e| format!("file_write:{e}"))?;
  }
  Ok(thumb)
}

/// The archives a page may ask the picture protocol about.
///
/// The protocol is reachable from any script the page runs, so the archive has to be one the
/// user actually opened — the same reasoning as the asset protocol's scope, kept small because
/// there is exactly one thing to allow. Entries are bounded so a long session cannot grow the
/// list without limit; 256 archives is far more than a person opens in one sitting.
#[derive(Default)]
pub struct ArchiveScope(Mutex<HashSet<String>>);

impl ArchiveScope {
  pub fn allow(&self, path: &str) {
    let key = draft::normalize_path(path);
    if key.is_empty() {
      return;
    }
    let mut allowed = self.0.lock().unwrap_or_else(|e| e.into_inner());
    if allowed.len() < 256 || allowed.contains(&key) {
      allowed.insert(key);
    }
  }

  fn contains(&self, path: &str) -> bool {
    let key = draft::normalize_path(path);
    self
      .0
      .lock()
      .unwrap_or_else(|e| e.into_inner())
      .contains(&key)
  }
}

fn mime_of(name: &str) -> &'static str {
  let ext = name
    .rsplit_once('.')
    .map(|(_, ext)| ext.to_ascii_lowercase())
    .unwrap_or_default();
  match ext.as_str() {
    "svg" => "image/svg+xml",
    "png" => "image/png",
    "jpg" | "jpeg" => "image/jpeg",
    "gif" => "image/gif",
    "webp" => "image/webp",
    "bmp" => "image/bmp",
    "ico" => "image/x-icon",
    "avif" => "image/avif",
    _ => "application/octet-stream",
  }
}

fn decode_param(value: &str) -> Option<String> {
  use base64::engine::general_purpose::URL_SAFE_NO_PAD;
  use base64::Engine as _;
  String::from_utf8(URL_SAFE_NO_PAD.decode(value).ok()?).ok()
}

fn query_param<'a>(query: &'a str, name: &str) -> Option<&'a str> {
  query.split('&').find_map(|pair| {
    let (key, value) = pair.split_once('=')?;
    (key == name).then_some(value)
  })
}

/// Answer one `wrolp-archive://…/img?a=…&e=…&t=…` request.
///
/// The URL carries no path that could be mistaken for a filesystem one: both the archive and
/// the entry travel base64url-encoded, and the archive has to be in `ArchiveScope` — a page
/// cannot name an arbitrary file and have this read it. A `t` parameter asks for a thumbnail of
/// that edge; without it the picture itself is served.
pub fn serve_archive_image(
  app: &AppHandle,
  request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
  let reply = |status: u16, message: &str| {
    tauri::http::Response::builder()
      .status(status)
      .header("Content-Type", "text/plain; charset=utf-8")
      .body(message.as_bytes().to_vec())
      .unwrap_or_default()
  };
  if request.uri().path() != "/img" {
    return reply(404, "not found");
  }
  let query = request.uri().query().unwrap_or("");
  let (Some(archive), Some(entry)) = (
    query_param(query, "a").and_then(decode_param),
    query_param(query, "e").and_then(decode_param),
  ) else {
    return reply(400, "bad request");
  };
  // No `t` at all means the picture itself; a bare `t` means "a thumbnail, the usual size".
  let edge = match query_param(query, "t") {
    None => 0,
    Some(value) => value.parse::<u32>().ok().unwrap_or(THUMB_EDGE),
  };
  if !app.state::<ArchiveScope>().contains(&archive) {
    return reply(403, "archive_not_opened");
  }
  if !gallery::has_image_ext(&entry) {
    return reply(400, "not_a_picture");
  }
  let path = PathBuf::from(draft::io_path(&archive));
  let passwords = app.state::<crate::archive_passwords::ArchivePasswords>();
  let resolved = match crate::archive_passwords::resolve(app, &passwords, &path, None) {
    Ok(value) => value,
    Err(e) => return reply(403, &e),
  };
  let secret = needs_password(&path);
  let bytes = match read_image_from(&path, &entry, resolved.as_deref()) {
    Ok(bytes) => bytes,
    Err(e) => return reply(404, &e),
  };
  let (body, content_type) = if edge == 0 {
    (bytes, mime_of(&entry))
  } else {
    // A format the decoder does not know (heic) or one that failed keeps the full picture:
    // wrong size is a better answer than no picture.
    match thumbnail_of(app, &path, &entry, &bytes, edge.clamp(32, 1024)) {
      Ok(thumb) => (thumb, "image/webp"),
      Err(_) => (bytes, mime_of(&entry)),
    }
  };
  tauri::http::Response::builder()
    .status(200)
    .header("Content-Type", content_type)
    // A password-protected archive is not allowed to leave its pictures in the webview's
    // cache either, which is disk on this machine.
    .header(
      "Cache-Control",
      if secret { "no-store" } else { "max-age=60" },
    )
    .body(body)
    .unwrap_or_else(|_| reply(500, "response"))
}

/// One picture's bytes from an archive the reader has opened, for OCR.
///
/// Same scope check and password chain as the image protocol: a page cannot name an arbitrary
/// archive or entry, and an encrypted archive is only read with the password already resolved
/// for this session.
pub(crate) fn read_gallery_image(
  app: &AppHandle,
  archive: &str,
  entry: &str,
) -> Result<Vec<u8>, String> {
  if !app.state::<ArchiveScope>().contains(archive) {
    return Err("archive_not_opened".into());
  }
  if !gallery::has_image_ext(entry) {
    return Err("not_a_picture".into());
  }
  let path = PathBuf::from(draft::io_path(archive));
  let passwords = app.state::<crate::archive_passwords::ArchivePasswords>();
  let resolved = crate::archive_passwords::resolve(app, &passwords, &path, None)?;
  read_image_from(&path, entry, resolved.as_deref())
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

/// Copy one unpacked file out to a folder the user chose, under a name no file there has.
///
/// This is the one way a file leaves an archive in an editable form: the copy stays untouched,
/// and what comes out is an ordinary file the editor can save over.
#[tauri::command(async)]
pub fn export_from_archive(
  app: AppHandle,
  path: String,
  target_dir: String,
) -> Result<crate::rename::Renamed, String> {
  if !in_cache(&app, &path) {
    return Err("archive_bad_path".into());
  }
  let source = PathBuf::from(draft::io_path(&path));
  if !source.is_file() {
    return Err("archive_not_file".into());
  }
  let dir = PathBuf::from(draft::io_path(&target_dir));
  if !dir.is_dir() {
    return Err("not_a_directory".into());
  }
  let dest = copy_out(&source, &dir)?;
  Ok(crate::rename::Renamed {
    old_path: draft::normalize_path(&path),
    path: draft::normalize_path(&dest.to_string_lossy()),
    name: dest
      .file_name()
      .map(|n| n.to_string_lossy().into_owned())
      .unwrap_or_default(),
  })
}

/// A path in `dir` under `name` that no file there already holds.
///
/// Export is a way out, not a way to overwrite: two exports of the same path, or an export
/// beside a file somebody already has, both have to leave the earlier file alone.
fn free_name(dir: &Path, name: &str) -> Result<PathBuf, String> {
  let (stem, ext) = match name.rsplit_once('.') {
    Some((stem, ext)) if !stem.is_empty() => (stem.to_string(), format!(".{ext}")),
    _ => (name.to_string(), String::new()),
  };
  let mut dest = dir.join(name);
  for n in 2..1000 {
    if !dest.exists() {
      break;
    }
    dest = dir.join(format!("{stem} ({n}){ext}"));
  }
  if dest.exists() {
    return Err("file_exists".into());
  }
  Ok(dest)
}

fn copy_out(source: &Path, dir: &Path) -> Result<PathBuf, String> {
  let name = source
    .file_name()
    .map(|n| n.to_string_lossy().into_owned())
    .ok_or_else(|| "archive_bad_path".to_string())?;
  let dest = free_name(dir, &name)?;
  fs::copy(source, &dest).map_err(|e| format!("file_write:{e}"))?;
  Ok(dest)
}

/// One picture taken out of an archive into a folder the user chose, under a name no file
/// there has. The in-archive gallery uses it where the folder gallery offers "open in system".
#[tauri::command(async)]
pub fn archive_export_image(
  app: AppHandle,
  passwords: State<'_, crate::archive_passwords::ArchivePasswords>,
  archive: String,
  entry: String,
  target_dir: String,
  password: Option<String>,
) -> Result<crate::rename::Renamed, String> {
  let dir = PathBuf::from(draft::io_path(&target_dir));
  if !dir.is_dir() {
    return Err("not_a_directory".into());
  }
  let source = PathBuf::from(draft::io_path(&archive));
  let resolved = crate::archive_passwords::resolve(&app, &passwords, &source, password.as_deref())?;
  let bytes = read_image_from(&source, &entry, resolved.as_deref())?;
  let name = entry
    .rsplit('/')
    .next()
    .filter(|last| !last.is_empty())
    .ok_or_else(|| "archive_bad_path".to_string())?;
  let dest = free_name(&dir, name)?;
  fs::write(&dest, &bytes).map_err(|e| format!("file_write:{e}"))?;
  Ok(crate::rename::Renamed {
    old_path: draft::normalize_path(&archive),
    path: draft::normalize_path(&dest.to_string_lossy()),
    name: dest
      .file_name()
      .map(|n| n.to_string_lossy().into_owned())
      .unwrap_or_default(),
  })
}

/// The pictures in one archive, without unpacking any of them.
///
/// The password is resolved even though a listing does not decrypt anything: doing it here is
/// what lets the gallery open with the archive already unlocked, so the pictures that follow
/// do not each have to ask.
#[tauri::command(async)]
pub fn archive_list_images(
  app: AppHandle,
  passwords: State<'_, crate::archive_passwords::ArchivePasswords>,
  archive: String,
  inner: String,
  recursive: bool,
  password: Option<String>,
) -> Result<ArchiveImageList, String> {
  let source = PathBuf::from(draft::io_path(&archive));
  let _ = crate::archive_passwords::resolve(&app, &passwords, &source, password.as_deref())?;
  // The gallery will ask the picture protocol for these entries, and the protocol only serves
  // archives on this list.
  app.state::<ArchiveScope>().allow(&archive);
  list_images_in(&source, &inner, recursive)
}

/// The format of an archive, for deciding whether to offer "browse this archive" at all.
#[tauri::command(async)]
pub fn archive_detect(path: String) -> Result<Option<String>, String> {
  let head = head_of(Path::new(&draft::io_path(&path)), 512)?;
  Ok(detect(&head).map(|format| format.as_str().to_string()))
}

/// The entries of an archive, without unpacking any of them.
#[tauri::command(async)]
pub fn list_archive(
  app: AppHandle,
  passwords: State<'_, crate::archive_passwords::ArchivePasswords>,
  path: String,
  password: Option<String>,
) -> Result<ArchiveListing, String> {
  let source = PathBuf::from(draft::io_path(&path));
  let resolved = crate::archive_passwords::resolve(&app, &passwords, &source, password.as_deref())?;
  list_with(&source, resolved.as_deref())
}

/// Unpack an archive into its cache folder and return where it landed.
///
/// Re-extracting the same archive is a no-op: the folder is keyed by the archive's identity,
/// so the second visit shows the same copy rather than unpacking beside it.
#[tauri::command(async)]
pub fn extract_archive(
  app: AppHandle,
  passwords: State<'_, crate::archive_passwords::ArchivePasswords>,
  path: String,
  password: Option<String>,
) -> Result<ExtractReport, String> {
  let source = PathBuf::from(draft::io_path(&path));
  let resolved = crate::archive_passwords::resolve(&app, &passwords, &source, password.as_deref())?;
  let settings = crate::commands::load_settings(&app).unwrap_or_default();
  // Clamped rather than trusted: the number is editable as JSON like every other setting, and
  // a zero or a huge one would either refuse everything or remove the ceiling entirely.
  let total_limit = settings
    .archive_max_total_bytes
    .clamp(64 * 1024 * 1024, MAX_TOTAL_BYTES);
  let keep_days = settings.archive_keep_days.min(365) as u64;
  let listing = list_with(&source, resolved.as_deref())?;
  if listing.total_bytes > total_limit {
    return Err("archive_too_large".into());
  }
  let root = cache_root(&app)?;
  // A keep window of 0 means the cache is cleared when the app closes, so there is nothing to
  // sweep here — and sweeping with 0 would delete the copy that is about to be used.
  if keep_days > 0 {
    sweep(&root, keep_days);
  }
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
  let report = extract_into(&source, &staging, total_limit, resolved.as_deref());
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

/// Delete the unpacked copies, and the pictures made from them, when the app closes.
///
/// This is what a keep window of 0 means, and it is the default: an archive that asked for a
/// password must not leave readable files behind once the window that showed them is gone. A
/// window larger than 0 leaves both caches to the sweep that runs on the next extract.
pub fn clear_cache_on_exit(app: &AppHandle) {
  if crate::commands::settings_of(app).archive_keep_days > 0 {
    return;
  }
  if let Ok(root) = cache_root(app) {
    let _ = fs::remove_dir_all(root);
  }
  if let Ok(dir) = thumb_dir(app) {
    let _ = fs::remove_dir_all(dir);
  }
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

  /// The writer lives behind a test-only feature, so samples are produced here rather than
  /// checked into the tree.
  fn write_sevenz(dir: &Path, path: &Path, files: &[(&str, &[u8])]) {
    let mut writer = sevenz_rust::SevenZWriter::create(path).unwrap();
    for (index, (name, body)) in files.iter().enumerate() {
      let source = dir.join(format!("sevenz-source-{index}"));
      fs::write(&source, body).unwrap();
      let entry = sevenz_rust::SevenZArchiveEntry::from_path(&source, (*name).to_string());
      writer
        .push_archive_entry(entry, Some(File::open(&source).unwrap()))
        .unwrap();
    }
    writer.finish().unwrap();
  }

  #[test]
  fn detect_looks_at_bytes_and_not_at_names() {
    assert_eq!(detect(b"PK\x03\x04rest"), Some(ArchiveFormat::Zip));
    assert_eq!(detect(b"PK\x05\x06"), Some(ArchiveFormat::Zip));
    assert_eq!(
      detect(b"7z\xbc\xaf\x27\x1crest"),
      Some(ArchiveFormat::SevenZ)
    );
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
    let report = extract_into(&path, &out, MAX_TOTAL_BYTES, None).unwrap();
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
    extract_into(&path, &out, MAX_TOTAL_BYTES, None).unwrap();
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
    let report = extract_into(&path, &out, MAX_TOTAL_BYTES, None).unwrap();
    assert_eq!(report.entries, 1);
    assert_eq!(report.skipped.len(), 1);
    assert_eq!(report.skipped[0].reason, "link");
    assert!(!out.join("escape").exists());
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn exporting_twice_leaves_the_first_copy_alone() {
    let dir = temp_dir("export");
    let source = dir.join("notes.md");
    fs::write(&source, b"one").unwrap();
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    let first = copy_out(&source, &out).unwrap();
    let second = copy_out(&source, &out).unwrap();
    assert_eq!(first.file_name().unwrap(), "notes.md");
    assert_eq!(second.file_name().unwrap(), "notes (2).md");
    assert_eq!(fs::read(&first).unwrap(), b"one");
    assert_eq!(fs::read(&second).unwrap(), b"one");
    fs::remove_dir_all(&dir).unwrap();
  }

  /// A zip sealed with WinZip AES, the shape most password-protected archives arrive in.
  fn write_encrypted_zip(path: &Path, password: &str) {
    let file = File::create(path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options =
      zip::write::SimpleFileOptions::default().with_aes_encryption(zip::AesMode::Aes256, password);
    writer.start_file("secret.txt", options).unwrap();
    writer.write_all(b"inside").unwrap();
    writer.finish().unwrap();
  }

  #[test]
  fn an_encrypted_zip_asks_for_a_password_and_then_opens_with_it() {
    let dir = temp_dir("encrypted");
    let path = dir.join("locked.zip");
    write_encrypted_zip(&path, "hunter2");
    assert!(needs_password(&path));
    assert_eq!(
      list_with(&path, None).err(),
      Some("archive_password_required".into())
    );
    assert!(password_works(&path, "hunter2").unwrap());
    assert!(!password_works(&path, "wrong").unwrap());
    assert_eq!(
      list_with(&path, Some("wrong")).err(),
      Some("archive_bad_password".into())
    );
    let listing = list_with(&path, Some("hunter2")).unwrap();
    assert_eq!(listing.entries.len(), 1);
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    assert_eq!(
      extract_into(&path, &out, MAX_TOTAL_BYTES, Some("wrong")).err(),
      Some("archive_bad_password".into())
    );
    let report = extract_into(&path, &out, MAX_TOTAL_BYTES, Some("hunter2")).unwrap();
    assert_eq!(report.entries, 1);
    assert_eq!(fs::read(out.join("secret.txt")).unwrap(), b"inside");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_chinese_password_is_offered_as_gbk_after_utf8() {
    let candidates = password_candidates("密码");
    assert_eq!(candidates[0], "密码".as_bytes());
    // GBK for 密 (C3 DC) 码 (C2 EB). AES uses the first candidate; ZipCrypto written by a
    // Chinese archiver uses this one.
    assert_eq!(candidates[1], [0xC3, 0xDC, 0xC2, 0xEB]);
    // ASCII is the same bytes in every encoding, so it is not tried twice.
    assert_eq!(password_candidates("hunter2").len(), 1);
  }

  #[test]
  fn a_chinese_password_opens_an_aes_zip() {
    let dir = temp_dir("chinese-password");
    let path = dir.join("locked.zip");
    write_encrypted_zip(&path, "密码123");
    assert!(password_works(&path, "密码123").unwrap());
    assert!(!password_works(&path, "密码124").unwrap());
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    let report = extract_into(&path, &out, MAX_TOTAL_BYTES, Some("密码123")).unwrap();
    assert_eq!(report.entries, 1);
    assert_eq!(fs::read(out.join("secret.txt")).unwrap(), b"inside");
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_7z_lists_and_unpacks_through_the_same_rules() {
    let dir = temp_dir("7z");
    let path = dir.join("a.7z");
    write_sevenz(
      &dir,
      &path,
      &[("readme.txt", b"hello"), ("docs/inner.md", b"# title")],
    );
    let listing = list(&path).unwrap();
    assert_eq!(listing.format, "7z");
    assert_eq!(listing.entries.len(), 2);
    assert_eq!(listing.total_bytes, 5 + 7);
    let out = dir.join("out");
    fs::create_dir_all(&out).unwrap();
    let report = extract_into(&path, &out, MAX_TOTAL_BYTES, None).unwrap();
    assert_eq!(report.entries, 2);
    assert_eq!(fs::read(out.join("docs/inner.md")).unwrap(), b"# title");
    // Cleanup is best-effort: this machine's sandbox redirects deletes, which can leave the
    // folder behind and must not turn a passing extraction into a failure.
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_7z_lists_pictures_and_reads_one_by_entry() {
    let dir = temp_dir("7z-images");
    let path = dir.join("pics.7z");
    write_sevenz(
      &dir,
      &path,
      &[
        ("a.png", b"alpha"),
        ("sub/b.jpg", b"beta"),
        ("notes.txt", b"text"),
      ],
    );
    let flat = list_images_in(&path, "", false).unwrap();
    assert_eq!(
      flat
        .items
        .iter()
        .map(|i| i.name.as_str())
        .collect::<Vec<_>>(),
      vec!["a.png"]
    );
    let deep = list_images_in(&path, "", true).unwrap();
    assert_eq!(
      deep
        .items
        .iter()
        .map(|i| i.entry.as_str())
        .collect::<Vec<_>>(),
      vec!["a.png", "sub/b.jpg"]
    );
    // Only the block holding the entry is decoded; the other pictures are left alone.
    assert_eq!(read_sevenz_image(&path, "sub/b.jpg").unwrap(), b"beta");
    assert_eq!(
      read_sevenz_image(&path, "notes.txt").unwrap_err(),
      "archive_bad_path"
    );
    assert_eq!(
      read_sevenz_image(&path, "missing.png").unwrap_err(),
      "archive_bad_path"
    );
    let _ = fs::remove_dir_all(&dir);
  }

  fn sample_png(width: u32, height: u32) -> Vec<u8> {
    use image::{GenericImage, Rgba, RgbaImage};
    let mut picture = RgbaImage::new(width, height);
    for (x, y, pixel) in picture.enumerate_pixels_mut() {
      *pixel = Rgba([(x % 256) as u8, (y % 256) as u8, 40, 255]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(picture)
      .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
      .unwrap();
    out
  }

  #[test]
  fn a_thumbnail_fits_the_edge_and_keeps_the_aspect() {
    let raw = sample_png(1000, 500);
    let thumb = make_thumbnail(&raw, THUMB_EDGE).unwrap();
    let decoded = image::load_from_memory(&thumb).unwrap();
    assert_eq!(
      (decoded.width(), decoded.height()),
      (THUMB_EDGE, THUMB_EDGE / 2)
    );
    // A picture already smaller than the edge is left at its own size.
    let small = make_thumbnail(&sample_png(40, 20), THUMB_EDGE).unwrap();
    let decoded = image::load_from_memory(&small).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (40, 20));
  }

  #[test]
  fn a_thumbnail_falls_back_loudly_for_bytes_it_cannot_decode() {
    assert_eq!(
      make_thumbnail(b"not a picture", THUMB_EDGE).unwrap_err(),
      "archive_thumb_failed"
    );
  }

  #[test]
  fn pictures_are_listed_by_folder_and_natural_name() {
    let dir = temp_dir("images");
    let path = dir.join("a.zip");
    write_zip(
      &path,
      &[
        ("IMG_10.png", b"ten"),
        ("IMG_2.png", b"two"),
        ("notes.txt", b"text"),
        ("sub/c.png", b"c"),
        ("sub/deep/d.jpg", b"d"),
        ("node_modules/skip.png", b"skip"),
      ],
    );
    let flat = list_images_in(&path, "", false).unwrap();
    assert_eq!(
      flat
        .items
        .iter()
        .map(|i| i.name.as_str())
        .collect::<Vec<_>>(),
      vec!["IMG_2.png", "IMG_10.png"]
    );
    assert_eq!(flat.scanned, 6);

    let deep = list_images_in(&path, "", true).unwrap();
    assert_eq!(
      deep
        .items
        .iter()
        .map(|i| i.entry.as_str())
        .collect::<Vec<_>>(),
      vec!["IMG_2.png", "IMG_10.png", "sub/c.png", "sub/deep/d.jpg"]
    );

    let inner = list_images_in(&path, "sub", false).unwrap();
    assert_eq!(
      inner
        .items
        .iter()
        .map(|i| i.entry.as_str())
        .collect::<Vec<_>>(),
      vec!["sub/c.png"]
    );
    assert_eq!(list_images_in(&path, "sub", true).unwrap().items.len(), 2);
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn an_archive_without_pictures_says_so() {
    let dir = temp_dir("noimages");
    let path = dir.join("a.zip");
    write_zip(&path, &[("readme.txt", b"plain")]);
    assert_eq!(
      list_images_in(&path, "", true).err(),
      Some("archive_no_images".into())
    );
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn only_a_zip_can_be_read_in_place() {
    let dir = temp_dir("streamonly");
    let path = dir.join("a.tar");
    write_tar(&path, |builder| append_tar_file(builder, "a.png", b"png"));
    assert_eq!(
      list_images_in(&path, "", true).err(),
      Some("archive_stream_only".into())
    );
    assert_eq!(
      read_image_from(&path, "a.png", None).err(),
      Some("archive_stream_only".into())
    );
    let _ = fs::remove_dir_all(&dir);
  }

  #[test]
  fn one_picture_is_read_by_the_name_the_listing_gave() {
    let dir = temp_dir("readimage");
    let path = dir.join("a.zip");
    write_zip(
      &path,
      &[("pics/a.png", b"png-bytes"), ("notes.txt", b"text")],
    );
    assert_eq!(
      read_image_from(&path, "pics/a.png", None).unwrap(),
      b"png-bytes".to_vec()
    );
    // A document is not addressable through the picture command, and a missing name is not
    // guessed at.
    assert_eq!(
      read_image_from(&path, "notes.txt", None).err(),
      Some("archive_bad_path".into())
    );
    assert_eq!(
      read_image_from(&path, "pics/missing.png", None).err(),
      Some("archive_bad_path".into())
    );
    let _ = fs::remove_dir_all(&dir);
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
