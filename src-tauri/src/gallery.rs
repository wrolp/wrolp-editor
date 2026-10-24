//! The image listing behind the gallery tab.
//!
//! Separate from `list_dir` on purpose: that one interleaves folders and files for the
//! Explorer and sorts names as text, which puts `IMG_10` before `IMG_2`. A gallery is a
//! sequence of pictures, so it lists files only, in natural order, and it may walk into
//! subfolders.

use serde::Serialize;
use std::cmp::Ordering;
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

/// A directory listing with the names in the order a person reads them: runs of digits
/// compare by value, everything else case-insensitively by character.
///
/// `IMG_2` therefore comes before `IMG_10`, which a plain string sort gets backwards. The
/// comparison is also the only ordering the gallery uses, so switching views never reshuffles
/// the sequence.
pub(crate) fn natural_key_cmp(left: &str, right: &str) -> Ordering {
  let a: Vec<char> = left.to_lowercase().chars().collect();
  let b: Vec<char> = right.to_lowercase().chars().collect();
  let (mut i, mut j) = (0, 0);
  while i < a.len() && j < b.len() {
    if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
      let (a_start, b_start) = (i, j);
      while i < a.len() && a[i].is_ascii_digit() {
        i += 1;
      }
      while j < b.len() && b[j].is_ascii_digit() {
        j += 1;
      }
      let a_run = &a[a_start..i];
      let b_run = &b[b_start..j];
      let a_num = trim_leading_zeros(a_run);
      let b_num = trim_leading_zeros(b_run);
      // Length first, then lexicographic: this compares arbitrarily long numbers without
      // parsing them, and a run of 30 digits is still ordered correctly.
      let ord = a_num.len().cmp(&b_num.len()).then_with(|| a_num.cmp(b_num));
      if ord != Ordering::Equal {
        return ord;
      }
      // Same value (`02` and `2`): fewer leading zeros first, so the spelling is stable.
      let ord = a_run.len().cmp(&b_run.len());
      if ord != Ordering::Equal {
        return ord;
      }
    } else {
      let ord = a[i].cmp(&b[j]);
      if ord != Ordering::Equal {
        return ord;
      }
      i += 1;
      j += 1;
    }
  }
  a.len().cmp(&b.len())
}

fn trim_leading_zeros(run: &[char]) -> &[char] {
  let first = run.iter().position(|c| *c != '0').unwrap_or(run.len());
  if first == run.len() {
    // All zeros: keep one so the number is not a zero-length slice.
    &run[run.len().saturating_sub(1)..]
  } else {
    &run[first..]
  }
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
  items.sort_by(|a, b| natural_key_cmp(&a.name, &b.name).then_with(|| a.path.cmp(&b.path)));
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
  fn digits_compare_by_value() {
    assert_eq!(natural_key_cmp("IMG_2.png", "IMG_10.png"), Ordering::Less);
    assert_eq!(
      natural_key_cmp("img_10.png", "IMG_9.png"),
      Ordering::Greater
    );
    assert_eq!(natural_key_cmp("2.jpg", "02.jpg"), Ordering::Less);
    assert_eq!(natural_key_cmp("02.jpg", "2.jpg"), Ordering::Greater);
  }

  #[test]
  fn text_compares_without_case() {
    assert_eq!(natural_key_cmp("a.png", "A.png"), Ordering::Equal);
    assert_eq!(natural_key_cmp("cat.png", "Dog.png"), Ordering::Less);
  }

  #[test]
  fn a_name_without_digits_still_orders() {
    assert_eq!(natural_key_cmp("z.png", "aa.png"), Ordering::Greater);
    assert_eq!(natural_key_cmp("a.png", "a.png"), Ordering::Equal);
    assert_eq!(natural_key_cmp("a.png", "a"), Ordering::Greater);
  }

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
