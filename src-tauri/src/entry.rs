//! Creating, copying and deleting files and folders, and letting go of the state that only
//! existed while they did.
//!
//! A path is the identity of a document across the whole store (see `rename`), so none of
//! this is only a filesystem operation: a typed name has to be one this app is willing to put
//! on disk, a copy has to land on a name that is free rather than on top of somebody's file,
//! and a delete has to stop the store pointing at something that is gone.
//!
//! What a delete deliberately does *not* do is throw the drafts away. Those hold the unsaved
//! text of files that were open when the entry went; a file deleted by mistake and created
//! again should still be offered its own edits back, which is the one thing left that can be.

use crate::commands::{self, protected_roots, refused_by_scope, FsEntry, HistoryEntry, SavedFile};
use crate::draft;
use crate::group::{GroupStore, GroupTab};
use crate::rename::{check_name, rekey_state, under, NameError, Renamed};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

/// Extension given to a new file typed without one.
///
/// It is a text file by intent, and naming it as one keeps it out of the "unknown binary"
/// hole every other tool has for an extensionless name.
const DEFAULT_EXT: &str = "txt";

/// Extension given to a new *encrypted* file typed without one.
///
/// Naming it after the container rather than after a text format matters here in a way it does
/// not for `DEFAULT_EXT`: an encrypted file is not readable by anything else, and an extension
/// that promised text would invite the user to open it in a tool that shows them noise.
pub(crate) const ENCRYPTED_EXT: &str = "wrolpenc";

fn name_error(e: NameError) -> String {
  match e {
    NameError::Empty => "create_name_empty".to_string(),
    NameError::Invalid => "create_name_invalid".to_string(),
  }
}

/// Where the entry will live, or why it cannot be created there.
///
/// The parent has to be a directory that is there now. Recreating the chain instead would
/// turn a folder the tree has just lost into a brand new one, several levels up from where
/// the user is looking.
fn target_of(parent: &str, name: &str) -> Result<PathBuf, String> {
  // This is where the entry is actually written, so the spelling has to be the one the user
  // typed: `normalize_path` lowercases on Windows and would put `Report.TXT` on disk as
  // `report.txt`, which the next listing then reports back verbatim. Identity stays with
  // `normalize_path` in the returned FsEntry; only the filesystem spelling is kept here.
  let dir = draft::io_path(parent);
  if dir.is_empty() {
    return Err("path_empty".into());
  }
  let dir = Path::new(&dir);
  if !dir.is_dir() {
    return Err("create_no_parent".into());
  }
  let path = draft::io_path(&dir.join(name).to_string_lossy());
  if path.is_empty() {
    return Err("path_unresolvable".into());
  }
  Ok(PathBuf::from(path))
}

/// The name an entry will be created under, extension included.
///
/// A name that carries any dot at all is left as typed: that covers a real extension and a
/// dotfile such as `.gitignore` alike, and appending to those would invent a name the user
/// did not ask for. Only a bare word gets `default_ext`.
fn entry_name(typed: &str, default_ext: &str) -> String {
  if typed.contains('.') {
    typed.to_string()
  } else {
    format!("{typed}.{default_ext}")
  }
}

/// Resolve a typed name to where a new entry will be created, and to the name it will carry.
///
/// Shared with the encrypted variant in `unlock` so the name discipline — checked, extended,
/// checked again for the length the extension added, resolved under a parent that is there, and
/// refused when the name is taken — is one rule rather than two that can drift apart.
pub(crate) fn new_entry_path(
  parent: &str,
  name: &str,
  default_ext: &str,
) -> Result<(PathBuf, String), String> {
  let typed = check_name(name).map_err(name_error)?;
  let named = entry_name(&typed, default_ext);
  // The extension is part of the segment, so the finished name has to face the limit again.
  if check_name(&named).is_err() {
    return Err("create_name_too_long".into());
  }
  let path = target_of(parent, &named)?;
  if path.exists() {
    return Err("create_exists".into());
  }
  Ok((path, named))
}

/// Create an empty file inside `parent`.
///
/// The file starts empty: it is a file the user asked to exist, not one with anything in it,
/// and an editor that invented content would be writing text nobody typed.
#[tauri::command(async, rename = "create_file")]
pub fn create_file_command(
  app: AppHandle,
  parent: String,
  name: String,
) -> Result<FsEntry, String> {
  crate::archive::refuse_if_cached(&app, &parent)?;
  create_file(parent, name)
}

/// The creation itself, once the folder has been cleared to receive it.
pub fn create_file(parent: String, name: String) -> Result<FsEntry, String> {
  let (path, named) = new_entry_path(&parent, &name, DEFAULT_EXT)?;
  // `create_new` rather than a plain write: it refuses a name that was taken between the
  // check above and here, so the one file that must never be destroyed by a "create" is
  // never truncated by one.
  std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&path)
    .map_err(|e| format!("create_failed:{e}"))?;
  let (mtime, bytes) = commands::stat_pair(&path, false);
  let path = draft::normalize_path(&path.to_string_lossy());
  Ok(FsEntry {
    name: named,
    path,
    is_dir: false,
    mtime,
    bytes,
  })
}

/// Create a folder inside `parent`.
#[tauri::command(async, rename = "create_dir")]
pub fn create_dir_command(app: AppHandle, parent: String, name: String) -> Result<FsEntry, String> {
  crate::archive::refuse_if_cached(&app, &parent)?;
  create_dir(parent, name)
}

/// The creation itself, once the folder has been cleared to receive it.
pub fn create_dir(parent: String, name: String) -> Result<FsEntry, String> {
  let named = check_name(&name).map_err(name_error)?;
  let path = target_of(&parent, &named)?;
  if path.exists() {
    return Err("create_exists".into());
  }
  std::fs::create_dir(&path).map_err(|e| format!("create_failed:{e}"))?;
  let (mtime, bytes) = commands::stat_pair(&path, true);
  let path = draft::normalize_path(&path.to_string_lossy());
  Ok(FsEntry {
    // The trailing separator is how a listing says "this is a folder", and the tree reads
    // the name rather than the flag when it draws one.
    name: format!("{named}/"),
    path,
    is_dir: true,
    mtime,
    bytes,
  })
}

/// The name halves of a file name, so a copy can be numbered without losing its type.
///
/// `notes.txt` becomes `("notes", ".txt")`, and a name with no extension — including a
/// dotfile, which *is* its own stem — keeps itself and gains an empty suffix.
fn split_ext(name: &str) -> (String, String) {
  let path = Path::new(name);
  let stem = path
    .file_stem()
    .map(|s| s.to_string_lossy().to_string())
    .unwrap_or_else(|| name.to_string());
  let ext = match path.extension() {
    Some(e) => format!(".{}", e.to_string_lossy()),
    None => String::new(),
  };
  (stem, ext)
}

/// A path inside `dir` that nothing is using yet.
///
/// A copy keeps the name the user copied, because that is the name they asked for, and takes
/// the next free spelling of it rather than writing over the file that is already there: the
/// one thing a paste must never do is destroy the file it landed on.
fn free_name(dir: &Path, name: &str) -> Result<PathBuf, String> {
  let direct = dir.join(name);
  if !direct.exists() {
    return Ok(direct);
  }
  let (stem, ext) = split_ext(name);
  for n in 2..1000 {
    let numbered = dir.join(format!("{stem} ({n}){ext}"));
    if !numbered.exists() {
      return Ok(numbered);
    }
  }
  Err("copy_name_full".into())
}

