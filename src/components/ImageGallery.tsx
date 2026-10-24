import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import {
  api,
  errorMessage,
  revealItemInDir,
  type ImageEntry,
  type Settings,
} from "../lib/tauri";
import { t } from "../lib/i18n";
import { extOf } from "../lib/path";
import { pathKey } from "../lib/types";
import { IconReload } from "./icons";
import ImagePreview from "./ImagePreview";

type GalleryMode = "stack" | "single" | "slideshow" | "grid";

const MODES: GalleryMode[] = ["stack", "single", "slideshow", "grid"];
const MODE_KEYS: Record<GalleryMode, string> = {
  stack: "gal.stack",
  single: "gal.single",
  slideshow: "gal.slideshow",
  grid: "gal.grid",
};
const INTERVALS = [2, 3, 5, 8, 10, 15, 30];
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
  dir: string;
  startPath?: string;
  interval: number;
  loop: boolean;
  onSaveSettings: (patch: Partial<Settings>) => void | Promise<unknown>;
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

function Undrawable({ path }: { path: string }) {
  return (
    <div className="gal-undrawable">
      <div>{t("gal.unsupported")}</div>
      <button
        className="btn small"
        onClick={(e) => {
          e.stopPropagation();
          void revealItemInDir(path).catch(() => {});
        }}
      >
        {t("img.openSystem")}
      </button>
    </div>
  );
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
  active,
  onOpen,
  refCallback,
}: {
  item: ImageEntry;
  index: number;
  active: boolean;
  onOpen: (index: number) => void;
  refCallback: (el: HTMLElement | null) => void;
}) {
  const [dims, setDims] = useState<{ width: number; height: number } | null>(
    null
  );
  return (
    <figure
      className={`gal-item${active ? " active" : ""}`}
      data-index={index}
      ref={refCallback}
      onClick={() => onOpen(index)}
    >
      <figcaption>
        <span className="gal-item-index">{index + 1}</span>
        <span className="gal-item-name" title={item.name}>
          {item.name}
        </span>
        <span className="gal-item-size">
          {dims ? `${dims.width} × ${dims.height} · ` : ""}
          {formatBytes(item.bytes)}
        </span>
      </figcaption>
      {isUndrawable(item.name) ? (
        <Undrawable path={item.path} />
      ) : (
        <GalleryImage
          src={convertFileSrc(item.path)}
          alt={item.name}
          onLoaded={(width, height) => setDims({ width, height })}
        />
      )}
    </figure>
  );
}

function StackView({
  items,
  index,
  onIndexChange,
  onOpen,
  ref,
}: {
  items: ImageEntry[];
  index: number;
  onIndexChange: (index: number) => void;
  onOpen: (index: number) => void;
  ref: Ref<StackHandle>;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemEls = useRef(new Map<number, HTMLElement>());

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
    <LazyProvider rootRef={scrollRef}>
      <div className="gal-stack" ref={scrollRef}>
        {items.map((item, i) => (
          <StackItem
            key={item.path}
            item={item}
            index={i}
            active={i === index}
            onOpen={onOpen}
            refCallback={(el) => {
              if (el) itemEls.current.set(i, el);
              else itemEls.current.delete(i);
            }}
          />
        ))}
      </div>
    </LazyProvider>
  );
}

/* ---------- grid view ---------- */

