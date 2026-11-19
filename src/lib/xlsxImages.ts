import JSZip from "jszip";

/**
 * Pictures embedded in a workbook, and where the sheet puts them.
 *
 * A spreadsheet's cell text is not the whole sheet: a picture is an entry under `xl/media`,
 * drawn by a `xl/drawings/drawingN.xml` that anchors it to a cell range. The spreadsheet
 * library the viewer uses reads cells only (its drawing support is a paid tier), so the zip
 * is read a second time here for the two things it does not cover.
 *
 * Offsets are Excel's own unit — EMU, 1/914400 inch, which is 1/9525 pixel at 96dpi. They are
 * kept unconverted so the caller can add them to whatever a cell's measured position is.
 */

/** Where one picture starts, and optionally ends, in grid coordinates. */
export interface ImageAnchor {
  /** Zero-based column and row. */
  col: number;
  row: number;
  /** Offset inside that cell, in EMU. */
  colOff: number;
  rowOff: number;
}

export interface SheetImage {
  /** Object URL of the picture, revoked by `releaseSheetImages`. */
  url: string;
  from: ImageAnchor;
  /** Present for a two-cell anchor: the picture is stretched between the two corners. */
  to?: ImageAnchor;
  /** Present for a one-cell or absolute anchor: the size the file records, in pixels. */
  width?: number;
  height?: number;
}

/** A picture that lives inside one cell rather than floating over the grid. */
export interface CellPicture {
  /** Object URL of the picture, revoked by `releaseSheetImages`. */
  url: string;
  /** Size the file records, in pixels, when it records one. */
  width?: number;
  height?: number;
}

export interface SheetImageSet {
  images: SheetImage[];
  /** Pictures placed inside cells, keyed `"row:col"` with zero-based sheet coordinates. */
  cells: Record<string, CellPicture>;
  /** Every object URL this set created, so releasing it revokes all of them. */
  urls: string[];
  /** Pictures left out by the caps below, so the viewer can say the sheet is not complete. */
  skipped: number;
}

/** Pictures by sheet name, exactly as `xl/workbook.xml` spells them. */
export type SheetImages = Record<string, SheetImageSet>;

/**
 * Caps for one sheet.
 *
 * A workbook is a zip, so a picture can be any size and there can be thousands of them. The
 * viewer draws what a document plausibly holds and stops: decoding a hundred megabytes of
 * photographs is not a preview but a way to lock the window.
 */
const MAX_IMAGES_PER_SHEET = 200;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

/** EMU per CSS pixel at 96dpi, the unit the anchors and extents are written in. */
export const EMU_PER_PX = 9525;

/** The relationships namespace, for `r:embed` and `r:id`. */
const REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/**
 * Where an in-cell picture is kept.
 *
 * WPS writes a `xl/cellimages.xml` part naming each picture, and puts `DISPIMG("ID_…")` in the
 * cell that shows it. Excel 365 writes the newer rich-value parts and marks the cell with a
 * `vm` index instead. The two are unrelated, so both are read when present.
 */
const CELL_IMAGES_PART = "xl/cellimages.xml";
const METADATA_PART = "xl/metadata.xml";
const RICH_VALUE_PART = "xl/richData/rdrichvalue.xml";
const RICH_STRUCTURE_PART = "xl/richData/rdrichvaluestructure.xml";
const RICH_RELS_PART = "xl/richData/richValueRel.xml";

/** Picture types this renderer can draw, by extension, when the bytes do not say. */
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};

function parseXml(text: string): Document | null {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  // Chromium reports a malformed part as a document whose root is `parsererror`.
  return doc.getElementsByTagName("parsererror").length > 0 ? null : doc;
}

/** Every descendant with this local name, whatever prefix the part happens to use. */
function elementsOf(root: Document | Element, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS("*", name));
}

function childElements(root: Element): Element[] {
  return Array.from(root.children);
}

/** An attribute that relationships normally spell with an `r:` prefix. */
function relAttr(element: Element, name: string): string | null {
  return (
    element.getAttribute(`r:${name}`) ??
    element.getAttributeNS(REL_NS, name) ??
    element.getAttribute(name)
  );
}

