import DOMPurify from "dompurify";
import { marked } from "marked";
import { SANITIZE } from "./markdownHtml";
import { IMAGE_EXT, LOCAL_ASSET_SELECTOR, dirOf, resolveLocalAsset } from "./markdownAsset";
import { basename } from "./path";
import { api } from "./tauri";

/** A rendered document plus the local files whose bytes could not be included. */
export interface ExportResult {
  html: string;
  /** Absolute paths of images that were left out, so the caller can say how many. */
  missing: string[];
}

/** How a render reports itself, and how a caller stops it. */
export interface ExportOptions {
  /** Aborting stops the render between images; nothing is printed afterwards. */
  signal?: AbortSignal;
  /** Called once with the number of images to inline, then after each one. */
  onProgress?: (done: number, total: number) => void;
  /** Called when the render is done and the print dialog is about to open. */
  onStage?: (stage: "render" | "print") => void;
}

/** The error an aborted export throws, recognisable by name like any other `AbortError`. */
function aborted(): DOMException {
  return new DOMException("Export cancelled", "AbortError");
}

/**
 * Pictures above this are re-encoded smaller before they are inlined.
 *
 * Printing rasterises every picture in the document, and a handful of multi-megabyte
 * photographs is what makes the dialog sit there doing nothing for several seconds — the
 * wait that reads as "the print window will not open". 1600 px on the long edge is still
 * sharper than a printed page can show.
 */
const INLINE_MAX_BYTES = 512 * 1024;
const INLINE_MAX_EDGE = 1600;
const INLINE_QUALITY = 0.85;

/** How long to wait for `afterprint` before releasing the UI anyway. */
const PRINT_WAIT_MS = 15000;

/** Base64 for a byte array, in chunks so a few megabytes do not blow the argument limit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * The bytes to inline for one picture, shrunk when the file is large enough to make the
 * print layout wait on decoding.
 *
 * SVG is left alone: it is text, it rasterises at whatever size it is drawn, and pushing it
 * through a canvas would trade that for one fixed bitmap. A picture with transparency keeps
 * PNG; everything else becomes JPEG at a print-adequate quality.
 */
async function inlineImage(
  abs: string,
  data64: string
): Promise<{ data: string; mime: string }> {
  const mime = mimeOf(abs);
  if (abs.toLowerCase().endsWith(".svg")) return { data: data64, mime };
  const raw = atob(data64);
  if (raw.length <= INLINE_MAX_BYTES) return { data: data64, mime };
  try {
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
    const scale = Math.min(1, INLINE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      bitmap.close?.();
      return { data: data64, mime };
    }
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const keepAlpha = /\.(?:png|webp|ico)$/i.test(abs);
    const blob = await canvas.convertToBlob(
      keepAlpha ? { type: "image/png" } : { type: "image/jpeg", quality: INLINE_QUALITY }
    );
    return {
      data: toBase64(new Uint8Array(await blob.arrayBuffer())),
      mime: keepAlpha ? "image/png" : "image/jpeg",
    };
  } catch {
    // A format this browser cannot decode keeps its original bytes: a big picture is still
    // better than one that silently vanished.
    return { data: data64, mime };
  }
}

/** MIME type for an inlined picture, from its extension. */
function mimeOf(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "avif":
      return "image/avif";
    case "bmp":
      return "image/bmp";
    case "ico":
      return "image/x-icon";
    case "svg":
      return "image/svg+xml";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "heic":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}

/**
 * Render markdown for export.
 *
 * The preview's own HTML cannot be reused: its images point at asset URLs, which are a
 * protocol inside this app and mean nothing to Word or to a printed page. This renders the
 * source again with the same sanitiser, then replaces every local picture with a base64 data
 * URI — the form that survives leaving the app.
 *
 * Code fences come out as their source, without the preview's colouring: an export has to
 * read the same in Word and on paper, where the app's theme does not exist.
 */
