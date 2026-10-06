import { useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { t } from "../lib/i18n";
import { api, revealItemInDir } from "../lib/tauri";

interface Props {
  path: string;
  /**
   * The buffer, for SVG only. An SVG is text, so it is already in memory and can be handed
   * to the image as a data URL — which sidesteps both the asset scope (a picture in a
   * refused folder stays unreachable that way) and whatever MIME the webview infers for
   * `.svg`. Null for a raster image, which has no text to build a URL from.
   */
  text?: string | null;
}

const STEPS = [25, 50, 75, 100, 150, 200, 400];

function nextStep(current: number | null, direction: 1 | -1): number {
  if (current === null) return direction === 1 ? 100 : STEPS[0];
  const at = STEPS.indexOf(current);
  if (at < 0) return 100;
  return STEPS[Math.min(STEPS.length - 1, Math.max(0, at + direction))];
}

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
export default function ImagePreview({ path, text }: Props) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  /** null means "fit the pane"; a number is a percentage of the image's own size. */
  const [step, setStep] = useState<number | null>(null);
  const [dims, setDims] = useState({ width: 0, height: 0 });
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
    setStep(null);
    setDims({ width: 0, height: 0 });
    setViaAsset(false);
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
  }, [assetSrc, inlineSvg]);

  return (
    <div className="img-preview">
      <div className="img-tools">
        <button
          className="img-tool"
          title={t("img.zoomOut")}
          onClick={() => setStep((prev) => nextStep(prev, -1))}
          disabled={step === STEPS[0]}
        >
          −
        </button>
        <span className="img-zoom">{step === null ? t("img.fit") : `${step}%`}</span>
        <button
          className="img-tool"
          title={t("img.zoomIn")}
          onClick={() => setStep((prev) => nextStep(prev, 1))}
          disabled={step === STEPS[STEPS.length - 1]}
        >
          +
        </button>
        <button
          className="img-tool"
          title={t("img.actual")}
          onClick={() => setStep((prev) => (prev === 100 ? null : 100))}
        >
          {t("img.actual")}
        </button>
        {dims.width > 0 && (
          <span className="img-dims">
            {dims.width} × {dims.height}
          </span>
        )}
        {viaAsset && <span className="img-note">{t("img.viaAsset")}</span>}
      </div>

      <div
        className="img-stage"
        onWheel={(e) => {
          // Ctrl+wheel only: a bare wheel over the picture would zoom the app out from under
          // the user, and this pane has nothing to scroll, so nothing would be gained.
          if (!e.ctrlKey) return;
          e.preventDefault();
          setStep((prev) => nextStep(prev, e.deltaY < 0 ? 1 : -1));
        }}
      >
        {failed || !src ? (
          <div className="editor-empty">
            <div>{malformed ? t("img.malformed") : src ? t("img.failed") : t("app.loading")}</div>
            <div className="img-actions">
              {failed && !viaAsset && !malformed && (
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
              {malformed && (
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
          <img
            className="img-frame"
            src={src}
            alt=""
            style={step === null ? undefined : { width: `${step}%`, maxWidth: "none" }}
            onLoad={(e) => {
              const img = e.currentTarget;
              setDims({ width: img.naturalWidth, height: img.naturalHeight });
            }}
            onError={() => setFailed(true)}
          />
        )}
      </div>
    </div>
  );
}
