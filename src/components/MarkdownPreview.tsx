import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api } from "../lib/tauri";

interface Props {
  /** Current buffer text. */
  text: string;
  /** Where the file lives, shown as a hint for relative links. */
  path: string;
  /** Fraction 0..1 of the editor's scroll position, so the two panes can track. */
  scrollRatio: number;
  beyondEnd: boolean;
  /** Called when the user scrolls the preview, to drive the editor instead. */
  onScrollRatio: (ratio: number) => void;
}

/**
 * Rendered markdown, side by side with the editor.
 *
 * The text comes out of a file the user opened, and markdown allows raw HTML, so the
 * output is sanitized before it reaches the DOM. Without that, opening a `.md` file is a
 * script-execution vector — and with `csp: null` in tauri.conf.json there is no CSP
 * backstop either.
 */
export default function MarkdownPreview({
  text,
  path,
  scrollRatio,
  onScrollRatio,
  beyondEnd,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /** Set while we move the preview ourselves, so our own scroll event is ignored. */
  const following = useRef(false);

  const sanitized = useMemo(() => {
    // `async: false` keeps this a plain string; marked would otherwise hand back a promise.
    const raw = marked.parse(text, { async: false, gfm: true, breaks: true }) as string;
    return DOMPurify.sanitize(raw, SANITIZE);
  }, [text]);

  /**
   * Folders the document points images into, resolved to absolute paths. `..` is allowed
   * here on purpose: the backend decides what is reachable, and it refuses whole drives
   * and the user's profile no matter how the path is spelled.
   */
  const referencedDirs = useMemo(() => {
    if (!path) return [] as string[];
    const doc = new DOMParser().parseFromString(`<body>${sanitized}</body>`, "text/html");
    const base = dirOf(path);
    const dirs = new Set<string>();
    for (const img of Array.from(doc.body.querySelectorAll("img"))) {
      const abs = resolveLocalImage(img.getAttribute("src"), base);
      if (abs) dirs.add(dirOf(abs));
    }
    return [...dirs];
  }, [sanitized, path]);

  // Grant access before any src is rewritten. Setting an asset URL the backend has not
  // been told about yet would 404, and the browser does not retry an <img> on its own,
  // so the order matters rather than being a micro-optimisation.
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    let live = true;
    setGranted(false);
    if (referencedDirs.length === 0) {
      setGranted(true);
      return;
    }
    Promise.all(referencedDirs.map((dir) => api.allowAssetDir(dir).catch(() => {}))).then(
      () => {
        if (live) setGranted(true);
      }
    );
    return () => {
      live = false;
    };
  }, [referencedDirs]);

  const html = useMemo(
    () => (granted ? rewriteImageSources(sanitized, path) : sanitized),
    [sanitized, granted, path]
  );

  /**
   * Size the tail that stands in for the editor's beyond-last-line space.
   *
   * The slack between the last line and the end of the content is not a constant. A
   * paragraph ends right after its text, a heading carries padding and a border, and a
   * `pre` carries 12px of padding, so a CSS `calc()` has to assume the largest guess and
   * is wrong for every other ending. Worse, both failure modes look like "the preview
   * scrolls oddly": too small a tail scrolls the last line out of view, too large a one
   * leaves blank space under it. So the two inputs that actually vary are measured, here,
   * and the arithmetic happens once in one place.
   *
   * Runs before the scroll-sync effect below (layout effects precede passive ones), which
   * is what lets it measure a pane that does not yet contain its own tail.
   */
  useLayoutEffect(() => {
    const pane = scrollRef.current;
    const body = bodyRef.current;
    if (!pane || !body || !beyondEnd) return;
    const tail = pane.querySelector<HTMLElement>(".md-tail");
    if (!tail) return;
    const apply = () => {
      tail.style.height = `${Math.max(0, Math.round(measureTail(pane, body)))}px`;
    };
    apply();
    // The answer depends on the pane's height, and an image that finishes loading moves
    // the last line. Neither changes the pane's own box, so this cannot loop.
    const observer = new ResizeObserver(apply);
    observer.observe(pane);
    observer.observe(body);
    return () => observer.disconnect();
  }, [html, beyondEnd]);

  // Follow the editor, but only when the editor is the one that moved.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    following.current = true;
    el.scrollTop = max * scrollRatio;
    // Release on the next frame: the scroll event from this assignment lands after it.
    const raf = requestAnimationFrame(() => {
      following.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollRatio, html]);

  const onScroll = () => {
    if (following.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) onScrollRatio(el.scrollTop / max);
  };

  // A path outside the asset scope renders as a broken image icon. React cannot attach
  // handlers to `dangerouslySetInnerHTML` content and `error` does not bubble, so the
  // only way to notice is a capture-phase listener on the container.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const markMissing = (e: Event) => {
      const img = e.target as HTMLElement;
      if (img.tagName === "IMG") img.setAttribute("data-missing", "");
    };
    el.addEventListener("error", markMissing, true);
    return () => el.removeEventListener("error", markMissing, true);
  }, []);

  return (
    <div className="md-preview" ref={scrollRef} onScroll={onScroll}>
      {/* Sanitized in `sanitize` below; `path` is rendered as text, never interpolated. */}
      <div className="md-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: html }} />
      {beyondEnd && <div className="md-tail" />}
    </div>
  );
}

