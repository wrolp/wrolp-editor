import JSZip from "jszip";

/**
 * A workbook read one sheet at a time, straight out of the zip.
 *
 * The viewer draws at most a screenful of the active sheet, but parsing a workbook with the
 * spreadsheet library builds every cell of every sheet as an object first — a 512 MB file is
 * several gigabytes of objects before the first row is drawn. Here the sheet part is inflated
 * in chunks and scanned as text, so only the rows the viewer draws are ever materialised. The
 * formatted text of a cell matches what `XLSX.utils.format_cell` returns, because the viewer
 * shows the file as Excel would, not as its XML spells it.
 */

/** How much of a sheet is drawn, matching the viewer's own caps. */
export const XLSX_MAX_ROWS = 2000;
export const XLSX_MAX_COLS = 80;

export interface XlsxSheetRows {
  rows: string[][];
  rowNumbers: number[];
  truncated: boolean;
}

export interface XlsxBook {
  /** Sheet names in workbook order. */
  names: string[];
  /**
   * Read one sheet by workbook index. `occupied` holds `"row:col"` keys (0-based sheet row,
   * 0-based column) of cells that hold an in-cell picture; such a cell's text is dropped but
   * the cell still counts as used, mirroring the current reader.
   */
  read(index: number, occupied?: ReadonlySet<string>): Promise<XlsxSheetRows>;
}

const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WORKBOOK_PART = "xl/workbook.xml";
const SHARED_STRINGS_PART = "xl/sharedStrings.xml";
const STYLES_PART = "xl/styles.xml";

/**
 * One cell's value before it is turned into text.
 *
 * A shared string is only a number until the shared-strings part is read, which happens after
 * the sheet: the part is read once for all the kept rows, not once per cell.
 */
type RawCell =
  | { kind: "text"; text: string }
  | { kind: "shared"; index: number }
  | { kind: "number"; raw: string; numFmtId: number };

interface RawRow {
  number: number;
  cells: (RawCell | undefined)[];
}

/** The number formats `xl/styles.xml` declares, and whether serial dates start in 1904. */
interface Styles {
  numFmts: Map<number, string>;
  /** `numFmtId` of each `<cellXfs>` entry, indexed by a cell's `s` attribute. */
  xfNumFmt: number[];
  date1904: boolean;
}

/** The slice of `XLSX.SSF` used here. */
interface Ssf {
  format(format: string | number, value: number, opts?: { date1904?: boolean }): string;
}

/** The part of JSZip's stream helper used here; its typings do not publish this method. */
interface ChunkStream {
  on(event: "data", callback: (chunk: Uint8Array) => void): ChunkStream;
  on(event: "end", callback: () => void): ChunkStream;
  on(event: "error", callback: (error: Error) => void): ChunkStream;
  pause(): ChunkStream;
  resume(): ChunkStream;
}

function parseXml(text: string): Document | null {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  // Chromium reports a malformed part as a document whose root is `parsererror`.
  return doc.getElementsByTagName("parsererror").length > 0 ? null : doc;
}