/// Copy the contents of `from` into `to`, both of them folders that already exist.
///
/// Links are never followed: where one points is outside the folder that was copied, and
/// walking it could drag in a whole drive the user never named. Skipping them is also what
/// makes the walk finite even before the self-check above has had its say.
fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
  std::fs::create_dir_all(to).map_err(|e| format!("dir_create:{e}"))?;
  let read = std::fs::read_dir(from).map_err(|e| format!("dir_read:{e}"))?;
  for item in read.flatten() {
    let meta = match item.file_type() {
      Ok(m) => m,
      Err(_) => continue,
    };
    if meta.is_symlink() {
      continue;
    }
    let target = to.join(item.file_name());
    if meta.is_dir() {
      copy_tree(&item.path(), &target)?;
    } else {
      std::fs::copy(item.path(), &target).map_err(|e| format!("copy_failed:{e}"))?;
    }
  }
  Ok(())
}

/// Copy a file, or a folder and everything in it, into a folder.
///
/// The copy lands beside whatever else is there rather than replacing it, which is why the
/// name it ends up with is the answer this returns: the caller shows the real name, so a
/// paste that had to be numbered is not a surprise found later.
#[tauri::command(async, rename = "copy_entry")]
pub fn copy_entry_command(
  app: AppHandle,
  source: String,
  target: String,
) -> Result<FsEntry, String> {
  // An unpacked archive is a view of somebody else's bytes: copying into it would edit a copy
  // that the next clean-up deletes, so the refusal is the same one every write makes.
  crate::archive::refuse_if_cached(&app, &target)?;
  copy_entry(source, target)
}

/// The copy itself, once the destination has been cleared to receive it.
pub fn copy_entry(source: String, target: String) -> Result<FsEntry, String> {
  // The spelling on disk, not the identity key: `normalize_path` lowercases on Windows, and
  // the copy takes its name from this path — `Report.txt` used to land as `report.txt`.
  let from = draft::io_path(&source);
  let dir = draft::io_path(&target);
  if from.is_empty() || dir.is_empty() {
    return Err("path_empty".into());
  }
  let from = Path::new(&from);
  let dir = Path::new(&dir);
  let meta = from
    .symlink_metadata()
    .map_err(|e| format!("copy_not_found:{e}"))?;
  if !dir.is_dir() {
    return Err("copy_no_target".into());
  }
  // The same line the asset scope draws, for the same reason: a paste into the system
  // directory or the user's whole profile is not something this app should do.
  if refused_by_scope(dir, &protected_roots()) {
    return Err("copy_refused".into());
  }
  if meta.file_type().is_symlink() {
    // A link is not a file to copy: what would be copied is whatever it points at, which
    // the user did not name and cannot see from the tree.
    return Err("copy_link".into());
  }
  let name = from
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .ok_or("copy_no_name")?;
  let to = free_name(dir, &name)?;
  // Copying a folder into itself would walk into the copy it is making and never stop.
  if under(
    &draft::normalize_path(&to.to_string_lossy()),
    &draft::normalize_path(&from.to_string_lossy()),
  ) {
    return Err("copy_into_itself".into());
  }
  let is_dir = meta.is_dir();
  if is_dir {
    copy_tree(from, &to)?;
  } else {
    std::fs::copy(from, &to).map_err(|e| format!("copy_failed:{e}"))?;
  }
  let (mtime, bytes) = commands::stat_pair(&to, is_dir);
  let path = draft::normalize_path(&to.to_string_lossy());
  Ok(FsEntry {
    // The trailing separator is how a listing says "folder", and a copy is shown by the
    // same listing.
    name: if is_dir {
      format!("{}/", name_at(&to))
    } else {
      name_at(&to)
    },
    path,
    is_dir,
    mtime,
    bytes,
  })
}

/// Put `from` at `to`, falling back to a copy and a delete when the two are on different
/// volumes.
///
/// `rename` cannot cross volumes: the contents would have to be read and written anyway, so
/// the only way to honour the gesture is to copy the entry and then take the original away.
/// The copy is removed again when the delete fails, because leaving both sides behind is a
/// copy the user never asked for.
fn move_across(from: &Path, to: &Path, is_dir: bool) -> Result<(), String> {
  if std::fs::rename(from, to).is_ok() {
    return Ok(());
  }
  let copied = if is_dir {
    copy_tree(from, to)
  } else {
    std::fs::copy(from, to)
      .map(|_| ())
      .map_err(|e| format!("copy_failed:{e}"))
  };
  if let Err(e) = copied {
    if is_dir {
      let _ = std::fs::remove_dir_all(to);
    } else {
      let _ = std::fs::remove_file(to);
    }
    return Err(e);
  }
  let removed = if is_dir {
    std::fs::remove_dir_all(from)
  } else {
    std::fs::remove_file(from)
  };
  if let Err(e) = removed {
    if is_dir {
      let _ = std::fs::remove_dir_all(to);
    } else {
      let _ = std::fs::remove_file(to);
    }
    return Err(format!("move_failed:{e}"));
  }
  Ok(())
}

/// Move a file, or a folder and everything in it, into another folder.
///
/// A move is the one entry operation that takes something away from where it was, so nothing
/// is replaced: a folder already holding that name is a refusal rather than a reason to
/// invent a numbered one. Everything the app keys by the path is re-homed afterwards, so an
/// open tab, its draft and its version history follow the entry rather than being left
/// pointing at a file that is no longer there.
#[tauri::command(async)]
pub fn move_entry(app: AppHandle, source: String, target: String) -> Result<Renamed, String> {
  crate::archive::refuse_if_cached(&app, &source)?;
  crate::archive::refuse_if_cached(&app, &target)?;
  // `old` is the identity the re-homing keys on; the move itself uses the spelling on disk,
  // because the name it carries over comes from these paths — a lowercased source would put
  // `Report.txt` down as `report.txt`.
  let old = draft::normalize_path(&source);
  let from_io = draft::io_path(&source);
  let dir = draft::io_path(&target);
  if old.is_empty() || from_io.is_empty() || dir.is_empty() {
    return Err("path_empty".into());
  }
  let from = Path::new(&from_io);
  let dir_path = Path::new(&dir);
  // Read as the entry itself: a link is what it is, not what it points at.
  let meta = from
    .symlink_metadata()
    .map_err(|e| format!("move_not_found:{e}"))?;
  if !dir_path.is_dir() {
    return Err("move_no_target".into());
  }
  // The same line a copy and a delete draw: neither end of a move may be a drive root or a
  // folder that holds the whole profile or the system directory.
  if refused_by_scope(dir_path, &protected_roots()) || refused_by_scope(from, &protected_roots()) {
    return Err("move_refused".into());
  }
  if meta.file_type().is_symlink() {
    return Err("move_link".into());
  }
  let name = from
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .ok_or("move_no_name")?;
  let to = dir_path.join(&name);
  let new = draft::normalize_path(&to.to_string_lossy());
  if new.is_empty() {
    return Err("path_unresolvable".into());
  }
  // Dropped back into the folder it came from: nothing moves, so nothing has to be re-homed.
  if new == old {
    return Ok(Renamed {
      old_path: old,
      path: new,
      name,
    });
  }
  let is_dir = meta.is_dir();
  // A folder moved inside itself would carry its own destination along with it.
  if is_dir && under(&new, &old) {
    return Err("move_into_itself".into());
  }
  if to.exists() {
    return Err("move_exists".into());
  }
  move_across(from, &to, is_dir)?;
  rekey_state(&app, &old, &new)?;
  Ok(Renamed {
    old_path: old,
    path: new,
    name,
  })
}

