/**
 * Conflict markers in a working-tree file, as text and as line ranges.
 *
 * Git writes the parts it could merge and leaves `<<<<<<<` / `=======` / `>>>>>>>` around the
 * parts it could not. This module reads those blocks; it never writes them. The merge view
 * edits the text through Monaco, so line numbers are always derived again from the current
 * model rather than carried across an edit.
 *
 * Only the two-way style is understood. `merge.conflictStyle=diff3` adds a `|||||||` base
 * section, which would be mistaken for ours; a file using it is refused rather than merged
 * wrongly.
 */

export interface LineRange {
  /** 0-based, inclusive. */
  from: number;
  /** 0-based, exclusive. */
  to: number;
}

export interface MergeTextSegment {
  kind: "text";
  text: string;
}

export interface MergeConflictSegment {
  kind: "conflict";
  /** The two sides between the markers, with `\n` separators and no marker lines. */
  ours: string;
  theirs: string;
  /** The whole block in the current text: `<<<<<<<` through `>>>>>>>`, 0-based inclusive. */
  from: number;
  to: number;
  /** The marker lines as written, labels included. */
  startMarker: string;
  endMarker: string;
}

export type MergeSegment = MergeTextSegment | MergeConflictSegment;

export type MergeParseProblem = "diff3" | "unterminated" | "unordered";

export interface MergeParseResult {
  ok: boolean;
  problem?: MergeParseProblem;
  segments: MergeSegment[];
  conflicts: MergeConflictSegment[];
}

export interface AlignedSides {
  ours: LineRange | null;
  theirs: LineRange | null;
}

const START = "<<<<<<<";
const SEPARATOR = "=======";
const END = ">>>>>>>";
const BASE = "|||||||";

/**
 * Parse a file that may contain conflict markers.
 *
 * Line endings are normalised to `\n` first; the editor stores `\n` and the backend restores
 * the file's own breaks when the result is applied.
 */
export function parseConflicts(text: string): MergeParseResult {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const segments: MergeSegment[] = [];
  const conflicts: MergeConflictSegment[] = [];
  let textStart = 0;
  let index = 0;

  const problem = (reason: MergeParseProblem): MergeMergeParseFailure => ({
    ok: false,
    problem: reason,
    segments: [],
    conflicts: [],
  });

  while (index < lines.length) {
    if (!lines[index].startsWith(START)) {
      index += 1;
      continue;
    }
    if (index > textStart) {
      segments.push({ kind: "text", text: lines.slice(textStart, index).join("\n") });
    }
    const start = index;
    const startMarker = lines[start];
    index += 1;
    const ours: string[] = [];
    let separator = -1;
    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith(BASE)) return problem("diff3");
      if (line.startsWith(SEPARATOR)) {
        separator = index;
        index += 1;
        break;
      }
      if (line.startsWith(END) || line.startsWith(START)) return problem("unordered");
      ours.push(line);
      index += 1;
    }
    if (separator < 0) return problem("unterminated");

    const theirs: string[] = [];
    let end = -1;
    while (index < lines.length) {
      const line = lines[index];
      if (line.startsWith(END)) {
        end = index;
        index += 1;
        break;
      }
      if (line.startsWith(START) || line.startsWith(BASE)) return problem("unordered");
      theirs.push(line);
      index += 1;
    }
    if (end < 0) return problem("unterminated");

    const conflict: MergeConflictSegment = {
      kind: "conflict",
      ours: ours.join("\n"),
      theirs: theirs.join("\n"),
      from: start,
      to: end,
      startMarker,
      endMarker: lines[end],
    };
    segments.push(conflict);
    conflicts.push(conflict);
    textStart = end + 1;
  }

  if (textStart < lines.length) {
    segments.push({ kind: "text", text: lines.slice(textStart).join("\n") });
  }
  return { ok: true, segments, conflicts };
}

type MergeMergeParseFailure = MergeParseResult;

/**
 * Where each side's block sits in the full text of that side.
 *
 * The block text is a slice of the same bytes as the side, so a line-for-line search is exact
 * once line endings are normalised. Two identical blocks in one side resolve to the first
 * occurrence; the block is still actionable, only its highlight may point at the earlier copy.
 */
export function alignSides(
  conflicts: MergeConflictSegment[],
  oursText: string,
  theirsText: string
): Map<number, AlignedSides> {
  const oursLines = normalizedLines(oursText);
  const theirsLines = normalizedLines(theirsText);
  const result = new Map<number, AlignedSides>();
  for (const conflict of conflicts) {
    result.set(conflict.from, {
      ours: findBlock(oursLines, conflict.ours),
      theirs: findBlock(theirsLines, conflict.theirs),
    });
  }
  return result;
}

function normalizedLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function findBlock(lines: string[], block: string): LineRange | null {
  if (block === "") return null;
  const wanted = block.split("\n");
  const last = lines.length - wanted.length;
  for (let start = 0; start <= last; start += 1) {
    let matches = true;
    for (let offset = 0; offset < wanted.length; offset += 1) {
      if (lines[start + offset] !== wanted[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) return { from: start, to: start + wanted.length };
  }
  return null;
}

/** The replacement for a conflict block: one side, or both in order. */
export function conflictChoice(
  conflict: MergeConflictSegment,
  choice: "ours" | "theirs" | "both"
): string {
  if (choice === "ours") return conflict.ours;
  if (choice === "theirs") return conflict.theirs;
  if (!conflict.ours) return conflict.theirs;
  if (!conflict.theirs) return conflict.ours;
  return `${conflict.ours}\n${conflict.theirs}`;
}

/** Number of conflicts still present, for the toolbar and Apply. */
export function unresolvedCount(result: MergeParseResult): number {
  return result.ok ? result.conflicts.length : 0;
}
