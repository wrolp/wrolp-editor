import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import {
  api,
  errorMessage,
  pickFolder,
  revealItemInDir,
  type ImageEntry,
  type Settings,
} from "../lib/tauri";
import { t } from "../lib/i18n";
import { listGallery, loadImage, sourceArchive, type GallerySource } from "../lib/gallerySource";
import { extOf, isSvg } from "../lib/path";
import { pathKey } from "../lib/types";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import { IconCollapse, IconReload, IconSliders } from "./icons";
import ImagePreview from "./ImagePreview";

type GalleryMode = "stack" | "single" | "slideshow" | "grid";

/** A stored or hand-edited mode name, or `null` when it is not one the toolbar offers. */
function asMode(value: string | undefined): GalleryMode | null {
  return value === "stack" || value === "single" || value === "slideshow" || value === "grid"
    ? value
    : null;
}

/** Pixels per second the stacked view's automatic scroll moves, and the range the slider offers. */
const SCROLL_SPEED_MIN = 10;
const SCROLL_SPEED_MAX = 240;
const SCROLL_SPEED_DEFAULT = 40;
/** What one press of − or + adds or takes away, since the number can also be typed. */
const SCROLL_SPEED_STEP = 5;

const MODES: GalleryMode[] = ["stack", "single", "slideshow", "grid"];
const MODE_KEYS: Record<GalleryMode, string> = {
  stack: "gal.stack",
  single: "gal.single",
  slideshow: "gal.slideshow",
  grid: "gal.grid",
};
const INTERVALS = [2, 3, 5, 8, 10, 15, 30];
/** How long the controls stay after the pointer leaves them, before they slide away. */
const GALLERY_TOOLS_CLOSE_DELAY = 2500;
/** One arrow-key press in the stacked view. Native scroll uses about this much. */
const STACK_SCROLL_STEP = 64;

/**
 * Picture types WebView2 cannot draw, known before the image is tried.
 *
 * These are still pictures: the table says what this renderer refuses, not what the file is.
 * Marking them up front is the difference between "this format does not open here" and a
 * broken-image glyph with no explanation.
 */
const UNDRAWABLE_EXT = new Set(["heic", "tif", "tiff"]);

function isUndrawable(name: string): boolean {
  return UNDRAWABLE_EXT.has(extOf(name));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

interface Props {
  /** The folder, or the zip and folder inside it, the pictures come from. */
  source: GallerySource;
  startPath?: string;
  /** Whether to include subfolders on the first listing; an entry point that already found
   *  pictures only in subfolders opens with this on rather than showing an empty grid. */
  initialRecursive?: boolean;
  /**
   * The layout the toolbar left the last gallery in. A folder — and a folder opened from one
   * of its pictures — opens the way it was left, rather than snapping back to the stack or to
   * the single view every time.
   */
  initialMode?: string;
  interval: number;
  loop: boolean;
  /** What sits behind a transparent picture, passed to the single view's own toolbar. */
  backdrop: string;
  onSaveSettings: (patch: Partial<Settings>) => void | Promise<unknown>;
  /** A sentence that is not a failure (an export finished). Goes to the app's toast row. */
  onNotice?: (message: string) => void;
  /** Recognize a picture as soon as it is shown; off, Extract text starts it. */
  ocrAuto?: boolean;
}

/* ---------- lazy images ----------
   One pair of observers per scrolling view, not one per picture: a 2000-cell grid with 2000
   observers is slower than the decoding it is trying to save. A picture is mounted when it
   comes within a screen of the viewport and removed once it is two screens away, which gives
   Chromium the chance to release the decoded bitmap instead of merely hiding it. */

type LazyRegister = (
  el: Element,
  mount: () => void,
  unmount: () => void
) => () => void;

const LazyContext = createContext<LazyRegister | null>(null);

function LazyProvider({
  rootRef,
  children,
}: {
  rootRef: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}) {
  const callbacks = useRef(
    new Map<Element, { mount: () => void; unmount: () => void }>()
  );
  const observers = useRef<{
    near: IntersectionObserver | null;
    far: IntersectionObserver | null;
  }>({ near: null, far: null });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const near = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) callbacks.current.get(entry.target)?.mount();
        }
      },
      { root, rootMargin: "100% 0px" }
    );
    const far = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) callbacks.current.get(entry.target)?.unmount();
        }
      },
      { root, rootMargin: "200% 0px" }
    );
    observers.current = { near, far };
    for (const el of callbacks.current.keys()) {
      near.observe(el);
      far.observe(el);
    }
    return () => {
      near.disconnect();
      far.disconnect();
      observers.current = { near: null, far: null };
    };
  }, [rootRef]);

  const register = useCallback<LazyRegister>((el, mount, unmount) => {
    callbacks.current.set(el, { mount, unmount });
    observers.current.near?.observe(el);
    observers.current.far?.observe(el);
    return () => {
      callbacks.current.delete(el);
      observers.current.near?.unobserve(el);
      observers.current.far?.unobserve(el);
    };
  }, []);

  return <LazyContext.Provider value={register}>{children}</LazyContext.Provider>;
}