/// The files Windows Explorer put on the clipboard, in the order it listed them.
///
/// `None` means the clipboard holds no file list at all — text or a picture. A paste falls
/// back to the picture in that case, so the distinction is what lets a screenshot arrive
/// through the same gesture as a copied file.
fn clipboard_files() -> Result<Option<Vec<PathBuf>>, String> {
  let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard_read:{e}"))?;
  match clipboard.get().file_list() {
    Ok(files) => Ok(Some(files)),
    Err(arboard::Error::ContentNotAvailable) => Ok(None),
    Err(arboard::Error::ClipboardOccupied) => Err("clipboard_busy".into()),
    Err(other) => Err(format!("clipboard_read:{other}")),
  }
}

/// The largest clipboard picture a paste will turn into a file. A 4K screenshot is about
/// 8 MP, so this leaves room for a wide multi-monitor grab while the RGBA buffer and the
/// encoder stay bounded.
const MAX_CLIPBOARD_IMAGE_PIXELS: usize = 40_000_000;
/// A PNG past this size is refused rather than written. Screenshots compress well; a file
/// this large is not the one the gesture promised.
const MAX_CLIPBOARD_IMAGE_BYTES: usize = 64 * 1024 * 1024;

/// Check a clipboard picture's shape before anything is allocated or encoded for it.
fn clipboard_image_shape(width: usize, height: usize, len: usize) -> Result<(), String> {
  let pixels = width
    .checked_mul(height)
    .ok_or_else(|| "clipboard_image_too_large".to_string())?;
  if pixels == 0 || len != pixels.saturating_mul(4) {
    return Err("clipboard_image_invalid".into());
  }
  if pixels > MAX_CLIPBOARD_IMAGE_PIXELS {
    return Err("clipboard_image_too_large".into());
  }
  Ok(())
}

/// The PNG signature and the IHDR size of a byte payload, when it is a PNG at all.
///
/// Reading the header rather than decoding lets a screenshot that is already PNG be written
/// unchanged: re-encoding a full screen in a debug build is slow for no gain, and the bytes
/// are exactly what the clipboard owner produced.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
  const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
  if bytes.len() < 24 || bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
    return None;
  }
  let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
  let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
  Some((width, height))
}

/// Whether a picture of this shape is one a paste will write.
fn acceptable_image(width: u32, height: u32) -> bool {
  let pixels = (width as usize).saturating_mul(height as usize);
  pixels > 0 && pixels <= MAX_CLIPBOARD_IMAGE_PIXELS
}

/// Decode a picture from bytes under the same allocation ceiling as the clipboard paths.
fn decode_image_bytes(bytes: &[u8]) -> Result<image::DynamicImage, String> {
  if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
    return Err("clipboard_image_too_large".into());
  }
  let mut limits = image::Limits::default();
  limits.max_image_width = Some(20_000);
  limits.max_image_height = Some(20_000);
  // Room for RGBA plus the decoder's own buffers at the pixel ceiling; the exact pixel
  // check runs after decoding, so this is the coarser of the two guards.
  limits.max_alloc = Some(256 * 1024 * 1024);
  let mut reader = image::ImageReader::new(std::io::Cursor::new(bytes))
    .with_guessed_format()
    .map_err(|_| "clipboard_image_invalid".to_string())?;
  reader.limits(limits);
  let image = reader
    .decode()
    .map_err(|_| "clipboard_image_invalid".to_string())?;
  if !acceptable_image(image.width(), image.height()) {
    return Err("clipboard_image_too_large".into());
  }
  Ok(image)
}

/// A PNG published under a format name rather than a file, as some capture tools do.
///
/// WeChat's screenshot tool, for one, registers `image/png` and a DeviceIndependentBitmap;
/// arboard looks for the standard `PNG` registration and CF_DIBV5, so on that clipboard it
/// fails with a conversion error. Reading the MIME-spelled format first is what makes the
/// menu's Paste and the Explorer's paste work for the screenshots people actually take.
/// The standard name is tried too, so a program using either spelling is covered.
#[cfg(windows)]
fn clipboard_png_bytes() -> Option<Vec<u8>> {
  let guard = clipboard_win::Clipboard::new_attempts(5).ok()?;
  for name in ["PNG", "image/png"] {
    let Some(format) = clipboard_win::raw::register_format(name) else {
      continue;
    };
    if !clipboard_win::raw::is_format_avail(format.get()) {
      continue;
    }
    let mut bytes = Vec::new();
    if clipboard_win::raw::get_vec(format.get(), &mut bytes).is_ok() && !bytes.is_empty() {
      drop(guard);
      return Some(bytes);
    }
  }
  drop(guard);
  None
}

#[cfg(not(windows))]
fn clipboard_png_bytes() -> Option<Vec<u8>> {
  None
}

/// The picture on the clipboard, as RGBA, with the checks a paste needs.
fn clipboard_image() -> Result<(u32, u32, Vec<u8>), String> {
  let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard_read:{e}"))?;
  let arboard::ImageData {
    width,
    height,
    bytes,
  } = clipboard.get_image().map_err(|e| match e {
    arboard::Error::ContentNotAvailable => "clipboard_empty".to_string(),
    arboard::Error::ClipboardOccupied => "clipboard_busy".to_string(),
    other => format!("clipboard_read:{other}"),
  })?;
  let bytes = bytes.into_owned();
  clipboard_image_shape(width, height, bytes.len())?;
  Ok((width as u32, height as u32, bytes))
}

/// Encode an image as PNG. PNG rather than BMP or JPEG: a screenshot is text on flat colour,
/// and lossless compression keeps the edges the reader is about to read.
fn png_of_image(image: image::DynamicImage) -> Result<Vec<u8>, String> {
  let mut png = Vec::new();
  image
    .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
    .map_err(|e| format!("clipboard_image_write:{e}"))?;
  if png.len() > MAX_CLIPBOARD_IMAGE_BYTES {
    return Err("clipboard_image_too_large".into());
  }
  Ok(png)
}

