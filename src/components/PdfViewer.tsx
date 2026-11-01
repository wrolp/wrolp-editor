import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
// The legacy build, not the default one: pdf.js now calls `Map.prototype.getOrInsertComputed`,
// which the webview on an older Windows may not have. The legacy build carries that polyfill
// for both the API and the worker, and costs only a few dozen kilobytes over the default build.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { t, translateError } from "../lib/i18n";
import { api } from "../lib/tauri";
import { stepFrom, zoomText } from "../lib/zoom";
import {
  IconBookmark,
  IconCollapse,
  IconCollapseAll,
  IconExpandAll,
  IconOutline,
  IconSliders,
} from "./icons";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  path: string;
  /** A `#rrggbb` colour for the page itself, or `night` to invert it; white leaves it untouched. */
  paper: string;
  onSavePaper: (value: string) => void;
  /** Which edge the bookmark column takes when it is open. */
  outlineSide: "left" | "right";
}

/** Zoom levels the buttons walk, as a percentage of the page's own size. `null` means "fit". */
const STEPS = [50, 75, 100, 150, 200, 300];
/** The range a typed percentage is held to, so a mistyped zero cannot make a page unusable. */
const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
/** Pixels per second the automatic scroll moves, the range the slider offers, and one nudge. */
const SPEED_MIN = 10;
const SPEED_MAX = 240;
const SPEED_STEP = 1;
const SPEED_DEFAULT = 40;
/** How long the tools stay after the pointer leaves them, before they slide away. */
const TOOLS_CLOSE_DELAY = 2500;

/** Night is a mode rather than a colour: the page is inverted, not tinted. */
const NIGHT_PAPER = "night";

/**
 * Papers worth one click: the white a document is written for, the two tints eyes rest on, and
 * the inverted sheet for a dark room. Anything else is asked of the browser's own picker, which
 * is why the last control is a colour input rather than a longer list of names that would have
 * to be described instead of shown.
 *
 * `swatch` is what the button paints, which is not the value for night: half light and half
 * dark says "the page turns over", where a plain dark square would only say "black".
 */
const PAPERS = [
  { value: "#ffffff", label: "pdf.paperWhite", swatch: "#ffffff" },
  { value: "#f4ecd8", label: "pdf.paperSepia", swatch: "#f4ecd8" },
  { value: "#c7edcc", label: "pdf.paperGreen", swatch: "#c7edcc" },
  { value: NIGHT_PAPER, label: "pdf.paperNight", swatch: "linear-gradient(135deg, #191919 50%, #e6e6e6 50%)" },
];

/**
 * The row that picks the colour of the sheet.
 *
 * Every control is a swatch of what it would paint, so the choice is made on the colour rather
 * than on a word for it, and the row is the same one the picture backdrop uses — a colour is a
 * colour, whichever surface it ends up on.
 */