/**
 * Height for the tail that mirrors Monaco's `scrollBeyondLastLine`.
 *
 * `tail = pane - remain`, where `remain` is the distance from the top of the last line to
 * the end of the body. The sign is easy to get backwards: scrolling to the end puts the
 * viewport's top edge at `contentHeight - paneHeight`, so the space left above the last
 * line works out to `pane - remain - tail` — zero, meaning the last line sits flush at the
 * top, exactly when `tail` equals `pane - remain`, and negative (the line is gone) once
 * `tail` exceeds it.
 *
 * `remain` is read off a single rect on purpose. Deriving it from a separate line height
 * instead is what went wrong twice: `getComputedStyle().lineHeight` is the line box while a
 * Range rect is the inline box, and the two differ by the half-leading, which leaves the
 * bottom of the line before it showing at the top edge.
 */
function measureTail(pane: HTMLElement, body: HTMLElement): number {
  const last = body.lastElementChild;
  if (!last) return 0;
  const lastLine = lastRenderedLine(last) ?? last.getBoundingClientRect();
  // Both rects are viewport-relative and read at the same instant, so their difference is
  // the distance below the last line wherever the pane is scrolled. Converting one of them
  // to content space first would mix coordinate systems and scale the result by scrollTop.
  const remain = body.getBoundingClientRect().bottom - lastLine.top;
  return pane.clientHeight - remain;
}

/**
 * The lowest line box rendered anywhere under `el`, or null when it renders no text.
 *
 * Walking backwards and taking the first text node that actually produces a line box is
 * what makes this correct. The obvious version — take the last child, and if it is a text
 * node measure it — fails on `marked` output, which puts a newline between block tags: a
 * `<ul>` therefore ends with a whitespace-only text node that renders no line box at all.
 * Falling back to the element's own box then put the tail ~180px short, because an
 * element's border box bottom is nowhere near its last line.
 *
 * Only a text node is measured, never an element box: a Range over a table also returns
 * the table's, tbody's and cell's boxes, and the lowest of those is the table's outer edge
 * rather than the line inside it.
 */
function lastRenderedLine(el: Node): DOMRect | null {
  for (let i = el.childNodes.length - 1; i >= 0; i--) {
    const child = el.childNodes[i];
    if (child.nodeType === Node.ELEMENT_NODE) {
      const found = lastRenderedLine(child);
      if (found) return found;
      continue;
    }
    if (child.nodeType !== Node.TEXT_NODE) continue;
    const range = document.createRange();
    range.selectNodeContents(child);
    // `width` filters the collapsed rect a trailing newline leaves behind, which sits at
    // the start of the *next* line and would otherwise pass for the last one.
    const rects = Array.from(range.getClientRects()).filter((r) => r.height > 0 && r.width > 0);
    // DOM order is not visual order once cells are involved, so take the lowest.
    if (rects.length) return rects.reduce((a, b) => (b.bottom > a.bottom ? b : a));
  }
  return null;
}

/**
 * Strip everything executable. `marked` only emits the tags we ask for, but markdown
 * text can carry raw HTML straight through, so the allow-list is deliberately narrow:
 * no scripts, no event handlers, no styles, no `javascript:` URLs.
 */
const SANITIZE = {
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li",
    "a", "img",
    "table", "thead", "tbody", "tr", "th", "td",
  ],
  ALLOWED_ATTR: ["href", "src", "alt", "title", "align"],
  // Strip srcset and style too, then constrain URLs to schemes that cannot run code.
  FORBID_ATTR: ["style", "srcset", "onerror", "onload", "onclick"],
  /**
   * Either an explicitly harmless scheme, or no scheme at all — the second branch is
   * what lets `img/logo.png`, `../shared/x.png`, `/root.png` and `#anchor` survive.
   *
   * Do not "tighten" this to a scheme-only list: DOMPurify drops the whole element when
   * a URI attribute fails this test (`_isValidAttribute` returns false, not just the
   * attribute), so a scheme-only pattern silently deletes every local image. Everything
   * with a colon has to be named here, which is what keeps `javascript:` and `data:`
   * out except for the `<img>` data-URI case DOMPurify allows on its own.
   */
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[^:]+$)/i,
};

/** Extensions worth spending an asset grant on. Anything else is left alone. */
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

function dirOf(filePath: string): string {
  const cut = filePath.replace(/[\\/][^\\/]*$/, "");
  return cut || filePath;
}

/**
 * Resolve an `img` src against the document's folder, or return null when it is not a
 * local image reference. Absolute URLs, data URIs, protocol-relative and root-absolute
 * links, and Windows paths spelled in the markdown ("C:\x.png") all return null: the
 * first group already resolves on its own, and the last is a drive path a document has
 * no business naming.
 */
function resolveLocalImage(src: string | null, baseDir: string): string | null {
  if (!src) return null;
  if (baseDir && /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i.test(src)) return null;
  if (!IMAGE_EXT.test(src.split(/[?#]/)[0])) return null;
  const segments = (baseDir ? `${baseDir}\\` : "").split(/[\\/]+/).filter(Boolean);
  for (const part of src.replace(/\//g, "\\").split("\\")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.length > 1 ? segments.join("\\") : null;
}

/** Swap every local image reference for an asset URL the backend has allowed. */
function rewriteImageSources(html: string, markdownPath: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const base = dirOf(markdownPath);
  for (const img of Array.from(doc.body.querySelectorAll("img"))) {
    const abs = resolveLocalImage(img.getAttribute("src"), base);
    if (abs) img.setAttribute("src", convertFileSrc(abs));
  }
  return doc.body.innerHTML;
}