function elementsOf(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

/** One attribute of an opening tag, without paying for a full XML parse of the row. */
function attr(tag: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(tag);
  return match ? match[1] ?? match[2] : null;
}

/** Resolve a relationship target against the part that declares it. */
function resolvePart(from: string, target: string): string {
  const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  const out: string[] = [];
  for (const segment of [...base, ...target.replace(/^\//, "").split("/")]) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

function relsPath(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

/** `Id -> resolved part path` for one part's relationships file. */
async function readRels(zip: JSZip, part: string): Promise<Map<string, string>> {
  const file = zip.file(relsPath(part));
  const out = new Map<string, string>();
  if (!file) return out;
  const doc = parseXml(await file.async("string"));
  if (!doc) return out;
  for (const rel of elementsOf(doc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    if (id && target && rel.getAttribute("TargetMode") !== "External") {
      out.set(id, resolvePart(part, target));
    }
  }
  return out;
}

/** Decode the entities an XML text node or attribute can hold. */
function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (whole, body: string) => {
    switch (body) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
      default: {
        const code =
          body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
        if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return whole;
        try {
          return String.fromCodePoint(code);
        } catch {
          return whole;
        }
      }
    }
  });
}

/** The text of every `<t>` run in a string item; phonetic runs are not part of the value. */
function textRuns(xml: string): string {
  const cleaned = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
  const runs = /<t\b[^>]*?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let out = "";
  let run: RegExpExecArray | null;
  while ((run = runs.exec(cleaned))) {
    if (run[1]) out += unescapeXml(run[1]);
  }
  return out;
}

/**
 * Decode one part as UTF-8, chunk by chunk.
 *
 * `stream: true` is what keeps a multi-byte character that straddles two zip chunks intact;
 * without it every chunk boundary is a chance to corrupt a CJK name. `consume` returns true
 * when it has what it needs, and the stream is paused rather than read to the end — stopping
 * is the point of this reader.
 */
async function streamText(
  entry: JSZip.JSZipObject,
  consume: (chunk: string) => boolean
): Promise<void> {
  const stream = (
    entry as unknown as { internalStream(type: "uint8array"): ChunkStream }
  ).internalStream("uint8array");
  const decoder = new TextDecoder("utf-8");
  await new Promise<void>((resolve, reject) => {
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      stream.pause();
      resolve();
    };
    stream.on("data", (chunk) => {
      if (stopped) return;
      try {
        if (consume(decoder.decode(chunk, { stream: true }))) stop();
      } catch (error) {
        stopped = true;
        stream.pause();
        reject(error);
      }
    });
    stream.on("end", () => {
      if (stopped) return;
      try {
        const tail = decoder.decode();
        if (tail && consume(tail)) {
          stop();
          return;
        }
      } catch (error) {
        stopped = true;
        reject(error);
        return;
      }
      stopped = true;
      resolve();
    });
    stream.on("error", (error) => {
      if (stopped) return;
      stopped = true;
      reject(error);
    });
    // A JSZip worker starts paused; listeners alone do not start the flow.
    if (!stopped) stream.resume();
  });
}

/** The strings the kept rows refer to, read in a single pass and stopping after the last one. */
async function readSharedStrings(zip: JSZip, wanted: Set<number>): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (wanted.size === 0) return out;
  const file = zip.file(SHARED_STRINGS_PART);
  if (!file) return out;
  let highest = -1;
  for (const index of wanted) if (index > highest) highest = index;

  let index = -1;
  let buffer = "";
  await streamText(file, (chunk) => {
    buffer += chunk;
    for (;;) {
      const start = buffer.search(/<si[\s/>]/);
      if (start < 0) {
        // Keep enough for a `<si` split across chunks.
        if (buffer.length > 3) buffer = buffer.slice(-3);
        return false;
      }
      const open = buffer.indexOf(">", start);
      if (open < 0) {
        buffer = buffer.slice(start);
        return false;
      }
      if (buffer[open - 1] === "/") {
        index += 1;
        if (wanted.has(index)) out.set(index, "");
        buffer = buffer.slice(open + 1);
      } else {
        const close = buffer.indexOf("</si>", open);
        if (close < 0) {
          buffer = buffer.slice(start);
          return false;
        }
        index += 1;
        if (wanted.has(index)) out.set(index, textRuns(buffer.slice(open + 1, close)));
        buffer = buffer.slice(close + 5);
      }
      if (index >= highest) return true;
    }
  });
  return out;
}

/** The custom formats and per-style format ids `xl/styles.xml` declares. */
function readStyles(doc: Document): Omit<Styles, "date1904"> {
  const numFmts = new Map<number, string>();
  for (const format of elementsOf(doc, "numFmt")) {
    const id = Number(format.getAttribute("numFmtId") ?? NaN);
    const code = format.getAttribute("formatCode");
    if (Number.isFinite(id) && code !== null) numFmts.set(id, code);
  }
  const xfNumFmt: number[] = [];
  // `cellXfs` is the list cells index with `s`; `cellStyleXfs` is the named-style list and
  // is not what a cell points at.
  const cellXfs = elementsOf(doc, "cellXfs")[0];
  if (cellXfs) {
    for (const xf of Array.from(cellXfs.children)) {
      if (xf.localName !== "xf") continue;
      const id = Number(xf.getAttribute("numFmtId") ?? 0);
      xfNumFmt.push(Number.isFinite(id) ? id : 0);
    }
  }
  return { numFmts, xfNumFmt };
}

/** What a cell's `s` attribute resolves to; a cell without one is General. */
function numFmtIdOf(style: number, styles: Styles): number {
  return style >= 0 && style < styles.xfNumFmt.length ? styles.xfNumFmt[style] : 0;
}

/** A cell's formatted text, as `XLSX.utils.format_cell` would print it. */
function formatNumber(raw: string, numFmtId: number, styles: Styles, ssf: Ssf | null): string {
  const value = Number(raw);
  // A value the XML cannot mean is shown as written rather than guessed at.
  if (!ssf || !Number.isFinite(value)) return raw;
  try {
    const custom = styles.numFmts.get(numFmtId);
    if (custom === undefined && numFmtId === 0) {
      // SheetJS prints whole numbers directly and hands the rest to the General format.
      return (value | 0) === value ? value.toString(10) : ssf.format(0, value);
    }
    return ssf.format(custom ?? numFmtId, value, { date1904: styles.date1904 });
  } catch {
    return raw;
  }
}

function cellText(
  cell: RawCell,
  shared: Map<number, string>,
  styles: Styles,
  ssf: Ssf | null
): string {
  switch (cell.kind) {
    case "text":
      return cell.text;
    case "shared":
      return shared.get(cell.index) ?? "";
    case "number":
      return formatNumber(cell.raw, cell.numFmtId, styles, ssf);
  }
}

/** The `<row>...</row>` body as cells, keyed by the column their `r` attribute implies. */
function cellsOfRow(body: string, styles: Styles): {
  cells: (RawCell | undefined)[];
  beyond: boolean;
} {
  const cells: (RawCell | undefined)[] = new Array(XLSX_MAX_COLS);
  let beyond = false;
  let nextColumn = 0;
  // A cell is either self-closing or ends at its own closing tag; nothing nests inside it.
  const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let match: RegExpExecArray | null;
  while ((match = cellPattern.exec(body))) {
    const head = match[1] ?? "";
    const inner = match[2] ?? "";
    const ref = attr(head, "r");
    let column = nextColumn;
    if (ref) {
      const parsed = /^([A-Z]+)/.exec(ref);
      if (parsed) {
        let base = 0;
        for (const letter of parsed[1]) base = base * 26 + (letter.charCodeAt(0) - 64);
        column = base - 1;
      }
    }
    nextColumn = column + 1;

    const type = attr(head, "t") ?? "n";
    const style = Number(attr(head, "s") ?? 0) || 0;
    const value = /<v\b[^>]*?(?:\/>|>([\s\S]*?)<\/v>)/.exec(inner)?.[1];
    // A `<c>` written only for its style holds nothing: it is not content, and it must not
    // extend the used range past the column cap either.
    const content = value !== undefined || type === "inlineStr" || /<f\b/.test(inner);
    if (column >= XLSX_MAX_COLS) {
      if (content) beyond = true;
      continue;
    }

    let cell: RawCell | undefined;
    switch (type) {
      case "s": {
        // A shared-string cell with no index is a stub, as SheetJS treats it.
        const index = parseInt(value ?? "", 10);
        if (Number.isFinite(index)) cell = { kind: "shared", index };
        break;
      }
      case "str":
        cell = { kind: "text", text: unescapeXml(value ?? "") };
        break;
      case "inlineStr": {
        const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(inner);
        cell = { kind: "text", text: inline ? textRuns(inline[1]) : "" };
        break;
      }
      case "b":
        // `parsexmlbool` accepts exactly these three spellings of true.
        cell = {
          kind: "text",
          text: value === "1" || value === "true" || value === "TRUE" ? "TRUE" : "FALSE",
        };
        break;
      case "e":
        // The error is stored as its own text, not as the numeric code SheetJS keeps in `v`.
        cell = { kind: "text", text: unescapeXml(value ?? "") };
        break;
      case "d":
        // A cell stored as an ISO date is rare; its written text is the closest thing to the
        // formatted value without a full date parser here.
        cell = { kind: "text", text: unescapeXml(value ?? "") };
        break;
      default: {
        if (value === undefined || value === "") break;
        if (Number.isFinite(Number(value))) {
          cell = { kind: "number", raw: value, numFmtId: numFmtIdOf(style, styles) };
        } else {
          cell = { kind: "text", text: unescapeXml(value) };
        }
      }
    }
    if (cell) cells[column] = cell;
  }
  return { cells, beyond };
}

async function readSheet(
  zip: JSZip,
  part: string,
  occupied: ReadonlySet<string> | undefined,
  styles: Styles,
  ssf: Ssf | null
): Promise<XlsxSheetRows> {
  const file = zip.file(part);
  if (!file) return { rows: [], rowNumbers: [], truncated: false };

  const collected: RawRow[] = [];
  let truncated = false;
  let buffer = "";
  let previous = -1;

  const keep = (number: number, cells: (RawCell | undefined)[]): boolean => {
    let used = false;
    for (let column = 0; column < XLSX_MAX_COLS && !used; column += 1) {
      const cell = cells[column];
      used =
        (occupied?.has(`${number}:${column}`) ?? false) ||
        (cell !== undefined && (cell.kind !== "text" || cell.text !== ""));
    }
    if (!used) return false;
    // One row past the cap is read to prove there is more: a sheet of exactly 2000 rows
    // would otherwise be reported as cut, and a blank row after the cap is not content.
    if (collected.length >= XLSX_MAX_ROWS) {
      truncated = true;
      return true;
    }
    collected.push({ number, cells });
    return false;
  };

  const consume = (chunk: string): boolean => {
    buffer += chunk;
    for (;;) {
      const ending = buffer.indexOf("</sheetData>");
      const start = buffer.indexOf("<row");
      if (ending >= 0 && (start < 0 || ending < start)) return true;
      if (start < 0) {
        // Keep enough for a `<row` split across chunks; anything earlier is not a row.
        if (buffer.length > 4) buffer = buffer.slice(-4);
        return false;
      }
      if (start > 0) buffer = buffer.slice(start);
      const open = buffer.indexOf(">", 4);
      if (open < 0) return false;
      const head = buffer.slice(0, open + 1);
      const ref = attr(head, "r");
      // A row without `r` follows the previous one; the first such row is row 1.
      const number = ref !== null && /^\d+$/.test(ref) ? Number(ref) - 1 : previous + 1;
      previous = number;
      if (head.endsWith("/>")) {
        buffer = buffer.slice(open + 1);
        continue;
      }
      const close = buffer.indexOf("</row>", open);
      if (close < 0) return false;
      const body = buffer.slice(open + 1, close);
      buffer = buffer.slice(close + 6);
      const { cells, beyond } = cellsOfRow(body, styles);
      if (beyond) truncated = true;
      if (keep(number, cells)) return true;
    }
  };

  await streamText(file, consume);

  const wanted = new Set<number>();
  for (const row of collected) {
    for (const cell of row.cells) {
      if (cell?.kind === "shared") wanted.add(cell.index);
    }
  }
  const shared = await readSharedStrings(zip, wanted);

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (const row of collected) {
    const texts: string[] = [];
    let last = -1;
    for (let column = 0; column < XLSX_MAX_COLS; column += 1) {
      const picture = occupied?.has(`${row.number}:${column}`) ?? false;
      const cell = row.cells[column];
      const text = picture || !cell ? "" : cellText(cell, shared, styles, ssf);
      texts.push(text);
      if (picture || text !== "") last = column;
    }
    // A shared string can resolve to "" only after its part is read; such a row is as blank
    // as one that never had a cell.
    if (last < 0) continue;
    rows.push(texts.slice(0, last + 1));
    rowNumbers.push(row.number);
  }
  return { rows, rowNumbers, truncated };
}

/**
 * Read a workbook's shape and leave every sheet on disk.
 *
 * Returns null when the bytes are not an OOXML workbook at all; throws `xlsx_unreadable`
 * when the parts are there but cannot be read.
 */
export async function openXlsxBook(raw: ArrayBuffer): Promise<XlsxBook | null> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(raw);
  } catch {
    // An `.xls` (OLE2) or a plain file is not a zip at all, which is simply not this format.
    return null;
  }
  const workbookFile = zip.file(WORKBOOK_PART);
  if (!workbookFile) return null;

  let workbookDoc: Document | null;
  try {
    workbookDoc = parseXml(await workbookFile.async("string"));
  } catch {
    throw new Error("xlsx_unreadable");
  }
  if (!workbookDoc) throw new Error("xlsx_unreadable");

  let rels: Map<string, string>;
  try {
    rels = await readRels(zip, WORKBOOK_PART);
  } catch {
    throw new Error("xlsx_unreadable");
  }
  const names: string[] = [];
  const parts: (string | undefined)[] = [];
  for (const sheet of elementsOf(workbookDoc, "sheet")) {
    const name = sheet.getAttribute("name");
    if (!name) continue;
    const id = sheet.getAttribute("r:id") ?? sheet.getAttributeNS(REL_NS, "id");
    names.push(name);
    parts.push(id ? rels.get(id) : undefined);
  }

  let styleDoc: Document | null = null;
  try {
    const stylesFile = zip.file(STYLES_PART);
    if (stylesFile) styleDoc = parseXml(await stylesFile.async("string"));
  } catch {
    throw new Error("xlsx_unreadable");
  }
  const styles: Styles = {
    ...(styleDoc ? readStyles(styleDoc) : { numFmts: new Map<number, string>(), xfNumFmt: [] }),
    // Serial dates in a 1904 workbook are formatted through the same shift Excel applies.
    date1904: ["1", "true"].includes(
      workbookDoc.getElementsByTagNameNS("*", "workbookPr")[0]?.getAttribute("date1904") ?? ""
    ),
  };

  // Loaded once per workbook: number formatting is the one thing the viewer shows that the
  // XML cannot be read for.
  const XLSX = await import("xlsx");
  const ssf = XLSX.SSF as Ssf;

  return {
    names,
    read: (index, occupied) => {
      const part = parts[index];
      if (!part) return Promise.resolve({ rows: [], rowNumbers: [], truncated: false });
      return readSheet(zip, part, occupied, styles, ssf);
    },
  };
}
