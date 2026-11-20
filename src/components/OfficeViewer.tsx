import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { t } from "../lib/i18n";
import { api, errorMessage } from "../lib/tauri";
import type { OfficeKind } from "../lib/path";
import { IconChevron, IconSliders } from "./icons";
import {
  EMU_PER_PX,
  readSheetImages,
  releaseSheetImages,
  type CellPicture,
  type SheetImage,
  type SheetImages,
} from "../lib/xlsxImages";
import { openXlsxBook, type XlsxBook } from "../lib/xlsxStream";

/**
 * Largest document this window will try to draw.
 *
 * A viewer holds the whole file in memory and its renderer builds a DOM for it, so a deck of
 * a hundred slides with full-page photographs is not a preview but a way to lock the window
 * up. The file is on disk, and the row's own "open in system" is the way to it.
 */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * Largest workbook read sheet by sheet.
 *
 * A sheet is inflated in chunks and only the rows on screen are kept, so the limit here is the
 * bytes in memory rather than the objects they would become: the whole-file parsers behind the
 * other kinds would need gigabytes for this. A workbook over `MAX_BYTES` whose bytes are not
 * an OOXML zip still has to go through that parser, so it is refused instead.
 */
const MAX_SHEET_BYTES = 512 * 1024 * 1024;

/** How much of a sheet is drawn. A spreadsheet can be longer than any screen can scroll. */
const MAX_ROWS = 2000;
const MAX_COLS = 80;

/** One sheet as the viewer draws it: formatted cells, already bounded. */
interface SheetView {
  name: string;
  rows: string[][];
  /** Zero-based sheet row of each drawn row; blank rows are left out of `rows`. */
  rowNumbers: number[];
  /** Whether rows or columns were left out, so the count is not mistaken for the whole. */
  truncated: boolean;
}

/** One sheet row read as a record; each of its cells is one line of the record. */
interface SheetRecord {
  /** Zero-based sheet row this record came from. */
  row: number;
  cells: string[];
}

/** One picture of the sheet, measured onto the drawn table. */
interface PlacedImage {
  key: string;
  url: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A slide deck's canvas: 16:9, at the width the renderer lays out in and the smallest it is shrunk to. */
const SLIDE_WIDTH = 960;
const SLIDE_HEIGHT = 540;
const SLIDE_MIN_WIDTH = 480;

/**
 * Shrink or grow Word pages to the pane.
 *
 * The renderer lays a page out at 96dpi — about 816px — and an editor pane is usually a
 * different width. The page is measured once, unzoomed, and the wrapper is then scaled with
 * CSS zoom: `fit` means "as wide as the pane, within reason", and a number is the reader's
 * own choice of size.
 */
const WORD_MIN_ZOOM = 25;
const WORD_MAX_ZOOM = 400;
/** The sizes the minus and plus buttons walk through, in percent. */
const WORD_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400];

const wordClamp = (percent: number) =>
  Math.min(WORD_MAX_ZOOM, Math.max(WORD_MIN_ZOOM, percent));

/**
 * The colours a Word page can take. The same sheet colours the PDF reader offers, named with
 * the same keys: it is paper either way, and a reader who tints one document usually wants the
 * other toned down too. There is no night here — a document's own colours are not inverted by
 * a page tint.
 */
const WORD_PAPERS = [
  { value: "#ffffff", label: "pdf.paperWhite" },
  { value: "#f4ecd8", label: "pdf.paperSepia" },
  { value: "#c7edcc", label: "pdf.paperGreen" },
];

/** The row that picks the colour of a Word page, mirroring the PDF toolbar's. */
function WordPaperPicker({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const preset = WORD_PAPERS.some((item) => item.value === value);
  return (
    <div className="pdf-papers" role="group" aria-label={t("pdf.paper")}>
      {WORD_PAPERS.map((item) => (
        <button
          key={item.value}
          type="button"
          className={`pdf-paper${value === item.value ? " active" : ""}`}
          style={{ background: item.value }}
          title={t(item.label)}
          aria-label={t(item.label)}
          aria-pressed={value === item.value}
          onClick={() => onChange(item.value)}
        />
      ))}
      <label
        className={`pdf-paper is-custom${preset ? "" : " active"}`}
        style={preset ? undefined : { background: value }}
        title={t("pdf.paperCustom")}
      >
        <input
          type="color"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          aria-label={t("pdf.paperCustom")}
        />
      </label>
    </div>
  );
}

/**
 * Wait for the pictures and the fonts the renderer has just inserted: pagination measures
 * blocks by their laid-out height, and an image that has not arrived yet measures zero.
 */
async function settleWordLayout(box: HTMLElement) {
  await document.fonts.ready.catch(() => undefined);
  await Promise.all(
    [...box.querySelectorAll("img")].map((img) =>
      img.complete
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener("load", () => resolve(), { once: true });
            img.addEventListener("error", () => resolve(), { once: true });
          })
    )
  );
}

/**
 * Split a sheet the renderer left running on for several pages.
 *
 * The renderer only breaks where the document says it broke — an explicit page break or a
 * `lastRenderedPageBreak` Word saved — and documents written by other tools carry neither,
 * which leaves a whole chapter on one long sheet. Nothing in the file says where those breaks
 * belong, so they are worked out from the layout instead: blocks are stacked until a sheet is
 * full, and the remainder moves to a fresh sheet with the same paper, margins, header and
 * footer. A table taller than a sheet stays whole and overflows it, because splitting one
 * would cut a row in half.
 */