/** Resolve a relationship target against the part that declares it. */
function resolvePart(from: string, target: string): string {
  const base = target.startsWith("/") ? [] : from.split("/").slice(0, -1);
  const out: string[] = [];
  for (const segment of [...base, ...target.replace(/^\//, "").split("/")]) {
    if (!segment || segment === ".") continue;
    if (segment === "..") out.pop();
    else out.push(segment);
  }
  return out.join("/");
}

function relsPath(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash)}/_rels/${part.slice(slash + 1)}.rels`;
}

/** `Id -> resolved part path` for one part's relationships file. */
async function readRels(zip: JSZip, part: string): Promise<Map<string, string>> {
  const file = zip.file(relsPath(part));
  const map = new Map<string, string>();
  if (!file) return map;
  const doc = parseXml(await file.async("string"));
  if (!doc) return map;
  for (const rel of elementsOf(doc, "Relationship")) {
    const id = rel.getAttribute("Id");
    const target = rel.getAttribute("Target");
    const mode = rel.getAttribute("TargetMode");
    // An external target is a link, not a picture stored in the file.
    if (id && target && mode !== "External") map.set(id, resolvePart(part, target));
  }
  return map;
}

/** The coordinates written inside an anchor's `<from>` or `<to>`. */
function anchorPoint(element: Element | undefined): ImageAnchor | null {
  if (!element) return null;
  const col = Number(elementsOf(element, "col")[0]?.textContent ?? NaN);
  const row = Number(elementsOf(element, "row")[0]?.textContent ?? NaN);
  if (!Number.isFinite(col) || !Number.isFinite(row)) return null;
  const colOff = Number(elementsOf(element, "colOff")[0]?.textContent ?? 0) || 0;
  const rowOff = Number(elementsOf(element, "rowOff")[0]?.textContent ?? 0) || 0;
  return { col, row, colOff, rowOff };
}

function emuToPx(value: string | null): number | undefined {
  const emu = Number(value ?? NaN);
  return Number.isFinite(emu) ? Math.max(1, emu / EMU_PER_PX) : undefined;
}

/**
 * How one drawing anchor places its picture.
 *
 * `twoCellAnchor` stretches between two cells, `oneCellAnchor` starts at a cell and carries
 * its own size, and `absoluteAnchor` carries a position from the sheet's top-left corner.
 */
function anchorGeometry(anchor: Element): Omit<SheetImage, "url"> | null {
  const from = anchorPoint(elementsOf(anchor, "from")[0]);
  const to = anchorPoint(elementsOf(anchor, "to")[0]);
  if (from && to) return { from, to };
  const ext = elementsOf(anchor, "ext")[0];
  const width = emuToPx(ext?.getAttribute("cx") ?? null);
  const height = emuToPx(ext?.getAttribute("cy") ?? null);
  if (from && width && height) return { from, width, height };
  const pos = elementsOf(anchor, "pos")[0];
  const x = emuToPx(pos?.getAttribute("x") ?? null);
  const y = emuToPx(pos?.getAttribute("y") ?? null);
  if (x !== undefined && y !== undefined && width && height) {
    // An absolute anchor is measured from A1: the same origin the grid starts at.
    return {
      from: { col: 0, row: 0, colOff: x * EMU_PER_PX, rowOff: y * EMU_PER_PX },
      width,
      height,
    };
  }
  return null;
}

/** Detect the picture type from its bytes: the extension in the zip is not always right. */
function sniffMime(bytes: Uint8Array, name: string): string {
  const at = (i: number) => bytes[i] ?? 0;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46) return "image/gif";
  if (at(0) === 0x42 && at(1) === 0x4d) return "image/bmp";
  if (at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50) return "image/webp";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_MIME[ext] ?? "application/octet-stream";
}

/** Pictures anchored directly to the sheet, in file order. */
function anchorsOf(doc: Document): Element[] {
  const root = doc.documentElement;
  return childElements(root).filter((element) =>
    ["twoCellAnchor", "oneCellAnchor", "absoluteAnchor"].includes(element.localName)
  );
}

/** A size written by the file, kept only when it is a real one: WPS writes 0 for cell pictures. */
function positivePx(value: string | null): number | undefined {
  const emu = Number(value ?? NaN);
  return Number.isFinite(emu) && emu > 0 ? emu / EMU_PER_PX : undefined;
}

/** `"B3"` -> zero-based column and row. */
function cellCoords(ref: string): { col: number; row: number } | null {
  const match = /^([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  let col = 0;
  for (const letter of match[1]) col = col * 26 + (letter.charCodeAt(0) - 64);
  return { col: col - 1, row: Number(match[2]) - 1 };
}

/**
 * One picture's bytes, decoded once per workbook.
 *
 * A workbook can point several cells at the same media part, and an object URL is what keeps
 * the bytes alive; sharing it means one decode and one revoke. The cache also holds `null` for
 * a part that cannot be drawn, so a broken picture is not read twice.
 */
async function pictureFromMedia(
  zip: JSZip,
  media: string,
  cache: Map<string, CellPicture | null>,
  urls: string[]
): Promise<CellPicture | null> {
  if (cache.has(media)) return cache.get(media) ?? null;
  const file = zip.file(media);
  if (!file) {
    cache.set(media, null);
    return null;
  }
  const bytes = await file.async("uint8array");
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    cache.set(media, null);
    return null;
  }
  const bytesCopy = new Uint8Array(bytes.byteLength);
  bytesCopy.set(bytes);
  const picture: CellPicture = {
    url: URL.createObjectURL(new Blob([bytesCopy.buffer], { type: sniffMime(bytes, media) })),
  };
  urls.push(picture.url);
  cache.set(media, picture);
  return picture;
}

/** Where WPS's `xl/cellimages.xml` says one named picture's media is. */
interface NamedPicture {
  media: string;
  width?: number;
  height?: number;
}

/** WPS's `xl/cellimages.xml`: picture name (`ID_…`) -> its media, read but not decoded yet. */
async function wpsCellPictures(zip: JSZip): Promise<Map<string, NamedPicture>> {
  const out = new Map<string, NamedPicture>();
  const file = zip.file(CELL_IMAGES_PART);
  if (!file) return out;
  const doc = parseXml(await file.async("string"));
  if (!doc) return out;
  const rels = await readRels(zip, CELL_IMAGES_PART);
  for (const pic of elementsOf(doc, "pic")) {
    const name = elementsOf(pic, "cNvPr")[0]?.getAttribute("name");
    const blip = elementsOf(pic, "blip")[0];
    const embed = blip ? relAttr(blip, "embed") : null;
    const media = embed ? rels.get(embed) : undefined;
    if (!name || !media) continue;
    const ext = elementsOf(pic, "ext")[0];
    out.set(name, {
      media,
      width: ext ? positivePx(ext.getAttribute("cx")) : undefined,
      height: ext ? positivePx(ext.getAttribute("cy")) : undefined,
    });
  }
  return out;
}

/** A cell's `vm` attribute (1-based) -> the rich value it names, or -1 for other metadata. */
async function richValueIndexes(zip: JSZip): Promise<number[]> {
  const out: number[] = [];
  const file = zip.file(METADATA_PART);
  if (!file) return out;
  const doc = parseXml(await file.async("string"));
  if (!doc) return out;
  const types = elementsOf(doc, "metadataTypes")[0];
  const names = types ? childElements(types).map((element) => element.getAttribute("name")) : [];
  const richType = names.indexOf("XLRICHVALUE") + 1;
  if (richType === 0) return out;
  const future = elementsOf(doc, "futureMetadata").find(
    (element) => element.getAttribute("name") === "XLRICHVALUE"
  );
  const richIds = future
    ? childElements(future)
        .filter((element) => element.localName === "bk")
        .map((bk) => {
          const index = Number(elementsOf(bk, "rvb")[0]?.getAttribute("i") ?? NaN);
          return Number.isFinite(index) ? index : -1;
        })
    : [];
  const values = elementsOf(doc, "valueMetadata")[0];
  if (!values) return out;
  for (const bk of childElements(values).filter((element) => element.localName === "bk")) {
    const rc = childElements(bk).find((element) => element.localName === "rc");
    const type = Number(rc?.getAttribute("t") ?? NaN);
    const value = Number(rc?.getAttribute("v") ?? NaN);
    out.push(
      type === richType && Number.isFinite(value) && (richIds[value] ?? -1) >= 0
        ? richIds[value]
        : -1
    );
  }
  return out;
}

/** Rich value index -> the media part of a `_localImage` value, or "" for any other value. */
async function richValueMedia(zip: JSZip): Promise<string[]> {
  const structuresFile = zip.file(RICH_STRUCTURE_PART);
  const valuesFile = zip.file(RICH_VALUE_PART);
  const relsFile = zip.file(RICH_RELS_PART);
  if (!structuresFile || !valuesFile || !relsFile) return [];
  const structures = parseXml(await structuresFile.async("string"));
  const values = parseXml(await valuesFile.async("string"));
  const relsDoc = parseXml(await relsFile.async("string"));
  if (!structures || !values || !relsDoc) return [];
  const keyIndexes = childElements(structures.documentElement).map((structure) =>
    childElements(structure).findIndex(
      (key) => key.getAttribute("n") === "_rvRel:LocalImageIdentifier"
    )
  );
  const relIds = childElements(relsDoc.documentElement).map((rel) => relAttr(rel, "id") ?? "");
  const relTargets = await readRels(zip, RICH_RELS_PART);
  const out: string[] = [];
  for (const rv of elementsOf(values, "rv")) {
    // The value's `s` picks the structure; the key's position picks which `<v>` holds the rel.
    const structure = Number(rv.getAttribute("s") ?? 0) || 0;
    const key = keyIndexes[structure] ?? -1;
    const rel = key >= 0 ? Number(childElements(rv)[key]?.textContent ?? NaN) : NaN;
    const media = Number.isFinite(rel) ? relTargets.get(relIds[rel] ?? "") : undefined;
    out.push(media ?? "");
  }
  return out;
}

/** Pictures that one sheet places inside its cells, keyed `"row:col"`. */
async function cellPicturesOfSheet(
  zip: JSZip,
  sheetPart: string,
  wps: Map<string, NamedPicture>,
  vmRich: number[],
  richMedia: string[],
  cache: Map<string, CellPicture | null>,
  urls: string[]
): Promise<{ cells: Record<string, CellPicture>; skipped: number }> {
  const cells: Record<string, CellPicture> = {};
  let skipped = 0;
  const file = zip.file(sheetPart);
  if (!file) return { cells, skipped };
  const doc = parseXml(await file.async("string"));
  const data = doc ? elementsOf(doc, "sheetData")[0] : undefined;
  if (!data) return { cells, skipped };
  for (const cell of elementsOf(data, "c")) {
    const at = cellCoords(cell.getAttribute("r") ?? "");
    if (!at) continue;
    const formula = elementsOf(cell, "f")[0]?.textContent ?? "";
    const id = /DISPIMG\(\s*"([^"]+)"/i.exec(formula)?.[1];
    const named = id ? wps.get(id) : undefined;
    const vm = Number(cell.getAttribute("vm") ?? NaN);
    const richIndex = Number.isFinite(vm) && vm > 0 ? vmRich[vm - 1] : undefined;
    const media =
      named?.media ??
      (richIndex !== undefined && richIndex >= 0 ? richMedia[richIndex] : undefined);
    if (!media) {
      // A cell that names a picture the file does not hold is a picture left out, not text.
      if (id) skipped += 1;
      continue;
    }
    const decoded = await pictureFromMedia(zip, media, cache, urls);
    if (!decoded) {
      skipped += 1;
      continue;
    }
    if (Object.keys(cells).length >= MAX_IMAGES_PER_SHEET) {
      skipped += 1;
      continue;
    }
    cells[`${at.row}:${at.col}`] = {
      ...decoded,
      width: named?.width,
      height: named?.height,
    };
  }
  return { cells, skipped };
}

async function imagesOfSheet(
  zip: JSZip,
  sheetPart: string,
  urls: string[]
): Promise<{ images: SheetImage[]; skipped: number }> {
  const file = zip.file(sheetPart);
  if (!file) return { images: [], skipped: 0 };
  const doc = parseXml(await file.async("string"));
  if (!doc) return { images: [], skipped: 0 };
  const drawingIds = elementsOf(doc, "drawing")
    .map((element) => relAttr(element, "id"))
    .filter((id): id is string => !!id);
  if (drawingIds.length === 0) return { images: [], skipped: 0 };

  const sheetRels = await readRels(zip, sheetPart);
  const images: SheetImage[] = [];
  let skipped = 0;
  for (const id of drawingIds) {
    const drawingPart = sheetRels.get(id);
    const drawing = drawingPart ? zip.file(drawingPart) : null;
    if (!drawingPart || !drawing) continue;
    const drawingDoc = parseXml(await drawing.async("string"));
    if (!drawingDoc) continue;
    const drawingRels = await readRels(zip, drawingPart);
    for (const anchor of anchorsOf(drawingDoc)) {
      const blip = elementsOf(anchor, "blip")[0];
      const embed = blip ? relAttr(blip, "embed") : null;
      const media = embed ? drawingRels.get(embed) : undefined;
      const mediaFile = media ? zip.file(media) : null;
      if (!media || !mediaFile) continue;
      if (images.length >= MAX_IMAGES_PER_SHEET) {
        skipped += 1;
        continue;
      }
      const bytes = await mediaFile.async("uint8array");
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        skipped += 1;
        continue;
      }
      const geometry = anchorGeometry(anchor);
      if (!geometry) {
        skipped += 1;
        continue;
      }
      // Copied into an exact-size buffer: a Blob cannot take a view whose backing store is
      // allowed to be a `SharedArrayBuffer`, and the zip entry may be a slice of a bigger one.
      const bytesCopy = new Uint8Array(bytes.byteLength);
      bytesCopy.set(bytes);
      const url = URL.createObjectURL(
        new Blob([bytesCopy.buffer], { type: sniffMime(bytes, media) })
      );
      urls.push(url);
      images.push({ ...geometry, url });
    }
  }
  return { images, skipped };
}

/**
 * Read every picture a workbook anchors to its sheets.
 *
 * A part that cannot be parsed is skipped rather than fatal: a workbook with one broken
 * drawing is still a workbook whose cells are worth showing. Call `releaseSheetImages` with
 * whatever this returned when the sheet goes away — the URLs keep the bytes alive.
 *
 * `only` limits the decode to one sheet by name: a large workbook is read a sheet at a time,
 * and decoding the pictures of sheets nobody is looking at would undo that.
 */
export async function readSheetImages(raw: ArrayBuffer, only?: string): Promise<SheetImages> {
  const zip = await JSZip.loadAsync(raw);
  const workbook = zip.file("xl/workbook.xml");
  if (!workbook) return {};
  const workbookDoc = parseXml(await workbook.async("string"));
  if (!workbookDoc) return {};
  const workbookRels = await readRels(zip, "xl/workbook.xml");
  // One cache and one URL list for the whole workbook: a media part can serve several sheets,
  // and every sheet's set shares the list so releasing any of them revokes what it decoded.
  const cache = new Map<string, CellPicture | null>();
  const urls: string[] = [];
  const wps = await wpsCellPictures(zip);
  const [vmRich, richMedia] = await Promise.all([richValueIndexes(zip), richValueMedia(zip)]);
  const out: SheetImages = {};
  for (const sheet of elementsOf(workbookDoc, "sheet")) {
    const name = sheet.getAttribute("name");
    const id = relAttr(sheet, "id");
    const sheetPart = id ? workbookRels.get(id) : undefined;
    if (!name || !sheetPart) continue;
    if (only !== undefined && name !== only) continue;
    const cells = await cellPicturesOfSheet(
      zip,
      sheetPart,
      wps,
      vmRich,
      richMedia,
      cache,
      urls
    );
    const { images, skipped } = await imagesOfSheet(zip, sheetPart, urls);
    const count = Object.keys(cells.cells).length;
    if (images.length > 0 || count > 0 || cells.skipped + skipped > 0) {
      out[name] = {
        images,
        cells: cells.cells,
        urls,
        skipped: cells.skipped + skipped,
      };
    }
  }
  // Nothing kept a reference to what the workbook-wide cache decoded (a `cellimages.xml` no
  // cell uses, say), so the URLs would otherwise outlive the reader.
  if (Object.keys(out).length === 0) {
    for (const url of urls) URL.revokeObjectURL(url);
  }
  return out;
}

/** Let go of every object URL a read produced. */
export function releaseSheetImages(sheets: SheetImages | null) {
  if (!sheets) return;
  const revoked = new Set<string>();
  const revoke = (url: string) => {
    if (revoked.has(url)) return;
    revoked.add(url);
    URL.revokeObjectURL(url);
  };
  for (const set of Object.values(sheets)) {
    for (const url of set.urls) revoke(url);
    for (const image of set.images) revoke(image.url);
    for (const picture of Object.values(set.cells)) revoke(picture.url);
  }
}
