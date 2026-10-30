import DOMPurify from "dompurify";
import { marked } from "marked";
import { SANITIZE } from "./markdownHtml";
import { IMAGE_EXT, LOCAL_ASSET_SELECTOR, dirOf, resolveLocalAsset } from "./markdownAsset";
import { api } from "./tauri";

/** A rendered document plus the local files whose bytes could not be included. */
export interface ExportResult {
  html: string;
  /** Absolute paths of images that were left out, so the caller can say how many. */
  missing: string[];
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
  docPath: string
): Promise<ExportResult> {
  const raw = marked.parse(markdown, { async: false, gfm: true, breaks: true }) as string;
  const clean = DOMPurify.sanitize(raw, SANITIZE);
  const doc = new DOMParser().parseFromString(`<body>${clean}</body>`, "text/html");
  const base = dirOf(docPath);
  const missing: string[] = [];

  for (const el of Array.from(doc.body.querySelectorAll(LOCAL_ASSET_SELECTOR))) {
    for (const attr of ["src", "poster"]) {
      const abs = resolveLocalAsset(el.getAttribute(attr), base);
      if (!abs) continue;
      if (!IMAGE_EXT.test(abs)) {
        // A recording cannot be carried as a data URI worth its size; leaving it out is
        // honest, and the caller names it in the warning.
        el.removeAttribute(attr);
        missing.push(abs);
        continue;
      }
      try {
        // The backend reads only directories the preview has already been granted, so the
        // grant has to be in place before the read — the same order the preview uses.
        await api.allowAssetDir(dirOf(abs));
        const data = await api.readExportAsset(abs);
        el.setAttribute(attr, `data:${mimeOf(abs)};base64,${data}`);
      } catch {
        el.removeAttribute(attr);
        missing.push(abs);
      }
    }
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
  docPath: string
): Promise<string[]> {
  const { html, missing } = await renderForExport(markdown, docPath);
  const root = document.createElement("div");
  root.className = "print-root";
  root.innerHTML = html;
  document.body.appendChild(root);
  document.body.classList.add("printing");
  const done = () => {
    document.body.classList.remove("printing");
    root.remove();
    window.removeEventListener("afterprint", done);
  };
  window.addEventListener("afterprint", done);
  try {
    window.print();
  } catch (error) {
    done();
    throw error;
  }
  return missing;
}
