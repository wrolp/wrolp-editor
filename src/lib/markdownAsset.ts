/**
 * Resolving a markdown document's own references to files beside it.
 *
 * Shared by the preview, which turns those references into asset URLs, and the export, which
 * inlines them as base64: both must agree on what counts as "beside the document", or an
 * export would miss a picture the preview showed. Nothing here touches the DOM or Tauri —
 * the callers decide what to do with the path they get back.
 */

/** Picture extensions a document may embed beside itself. */
export const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg|tiff?|heic)$/i;

/** The same, for a document that embeds a recording rather than a picture. */
export const MEDIA_EXT = /\.(?:mp4|m4v|webm|mov|avi|mkv|ogv|mp3|wav|ogg|oga|opus|flac|aac|m4a)$/i;

/** The folder a file sits in; the path itself when it has no folder part. */
export function dirOf(filePath: string): string {
  const cut = filePath.replace(/[\\/][^\\/]*$/, "");
  return cut || filePath;
}

/**
 * A reference that is not a file beside the document: it names a scheme, a share (`//server/x`),
 * a drive (`C:\x`) or a root (`/x`). The last two are how a whole drive would be reached, and a
 * document has no business naming either.
 */
export const NOT_A_LOCAL_PATH = /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/|#)/i;

/**
 * The file part of a reference and its `#fragment`, split the way a browser splits it. A query
 * stays with the file part, since nothing in a local file answers one.
 */
export function splitFragment(ref: string): [string, string] {
  const at = ref.indexOf("#");
  return at === -1 ? [ref, ""] : [ref.slice(0, at), ref.slice(at + 1)];
}

/** Undo a percent-escaping, or hand back the raw text when it is not well formed. */
export function decodeRef(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/**
 * Walk `ref` from the document's folder, `..` included. Null when the walk ends above the root
 * it started from, which is a fold the document does not actually live in.
 */
export function joinToLocal(ref: string, baseDir: string): string | null {
  const segments = (baseDir ? `${baseDir}\\` : "").split(/[\\/]+/).filter(Boolean);
  for (const part of ref.replace(/\//g, "\\").split("\\")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.length > 1 ? segments.join("\\") : null;
}

/**
 * Resolve an embedded asset's src against the document's folder, or return null when it is
 * not a local reference. Absolute URLs, data URIs, protocol-relative and root-absolute
 * links, and Windows paths spelled in the markdown ("C:\x.png") all return null: the first
 * group already resolves on its own, and the rest is what `NOT_A_LOCAL_PATH` refuses for
 * links too.
 *
 * Percent-decoded, for the same reason a link is: the src arrives here out of the sanitiser's
 * serialized string, and that serialization escapes every non-ASCII name — a picture called
 * `架构图.svg` reaches this as `%E6%9E%B6%E6%9E%84%E5%9B%BE.svg`. Joining the escaped form
 * hands the asset protocol a `%` to escape a second time, and it then answers 404 for a file
 * that is sitting right beside the document.
 */
export function resolveLocalAsset(src: string | null, baseDir: string): string | null {
  if (!src) return null;
  if (baseDir && NOT_A_LOCAL_PATH.test(src)) return null;
  const file = splitFragment(src)[0].split(/[?#]/)[0];
  if (!IMAGE_EXT.test(file) && !MEDIA_EXT.test(file)) return null;
  const decoded = decodeRef(file);
  if (NOT_A_LOCAL_PATH.test(decoded)) return null;
  return joinToLocal(decoded, baseDir);
}

/** Every element in a preview that can point at a file beside the document. */
export const LOCAL_ASSET_SELECTOR = "img, video, audio, source";
