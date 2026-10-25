//! The order names are read in: runs of digits compare by value, everything else
//! case-insensitively by character.
//!
//! `IMG_2` therefore comes before `IMG_10`, which a plain string sort gets backwards. The
//! Explorer and the gallery both use this, so switching views never reshuffles a folder.

use std::cmp::Ordering;

pub(crate) fn natural_cmp(left: &str, right: &str) -> Ordering {
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
    // The whole name counts, extension included: the two would tie on the stem alone.
    assert_eq!(natural_cmp("a2.txt", "a10.txt"), Ordering::Less);
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