/**
 * One picture that only exists in the DOM near the viewport.
 *
 * `measured` is kept after the image is removed and used as the host's minimum height, so
 * unmounting a tall picture from the middle of a stacked list does not pull everything below
 * it upwards. Measuring is done on load, never on removal: by then the scroll position has
 * already moved.
 */
function GalleryImage({
  src,
  alt,
  onLoaded,
}: {
  src: string;
  alt: string;
  onLoaded?: (width: number, height: number) => void;
}) {
  const register = useContext(LazyContext);
  const hostRef = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [measured, setMeasured] = useState<number | null>(null);

  useEffect(() => {
    const el = hostRef.current;
    if (!el || !register) return;
    return register(
      el,
      () => setShown(true),
      () => {
        // The element is about to leave the DOM; when it comes back the browser will decode
        // it again, so the next paint should wait for that instead of showing a stale frame.
        setShown(false);
        setLoaded(false);
      }
    );
  }, [register]);

  return (
    <div
      ref={hostRef}
      className="gal-lazy"
      style={measured === null ? undefined : { minHeight: measured }}
    >
      {/* A mounted picture that has not decoded yet keeps its space and shows a shimmer;
          an unmounted one keeps the measured space with a flat placeholder. */}
      {!failed && !(shown && loaded) && (
        <span
          className={shown ? "gal-loading" : "gal-placeholder"}
          aria-hidden="true"
        />
      )}
      {shown && !failed && (
        <img
          className={loaded ? "loaded" : undefined}
          src={src}
          alt={alt}
          loading="eager"
          decoding="async"
          onLoad={(e) => {
            const img = e.currentTarget;
            setLoaded(true);
            setMeasured(img.offsetHeight);
            onLoaded?.(img.naturalWidth, img.naturalHeight);
          }}
          onError={() => setFailed(true)}
        />
      )}
      {failed && (
        <span className="gal-broken" title={t("img.failed")}>
          !
        </span>
      )}
    </div>
  );
}

/**
 * A placeholder for a picture this renderer cannot draw.
 *
 * A folder's picture offers the system handlers; an archive's does not, because its entry has
 * no path to hand over — the one thing that makes sense there is taking a copy out.
 */
