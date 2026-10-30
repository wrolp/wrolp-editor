/**
 * The folded view of a comparison: the changed runs, their surroundings, and nothing else.
 *
 * Monaco's diff editor has no "collapse unchanged regions" in the version this app bundles, and the
 * alternative — writing a second, unified diff renderer — would mean a diff algorithm of our own
 * next to the one already running in the editor, two answers where one is asked for. So this takes
 * the ranges the diff editor already computed, slices both sides down to the hunks those ranges
 * cover plus a few lines of context, and hands the two truncated texts back to the same editor.
 * The unchanged stretches are simply not in the models, which is what makes them not on screen.
 *
 * Nothing here is aware of the editor: line numbers in, strings out, so the pairing logic can be
 * read and checked on its own.
 */

/**
 * One change as Monaco reports it, in 1-based line numbers.
 *
 * The odd-looking convention is Monaco's: when a change adds lines without removing any, the
 * removed side is `start = <the line it was inserted after>, end = 0`, and the same shape holds for
 * a deletion on the added side. So `end < start` means "nothing here changed", and `start` still
 * says where the insertion or deletion sits — which is what lets a pure insertion keep its context.
 */
export interface FoldChange {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

export interface FoldedPair {
  /** The left side, cut down to its hunks. */
  left: string;
  /** The right side, cut to the hunks paired with the left's. */
  right: string;
  /** Lines dropped from each side, said out loud because a fold that hides its own size is a lie. */
  hiddenLeft: number;
  hiddenRight: number;
  /** How many separate runs survived. */
  hunks: number;
  /** Whether the fold dropped anything at all. */
  folded: boolean;
  /**
   * The original line number behind each line of `left`, in the same order.
   *
   * A folded model is a different document, so its own line numbers start at 1 in every hunk
   * and say nothing about where the text came from. The caller hands these back to the editor
   * so the gutter keeps naming the lines of the file the user actually has.
   */
  leftNumbers: number[];
  /** The same for `right`. */
  rightNumbers: number[];
}

/** Lines kept on each side of a change. Three is what `git diff` shows and what a reader scans. */
export const FOLD_CONTEXT = 3;

interface Window {
  from: number;
  to: number;
}

/** The lines one change covers on one side, widened by the context. */
function windowOf(start: number, end: number, lineCount: number, context: number): Window | null {
  if (lineCount === 0) return null;
  // `end < start` is the empty case: an insertion (or deletion) anchored after line `start`.
  const first = end >= start ? start : start + 1;
  const last = end >= start ? end : start;
  if (last < 1 && first > lineCount) return null;
  const from = Math.max(1, first - context);
  const to = Math.min(lineCount, Math.max(from - 1, last) + context);
  return { from, to };
}

/** The same change's window on the other side of the comparison. */
function sideOf(change: FoldChange, side: "original" | "modified"): Window | undefined {
  return side === "original"
    ? { from: change.originalStartLineNumber, to: change.originalEndLineNumber }
    : { from: change.modifiedStartLineNumber, to: change.modifiedEndLineNumber };
}

/** Overlap or touching, in either dimension: merging on either is safe, it only shows more. */
function adjacent(a: Window, b: Window): boolean {
  return a.from <= b.to + 1 && b.from <= a.to + 1;
}

/**
 * Slice both sides down to their hunks.
 *
 * `changes` are the diff editor's own, in document order. Groups are merged across both sides at
 * once, so the k-th slice of the left always answers to the k-th slice of the right; without that,
 * two nearby changes on one side and a far one on the other would pair the wrong stretches and the
 * editor would report a rewrite where a paragraph moved.
 */
export function foldPair(
  left: string,
  right: string,
  changes: readonly FoldChange[],
  context = FOLD_CONTEXT
): FoldedPair {
  const leftLines = left.length === 0 ? [] : left.split("\n");
  const rightLines = right.length === 0 ? [] : right.split("\n");
  const groups: { left: Window; right: Window }[] = [];
  for (const change of changes) {
    // `sideOf` yields the raw pair; `windowOf` widens and clamps it, and answers null for a side
    // with no lines at all (an empty file cannot show context).
    const rawLeft = sideOf(change, "original");
    const rawRight = sideOf(change, "modified");
    if (!rawLeft || !rawRight) continue;
    const wLeft = windowOf(rawLeft.from, rawLeft.to, leftLines.length, context);
    const wRight = windowOf(rawRight.from, rawRight.to, rightLines.length, context);
    if (!wLeft || !wRight) continue;
    const last = groups[groups.length - 1];
    if (last && (adjacent(last.left, wLeft) || adjacent(last.right, wRight))) {
      last.left = { from: Math.min(last.left.from, wLeft.from), to: Math.max(last.left.to, wLeft.to) };
      last.right = {
        from: Math.min(last.right.from, wRight.from),
        to: Math.max(last.right.to, wRight.to),
      };
      continue;
    }
    groups.push({ left: wLeft, right: wRight });
  }
  if (groups.length === 0) {
    return {
      left,
      right,
      hiddenLeft: 0,
      hiddenRight: 0,
      hunks: 0,
      folded: false,
      // Nothing was cut, so every line still sits at its own number.
      leftNumbers: leftLines.map((_, i) => i + 1),
      rightNumbers: rightLines.map((_, i) => i + 1),
    };
  }
  /**
   * One side's kept runs, each with the original line every line of it came from. The numbers
   * are built here rather than recovered later: only this function knows which window a line
   * of the folded text belongs to.
   */
  const parts = (lines: string[], windows: Window[]) => {
    const out: { text: string; numbers: number[] }[] = [];
    for (const w of windows) {
      const slice = lines.slice(w.from - 1, w.to);
      const text = slice.join("\n");
      if (text.length === 0) continue;
      out.push({ text, numbers: slice.map((_, i) => w.from + i) });
    }
    return out;
  };
  const leftParts = parts(leftLines, groups.map((g) => g.left));
  const rightParts = parts(rightLines, groups.map((g) => g.right));
  const leftText = leftParts.map((p) => p.text).join("\n");
  const rightText = rightParts.map((p) => p.text).join("\n");
  const kept = (text: string) => (text.length === 0 ? 0 : text.split("\n").length);
  const keptLeft = kept(leftText);
  const keptRight = kept(rightText);
  return {
    left: leftText,
    right: rightText,
    hiddenLeft: Math.max(0, leftLines.length - keptLeft),
    hiddenRight: Math.max(0, rightLines.length - keptRight),
    hunks: groups.length,
    folded: keptLeft < leftLines.length || keptRight < rightLines.length,
    leftNumbers: leftParts.flatMap((p) => p.numbers),
    rightNumbers: rightParts.flatMap((p) => p.numbers),
  };
}
