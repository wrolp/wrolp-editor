import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { convertFileSrc } from "@tauri-apps/api/core";
import monaco from "../lib/monaco";
import { api, errorMessage } from "../lib/tauri";

interface Props {
  /** Current buffer text. */
  text: string;
  /** Where the file lives, shown as a hint for relative links. */
  path: string;
  /** Fraction 0..1 of the editor's scroll position, so the two panes can track. */
  scrollRatio: number;
  beyondEnd: boolean;
  /** Resolved scheme (dark | light) so diagrams are not drawn for the wrong background. */
  theme: string;
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
  theme,
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
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
    return DOMPurify.sanitize(raw, SANITIZE);
  }, [text, resolved, theme]);

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
  }, [html]);

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

  // Diagrams are injected as plain HTML, so the zoom controls get their handlers through
  // delegation on the preview container — the same trick the broken-image detection uses.
  // Plain wheel keeps scrolling the preview; Ctrl/Cmd + wheel zooms the diagram under it.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const setZoom = (stage: HTMLElement, zoom: number) => {
      const clamped = Math.min(Math.max(Math.round(zoom * 100) / 100, 0.2), 5);
      stage.dataset.zoom = String(clamped);
      const svg = stage.querySelector("svg");
      const val = stage.closest("div[data-diagram]")?.querySelector<HTMLElement>(".md-dz-val");
      if (val) val.textContent = `${Math.round(clamped * 100)}%`;
      if (svg) {
        // `zoom` is unreliable on an SVG whose width is capped by `max-width: 100%`, so the
        // size is set from the viewBox instead: explicit pixel width and height scale the
        // drawing deterministically and let the stage scroll when it outgrows the column.
        if (clamped === 1) {
          svg.style.width = "";
          svg.style.height = "";
          svg.style.maxWidth = "";
        } else {
          const vb = svg.viewBox?.baseVal;
          if (vb && vb.width && vb.height) {
            svg.style.maxWidth = "none";
            svg.style.width = `${Math.round(vb.width * clamped)}px`;
            svg.style.height = `${Math.round(vb.height * clamped)}px`;
          }
        }
      }
      // Only a drawing that actually overflows its column can be panned, so the grab cursor
      // and the drag handler are gated on this class rather than on the zoom value.
      const overflow = stage.scrollWidth > stage.clientWidth || stage.scrollHeight > stage.clientHeight;
      stage.classList.toggle("md-can-pan", overflow);
    };
    const onClick = (e: MouseEvent) => {
      const btn = (e.target as Element).closest?.("[data-zoom]");
      if (!btn) return;
      const stage = btn.closest("div[data-diagram]")?.querySelector<HTMLElement>(".md-diagram-stage");
      if (!stage) return;
      const action = btn.getAttribute("data-zoom");
      const current = Number(stage.dataset.zoom ?? "1");
      setZoom(stage, action === "in" ? current * 1.2 : action === "out" ? current / 1.2 : 1);
    };
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const stage = (e.target as Element).closest?.(".md-diagram-stage") as HTMLElement | null;
      if (!stage) return;
      e.preventDefault();
      const current = Number(stage.dataset.zoom ?? "1");
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
    // For the highlighter's token spans, and for the diagram placeholders. Both are inert on
    // their own: neither carries an attribute that survives the hook below.
    "span", "div",
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

/**
 * Lets the highlighter's `class` through inside a code block, and nowhere else.
 *
 * The highlighter emits `<span class="mtkN">`, and those classes are what carry the colour,
 * so without this every block renders as flat uncoloured text. But `class` on the document
 * at large is a different thing: a document that could name classes could restyle the app
 * chrome around it, so the attribute is kept strictly inside `pre > code`.
 *
 * `uponSanitizeAttribute` is the hook that can do this — it runs *before* the allow-list
 * check and exposes `forceKeepAttr`, which short-circuits it. (`afterSanitizeAttributes`
 * would be too late: the attribute has already been removed by then.) The decision is
 * per-attribute rather than a mutation of `allowedAttributes`, because that set is cloned
 * once per `sanitize()` call and mutating it would leak into every later element.
 *
 * Registered once at module scope: `addHook` pushes onto an array, so doing this per render
 * would stack duplicates that each re-run for every attribute of every element.
 */
DOMPurify.addHook("uponSanitizeAttribute", (node, event) => {
  if (event.attrName !== "class") return;
  // Diagram SVG keeps its classes. Mermaid colours everything through class selectors in
  // its embedded `<style>` (`#mmd-x .node rect { fill: … }`), so stripping `class` there
  // left every rule unmatched: nodes fell back to an inherited grey fill and the labels
  // lost their layout — grey slabs with no text. SVG content is already fenced off from
  // the document by its own pass, and a class inside a drawing cannot style the app.
  if (node.namespaceURI === "http://www.w3.org/2000/svg") return;
  // `closest` matches the element itself, so this covers `<code class="language-x">` as
  // well as the spans inside it.
  if ((node as Element).closest("pre > code")) event.forceKeepAttr = true;
  else event.keepAttr = false;
});

/**
 * A second, narrower boundary for diagram SVG.
 *
 * The main allow-list cannot take SVG: mermaid emits a `<style>` element inside its `<svg>`,
 * and `style` is in `FORBID_ATTR` by design, so forcing it through would strip the styling
 * or the whole drawing. Diagram output does not come from the document either — it comes
 * from mermaid or from a local program — but it is still generated from text the document
 * supplied, so it gets its own pass with scripting and HTML embedding forbidden outright.
 *
 * `xlink:href` is deliberately not forbidden: both mermaid and graphviz reference their own
 * arrowheads with `url(#marker)`, and DOMPurify's default URI check already rejects
 * `javascript:`.
 *
 * Residual risk, now that `style` really is let through rather than merely believed to be:
 * CSS inside an inline `<svg>` applies to the whole document, not just the drawing, so a
 * crafted document could restyle the app's own chrome through mermaid's `themeCSS`
 * directive. It is CSS only — no script, and no way to read anything back out — and it
 * takes a file the user chose to open. Scoping the rules would mean rewriting mermaid's
 * stylesheet on the way through, which is a bigger change than the problem warrants; if it
 * ever stops being acceptable, dropping `style` and setting the colours on the container in
 * app.css is the fallback.
 */
const SVG_SANITIZE = {
  USE_PROFILES: { svg: true, svgFilters: true },
  // Naming a profile REPLACES the default allow-list rather than adding to it, and `style`
  // belongs to the html profile. Without this line mermaid's embedded stylesheet is
  // stripped, taking every colour with it: the shapes keep the inline fills they carry and
  // the labels fall back to the app's text colour, which is how a dark diagram ended up
  // with light boxes and unreadable text. `FORBID_CONTENTS` does not undo this — it only
  // governs the children of a node that was disallowed in the first place.
  ADD_TAGS: ["style"],
  FORBID_TAGS: [
    "script", "foreignObject", "iframe", "object", "embed",
    "animate", "animateMotion", "animateTransform", "set", "handler",
  ],
  FORBID_ATTR: ["onload", "onerror", "onclick", "onbegin", "onend", "onrepeat"],
};

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
const IMAGE_EXT = /\.(?:png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

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
    flowchart: { htmlLabels: false },
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
const RENDER_VERSION = 2;
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
