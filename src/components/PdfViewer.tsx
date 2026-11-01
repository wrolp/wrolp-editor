import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
// The legacy build, not the default one: pdf.js now calls `Map.prototype.getOrInsertComputed`,
// which the webview on an older Windows may not have. The legacy build carries that polyfill
// for both the API and the worker, and costs only a few dozen kilobytes over the default build.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";
import { t, translateError } from "../lib/i18n";
import { api } from "../lib/tauri";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

interface Props {
  path: string;
  /** A `#rrggbb` colour for the page itself, or `night` to invert it; white leaves it untouched. */
  paper: string;
  onSavePaper: (value: string) => void;
}

/** Zoom levels the buttons walk, as a percentage of the page's own size. `null` means "fit". */
const STEPS = [50, 75, 100, 150, 200, 300];
/** The range a typed percentage is held to, so a mistyped zero cannot make a page unusable. */
const ZOOM_MIN = 25;
const ZOOM_MAX = 400;
/** Pixels per second the automatic scroll moves, the range the slider offers, and one nudge. */
const SPEED_MIN = 10;
const SPEED_MAX = 240;
const SPEED_STEP = 5;
const SPEED_DEFAULT = 40;

/** The number the size box shows: the pinned percentage, or what fitting comes to instead. */
function zoomText(zoom: number | null, fitPercent: number): string {
  if (zoom !== null) return String(zoom);
  return fitPercent > 0 ? String(fitPercent) : "";
}

/**
 * The next rung of the ladder in `direction`, for a percentage that may not be on it.
 *
 * A typed size sits between two rungs; stepping from it lands on the neighbouring one rather
 * than snapping back to 100. A size already past the end of the ladder stays where it is, which
 * is what the matching end of the ladder means for a number the buttons did not choose.
 */
function stepFrom(current: number, direction: 1 | -1): number {
  const at = STEPS.indexOf(current);
  if (at >= 0) return STEPS[Math.min(STEPS.length - 1, Math.max(0, at + direction))];
  if (direction === 1) return STEPS.find((step) => step > current) ?? current;
  for (let i = STEPS.length - 1; i >= 0; i -= 1) {
    if (STEPS[i] < current) return STEPS[i];
  }
  return current;
}

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
  onError,
}: {
  doc: pdfjs.PDFDocumentProxy;
  index: number;
  zoom: number | null;
  width: number;
  onError: (message: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(index < 2);
  const [height, setHeight] = useState(0);

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
      } catch (e) {
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

  return (
    <div
      className="pdf-page"
      ref={wrapRef}
      style={height > 0 ? { height } : undefined}
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
export default function PdfViewer({ path, paper, onSavePaper }: Props) {
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
  const [atEnd, setAtEnd] = useState(false);
  /** The first page whose render failed, shown instead of letting the pane sit blank. */
  const [pageError, setPageError] = useState<string | null>(null);

  /** What the pane is showing, whether the reader pinned it or the pane chose it. */
  const shownZoom = zoom ?? fitPercent;

  const stepBy = (direction: 1 | -1) => {
    // Stepping from "fit" starts where the pane already is, so a small first nudge from a
    // document fitted at 134% lands on 150 rather than jumping across it.
    setZoom((current) => stepFrom(current ?? fitPercent, direction));
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

  // Night inverts the page rather than tinting it, so the sheet colour becomes the stylesheet's
  // business alone: a tint layer over an inverted page would darken the text as well.
  const night = paper === NIGHT_PAPER;

  return (
    <div
      className="pdf-view"
      data-paper={night ? "night" : undefined}
      style={{ "--pdf-paper": night ? "#ffffff" : paper } as CSSProperties}
    >
      <div className="pdf-tools">
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
        <span className="pdf-size">
          <input
            className="pdf-size-input"
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
          <span className="pdf-size-unit">%</span>
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
          className={`pdf-tool pdf-fit${zoom === null ? " on" : ""}`}
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
        {/* A slider for the coarse move, and buttons for the nudge between rungs of five: the
            pace of a document read aloud is worth setting exactly, and a slider alone cannot
            be walked one number at a time. */}
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
        onPointerDown={pauseForHand}
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
                onError={(message) => setPageError((current) => current ?? message)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