function paginateWord(box: HTMLElement) {
  const wrapper = box.querySelector<HTMLElement>(".docx-wrapper");
  if (!wrapper) return;
  const sheets = [...wrapper.querySelectorAll<HTMLElement>(":scope > section.docx")];
  for (const sheet of sheets) {
    const article = sheet.querySelector<HTMLElement>(":scope > article");
    if (!article) continue;
    const blocks = [...article.children] as HTMLElement[];
    if (blocks.length < 2) continue;
    const style = getComputedStyle(sheet);
    // The paper height is the inline minimum the renderer computed from the section
    // properties; a sheet that has grown past it still reports the minimum here.
    const sheetHeight = parseFloat(sheet.style.minHeight) || sheet.clientHeight;
    const bottom = parseFloat(style.paddingBottom) || 0;
    const footer = sheet.querySelector<HTMLElement>(":scope > footer");
    const room = sheetHeight - bottom - (footer?.offsetHeight ?? 0) - article.offsetTop;
    if (room <= 0) continue;
    const endOf = (block: HTMLElement) => block.offsetTop + block.offsetHeight;
    if (endOf(blocks[blocks.length - 1]) <= article.offsetTop + room + 1) continue;

    // Measured while every block is still in place, so no decision depends on a block that
    // has already been moved away.
    const pages: HTMLElement[][] = [];
    let group: HTMLElement[] = [];
    let base = blocks[0].offsetTop;
    for (const block of blocks) {
      if (group.length > 0 && endOf(block) - base > room + 1) {
        pages.push(group);
        group = [];
        base = block.offsetTop;
      }
      group.push(block);
    }
    if (group.length > 0) pages.push(group);
    if (pages.length < 2) continue;

    // The first page keeps its blocks; every later page gets its own sheet, cloned from this
    // one so it inherits the paper size, the margins and the header and footer.
    const emptyArticle = article.cloneNode(false) as HTMLElement;
    let anchor = sheet;
    for (const page of pages.slice(1)) {
      const next = sheet.cloneNode(false) as HTMLElement;
      next.removeAttribute("id");
      for (const child of [...sheet.children]) {
        if (child === article) {
          const body = emptyArticle.cloneNode(false) as HTMLElement;
          body.removeAttribute("id");
          body.append(...page);
          next.appendChild(body);
        } else {
          const copy = child.cloneNode(true) as HTMLElement;
          copy.removeAttribute("id");
          next.appendChild(copy);
        }
      }
      anchor.after(next);
      anchor = next;
    }
  }
}

interface Props {
  path: string;
  kind: OfficeKind;
  /**
   * A CSV's text, already decoded and as the editor holds it. Present means this file is a
   * CSV: there are no bytes to read and no pictures to place, only rows to split.
   */
  csvText?: string;
  /** The colour of the paper a Word page is drawn on, kept in settings with the PDF's. */
  paper: string;
  onSavePaper: (value: string) => void;
}

/**
 * The sentence the viewer shows for a failure.
 *
 * A refusal from the backend is a code the app already words; anything else came out of one
 * of the renderers, and those messages are English internals. They are worth keeping as the
 * detail — that is what makes a report actionable — but they cannot be the sentence.
 */
function failure(e: unknown): string {
  const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const code = raw.split(":", 1)[0];
  // The codes this viewer throws, and the one the read command answers with.
  if (code.startsWith("office_") || code === "fs_read") return errorMessage(e);
  const detail = raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
  return `${t("office.unreadable")} — ${detail}`;
}

/** Column letters as a spreadsheet shows them: 0 -> "A", 26 -> "AA". */
function columnName(index: number): string {
  let name = "";
  let n = index;
  do {
    name = String.fromCharCode(65 + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return name;
}

/**
 * The workbook as plain grids.
 *
 * The cells come back formatted, because the viewer is read-only and a date that reads
 * `45123` is not what the file says to anybody looking at it. The rows are read cell by cell
 * rather than through `sheet_to_json`, so each drawn row keeps its real sheet row number:
 * pictures are anchored and stored by that number, and a row the reader skipped would put
 * every picture one row off. Bounded here rather than while drawing: a bound applied at draw
 * time would still have parsed the whole sheet.
 */
async function readWorkbook(raw: ArrayBuffer, images: SheetImages | null): Promise<SheetView[]> {
  const XLSX = await import("xlsx");
  const book = XLSX.read(raw, { type: "array" });
  return book.SheetNames.map((name) => {
    const sheet = book.Sheets[name];
    const pictures = images?.[name]?.cells;
    const rows: string[][] = [];
    const rowNumbers: number[] = [];
    let truncated = false;
    if (sheet?.["!ref"]) {
      const range = XLSX.utils.decode_range(sheet["!ref"]);
      const width = Math.min(Math.max(range.e.c - range.s.c + 1, 1), MAX_COLS);
      truncated = range.e.c - range.s.c + 1 > width;
      for (let row = range.s.r; row <= range.e.r; row += 1) {
        const kept: string[] = [];
        let used = false;
        let last = -1;
        for (let column = range.s.c; column < range.s.c + width; column += 1) {
          const picture = pictures?.[`${row}:${column}`];
          const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })];
          // An in-cell picture takes the cell's place; the text beside it is the formula that
          // referred to it, which is not what the cell shows.
          const text = picture ? "" : cell ? XLSX.utils.format_cell(cell) : "";
          kept.push(text ?? "");
          if (text || picture) {
            used = true;
            last = kept.length - 1;
          }
        }
        if (!used) continue;
        if (rows.length >= MAX_ROWS) {
          truncated = true;
          break;
        }
        rows.push(kept.slice(0, last + 1));
        rowNumbers.push(row);
      }
    }
    return { name, rows, rowNumbers, truncated };
  });
}

/**
 * A CSV read as the sheet it describes.
 *
 * Parsed here rather than through the workbook reader: that one takes bytes, and SheetJS
 * would reinterpret numbers and dates on the way, which is not what the text says. A quoted
 * field may hold commas and line breaks, and a doubled quote is one quote; everything else
 * is the cell's text verbatim.
 */