function GridView({
  items,
  index,
  large,
  onOpen,
  ref,
}: {
  items: ImageEntry[];
  index: number;
  large: boolean;
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

  return (
    <LazyProvider rootRef={scrollRef}>
      <div className={`gal-grid${large ? " large" : ""}`} ref={scrollRef}>
        {items.map((item, i) => (
          <button
            key={item.path}
            type="button"
            className={`gal-cell${i === index ? " active" : ""}`}
            title={item.name}
            ref={(el) => {
              if (el) cellEls.current.set(i, el);
              else cellEls.current.delete(i);
            }}
            onClick={() => onOpen(i)}
          >
            {isUndrawable(item.name) ? (
              <span className="gal-cell-unsupported">{t("gal.unsupportedShort")}</span>
            ) : (
              <GalleryImage src={convertFileSrc(item.path)} alt={item.name} />
            )}
          </button>
        ))}
      </div>
    </LazyProvider>
  );
}

/* ---------- filmstrip ---------- */

function Filmstrip({
  items,
  index,
  onPick,
}: {
  items: ImageEntry[];
  index: number;
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
          <button
            key={item.path}
            type="button"
            className={`gal-thumb${i === index ? " active" : ""}`}
            title={item.name}
            ref={(el) => {
              if (el) thumbEls.current.set(i, el);
              else thumbEls.current.delete(i);
            }}
            onClick={() => onPick(i)}
          >
            {isUndrawable(item.name) ? (
              <span className="gal-thumb-unsupported">{extOf(item.name)}</span>
            ) : (
              <GalleryImage src={convertFileSrc(item.path)} alt={item.name} />
            )}
          </button>
        ))}
      </div>
    </LazyProvider>
  );
}

/* ---------- gallery ---------- */

export default function ImageGallery({
  dir,
  startPath,
  interval,
  loop,
  onSaveSettings,
}: Props) {
  const [mode, setMode] = useState<GalleryMode>(startPath ? "single" : "stack");
  const [items, setItems] = useState<ImageEntry[]>([]);
  const [index, setIndex] = useState(0);
  const [recursive, setRecursive] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [scanned, setScanned] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [hover, setHover] = useState(false);
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [documentVisible, setDocumentVisible] = useState(
    () => !document.hidden
  );
  const [largeCells, setLargeCells] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const stackRef = useRef<StackHandle>(null);
  const gridRef = useRef<ViewHandle>(null);
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
    api
      .allowAssetDir(dir)
      .then(() => api.listImages(dir, recursive))
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
  }, [dir, recursive, refreshKey, startPath]);

  // The Explorer knows when a folder changed (a rename, a delete, a paste). It announces the
  // folder, and a gallery showing that folder — or, when recursive, one of its ancestors —
  // re-reads its list.
  useEffect(() => {
    const onChange = (e: Event) => {
      const changed = (e as CustomEvent<string>).detail;
      if (typeof changed !== "string") return;
      const key = pathKey(changed);
      const root = pathKey(dir);
      if (key === root || (recursive && key.startsWith(`${root}/`))) {
        setRefreshKey((k) => k + 1);
      }
    };
    window.addEventListener("wrolp:folder-changed", onChange);
    return () => window.removeEventListener("wrolp:folder-changed", onChange);
  }, [dir, recursive]);

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
  // picture in the single view, and going back must return the stack to it.
  const changeMode = useCallback((next: GalleryMode) => {
    setMode(next);
    if (next === "slideshow") setPlaying(true);
  }, []);

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
          if (mode === "slideshow" || mode === "stack") setMode("single");
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

  // Neighbours are warmed so the next frame of a slideshow is not a blank pane, and so an
  // arrow jump in the stacked view lands on a picture already on its way. Five pictures,
  // not the whole folder.
  const preload = items.filter(
    (item, i) =>
      Math.abs(i - index) <= 2 && i !== index && !isUndrawable(item.name)
  );

  const current = items[index];
  const totalBytes = items.reduce((sum, item) => sum + item.bytes, 0);
  const sizeText = formatBytes(totalBytes);

  return (
    <div className="image-gallery" ref={rootRef} tabIndex={-1}>
      <div className="gal-toolbar">
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
          index={index}
          onIndexChange={setIndex}
          onOpen={openAt}
        />
      ) : mode === "grid" ? (
        <GridView
          ref={gridRef}
          items={items}
          index={index}
          large={largeCells}
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
              <Undrawable path={current.path} />
            ) : current ? (
              <ImagePreview path={current.path} text={null} />
            ) : null}
          </div>
          <Filmstrip items={items} index={index} onPick={jumpTo} />
        </div>
      )}

      <div className="gal-preload" aria-hidden="true">
        {preload.map((item) => (
          <img key={item.path} src={convertFileSrc(item.path)} alt="" />
        ))}
      </div>
    </div>
  );
}
