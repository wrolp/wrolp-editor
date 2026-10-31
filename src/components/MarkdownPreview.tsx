import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import monaco from "../lib/monaco";
import { t } from "../lib/i18n";
import { INLINE_SVG_SANITIZE, SANITIZE, SVG_SANITIZE } from "../lib/markdownHtml";
import {
  LOCAL_ASSET_SELECTOR,
  NOT_A_LOCAL_PATH,
  decodeRef,
  dirOf,
  joinToLocal,
  resolveLocalAsset,
  splitFragment,
} from "../lib/markdownAsset";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import { IconTreeChevron } from "./icons";
import { api, errorMessage, openUrl } from "../lib/tauri";

interface Props {
  /** Current buffer text. */
  text: string;
  /** Where the file lives, shown as a hint for relative links. */
  path: string;
  /** Fraction 0..1 of the editor's scroll position, so the two panes can track. */
  scrollRatio: number;
  beyondEnd: boolean;
  /** Reading measure for the body: `narrow` | `wide` | `full`, from `settings.previewWidth`. */
  width: string;
  /** Resolved scheme (dark | light) so diagrams are not drawn for the wrong background. */
  theme: string;
  /**
   * The outline column, asked for only by the preview-only layout. Splitting keeps the editor
   * in the frame, so the outline would be a third column competing with it for width.
   */
  showToc: boolean;
  /** Which edge the outline column takes: `left` | `right`. */
  tocSide: "left" | "right";
  /** Opens a file the document links to, beside itself. */
  onOpenPath: (path: string) => void;
  /** Reports a link that was followed but could not be opened. */
  onError: (message: string) => void;
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
  width,
  theme,
  showToc,
  tocSide,
  onOpenPath,
  onError,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  /**
   * The preview's own right-click menu. The pane is read-only, so it offers Copy (the selection,
   * or the block under the pointer), Copy code, Copy link and Select All — not Cut or Paste.
   */
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    selection: string;
    block: string;
    code: string | null;
    link: string | null;
  } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAt = useMenuPlacement(menu, menuRef);
  /**
   * Bumped whenever the body node turns out to be a fresh one, which is what makes the two
   * injection passes below run for it rather than for the node they filled last time.
   *
   * Both of those mutate DOM that React owns, so they are keyed on `html` alone — and switching
   * the layout re-creates the pane without changing `html`, which left a diagram that was on
   * screen go blank on the way to side-by-side, with only the sanitizer's placeholder in it.
   */
  const [bodyGeneration, setBodyGeneration] = useState(0);
  const attachBody = useCallback((el: HTMLDivElement | null) => {
    if (bodyRef.current === el) return;
    bodyRef.current = el;
    if (el) setBodyGeneration((n) => n + 1);
  }, []);
  /** Set while we move the preview ourselves, so our own scroll event is ignored. */
  const following = useRef(false);
  // Read through a ref so a theme change re-renders diagrams without rebuilding the
  // callback or re-running the fence pass for an unrelated reason.
  const themeRef = useRef(theme);
  themeRef.current = theme;

  /**
   * What the asynchronous pass produced for one fence: highlighted source for a code block,
   * SVG for a diagram, or the reason it could not be drawn.
   *
   * Keyed by content, not by position, which is what makes typing free: a keystroke outside
   * a fence leaves every key unchanged, so nothing is re-highlighted and no diagram is
   * re-rendered. A block that does change is simply a new key.
   */
  const cacheRef = useRef(
    new Map<string, { html?: string; svg?: string; error?: string }>()
  );
  /**
   * The inline `<svg>` markup the synchronous pass set aside, keyed by what its placeholder
   * names in `data-inline-svg`. Rebuilt with every render of the document, and read back by the
   * effect that puts the drawings in.
   */
  const inlineSvgRef = useRef(new Map<string, string>());
  /** Bumped when the cache gains something, so the synchronous pass re-runs. */
  const [resolved, setResolved] = useState(0);

  /** Every fence in the document, collected without rendering any of it. */
  const fences = useMemo(() => {
    const found: { key: string; lang: string; text: string; diagram: DiagramKind | null }[] = [];
    for (const token of marked.lexer(text)) {
      if (token.type !== "code") continue;
      const lang = fenceLang(token.lang);
      const source = token.text;
      const kind = (DIAGRAM_KINDS as Record<string, DiagramKind | undefined>)[lang] ?? null;
      found.push({ key: fenceKey(lang, source), lang, text: source, diagram: kind });
    }
    return found;
  }, [text]);

  /**
   * The asynchronous pass. Highlighting and diagram rendering both cost something — one
   * tokenises, the other may start a program — so this runs only for fences whose content is
   * not already resolved, and it does not run at all for a document without any.
   */
  useEffect(() => {
    let live = true;
    // The theme is part of the cache key: the same source drawn for the other scheme is a
    // different picture, and reusing it would leave a dark diagram in a light preview.
    const todo = fences.filter((f) => !cacheRef.current.has(cacheKey(f.key, themeRef.current)));
    if (todo.length === 0) return;
    Promise.all(
      todo.map(async (fence) => {
        // Mermaid's own dynamic import is the last thing attempted, so a document with only
        // code blocks never pays for it.
        if (fence.diagram) {
          try {
            const svg =
              fence.diagram === "mermaid"
                ? await renderMermaid(fence.text, fence.key, themeRef.current)
                : await api.renderDiagram(fence.diagram, fence.text);
            return [cacheKey(fence.key, themeRef.current), { svg }] as const;
          } catch (e) {
            return [cacheKey(fence.key, themeRef.current), { error: errorMessage(e) }] as const;
          }
        }
        const language = monacoLanguage(fence.lang);
        // An unknown or absent language is left as plain source rather than handed to
        // Monaco, which would answer with unstyled text anyway.
        if (!language) return null;
        try {
          const html = await monaco.editor.colorize(fence.text, language, { tabSize: 0 });
          return [fence.key, { html }] as const;
        } catch {
          return null;
        }
      })
    ).then((entries) => {
      if (!live) return;
      let changed = false;
      for (const entry of entries) {
        if (!entry) continue;
        cacheRef.current.set(entry[0], entry[1]);
        changed = true;
      }
      if (changed) setResolved((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [fences, theme]);

  const sanitized = useMemo(() => {
    // A renderer built per call rather than registered globally with `marked.use()`: this is
    // the only place that overrides code rendering, and a global registration would leak
    // into every other consumer of the singleton.
    const renderer = new marked.Renderer();
    renderer.code = ({ text: source, lang }) => {
      const info = fenceLang(lang);
      const key = fenceKey(info, source);
      // Must be the same key the effect below writes with, or the lookup never hits and
      // every diagram stays a placeholder no matter how many times it renders.
      const hit = cacheRef.current.get(cacheKey(key, theme));
      const cls = info ? ` class="language-${escapeHtml(info)}"` : "";
      if (hit?.html !== undefined) return `<pre><code${cls}>${hit.html}</code></pre>\n`;
      if (hit && DIAGRAM_KINDS[info as keyof typeof DIAGRAM_KINDS]) {
        // The diagram itself is injected after sanitisation — see the effect below — so all
        // that goes through here is a placeholder. The source rides along so a diagram that
        // never renders still shows what it was meant to be.
        return (
          `<div data-diagram="${escapeHtml(cacheKey(key, theme))}"><pre><code${cls}>${escapeHtml(source)}</code></pre></div>\n`
        );
      }
      return `<pre><code${cls}>${escapeHtml(source)}</code></pre>\n`;
    };
    // `async: false` keeps this a plain string; marked would otherwise hand back a promise.
    const raw = marked.parse(text, {
      async: false,
      gfm: true,
      breaks: true,
      renderer,
    }) as string;
    // A hand-written `<svg>` cannot go through the pass below — its allow-list has no SVG in it,
    // which is why the drawing used to arrive as an empty paragraph — so each one is set aside
    // here and put back by the effect after the sanitized HTML is in the DOM, through
    // `INLINE_SVG_SANITIZE`. The placeholder is inert and carries no attribute of its own.
    //
    // Only unescaped markup is matched: a code block reaches here as `&lt;svg`, so a document
    // that shows an SVG as an example keeps showing it as an example.
    const found = new Map<string, string>();
    let taken = 0;
    const withHoles = raw.replace(/<svg[\s\S]*?<\/svg>/gi, (svg) => {
      const key = `svg${taken++}`;
      found.set(key, svg);
      return `<div data-inline-svg="${key}"></div>`;
    });
    inlineSvgRef.current = found;
    return DOMPurify.sanitize(withHoles, SANITIZE);
  }, [text, resolved, theme]);

  /**
   * Folders the document points embedded assets into, resolved to absolute paths. `..` is allowed
   * here on purpose: the backend decides what is reachable, and it refuses whole drives
   * and the user's profile no matter how the path is spelled.
   */
  const referencedDirs = useMemo(() => {
    if (!path) return [] as string[];
    const doc = new DOMParser().parseFromString(`<body>${sanitized}</body>`, "text/html");
    const base = dirOf(path);
    const dirs = new Set<string>();
    for (const el of Array.from(doc.body.querySelectorAll(LOCAL_ASSET_SELECTOR))) {
      for (const name of ["src", "poster"]) {
        const abs = resolveLocalAsset(el.getAttribute(name), base);
        if (abs) dirs.add(dirOf(abs));
      }
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
    () => (granted ? rewriteAssetSources(sanitized, path) : sanitized),
    [sanitized, granted, path]
  );

  /**
   * Collapsed for this preview only. It is a reading convenience rather than a preference
   * worth a settings field: the list is there when a document needs it and out of the way
   * when it does not.
   */
  const [tocOpen, setTocOpen] = useState(true);
  /** Raw heading index of the section at the top of the pane. */
  const [activeIndex, setActiveIndex] = useState(0);
  const tocRef = useRef<HTMLElement>(null);
  // Read through a ref by `updateActive`, which must stay stable: taking `showToc` as a
  // dependency would rebuild it and re-run the follow effect, resetting the scroll position
  // every time the layout gains or loses the column.
  const showTocRef = useRef(showToc);
  showTocRef.current = showToc;

  /**
   * Which heading owns the top of the viewport.
   *
   * The edge is 16px below the pane's top rather than flush with it: `scrollToHeading` leaves
   * 12px, so a heading that was just clicked still counts as the current one. Taking the last
   * heading above the line, not the nearest one, keeps a section highlighted for its whole
   * length instead of only until its first paragraph scrolls under.
   *
   * Measured from live rects on every scroll rather than cached offsets: diagrams are injected
   * after the markdown pass and images finish loading later still, so any offset captured at
   * render time would go stale without an event to recompute it.
   */
  const updateActive = useCallback(() => {
    const pane = scrollRef.current;
    const body = bodyRef.current;
    if (!showTocRef.current || !pane || !body) return;
    // Same filter as `outline`: a heading with no text has no row to highlight, so it must
    // not win the position either. The raw index is kept because that is what a row stores.
    const headings = Array.from(body.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))
      .map((element, index) => ({ element, index }))
      .filter((heading) => (heading.element.textContent ?? "").trim());
    if (headings.length === 0) return;
    const max = pane.scrollHeight - pane.clientHeight;
    let index = headings[0].index;
    if (max > 0 && pane.scrollTop >= max - 1) {
      // With no room left to scroll, the last heading may never reach the top edge — a short
      // closing section, or no scroll-beyond-end tail. It is still the section being read.
      index = headings[headings.length - 1].index;
    } else {
      const edge = pane.getBoundingClientRect().top + 16;
      for (let i = 0; i < headings.length; i++) {
        if (headings[i].element.getBoundingClientRect().top <= edge) index = headings[i].index;
        else break;
      }
    }
    setActiveIndex((current) => (current === index ? current : index));
  }, []);

  /**
   * The headings, in document order, each with its position in the same query the click
   * handler uses.
   *
   * Read off the rendered HTML rather than the markdown source: a `#` inside a fence is not a
   * heading, and a setext underline is one, so the list is only guaranteed to match what is on
   * screen if it is taken from what is on screen.
   */
  const outline = useMemo(() => {
    if (!showToc) return [];
    const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
    const found = Array.from(doc.body.querySelectorAll("h1, h2, h3, h4, h5, h6"))
      .map((heading, index) => ({
        index,
        text: (heading.textContent ?? "").trim(),
        level: Number(heading.tagName.charAt(1)),
      }))
      .filter((heading) => heading.text);
    const shallowest = found.reduce((min, heading) => Math.min(min, heading.level), 6);
    return found.map((heading) => ({ ...heading, indent: heading.level - shallowest }));
  }, [html, showToc]);

  const jumpToHeading = (index: number) => {
    const pane = scrollRef.current;
    const body = bodyRef.current;
    if (!pane || !body) return;
    const target = body.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")[index];
    if (!target) return;
    setActiveIndex(index);
    scrollToHeading(pane, target);
  };

  /**
   * Keep the highlighted entry inside the column's own viewport. The outline is taller than
   * the column for a long document, so without this the highlight exists but scrolls out of
   * sight and the linkage is invisible.
   *
   * Only nudged when the row is actually outside — scrolling on every change would fight a
   * user who is browsing the outline by hand.
   */
  useEffect(() => {
    const nav = tocRef.current;
    if (!nav || !tocOpen) return;
    const row = nav.querySelector<HTMLElement>(`button[data-toc-index="${activeIndex}"]`);
    if (!row) return;
    const box = nav.getBoundingClientRect();
    const item = row.getBoundingClientRect();
    const margin = 6;
    if (item.top < box.top + margin) nav.scrollTop -= box.top + margin - item.top;
    else if (item.bottom > box.bottom - margin) nav.scrollTop += item.bottom - (box.bottom - margin);
  }, [activeIndex, tocOpen]);

  // The column can appear without the pane moving — entering the preview-only layout — so
  // the highlight is seeded as soon as it exists rather than waiting for the next scroll.
  useEffect(() => {
    if (showToc) updateActive();
  }, [showToc, updateActive]);

  /**
   * Puts the diagram SVGs into their placeholders.
   *
   * The SVG cannot go through the markdown pass: mermaid emits a `<style>` element inside
   * its drawing, and `style` is forbidden there by design, so it would arrive stripped or not
   * at all. The placeholder is what the markdown pass emits; the drawing is injected here,
   * through the separate `SVG_SANITIZE` boundary, once the sanitized HTML is in the DOM.
   *
   * A failure leaves the source the placeholder already carries and adds the reason, so a
   * diagram whose tool is not installed shows what it was rather than an empty box.
   *
   * Ahead of the tail measurement below, which therefore measures the height the document
   * actually ended up with rather than one that is about to change.
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    for (const holder of Array.from(body.querySelectorAll<HTMLElement>("div[data-diagram]"))) {
      const key = holder.getAttribute("data-diagram") ?? "";
      const hit = cacheRef.current.get(key);
      if (holder.dataset.injected === (hit?.svg ?? hit?.error ?? "")) continue;
      holder.dataset.injected = hit?.svg ?? hit?.error ?? "";
      if (hit?.svg) {
        holder.removeAttribute("data-diagram-error");
        const svg = DOMPurify.sanitize(hit.svg, SVG_SANITIZE);
        // The drawing is wrapped in a scrollable stage plus a hover toolbar. The SVG cannot
        // carry these as React children — it is injected HTML — so the toolbar buttons are
        // wired up by the delegated listener below.
        holder.insertAdjacentHTML(
          "afterbegin",
          `<div class="md-diagram-zoom">` +
            `<button type="button" class="md-dz" data-zoom="out" title="缩小" aria-label="缩小">−</button>` +
            `<span class="md-dz-val">100%</span>` +
            `<button type="button" class="md-dz" data-zoom="in" title="放大" aria-label="放大">+</button>` +
            `<button type="button" class="md-dz" data-zoom="reset" title="重置" aria-label="重置">⟲</button>` +
            `</div>` +
            `<div class="md-diagram-stage">${svg}</div>`
        );
      } else if (hit?.error) {
        holder.setAttribute("data-diagram-error", "");
        const note = document.createElement("div");
        note.className = "md-diagram-error";
        note.textContent = hit.error;
        holder.insertAdjacentElement("afterbegin", note);
      }
    }
  }, [html, bodyGeneration]);

  /**
   * Puts the document's own `<svg>` drawings back.
   *
   * The markup was lifted out of the rendered HTML by the synchronous pass, because that pass
   * has no SVG in its allow-list and would have left an empty paragraph where a drawing belongs.
   * It comes back through `INLINE_SVG_SANITIZE` — the diagram profile, with the one thing a
   * document is not trusted for taken out — and only after the sanitized HTML is in the DOM, so
   * nothing here reaches the page unfiltered.
   */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    for (const holder of Array.from(
      body.querySelectorAll<HTMLElement>("div[data-inline-svg]")
    )) {
      const svg = inlineSvgRef.current.get(holder.dataset.inlineSvg ?? "");
      if (!svg) continue;
      holder.innerHTML = DOMPurify.sanitize(svg, INLINE_SVG_SANITIZE);
    }
  }, [html, bodyGeneration]);

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
   *
   * `bodyGeneration` is a dependency because the observer below holds the body node: a pane
   * that was re-created would otherwise leave it watching a detached element, so the tail
   * stops following the content it was sized for.
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
  }, [html, beyondEnd, bodyGeneration]);

  // Follow the editor, but only when the editor is the one that moved.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    following.current = true;
    el.scrollTop = max * scrollRatio;
    // The assignment above may not emit a scroll event when the value did not change, and
    // the outline still has to reflect where the pane ended up after a document edit.
    updateActive();
    // Release on the next frame: the scroll event from this assignment lands after it.
    const raf = requestAnimationFrame(() => {
      following.current = false;
    });
    return () => cancelAnimationFrame(raf);
  }, [scrollRatio, html, updateActive]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Runs even while we are the one scrolling: the outline must follow the editor as well.
    updateActive();
    if (following.current) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max > 0) onScrollRatio(el.scrollTop / max);
  };

  const openPreviewMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const pane = scrollRef.current;
    if (!pane) return;
    const target = event.target as Element;
    const selection = window.getSelection();
    const selected =
      selection && pane.contains(selection.anchorNode) ? selection.toString() : "";
    const code = target.closest("pre")?.textContent ?? null;
    const link = target.closest("a[href]")?.getAttribute("href") ?? null;
    // The fallback is the block the pointer is in, so Copy works over a paragraph or a table
    // cell without asking the user to select it first.
    const block =
      target.closest("p, li, blockquote, h1, h2, h3, h4, h5, h6, td, th")?.textContent ??
      bodyRef.current?.innerText ??
      "";
    setMenu({
      x: event.clientX,
      y: event.clientY,
      selection: selected,
      block: block.trim(),
      code,
      link,
    });
  };

  const runPreviewMenu = (action: "copy" | "code" | "link" | "selectAll") => {
    const current = menu;
    setMenu(null);
    if (!current) return;
    if (action === "selectAll") {
      const body = bodyRef.current;
      if (!body) return;
      const range = document.createRange();
      range.selectNodeContents(body);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      return;
    }
    const text =
      action === "copy"
        ? current.selection || current.block
        : action === "code"
          ? current.code ?? ""
          : current.link ?? "";
    if (text) void writeText(text).catch(() => {});
  };

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

  /**
   * Make the links inside the preview go somewhere.
   *
   * Left to the document, every kind of `href` fails in its own way and all of them read as a
   * broken click: a `#heading` rewrites the app window's own URL hash, a relative path tries to
   * navigate the webview away from the app, and an external URL is refused by Tauri's navigation
   * guard. Each kind is answered here instead, and the click is taken away from the document
   * first so that nothing it holds can move the window — including a scheme this never handles.
   */
  useEffect(() => {
    const pane = scrollRef.current;
    if (!pane) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const link = (e.target as Element).closest?.("a");
      const href = link?.getAttribute("href");
      // An `<a>` with no href is a marker rather than a link; it has nothing to go to.
      if (!href) return;
      e.preventDefault();
      if (href.startsWith("#")) {
        const body = bodyRef.current;
        if (!body) return;
        const target = findHeadingBySlug(body, anchorOf(href));
        if (!target) return;
        scrollToHeading(pane, target);
        return;
      }
      if (EXTERNAL_SCHEME.test(href)) {
        openUrl(href).catch((err) => onError(errorMessage(err)));
        return;
      }
      const target = resolveLocalTarget(href, dirOf(path));
      if (target) onOpenPath(target);
    };
    pane.addEventListener("click", onClick);
    return () => pane.removeEventListener("click", onClick);
  }, [path, onOpenPath, onError]);

  // Diagrams are injected as plain HTML, so the zoom controls get their handlers through
  // delegation on the preview container — the same trick the broken-image detection uses.
  // Plain wheel keeps scrolling the preview; Ctrl/Cmd + wheel zooms the diagram under it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    /**
     * The level lives in `data-zoom-level`, NOT in `data-zoom` — the zoom *buttons* carry
     * `data-zoom` ("in" / "out" / "reset"), and the delegated click handler below finds them
     * by `closest()`. Storing the level under the same name put that attribute on the stage,
     * so `closest()` starting at the stage matched the stage itself, read "1.44" as an
     * action, matched neither branch and fell through to reset. The dragged-to-pan click is
     * retargeted to the stage by pointer capture, so every reset happened right after a pan.
     */
    const setZoom = (stage: HTMLElement, zoom: number) => {
      const previous = Number(stage.dataset.zoomLevel ?? "1") || 1;
      const clamped = Math.min(Math.max(Math.round(zoom * 100) / 100, 0.2), 5);
      stage.dataset.zoomLevel = String(clamped);
      const svg = stage.querySelector("svg");
      const val = stage.closest("div[data-diagram]")?.querySelector<HTMLElement>(".md-dz-val");
      if (val) val.textContent = `${Math.round(clamped * 100)}%`;
      if (svg) {
        if (clamped === 1) {
          // Hand the drawing back to the stylesheet: it fits its column again.
          svg.style.width = "";
          svg.style.height = "";
          svg.style.maxWidth = "";
        } else {
          // Scale from the size the drawing actually occupies unscaled, not from its
          // viewBox: a drawing wider than the column is already shrunk to fit by
          // `max-width`, and multiplying its intrinsic width would jump to something
          // several times the size on the screen. Taking the laid-out size once, then
          // dividing the current size back out on later steps, keeps every level a plain
          // multiple of what the user saw at 100% and does not drift as steps repeat.
          const base = svg.style.width
            ? {
                w: parseFloat(svg.style.width) / previous,
                h: parseFloat(svg.style.height) / previous,
              }
            : (() => {
                const box = svg.getBoundingClientRect();
                return { w: box.width, h: box.height };
              })();
          if (base.w > 0 && base.h > 0) {
            svg.style.maxWidth = "none";
            svg.style.width = `${Math.round(base.w * clamped)}px`;
            svg.style.height = `${Math.round(base.h * clamped)}px`;
          }
        }
      }
      // Only a drawing that actually overflows its column can be panned, so the grab cursor
      // and the drag handler are gated on this class rather than on the zoom value.
      const overflow = stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight;
      stage.classList.toggle("md-can-pan", overflow);
    };
    const onClick = (e: MouseEvent) => {
      // Matched on the tag too, so a future `data-zoom` on something that is not a control
      // can never be read as an action. `closest` starts at the target itself.
      const btn = (e.target as Element).closest?.("button[data-zoom]");
      if (!btn) return;
      const stage = btn.closest("div[data-diagram]")?.querySelector<HTMLElement>(".md-diagram-stage");
      if (!stage) return;
      const action = btn.getAttribute("data-zoom");
      const current = Number(stage.dataset.zoomLevel ?? "1");
      setZoom(stage, action === "in" ? current * 1.2 : action === "out" ? current / 1.2 : 1);
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const stage = (e.target as Element).closest?.(".md-diagram-stage") as HTMLElement | null;
      if (!stage) return;
      e.preventDefault();
      const current = Number(stage.dataset.zoomLevel ?? "1");
      setZoom(stage, e.deltaY < 0 ? current * 1.1 : current / 1.1);
    };
    // Press-and-drag pans a diagram that is larger than its column. Pointer events are
    // used so the same code covers mouse and trackpad; the move/up listeners go on window
    // so a fast drag that leaves the stage still pans instead of stalling.
    let pan: { stage: HTMLElement; x: number; y: number; sl: number; st: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      const stage = (e.target as Element).closest?.(".md-diagram-stage") as HTMLElement | null;
      if (!stage || !stage.classList.contains("md-can-pan")) return;
      pan = { stage, x: e.clientX, y: e.clientY, sl: stage.scrollLeft, st: stage.scrollTop };
      stage.classList.add("md-dragging");
      stage.setPointerCapture?.(e.pointerId);
      e.preventDefault(); // stop text selection / native image drag while panning
    };
    const onPointerMove = (e: PointerEvent) => {
      if (!pan) return;
      pan.stage.scrollLeft = pan.sl - (e.clientX - pan.x);
      pan.stage.scrollTop = pan.st - (e.clientY - pan.y);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!pan) return;
      pan.stage.classList.remove("md-dragging");
      pan.stage.releasePointerCapture?.(e.pointerId);
      pan = null;
    };
    el.addEventListener("click", onClick);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
  }, []);

  const pane = (
    <div
      className="md-preview"
      data-md-width={width}
      ref={scrollRef}
      onScroll={onScroll}
      onContextMenu={openPreviewMenu}
    >
      {/* Sanitized in `sanitize` below; `path` is rendered as text, never interpolated. */}
      <div className="md-body" ref={attachBody} dangerouslySetInnerHTML={{ __html: html }} />
      {beyondEnd && <div className="md-tail" />}

      {menu && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ display: "block", left: menuAt.left, top: menuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div className="ctx-item" onClick={() => runPreviewMenu("copy")}>
            {t("editor.copy")}
          </div>
          {menu.code !== null && (
            <div className="ctx-item" onClick={() => runPreviewMenu("code")}>
              {t("preview.copyCode")}
            </div>
          )}
          {menu.link !== null && (
            <div className="ctx-item" onClick={() => runPreviewMenu("link")}>
              {t("preview.copyLink")}
            </div>
          )}
          <div className="ws-sep" />
          <div className="ctx-item" onClick={() => runPreviewMenu("selectAll")}>
            {t("editor.selectAll")}
          </div>
        </div>
      )}
    </div>
  );

  // The outline is a sibling of the scroller rather than a sticky child of it: the pane's own
  // scroll position is what tracks the editor, and a column inside it would move with that.
  const showOutline = showToc && outline.length > 0;

  const outlineColumn = showOutline ? (
    <nav className={`md-toc${tocOpen ? "" : " collapsed"}`} aria-label={t("preview.toc")} ref={tocRef}>
      <div className="md-toc-head">
        <span className="md-toc-title">{t("preview.toc")}</span>
        <button
          type="button"
          className="md-toc-toggle"
          title={t(tocOpen ? "preview.tocCollapse" : "preview.tocExpand")}
          aria-expanded={tocOpen}
          onClick={() => setTocOpen((open) => !open)}
        >
          <span className="chev">
            <IconTreeChevron />
          </span>
        </button>
      </div>
      <ul>
        {outline.map((heading) => (
          <li
            key={heading.index}
            style={{ "--toc-indent": heading.indent } as CSSProperties}
          >
            <button
              type="button"
              className={heading.index === activeIndex ? "active" : undefined}
              aria-current={heading.index === activeIndex ? "location" : undefined}
              data-toc-index={heading.index}
              title={heading.text}
              onClick={() => jumpToHeading(heading.index)}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  ) : null;

  /**
   * The wrapper is here even when there is no outline to put in it, and that is load-bearing.
   *
   * Returning the bare pane instead made the pane the root of this subtree, so the switch to a
   * layout that does have an outline re-rooted the same `div` type under a wrapper. React then
   * paired the old children with the new ones by position and reused the `.md-tail` node as the
   * pane — and the tail's height is written from `measureTail`, which React does not own and so
   * never clears. The preview came back standing at the tail's old height, leaving a strip of
   * unfilled row under it. Pinning the pane to one child slot keeps its node, and its scroll
   * position, across every layout switch.
   */
  return (
    <div className={`md-with-toc${tocSide === "right" ? " toc-right" : ""}`}>
      {tocSide === "left" ? outlineColumn : null}
      {pane}
      {tocSide === "right" ? outlineColumn : null}
    </div>
  );
}

/**
 * Puts a heading just below the top edge of the pane.
 *
 * Measured from the pane's own edge rather than by `scrollIntoView`, which would also scroll
 * any ancestor, and from the heading's box rather than its `offsetTop`, whose offset parent is
 * whichever wrapper last happened to be positioned.
 */
function scrollToHeading(pane: HTMLElement, target: HTMLElement) {
  pane.scrollTop += target.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12;
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

/** Fence languages that are diagrams rather than source. */
const DIAGRAM_KINDS = { mermaid: "mermaid", plantuml: "plantuml", graphviz: "graphviz" } as const;
type DiagramKind = (typeof DIAGRAM_KINDS)[keyof typeof DIAGRAM_KINDS];

/**
 * The fence info string, reduced to a language token.
 *
 * marked hands over the whole info string, and people write `js title=x`, `python {hl}` and
 * `{.rust}` for their own reasons, so only the leading word is meaningful here.
 */
function fenceLang(lang: string | undefined): string {
  if (!lang) return "";
  return lang
    .trim()
    .split(/\s+/)[0]
    .replace(/^\{+/, "")
    .replace(/\}$/, "")
    .toLowerCase();
}

/**
 * Escapes text for the one context `colorize` does not cover itself.
 *
 * Monaco escapes `&` and `<`, and turns runs of spaces into `&nbsp;` — but not `"`. That is
 * fine for its own output and not fine for an attribute, so anything this module puts inside
 * an attribute is escaped here.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Fence language to Monaco language id, built once from the editor's own registry.
 *
 * Monaco's registry is the source of truth rather than a hand-written list, so every
 * language the editor can already open is highlightable here without being enumerated. The
 * extra aliases cover the spellings people actually type into a fence, which the registry
 * does not always carry (`sh`, `c++`, `py`).
 */
let langMap: Map<string, string> | null = null;

function monacoLanguage(token: string): string | null {
  if (!langMap) {
    langMap = new Map();
    for (const lang of monaco.languages.getLanguages()) {
      langMap.set(lang.id.toLowerCase(), lang.id);
      for (const alias of lang.aliases ?? []) langMap.set(alias.toLowerCase(), lang.id);
      for (const ext of lang.extensions ?? []) langMap.set(ext.replace(/^\./, "").toLowerCase(), lang.id);
    }
    for (const [alias, id] of Object.entries({
      "c++": "cpp", cxx: "cpp", hpp: "cpp", "c#": "csharp", cs: "csharp",
      py: "python", rb: "ruby", rs: "rust", kt: "kotlin", tsx: "typescript",
      jsx: "javascript", golang: "go", sh: "shell", bash: "shell", zsh: "shell",
      console: "shell", yml: "yaml", md: "markdown", ps1: "powershell",
    })) {
      langMap.set(alias, id);
    }
  }
  return langMap.get(token) ?? null;
}

/** Extensions worth spending an asset grant on. Anything else is left alone. */
let mermaidModule: Promise<typeof import("mermaid")> | null = null;

/**
 * Draws a mermaid diagram to SVG.
 *
 * `securityLevel: "strict"` is the point of this function, not a default to accept: it is
 * the only level that escapes HTML inside labels and refuses `click` bindings.
 *
 * `htmlLabels: false` is what makes the result survive the sanitizer. Left on, mermaid draws
 * every label as HTML inside a `<foreignObject>` — five of them for a three-node flowchart,
 * and no `<text>` at all — so forbidding `foreignObject` (which the SVG pass must, since that
 * is the one tag that lets markup back into an SVG) silently removes every label and leaves
 * a diagram with unlabelled boxes. Turning it off makes mermaid emit real `<text>`, and the
 * whole drawing then passes the sanitizer untouched: measured, zero tags removed.
 *
 * `startOnLoad: false` because nothing here is automatic: rendering is driven by the async
 * pass, one fence at a time. The module is imported on first use and kept, so a document with
 * no diagram never loads it.
 *
 * Residual risk, stated plainly: mermaid keeps a `<style>` element inside its drawing, which
 * this pass allows because the labels need it — they take their colour from there. A diagram
 * can therefore supply CSS through mermaid's `themeCSS` init directive. That is CSS only,
 * with no script and no way out of the preview pane, and it requires a document the user
 * chose to open; it is the price of mermaid's own styling, not an oversight.
 */
async function renderMermaid(source: string, key: string, theme: string): Promise<string> {
  mermaidModule ??= import("mermaid");
  const mermaid = (await mermaidModule).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    // Mermaid ships a light and a dark theme; the app picks its own so a diagram cannot
    // arrive as a dark slab inside a light preview. "default" is mermaid light theme.
    theme: theme === "light" ? "default" : "dark",
    htmlLabels: false,
    flowchart: {
      htmlLabels: false,
      // Tighter than the defaults: a wide `flowchart LR` spends its width on the gaps between
      // ranks, and 50px of empty space per rank adds up. Measured on a cyclic nine-node graph,
      // 20/15 draws it 1262x226 where the defaults draw 1382x287 — the same drawing, 9% narrower
      // and 21% shorter. ELK was measured too and drew it 1880 wide, so dagre stays.
      curve: "linear",
      nodeSpacing: 15,
      rankSpacing: 20,
      padding: 8,
    },
  });
  // The id has to be unique per render and safe as a DOM id.
  const { svg } = await mermaid.render(`mmd-${key}`, source);
  return svg;
}

/**
 * Cache key for one fence. The scheme is part of it, so switching themes redraws the
 * diagram instead of reusing the picture drawn for the other one.
 *
 * `RENDER_VERSION` is the third part: it is bumped whenever the rendering pipeline
 * changes, so a cached picture drawn under old code is invalidated and redrawn without
 * the user having to restart or edit the document. Without it, the cache — keyed only by
 * source and theme — would keep serving a stale diagram after a fix like the mermaid
 * class-stripping one, making the change look like it did nothing.
 *
 * Only ever a cache key and a data-diagram attribute value. It must NOT reach
 * mermaid as a DOM id: the theme separator is not a legal character in a CSS
 * selector and mermaid looks its drawing up by id, so an id built from this string
 * fails outright. The id uses the plain fence.key, which is already an id-safe digest.
 */
const RENDER_VERSION = 3;
function cacheKey(key: string, theme: string): string {
  return key + String.fromCharCode(64) + theme + String.fromCharCode(64) + RENDER_VERSION;
}

/**
 * A short, collision-resistant, DOM-id-safe digest of a cache key.
 */
function hashKey(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Identity of one fenced block: its language and its content, and nothing else.
 *
 * Hashed rather than spelled out because the key has to survive a round trip through an
 * HTML attribute — the injection effect reads it back off the placeholder to find what to
 * draw. Anything unusual in the source would not survive that trip (a NUL, which is the
 * natural separator, becomes U+FFFD the moment the parser sees it in an attribute) and the
 * lookup would silently miss. A digest is the same in both places whatever the source
 * contains, and it keeps a diagram's text out of the document.
 */
function fenceKey(lang: string, source: string): string {
  return hashKey(`${lang}\n${source}`);
}

/** The four schemes the opener plugin may hand to a default application. */
const EXTERNAL_SCHEME = /^(?:https?|mailto|tel):/i;

/**
 * The file a link points at beside the document: its `#fragment` dropped, percent-decoded, then
 * resolved. Null for a pure anchor and for anything `NOT_A_LOCAL_PATH` refuses.
 *
 * The decoded form is checked again because escaping is how a refusal is usually smuggled:
 * `%2F..%2F` is a root-absolute path once it has been read, not before.
 */
function resolveLocalTarget(href: string, baseDir: string): string | null {
  const file = splitFragment(href)[0].split(/[?#]/)[0];
  if (!file || (baseDir && NOT_A_LOCAL_PATH.test(href))) return null;
  const decoded = decodeRef(file);
  if (NOT_A_LOCAL_PATH.test(decoded)) return null;
  return joinToLocal(decoded, baseDir);
}

/**
 * GitHub's anchor spelling for a heading, so a table of contents written as
 * `[Install](#installation)` reaches its target whatever tool wrote it. Punctuation goes, spaces
 * become hyphens, and letters of any script stay — a Chinese heading's anchor is its own text.
 */
function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/\s+/g, "-");
}

/** The anchor an `href` asks for, in the same spelling headings are slugified into. */
function anchorOf(href: string): string {
  return headingSlug(decodeRef(href.slice(1)));
}

/**
 * The heading an in-document anchor names, or null.
 *
 * Repeated headings take GitHub's `-1`, `-2` suffixes, which forces a walk of the whole document
 * in order: what the third "Usage" is called is only knowable from the two before it.
 *
 * The id is deliberately never written onto the element. Settling the anchor here means a file's
 * own HTML cannot put an `id` anywhere in the app's document — which is why `id` is not in the
 * sanitiser's allow-list either, and stays out of it.
 */
function findHeadingBySlug(body: HTMLElement, want: string): HTMLElement | null {
  if (!want) return null;
  const seen = new Map<string, number>();
  for (const heading of Array.from(body.querySelectorAll("h1, h2, h3, h4, h5, h6"))) {
    const base = headingSlug(heading.textContent ?? "");
    const repeats = seen.get(base) ?? 0;
    seen.set(base, repeats + 1);
    if ((repeats === 0 ? base : `${base}-${repeats}`) === want) return heading as HTMLElement;
  }
  return null;
}

/** Swap every local picture/recording reference for an asset URL the backend has allowed. */
function rewriteAssetSources(html: string, markdownPath: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const base = dirOf(markdownPath);
  for (const el of Array.from(doc.body.querySelectorAll(LOCAL_ASSET_SELECTOR))) {
    for (const name of ["src", "poster"]) {
      const abs = resolveLocalAsset(el.getAttribute(name), base);
      if (abs) el.setAttribute(name, convertFileSrc(abs));
    }
  }
  return doc.body.innerHTML;
}