function Undrawable({
  item,
  onExport,
}: {
  item: ImageEntry;
  onExport?: (item: ImageEntry) => void;
}) {
  return (
    <div className="gal-undrawable">
      <div>{t("gal.unsupported")}</div>
      <div className="gal-undrawable-actions">
        {onExport ? (
          <button
            className="btn small"
            onClick={(e) => {
              e.stopPropagation();
              onExport(item);
            }}
          >
            {t("gal.exportImage")}
          </button>
        ) : (
          <>
            <button
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                void api.openInSystem(item.path).catch(() => {});
              }}
            >
              {t("side.menuOpenSystem")}
            </button>
            <button
              className="btn small"
              onClick={(e) => {
                e.stopPropagation();
                void revealItemInDir(item.path).catch(() => {});
              }}
            >
              {t("img.openSystem")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The URL for one card. Both kinds of source answer immediately: a folder's picture through the
 * asset protocol, an archive's through `wrolp-archive`, which the WebView fetches lazily.
 *
 * `thumb` asks an archive for a shrunken copy. The grid and the filmstrip do, because decoding
 * a dozen full-size photographs to fill one screen is what made the first paint slow; the
 * single view asks for the picture itself.
 */
function itemUrl(
  archive: string | null,
  item: ImageEntry | undefined,
  thumb?: number
): string | null {
  const path = item?.path ?? "";
  if (path === "") return null;
  return loadImage(archive, item as ImageEntry, thumb);
}

/** The thumbnail edge the grid asks for: a cell at 2× scaling, and no more. */
const GRID_THUMB = 320;
/** The filmstrip is a row of small cards, so its copies are smaller still. */
const STRIP_THUMB = 160;

/** The folder an entry sits in, relative to the gallery's own root (`""` at the root). */
function folderOf(entry: string, inner: string): string {
  const prefix = inner === "" ? "" : `${inner}/`;
  const rel = entry.startsWith(prefix) ? entry.slice(prefix.length) : entry;
  const cut = rel.lastIndexOf("/");
  return cut < 0 ? "" : rel.slice(0, cut);
}

/* ---------- stacked view ---------- */

interface ViewHandle {
  scrollToIndex(index: number): void;
}

interface StackHandle extends ViewHandle {
  /** Move the stacked list by a pixel amount, for the arrow keys. */
  scrollBy(delta: number): void;
  /** Move by most of a viewport, the way PageUp/PageDown and Space do elsewhere. */
  page(direction: 1 | -1): void;
}

function StackItem({
  item,
  index,
  archive,
  onMenu,
  onExport,
  refCallback,
}: {
  item: ImageEntry;
  index: number;
  archive: string | null;
  onMenu: (event: ReactMouseEvent<HTMLElement>, index: number) => void;
  onExport?: (item: ImageEntry) => void;
  refCallback: (el: HTMLElement | null) => void;
}) {
  const src = itemUrl(archive, item);
  return (
    <figure
      className="gal-item"
      data-index={index}
      ref={refCallback}
      onContextMenu={(event) => onMenu(event, index)}
    >
      {/* The number and name follow the pointer instead of occupying a bar above every
          picture: stacked reads as a run of pages, not a list of titled cards. The counter in
          the toolbar names the page that is on screen while nothing is hovered. */}
      <figcaption className="gal-item-tag">
        <span className="gal-item-index">{index + 1}</span>
        <span className="gal-item-name">{item.name}</span>
      </figcaption>
      {isUndrawable(item.name) ? (
        <Undrawable item={item} onExport={onExport} />
      ) : src ? (
        <GalleryImage src={src} alt={item.name} />
      ) : (
        <div className="gal-lazy">
          <span className="gal-placeholder" aria-hidden="true" />
        </div>
      )}
    </figure>
  );
}

function StackView({
  items,
  archive,
  autoScroll,
  speed,
  onIndexChange,
  onOpen,
  onToggleAutoScroll,
  onAutoScrollEnd,
  onHandScroll,
  onExport,
  ref,
}: {
  items: ImageEntry[];
  archive: string | null;
  autoScroll: boolean;
  speed: number;
  onIndexChange: (index: number) => void;
  onOpen: (index: number) => void;
  onToggleAutoScroll: () => void;
  onAutoScrollEnd: () => void;
  onHandScroll: () => void;
  onExport?: (item: ImageEntry) => void;
  ref: Ref<StackHandle>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemEls = useRef(new Map<number, HTMLElement>());
  /** The page menu: where it opened, and which page it is about. */
  const [menu, setMenu] = useState<{ x: number; y: number; index: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAt = useMenuPlacement(menu, menuRef);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
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
  }, [menu]);

  /**
   * The automatic scroll. Each frame moves the column by `speed` pixels per second of elapsed
   * time, so a slow machine does not slow the reading down, and it stops at the last page
   * instead of letting the reader watch a column that cannot move any further.
   */
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const elapsed = (now - last) / 1000;
      last = now;
      const max = el.scrollHeight - el.clientHeight;
      if (el.scrollTop >= max - 1) {
        onAutoScrollEnd();
        return;
      }
      el.scrollTop = Math.min(max, el.scrollTop + speed * elapsed);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [autoScroll, speed, onAutoScrollEnd]);

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(i: number) {
        itemEls.current.get(i)?.scrollIntoView({ block: "start" });
      },
      scrollBy(delta: number) {
        scrollRef.current?.scrollBy({ top: delta });
      },
      page(direction: 1 | -1) {
        const el = scrollRef.current;
        if (el) el.scrollBy({ top: direction * el.clientHeight * 0.9 });
      },
    }),
    []
  );

  // The picture at the top of the viewport is the one the counter names and the one the
  // arrows step from. "Most visible" was tried first and made a short picture at the top
  // lose to a tall neighbour below it, so one ArrowDown could move the counter by three.
  // Topmost is also what reading a vertical feed means: the next picture is the next one
  // under the one you started from.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || items.length === 0) return;
    const visible = new Set<number>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const at = Number((entry.target as HTMLElement).dataset.index);
          if (entry.isIntersecting) visible.add(at);
          else visible.delete(at);
        }
        let topmost = -1;
        for (const at of visible) {
          if (topmost < 0 || at < topmost) topmost = at;
        }
        if (topmost >= 0) onIndexChange(topmost);
      },
      { root }
    );
    for (const el of itemEls.current.values()) observer.observe(el);
    return () => observer.disconnect();
  }, [items, onIndexChange]);

  return (
    <>
      <LazyProvider rootRef={scrollRef}>
        <div
          className="gal-stack"
          ref={scrollRef}
          // A wheel or a double click means the reader has taken over: the automatic scroll
          // steps aside rather than fighting the hand that is already moving the column.
          onWheel={onHandScroll}
          onDoubleClick={onHandScroll}
        >
          {items.map((item, i) => (
            <StackItem
              key={item.path}
              item={item}
              index={i}
              archive={archive}
              onMenu={(event, at) => {
                // A click is reading, not opening; going to one-by-one is a menu row.
                event.preventDefault();
                setMenu({ x: event.clientX, y: event.clientY, index: at });
              }}
              onExport={onExport}
              refCallback={(el) => {
                if (el) itemEls.current.set(i, el);
                else itemEls.current.delete(i);
              }}
            />
          ))}
        </div>
      </LazyProvider>
      {menu && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ display: "block", left: menuAt.left, top: menuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div
            className="ctx-item"
            onClick={() => {
              const at = menu.index;
              setMenu(null);
              onOpen(at);
            }}
          >
            {t("gal.openSingle")}
          </div>
          <div className="ws-sep" />
          <div
            className="ctx-item"
            onClick={() => {
              setMenu(null);
              onToggleAutoScroll();
            }}
          >
            {t("gal.autoScroll")}
            <span className="ctx-check">{autoScroll ? "✓" : ""}</span>
          </div>
        </div>
      )}
    </>
  );
}

/* ---------- grid view ---------- */

