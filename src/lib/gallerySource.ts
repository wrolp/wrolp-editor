/**
 * Where a gallery's pictures come from: a folder on disk, or the inside of a zip or 7z.
 *
 * The folder case is the original one: the backend lists it and the asset protocol serves the
 * pictures. An archive has neither a folder to list nor a path the asset protocol accepts, so
 * the backend lists its entries and a second protocol — `wrolp-archive` — serves the pictures.
 * That protocol only answers for archives the user has opened in this session, and builds its
 * URLs from base64-encoded names, so no path in it can be mistaken for a filesystem path.
 */
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, type ImageEntry } from "./tauri";

export type GallerySource =
  | { kind: "dir"; dir: string }
  | { kind: "archive"; archive: string; inner: string };

/** The archive a source reads from, or null for a folder. */
export function sourceArchive(source: GallerySource): string | null {
  return source.kind === "archive" ? source.archive : null;
}

export interface GalleryList {
  items: ImageEntry[];
  truncated: boolean;
  scanned: number;
}

/**
 * The pictures of one source, in the order the gallery should show them.
 *
 * Archive items carry their entry name in `path`: within one gallery it is as unique as a
 * disk path, and it is exactly what the picture URL needs.
 */
export async function listGallery(
  source: GallerySource,
  recursive: boolean
): Promise<GalleryList> {
  if (source.kind === "dir") {
    await api.allowAssetDir(source.dir);
    return api.listImages(source.dir, recursive);
  }
  const list = await api.archiveListImages(source.archive, source.inner, recursive);
  return {
    items: list.items.map((item) => ({
      name: item.name,
      path: item.entry,
      bytes: item.bytes,
    })),
    truncated: list.truncated,
    scanned: list.scanned,
  };
}

/** base64url without padding, which is what the Rust side decodes. */
function b64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const SCHEME = "wrolp-archive";

/**
 * A URL the `wrolp-archive` protocol answers. `thumb` asks for a shrunken copy whose long side
 * is that many pixels; without it the picture itself is served.
 *
 * The host part is per platform and matches what Tauri does for its own asset protocol: Windows
 * (and Android) put the scheme in a subdomain of localhost, while macOS and Linux use the scheme
 * directly. Using `convertFileSrc` is not an option here because it percent-encodes the whole
 * string, query string included.
 */
export function archiveImageSrc(
  archive: string,
  entry: string,
  thumb?: number
): string {
  const query = `a=${b64url(archive)}&e=${b64url(entry)}${thumb ? `&t=${thumb}` : ""}`;
  return navigator.userAgent.includes("Windows")
    ? `http://${SCHEME}.localhost/img?${query}`
    : `${SCHEME}://localhost/img?${query}`;
}

/**
 * A URL the `<img>` can use: the asset protocol for a folder's picture, the archive protocol
 * for an entry. Both are stable for the lifetime of the page, so no blob has to be kept alive
 * or released.
 */
export function loadImage(
  archive: string | null,
  item: ImageEntry,
  thumb?: number
): string {
  return archive === null ? convertFileSrc(item.path) : archiveImageSrc(archive, item.path, thumb);
}
