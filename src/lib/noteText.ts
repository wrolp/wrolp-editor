/**
 * Split a note into the header (everything through its closing `---`, or nothing) and the body.
 * The rule matches the backend's: only a first line that is exactly `---` opens a header, and
 * an unclosed one is body.
 */
export function splitNote(text: string): { head: string; body: string } {
  const firstEnd = text.indexOf("\n");
  if (firstEnd < 0 || text.slice(0, firstEnd).trim() !== "---") {
    return { head: "", body: text };
  }
  let pos = firstEnd + 1;
  while (pos <= text.length) {
    const end = text.indexOf("\n", pos);
    const lineEnd = end < 0 ? text.length : end;
    if (text.slice(pos, lineEnd).trim() === "---") {
      const cut = end < 0 ? text.length : end + 1;
      return { head: text.slice(0, cut), body: text.slice(cut) };
    }
    if (end < 0) break;
    pos = end + 1;
  }
  return { head: "", body: text };
}