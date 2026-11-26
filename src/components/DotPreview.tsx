import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import DOMPurify from "dompurify";
import { SVG_SANITIZE } from "../lib/markdownHtml";
import { t } from "../lib/i18n";
import { api, errorMessage } from "../lib/tauri";
import { stepFrom, zoomText } from "../lib/zoom";

/** The rungs the two zoom buttons walk; a typed size between them keeps its place. */
const STEPS = [25, 50, 75, 100, 125, 150, 200, 300, 400, 600, 800];
const MIN_ZOOM = 10;
const MAX_ZOOM = 800;
/** What `.dot-stage` pads the drawing on every side; fit is measured inside it. */
const STAGE_PAD = 16;

function clampZoom(value: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(value)));
}

/** A CSS length (`461pt`, `120px`, `4in`) in pixels, or 0 when it cannot be read. */
function lengthPx(value: string | null): number {
  if (!value) return 0;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*(px|pt|pc|in|cm|mm)?\s*$/i.exec(value);
  if (!match) return 0;
  const unit = (match[2] ?? "px").toLowerCase();
  const per: Record<string, number> = {
    px: 1,
    pt: 4 / 3,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
  };
  return parseFloat(match[1]) * (per[unit] ?? 1);
}

/**
 * The drawing's own size in pixels, from the attributes `dot` writes.
 *
 * Graphviz sizes its SVG in points; the browser would lay the same file out at 4/3 that, so
 * `pt` is converted here. That makes "100%" mean the size the drawing would have in a page,
 * not the number in its viewBox.
 */