function GridCell({
  item,
  index,
  active,
  archive,
  onOpen,
  refCallback,
}: {
  item: ImageEntry;
  index: number;
  active: boolean;
  archive: string | null;
  onOpen: (index: number) => void;
  refCallback: (el: HTMLElement | null) => void;
}) {
  const src = itemUrl(archive, item, GRID_THUMB);
  return (
    <button
      type="button"
      className={`gal-cell${active ? " active" : ""}`}
      title={item.name}
      ref={refCallback}
      onClick={() => onOpen(index)}
    >
      {isUndrawable(item.name) ? (
        <span className="gal-cell-unsupported">{t("gal.unsupportedShort")}</span>
      ) : src ? (
        <GalleryImage src={src} alt={item.name} />
      ) : (
        <span className="gal-placeholder" aria-hidden="true" />
      )}
    </button>
  );
}

function GridView({
  items,
  index,
  large,
  archive,
  inner,
  onOpen,
  ref,
}: {
  items: ImageEntry[];
  index: number;
  large: boolean;
  archive: string | null;
  /** The folder inside the archive the listing started from, for the section headings. */
  inner: string;
  onOpen: (index: number) => void;
  ref: Ref<ViewHandle>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const cellEls = useRef(new Map<number, HTMLElement>());

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex(i: number) {
        cellEls.current.get(i)?.scrollIntoView({ block: "nearest" });
      },
    }),
    []
  );

  // The listing already orders by (folder, name), so one pass turns it into sections. A single
  // folder keeps the flat grid it always had: a heading over every cell would only add noise.
  const groups = useMemo(() => {
    const out: { folder: string; items: { item: ImageEntry; index: number }[] }[] = [];
    items.forEach((item, at) => {
      const folder = folderOf(item.path, inner);
      const last = out[out.length - 1];
      if (last !== undefined && last.folder === folder) last.items.push({ item, index: at });
      else out.push({ folder, items: [{ item, index: at }] });
    });
    return out;
  }, [items, inner]);
  const sectioned = groups.length > 1;

  return (
    <LazyProvider rootRef={scrollRef}>
      <div className={`gal-grid${large ? " large" : ""}`} ref={scrollRef}>
        {groups.map((group) => (
          <Fragment key={group.folder || "\u0000root"}>
            {sectioned && group.folder !== "" && (
              <div className="gal-group-head">{group.folder}</div>
            )}
            {group.items.map(({ item, index: at }) => (
              <GridCell
                key={item.path}
                item={item}
                index={at}
                active={at === index}
                archive={archive}
                onOpen={onOpen}
                refCallback={(el) => {
                  if (el) cellEls.current.set(at, el);
                  else cellEls.current.delete(at);
                }}
              />
            ))}
          </Fragment>
        ))}
      </div>
    </LazyProvider>
  );
}

/* ---------- filmstrip ---------- */

function Thumb({
  item,
  index,
  active,
  archive,
  onPick,
  refCallback,
}: {
  item: ImageEntry;
  index: number;
  active: boolean;
  archive: string | null;
  onPick: (index: number) => void;
  refCallback: (el: HTMLElement | null) => void;
}) {
  const src = itemUrl(archive, item, STRIP_THUMB);
  return (
    <button
      type="button"
      className={`gal-thumb${active ? " active" : ""}`}
      title={item.name}
      ref={refCallback}
      onClick={() => onPick(index)}
    >
      {isUndrawable(item.name) ? (
        <span className="gal-thumb-unsupported">{extOf(item.name)}</span>
      ) : src ? (
        <GalleryImage src={src} alt={item.name} />
      ) : (
        <span className="gal-placeholder" aria-hidden="true" />
      )}
    </button>
  );
}

