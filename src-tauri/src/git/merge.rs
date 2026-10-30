//! Three-way line merge, for a conflict whose common base is available.
//!
//! Git leaves the markers in the working tree and the merge view asks the user about every
//! one of them. Most conflicts are not conflicts at all: the two sides touched different
//! parts of the file, and the only reason they disagree is that neither was applied. This
//! merges them against the base first, so the view opens with those regions already settled
//! and the user only sees the ones that genuinely need a decision.
//!
//! The result keeps git's marker spelling (`<<<<<<<`, `=======`, `>>>>>>>` at the start of a
//! line), so the existing parser reads it unchanged — this replaces *which* text the view
//! opens with, not how the view works.

/// A file longer than this is left alone: aligning two sides costs `lines²` cells, and a
/// conflict on a fifty-thousand-line file is rare enough that falling back to git's own
/// markers is the better trade than a pause on every click.
pub(crate) const MAX_MERGE_LINES: usize = 4000;

/// One changed region: base lines `[start, end)` are replaced by `lines`.
struct Block {
  start: usize,
  end: usize,
  lines: Vec<String>,
}

/// Split text into LF-terminated-free lines. The caller has already normalised the endings,
/// and restoring the file's own breaks is the writer's job, exactly as it is for the parser.
fn lines_of(text: &str) -> Vec<String> {
  text.split('\n').map(|line| line.to_string()).collect()
}

/// A longest common subsequence of two line sequences, as `(a, b)` index pairs in order.
///
/// The table is quadratic in the number of lines, which is why `MAX_MERGE_LINES` exists: the
/// answer is computed once per open, on the UI thread of a desktop app, and must not be able
/// to hang it on a pathological file.
fn lcs_pairs(a: &[&str], b: &[&str]) -> Vec<(usize, usize)> {
  let n = a.len();
  let m = b.len();
  // `dp[i][j]` is the LCS length of `a[i..]` and `b[j..]`, filled from the far corner back.
  let mut dp = vec![vec![0u32; m + 1]; n + 1];
  for i in (0..n).rev() {
    for j in (0..m).rev() {
      dp[i][j] = if a[i] == b[j] {
        dp[i + 1][j + 1] + 1
      } else {
        dp[i + 1][j].max(dp[i][j + 1])
      };
    }
  }
  let mut out = Vec::new();
  let (mut i, mut j) = (0, 0);
  while i < n && j < m {
    if a[i] == b[j] {
      out.push((i, j));
      i += 1;
      j += 1;
    } else if dp[i + 1][j] >= dp[i][j + 1] {
      i += 1;
    } else {
      j += 1;
    }
  }
  out
}

/// The regions of `base` that `other` replaced, in base order.
fn blocks_of(base: &[String], other: &[String]) -> Vec<Block> {
  let a: Vec<&str> = base.iter().map(|line| line.as_str()).collect();
  let b: Vec<&str> = other.iter().map(|line| line.as_str()).collect();
  let pairs = lcs_pairs(&a, &b);
  let mut out = Vec::new();
  let (mut bi, mut oi) = (0, 0);
  for (ai, bj) in pairs {
    // Everything between the previous match and this one is one replacement: base lines
    // `bi..ai` become `other` lines `oi..bj`.
    if ai > bi || bj > oi {
      out.push(Block {
        start: bi,
        end: ai,
        lines: other[oi..bj].to_vec(),
      });
    }
    bi = ai + 1;
    oi = bj + 1;
  }
  // A tail that never matched: one last replacement, which may be a pure append.
  if bi < base.len() || oi < other.len() {
    out.push(Block {
      start: bi,
      end: base.len(),
      lines: other[oi..].to_vec(),
    });
  }
  out
}

/// The text one side put in place of base lines `[start, end)`, given every block from that
/// side that falls inside that span. Gaps between the blocks keep the base lines, which is
/// what makes a region that only one side touched come out whole.
fn apply_group(base: &[String], group: &[&Block]) -> Vec<String> {
  let mut out = Vec::new();
  let mut pos = group[0].start;
  for block in group {
    out.extend_from_slice(&base[pos..block.start]);
    out.extend_from_slice(&block.lines);
    pos = block.end;
  }
  out
}

