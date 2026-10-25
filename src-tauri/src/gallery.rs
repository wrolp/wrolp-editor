//! The image listing behind the gallery tab.
//!
//! Separate from `list_dir` on purpose: that one interleaves folders and files for the
//! Explorer, while a gallery is a sequence of pictures, so it lists files only and may walk
//! into subfolders. Both put names in the same natural order, so switching views never
//! reshuffles a folder.

use crate::name_order::natural_cmp;
use serde::Serialize;
use std::path::Path;

/// Enough pictures for any album a person scrolls through, and the first guard against a
/// recursive walk that reaches a photo library's tens of thousands of files.
const MAX_GALLERY_IMAGES: usize = 2000;
/// Deep enough to catch `photos/2026/10/24` without turning `\\server\share` into a long walk.
const MAX_GALLERY_DEPTH: usize = 4;
/// Same folders the Explorer's own listing skips: none of them are albums, and walking
/// `node_modules` can surface thousands of placeholder images.
const IGNORED: [&str; 4] = ["node_modules", "target", "dist", ".git"];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageList {
  /// Pictures in natural order, at most `MAX_GALLERY_IMAGES` of them.
  pub items: Vec<ImageEntry>,
  /// The folder held more pictures than the cap. Said out loud in the UI instead of
  /// silently showing a prefix.
  pub truncated: bool,
  /// Directory entries looked at while producing `items`, so a truncated list can explain
  /// itself without reading the disk again.
  pub scanned: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageEntry {
  pub name: String,
  /// Absolute path, normalized by the backend the same way `list_dir` does.
  pub path: String,
  pub bytes: u64,
}

/// Pictures a gallery can list. Raster types come from the editor's own table, so the
/// gallery and "this file is binary" cannot drift apart; `svg` is added because it draws
/// through an `<img>` even though the editor also treats it as text.
fn has_image_ext(name: &str) -> bool {
  match name.rsplit_once('.') {
    Some((_, ext)) => {
      let ext = ext.to_ascii_lowercase();
      ext == "svg" || crate::commands::BINARY_EXT.contains(&ext.as_str())
    }
    None => false,
  }
}

fn is_ignored(name: &str) -> bool {
  IGNORED.iter().any(|i| name.eq_ignore_ascii_case(i))
}

/// Walk one folder, appending pictures. The root is the only folder whose read failure is
/// reported: an unreadable subfolder inside a network share is skipped rather than failing
/// an album the user can otherwise see.
fn scan(
  dir: &Path,
  depth: usize,
  recursive: bool,
  out: &mut Vec<ImageEntry>,
  scanned: &mut usize,
) -> Result<(), String> {
  let read = std::fs::read_dir(dir).map_err(|e| format!("dir_read:{e}"))?;
  for item in read.flatten() {
    *scanned += 1;
    let name = item.file_name().to_string_lossy().to_string();
    let path = item.path();
    let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
    if is_dir {
      if recursive && depth < MAX_GALLERY_DEPTH && !is_ignored(&name) {
        let _ = scan(&path, depth + 1, true, out, scanned);
      }
      continue;
    }
    if !has_image_ext(&name) {
      continue;
    }
    let bytes = item.metadata().map(|m| m.len()).unwrap_or(0);
    out.push(ImageEntry {
      name,
      path: path.to_string_lossy().to_string(),
      bytes,
    });
  }
  Ok(())
}

/// List the pictures in `dir`, naturally ordered.
///
/// Metadata only: the gallery addresses pictures through the asset protocol, so the editor's
/// text-size ceiling (`MAX_FILE_BYTES`) does not apply and a 25 MB TIFF is listed like any
/// other picture. Whether this renderer can draw it is a separate question.
#[tauri::command(async)]
pub fn list_images(dir: String, recursive: bool) -> Result<ImageList, String> {
  let normalized = crate::draft::normalize_path(&dir);
  let root = Path::new(&normalized);
  if !root.is_dir() {
    return Err("not_a_directory".into());
  }
  let mut items: Vec<ImageEntry> = Vec::new();
  let mut scanned = 0usize;
  scan(root, 0, recursive, &mut items, &mut scanned)?;
  items.sort_by(|a, b| natural_cmp(&a.name, &b.name).then_with(|| a.path.cmp(&b.path)));
  let truncated = items.len() > MAX_GALLERY_IMAGES;
  items.truncate(MAX_GALLERY_IMAGES);
  Ok(ImageList {
    items,
    truncated,
    scanned,
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn pictures_include_raster_types_and_svg() {
    for name in ["a.png", "a.JPEG", "a.webp", "a.tiff", "a.svg", "a.SVG"] {
      assert!(has_image_ext(name), "{name} should be listed");
    }
    for name in ["a.md", "a.txt", "no-extension", ".gitignore"] {
      assert!(!has_image_ext(name), "{name} should not be listed");
    }
  }

  #[test]
  fn a_missing_folder_is_reported() {
    let missing = std::env::temp_dir().join(format!(
      "wrolp-gallery-missing-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ));
    assert_eq!(
      list_images(missing.to_string_lossy().to_string(), false).err(),
      Some("not_a_directory".into())
    );
  }

  fn temp_album(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
      "wrolp-gallery-{name}-{}-{}",
      std::process::id(),
      std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("album dir");
    dir
  }

  fn touch(dir: &Path, name: &str) -> std::path::PathBuf {
    let path = dir.join(name);
    std::fs::write(&path, b"x").expect("file");
    path
  }

  #[test]
  fn a_listing_is_naturally_ordered_and_skips_ignored_folders() {
    let dir = temp_album("order");
    touch(&dir, "IMG_10.png");
    touch(&dir, "IMG_2.png");
    touch(&dir, "notes.md");
    let sub = dir.join("sub");
    std::fs::create_dir_all(&sub).unwrap();
    touch(&sub, "IMG_1.svg");
    let ignored = dir.join("node_modules");
    std::fs::create_dir_all(&ignored).unwrap();
    touch(&ignored, "placeholder.png");

    let flat = list_images(dir.to_string_lossy().to_string(), false).unwrap();
    assert_eq!(
      flat
        .items
        .iter()
        .map(|i| i.name.as_str())
        .collect::<Vec<_>>(),
      vec!["IMG_2.png", "IMG_10.png"]
    );
    assert_eq!(flat.scanned, 5, "two pictures, one document, two folders");
    assert!(!flat.truncated);

    let deep = list_images(dir.to_string_lossy().to_string(), true).unwrap();
    assert_eq!(
      deep
        .items
        .iter()
        .map(|i| i.name.as_str())
        .collect::<Vec<_>>(),
      vec!["IMG_1.svg", "IMG_2.png", "IMG_10.png"]
    );
    assert!(
      deep.scanned >= 6,
      "the walk should also have looked inside sub"
    );
    assert!(
      !deep.items.iter().any(|i| i.name == "placeholder.png"),
      "node_modules must not be walked"
    );

    std::fs::remove_dir_all(&dir).ok();
  }
}
