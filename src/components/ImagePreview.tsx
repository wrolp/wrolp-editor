import { useCallback, useEffect, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";
import {
  api,
  copyText,
  errorMessage,
  revealItemInDir,
  type OcrImage,
  type OcrLanguage,
  type OcrLine,
  type OcrSource,
} from "../lib/tauri";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import { stepFrom, zoomText } from "../lib/zoom";
import BackdropPicker from "./BackdropPicker";
import { IconCollapse, IconSliders } from "./icons";

interface Props {
  path: string;
  /**
   * A URL the caller already prepared — an archive entry's blob URL. When given, the preview
   * draws it directly instead of going through the asset protocol.
   */
  src?: string | null;
  /**
   * True when the picture has no path on disk. There is then nothing to grant, nothing to
   * reveal and nothing to hand to another program; the pane draws, and that is all.
   */
  external?: boolean;
  /**
   * The buffer, for SVG only. An SVG is text, so it is already in memory and can be handed
   * to the image as a data URL — which sidesteps both the asset scope (a picture in a
   * refused folder stays unreachable that way) and whatever MIME the webview infers for
   * `.svg`. Null for a raster image, which has no text to build a URL from.
   */
  text?: string | null;
  /**
   * What sits behind the picture's transparent pixels: `checker`, or a `#rrggbb` colour. A prop
   * rather than the pane's own state because the choice is global — the gallery's thumbnails
   * paint with it too — and it survives the tab it was changed in.
   */
  backdrop: string;
  onSaveBackdrop: (value: string) => void;
  /**
   * Open the picture's folder as a gallery, landing on this picture. The parent passes the
   * whole path so the gallery can find it in its own naturally-ordered list.
   */
  onBrowseFolder?: (path: string) => void;
  /**
   * Where text recognition reads the picture from. Null hides the controls — an SVG has no
   * pixels to recognize, and a pane without a readable source has nothing to ask.
   */
  ocrSource?: OcrSource | null;
  /** Recognize the picture as soon as it is shown; off, Extract text starts it. */
  ocrAuto?: boolean;
  /** A sentence for the app's toast row (recognition failure, copied characters). */
  onNotice?: (message: string) => void;
}

/** Zoom levels the buttons walk, as a percentage of the picture's own pixels. */
const STEPS = [25, 50, 75, 100, 150, 200, 400];
/** The range a typed percentage is held to, so a mistyped zero cannot lose the picture. */
const ZOOM_MIN = 5;
const ZOOM_MAX = 800;
/** What `.img-stage` pads the picture on every side; fit is measured inside it. */
const STAGE_PAD = 14;
/** How long the tools stay after the pointer leaves them, before they slide away. */
const TOOLS_CLOSE_DELAY = 2500;

function dirOf(filePath: string): string {
  const cut = filePath.replace(/[\\/][^\\/]*$/, "");
  return cut || filePath;
}

/**
 * An SVG document as an image URL. The `charset` is stated so a file that declares its own
 * encoding still decodes, and `encodeURIComponent` handles the characters that would
 * otherwise end the data URL early (`#` in particular, which every SVG uses in `url(#id)`).
 */
function svgDataUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * Whether the source is well-formed XML, which is what a browser insists on before it will
 * draw an SVG at all. Asking the same parser up front turns a blank pane into a sentence
 * that says why: a file with a repeated attribute is rejected here exactly as it is by the
 * `<img>`, and no encoding or URL spelling would have saved it.
 */
function xmlIsWellFormed(svg: string): boolean {
  return !new DOMParser().parseFromString(svg, "image/svg+xml").querySelector("parsererror");
}

/** A stable identity for an OCR source, so a fresh object literal does not re-ask. */
function sourceId(source: OcrSource | null | undefined): string {
  if (!source) return "";
  return source.kind === "path"
    ? `p:${source.path}`
    : `a:${source.archive}:${source.entry}`;
}

/**
 * Windows' Chinese OCR returns one word per character, so `OcrLine.Text` joins them with
 * spaces that are not on the page. Word boxes tell the truth: a real space is a gap wider than
 * a fraction of the line's height, while two Chinese characters sit flush.
 */
function wordHasGap(line: OcrLine, index: number): boolean {
  const word = line.words[index];
  const next = line.words[index + 1];
  if (!word || !next) return false;
  return next.x - (word.x + word.width) > Math.max(1, word.height * 0.18);
}

function lineText(line: OcrLine): string {
  return line.words
    .map((word, index) => word.text + (wordHasGap(line, index) ? " " : ""))
    .join("")
    .trimEnd();
}

/** One language list for the whole window; the engine's list only changes with Windows. */
let ocrLanguagesPromise: Promise<OcrLanguage[]> | null = null;
function loadOcrLanguages(): Promise<OcrLanguage[]> {
  if (!ocrLanguagesPromise) {
    ocrLanguagesPromise = api.ocrLanguages().catch((error) => {
      ocrLanguagesPromise = null;
      throw error;
    });
  }
  return ocrLanguagesPromise;
}

/**
 * Draws an image file — raster or SVG — instead of leaving its bytes in the editor.
 *
 * The picture comes through the asset protocol rather than a data URL: the backend already
 * grants the folder a file lives in when the file is opened, so nothing is copied through
 * base64 and JSON first and a large photo costs no extra memory on the way in.
 *
 * SVG goes through `<img>` like everything else, which is also what keeps it safe: scripts
 * inside an SVG do not run when it is loaded as an image, only when it is a document.
 */
export default function ImagePreview({
  path,
  src: prepared,
  external,
  text,
  backdrop,
  onSaveBackdrop,
  onBrowseFolder,
  ocrSource,
  ocrAuto = false,
  onNotice,
}: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** How the picture is scaled: both sides to the pane, width only, or a pinned percentage. */
  const [zoom, setZoom] = useState<"fit" | "width" | number>("fit");
  const [dims, setDims] = useState({ width: 0, height: 0 });
  /** The room the picture is fitted into, watched rather than assumed. */
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  /** The text in the size box while it is being typed; committed on Enter or on leaving it. */
  const [zoomDraft, setZoomDraft] = useState("");
  /** The tools take no room unless they are in use; the tab in the corner brings them back. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** The installed recognizers, and whether this platform has the feature at all. */
  const [ocrLanguages, setOcrLanguages] = useState<OcrLanguage[]>([]);
  const [ocrAvailable, setOcrAvailable] = useState(false);
  const [ocrLanguage, setOcrLanguage] = useState("");
  const [ocrState, setOcrState] = useState<"idle" | "running" | "ready" | "empty">(
    "idle"
  );
  const [ocr, setOcr] = useState<OcrImage | null>(null);
  const [ocrShown, setOcrShown] = useState(true);
  const [ocrMenu, setOcrMenu] = useState<{
    x: number;
    y: number;
    selection: string;
  } | null>(null);
  const ocrLayerRef = useRef<HTMLDivElement>(null);
  const ocrMenuRef = useRef<HTMLDivElement>(null);
  /** Invalidates a result that belongs to a picture no longer on screen. */
  const ocrRequest = useRef(0);
  /** The one source the automatic pass has already run for; a failure must not loop. */
  const autoOcrFor = useRef("");
  const ocrMenuAt = useMenuPlacement(ocrMenu, ocrMenuRef);
  const ocrId = sourceId(ocrSource);

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * The scale that fits the picture into the room it is given. A picture smaller than the pane
   * is already at its own size, so this stops at 1.
   *
   * The size is worked out here rather than left to `max-width` / `max-height`: a percentage
   * `max-height` against a pane whose height comes from flex layout is not resolved at all, so
   * a tall picture used to overflow the pane instead of fitting it.
   */
  const fitScale =
    stage.width > 0 && dims.width > 0 && dims.height > 0
      ? Math.min(
          1,
          (stage.width - STAGE_PAD * 2) / dims.width,
          (stage.height - STAGE_PAD * 2) / dims.height
        )
      : 0;
  const fitPercent = fitScale > 0 ? Math.round(fitScale * 100) : 0;
  /**
   * Width-only fit: a tall picture fills the pane across and scrolls down. Capped at 100%
   * as well, so a small picture is not blown up just because the window is wide.
   */
  const fitWidthScale =
    stage.width > 0 && dims.width > 0
      ? Math.min(1, (stage.width - STAGE_PAD * 2) / dims.width)
      : 0;
  const fitWidthPercent = fitWidthScale > 0 ? Math.round(fitWidthScale * 100) : 0;
  /** The percentage whichever fitting mode is in force follows. */
  const fittingPercent = zoom === "width" ? fitWidthPercent : fitPercent;
  /** What the pane is showing, whether the reader pinned it or a fitting mode chose it. */
  const shownZoom = typeof zoom === "number" ? zoom : fittingPercent;
  const scale = typeof zoom === "number" ? zoom / 100 : zoom === "width" ? fitWidthScale : fitScale;
  /** The picture's width in pixels: its own pixels times the scale, fitted or pinned. */
  const pictureWidth = dims.width > 0 && scale > 0 ? Math.round(dims.width * scale) : 0;

  const stepBy = (direction: 1 | -1) => {
    // Stepping from a fit mode starts where the pane already is, so a small first nudge from a
    // photo fitted at 42% lands on 50 rather than jumping across it.
    setZoom((current) =>
      stepFrom(STEPS, typeof current === "number" ? current : fittingPercent, direction)
    );
  };

  /**
   * Reads the size box: an empty one means fit the window, a percentage outside the range is
   * brought back into it, and anything that is not a number is a slip that only restores the box.
   */
  const applyZoomDraft = (text: string) => {
    const typed = text.trim();
    if (typed === "") {
      setZoom("fit");
      setZoomDraft(zoomText(null, fitPercent));
      return;
    }
    const parsed = Number.parseInt(typed, 10);
    if (Number.isNaN(parsed)) {
      setZoomDraft(zoomText(typeof zoom === "number" ? zoom : null, fittingPercent));
      return;
    }
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, parsed));
    // Typing the percentage the window fit already gives is that fit: the box keeps following
    // the pane instead of pinning a size that would stop keeping up with a resize.
    setZoom(next === fitPercent ? "fit" : next);
    setZoomDraft(String(next));
  };

  // The box follows the size whenever it is set from elsewhere — the buttons, a fit mode, a
  // resize — so it always names what is on screen rather than a stale draft.
  useEffect(() => {
    setZoomDraft(zoomText(typeof zoom === "number" ? zoom : null, fittingPercent));
  }, [zoom, fittingPercent]);

  /**
   * The tools leave a few seconds after the pointer does, rather than the instant it does: a
   * hand that has gone to the picture is often on its way straight back, and a row that
   * vanishes under it reads as a slip.
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
  /**
   * Set when the buffer is not well-formed XML. Worth knowing before anything is rendered:
   * a browser refuses such a file however it is addressed, so this is the difference
   * between "try the other route" and "stop, and say what is wrong with the file".
   */
  const [malformed, setMalformed] = useState(false);
  /**
   * Fall back to serving the file over the asset protocol. The inline route and the asset
   * route fail for opposite reasons — a refused scope versus a webview that will not infer
   * a type for `.svg` — so when one is blank the other is worth a try, and the button makes
   * that visible instead of leaving an empty pane.
   */
  const [viaAsset, setViaAsset] = useState(false);

  const assetSrc = useCallback(async () => {
    await api.allowAssetDir(dirOf(path)).catch(() => {});
    return convertFileSrc(path);
  }, [path]);

  // An SVG redraws as it is typed, so its URL is derived from the buffer rather than fetched.
  // `encodeURIComponent` rather than base64: the source is already text, and this keeps it
  // readable in devtools when a picture refuses to draw.
  const inlineSvg = text === null || text === undefined ? null : svgDataUrl(text);

  useEffect(() => {
    let live = true;
    setFailed(false);
    setZoom("fit");
    setDims({ width: 0, height: 0 });
    setViaAsset(false);
    if (external) {
      // The caller owns the URL (a blob from inside an archive) and the bytes behind it; this
      // pane neither fetches nor grants anything.
      setMalformed(false);
      setSrc(prepared ?? null);
      return;
    }
    if (inlineSvg !== null) {
      // Checked before rendering rather than after failing: a file a browser will reject
      // outright should say so, not keep asking for it.
      if (!xmlIsWellFormed(text ?? "")) {
        setMalformed(true);
        setSrc(null);
        return;
      }
      setMalformed(false);
      setSrc(inlineSvg);
      return;
    }
    setMalformed(false);
    setSrc(null);
    // The grant is what makes an asset URL resolvable. `openPath` already makes it when the
    // tab is opened, but nothing here requires having been reached that way: a restored
    // session or a file handed over by a second instance arrive without that guarantee.
    void assetSrc().then((url) => {
      if (live) setSrc(url);
    });
    return () => {
      live = false;
    };
  }, [assetSrc, inlineSvg, external, prepared]);

  useEffect(() => {
    if (!ocrId) {
      setOcrAvailable(false);
      setOcrLanguages([]);
      return;
    }
    let live = true;
    loadOcrLanguages()
      .then((list) => {
        if (!live) return;
        setOcrLanguages(list);
        setOcrAvailable(true);
        setOcrLanguage((current) =>
          list.some((language) => language.tag === current) ? current : ""
        );
      })
      .catch((error) => {
        if (!live) return;
        const raw =
          typeof error === "string"
            ? error
            : error instanceof Error
              ? error.message
              : String(error);
        setOcrLanguages([]);
        setOcrAvailable(!raw.startsWith("ocr_unsupported"));
      });
    return () => {
      live = false;
    };
  }, [ocrId]);

  // A new picture starts without the last one's words; the chosen language is a session
  // preference and stays.
  useEffect(() => {
    ocrRequest.current += 1;
    autoOcrFor.current = "";
    setOcrState("idle");
    setOcr(null);
    setOcrShown(true);
    setOcrMenu(null);
  }, [path]);

  useEffect(() => {
    if (!ocrMenu) return;
    const close = () => setOcrMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ocrMenu]);

  /**
   * Recognize the current picture. `announce` is what separates a deliberate extraction —
   * which must say why it failed — from the automatic pass that runs as the picture appears.
   * That one stays silent: a gallery of unsupported pictures would otherwise fill the toast
   * row on every turn.
   */
  const runOcr = useCallback(
    async (announce = true) => {
      if (!ocrSource || ocrState === "running") return;
      const generation = ++ocrRequest.current;
      setOcrState("running");
      setOcrMenu(null);
      try {
        const result = await api.ocrImage(ocrSource, ocrLanguage || null);
        if (generation !== ocrRequest.current) return;
        const hasText = result.lines.some((line) => line.words.length > 0);
        setOcr(result);
        setOcrShown(true);
        setOcrState(hasText ? "ready" : "empty");
        if (!hasText && announce) onNotice?.(t("img.ocrEmpty"));
      } catch (error) {
        if (generation !== ocrRequest.current) return;
        setOcrState("idle");
        if (announce) onNotice?.(errorMessage(error));
      }
    },
    [ocrLanguage, ocrSource, ocrState, onNotice]
  );

  // The reading happens on its own: the words are what a picture is opened for as often as
  // the pixels are. The Extract button stays as the way to run it again, and as the way to
  // see the reason when an automatic pass could not read the picture.
  const autoOcrKey = `${ocrId}|${src ?? ""}|${ocrLanguage}|${dims.width}`;
  useEffect(() => {
    if (!ocrAuto || !ocrId || !ocrAvailable || !src || failed || dims.width === 0) return;
    if (ocrState !== "idle" || autoOcrFor.current === autoOcrKey) return;
    autoOcrFor.current = autoOcrKey;
    void runOcr(false);
  }, [autoOcrKey, dims.width, failed, ocrAuto, ocrAvailable, ocrId, ocrState, runOcr, src]);

  const copyAllOcr = useCallback(() => {
    if (!ocr) return;
    const text = ocr.lines.map(lineText).join("\n");
    if (!text) {
      onNotice?.(t("img.ocrEmpty"));
      return;
    }
    void copyText(text).then((ok) => {
      onNotice?.(
        ok ? t("img.ocrCopied", { n: String(text.length) }) : t("side.copyFailed")
      );
    });
    setOcrMenu(null);
  }, [ocr, onNotice]);

  const copyOcrSelection = useCallback(() => {
    const text = ocrMenu?.selection ?? "";
    if (!text) return;
    void copyText(text).then((ok) => {
      onNotice?.(
        ok ? t("img.ocrCopied", { n: String(text.length) }) : t("side.copyFailed")
      );
    });
    setOcrMenu(null);
  }, [ocrMenu, onNotice]);

  const selectAllOcr = useCallback(() => {
    const layer = ocrLayerRef.current;
    if (!layer) return;
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    setOcrMenu(null);
  }, []);

  const pictureHeight =
    dims.width > 0 && pictureWidth > 0
      ? Math.round(dims.height * (pictureWidth / dims.width))
      : 0;
  const ocrScaleX =
    ocr && ocr.width > 0 && pictureWidth > 0 ? pictureWidth / ocr.width : 0;
  const ocrScaleY =
    ocr && ocr.height > 0 && pictureHeight > 0 ? pictureHeight / ocr.height : 0;

  return (
    <div className="img-preview">
      {/* The only thing on the picture when the tools are away: a tab in the corner that brings
          them back, rather than a spot along the top edge that has to be found by accident. */}
      <button
        type="button"
        className="img-tools-toggle"
        title={toolsOpen ? t("tools.hide") : t("tools.show")}
        aria-label={toolsOpen ? t("tools.hide") : t("tools.show")}
        aria-expanded={toolsOpen}
        onPointerEnter={stayOpen}
        onClick={() => setToolsOpen((open) => !open)}
      >
        {toolsOpen ? <IconCollapse edge="top" /> : <IconSliders />}
      </button>
      <div
        className={`img-tools${toolsOpen ? " open" : ""}`}
        onPointerEnter={stayOpen}
        onPointerLeave={(event) => {
          // A control dragged past the row is still the row being used, so a button held down
          // keeps it open until the pointer is lifted; otherwise the row waits a moment before
          // it leaves, in case the hand is coming straight back.
          if (event.buttons === 0) closeSoon();
        }}
      >
        <button
          className="img-tool"
          title={t("img.zoomOut")}
          onClick={() => stepBy(-1)}
          disabled={shownZoom <= STEPS[0]}
        >
          −
        </button>
        {/* The same box the reader has: a picture is zoomed to a number as often as to a rung. */}
        <span className="zoom-box">
          <input
            className="zoom-input"
            type="text"
            inputMode="numeric"
            title={t("img.size")}
            aria-label={t("img.size")}
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
          className="img-tool"
          title={t("img.zoomIn")}
          onClick={() => stepBy(1)}
          disabled={shownZoom >= STEPS[STEPS.length - 1]}
        >
          +
        </button>
        <button
          className={`img-tool zoom-fit${zoom === "fit" ? " on" : ""}`}
          title={t("img.fit")}
          aria-pressed={zoom === "fit"}
          onClick={() => setZoom("fit")}
        >
          {t("img.fit")}
        </button>
        <button
          className={`img-tool zoom-fit${zoom === "width" ? " on" : ""}`}
          title={t("img.fitWidth")}
          aria-pressed={zoom === "width"}
          onClick={() => setZoom("width")}
        >
          {t("img.fitWidth")}
        </button>
        <button className="img-tool" title={t("img.actual")} onClick={() => setZoom(100)}>
          {t("img.actual")}
        </button>
        {ocrSource && ocrAvailable && (
          <>
            {ocrLanguages.length > 1 && (
              <select
                className="select img-ocr-lang"
                value={ocrLanguage}
                title={t("img.ocrLang")}
                aria-label={t("img.ocrLang")}
                onChange={(event) => setOcrLanguage(event.target.value)}
              >
                <option value="">{t("img.ocrSystem")}</option>
                {ocrLanguages.map((language) => (
                  <option key={language.tag} value={language.tag}>
                    {language.name || language.tag}
                  </option>
                ))}
              </select>
            )}
            <button
              className="img-tool"
              title={t("img.ocrExtract")}
              disabled={ocrState === "running"}
              onClick={() => void runOcr(true)}
            >
              {ocrState === "running" ? t("img.ocrRunning") : t("img.ocrExtract")}
            </button>
            {ocrState === "ready" && (
              <>
                <button
                  className={`img-tool${ocrShown ? " on" : ""}`}
                  title={ocrShown ? t("img.ocrHide") : t("img.ocrShow")}
                  aria-pressed={ocrShown}
                  onClick={() => setOcrShown((shown) => !shown)}
                >
                  {ocrShown ? t("img.ocrHide") : t("img.ocrShow")}
                </button>
                <button
                  className="img-tool"
                  title={t("img.ocrCopyAll")}
                  onClick={copyAllOcr}
                >
                  {t("img.ocrCopyAll")}
                </button>
              </>
            )}
            {ocrState === "empty" && (
              <span className="img-note">{t("img.ocrEmpty")}</span>
            )}
          </>
        )}
        {dims.width > 0 && (
          <span className="img-dims">
            {dims.width} × {dims.height}
          </span>
        )}
        {/* Here rather than only in Settings, because wanting it is a thing that happens while
            looking at a picture that has gone invisible on the backdrop it is on. */}
        <BackdropPicker value={backdrop} onChange={onSaveBackdrop} />
        {onBrowseFolder && (
          <button
            className="img-tool"
            title={t("img.browseFolder")}
            onClick={() => onBrowseFolder(path)}
          >
            {t("img.browseFolder")}
          </button>
        )}
        {viaAsset && <span className="img-note">{t("img.viaAsset")}</span>}
      </div>

      <div
        className="img-stage"
        ref={stageRef}
        // Reaching for the picture is a decision, not a hand passing over: the tools go at once
        // and the picture gets the whole pane.
        onPointerDown={() => {
          closeNow();
          setOcrMenu(null);
        }}
        onWheel={(e) => {
          // Ctrl+wheel only: a bare wheel over the picture would zoom the app out from under
          // the user, and this pane has nothing to scroll, so nothing would be gained.
          if (!e.ctrlKey) return;
          e.preventDefault();
          stepBy(e.deltaY < 0 ? 1 : -1);
        }}
        onContextMenu={(event) => {
          if (ocrState !== "ready" || !ocrShown) return;
          event.preventDefault();
          setOcrMenu({
            x: event.clientX,
            y: event.clientY,
            selection: window.getSelection()?.toString() ?? "",
          });
        }}
      >
        {failed || !src ? (
          <div className="editor-empty">
            <div>{malformed ? t("img.malformed") : src ? t("img.failed") : t("app.loading")}</div>
            <div className="img-actions">
              {failed && !viaAsset && !malformed && !external && (
                <button
                  className="btn"
                  onClick={() => {
                    setFailed(false);
                    setViaAsset(true);
                    void assetSrc().then(setSrc);
                  }}
                >
                  {t("img.retryAsset")}
                </button>
              )}
              {/* A picture this pane cannot draw may still open in whatever handles it
                  properly, which beats leaving the user with a dead pane. */}
              {malformed && !external && (
                <button
                  className="btn primary"
                  onClick={() => void revealItemInDir(path).catch(() => {})}
                >
                  {t("img.openSystem")}
                </button>
              )}
            </div>
          </div>
        ) : (
          <div
            className="img-ocr-shell"
            style={
              pictureWidth > 0 && pictureHeight > 0
                ? { width: `${pictureWidth}px`, height: `${pictureHeight}px` }
                : undefined
            }
          >
            <img
              className="img-frame"
              src={src}
              alt=""
              style={
                pictureWidth > 0 && pictureHeight > 0
                  ? {
                      // Pixels of the picture's own size, not a share of the pane: "100%" is the
                      // picture at its real size, which is what the 100% button says. Both caps
                      // have to go, or a picture taller than the pane stops growing while the
                      // percentage keeps climbing.
                      width: "100%",
                      height: "100%",
                      maxWidth: "none",
                      maxHeight: "none",
                    }
                  : undefined
              }
              onLoad={(e) => {
                const img = e.currentTarget;
                setDims({ width: img.naturalWidth, height: img.naturalHeight });
              }}
              onError={() => setFailed(true)}
            />
            {ocrState === "ready" && ocrShown && ocr && (
              <div className="img-ocr-layer" ref={ocrLayerRef}>
                {ocr.lines.map((line, lineIndex) => (
                  <div className="img-ocr-line" key={lineIndex}>
                    {line.words.map((word, wordIndex) => (
                      <span
                        key={wordIndex}
                        style={{
                          left: `${word.x * ocrScaleX}px`,
                          top: `${word.y * ocrScaleY}px`,
                          width: `${word.width * ocrScaleX}px`,
                          height: `${word.height * ocrScaleY}px`,
                          fontSize: `${Math.max(8, word.height * ocrScaleY * 0.82)}px`,
                          lineHeight: `${word.height * ocrScaleY}px`,
                        }}
                      >
                        {word.text}
                        {wordHasGap(line, wordIndex) ? " " : ""}
                      </span>
                    ))}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {ocrMenu && (
        <div
          className="ctx-menu"
          ref={ocrMenuRef}
          style={{ left: ocrMenuAt.left, top: ocrMenuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {ocrMenu.selection && (
            <div className="ctx-item" onClick={copyOcrSelection}>
              {t("img.ocrCopy")}
            </div>
          )}
          <div className="ctx-item" onClick={selectAllOcr}>
            {t("img.ocrSelectAll")}
          </div>
          <div className="ctx-item" onClick={copyAllOcr}>
            {t("img.ocrCopyAll")}
          </div>
          <div className="ws-sep" />
          <div
            className="ctx-item"
            onClick={() => {
              setOcrShown(false);
              setOcrMenu(null);
            }}
          >
            {t("img.ocrHide")}
          </div>
        </div>
      )}
    </div>
  );
}