/// Merge `ours` and `theirs` against `base`.
///
/// `Some((text, settled))` is the merged text and how many regions were decided without
/// asking; regions that both sides changed differently are left as git markers. `None` means
/// the file is too long to align, and the caller should keep what git wrote.
pub fn merge3(base: &str, ours: &str, theirs: &str) -> Option<(String, usize)> {
  let base_lines = lines_of(base);
  let ours_lines = lines_of(ours);
  let theirs_lines = lines_of(theirs);
  if base_lines.len() > MAX_MERGE_LINES
    || ours_lines.len() > MAX_MERGE_LINES
    || theirs_lines.len() > MAX_MERGE_LINES
  {
    return None;
  }

  let our_blocks = blocks_of(&base_lines, &ours_lines);
  let their_blocks = blocks_of(&base_lines, &theirs_lines);
  let mut out: Vec<String> = Vec::new();
  let mut settled = 0usize;
  let (mut oi, mut ti) = (0usize, 0usize);
  let mut pos = 0usize;

  while oi < our_blocks.len() || ti < their_blocks.len() {
    // The next region starts where the earliest remaining block does.
    let start = match (our_blocks.get(oi), their_blocks.get(ti)) {
      (Some(o), Some(t)) => o.start.min(t.start),
      (Some(o), None) => o.start,
      (None, Some(t)) => t.start,
      (None, None) => break,
    };
    out.extend_from_slice(&base_lines[pos..start]);

    // Everything that touches this region joins it, from either side: overlapping changes
    // cannot be decided independently, so they are one unit to apply or to report.
    let mut end = start;
    let mut ours_here: Vec<&Block> = Vec::new();
    let mut theirs_here: Vec<&Block> = Vec::new();
    loop {
      let mut grew = false;
      while oi < our_blocks.len() && our_blocks[oi].start <= end {
        end = end.max(our_blocks[oi].end);
        ours_here.push(&our_blocks[oi]);
        oi += 1;
        grew = true;
      }
      while ti < their_blocks.len() && their_blocks[ti].start <= end {
        end = end.max(their_blocks[ti].end);
        theirs_here.push(&their_blocks[ti]);
        ti += 1;
        grew = true;
      }
      if !grew {
        break;
      }
    }

    if theirs_here.is_empty() {
      // Only one side touched this region, so applying it is not a decision to ask about.
      out.extend(apply_group(&base_lines, &ours_here));
      settled += 1;
    } else if ours_here.is_empty() {
      out.extend(apply_group(&base_lines, &theirs_here));
      settled += 1;
    } else {
      let mine = apply_group(&base_lines, &ours_here);
      let theirs = apply_group(&base_lines, &theirs_here);
      if mine == theirs {
        // Both sides made the same change: applying it once is not a decision to ask about.
        out.extend(mine);
        settled += 1;
      } else {
        out.push("<<<<<<< ours".to_string());
        out.extend(mine);
        out.push("=======".to_string());
        out.extend(theirs);
        out.push(">>>>>>> theirs".to_string());
      }
    }
    pos = end;
  }
  out.extend_from_slice(&base_lines[pos..]);
  Some((out.join("\n"), settled))
}

#[cfg(test)]
mod tests {
  use super::merge3;

  fn merged(base: &str, ours: &str, theirs: &str) -> (String, usize) {
    merge3(base, ours, theirs).expect("a small file must be mergeable")
  }

  #[test]
  fn a_change_on_one_side_is_applied_alone() {
    let (text, settled) = merged("a\nb\nc\n", "a\nB\nc\n", "a\nb\nc\n");
    assert_eq!(text, "a\nB\nc\n");
    assert_eq!(settled, 1);
  }

  #[test]
  fn changes_to_different_regions_both_land() {
    let (text, settled) = merged("a\nb\nc\nd\n", "A\nb\nc\nd\n", "a\nb\nc\nD\n");
    assert_eq!(text, "A\nb\nc\nD\n");
    assert_eq!(settled, 2);
  }

  #[test]
  fn the_same_change_on_both_sides_is_not_a_conflict() {
    let (text, settled) = merged("a\nb\nc\n", "a\nX\nc\n", "a\nX\nc\n");
    assert_eq!(text, "a\nX\nc\n");
    assert_eq!(settled, 1);
  }

  #[test]
  fn different_changes_to_one_line_become_markers() {
    let (text, _) = merged("a\nb\nc\n", "a\nMINE\nc\n", "a\nTHEIRS\nc\n");
    assert_eq!(
      text,
      "a\n<<<<<<< ours\nMINE\n=======\nTHEIRS\n>>>>>>> theirs\nc\n"
    );
  }

  #[test]
  fn a_delete_against_a_modify_is_a_conflict() {
    // One side removed the line, the other rewrote it: neither answer contains the other.
    let (text, _) = merged("a\nb\nc\n", "a\nc\n", "a\nB\nc\n");
    assert!(text.contains("<<<<<<< ours"), "got {text}");
    assert!(text.contains("======="), "got {text}");
  }

  #[test]
  fn the_same_delete_on_both_sides_is_applied_once() {
    let (text, settled) = merged("a\nb\nc\n", "a\nc\n", "a\nc\n");
    assert_eq!(text, "a\nc\n");
    assert_eq!(settled, 1);
  }

  #[test]
  fn an_append_and_an_edit_elsewhere_both_land() {
    let (text, settled) = merged("a\nb\n", "A\nb\n", "a\nb\nnew\n");
    assert_eq!(text, "A\nb\nnew\n");
    assert_eq!(settled, 2);
  }

  #[test]
  fn a_conflict_between_two_regions_keeps_the_clean_ones_around_it() {
    let (text, settled) = merged(
      "1\n2\n3\n4\n5\n",
      "ONE\n2\n3\n4\n5\n",
      "1\n2\nX\n4\n5\n",
    );
    // The first line is only ours, the third only theirs: both land, nothing to ask.
    assert_eq!(text, "ONE\n2\nX\n4\n5\n");
    assert_eq!(settled, 2);
  }

  #[test]
  fn a_file_too_long_to_align_is_left_to_git() {
    let long = "x\n".repeat(5000);
    assert!(merge3(&long, &long, &long).is_none());
  }
}