function naturalSize(markup: string): { w: number; h: number } {
  if (!markup) return { w: 0, h: 0 };
  const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
  const root = doc.documentElement;
  const w = lengthPx(root.getAttribute("width"));
  const h = lengthPx(root.getAttribute("height"));
  if (w > 0 && h > 0) return { w, h };
  const box = (root.getAttribute("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2] > 0 && box[3] > 0) return { w: box[2], h: box[3] };
  return { w: 0, h: 0 };
}

interface Props {
  /** The buffer's current text; the drawing follows it as the user types. */
  text: string;
}

/**
 * A Graphviz DOT file drawn beside its source.
 *
 * The drawing is made by the local `dot` through `render_diagram`, the same route the markdown
 * preview takes for a `graphviz` fence. It is a viewer rather than an editor: the SVG is
 * sanitized before it reaches the DOM, because it is generated from text the user opened and
 * this window has no CSP backstop (see tauri.conf.json).
 *
 * Editing is a normal thing to do with the source on screen, so a failed render keeps the
 * last drawing and reports the error in a strip above it instead of blanking the pane on
 * every half-typed line.
 */
export default function DotPreview({ text }: Props) {
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Both sides to the pane, width only, or a pinned percentage — the picture pane's model. */
  const [zoom, setZoom] = useState<"fit" | "width" | number>("fit");
  const [zoomDraft, setZoomDraft] = useState("");
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  /** Which render is current. A reply that is not it is dropped, not shown. */
  const runRef = useRef(0);

  useEffect(() => {
    const run = ++runRef.current;
    if (!text.trim()) {
      setSvg("");
      setError(null);
      setBusy(false);
      return;
    }
    setBusy(true);
    // The buffer is already debounced upstream; this holds back the burst a file switch or
    // a paste can produce without making typing wait on a second timer.
    const timer = window.setTimeout(() => {
      api
        .renderDiagram("graphviz", text)
        .then((result) => {
          if (run !== runRef.current) return;
          setSvg(DOMPurify.sanitize(result, SVG_SANITIZE));
          setError(null);
        })
        .catch((e) => {
          if (run !== runRef.current) return;
          setError(errorMessage(e));
        })
        .finally(() => {
          if (run === runRef.current) setBusy(false);
        });
    }, 120);
    return () => clearTimeout(timer);
  }, [text]);

  const size = useMemo(() => naturalSize(svg), [svg]);

  /** The room the drawing is fitted into, watched rather than assumed. */
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => setRoom({ w: stage.clientWidth, h: stage.clientHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    measure();
    return () => observer.disconnect();
  }, [svg]);

  /**
   * Both scales the pane can fit with. `window` puts the whole drawing on screen; `width`
   * keeps it readable and lets a tall drawing scroll. Neither enlarges a drawing smaller
   * than the room it is given: a two-node graph blown up to fill a window reads as a
   * poster, not as a diagram.
   */
  const avail = useMemo(() => {
    if (size.w <= 0 || size.h <= 0 || room.w <= 0 || room.h <= 0) return null;
    return {
      w: Math.max(40, room.w - STAGE_PAD * 2),
      h: Math.max(40, room.h - STAGE_PAD * 2),
    };
  }, [size, room]);
  const fitScale = useMemo(() => {
    if (!avail) return 1;
    return Math.min(avail.w / size.w, avail.h / size.h, 1);
  }, [avail, size]);
  const fitWidthScale = useMemo(() => {
    if (!avail) return 1;
    return Math.min(avail.w / size.w, 1);
  }, [avail, size]);
  const fitPercent = Math.round(fitScale * 100);
  const fitWidthPercent = Math.round(fitWidthScale * 100);
  const fittingPercent = zoom === "width" ? fitWidthPercent : fitPercent;
  const shownZoom = typeof zoom === "number" ? zoom : fittingPercent;
  const scale = typeof zoom === "number" ? zoom / 100 : zoom === "width" ? fitWidthScale : fitScale;

  useEffect(() => {
    setZoomDraft(zoomText(typeof zoom === "number" ? zoom : null, fittingPercent));
  }, [zoom, fittingPercent]);

  const applyZoomDraft = (raw: string) => {
    const digits = raw.replace(/[^\d]/g, "");
    if (!digits) {
      setZoom("fit");
      return;
    }
    const next = clampZoom(parseInt(digits, 10));
    // Typing the percentage a fitting mode already gives is that fit: the pane keeps
    // following a resize instead of pinning a number that no longer fits.
    if (next === fitPercent) setZoom("fit");
    else if (next === fitWidthPercent) setZoom("width");
    else setZoom(next);
  };

  const stepBy = (direction: 1 | -1) => {
    setZoom(clampZoom(stepFrom(STEPS, shownZoom, direction)));
  };

  /**
   * Ctrl/Cmd + wheel zooms the drawing under the pointer. Bound natively because a synthetic
   * wheel listener cannot call `preventDefault`, and the bare wheel keeps scrolling the
   * pane — a drawing larger than the window is read by scrolling as much as by zooming.
   */
  const fitPercentRef = useRef(fitPercent);
  fitPercentRef.current = fitPercent;
  const fitWidthPercentRef = useRef(fitWidthPercent);
  fitWidthPercentRef.current = fitWidthPercent;
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      setZoom((current) => {
        const base =
          typeof current === "number"
            ? current
            : current === "width"
              ? fitWidthPercentRef.current
              : fitPercentRef.current;
        return clampZoom(base * (event.deltaY < 0 ? 1.1 : 1 / 1.1));
      });
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [svg]);

  /**
   * Only a drawing that actually overflows the pane can be panned, so the grab cursor and
   * the drag handler are gated on this rather than on the zoom value: at 100% a drawing that
   * still fits has nothing to drag.
   */
  const [canPan, setCanPan] = useState(false);
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    setCanPan(
      stage.scrollWidth > stage.clientWidth + 1 || stage.scrollHeight > stage.clientHeight + 1
    );
  }, [scale, size, room, svg, error]);

  const pan = useRef<{ x: number; y: number; sl: number; st: number } | null>(null);
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!canPan || event.button !== 0) return;
    const stage = event.currentTarget;
    pan.current = { x: event.clientX, y: event.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
    stage.setPointerCapture(event.pointerId);
    setDragging(true);
    event.preventDefault(); // no text selection or native drag while panning
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const started = pan.current;
    if (!started) return;
    const stage = event.currentTarget;
    stage.scrollLeft = started.sl - (event.clientX - started.x);
    stage.scrollTop = started.st - (event.clientY - started.y);
  };
  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!pan.current) return;
    pan.current = null;
    setDragging(false);
    const stage = event.currentTarget;
    if (stage.hasPointerCapture(event.pointerId)) stage.releasePointerCapture(event.pointerId);
  };

  const missing = error?.startsWith("diagram_missing") ?? false;
  const timeout = error === "diagram_timeout";
  const errorTitle = missing ? t("dot.missing") : timeout ? t("dot.timeout") : t("dot.error");
  // The detail is Graphviz's stderr, which is written for a person to read; a missing program
  // has nothing useful to add past the sentence above it.
  const errorDetail = missing || timeout ? "" : error ?? "";
  /** The zoom controls act on a drawing; with none on screen there is nothing to act on. */
  const hasDrawing = size.w > 0 && size.h > 0;

  return (
    <div className="dot-preview">
      <div className="dot-tools">
        <button
          className="img-tool"
          title={t("dot.zoomOut")}
          disabled={!hasDrawing || shownZoom <= MIN_ZOOM}
          onClick={() => stepBy(-1)}
        >
          −
        </button>
        <span className="zoom-box">
          <input
            className="zoom-input"
            type="text"
            inputMode="numeric"
            title={t("dot.size")}
            aria-label={t("dot.size")}
            placeholder={t("dot.fit")}
            disabled={!hasDrawing}
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
          className="img-tool"
          title={t("dot.zoomIn")}
          disabled={!hasDrawing || shownZoom >= MAX_ZOOM}
          onClick={() => stepBy(1)}
        >
          +
        </button>
        <button
          className={`img-tool zoom-fit${zoom === "fit" ? " on" : ""}`}
          title={t("dot.fit")}
          aria-pressed={zoom === "fit"}
          disabled={!hasDrawing}
          onClick={() => setZoom("fit")}
        >
          {t("dot.fit")}
        </button>
        <button
          className={`img-tool zoom-fit${zoom === "width" ? " on" : ""}`}
          title={t("dot.fitWidth")}
          aria-pressed={zoom === "width"}
          disabled={!hasDrawing}
          onClick={() => setZoom("width")}
        >
          {t("dot.fitWidth")}
        </button>
        <button
          className="img-tool"
          title={t("dot.actual")}
          disabled={!hasDrawing}
          onClick={() => setZoom(100)}
        >
          {t("dot.actual")}
        </button>
        {hasDrawing && (
          <span className="dot-dims">
            {Math.round(size.w)} × {Math.round(size.h)}
          </span>
        )}
        <span className="dot-note">{busy ? t("dot.rendering") : ""}</span>
      </div>

      {!svg && !error && (
        <div className="dot-message">{busy ? t("dot.rendering") : t("dot.empty")}</div>
      )}
      {!svg && error && (
        <div className="dot-message">
          <div className="dot-message-title">{errorTitle}</div>
          {errorDetail && <pre className="dot-message-detail">{errorDetail}</pre>}
        </div>
      )}
      {svg && (
        <>
          {/* The last good drawing stays on screen while a half-typed line fails to parse;
              the strip says why it is not the drawing the text describes right now. */}
          {error && (
            <div className="dot-error-bar" title={errorDetail || errorTitle}>
              {errorTitle}
              {errorDetail && <span className="dot-error-detail"> · {errorDetail}</span>}
            </div>
          )}
          <div
            className={`dot-stage${canPan ? " dot-can-pan" : ""}${dragging ? " dot-dragging" : ""}`}
            ref={stageRef}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endPan}
            onPointerCancel={endPan}
            onDoubleClick={() => setZoom("fit")}
          >
            <div
              className="dot-canvas"
              style={
                size.w > 0 && size.h > 0
                  ? { width: `${size.w * scale}px`, height: `${size.h * scale}px` }
                  : undefined
              }
              // Sanitized in the effect that renders it; the raw SVG never reaches the DOM.
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          </div>
        </>
      )}
    </div>
  );
}