function Filmstrip({
  items,
  index,
  archive,
  onPick,
}: {
  items: ImageEntry[];
  index: number;
  archive: string | null;
  onPick: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const thumbEls = useRef(new Map<number, HTMLElement>());

  useEffect(() => {
    thumbEls.current
      .get(index)
      ?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [index]);

  return (
    <LazyProvider rootRef={scrollRef}>
      <div className="gal-strip" ref={scrollRef}>
        {items.map((item, i) => (
          <Thumb
            key={item.path}
            item={item}
            index={i}
            active={i === index}
            archive={archive}
            onPick={onPick}
            refCallback={(el) => {
              if (el) thumbEls.current.set(i, el);
              else thumbEls.current.delete(i);
            }}
          />
        ))}
      </div>
    </LazyProvider>
  );
}

/** One neighbour, warmed. For an archive this also fills the URL cache the card will read. */
function PreloadedImage({
  item,
  archive,
}: {
  item: ImageEntry;
  archive: string | null;
}) {
  const src = itemUrl(archive, item);
  return src ? <img src={src} alt="" /> : null;
}

/**
 * Where inside the archive the pictures on screen live, one crumb per folder.
 *
 * The archive's own name is the root: an entry's folder is the only thing a breadcrumb can
 * usefully move, because the archive itself is the tab. Clicking a crumb re-lists from that
 * folder instead of opening another tab, so the tab keeps pointing at where it was opened.
 */
function Crumbs({
  archive,
  inner,
  onNavigate,
}: {
  archive: string;
  inner: string;
  onNavigate: (inner: string) => void;
}) {
  const name = archive.split(/[\\/]/).pop() || archive;
  const parts = inner.split("/").filter((part) => part !== "");
  return (
    <nav className="gal-crumbs" aria-label={t("gal.location")}>
      <button
        type="button"
        className={`gal-crumb${parts.length === 0 ? " current" : ""}`}
        onClick={() => onNavigate("")}
      >
        {name}
      </button>
      {parts.map((part, at) => {
        const target = parts.slice(0, at + 1).join("/");
        return (
          <Fragment key={target}>
            <span className="gal-crumb-sep">/</span>
            <button
              type="button"
              className={`gal-crumb${at === parts.length - 1 ? " current" : ""}`}
              onClick={() => onNavigate(target)}
            >
              {part}
            </button>
          </Fragment>
        );
      })}
    </nav>
  );
}

/* ---------- gallery ---------- */

export default function ImageGallery({
  source,
  startPath,
  initialRecursive,
  initialMode,
  interval,
  loop,
  backdrop,
  onSaveSettings,
  onNotice,
  ocrAuto = false,
}: Props) {
  /** The zip the pictures come from; null when they are a folder's. */
  const archive = sourceArchive(source);
  /**
   * The folder inside the archive on screen. The tab names where the gallery was opened; the
   * breadcrumb moves within the archive from there, and going back to another tab starts over.
   */
  const [inner, setInner] = useState(source.kind === "archive" ? source.inner : "");
  useEffect(() => {
    setInner(source.kind === "archive" ? source.inner : "");
  }, [source]);
  const effectiveSource = useMemo<GallerySource>(
    () =>
      source.kind === "archive"
        ? { kind: "archive", archive: source.archive, inner }
        : source,
    [source, inner]
  );
  const openingMode: GalleryMode =
    asMode(initialMode) ?? (startPath ? "single" : "stack");
  const [mode, setMode] = useState<GalleryMode>(openingMode);
  const [items, setItems] = useState<ImageEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [recursive, setRecursive] = useState(initialRecursive ?? false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scanned, setScanned] = useState(0);
  // A remembered slideshow starts playing, because that is the mode that was left.
  const [playing, setPlaying] = useState(openingMode === "slideshow");
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden
  );
  const [largeCells, setLargeCells] = useState(false);
  /** The stacked view's automatic scroll, and the pace it moves at. */
  const [autoScroll, setAutoScroll] = useState(false);
  const [scrollSpeed, setScrollSpeed] = useState(SCROLL_SPEED_DEFAULT);
  /** The speed while it is being typed; committed on Enter or on leaving the box. */
  const [speedDraft, setSpeedDraft] = useState(String(SCROLL_SPEED_DEFAULT));
  /** The controls take no room unless they are in use; the tab in the corner brings them back. */
  const [toolsOpen, setToolsOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<StackHandle>(null);
  const gridRef = useRef<ViewHandle>(null);

  /**
   * The controls leave a few seconds after the pointer does, rather than the instant it does:
   * a hand that has gone to the pictures is often on its way straight back.
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
    }, GALLERY_TOOLS_CLOSE_DELAY);
  }, [stayOpen]);
  const closeNow = useCallback(() => {
    stayOpen();
    setToolsOpen(false);
  }, [stayOpen]);
  useEffect(() => () => stayOpen(), [stayOpen]);
  /**
   * The picture on screen, kept in a ref so a refresh can return to it without making the
   * listing effect depend on the index. A deleted or renamed picture is simply gone and the
   * list starts over.
   */
  const currentPathRef = useRef<string | undefined>(startPath);
  if (items[index]) currentPathRef.current = items[index].path;

  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  // One listing per folder: changing the view must not reshuffle the sequence or re-read the
  // disk, because the index the user is on only means something against that sequence.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    listGallery(effectiveSource, recursive)
      .then((list) => {
        if (!live) return;
        setItems(list.items);
        setTruncated(list.truncated);
        setScanned(list.scanned);
        const wanted = startPath ?? currentPathRef.current;
        const at =
          wanted === undefined
            ? -1
            : list.items.findIndex(
                (item) => pathKey(item.path) === pathKey(wanted)
              );
        setIndex(at >= 0 ? at : 0);
      })
      .catch((e) => {
        if (!live) return;
        // Keep what is already on screen: a folder that became unreadable should be labelled,
        // not erased. An initial failure has nothing to keep and falls through to the status
        // pane below.
        setError(errorMessage(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [effectiveSource, recursive, refreshKey, startPath]);

  // The Explorer knows when a folder changed (a rename, a delete, a paste). It announces the
  // folder, and a gallery showing that folder — or, when recursive, one of its ancestors —
  // re-reads its list. An archive has no live folder to watch.
  useEffect(() => {
    if (source.kind !== "dir") return;
    const onChange = (e: Event) => {
      const changed = (e as CustomEvent<string>).detail;
      if (typeof changed !== "string") return;
      const key = pathKey(changed);
      const root = pathKey(source.dir);
      if (key === root || (recursive && key.startsWith(`${root}/`))) {
        setRefreshKey((k) => k + 1);
      }
    };
    window.addEventListener("wrolp:folder-changed", onChange);
    return () => window.removeEventListener("wrolp:folder-changed", onChange);
  }, [source, recursive]);

  useEffect(() => {
    const onBlur = () => setFocused(false);
    const onFocus = () => setFocused(true);
    const onVisibility = () => setDocumentVisible(!document.hidden);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const last = items.length - 1;

  const jumpTo = useCallback(
    (target: number) => {
      if (items.length === 0) return;
      const next = Math.max(0, Math.min(items.length - 1, target));
      setIndex(next);
      if (mode === "stack") stackRef.current?.scrollToIndex(next);
      if (mode === "grid") gridRef.current?.scrollToIndex(next);
    },
    [items.length, mode]
  );

  const step = useCallback(
    (delta: number) => {
      if (items.length === 0) return;
      let target = index + delta;
      // A looping slideshow wraps both when the timer advances and when an arrow asks for the
      // picture after the last one. One-by-one and stacked stop at the ends.
      if (mode === "slideshow" && loop) {
        if (target > last) target = 0;
        else if (target < 0) target = last;
      }
      jumpTo(target);
    },
    [items.length, index, mode, loop, last, jumpTo]
  );

  // Mode changes carry the index across: opening a picture from the stack must land on that
  // picture in the single view, and going back must return the stack to it. A toolbar choice
  // is also written to settings, so the next gallery opens the way this one was left; a
  // double-click into the single view is navigation and deliberately does not.
  const changeMode = useCallback(
    (next: GalleryMode) => {
      setMode(next);
      if (next === "slideshow") setPlaying(true);
      void onSaveSettings({ galleryMode: next });
    },
    [onSaveSettings]
  );

  useEffect(() => {
    const target = index;
    if (mode === "stack") {
      requestAnimationFrame(() => stackRef.current?.scrollToIndex(target));
    } else if (mode === "grid") {
      requestAnimationFrame(() => gridRef.current?.scrollToIndex(target));
    }
    // Only when the view changes; scrolling in the stack already moves the index and must not
    // be answered by scrolling to it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  // The slideshow is a pure index pump: it never writes anything, and every condition that
  // could pull attention away from the window stops it where it is.
  useEffect(() => {
    if (
      mode !== "slideshow" ||
      !playing ||
      hover ||
      !focused ||
      !documentVisible ||
      items.length < 2
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      setIndex((current) => {
        const next = current + 1;
        if (next <= last) return next;
        return loop ? 0 : current;
      });
    }, Math.max(1, interval) * 1000);
    return () => window.clearTimeout(timer);
  }, [
    mode,
    playing,
    hover,
    focused,
    documentVisible,
    index,
    last,
    interval,
    loop,
    items.length,
  ]);

  // Without looping, the last picture is the end of the show rather than a picture that is
  // shown forever while the play button still says it is running.
  useEffect(() => {
    if (mode === "slideshow" && playing && !loop && index >= last && last > 0) {
      setPlaying(false);
    }
  }, [mode, playing, loop, index, last]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (items.length === 0) return;
      switch (e.key) {
        // Up/Down move the scrollbar, not the selection: the stacked view is a reading
        // column, and a key press should reveal the next strip of it rather than jump a
        // whole picture. Left/Right are the picture-by-picture keys.
        case "ArrowDown":
          if (mode === "stack") {
            e.preventDefault();
            stackRef.current?.scrollBy(STACK_SCROLL_STEP);
          }
          break;
        case "ArrowUp":
          if (mode === "stack") {
            e.preventDefault();
            stackRef.current?.scrollBy(-STACK_SCROLL_STEP);
          }
          break;
        case "PageDown":
          if (mode === "stack") {
            e.preventDefault();
            stackRef.current?.page(1);
          }
          break;
        case "PageUp":
          if (mode === "stack") {
            e.preventDefault();
            stackRef.current?.page(-1);
          }
          break;
        case "ArrowLeft":
          if (mode !== "grid") {
            e.preventDefault();
            step(-1);
          }
          break;
        case "ArrowRight":
          if (mode !== "grid") {
            e.preventDefault();
            step(1);
          }
          break;
        case "Home":
          if (mode !== "grid") {
            e.preventDefault();
            jumpTo(0);
          }
          break;
        case "End":
          if (mode !== "grid") {
            e.preventDefault();
            jumpTo(last);
          }
          break;
        case " ":
          if (mode === "slideshow") {
            e.preventDefault();
            setPlaying((p) => !p);
          } else if (mode === "stack") {
            e.preventDefault();
            stackRef.current?.page(1);
          }
          break;
        case "Escape":
          // The stack is a reading column now, so leaving it is a menu row rather than a key
          // that can fire while a menu is open. A slideshow still stops on Escape.
          if (mode === "slideshow") setMode("single");
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items.length, mode, last, jumpTo, step]);

  const openAt = useCallback((i: number) => {
    setIndex(i);
    setMode("single");
  }, []);

  // Automatic scrolling belongs to the stacked column; leaving it ends the run rather than
  // resuming it behind another mode.
  useEffect(() => {
    if (mode !== "stack") setAutoScroll(false);
  }, [mode]);
  const stopAutoScroll = useCallback(() => setAutoScroll(false), []);
  const toggleAutoScroll = useCallback(() => setAutoScroll((on) => !on), []);

  /** The typed speed, held inside the range: an empty or wild draft keeps the last good one. */
  const typedSpeed = () => {
    const parsed = Number(speedDraft);
    return speedDraft.trim() !== "" && Number.isFinite(parsed)
      ? Math.min(SCROLL_SPEED_MAX, Math.max(SCROLL_SPEED_MIN, Math.round(parsed)))
      : scrollSpeed;
  };
  const commitSpeed = () => {
    const next = typedSpeed();
    setScrollSpeed(next);
    setSpeedDraft(String(next));
  };
  const nudgeSpeed = (delta: number) => {
    const next = Math.min(
      SCROLL_SPEED_MAX,
      Math.max(SCROLL_SPEED_MIN, typedSpeed() + delta)
    );
    setScrollSpeed(next);
    setSpeedDraft(String(next));
  };

  /**
   * Take a picture out of the archive, into a folder the user picks. The copy is an ordinary
   * file from then on; the archive itself is not touched.
   */
  const exportPicture = useCallback(
    async (item: ImageEntry) => {
      const zip = sourceArchive(source);
      if (zip === null) return;
      const dir = await pickFolder().catch((e) => {
        onNotice?.(errorMessage(e));
        return null;
      });
      if (!dir) return;
      try {
        const out = await api.archiveExportImage(zip, item.path, dir);
        onNotice?.(t("side.exported", { name: out.name }));
      } catch (e) {
        onNotice?.(errorMessage(e));
      }
    },
    [source, onNotice]
  );

  // Neighbours are warmed so the next frame of a slideshow is not a blank pane, and so an
  // arrow jump in the stacked view lands on a picture already on its way. Five pictures,
  // not the whole folder — and only for the views that show one picture at a time, because
  // the grid and the stack fetch their own thumbnails as they scroll.
  const preload =
    mode === "single" || mode === "slideshow"
      ? items.filter(
          (item, i) =>
            Math.abs(i - index) <= 2 && i !== index && !isUndrawable(item.name)
        )
      : [];

  const current = items[index];
  const currentSrc = itemUrl(archive, current);
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const sizeText = formatBytes(totalBytes);

  return (
    <div
      className="image-gallery"
      ref={rootRef}
      tabIndex={-1}
      onPointerDown={(event) => {
        // Reaching for a picture puts the controls away, so the pictures get the whole pane —
        // unless the click is on the row itself, which is the row being used.
        if (!(event.target as Element).closest(".gal-toolbar, .gal-tools-toggle")) closeNow();
      }}
    >
      {/* The only thing on the pictures when the controls are away: a tab in the corner that
          brings them back. It keeps to the left, clear of the picture's own tab in the single
          view below it. */}
      <button
        type="button"
        className="gal-tools-toggle"
        title={toolsOpen ? t("tools.hide") : t("tools.show")}
        aria-label={toolsOpen ? t("tools.hide") : t("tools.show")}
        aria-expanded={toolsOpen}
        onPointerEnter={stayOpen}
        onClick={() => setToolsOpen((open) => !open)}
      >
        {toolsOpen ? <IconCollapse edge="top" /> : <IconSliders />}
      </button>
      <div
        className={`gal-toolbar${toolsOpen ? " open" : ""}`}
        onPointerEnter={stayOpen}
        onPointerLeave={(event) => {
          // A control dragged past the row is still the row being used, so a button held down
          // keeps it open until the pointer is lifted.
          if (event.buttons === 0) closeSoon();
        }}
      >
        <div className="gal-modes" role="group" aria-label={t("gal.modes")}>
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              className={`gal-mode${mode === m ? " active" : ""}`}
              aria-pressed={mode === m}
              title={t(MODE_KEYS[m])}
              onClick={() => changeMode(m)}
            >
              {t(MODE_KEYS[m])}
            </button>
          ))}
        </div>

        {mode !== "grid" && (
          <div className="gal-nav">
            <button
              className="gal-tool"
              type="button"
              title={t("gal.prev")}
              disabled={!(mode === "slideshow" && loop) && index <= 0}
              onClick={() => step(-1)}
            >
              ‹
            </button>
            <span className="gal-position">
              {items.length === 0 ? "0 / 0" : `${index + 1} / ${items.length}`}
            </span>
            <button
              className="gal-tool"
              type="button"
              title={t("gal.next")}
              disabled={!(mode === "slideshow" && loop) && index >= last}
              onClick={() => step(1)}
            >
              ›
            </button>
          </div>
        )}

        {mode === "stack" && (
          <div className="gal-slideshow-tools">
            <button
              className={`gal-tool${autoScroll ? " active" : ""}`}
              type="button"
              title={t("gal.autoScroll")}
              aria-pressed={autoScroll}
              onClick={() => setAutoScroll((on) => !on)}
            >
              {autoScroll ? "❚❚" : "▶"}
            </button>
            {/* A number to type and buttons for a nudge of one step, rather than a slider
                alone: the pace of a long read is worth setting exactly. */}
            <span className="gal-speed">
              {t("gal.scrollSpeed")}
              <button
                className="gal-tool"
                type="button"
                title={t("gal.slower")}
                disabled={typedSpeed() <= SCROLL_SPEED_MIN}
                onClick={() => nudgeSpeed(-SCROLL_SPEED_STEP)}
              >
                −
              </button>
              <input
                className="gal-speed-input"
                type="number"
                inputMode="numeric"
                min={SCROLL_SPEED_MIN}
                max={SCROLL_SPEED_MAX}
                value={speedDraft}
                aria-label={t("gal.scrollSpeed")}
                onChange={(e) => setSpeedDraft(e.target.value)}
                onBlur={commitSpeed}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitSpeed();
                    e.currentTarget.blur();
                  }
                }}
              />
              <span className="gal-speed-unit">px/s</span>
              <button
                className="gal-tool"
                type="button"
                title={t("gal.faster")}
                disabled={typedSpeed() >= SCROLL_SPEED_MAX}
                onClick={() => nudgeSpeed(SCROLL_SPEED_STEP)}
              >
                +
              </button>
            </span>
          </div>
        )}

        {mode === "slideshow" && (
          <div className="gal-slideshow-tools">
            <button
              className="gal-tool"
              type="button"
              title={playing ? t("gal.pause") : t("gal.play")}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? t("gal.pause") : t("gal.play")}
            </button>
            <label className="gal-check">
              <input
                type="checkbox"
                checked={loop}
                onChange={(e) =>
                  void onSaveSettings({ galleryLoop: e.target.checked })
                }
              />
              {t("gal.loop")}
            </label>
            <label className="gal-check">
              {t("gal.interval")}
              <select
                className="select gal-select"
                value={interval}
                onChange={(e) =>
                  void onSaveSettings({
                    galleryInterval: Number(e.target.value),
                  })
                }
              >
                {INTERVALS.map((sec) => (
                  <option key={sec} value={sec}>
                    {t("gal.seconds", { n: sec })}
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}

        {mode === "grid" && (
          <div className="gal-nav">
            <button
              className={`gal-tool${largeCells ? "" : " active"}`}
              type="button"
              onClick={() => setLargeCells(false)}
            >
              {t("gal.sizeSmall")}
            </button>
            <button
              className={`gal-tool${largeCells ? " active" : ""}`}
              type="button"
              onClick={() => setLargeCells(true)}
            >
              {t("gal.sizeLarge")}
            </button>
          </div>
        )}

        <span className="gal-meta">
          {t("gal.count", { n: items.length, size: sizeText })}
          {truncated && (
            <span className="gal-warn">
              {" "}
              {t("gal.truncated", { n: items.length, scanned })}
            </span>
          )}
        </span>

        <label className="gal-check">
          <input
            type="checkbox"
            checked={recursive}
            onChange={(e) => setRecursive(e.target.checked)}
          />
          {t("gal.recursive")}
        </label>

        <button
          className="gal-tool gal-refresh"
          type="button"
          title={t("gal.refresh")}
          onClick={() => setRefreshKey((k) => k + 1)}
        >
          <IconReload size={13} />
        </button>
      </div>

      {error && items.length > 0 && (
        <div className="gal-banner">
          <span>{error}</span>
          <button
            className="btn small"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            {t("gal.retry")}
          </button>
        </div>
      )}

      {source.kind === "archive" && (
        <Crumbs archive={source.archive} inner={inner} onNavigate={setInner} />
      )}

      {loading && items.length === 0 ? (
        <div className="gal-status">{t("gal.loading")}</div>
      ) : error && items.length === 0 ? (
        <div className="gal-status">
          <div>{error}</div>
          <button
            className="btn small"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            {t("gal.retry")}
          </button>
        </div>
      ) : items.length === 0 ? (
        <div className="gal-empty">{t("gal.empty")}</div>
      ) : mode === "stack" ? (
        <StackView
          ref={stackRef}
          items={items}
          archive={archive}
          autoScroll={autoScroll}
          speed={scrollSpeed}
          onIndexChange={setIndex}
          onOpen={openAt}
          onToggleAutoScroll={toggleAutoScroll}
          onAutoScrollEnd={stopAutoScroll}
          onHandScroll={stopAutoScroll}
          onExport={archive === null ? undefined : exportPicture}
        />
      ) : mode === "grid" ? (
        <GridView
          ref={gridRef}
          items={items}
          index={index}
          large={largeCells}
          archive={archive}
          inner={source.kind === "archive" ? inner : ""}
          onOpen={openAt}
        />
      ) : (
        <div
          className="gal-single"
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          <div className="gal-single-stage">
            {current && isUndrawable(current.name) ? (
              <Undrawable
                item={current}
                onExport={archive === null ? undefined : exportPicture}
              />
            ) : current ? (
              <ImagePreview
                path={current.path}
                src={currentSrc}
                external={archive !== null}
                text={null}
                backdrop={backdrop}
                onSaveBackdrop={(value) => onSaveSettings({ imageBackdrop: value })}
                ocrSource={
                  isSvg(current.path)
                    ? null
                    : archive !== null
                      ? { kind: "archive", archive, entry: current.path }
                      : { kind: "path", path: current.path }
                }
                ocrAuto={ocrAuto}
                onNotice={onNotice}
              />
            ) : null}
          </div>
          <Filmstrip
            items={items}
            index={index}
            archive={archive}
            onPick={jumpTo}
          />
        </div>
      )}

      <div className="gal-preload" aria-hidden="true">
        {preload.map((item) => (
          <PreloadedImage key={item.path} item={item} archive={archive} />
        ))}
      </div>
    </div>
  );
}
