//! The order names are read in: runs of digits compare by value, everything else
//! case-insensitively by character — and the stem comes before the extension.
//!
//! `IMG_2` therefore comes before `IMG_10`, which a plain string sort gets backwards. The
//! Explorer and the gallery both use this, so switching views never reshuffles a folder.

use std::cmp::Ordering;

/// Compare two names the way the Explorer and the gallery read them.
///
/// Stems first, extensions only as a tie-break. Comparing the whole name puts the dot of one
/// against whatever follows the other's stem: `文档.md` against `文档-1.md` differs at `.`
/// versus `-`, and `.` is the larger character, so the longer name led. A name that stops
/// where the other continues has to sort first instead; two files whose stems match still
/// have an order, and their extensions give it.
pub(crate) fn natural_cmp(left: &str, right: &str) -> Ordering {
  let (left_stem, left_ext) = split_name(left);
  let (right_stem, right_ext) = split_name(right);
  compare_text(left_stem, right_stem).then_with(|| compare_text(left_ext, right_ext))
}

/// The name without its extension, and the extension without the dot.
///
/// A dot at the first character belongs to the name rather than starting an extension
/// (`.gitignore`), and a folder arrives from `list_dir` with a trailing `/` that is not one
/// either.
fn split_name(name: &str) -> (&str, &str) {
  let trimmed = name.strip_suffix('/').unwrap_or(name);
  match trimmed.rfind('.') {
    None | Some(0) => (trimmed, ""),
    Some(dot) => (&trimmed[..dot], &trimmed[dot + 1..]),
  }
}

fn compare_text(left: &str, right: &str) -> Ordering {
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

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn digits_compare_by_value() {
    assert_eq!(natural_cmp("IMG_2.png", "IMG_10.png"), Ordering::Less);
    assert_eq!(natural_cmp("img_10.png", "IMG_9.png"), Ordering::Greater);
    assert_eq!(natural_cmp("2.jpg", "02.jpg"), Ordering::Less);
    assert_eq!(natural_cmp("02.jpg", "2.jpg"), Ordering::Greater);
    // The run sits in the stem, which is what is compared first.
    assert_eq!(natural_cmp("a2.txt", "a10.txt"), Ordering::Less);
  }

  #[test]
  fn a_name_that_stops_where_the_other_continues_sorts_first() {
    // The whole-name comparison put the dot against the `-` and `.` is the larger character,
    // so the longer name led. `文档.md` is the name, `文档-1.md` is that name plus a suffix.
    assert_eq!(natural_cmp("文档.md", "文档-1.md"), Ordering::Less);
    assert_eq!(natural_cmp("文档-1.md", "文档.md"), Ordering::Greater);
    assert_eq!(natural_cmp("a.md", "a-1.md"), Ordering::Less);
    assert_eq!(natural_cmp("notes.md", "notes (2).md"), Ordering::Less);
    assert_eq!(natural_cmp("a.b.md", "a.b-1.md"), Ordering::Less);
  }

  #[test]
  fn matching_stems_are_ordered_by_extension() {
    assert_eq!(natural_cmp("a.md", "a.txt"), Ordering::Less);
    assert_eq!(natural_cmp("a.txt", "a.md"), Ordering::Greater);
    // No extension sorts before any, so `a` stays next to `a.md` where a reader looks for it.
    assert_eq!(natural_cmp("a", "a.md"), Ordering::Less);
  }

  #[test]
  fn a_leading_dot_and_a_folder_slash_are_not_extensions() {
    assert_eq!(natural_cmp(".gitignore", "a.md"), Ordering::Less);
    assert_eq!(natural_cmp("docs/", "docs-old/"), Ordering::Less);
  }

  #[test]
  fn text_compares_without_case() {
    assert_eq!(natural_cmp("a.png", "A.png"), Ordering::Equal);
    assert_eq!(natural_cmp("cat.png", "Dog.png"), Ordering::Less);
  }

  #[test]
  fn a_name_without_digits_still_orders() {
    assert_eq!(natural_cmp("z.png", "aa.png"), Ordering::Greater);
    assert_eq!(natural_cmp("a.png", "a.png"), Ordering::Equal);
    assert_eq!(natural_cmp("a.png", "a"), Ordering::Greater);
  }
}