function readCsv(text: string): SheetView {
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let truncated = false;
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let record = 0;
  const endField = () => {
    if (row.length < MAX_COLS) row.push(field);
    else truncated = true;
    field = "";
  };
  const endRecord = () => {
    endField();
    // A blank line is not a record; the workbook reader skips those too.
    if (row.some((cell) => cell !== "")) {
      if (rows.length < MAX_ROWS) {
        rows.push(row);
        rowNumbers.push(record);
      } else {
        truncated = true;
      }
    }
    row = [];
    record += 1;
  };
  // A BOM is an encoding mark, not the first cell's first character.
  const start = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && field === "") {
      quoted = true;
    } else if (char === ",") {
      endField();
    } else if (char === "\r" || char === "\n") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      endRecord();
    } else {
      field += char;
    }
  }
  if (field !== "" || row.length > 0) endRecord();
  return { name: "CSV", rows, rowNumbers, truncated };
}

/**
 * One Word document, spreadsheet or slide deck drawn from its own bytes.
 *
 * The three renderers are loaded on demand: each is larger than the whole editor, and a
 * session that never opens one of these files pays nothing for them. What they have in
 * common is where the bytes come from — `read_file_range` hands the whole file over as an
 * `ArrayBuffer`, the same channel the PDF reader uses, because a `fetch` against the asset
 * protocol would need CORS.
 */
