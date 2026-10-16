/**
 * Which lines of a buffer differ from the text it was saved as.
 *
 * The workbench draws unsaved changes in the gutter; the standalone editor does not, and the
 * library keeps its diff computer behind the diff widget instead of in public API. So the
 * comparison lives here, in two steps that keep the cost honest: trim the ends that still match,
 * then spend a table only on what is left between them.
 *
 * The buffer is read line by line through `lineAt` rather than copied whole: the saved text is
 * split once when the file is saved, while the buffer is only asked for the lines the trim needs,
 * so typing in a large file costs a walk rather than a second copy of it.
 */

/** One run of changed lines, in buffer line numbers, first line is 1. */
export interface DirtyRange {
  from: number;
  to: number;
  /** Text with nothing saved behind it, as opposed to text that replaced some. */
  added: boolean;
}

/**
 * The most lines an exact comparison is worth on either side of the trimmed block. Past it the
 * block is reported as one run: an edit at either end of a 20 000-line file must not cost a
 * 20 000 × 20 000 table, and a highlighted stretch still says where to look.
 */
const EXACT_LIMIT = 256;

/**
 * The changed runs between the saved lines and the buffer, compared line by line. Equal means
 * exactly equal: the trailing space somebody deleted is a change, and that is worth seeing
 * before a save rather than discovering after one.
 */
export function dirtyRanges(
  saved: string[],
  lineCount: number,
  lineAt: (index: number) => string
): DirtyRange[] {
  let head = 0;
  while (head < saved.length && head < lineCount && saved[head] === lineAt(head)) head++;
  let savedEnd = saved.length;
  let currentEnd = lineCount;
  while (
    savedEnd > head &&
    currentEnd > head &&
    saved[savedEnd - 1] === lineAt(currentEnd - 1)
  ) {
    savedEnd--;
    currentEnd--;
  }
  if (savedEnd === head && currentEnd === head) return [];

  const rows = savedEnd - head;
  const cols = currentEnd - head;
  if (rows > EXACT_LIMIT || cols > EXACT_LIMIT) {
    // Too wide to line up. Called a replacement unless the saved side was empty there, in which
    // case the buffer really did grow.
    return [{ from: head + 1, to: currentEnd, added: rows === 0 }];
  }

  const before: string[] = saved.slice(head, savedEnd);
  const after: string[] = [];
  for (let j = head; j < currentEnd; j++) after.push(lineAt(j));
  return changedRuns(head, before, after);
}

/**
 * Walk the longest common subsequence of the two blocks and group the buffer lines that fall out
 * of it.
 *
 * A saved line with no counterpart marks what follows as a replacement — the difference between a
 * new paragraph and a rewritten one. A deletion on its own produces nothing to highlight, because
 * the buffer has no line left to tint.
 */
function changedRuns(head: number, before: string[], after: string[]): DirtyRange[] {
  const rows = before.length;
  const cols = after.length;
  // `table[i * (cols + 1) + j]` is the length of the common subsequence of `before[i..]` and
  // `after[j..]`. Flat, because at this size an array of arrays is mostly pointer chasing.
  const table = new Int32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i * (cols + 1) + j] =
        before[i] === after[j]
          ? table[(i + 1) * (cols + 1) + j + 1] + 1
          : Math.max(table[(i + 1) * (cols + 1) + j], table[i * (cols + 1) + j + 1]);
    }
  }

  const runs: DirtyRange[] = [];
  let i = 0;
  let j = 0;
  let start = -1;
  let replaced = false;
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      if (start >= 0) {
        runs.push({ from: head + start + 1, to: head + j, added: !replaced });
        start = -1;
        replaced = false;
      }
      i++;
      j++;
    } else if (table[(i + 1) * (cols + 1) + j] >= table[i * (cols + 1) + j + 1]) {
      replaced = true;
      i++;
    } else {
      if (start < 0) start = j;
      j++;
    }
  }
  // Anything left in the buffer after the alignment ran out is changed text: either it follows a
  // removal, or the saved block simply ended first.
  if (start < 0 && j < cols) start = j;
  if (start >= 0) runs.push({ from: head + start + 1, to: head + cols, added: !replaced });
  return runs;
}