function PaperPicker({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const preset = PAPERS.some((item) => item.value === value);
  /**
   * The sheet to come back to when night is switched off.
   *
   * Night is a mode, not a colour, so the control that turns it on turns it off again: a reader
   * who clicks the half-dark chip a second time is asking for their paper back, not for another
   * click on the mode they are already in.
   */
  const daylight = useRef("#ffffff");
  useEffect(() => {
    if (value !== NIGHT_PAPER) daylight.current = value;
  }, [value]);

  return (
    <div className="pdf-papers" role="group" aria-label={t("pdf.paper")}>
      {PAPERS.map((item) => {
        const active = value === item.value;
        const leavingNight = active && item.value === NIGHT_PAPER;
        return (
          <button
            key={item.value}
            type="button"
            className={`pdf-paper${active ? " active" : ""}`}
            style={{ background: item.swatch }}
            title={t(leavingNight ? "pdf.paperNightOff" : item.label)}
            aria-label={t(item.label)}
            aria-pressed={active}
            onClick={() => onChange(leavingNight ? daylight.current : item.value)}
          />
        );
      })}
      <label
        className={`pdf-paper is-custom${preset ? "" : " active"}`}
        style={preset ? undefined : { background: value }}
        title={t("pdf.paperCustom")}
      >
        {/* The invisible input still receives the click, which is what opens the system dialog;
            the label wears the colour, so the swatch is the control's only face. */}
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

/** One entry of a PDF's outline: a title, what it points at, and what sits under it. */
interface Bookmark {
  title: string;
  /** A named destination, or the explicit array pdf.js resolved it to; null when it has none. */
  dest: unknown;
  items: Bookmark[];
}

/** The tree `getOutline` answers with, before it is cut down to what a list of links needs. */
type RawOutline = readonly { title?: string; dest?: unknown; items?: RawOutline }[];

/**
 * The outline, keeping only entries a list can show.
 *
 * A title with no text is a separator or a placeholder in the file, and a row with nothing to
 * click would read as a broken bookmark; dropping it keeps the tree's shape and its indices
 * consistent with what is on screen.
 */
function toBookmarks(nodes: RawOutline): Bookmark[] {
  const out: Bookmark[] = [];
  for (const node of nodes) {
    const title = (node.title ?? "").trim();
    if (!title) continue;
    out.push({
      title,
      dest: node.dest ?? null,
      items: node.items ? toBookmarks(node.items) : [],
    });
  }
  return out;
}

/**
 * Every branch path that still has entries under it, so "collapse all" can put them away at once.
 * Mirrors the `path/${index}` keys `BookmarkList` builds, so the same `folded` set covers both.
 */
function allBranchKeys(items: Bookmark[], path = ""): string[] {
  const keys: string[] = [];
  items.forEach((item, index) => {
    const key = `${path}/${index}`;
    if (item.items.length > 0) {
      keys.push(key);
      keys.push(...allBranchKeys(item.items, key));
    }
  });
  return keys;
}

/**
 * The outline as nested lists.
 *
 * Recursive rather than flattened: a PDF's bookmarks are a tree, and a flat column of titles
 * would lose the shape that makes a long one navigable. Every branch that has entries under it
 * can be folded, so a reader can keep an overview of a long document instead of scrolling past
 * every subsection.
 *
 * The arrow is a control of its own rather than part of the title's button: clicking it folds
 * the branch, while clicking the title still takes the reader to the page it names — one row,
 * two intents, neither of them guessing at the other.
 */
function BookmarkList({
  items,
  path,
  folded,
  onGo,
  onFold,
}: {
  items: Bookmark[];
  /** This list's place in the tree, so one branch is remembered apart from the next. */
  path: string;
  /** The branches whose entries are put away, by path. */
  folded: ReadonlySet<string>;
  onGo: (dest: unknown) => void;
  onFold: (path: string) => void;
}) {
  return (
    <ul className="pdf-outline-list">
      {items.map((item, index) => {
        const key = `${path}/${index}`;
        const open = !folded.has(key);
        const hasItems = item.items.length > 0;
        const twistLabel = t(open ? "pdf.outlineCollapse" : "pdf.outlineExpand", {
          title: item.title,
        });
        return (
          <li key={key}>
            <div className="pdf-outline-row">
              {hasItems ? (
                <button
                  type="button"
                  className="pdf-outline-twist"
                  title={twistLabel}
                  aria-label={twistLabel}
                  aria-expanded={open}
                  onClick={() => onFold(key)}
                >
                  {open ? "−" : "+"}
                </button>
              ) : null}
              <button
                type="button"
                className="pdf-outline-link"
                title={item.title}
                onClick={() => onGo(item.dest)}
              >
                <IconBookmark size={13} />
                <span className="pdf-outline-title">{item.title}</span>
              </button>
            </div>
            {hasItems && open && (
              <BookmarkList
                items={item.items}
                path={key}
                folded={folded}
                onGo={onGo}
                onFold={onFold}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** An affine matrix as pdf.js passes one around: `[a, b, c, d, e, f]`. */
type Matrix = [number, number, number, number, number, number];

/** `m2` applied first, then `m1` — the order pdf.js's own `Util.transform(m1, m2)` uses. */
function compose(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** Past this many pictures a page is treated as a sheet of pictures, and is left whole. */
const MAX_HOLES = 300;

/**
 * Where the pictures on a page sit, as fractions of the page.
 *
 * pdf.js draws a picture into the unit square under whatever matrix is in force, so walking the
 * operator list and keeping that matrix is enough to know the outline: nothing is rendered a
 * second time and no pixels are read. Image masks are left out on purpose — those are stencils
 * drawn as shapes, and a shape that stays dark on a dark page would simply disappear.
 */
function imageRects(ops: { fnArray: number[]; argsArray: unknown[] }, viewport: pdfjs.PageViewport) {
  const rects: { x: number; y: number; w: number; h: number }[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  for (let i = 0; i < ops.fnArray.length; i += 1) {
    const fn = ops.fnArray[i];
    if (fn === pdfjs.OPS.save) {
      stack.push(ctm);
    } else if (fn === pdfjs.OPS.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === pdfjs.OPS.transform) {
      ctm = compose(ctm, ops.argsArray[i] as Matrix);
    } else if (fn === pdfjs.OPS.paintFormXObjectBegin) {
      // A form draws its content inline, behind a matrix of its own: the same save-and-transform
      // the canvas renderer performs, so pictures nested in forms are not missed.
      stack.push(ctm);
      const form = (ops.argsArray[i] as [Matrix | null, unknown])[0];
      if (form) ctm = compose(ctm, form);
    } else if (fn === pdfjs.OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === pdfjs.OPS.paintImageXObject || fn === pdfjs.OPS.paintInlineImageXObject) {
      const m = compose(viewport.transform as Matrix, ctm);
      // The four corners of the unit square under the matrix, then the box around them.
      const xs = [m[4], m[0] + m[4], m[0] + m[2] + m[4], m[2] + m[4]];
      const ys = [m[5], m[1] + m[5], m[1] + m[3] + m[5], m[3] + m[5]];
      const x = Math.min(...xs) / viewport.width;
      const y = Math.min(...ys) / viewport.height;
      const w = (Math.max(...xs) - Math.min(...xs)) / viewport.width;
      const h = (Math.max(...ys) - Math.min(...ys)) / viewport.height;
      if (w > 0 && h > 0) rects.push({ x, y, w, h });
      if (rects.length > MAX_HOLES) return [];
    }
  }
  return rects;
}

/**
 * A mask that is opaque everywhere but the pictures, so the inversion layer can be cut out over
 * them and they keep the colours they were written with.
 *
 * `evenodd` is what makes the inner rectangles holes, and alpha is what both the modern and the
 * prefixed mask properties read from an image — no `mask-mode` support needed.
 */
function holesMask(rects: { x: number; y: number; w: number; h: number }[]): string {
  if (!rects.length) return "";
  const holes = rects
    .map((r) => {
      const x = r.x.toFixed(4);
      const y = r.y.toFixed(4);
      const right = (r.x + r.w).toFixed(4);
      const bottom = (r.y + r.h).toFixed(4);
      return `M${x} ${y}H${right}V${bottom}H${x}Z`;
    })
    .join("");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1" preserveAspectRatio="none">` +
    `<path fill="#fff" fill-rule="evenodd" d="M0 0H1V1H0Z${holes}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/**
 * One page, drawn into a canvas.
 *
 * Pages are drawn lazily: the observer marks a page visible once it is near the viewport, and
 * the canvas only then asks the document for its content. `rendered` keeps a page drawn after
 * it leaves the viewport again — redrawing on every scroll back would make long documents
 * flicker for no gain.
 */
function PdfPage({
  doc,
  index,
  zoom,
  width,
  night,
  onError,
}: {
  doc: pdfjs.PDFDocumentProxy;
  index: number;
  zoom: number | null;
  width: number;
  /** Inverted page; the pictures on it are measured so they can be left alone. */
  night: boolean;
  onError: (message: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(index < 2);
  const [height, setHeight] = useState(0);
  /** Whether the canvas holds this page, as opposed to a frame waiting for it. */
  const [drawn, setDrawn] = useState(false);
  /** The pictures on this page, as a mask for the inversion layer; empty until measured. */
  const [holes, setHoles] = useState("");

  useEffect(() => {
    if (visible) return;
    const node = wrapRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      // A screen ahead: the next page is usually already drawn by the time it is reached.
      { rootMargin: "600px 0px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || width <= 0) return;
    let live = true;
    let task: pdfjs.RenderTask | null = null;
    void (async () => {
      try {
        const page = await doc.getPage(index + 1);
        if (!live) return;
        const base = page.getViewport({ scale: 1 });
        // Fit is measured on the page's own width, so a page whose scan is a different size
        // still fills the pane the same way. The scale folds the device ratio in rather than
        // passing a separate transform, which keeps every display on the one code path the
        // plain browser already exercised.
        const dpr = Math.min(2, window.devicePixelRatio || 1);
        const unit = zoom === null ? width / base.width : zoom / 100;
        const viewport = page.getViewport({ scale: unit * dpr });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) return;
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        setHeight(Math.floor(viewport.height / dpr));
        task = page.render({ canvas, canvasContext: context, viewport });
        await task.promise;
        // Drawn for real, so the frame's height is now the page's own rather than an estimate:
        // the measuring effect below must stop following the pane's width from here on.
        if (live) setDrawn(true);
      } catch (e) {
        // A render this component cancelled itself is not a page that failed: the effect is
        // re-running with a new size, and reporting it would put "rendering cancelled" on a
        // page that is about to be drawn.
        if (!live) return;
        // A page that cannot be drawn leaves its frame empty, but the reason is worth saying:
        // a swallowed failure here is exactly the kind that would read as a blank pane.
        onError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
      task?.cancel();
    };
  }, [doc, index, zoom, width, visible]);

  // A page that has not been drawn yet still holds its place: the list's scrollbar, and a jump
  // from a bookmark, both need the frame to be where the page will be rather than stacked at
  // zero height. The number is the one the render will land on, so the frame does not resize
  // when the page arrives.
  useEffect(() => {
    if (drawn || width <= 0) return;
    let live = true;
    void doc
      .getPage(index + 1)
      .then((page) => {
        if (!live) return;
        const base = page.getViewport({ scale: 1 });
        const unit = zoom === null ? width / base.width : zoom / 100;
        setHeight(Math.floor(base.height * unit));
      })
      .catch(() => {
        // A page that cannot be measured keeps its zero frame; it reports the reason when it
        // draws.
      });
    return () => {
      live = false;
    };
  }, [doc, index, zoom, width, drawn]);

  // Night cuts the pictures out of the inversion layer so a photograph on the page stays the
  // photograph it was. Measured only while the mode is on and the page is near the viewport:
  // listing a page's operations is work, and a page nobody is looking at does not need it.
  useEffect(() => {
    if (!night || !visible) return;
    let live = true;
    void (async () => {
      const page = await doc.getPage(index + 1);
      const ops = await page.getOperatorList();
      if (live) setHoles(holesMask(imageRects(ops, page.getViewport({ scale: 1 }))));
    })().catch(() => {
      // A page whose operations cannot be listed keeps the plain inversion; that page reports
      // the real reason when it draws.
    });
    return () => {
      live = false;
    };
  }, [doc, index, night, visible]);

  return (
    <div
      className="pdf-page"
      ref={wrapRef}
      style={
        {
          ...(height > 0 ? { height } : {}),
          ...(holes ? { "--pdf-holes": holes } : {}),
        } as CSSProperties
      }
      data-page={index + 1}
    >
      <canvas ref={canvasRef} className="pdf-canvas" />
    </div>
  );
}

/**
 * A PDF document, read rather than edited.
 *
 * The file is loaded through the asset protocol, the same route the image preview takes: the
 * bytes stay in the webview's cache instead of being copied through JSON, and a large document
 * costs no extra memory on the way in.
 *
 * The automatic scroll is the reason this exists as its own view: a document read aloud, or a
 * sheet of music, has to move at a pace the reader sets, and a browser's built-in viewer has no
 * way to do that.
 */
export default function PdfViewer({ path, paper, onSavePaper, outlineSide }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjs.PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  /** null fits the pane; a number is a percentage of the page's own size. */
  const [zoom, setZoom] = useState<number | null>(null);
  /** What fitting comes to for the first page, so the size box shows a number rather than a 0. */
  const [fitPercent, setFitPercent] = useState(0);
  /** The text in the size box while it is being typed; committed on Enter or on leaving it. */
  const [zoomDraft, setZoomDraft] = useState("");
  const [width, setWidth] = useState(0);
  const [autoScroll, setAutoScroll] = useState(false);
  const [speed, setSpeed] = useState(SPEED_DEFAULT);
  /** The tools take no room unless they are in use; the tab in the corner brings them back. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** The document's outline, empty when it has none — the tab then has nothing to offer. */
  const [outline, setOutline] = useState<Bookmark[]>([]);
  /** The bookmark column takes no width until the tab asks for it. */
  const [outlineOpen, setOutlineOpen] = useState(false);
  /** The branches put away by the reader, by path; empty means the whole tree is open. */
  const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
  const [atEnd, setAtEnd] = useState(false);
  /** The first page whose render failed, shown instead of letting the pane sit blank. */
  const [pageError, setPageError] = useState<string | null>(null);

  /** What the pane is showing, whether the reader pinned it or the pane chose it. */
  const shownZoom = zoom ?? fitPercent;

  const stepBy = (direction: 1 | -1) => {
    // Stepping from "fit" starts where the pane already is, so a small first nudge from a
    // document fitted at 134% lands on 150 rather than jumping across it.
    setZoom((current) => stepFrom(STEPS, current ?? fitPercent, direction));
  };

  /**
   * Reads the size box: an empty one means fit, a percentage outside the range is brought back
   * into it, and anything that is not a number is a slip that only restores the box.
   */
  const applyZoomDraft = (text: string) => {
    const typed = text.trim();
    if (typed === "") {
      setZoom(null);
      setZoomDraft(zoomText(null, fitPercent));
      return;
    }
    const parsed = Number.parseInt(typed, 10);
    if (Number.isNaN(parsed)) {
      setZoomDraft(zoomText(zoom, fitPercent));
      return;
    }
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parsed));
    // Typing the percentage that fitting already gives is fitting: the box keeps following the
    // pane instead of pinning a size that would stop keeping up with a resize.
    setZoom(next === fitPercent ? null : next);
    setZoomDraft(String(next));
  };

  // The pane's width is what "fit" is measured against, so it is watched rather than assumed.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setWidth(host.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let live = true;
    // The loading task, not the document, owns the worker: pdf.js only cleans up after a
    // document through the task that produced it.
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    setDoc(null);
    setPageCount(0);
    setError(null);
    setPageError(null);
    setAtEnd(false);
    setZoom(null);
    void (async () => {
      try {
        // Bytes come through the IPC binary channel rather than the asset protocol: pdf.js
        // fetches with `Range` and CORS, and the asset handler answers neither the way a
        // document served over http would — the images get away with `<img>`, which is
        // exempt from both.
        const bytes = new Uint8Array(await api.readFileBytes(path));
        task = pdfjs.getDocument({ data: bytes });
        const loaded = await task.promise;
        if (!live) return;
        setDoc(loaded);
        setPageCount(loaded.numPages);
      } catch (e) {
        if (live) setError(translateError(e instanceof Error ? e.message : String(e)));
      }
    })();
    return () => {
      live = false;
      void task?.destroy();
    };
  }, [path]);

  // The outline is read once per document: a document without one answers null, which is not a
  // failure but the reason the tab never appears.
  useEffect(() => {
    // A new document starts with every branch open: the paths that folded the last one name
    // entries that no longer exist here, and a column that opens with parts of it missing would
    // look like the file had fewer bookmarks than it does.
    setFolded(new Set());
    if (!doc) {
      setOutline([]);
      return;
    }
    let live = true;
    void doc
      .getOutline()
      .then((tree) => {
        if (live) setOutline(tree ? toBookmarks(tree as unknown as RawOutline) : []);
      })
      .catch(() => {
        if (live) setOutline([]);
      });
    return () => {
      live = false;
    };
  }, [doc]);

  /**
   * Follow a bookmark to the page it names.
   *
   * `dest` is either a name to look up or the explicit array pdf.js uses, and both end at a page
   * number; the element for that page carries its number, so the jump is a scroll rather than a
   * second render. A target that cannot be resolved leaves the reader where it is — a bookmark
   * pointing outside the document is a broken link, not a broken reader.
   */
  const goToBookmark = useCallback(
    async (dest: unknown) => {
      if (!doc || dest === null) return;
      try {
        const target = typeof dest === "string" ? await doc.getDestination(dest) : dest;
        if (!Array.isArray(target) || target.length === 0) return;
        const first = target[0] as { num?: number } | number;
        const index =
          typeof first === "number"
            ? first - 1
            : await doc.getPageIndex(first as Parameters<typeof doc.getPageIndex>[0]);
        hostRef.current
          ?.querySelector<HTMLElement>(`[data-page="${index + 1}"]`)
          ?.scrollIntoView({ block: "start" });
      } catch {
        // Nothing to say: the column stays open where it was.
      }
    },
    [doc]
  );

  /** Puts one branch of the outline away, or brings it back, without touching its siblings. */
  const toggleFold = useCallback((key: string) => {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * The size box needs a number to show while the document is fitted, and stepping from fit
   * needs one to step away from. The first page is the reference: it is the one on screen when
   * a document is opened, and pdf.js has already measured it by the time a pane is this wide.
   */
  useEffect(() => {
    if (!doc || width <= 0) {
      setFitPercent(0);
      return;
    }
    let live = true;
    void doc
      .getPage(1)
      .then((page) => {
        if (live) setFitPercent(Math.round((width / page.getViewport({ scale: 1 }).width) * 100));
      })
      .catch(() => {
        // An unmeasurable first page leaves the box as it is; that page reports the reason
        // itself when it tries to draw.
      });
    return () => {
      live = false;
    };
  }, [doc, width]);

  // The box follows the size whenever it is set from elsewhere — the buttons, the fit button,
  // a resize while fitting — so it always names what is on screen rather than a stale draft.
  useEffect(() => {
    setZoomDraft(zoomText(zoom, fitPercent));
  }, [zoom, fitPercent]);

  /**
   * The scroll loop. Each frame moves the container by `speed` pixels per second of elapsed
   * time, so a slow machine does not slow the document down, and stops at the bottom instead
   * of leaving the reader staring at a page that no longer moves.
   */
  useEffect(() => {
    if (!autoScroll) return;
    const host = hostRef.current;
    if (!host) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsed = Math.min(0.1, (now - last) / 1000);
      last = now;
      const max = host.scrollHeight - host.clientHeight;
      if (host.scrollTop >= max - 1) {
        setAutoScroll(false);
        setAtEnd(true);
        return;
      }
      host.scrollTop = Math.min(max, host.scrollTop + speed * elapsed);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [autoScroll, speed]);

  // A wheel or a drag means the reader has taken over; the automatic scroll steps aside rather
  // than fighting the hand that is already moving the page.
  const pauseForHand = useCallback(() => {
    setAutoScroll((on) => (on ? false : on));
  }, []);

  /**
   * The tools leave a few seconds after the pointer does, rather than the instant it does: a
   * hand that has gone to the page is often on its way straight back, and a row that vanishes
   * under it reads as a slip.
   */
  const closeTimer = useRef<number | null>(null);
  const stayOpen = useCallback(() => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);
  const closeSoon = useCallback(() => {
    stayOpen();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      setToolsOpen(false);
    }, TOOLS_CLOSE_DELAY);
  }, [stayOpen]);
  const closeNow = useCallback(() => {
    stayOpen();
    setToolsOpen(false);
  }, [stayOpen]);
  useEffect(() => () => stayOpen(), [stayOpen]);

  // Night inverts the page rather than tinting it, and the inversion is a stylesheet layer with
  // the pictures cut out of it, so the sheet colour becomes the stylesheet's business alone.
  const night = paper === NIGHT_PAPER;

  return (
    <div
      className="pdf-view"
      data-paper={night ? "night" : undefined}
      style={{ "--pdf-paper": night ? "#ffffff" : paper } as CSSProperties}
    >
      {/* The only thing on the page when the tools are away: a tab in the corner that brings
          them back, rather than a spot along the top edge that has to be found by accident. */}
      <button
        type="button"
        className="pdf-tools-toggle"
        title={toolsOpen ? t("tools.hide") : t("tools.show")}
        aria-label={toolsOpen ? t("tools.hide") : t("tools.show")}
        aria-expanded={toolsOpen}
        onPointerEnter={stayOpen}
        onClick={() => setToolsOpen((open) => !open)}
      >
        {toolsOpen ? <IconCollapse edge="top" /> : <IconSliders />}
      </button>
      {/* The bookmarks' own tab, on the side its column opens from. It only exists when the
          document has an outline to show. */}
      {outline.length > 0 && (
        <button
          type="button"
          className={`pdf-outline-tab ${outlineSide}`}
          title={t(outlineOpen ? "pdf.outlineHide" : "pdf.outlineShow")}
          aria-label={t(outlineOpen ? "pdf.outlineHide" : "pdf.outlineShow")}
          aria-expanded={outlineOpen}
          onClick={() => setOutlineOpen((open) => !open)}
        >
          {outlineOpen ? <IconCollapse edge={outlineSide} /> : <IconOutline />}
        </button>
      )}
      <div
        className={`pdf-tools tab-${outlineSide}${toolsOpen ? " open" : ""}`}
        onPointerEnter={stayOpen}
        onPointerLeave={(event) => {
          // A slider dragged past the row is still the row being used, so a button held down
          // keeps it open until the pointer is lifted; otherwise the row waits a moment before
          // it leaves, in case the hand is coming straight back.
          if (event.buttons === 0) closeSoon();
        }}
      >
        <button
          className="pdf-tool"
          title={t("img.zoomOut")}
          onClick={() => stepBy(-1)}
          disabled={shownZoom <= STEPS[0]}
        >
          −
        </button>
        {/* A plain number rather than a slider: a reader who knows the size they want should be
            able to type it, and while the document is fitted the box reports what fit comes to. */}
        <span className="zoom-box">
          <input
            className="zoom-input"
            type="text"
            inputMode="numeric"
            title={t("pdf.pageSize")}
            aria-label={t("pdf.pageSize")}
            placeholder={t("img.fit")}
            value={zoomDraft}
            onChange={(event) => setZoomDraft(event.target.value)}
            onBlur={(event) => applyZoomDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
          <span className="zoom-unit">%</span>
        </span>
        <button
          className="pdf-tool"
          title={t("img.zoomIn")}
          onClick={() => stepBy(1)}
          disabled={shownZoom >= STEPS[STEPS.length - 1]}
        >
          +
        </button>
        <button
          className={`pdf-tool zoom-fit${zoom === null ? " on" : ""}`}
          title={t("img.fit")}
          aria-pressed={zoom === null}
          onClick={() => setZoom(null)}
        >
          {t("img.fit")}
        </button>
        <PaperPicker value={paper} onChange={onSavePaper} />
        <span className="pdf-pages" title={t("pdf.pages", { n: pageCount })}>
          {t("pdf.pages", { n: pageCount })}
        </span>
        <span className="pdf-spacer" />
        <button
          className={`pdf-tool pdf-auto${autoScroll ? " on" : ""}`}
          title={t("pdf.autoScroll")}
          aria-pressed={autoScroll}
          disabled={!doc}
          onClick={() => {
            setAtEnd(false);
            setAutoScroll((on) => !on);
          }}
        >
          {autoScroll ? "❚❚" : "▶"}
        </button>
        {/* A slider for the coarse move, and buttons for a nudge of one: the pace of a document
            read aloud is worth setting exactly, and a slider alone cannot be walked one number
            at a time. */}
        <span className="pdf-speed">
          <span>{t("pdf.speed")}</span>
          <button
            className="pdf-tool"
            title={t("pdf.slower")}
            onClick={() => setSpeed((value) => Math.max(SPEED_MIN, value - SPEED_STEP))}
            disabled={speed <= SPEED_MIN}
          >
            −
          </button>
          <input
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={SPEED_STEP}
            value={speed}
            aria-label={t("pdf.speed")}
            onChange={(event) => setSpeed(Number(event.target.value))}
          />
          <button
            className="pdf-tool"
            title={t("pdf.faster")}
            onClick={() => setSpeed((value) => Math.min(SPEED_MAX, value + SPEED_STEP))}
            disabled={speed >= SPEED_MAX}
          >
            +
          </button>
          <span className="pdf-speed-value">{speed}</span>
        </span>
        {atEnd && <span className="pdf-end">{t("pdf.end")}</span>}
      </div>
      <div
        className="pdf-scroll"
        ref={hostRef}
        onWheel={pauseForHand}
        // A single click only clears the tools; the automatic scroll keeps going. Stopping is a
        // deliberate double click, so a reader who taps the page to read does not lose their place.
        onDoubleClick={pauseForHand}
        onPointerDown={closeNow}
      >
        {(error || pageError) && (
          <div className="pdf-error">{t("pdf.error", { detail: error ?? pageError ?? "" })}</div>
        )}
        {!error && !doc && <div className="pdf-loading">{t("app.loading")}</div>}
        {doc && width > 0 && (
          <div className="pdf-pages-list">
            {Array.from({ length: pageCount }, (_, index) => (
              <PdfPage
                key={index}
                doc={doc}
                index={index}
                zoom={zoom}
                width={width}
                night={night}
                onError={(message) => setPageError((current) => current ?? message)}
              />
            ))}
          </div>
        )}
      </div>
      {outlineOpen && outline.length > 0 && (
        <nav
          className={`pdf-outline ${outlineSide}`}
          aria-label={t("pdf.outline")}
          // Order rather than two render sites: the pages keep their DOM slot, so opening or
          // closing the column never re-mounts the document.
          style={{ order: outlineSide === "left" ? -1 : 0 }}
        >
          <div className="pdf-outline-head">
            <span>{t("pdf.outline")}</span>
            {/* One button does both jobs: shown as collapse when everything is open, expand when
                anything is put away. The whole tree shares a single folded set, so the swap is a
                one-line decision rather than tracking a third "all / some / none" state. */}
            <button
              type="button"
              className="pdf-outline-all"
              title={folded.size === 0 ? t("pdf.outlineCollapseAll") : t("pdf.outlineExpandAll")}
              aria-label={
                folded.size === 0 ? t("pdf.outlineCollapseAll") : t("pdf.outlineExpandAll")
              }
              onClick={() =>
                setFolded(folded.size === 0 ? new Set(allBranchKeys(outline)) : new Set())
              }
            >
              {folded.size === 0 ? <IconCollapseAll size={13} /> : <IconExpandAll size={13} />}
            </button>
          </div>
          <BookmarkList
            items={outline}
            path=""
            folded={folded}
            onGo={goToBookmark}
            onFold={toggleFold}
          />
        </nav>
      )}
    </div>
  );
}