/// A clipboard picture in the RGBA shape arboard hands over, encoded as PNG.
fn clipboard_png(width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<u8>, String> {
  let image = image::RgbaImage::from_raw(width, height, rgba)
    .ok_or_else(|| "clipboard_image_invalid".to_string())?;
  png_of_image(image::DynamicImage::ImageRgba8(image))
}

/// Where a clipboard picture can land: an existing folder, not the system or profile tree.
fn paste_dir(dir: &str) -> Result<PathBuf, String> {
  let dir = draft::io_path(dir);
  if dir.is_empty() {
    return Err("path_empty".into());
  }
  let dir = PathBuf::from(dir);
  if !dir.is_dir() {
    return Err("copy_no_target".into());
  }
  if refused_by_scope(&dir, &protected_roots()) {
    return Err("copy_refused".into());
  }
  Ok(dir)
}

/// The moment a paste happened, in a spelling a file name can carry.
fn pasted_stamp() -> String {
  chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// The stem a paste offers as its default: `image-<moment>`, numbered if that name is taken.
/// The dialog shows this, and the save repeats the check under `create_new`, so a race
/// between the two still cannot overwrite anything.
fn free_image_stem(dir: &Path) -> String {
  let base = format!("image-{}", pasted_stamp());
  for n in 1..1000 {
    let stem = if n == 1 {
      base.clone()
    } else {
      format!("{base}-{n}")
    };
    if !dir.join(format!("{stem}.png")).exists() {
      return stem;
    }
  }
  base
}

/// A user-chosen stem through the same segment rules as a renamed file. A typed `.png` is
/// folded into the suffix the dialog already shows rather than becoming `.png.png`; a name
/// that is only the suffix lands on the empty-name error.
fn explicit_image_stem(raw: &str) -> Result<String, String> {
  let cleaned = check_name(raw).map_err(name_error)?;
  let stem = if cleaned.to_ascii_lowercase().ends_with(".png") {
    cleaned[..cleaned.len() - 4].to_string()
  } else {
    cleaned
  };
  if stem.is_empty() {
    return Err("create_name_empty".into());
  }
  Ok(stem)
}

/// Create one named PNG and write it. A name already on disk answers `create_exists` rather
/// than being overwritten; the sidecar of this is the "never destroy somebody's file" rule
/// every paste in the app follows.
fn write_new_png(dir: &Path, name: &str, png: &[u8]) -> Result<PathBuf, String> {
  let path = dir.join(name);
  match std::fs::OpenOptions::new()
    .write(true)
    .create_new(true)
    .open(&path)
  {
    Ok(mut file) => {
      if let Err(e) = file.write_all(png) {
        drop(file);
        let _ = std::fs::remove_file(&path);
        return Err(format!("clipboard_image_write:{e}"));
      }
      Ok(path)
    }
    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Err("create_exists".into()),
    Err(e) => Err(format!("clipboard_image_write:{e}")),
  }
}

/// Write the PNG under the chosen stem, with the extension the dialog shows. The name is
/// exactly what was asked for: a taken one is reported, not silently numbered, because the
/// reader is in the dialog to choose it.
fn write_explicit_png(dir: &Path, stem: &str, png: &[u8]) -> Result<(PathBuf, String), String> {
  let name = format!("{stem}.png");
  let path = write_new_png(dir, &name, png)?;
  Ok((path, name))
}

/// Write the PNG under a name no file in the folder has, refusing to overwrite.
///
/// This is the path with no dialog in front of it: the timestamp stem is numbered with
/// `-2`, `-3` rather than a suffix with a space, because the name is also what a Markdown
/// link carries.
fn write_pasted_png(dir: &Path, stem: &str, png: &[u8]) -> Result<(PathBuf, String), String> {
  for n in 1..1000 {
    let name = if n == 1 {
      format!("{stem}.png")
    } else {
      format!("{stem}-{n}.png")
    };
    match write_new_png(dir, &name, png) {
      Ok(path) => return Ok((path, name)),
      Err(e) if e == "create_exists" => continue,
      Err(e) => return Err(e),
    }
  }
  Err("clipboard_image_write:name_full".into())
}

/// The entry a just-written PNG lands on, as the tree lists it. A stem is the name the
/// dialog collected; without one the timestamp and the numbered fallback choose it.
fn entry_of_png(dir: &Path, png: &[u8], stem: Option<&str>) -> Result<FsEntry, String> {
  let (path, name) = match stem {
    Some(raw) => write_explicit_png(dir, &explicit_image_stem(raw)?, png)?,
    None => {
      let base = format!("image-{}", pasted_stamp());
      write_pasted_png(dir, &base, png)?
    }
  };
  let (mtime, bytes) = commands::stat_pair(&path, false);
  let path = draft::normalize_path(&path.to_string_lossy());
  Ok(FsEntry {
    name,
    path,
    is_dir: false,
    mtime,
    bytes,
  })
}

/// Save the clipboard's picture into `dir` and return the entry, as the tree lists it.
///
/// `name` is the stem the paste dialog collected; without one the timestamp and the
/// numbered fallback choose it.
pub fn paste_clipboard_image(dir: String, name: Option<String>) -> Result<FsEntry, String> {
  let dir = paste_dir(&dir)?;
  let stem = name.as_deref();
  // A capture tool that publishes a PNG is the cheap and faithful route: the bytes are
  // written unchanged, and no RGBA buffer has to exist at all.
  if let Some(bytes) = clipboard_png_bytes() {
    if let Some((width, height)) = png_dimensions(&bytes) {
      if acceptable_image(width, height) && bytes.len() <= MAX_CLIPBOARD_IMAGE_BYTES {
        return entry_of_png(&dir, &bytes, stem);
      }
    }
    let image = decode_image_bytes(&bytes)?;
    return entry_of_png(&dir, &png_of_image(image)?, stem);
  }
  let (width, height, rgba) = clipboard_image()?;
  let png = clipboard_png(width, height, rgba)?;
  entry_of_png(&dir, &png, stem)
}

/// Save a picture the WebView handed over with the paste event.
///
/// Ctrl+V carries the picture's bytes itself, so this path does not read the system clipboard
/// a second time: the bytes that were pasted are the bytes that land. Decoding is bounded by
/// the same pixel ceiling as the clipboard path, and the file is re-encoded as PNG so one
/// extension stands for the one format a Markdown link names.
pub fn save_pasted_image(
  dir: String,
  data: String,
  name: Option<String>,
) -> Result<FsEntry, String> {
  let dir = paste_dir(&dir)?;
  let stem = name.as_deref();
  use base64::Engine as _;
  let bytes = base64::engine::general_purpose::STANDARD
    .decode(data.trim())
    .map_err(|_| "clipboard_image_invalid".to_string())?;
  if bytes.is_empty() {
    return Err("clipboard_image_invalid".into());
  }
  if bytes.len() > MAX_CLIPBOARD_IMAGE_BYTES {
    return Err("clipboard_image_too_large".into());
  }
  // The common screenshot is already a PNG; write those bytes unchanged.
  if let Some((width, height)) = png_dimensions(&bytes) {
    if acceptable_image(width, height) {
      return entry_of_png(&dir, &bytes, stem);
    }
  }
  let image = decode_image_bytes(&bytes)?;
  let png = png_of_image(image)?;
  entry_of_png(&dir, &png, stem)
}

/// Paste a clipboard picture into a folder.
///
/// Separate from the file paste so the editor can ask for a picture without first reading
/// a file list; the Explorer goes through both, files first. `name` is the stem the dialog
/// collected; without one the timestamp and the numbered fallback choose it.
#[tauri::command(async, rename = "paste_clipboard_image")]
pub fn paste_clipboard_image_command(
  app: AppHandle,
  dir: String,
  name: Option<String>,
) -> Result<FsEntry, String> {
  crate::archive::refuse_if_cached(&app, &dir)?;
  paste_clipboard_image(dir, name)
}

/// Save bytes the WebView already has, for the Ctrl+V path that does not need the system
/// clipboard at all.
#[tauri::command(async, rename = "save_pasted_image")]
pub fn save_pasted_image_command(
  app: AppHandle,
  dir: String,
  data: String,
  name: Option<String>,
) -> Result<FsEntry, String> {
  crate::archive::refuse_if_cached(&app, &dir)?;
  save_pasted_image(dir, data, name)
}

/// The stem the paste dialog should start with, numbered so the first save cannot collide.
#[tauri::command(async, rename = "pasted_image_name")]
pub fn pasted_image_name_command(app: AppHandle, dir: String) -> Result<String, String> {
  crate::archive::refuse_if_cached(&app, &dir)?;
  let dir = paste_dir(&dir)?;
  Ok(free_image_stem(&dir))
}

/// What the clipboard offers a paste: a file list, a picture, or nothing.
///
/// Only the formats are inspected here; the picture itself is read after the reader has
/// confirmed the name, which is what keeps a large screenshot from being decoded first.
#[tauri::command(async)]
pub fn clipboard_paste_kind() -> Result<String, String> {
  if let Some(files) = clipboard_files()? {
    if !files.is_empty() {
      return Ok("files".into());
    }
  }
  Ok(
    if clipboard_has_image() {
      "image"
    } else {
      "empty"
    }
    .into(),
  )
}

/// Whether the clipboard advertises a picture this build can read.
///
/// Format availability rather than decoding: this only decides whether the name dialog is
/// worth opening, and a capture tool's picture can be several megabytes.
#[cfg(windows)]
fn clipboard_has_image() -> bool {
  let Ok(_guard) = clipboard_win::Clipboard::new_attempts(5) else {
    return false;
  };
  for name in ["PNG", "image/png"] {
    if let Some(format) = clipboard_win::raw::register_format(name) {
      if clipboard_win::raw::is_format_avail(format.get()) {
        return true;
      }
    }
  }
  clipboard_win::raw::is_format_avail(clipboard_win::formats::CF_DIBV5)
}

#[cfg(not(windows))]
fn clipboard_has_image() -> bool {
  arboard::Clipboard::new()
    .and_then(|mut clipboard| clipboard.get_image().map(|_| ()))
    .is_ok()
}

/// What a clipboard paste did: the copies it made, and how many sources it could not take.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardPaste {
  pub copied: Vec<FsEntry>,
  pub failed: usize,
}

/// Copy a set of sources into `target`, whichever gesture supplied them.
///
/// The copy itself is `copy_entry`, so the rules are the ones a paste inside the tree already
/// follows: never overwrite, number a name that is taken, refuse system folders, and never
/// copy a folder into itself. One source that cannot be taken does not stop the rest — the
/// count comes back so the caller can say what happened — but when nothing lands, the first
/// reason is the error, because that is the one worth showing.
fn copy_sources(sources: Vec<PathBuf>, target: String) -> Result<ClipboardPaste, String> {
  // Passed on to `copy_entry` as the folder to copy into, so it keeps the case the listing
  // showed rather than the lowercased identity key.
  let dir = draft::io_path(&target);
  if dir.is_empty() {
    return Err("path_empty".into());
  }
  if !Path::new(&dir).is_dir() {
    return Err("copy_no_target".into());
  }
  let mut copied: Vec<FsEntry> = Vec::new();
  let mut first_error: Option<String> = None;
  for source in &sources {
    match copy_entry(source.to_string_lossy().into_owned(), dir.clone()) {
      Ok(entry) => copied.push(entry),
      Err(e) => {
        first_error.get_or_insert(e);
      }
    }
  }
  if copied.is_empty() {
    return Err(first_error.unwrap_or_else(|| "copy_failed".into()));
  }
  Ok(ClipboardPaste {
    failed: sources.len() - copied.len(),
    copied,
  })
}

/// Copy every file the system clipboard lists into `target`.
#[tauri::command(async, rename = "paste_clipboard_files")]
pub fn paste_clipboard_files_command(
  app: AppHandle,
  target: String,
) -> Result<ClipboardPaste, String> {
  crate::archive::refuse_if_cached(&app, &target)?;
  paste_clipboard_files(target)
}

/// The paste itself, once the destination has been cleared to receive it.
///
/// A file list wins; a clipboard with no list but a picture becomes a PNG in the folder.
/// With neither, the clipboard is empty as far as a paste is concerned.
pub fn paste_clipboard_files(target: String) -> Result<ClipboardPaste, String> {
  if let Some(sources) = clipboard_files()? {
    if !sources.is_empty() {
      return copy_sources(sources, target);
    }
  }
  let entry = paste_clipboard_image(target, None)?;
  Ok(ClipboardPaste {
    copied: vec![entry],
    failed: 0,
  })
}

/// Copy the paths Windows Explorer dropped on the window into `target`.
///
/// A drop already carries absolute paths, so there is no clipboard to read — but the naming,
/// the refusals and the report are the very same ones a clipboard paste goes through.
#[tauri::command(async, rename = "copy_dropped_files")]
pub fn copy_dropped_files_command(
  app: AppHandle,
  paths: Vec<String>,
  target: String,
) -> Result<ClipboardPaste, String> {
  crate::archive::refuse_if_cached(&app, &target)?;
  copy_dropped_files(paths, target)
}

/// The copy itself, once the destination has been cleared to receive it.
pub fn copy_dropped_files(paths: Vec<String>, target: String) -> Result<ClipboardPaste, String> {
  if paths.is_empty() {
    return Err("clipboard_empty".into());
  }
  copy_sources(paths.into_iter().map(PathBuf::from).collect(), target)
}

/// The last segment of `path`, which for a numbered copy is the name it was given.
fn name_at(path: &Path) -> String {
  path
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .unwrap_or_default()
}

/// Park the text of a file that was deleted while it was open.
///
/// The file is gone, so the only place its text still exists is the editor's buffer, and a
/// quit or a closed tab would take that with it. This writes it out under the name it had,
/// in a folder this app owns, so the buffer becomes a file again: it can be edited and saved
/// like any other, and it is added to the recent-files list, which is what lets it be opened
/// again after the tab is gone.
///
/// Nothing is replaced here either: a second file kept under a name that is already parked
/// takes the next free spelling, the same way a paste does.
#[tauri::command(async)]
pub fn keep_file(
  app: AppHandle,
  path: String,
  content: String,
  encoding: Option<String>,
  bom: Option<bool>,
) -> Result<SavedFile, String> {
  let dir = draft::kept_dir(&app)?;
  let name = Path::new(&path)
    .file_name()
    .map(|n| n.to_string_lossy().to_string())
    .ok_or("keep_no_name")?;
  let target = free_name(&dir, &name)?;
  // The same encoding the file was read in, for the same reason a save uses it: a legacy
  // file kept as UTF-8 would be garbage to every other tool that opens it. It has to be
  // named, too — "auto" is a way to read a file, not a way to write one.
  let chosen = commands::write_encoding(encoding)?;
  let written = crate::encoding::encode(&content, &chosen, bom.unwrap_or(false))?;
  if written.len() as u64 > commands::MAX_FILE_BYTES {
    return Err(format!("file_too_large:{}", written.len() / (1024 * 1024)));
  }
  std::fs::write(&target, &written).map_err(|e| format!("file_write:{e}"))?;
  let mtime = std::fs::metadata(&target)
    .map(|m| commands::mtime_ms(&m))
    .unwrap_or(0);
  let path = draft::normalize_path(&target.to_string_lossy());
  // Being able to open it again is half the point, and the recent-files list is where a
  // file goes to be found once its tab is closed.
  commands::push_history_entry(&app, &path)?;
  Ok(SavedFile {
    path,
    // The parked copy's own name: `free_name` may have numbered it.
    name: name_at(&target),
    mtime,
    encoding: crate::encoding::resolve_for_write(&chosen)?
      .name()
      .to_string(),
    bytes: written.len() as u64,
  })
}

/// Delete a file, or a folder and everything in it.
///
/// Nothing is moved and nothing is copied, so this cannot be taken back from inside the app
/// and does not reach the Recycle Bin. That is the whole reason the frontend asks first.
#[tauri::command(async)]
pub fn remove_entry(app: AppHandle, path: String) -> Result<(), String> {
  crate::archive::refuse_if_cached(&app, &path)?;
  let target = draft::normalize_path(&path);
  if target.is_empty() {
    return Err("path_empty".into());
  }
  let entry = Path::new(&target);
  // Read as the entry itself: a link is what it is, not what it points at.
  let link = std::fs::symlink_metadata(entry).map_err(|e| format!("remove_not_found:{e}"))?;
  let follows = std::fs::metadata(entry).map_err(|e| format!("remove_not_found:{e}"))?;
  // The same line the asset scope and the rename draw: a drive root, the system directory
  // or the user's profile is not this app's to delete.
  if refused_by_scope(entry, &protected_roots()) {
    return Err("remove_refused".into());
  }
  if link.file_type().is_symlink() {
    // Removed as the link it is, never followed. On Windows a link to a folder has to go
    // through RemoveDirectory, which is what makes the two branches necessary.
    if follows.is_dir() {
      std::fs::remove_dir(entry).map_err(|e| format!("remove_failed:{e}"))?;
    } else {
      std::fs::remove_file(entry).map_err(|e| format!("remove_failed:{e}"))?;
    }
  } else if follows.is_dir() {
    std::fs::remove_dir_all(entry).map_err(|e| format!("remove_failed:{e}"))?;
  } else {
    std::fs::remove_file(entry).map_err(|e| format!("remove_failed:{e}"))?;
  }
  // The entry is gone by now and cannot be brought back, so a state file that refuses to be
  // written is not a failed delete: it would be reported as one, and the caller would keep a
  // row on screen for a file that is not there. What a stale record costs is a tab that is
  // skipped on the next start, which is the same thing that happens to a file deleted on the
  // command line while the app was closed.
  let _ = drop_state(&app, &target);
  Ok(())
}

/// Let go of what the store kept only because the entry was there.
///
/// The drafts and the per-file overrides stay: they hold unsaved work, and a path that
/// nothing points at any more is not a corrupt record — it is one this app simply does not
/// offer. Everything that would try to *open* the entry is dropped instead, because that
/// fails, and a session that restores a list of failures is worse than one that restores a
/// shorter list.
fn drop_state(app: &AppHandle, gone: &str) -> Result<(), String> {
  drop_group_state(app, gone)?;
  drop_history(app, gone)
}

/// The tabs a group keeps once `gone` is deleted, and the selection it is left pointing at.
/// Returns whether anything had to change, so an untouched store is not rewritten.
fn drop_tabs(tabs: &mut Vec<GroupTab>, active: &mut String, gone: &str) -> bool {
  let before = tabs.len();
  tabs.retain(|tab| tab.path.is_empty() || !under(&tab.path, gone));
  let selection_went = under(active, gone);
  if tabs.len() != before || selection_went {
    // A group whose selected tab was deleted has to land on something, or it opens with
    // nothing selected and the window looks empty.
    *active = tabs.last().map(|t| t.key()).unwrap_or_default();
    return true;
  }
  false
}

/// What each group keeps once `gone` is deleted: its tabs (minus any inside `gone`), the
/// selection it is left pointing at, and its Explorer folder.
///
/// The folder is lifted to the parent rather than cleared. The tree was showing something that
/// has just been deleted out from under it, and the parent is the one place certain to be
/// there; a root pointing at nothing is a dead sidebar. Groups showing a folder elsewhere are
/// left alone.
fn drop_group_state(app: &AppHandle, gone: &str) -> Result<(), String> {
  let Some(mut store) = commands::read_json::<GroupStore>(app, commands::GROUPS_FILE)? else {
    return Ok(());
  };
  let lifted = Path::new(gone)
    .parent()
    .map(|p| draft::normalize_path(&p.to_string_lossy()))
    .unwrap_or_default();
  let mut changed = false;
  for item in &mut store.items {
    let mut active = item.active.clone();
    if drop_tabs(&mut item.tabs, &mut active, gone) {
      item.active = active;
      changed = true;
    }
    if !item.root.is_empty() && under(&item.root, gone) {
      item.root = lifted.clone();
      changed = true;
    }
  }
  if changed {
    commands::write_json(app, commands::GROUPS_FILE, &store)?;
  }
  Ok(())
}

fn drop_history(app: &AppHandle, gone: &str) -> Result<(), String> {
  let Some(mut history) = commands::read_json::<Vec<HistoryEntry>>(app, "history.json")? else {
    return Ok(());
  };
  let before = history.len();
  history.retain(|item| !under(&draft::normalize_path(&item.path), gone));
  if history.len() != before {
    commands::write_json(app, "history.json", &history)?;
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn scratch(name: &str) -> String {
    let dir = std::env::temp_dir().join(format!("wrolp-entry-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("temp dir");
    draft::normalize_path(&dir.to_string_lossy())
  }

  fn tab(path: &str) -> GroupTab {
    GroupTab {
      path: path.to_string(),
      ..Default::default()
    }
  }

  #[test]
  fn a_bare_word_gets_a_text_extension_and_a_named_one_is_left_alone() {
    assert_eq!(entry_name("notes", DEFAULT_EXT), "notes.txt");
    assert_eq!(entry_name("notes.md", DEFAULT_EXT), "notes.md");
    assert_eq!(entry_name("archive.tar.gz", DEFAULT_EXT), "archive.tar.gz");
    // A dotfile is a whole name, not a stem missing its extension.
    assert_eq!(entry_name(".gitignore", DEFAULT_EXT), ".gitignore");
    assert_eq!(entry_name("v1.2", DEFAULT_EXT), "v1.2");
    // The extension is the caller's, so an encrypted entry can carry its own.
    assert_eq!(entry_name("notes", ENCRYPTED_EXT), "notes.wrolpenc");
    assert_eq!(entry_name("notes.md", ENCRYPTED_EXT), "notes.md");
  }

  #[test]
  fn the_extension_counts_towards_the_name_limit() {
    let edge = "n".repeat(crate::rename::MAX_NAME_LEN);
    // Room for the extension is what makes this createable, one character more is not.
    assert!(check_name(&entry_name(&edge[..edge.len() - 4], DEFAULT_EXT)).is_ok());
    assert!(check_name(&entry_name(&edge, DEFAULT_EXT)).is_err());
  }

  #[test]
  fn an_encrypted_entry_gets_the_container_extension() {
    let dir = scratch("enc-ext");
    let (resolved, named) = new_entry_path(&dir, "secret", ENCRYPTED_EXT).expect("resolved");
    assert_eq!(named, "secret.wrolpenc");
    assert!(resolved.to_string_lossy().ends_with("secret.wrolpenc"));
    // A name carrying its own extension keeps it: a container is recognised by its header, not
    // by its name, and renaming what the user typed would point them at a file they cannot find.
    let (_, named) = new_entry_path(&dir, "notes.md", ENCRYPTED_EXT).expect("resolved");
    assert_eq!(named, "notes.md");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_taken_name_is_refused_before_anything_is_written() {
    let dir = scratch("enc-taken");
    create_file(dir.clone(), "notes".into()).expect("created");
    assert_eq!(
      new_entry_path(&dir, "notes.txt", ENCRYPTED_EXT).expect_err("taken"),
      "create_exists"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_created_file_is_empty_and_takes_its_name_as_given() {
    let dir = scratch("file");
    let made = create_file(dir.clone(), "notes".into()).expect("created");
    assert_eq!(made.name, "notes.txt");
    assert!(!made.is_dir);
    assert_eq!(
      std::fs::read_to_string(&made.path).expect("read"),
      "",
      "a new file starts empty rather than holding the editor's idea of a template"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_created_entry_keeps_the_case_typed_on_disk() {
    let dir = scratch("case");
    create_file(dir.clone(), "Report.TXT".into()).expect("file");
    create_dir(dir.clone(), "MyFolder".into()).expect("folder");
    let mut names: Vec<String> = std::fs::read_dir(&dir)
      .expect("read")
      .flatten()
      .map(|item| item.file_name().to_string_lossy().into_owned())
      .collect();
    names.sort();
    assert!(
      names.iter().any(|n| n == "Report.TXT"),
      "the file must land on disk with the case the user typed, got {names:?}"
    );
    assert!(
      names.iter().any(|n| n == "MyFolder"),
      "the folder must land on disk with the case the user typed, got {names:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_pasted_copy_keeps_the_case_of_the_source_name() {
    let dir = scratch("copy-case");
    let root = std::path::PathBuf::from(&dir);
    let from = root.join("from");
    let to = root.join("to");
    std::fs::create_dir_all(&from).expect("source dir");
    std::fs::create_dir_all(&to).expect("target dir");
    let source = from.join("Report.TXT");
    std::fs::write(&source, b"x").expect("source file");

    let copied = copy_entry(
      source.to_string_lossy().into_owned(),
      to.to_string_lossy().into_owned(),
    )
    .expect("copy");

    assert_eq!(copied.name, "Report.TXT");
    // The listing, not the returned name: on Windows `to/report.txt` would still resolve, so
    // the only honest check is the spelling the directory holds.
    let names: Vec<String> = std::fs::read_dir(&to)
      .expect("read")
      .flatten()
      .map(|item| item.file_name().to_string_lossy().into_owned())
      .collect();
    assert!(
      names.iter().any(|n| n == "Report.TXT"),
      "the copy must keep the case of the source name, got {names:?}"
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_name_already_taken_is_refused_rather_than_overwritten() {
    let dir = scratch("exists");
    create_file(dir.clone(), "notes.md".into()).expect("first");
    // Even the name typed as it would be typed again, and even with the case spelled
    // differently: on Windows that is the same file.
    assert!(create_file(dir.clone(), "notes.md".into()).is_err());
    assert!(create_file(dir.clone(), "NOTES.MD".into()).is_err());
    assert!(create_dir(dir.clone(), "notes.md".into()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn nothing_is_created_inside_a_folder_that_is_not_there() {
    let dir = scratch("gone");
    let missing = format!("{dir}\\missing");
    assert!(create_file(missing.clone(), "notes".into()).is_err());
    assert!(create_dir(missing, "sub".into()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_name_that_could_reach_outside_its_folder_is_refused() {
    let dir = scratch("escape");
    for name in ["..", "../elsewhere", r"sub\file.txt", "a:b", ""] {
      assert!(
        create_file(dir.clone(), name.into()).is_err(),
        "{name} should be refused"
      );
    }
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_name_is_halved_so_a_numbered_copy_keeps_its_type() {
    assert_eq!(split_ext("notes.txt"), ("notes".to_string(), ".txt".into()));
    assert_eq!(split_ext("notes"), ("notes".to_string(), String::new()));
    assert_eq!(
      split_ext("archive.tar.gz"),
      ("archive.tar".to_string(), ".gz".into())
    );
    // A dotfile is its own stem, so numbering it does not turn it into ".gitignore.txt".
    assert_eq!(
      split_ext(".gitignore"),
      (".gitignore".to_string(), String::new())
    );
  }

  #[test]
  fn a_copy_beside_a_name_that_is_taken_is_numbered_not_overwritten() {
    let dir = scratch("number");
    create_file(dir.clone(), "notes.txt".into()).expect("first");
    let second = copy_entry(format!("{dir}\\notes.txt"), dir.clone()).expect("second");
    assert_eq!(second.name, "notes (2).txt");
    // The original is still the original: a paste that landed on a name wrote nothing.
    let third = copy_entry(format!("{dir}\\notes.txt"), dir.clone()).expect("third");
    assert_eq!(third.name, "notes (3).txt");
    let kept = std::fs::read_to_string(format!("{dir}\\notes.txt")).expect("read");
    assert_eq!(kept, "", "the file already there is untouched");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_folder_copies_whole_and_takes_a_numbered_name_of_its_own() {
    let dir = scratch("tree");
    create_dir(dir.clone(), "src".into()).expect("folder");
    create_file(format!("{dir}\\src"), "a.txt".into()).expect("file");
    create_dir(format!("{dir}\\src"), "deep".into()).expect("nested");
    create_file(format!("{dir}\\src\\deep"), "b.txt".into()).expect("nested file");

    let copy = copy_entry(format!("{dir}\\src"), dir.clone()).expect("copied");
    assert!(copy.is_dir);
    let root = PathBuf::from(&copy.path);
    assert!(root.join("a.txt").is_file(), "files come along");
    assert!(
      root.join("deep").join("b.txt").is_file(),
      "and whole folders do too"
    );
    // Two folders cannot share a name, so the second is numbered like a file would be.
    let again = copy_entry(format!("{dir}\\src"), dir.clone()).expect("copied again");
    assert_ne!(again.path, copy.path);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_folder_cannot_be_copied_into_itself() {
    let dir = scratch("self");
    create_dir(dir.clone(), "src".into()).expect("folder");
    create_dir(format!("{dir}\\src"), "inner".into()).expect("inner");
    // The walk would step into the copy it is making and never come back.
    assert!(copy_entry(format!("{dir}\\src"), format!("{dir}\\src\\inner")).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_paste_needs_a_folder_that_is_there() {
    let dir = scratch("target");
    create_file(dir.clone(), "notes.txt".into()).expect("file");
    assert!(copy_entry(format!("{dir}\\notes.txt"), format!("{dir}\\nope")).is_err());
    // And so does a copy of something that is not there at all.
    assert!(copy_entry(format!("{dir}\\missing.txt"), dir.clone()).is_err());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_clipboard_picture_is_shaped_before_it_is_used() {
    assert_eq!(clipboard_image_shape(2, 2, 16), Ok(()));
    assert_eq!(
      clipboard_image_shape(2, 2, 15),
      Err("clipboard_image_invalid".to_string())
    );
    assert_eq!(
      clipboard_image_shape(0, 2, 0),
      Err("clipboard_image_invalid".to_string())
    );
    assert_eq!(
      clipboard_image_shape(10_000, 10_000, 400_000_000),
      Err("clipboard_image_too_large".to_string())
    );
  }

  #[test]
  fn a_pasted_picture_lands_as_a_png_and_never_overwrites() {
    let dir = scratch("picture");
    let png = clipboard_png(
      2,
      2,
      vec![
        255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255,
      ],
    )
    .expect("encoded");
    let (first, name) =
      write_pasted_png(Path::new(&dir), "image-20261121-103045", &png).expect("first");
    assert_eq!(name, "image-20261121-103045.png");
    let decoded = image::open(&first).expect("decodes");
    assert_eq!((decoded.width(), decoded.height()), (2, 2));

    let (second, name) =
      write_pasted_png(Path::new(&dir), "image-20261121-103045", &png).expect("second");
    assert_eq!(name, "image-20261121-103045-2.png");
    assert_ne!(first, second);
    // The file already there is untouched: a paste never lands on a name somebody has.
    assert_eq!(std::fs::read(&first).expect("read"), png);
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_picture_needs_a_folder_it_may_write_to() {
    let dir = scratch("picture-target");
    create_file(dir.clone(), "notes.txt".into()).expect("file");
    assert_eq!(
      paste_dir(&format!("{dir}\\notes.txt")).err(),
      Some("copy_no_target".into())
    );
    assert_eq!(
      paste_dir(&format!("{dir}\\missing")).err(),
      Some("copy_no_target".into())
    );
    assert!(paste_dir(&dir).is_ok());
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_paste_event_picture_is_saved_without_the_clipboard() {
    use base64::Engine as _;
    let dir = scratch("pasted-bytes");
    let png = clipboard_png(1, 1, vec![0, 0, 0, 255]).expect("encoded");
    let data = base64::engine::general_purpose::STANDARD.encode(&png);
    let made = save_pasted_image(dir.clone(), data, None).expect("saved");
    assert!(made.name.starts_with("image-"));
    assert!(made.name.ends_with(".png"));
    assert_eq!(
      std::fs::read(&made.path).expect("read"),
      png,
      "an already-PNG paste is written unchanged rather than re-encoded"
    );
    let decoded = image::open(&made.path).expect("decodes");
    assert_eq!((decoded.width(), decoded.height()), (1, 1));
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_png_header_is_recognised_without_decoding() {
    let png = clipboard_png(3, 2, vec![0; 3 * 2 * 4]).expect("encoded");
    assert_eq!(png_dimensions(&png), Some((3, 2)));
    assert_eq!(png_dimensions(b"not a png"), None);
    assert_eq!(png_dimensions(&[0x89, b'P', b'N', b'G']), None);
    assert!(!acceptable_image(0, 2));
    assert!(acceptable_image(2377, 16761));
    assert!(!acceptable_image(10_000, 10_000));
  }

  #[test]
  fn a_paste_event_that_is_not_a_picture_is_refused() {
    use base64::Engine as _;
    let dir = scratch("pasted-bad");
    assert_eq!(
      save_pasted_image(dir.clone(), "not base64".into(), None).err(),
      Some("clipboard_image_invalid".into())
    );
    let text = base64::engine::general_purpose::STANDARD.encode(b"hello");
    assert_eq!(
      save_pasted_image(dir.clone(), text, None).err(),
      Some("clipboard_image_invalid".into())
    );
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_named_paste_uses_the_name_and_refuses_a_taken_one() {
    use base64::Engine as _;
    let dir = scratch("named-picture");
    let png = clipboard_png(1, 1, vec![0, 0, 0, 255]).expect("encoded");
    let data = || base64::engine::general_purpose::STANDARD.encode(&png);

    let first = save_pasted_image(dir.clone(), data(), Some("my shot".into())).expect("first");
    assert_eq!(first.name, "my shot.png");
    // A taken name is the reader's to fix in the dialog, not the backend's to number.
    assert_eq!(
      save_pasted_image(dir.clone(), data(), Some("my shot".into())).err(),
      Some("create_exists".into())
    );
    // A typed extension is folded into the one the dialog shows.
    let typed = save_pasted_image(dir.clone(), data(), Some("foto.PNG".into())).expect("typed");
    assert_eq!(typed.name, "foto.png");
    let _ = std::fs::remove_dir_all(&dir);
  }

  #[test]
  fn a_paste_name_follows_the_same_rules_as_a_renamed_file() {
    assert_eq!(explicit_image_stem(" my shot "), Ok("my shot".into()));
    assert_eq!(explicit_image_stem("shot.png"), Ok("shot".into()));
    assert_eq!(explicit_image_stem("shot.PNG"), Ok("shot".into()));
    assert_eq!(explicit_image_stem(""), Err("create_name_empty".into()));
    assert_eq!(explicit_image_stem(".png"), Err("create_name_empty".into()));
    assert_eq!(
      explicit_image_stem("a/b"),
      Err("create_name_invalid".into())
    );
    assert_eq!(
      explicit_image_stem("CON"),
      Err("create_name_invalid".into())
    );
  }

  #[test]
  fn the_default_paste_name_is_free() {
    let dir = scratch("default-name");
    let dir = Path::new(&dir);
    let stem = free_image_stem(dir);
    assert!(stem.starts_with("image-"));
    std::fs::write(dir.join(format!("{stem}.png")), b"x").expect("occupy the name");
    let next = free_image_stem(dir);
    assert_ne!(stem, next);
    assert!(!dir.join(format!("{next}.png")).exists());
    let _ = std::fs::remove_dir_all(dir);
  }

  /// A deleted folder takes its whole subtree with it, while a sibling sharing its prefix
  /// and any scratch tab stay exactly where they are.
  #[test]
  fn a_deleted_folder_takes_its_tabs_and_leaves_the_rest_alone() {
    let mut tabs = vec![
      tab(r"c:\notes\gone\a.txt"),
      tab(r"c:\notes\gone"),
      tab(r"c:\notes\goneful\b.txt"),
      tab(r"c:\notes\kept\c.txt"),
      GroupTab {
        untitled: "Untitled-1".into(),
        content: "scratch".into(),
        ..Default::default()
      },
    ];
    let mut active = r"c:\notes\gone\a.txt".into();
    assert!(drop_tabs(&mut tabs, &mut active, r"c:\notes\gone"));
    let paths: Vec<String> = tabs.iter().map(|t| t.path.clone()).collect();
    assert_eq!(
      paths,
      vec![r"c:\notes\goneful\b.txt", r"c:\notes\kept\c.txt", ""]
    );
    // The selection went with the tab it named, so it lands on what is left — the same
    // fallback a tab that was moved to another group gets.
    assert_eq!(active, "untitled://Untitled-1");
  }

  #[test]
  fn deleting_something_that_was_not_open_changes_nothing() {
    let mut tabs = vec![tab(r"c:\notes\a.txt")];
    let mut active = r"c:\notes\a.txt".into();
    assert!(!drop_tabs(&mut tabs, &mut active, r"c:\notes\other"));
    assert_eq!(active, r"c:\notes\a.txt");
  }

  #[test]
  fn the_last_tab_going_leaves_the_group_with_no_selection() {
    let mut tabs = vec![tab(r"c:\notes\a.txt")];
    let mut active = r"c:\notes\a.txt".into();
    assert!(drop_tabs(&mut tabs, &mut active, r"c:\notes\a.txt"));
    assert!(tabs.is_empty());
    assert_eq!(active, "");
  }
}