export async function renderForExport(
  markdown: string,
  docPath: string,
  opts?: ExportOptions
): Promise<ExportResult> {
  const raw = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  const clean = DOMPurify.sanitize(raw, SANITIZE);
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  const base = dirOf(docPath);
  const missing: string[] = [];
  opts?.onStage?.("render");

  /**
   * Collected before anything is read, so the total is known up front. Every image is a
   * separate round trip through the backend, and the first export of a picture-heavy
   * document is where the wait actually comes from — a count makes that wait legible.
   */
  const jobs: { el: Element; attr: string; abs: string }[] = [];
  for (const el of Array.from(doc.body.querySelectorAll(LOCAL_ASSET_SELECTOR))) {
    for (const attr of ["src", "poster"]) {
      const abs = resolveLocalAsset(el.getAttribute(attr), base);
      if (abs) jobs.push({ el, attr, abs });
    }
  }
  opts?.onProgress?.(0, jobs.length);

  let done = 0;
  for (const job of jobs) {
    // Checked per image, not once at the top: a document with forty pictures is exactly the
    // case where cancelling has to work between two of them.
    if (opts?.signal?.aborted) throw aborted();
    if (!IMAGE_EXT.test(job.abs)) {
      // A recording cannot be carried as a data URI worth its size; leaving it out is
      // honest, and the caller names it in the warning.
      job.el.removeAttribute(job.attr);
      missing.push(job.abs);
    } else {
      try {
        // The backend reads only directories the preview has already been granted, so the
        // grant has to be in place before the read — the same order the preview uses.
        await api.allowAssetDir(dirOf(job.abs));
        const inlined = await inlineImage(job.abs, await api.readExportAsset(job.abs));
        job.el.setAttribute(job.attr, `data:${inlined.mime};base64,${inlined.data}`);
      } catch {
        job.el.removeAttribute(job.attr);
        missing.push(job.abs);
      }
    }
    done += 1;
    opts?.onProgress?.(done, jobs.length);
  }
  return { html: doc.body.innerHTML, missing };
}

/**
 * Print a rendered document through the browser's own print dialog, which on Windows offers
 * "Save as PDF".
 *
 * The rendered document is laid over the app as a direct child of `<body>`; `body.printing`
 * hides everything else for the duration, so what comes out is the document and not the
 * editor around it. The class comes off on `afterprint`, and again if printing throws.
 */
export async function printMarkdown(
  markdown: string,
  docPath: string,
  opts?: ExportOptions
): Promise<string[]> {
  const { html, missing } = await renderForExport(markdown, docPath, opts);
  // A cancel that lands during the last image must not still open the dialog.
  if (opts?.signal?.aborted) throw aborted();
  opts?.onStage?.("print");
  // One frame for the progress line to paint: `window.print` blocks the thread, so without
  // this the "opening the dialog" state would be set and never seen.
  await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  // Checked again after the frame: a caller that aborts for its own reasons must not be
  // answered with a dialog.
  if (opts?.signal?.aborted) throw aborted();
  const root = document.createElement("div");
  root.className = "print-root";
  root.innerHTML = html;
  document.body.appendChild(root);
  document.body.classList.add("printing");
  // The print dialog takes its default file name from the document title. Left as the app's
  // name, "Save as PDF" offers "WROLP Editor.pdf" no matter which document was printed.
  const previousTitle = document.title;
  const fileName = basename(docPath);
  document.title = fileName.replace(/\.[^./\\]+$/, "") || fileName;
  const done = () => {
    document.title = previousTitle;
    document.body.classList.remove("printing");
    root.remove();
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  try {
    // Some engines block here until the dialog closes; others return at once and open the
    // dialog a moment later. Waiting for `afterprint` covers both, so the progress line
    // lasts until the dialog is really gone instead of vanishing the instant printing is
    // requested — which looked like the click had failed while the dialog was still loading.
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        window.removeEventListener("afterprint", finish);
        resolve();
      };
      const timer = window.setTimeout(finish, PRINT_WAIT_MS);
      window.addEventListener("afterprint", finish, { once: true });
      window.print();
    });
  } catch (error) {
    done();
    throw error;
  }
  done();
  return missing;
}