export default function OfficeViewer({ path, kind, csvText, paper, onSavePaper }: Props) {
  const host = useRef<HTMLDivElement>(null);
  /** The deck's previewer, which owns DOM outside React's knowledge and has to be torn down. */
  const deck = useRef<{ destroy: () => void } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sheets, setSheets] = useState<SheetView[] | null>(null);
  /** A workbook too large to parse whole: its sheet names, and the one sheet that is drawn. */
  const [sheetNames, setSheetNames] = useState<string[] | null>(null);
  const [lazySheet, setLazySheet] = useState<SheetView | null>(null);
  const bookRef = useRef<XlsxBook | null>(null);
  const rawRef = useRef<ArrayBuffer | null>(null);
  const [active, setActive] = useState(0);
  /** Pictures of each sheet, and the object URLs that keep their bytes alive. */
  const [images, setImages] = useState<SheetImages | null>(null);
  const imagesRef = useRef<SheetImages | null>(null);
  /** A sheet is either its grid or one record at a time; records read the first two columns. */
  const [mode, setMode] = useState<"grid" | "records">("grid");
  const [record, setRecord] = useState(0);
  /** The page number being edited in the counter; Enter jumps to it. */
  const [jump, setJump] = useState("1");
  /** How a record names its fields: the title block, and whether to draw it at all. */
  const [showTitles, setShowTitles] = useState(true);
  const [titleRow, setTitleRow] = useState(1);
  const [titleRows, setTitleRows] = useState(1);
  const recordsRef = useRef<HTMLDivElement>(null);

  /** The Word page's own width in CSS pixels, measured once before any zoom is applied. */
  const [paperWidth, setPaperWidth] = useState(0);
  /** How much horizontal room the pane gives a page. Tracked so fit follows a resized window. */
  const [roomWidth, setRoomWidth] = useState(0);
  /** `null` fits the page to the pane; a number is the reader's own size in percent. */
  const [wordZoom, setWordZoom] = useState<number | null>(null);
  /** What the zoom box shows; kept as text so a half-typed number is not rewritten. */
  const [wordDraft, setWordDraft] = useState("100");
  /** Whether the light strip the renderer draws between pages is kept. Off by default: a long
   *  document reads as one continuous page, which is what most people open a Word file to do. */
  const [wordGaps, setWordGaps] = useState(false);
  /** The page options stay folded behind one floating button until they are asked for. */
  const [wordTools, setWordTools] = useState(false);
  const wordToolsRef = useRef<HTMLDivElement>(null);
  /** The page the reader is on, counted from the pages the renderer laid out. */
  const [wordPage, setWordPage] = useState({ index: 0, total: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Scroll fires far more often than a page count can be read; one frame is enough. */
  const pageFrame = useRef(0);

  useEffect(() => {
    let alive = true;
    const box = host.current;
    if (!box) return;
    box.replaceChildren();
    setError(null);
    setLoading(true);
    setSheets(null);
    setSheetNames(null);
    setLazySheet(null);
    bookRef.current = null;
    rawRef.current = null;
    setImages(null);
    setActive(0);
    setMode("grid");
    setRecord(0);
    setShowTitles(true);
    setTitleRow(1);
    setTitleRows(1);
    setLabelWidth(null);
    setWordZoom(null);
    setWordGaps(false);
    setPaperWidth(0);
    setWordTools(false);
    setWordPage({ index: 0, total: 0 });

    // A CSV is text, and the text is already here: decoded for the editor, and the very
    // buffer behind this pane. Nothing to fetch, nothing to release.
    if (csvText !== undefined) {
      setSheets([readCsv(csvText)]);
      setImages({});
      setLoading(false);
      return () => {
        alive = false;
        box.replaceChildren();
      };
    }

    void (async () => {
      try {
        const stat = await api.statFile(path);
        if (!alive) return;
        if (!stat) throw new Error("office_missing");
        if (stat.bytes > (kind === "sheet" ? MAX_SHEET_BYTES : MAX_BYTES)) {
          throw new Error(`office_too_large:${Math.max(1, Math.round(stat.bytes / 1024 / 1024))}`);
        }
        const raw = await api.readFileRange(path, 0, stat.bytes);
        if (!alive) return;
        if (kind === "word") {
          const { renderAsync } = await import("docx-preview");
          if (!alive) return;
          // `inWrapper` gives the pages their own container, which is what the stylesheet
          // sizes and paints; the renderer owns everything inside it.
          await renderAsync(raw, box, undefined, {
            inWrapper: true,
            breakPages: true,
            // The renderer's default is to ignore the page boundaries Word itself recorded
            // when it last laid the document out, which leaves a whole chapter on one sheet:
            // those marks are the only pagination a document carries, so they are honoured.
            ignoreLastRenderedPageBreak: false,
            renderHeaders: true,
            renderFooters: true,
          });
          // Pagination is measured, so the fonts and pictures have to be in place first.
          await settleWordLayout(box);
          if (!alive) return;
          paginateWord(box);
          // Measured before any zoom: `offsetWidth` is the paper's own width, and every later
          // scale is computed against it rather than against the currently zoomed rendering.
          const page = box.querySelector<HTMLElement>(".docx-wrapper > section.docx");
          setPaperWidth(page?.offsetWidth ?? 0);
          setRoomWidth(box.clientWidth);
          // The renderer has just written the pages in, so the count is final here.
          setWordPage({
            index: 1,
            total: box.querySelectorAll(".docx-wrapper > section.docx").length,
          });
        } else if (kind === "sheet" && stat.bytes > MAX_BYTES) {
          // Too big to hand to a whole-file parser: read the shape now, and one sheet at a
          // time as it is shown. A file this size that is not an OOXML zip has no reader
          // that does not build every cell first, so it is refused instead.
          const book = await openXlsxBook(raw);
          if (book) {
            if (!alive) return;
            bookRef.current = book;
            rawRef.current = raw;
            setSheetNames(book.names);
          } else {
            throw new Error(`office_too_large:${Math.max(1, Math.round(stat.bytes / 1024 / 1024))}`);
          }
        } else if (kind === "sheet") {
          // Pictures first: the cells they sit in are drawn as pictures rather than as the
          // `DISPIMG` formula text, and a row that holds nothing but a picture is still a row.
          let pictures: SheetImages = {};
          try {
            pictures = await readSheetImages(raw);
          } catch {
            pictures = {};
          }
          if (!alive) {
            releaseSheetImages(pictures);
            return;
          }
          const view = await readWorkbook(raw, pictures);
          if (!alive) {
            releaseSheetImages(pictures);
            return;
          }
          imagesRef.current = pictures;
          setSheets(view);
          setImages(pictures);
        } else {
          const { init } = await import("pptx-preview");
          if (!alive) return;
          // The deck is laid out at the canvas it is given, so the pane's own width is the
          // right one: a wider canvas than the pane would push every slide out of view.
          const width = Math.max(
            SLIDE_MIN_WIDTH,
            Math.min(SLIDE_WIDTH, Math.round(box.clientWidth) || SLIDE_WIDTH)
          );
          const previewer = init(box, {
            width,
            height: Math.round((width * SLIDE_HEIGHT) / SLIDE_WIDTH),
            mode: "list",
          });
          deck.current = previewer;
          const parsed = (await previewer.preview(raw)) as { slides?: unknown[] } | undefined;
          // A deck the reader could not make sense of resolves with no slides rather than
          // failing, and an empty black canvas is the one answer that helps nobody.
          if (!parsed?.slides?.length) throw new Error("office_no_slides");
        }
        if (alive) setLoading(false);
      } catch (e) {
        if (!alive) return;
        setError(failure(e));
        setLoading(false);
      }
    })();

    return () => {
      alive = false;
      deck.current?.destroy();
      deck.current = null;
      releaseSheetImages(imagesRef.current);
      imagesRef.current = null;
      box.replaceChildren();
    };
  }, [path, kind, csvText]);

  /**
   * The sheet a large workbook is showing.
   *
   * Only one sheet is held at a time: switching releases the pictures of the sheet leaving and
   * reads the rows of the sheet arriving, so what is in memory follows the sheet on screen
   * rather than the whole workbook.
   */
  useEffect(() => {
    const book = bookRef.current;
    const raw = rawRef.current;
    const name = sheetNames?.[active];
    if (!book || !raw || !name) return;
    let alive = true;
    let published = false;
    setLazySheet(null);
    void (async () => {
      let pictures: SheetImages = {};
      try {
        pictures = await readSheetImages(raw, name);
      } catch {
        pictures = {};
      }
      try {
        if (!alive) return;
        const occupied = new Set(Object.keys(pictures[name]?.cells ?? {}));
        const rows = await book.read(active, occupied);
        if (!alive) return;
        const previous = imagesRef.current;
        imagesRef.current = pictures;
        published = true;
        setImages(pictures);
        if (previous) releaseSheetImages(previous);
        setLazySheet({ name, ...rows });
      } catch (e) {
        if (alive) setError(failure(e));
      } finally {
        if (!alive && !published) releaseSheetImages(pictures);
      }
    })();
    return () => {
      alive = false;
    };
  }, [active, sheetNames]);

  /** The sheet on screen: from the whole-workbook read, or read for this tab alone. */
  const sheet = sheets ? (sheets[active] ?? null) : lazySheet;
  /** The tabs: every sheet of a parsed workbook, or just the names of a large one. */
  const sheetTabs = sheets?.map((view) => view.name) ?? sheetNames;
  /** The pictures of the sheet on screen. Memoized: the measuring effect keys on it. */
  const pictures = useMemo<SheetImage[]>(
    () => (sheet ? (images?.[sheet.name]?.images ?? []) : []),
    [images, sheet]
  );
  /** Pictures stored inside the cells of the sheet on screen, keyed `"row:col"`. */
  const cellImages = useMemo<Record<string, CellPicture>>(
    () => (sheet ? (images?.[sheet.name]?.cells ?? {}) : {}),
    [images, sheet]
  );
  /** Every column the sheet uses, which is how wide a record can be. */
  const sheetCols = useMemo(
    () => (sheet ? sheet.rows.reduce((width, row) => Math.max(width, row.length), 0) : 0),
    [sheet]
  );
  /** Sheet rows that hold an in-cell picture, so a picture-only row is still a record. */
  const pictureRows = useMemo(() => {
    const set = new Set<number>();
    for (const key of Object.keys(cellImages)) set.add(Number(key.split(":", 1)[0]));
    return set;
  }, [cellImages]);
  /**
   * The title of each column, taken from the title block above the records.
   *
   * A title can be spelled over several rows — a group heading above a sub-heading, or one
   * merged cell down the column — so the block is read row by row and the parts joined. A
   * column whose cells are all empty simply has no title.
   */
  const titles = useMemo<string[]>(() => {
    // Titles off means the sheet has no title block at all; every row is data.
    if (!showTitles || !sheet || sheetCols === 0) return [];
    const byRow = new Map<number, number>();
    sheet.rowNumbers.forEach((row, index) => byRow.set(row, index));
    const parts: string[][] = Array.from({ length: sheetCols }, () => []);
    for (let offset = 0; offset < titleRows; offset += 1) {
      const index = byRow.get(titleRow - 1 + offset);
      if (index === undefined) continue;
      const row = sheet.rows[index] ?? [];
      for (let column = 0; column < sheetCols; column += 1) {
        const text = (row[column] ?? "").trim();
        // A merged title writes its text in the first cell only; joining non-empty parts
        // keeps it once instead of repeating the same line for every row it covers.
        if (text && !parts[column].includes(text)) parts[column].push(text);
      }
    }
    return parts.map((column) => column.join(" "));
  }, [showTitles, sheet, sheetCols, titleRow, titleRows]);
  /**
   * The data rows, each one a record.
   *
   * One row is one record: a grid makes a sheet of records hard to read, most of all when a
   * cell is a picture, so the record view turns the row into a column of fields. The title
   * block is not a record. A row that holds nothing at all is left out; one whose only
   * content is a picture stays, because the picture is the record.
   */
  const records = useMemo<SheetRecord[]>(() => {
    if (!sheet) return [];
    // With titles hidden there is no title block to skip, so the first row is the first
    // record — the same place the grid starts.
    const first = showTitles ? titleRow - 1 : -1;
    const last = showTitles ? first + titleRows - 1 : -1;
    const out: SheetRecord[] = [];
    sheet.rows.forEach((row, index) => {
      const rowNumber = sheet.rowNumbers[index] ?? index;
      if (rowNumber >= first && rowNumber <= last) return;
      if (!pictureRows.has(rowNumber) && row.every((cell) => cell === "")) return;
      out.push({ row: rowNumber, cells: row });
    });
    return out;
  }, [sheet, pictureRows, showTitles, titleRow, titleRows]);
  const current = records.length === 0 ? -1 : Math.min(record, records.length - 1);
  const item = current >= 0 ? records[current] : null;
  /** Floating pictures anchored over the current record's row. */
  const itemPictures = useMemo<SheetImage[]>(() => {
    if (!item) return [];
    return pictures.filter(
      (image) => image.from.row <= item.row && item.row <= (image.to?.row ?? image.from.row)
    );
  }, [pictures, item]);

  /** Another sheet is another list; the record index does not carry over. */
  useEffect(() => {
    setRecord(0);
    setJump("1");
  }, [path, active]);

  // The page number is an input, so it follows whatever the arrows, keys or a jump select.
  useEffect(() => {
    if (current >= 0) setJump(String(current + 1));
  }, [current]);

  const step = (delta: number) => {
    if (records.length === 0) return;
    // The counter walks a ring: the first record's "previous" is the last one and the last
    // record's "next" is the first, so neither arrow is a dead end.
    setRecord((current + delta + records.length) % records.length);
  };

  /**
   * Width of the title column, once the user has dragged it; null lets the column take the
   * width of its longest title, which is the width it needs to be read without wrapping.
   */
  const [labelWidth, setLabelWidth] = useState<number | null>(null);

  /** The divider between titles and data: drag it left or right to re-measure the column. */
  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    const card = event.currentTarget.closest<HTMLElement>(".office-record-card");
    const label = card?.querySelector<HTMLElement>(".office-record-label");
    if (!card || !label) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = label.getBoundingClientRect().width;
    // Keep a readable slice of the data side no matter how far the divider is dragged.
    const max = Math.max(60, card.clientWidth - 160);
    const move = (moveEvent: PointerEvent) => {
      const width = startWidth + moveEvent.clientX - startX;
      setLabelWidth(Math.round(Math.min(Math.max(width, 60), max)));
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };

  /** Jump to the record the user typed, counting from one like the counter shows. */
  const jumpTo = () => {
    const parsed = Math.trunc(Number(jump));
    if (records.length === 0 || !Number.isFinite(parsed)) return;
    setRecord(Math.min(Math.max(parsed, 1), records.length) - 1);
  };

  /** A title-block number the user typed, kept to a whole row inside the sheet. */
  const titleNumber = (value: string, min: number) => {
    const parsed = Math.trunc(Number(value));
    return Number.isFinite(parsed) ? Math.min(Math.max(parsed, min), MAX_ROWS) : min;
  };
  const changeTitleRow = (value: string) => {
    setTitleRow(titleNumber(value, 1));
    setRecord(0);
  };
  const changeTitleRows = (value: string) => {
    // Zero title rows is a sheet without a header: then every row is a record.
    setTitleRows(titleNumber(value, 0));
    setRecord(0);
  };

  /** Typing arrows should move the record, so the view takes focus when it appears. */
  useEffect(() => {
    if (mode === "records") recordsRef.current?.focus();
  }, [mode]);

  /**
   * The grid is grown to hold the pictures.
   *
   * A sheet can be nothing but a picture — an empty cell range with a photograph anchored at
   * C3 — and a table with no cells there has nowhere to measure the anchor from.
   */
  const drawn = useMemo(() => {
    const extent = pictures.reduce(
      (acc, image) => ({
        rows: Math.max(acc.rows, (image.to?.row ?? image.from.row) + 1),
        cols: Math.max(acc.cols, (image.to?.col ?? image.from.col) + 1),
      }),
      { rows: 0, cols: 0 }
    );
    const cells = sheet ? sheet.rows.reduce((w, row) => Math.max(w, row.length), 0) : 0;
    const rows = sheet ? Math.max(sheet.rows.length, Math.min(extent.rows, MAX_ROWS)) : 0;
    const rowNumbers = sheet ? sheet.rowNumbers.slice(0, rows) : [];
    // Rows added for a picture below the last row of data have no number of their own.
    let next = rowNumbers.length > 0 ? rowNumbers[rowNumbers.length - 1] + 1 : 0;
    while (rowNumbers.length < rows) {
      rowNumbers.push(next);
      next += 1;
    }
    return {
      rows,
      cols: sheet ? Math.max(1, Math.min(Math.max(cells, extent.cols), MAX_COLS)) : 0,
      rowNumbers,
    };
  }, [sheet, pictures]);
  /** Sheet row number -> drawn row index; rows left out for being blank have no entry. */
  const drawnRow = useMemo(() => {
    const map = new Map<number, number>();
    drawn.rowNumbers.forEach((row, index) => map.set(row, index));
    return map;
  }, [drawn]);

  const tableRef = useRef<HTMLTableElement>(null);
  const [placed, setPlaced] = useState<PlacedImage[]>([]);

  /**
   * Measure each picture onto the table.
   *
   * An anchor is a cell and an offset inside it, which only means pixels once the table has
   * been laid out — column widths come from the content and from the sheet's own proportions.
   * So the positions are read from the cells themselves, and read again whenever the table
   * changes size.
   */
  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table || pictures.length === 0) {
      setPlaced([]);
      return;
    }
    const measure = () => {
      const base = table.getBoundingClientRect();
      // The row-number gutter is the first cell of every row. An anchor names a sheet row,
      // which is not the table's row index once blank rows have been left out.
      const corner = (col: number, row: number) => {
        const index = drawnRow.get(row);
        if (index === undefined) return null;
        const cell = table.tBodies[0]?.rows[index]?.cells[col + 1] as HTMLElement | undefined;
        if (!cell) return null;
        const rect = cell.getBoundingClientRect();
        return { left: rect.left - base.left, top: rect.top - base.top };
      };
      const out: PlacedImage[] = [];
      pictures.forEach((image, index) => {
        const start = corner(image.from.col, image.from.row);
        if (!start) return;
        const left = start.left + image.from.colOff / EMU_PER_PX;
        const top = start.top + image.from.rowOff / EMU_PER_PX;
        let width = image.width ?? 0;
        let height = image.height ?? 0;
        if (image.to) {
          const end = corner(image.to.col, image.to.row);
          if (!end) return;
          width = end.left + image.to.colOff / EMU_PER_PX - left;
          height = end.top + image.to.rowOff / EMU_PER_PX - top;
        }
        // A stretched-away anchor (or a cell cut off by the row cap) is not worth a box.
        if (width < 4 || height < 4) return;
        out.push({ key: `${index}:${image.url}`, url: image.url, left, top, width, height });
      });
      setPlaced(out);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [pictures, drawnRow, drawn.cols, mode]);

  /**
   * The page under the reading mark — a third of the way down the pane, so the indicator
   * changes when the next page really has the eye, not when its edge appears at the bottom.
   */
  const readWordPage = () => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const pages = scroller.querySelectorAll<HTMLElement>(".docx-wrapper > section.docx");
    const total = pages.length;
    if (total === 0) {
      setWordPage((current) => (current.total === 0 ? current : { index: 0, total: 0 }));
      return;
    }
    const mark = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.35;
    let index = total;
    for (let i = 0; i < total; i += 1) {
      if (pages[i].getBoundingClientRect().bottom > mark) {
        index = i + 1;
        break;
      }
    }
    setWordPage((current) =>
      current.index === index && current.total === total ? current : { index, total }
    );
  };

  /** Keep the page chip in step with the scroll, at most once a frame. */
  const trackWordPage = () => {
    if (pageFrame.current !== 0) return;
    pageFrame.current = window.requestAnimationFrame(() => {
      pageFrame.current = 0;
      readWordPage();
    });
  };

  useEffect(() => () => window.cancelAnimationFrame(pageFrame.current), []);

  /**
   * The page width that fills the pane.
   *
   * Capped at 2×: a page is a fixed piece of paper, and blowing it up to fill an ultrawide
   * window would make a document out of a paragraph. The floor keeps a very narrow pane from
   * shrinking a page to something unreadable — sideways scrolling is the better trade there.
   */
  const wordFit =
    paperWidth > 0 && roomWidth > 0
      ? Math.min(2, Math.max(0.25, roomWidth / paperWidth))
      : 1;
  /** What the reader is actually looking at, in percent: their choice, or what fit comes to. */
  const wordShown = wordZoom ?? Math.round(wordFit * 100);

  useEffect(() => {
    setWordDraft(String(wordShown));
  }, [wordShown]);

  /** A resized window changes what "fit" means, so the pane's width is tracked while it shows. */
  useEffect(() => {
    if (kind !== "word") return;
    const box = host.current;
    if (!box) return;
    const update = () => {
      setRoomWidth(box.clientWidth);
      // A wider pane means a different reading mark, so the page may have changed.
      readWordPage();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(box);
    return () => observer.disconnect();
  }, [kind, path]);

  /** The floating panel is dismissed the way a menu is: a click elsewhere, or Escape. */
  useEffect(() => {
    if (!wordTools) return;
    const dismiss = (event: PointerEvent) => {
      if (!wordToolsRef.current?.contains(event.target as Node)) setWordTools(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWordTools(false);
    };
    window.addEventListener("pointerdown", dismiss);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", dismiss);
      window.removeEventListener("keydown", escape);
    };
  }, [wordTools]);

  // Zoom is applied to the renderer's own wrapper rather than to the pane: the pane keeps the
  // full width, so a page magnified past the window scrolls sideways instead of being clipped,
  // and the pages stay centred while they are smaller than it.
  useLayoutEffect(() => {
    const box = host.current;
    if (!box || kind !== "word" || paperWidth <= 0) return;
    const target = box.querySelector<HTMLElement>(".docx-wrapper") ?? box;
    target.style.zoom = String(wordZoom === null ? wordFit : wordZoom / 100);
    // Scaling moves every page under the reading mark; re-read once layout has settled.
    trackWordPage();
  }, [kind, paperWidth, wordFit, wordZoom]);

  /** Walk the steps; from a fit size the first click lands on the next step either way. */
  const stepWordZoom = (delta: number) => {
    const next = WORD_STEPS.find((step) =>
      delta > 0 ? step > wordShown : step < wordShown
    );
    setWordZoom(next ?? (delta > 0 ? WORD_MAX_ZOOM : WORD_MIN_ZOOM));
  };

  /** A typed size; an empty box goes back to fit, the way clearing the PDF box does. */
  const applyWordDraft = (value: string) => {
    const parsed = Math.round(Number(value.replace("%", "").trim()));
    if (value.trim() === "" || !Number.isFinite(parsed) || parsed <= 0) {
      setWordZoom(null);
      return;
    }
    setWordZoom(wordClamp(parsed));
  };

  return (
    <div
      className={`office-view office-${kind}`}
      style={{ "--word-paper": paper } as CSSProperties}
    >
      {kind === "sheet" && sheetTabs && sheetTabs.length > 0 && (
        <div className="office-sheet-bar">
          {mode === "records" && (
            <div className="office-record-config">
              <label>
                <input
                  type="checkbox"
                  checked={showTitles}
                  onChange={(event) => {
                    setShowTitles(event.target.checked);
                    // Hiding the titles makes the first row a record; show that row.
                    setRecord(0);
                  }}
                />
                {t("office.recordShowTitle")}
              </label>
              {showTitles && (
                <>
                  <label>
                    {t("office.recordTitleRow")}
                    <input
                      type="number"
                      min={1}
                      max={MAX_ROWS}
                      value={titleRow}
                      onChange={(event) => changeTitleRow(event.target.value)}
                    />
                  </label>
                  <label>
                    {t("office.recordTitleRows")}
                    <input
                      type="number"
                      min={0}
                      max={MAX_ROWS}
                      value={titleRows}
                      onChange={(event) => changeTitleRows(event.target.value)}
                    />
                  </label>
                </>
              )}
            </div>
          )}
          <div className="office-view-switch" role="group" aria-label={t("office.viewMode")}>
            <button
              type="button"
              className={mode === "grid" ? "active" : ""}
              aria-pressed={mode === "grid"}
              onClick={() => setMode("grid")}
            >
              {t("office.gridView")}
            </button>
            <button
              type="button"
              className={mode === "records" ? "active" : ""}
              aria-pressed={mode === "records"}
              onClick={() => setMode("records")}
            >
              {t("office.recordView")}
            </button>
          </div>
        </div>
      )}
      {kind === "word" && !loading && !error && (
        <div className="office-word-tools" ref={wordToolsRef}>
          {wordTools && (
            <div
              className="office-word-panel"
              role="dialog"
              aria-label={t("office.viewOptions")}
            >
              <div className="office-word-row">
                <span className="office-word-label">{t("office.zoom")}</span>
                <button
                  type="button"
                  className="pdf-tool"
                  title={t("img.zoomOut")}
                  onClick={() => stepWordZoom(-1)}
                  disabled={wordShown <= WORD_MIN_ZOOM}
                >
                  −
                </button>
                {/* A plain number, like the PDF viewer's: a reader who knows the size they
                    want should be able to type it, and while fitted the box reports what fit
                    comes to. */}
                <span className="zoom-box">
                  <input
                    className="zoom-input"
                    type="text"
                    inputMode="numeric"
                    title={t("office.zoom")}
                    aria-label={t("office.zoom")}
                    placeholder={t("office.fitWidth")}
                    value={wordDraft}
                    onChange={(event) => setWordDraft(event.target.value)}
                    onBlur={(event) => applyWordDraft(event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                  />
                  <span className="zoom-unit">%</span>
                </span>
                <button
                  type="button"
                  className="pdf-tool"
                  title={t("img.zoomIn")}
                  onClick={() => stepWordZoom(1)}
                  disabled={wordShown >= WORD_MAX_ZOOM}
                >
                  +
                </button>
              </div>
              <div className="office-word-row">
                <button
                  type="button"
                  className={`pdf-tool zoom-fit${wordZoom === null ? " on" : ""}`}
                  title={t("office.fitWidth")}
                  aria-pressed={wordZoom === null}
                  onClick={() => setWordZoom(null)}
                >
                  {t("office.fitWidth")}
                </button>
                <button
                  type="button"
                  className={`pdf-tool zoom-fit${wordGaps ? "" : " on"}`}
                  title={t("office.hideGaps")}
                  aria-pressed={!wordGaps}
                  onClick={() => setWordGaps((show) => !show)}
                >
                  {t("office.hideGaps")}
                </button>
              </div>
              <div className="office-word-row">
                <span className="office-word-label">{t("pdf.paper")}</span>
                <WordPaperPicker value={paper} onChange={onSavePaper} />
              </div>
            </div>
          )}
          <button
            type="button"
            className={`office-word-fab${wordTools ? " open" : ""}`}
            title={t("office.viewOptions")}
            aria-label={t("office.viewOptions")}
            aria-expanded={wordTools}
            aria-haspopup="dialog"
            onClick={() => setWordTools((open) => !open)}
          >
            <IconSliders size={17} />
          </button>
        </div>
      )}
      {kind === "word" && wordPage.total > 0 && (
        <div
          className="office-word-page"
          title={t("office.pageOf", { n: wordPage.index, total: wordPage.total })}
        >
          {wordPage.index} / {wordPage.total}
        </div>
      )}
      <div
        className="office-scroll"
        ref={scrollRef}
        onScroll={kind === "word" ? trackWordPage : undefined}
      >
        {kind === "sheet" && sheet && mode === "records" ? (
          <div
            className="office-records"
            ref={recordsRef}
            tabIndex={0}
            onKeyDown={(event) => {
              // Typing in the page number is not navigation; its arrows belong to the caret.
              if ((event.target as HTMLElement).closest("input, textarea, select")) return;
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              // The arrows belong to the record: without this they also scroll the pane and
              // reach the editor hidden behind it.
              event.preventDefault();
              event.stopPropagation();
              step(event.key === "ArrowRight" ? 1 : -1);
            }}
          >
            {item ? (
              <>
                <div
                  className={`office-record-card${showTitles ? "" : " no-titles"}`}
                  style={
                    labelWidth == null
                      ? undefined
                      : { gridTemplateColumns: `${labelWidth}px minmax(0, 1fr)` }
                  }
                >
                  {Array.from({ length: sheetCols }, (_, column) => {
                    const value = item.cells[column] ?? "";
                    const picture = cellImages[`${item.row}:${column}`];
                    const title = titles[column] ?? "";
                    // A column the sheet never uses is not a field. An empty cell under a
                    // title still is, so a record keeps the same shape from row to row —
                    // unless the titles are hidden, when an empty field says nothing.
                    if (!value && !picture && (!showTitles || !title)) return null;
                    return (
                      <div className="office-record-field" key={column}>
                        {showTitles && (
                          <div className="office-record-label">
                            {title}
                            {/* The drag handle rides on the column's edge; every field carries
                                one so the divider can be grabbed anywhere down the card. */}
                            <div
                              className="office-record-divider"
                              role="separator"
                              aria-orientation="vertical"
                              onPointerDown={startResize}
                            />
                          </div>
                        )}
                        <div className="office-record-value">
                          {picture ? (
                            <img className="office-record-image" src={picture.url} alt="" />
                          ) : value ? (
                            value
                          ) : (
                            <span className="office-record-blank">—</span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {itemPictures.length > 0 && (
                    <div className="office-record-floats">
                      {itemPictures.map((picture) => (
                        <img
                          key={picture.url}
                          className="office-record-image"
                          src={picture.url}
                          alt=""
                        />
                      ))}
                    </div>
                  )}
                </div>
                <div className="office-record-count">
                  <button
                    type="button"
                    className="office-record-page-arrow prev"
                    aria-label={t("office.recordsPrev")}
                    onClick={() => step(-1)}
                  >
                    <IconChevron size={16} />
                  </button>
                  <input
                    className="office-record-page-input"
                    type="number"
                    min={1}
                    max={records.length}
                    value={jump}
                    aria-label={t("office.recordJumpPlaceholder")}
                    onChange={(event) => setJump(event.target.value)}
                    onBlur={() => setJump(String(current + 1))}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter") return;
                      event.preventDefault();
                      event.stopPropagation();
                      jumpTo();
                    }}
                  />
                  <span className="office-record-page-total">/ {records.length}</span>
                  <button
                    type="button"
                    className="office-record-page-arrow next"
                    aria-label={t("office.recordsNext")}
                    onClick={() => step(1)}
                  >
                    <IconChevron size={16} />
                  </button>
                </div>
              </>
            ) : (
              <div className="office-empty">{t("office.noRecords")}</div>
            )}
          </div>
        ) : kind === "sheet" && sheet ? (
          <div className="office-grid-wrap">
            <table className="office-grid" ref={tableRef}>
              <thead>
                <tr>
                  <th className="office-grid-gutter" />
                  {Array.from({ length: drawn.cols }, (_, index) => (
                    <th key={index}>{columnName(index)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: drawn.rows }, (_, rowIndex) => {
                  const row = sheet.rows[rowIndex] ?? [];
                  const rowNumber = drawn.rowNumbers[rowIndex] ?? rowIndex;
                  return (
                    <tr key={rowIndex}>
                      <th className="office-grid-gutter">{rowNumber + 1}</th>
                      {Array.from({ length: drawn.cols }, (_, cellIndex) => {
                        const picture = cellImages[`${rowNumber}:${cellIndex}`];
                        return (
                          <td key={cellIndex}>
                            {picture ? (
                              <img className="office-cell-image" src={picture.url} alt="" />
                            ) : (
                              (row[cellIndex] ?? "")
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {/* The pictures sit above the cells rather than inside them: one anchor can
                cover a range, and a grid cell cannot. */}
            {placed.length > 0 && (
              <div className="office-grid-pictures" aria-hidden>
                {placed.map((picture) => (
                  <img
                    key={picture.key}
                    src={picture.url}
                    alt=""
                    style={{
                      left: picture.left,
                      top: picture.top,
                      width: picture.width,
                      height: picture.height,
                    }}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          // The renderers write their own markup into this element: React must not own it.
          <div
            className={`office-doc${kind === "word" && !wordGaps ? " tight" : ""}`}
            ref={host}
          />
        )}
        {kind === "sheet" && sheetTabs && sheetTabs.length === 0 && (
          <div className="office-empty">{t("office.noSheets")}</div>
        )}
        {sheet?.truncated && (
          <div className="office-note">
            {t("office.truncated", { rows: MAX_ROWS, cols: MAX_COLS })}
          </div>
        )}
        {sheet && (images?.[sheet.name]?.skipped ?? 0) > 0 && (
          <div className="office-note">
            {t("office.picturesHidden", { n: images?.[sheet.name]?.skipped ?? 0 })}
          </div>
        )}
        {loading && <div className="office-status">{t("app.loading")}</div>}
        {error && <div className="office-status office-error">{error}</div>}
      </div>

      {sheetTabs && sheetTabs.length > 1 && (
        <div className="office-sheet-tabs" role="tablist">
          {sheetTabs.map((name, index) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={index === active}
              className={`office-sheet-tab${index === active ? " active" : ""}`}
              onClick={() => setActive(index)}
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
