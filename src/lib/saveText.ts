/**
 * The two cleanups a save can be told to do: drop trailing whitespace, and make sure the file
 * ends with a line break.
 *
 * They are expressed as edits to the buffer rather than as a rewrite of the text on the way out,
 * because the buffer is what the tab compares itself against when it decides whether it is
 * unsaved, what the diff marks are drawn from, and what the user reads back after the save. A
 * file written differently from the text on screen would make all three describe different
 * documents.
 */

/** A replacement in Monaco's terms: a 1-based range in the text before any of the edits applied. */
export interface LineEdit {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  text: string;
}

export interface SaveCleanup {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  /** The line break this file is written with, taken from the buffer rather than assumed. */
  eol: string;
}

/** What counts as trailing whitespace: a space or a tab at the end of a line, nothing else. */
function trimmedLength(line: string): number {
  let end = line.length;
  while (end > 0 && (line[end - 1] === " " || line[end - 1] === "\t")) end--;
  return end;
}

/**
 * The edits that leave `lines` ready to write, in the order Monaco wants them: none overlapping,
 * each at or after the one before it. Empty means the text is already in the shape asked for,
 * which is the common case and costs the buffer nothing.
 *
 * An empty document is left alone rather than given a line break: a file with a final newline and
 * no content is one byte that says nothing, and every tool that shows "no trailing newline" would
 * then go quiet on a file nobody has written anything into.
 */
export function cleanupEdits(lines: string[], opts: SaveCleanup): LineEdit[] {
  const edits: LineEdit[] = [];
  // Where the last line ends once its trailing whitespace is gone, which is where a final line
  // break has to go: an edit's coordinates are read against the original text, and the trim of
  // that line is already in the list ahead of it.
  let lastEnd = lines.length > 0 ? lines[lines.length - 1].length : 0;
  if (opts.trimTrailingWhitespace) {
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const kept = trimmedLength(line);
      if (kept < line.length) {
        edits.push({
          startLine: i + 1,
          startColumn: kept + 1,
          endLine: i + 1,
          endColumn: line.length + 1,
          text: "",
        });
      }
      if (i === lines.length - 1) lastEnd = kept;
    }
  }
  const hasContent = lines.some((line) => line.length > 0);
  // Monaco keeps a document ending in a line break as one more line, empty, so an empty last
  // line beyond the first is the file already having the break we would add.
  const endsWithBreak = lines.length > 1 && lines[lines.length - 1] === "";
  if (opts.insertFinalNewline && hasContent && !endsWithBreak) {
    const at = lines.length;
    edits.push({
      startLine: at,
      startColumn: lastEnd + 1,
      endLine: at,
      endColumn: lastEnd + 1,
      text: opts.eol,
    });
  }
  return edits;
}
