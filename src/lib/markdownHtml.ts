import DOMPurify from "dompurify";

/**
 * The preview's policy for raw HTML inside a document, as one source of truth.
 *
 * Everything here is what `MarkdownPreview` feeds to DOMPurify. The two hooks at the bottom
 * register themselves when this module is first imported, which is the same moment the
 * component that sanitizes is loaded — they are module-scope because `addHook` pushes onto an
 * array, so registering per render would stack duplicates that each re-run for every attribute
 * of every element.
 */

/**
 * Strip everything executable. `marked` only emits the tags we ask for, but markdown text can
 * carry raw HTML straight through, so the allow-list is what decides what a document is allowed
 * to look like: the tags that mean something in a document are in, and a script, a stylesheet, a
 * form, an event handler or a URL scheme that can run code never are.
 */
export const SANITIZE = {
  ALLOWED_TAGS: [
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "br", "hr",
    "strong", "em", "del", "code", "pre", "blockquote",
    "ul", "ol", "li",
    "a", "img",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
    // For the highlighter's token spans, and for the diagram placeholders.
    "span", "div",
    // A document's own emphasis and annotations, which used to arrive as bare text.
    "b", "i", "u", "s", "strike", "small", "big", "sup", "sub", "ins", "mark", "kbd", "samp",
    "var", "abbr", "dfn", "time", "cite", "q", "ruby", "rt", "rp", "bdi", "bdo", "font", "center",
    // Grouping, including the one element that carries behaviour of its own: `details` opens and
    // closes, which is markup plus a click, with nothing a document can reach through it.
    "details", "summary", "figure", "figcaption", "dl", "dt", "dd",
    "article", "section", "aside", "nav", "header", "footer", "main",
    // The box a GFM task list is rendered as (`marked` emits a disabled checkbox input).
    "input",
    // Media. A frame is fenced by the hook below rather than left to its own attributes.
    "picture", "video", "audio", "source", "iframe",
  ],
  ALLOWED_ATTR: [
    "href", "src", "alt", "title", "align", "valign",
    "width", "height", "colspan", "rowspan", "scope", "headers",
    "open", "summary", "start", "reversed", "type", "disabled", "checked",
    "controls", "poster", "preload", "loop", "muted", "playsinline",
    "datetime", "dir", "lang", "cite", "span", "color", "face", "size", "decoding",
    // Kept, but never verbatim: what lands in the DOM is whatever the two functions below
    // return for them.
    "style", "class",
  ],
  // `srcset` stays out because the asset rewriting in the preview only knows `src`; the handlers
  // are belt-and-braces over an allow-list that would not name them anyway.
  FORBID_ATTR: ["srcset", "onerror", "onload", "onclick"],
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
 * A second, narrower boundary for diagram SVG.
 *
 * The main allow-list cannot take SVG: it names none of its tags, and a diagram carries a
 * `<style>` element that only a diagram is allowed to carry. Diagram output does not come
 * from the document either — it comes from mermaid or from a local program — but it is still
 * generated from text the document supplied, so it gets its own pass with scripting and HTML
 * embedding forbidden outright.
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
export const SVG_SANITIZE = {
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

/**
 * The same profile for a drawing that came out of the document rather than out of a diagram tool.
 *
 * One thing less: `style`. Mermaid's own stylesheet is what colours its drawing, so the diagram
 * pass has to keep it; a `<style>` written by the document would apply to the whole preview
 * rather than to the picture, which is a way for a file to restyle the app around it. What is
 * left is the markup's own attributes — fills, strokes, gradients, transforms — so a hand-written
 * drawing still arrives, only without whatever a stylesheet block was doing for it.
 */
export const INLINE_SVG_SANITIZE = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [
    "script", "foreignObject", "iframe", "object", "embed", "style",
    "animate", "animateMotion", "animateTransform", "set", "handler",
  ],
  FORBID_ATTR: ["style", "onload", "onerror", "onclick", "onbegin", "onend", "onrepeat"],
};

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * The two attributes the allow-list cannot express as a yes/no.
 *
 * `class` and `style` are filtered per value here rather than by name, and this is the only
 * hook that can do it: `uponSanitizeAttribute` runs *before* the allow-list check. Note the
 * difference between the two ways of keeping an attribute — `forceKeepAttr` short-circuits the
 * check but leaves the value as the document wrote it, so it is only used where nothing is
 * rewritten; a rewritten value has to go the normal route, where DOMPurify reads `attrValue`
 * back out and writes it. (`afterSanitizeAttributes` would be too late: by then the attribute
 * is already gone or already kept, unmodified.)
 */
DOMPurify.addHook("uponSanitizeAttribute", (node, event) => {
  // Diagram SVG is outside both policies. Mermaid colours its shapes through `class` selectors
  // and inline `style` in the same embedded stylesheet, so stripping either left grey slabs with
  // no labels; and the document's own `<svg>` never reaches here at all — it is set aside before
  // this pass and comes back through the inline-SVG profile, which still forbids both.
  if (node.namespaceURI === SVG_NS) return;
  if (event.attrName === "style") {
    const kept = filterInlineStyle(event.attrValue);
    if (kept) event.attrValue = kept;
    else event.keepAttr = false;
    return;
  }
  if (event.attrName !== "class") return;
  // `closest` matches the element itself, so this covers `<code class="language-x">` as well as
  // the token spans inside it — the highlighter's classes are the app's own output and stay
  // verbatim, because `app.css` colours code through them.
  if ((node as Element).closest("pre > code")) {
    event.forceKeepAttr = true;
    return;
  }
  event.attrValue = scopeDocClasses(event.attrValue);
});

/**
 * The two tags that need more than a name on the allow-list.
 *
 * `afterSanitizeAttributes` is the point where an attribute can be *written* as well as kept:
 * what is set here goes in after the allow-list has run, so `sandbox` in particular is always
 * the one this app decided on, whatever the document asked for.
 */
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  const el = node as Element;
  if (el.tagName === "IFRAME") {
    const src = el.getAttribute("src") ?? "";
    // A frame is the one allowed tag that brings a whole second page in, so it gets the same
    // bargain `HtmlPreview` strikes for an `.html` file: the page runs its own scripts, in an
    // opaque origin where it cannot reach this document. Nothing local is offered — no path
    // here is ever rewritten into an asset URL, so an empty frame keeps the line intact instead
    // of showing a page that cannot load.
    el.setAttribute("src", /^https:\/\/\S/i.test(src) ? src : "about:blank");
    el.setAttribute("sandbox", "allow-scripts");
    el.setAttribute("loading", "lazy");
    el.setAttribute("referrerpolicy", "no-referrer");
    return;
  }
  if (el.tagName === "INPUT") {
    // Only the task-list box survives a document's spelling of some other control.
    if (el.getAttribute("type") !== "checkbox") el.setAttribute("type", "checkbox");
    el.setAttribute("disabled", "");
  }
});

/**
 * The parts of that policy that are pure string work, kept apart so they can be run and checked
 * without a DOM.
 */

/**
 * Inline `style` is allowed, one declaration at a time.
 *
 * The list is presentational on purpose: no `@font-face`, no `behavior`, nothing that names a
 * resource. Every value is additionally checked against `STYLE_VALUE_BANNED`, which is what
 * keeps `url()` out — and `url()` is the only way a property becomes a request the machine
 * did not ask for, whether as `background: url(http://x/collect?a=…)` or inside a gradient.
 */
const STYLE_PROPS = new Set([
  "color",
  "background",
  "background-color",
  "background-image",
  "background-size",
  "background-position",
  "background-repeat",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "font-stretch",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "white-space",
  "text-align",
  "text-align-last",
  "text-decoration",
  "text-decoration-line",
  "text-decoration-color",
  "text-decoration-style",
  "text-decoration-thickness",
  "text-indent",
  "text-transform",
  "text-overflow",
  "text-shadow",
  "vertical-align",
  "direction",
  "writing-mode",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-style",
  "border-width",
  "border-radius",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-left-radius",
  "border-bottom-right-radius",
  "border-collapse",
  "border-spacing",
  "outline",
  "outline-offset",
  "box-shadow",
  "box-sizing",
  "opacity",
  "visibility",
  "filter",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "aspect-ratio",
  "display",
  "flex",
  "flex-basis",
  "flex-direction",
  "flex-grow",
  "flex-shrink",
  "flex-wrap",
  "align-items",
  "align-self",
  "align-content",
  "justify-content",
  "justify-items",
  "place-items",
  "place-content",
  "gap",
  "row-gap",
  "column-gap",
  "order",
  "grid",
  "grid-template",
  "grid-template-columns",
  "grid-template-rows",
  "grid-template-areas",
  "grid-column",
  "grid-row",
  "grid-auto-flow",
  "float",
  "clear",
  "position",
  "top",
  "right",
  "bottom",
  "left",
  "inset",
  "z-index",
  "transform",
  "transform-origin",
  "transition",
  "cursor",
  "list-style",
  "list-style-type",
  "list-style-position",
  "object-fit",
  "object-position",
  "overflow",
  "overflow-x",
  "overflow-y",
  "table-layout",
  "caption-side",
  "tab-size",
  "user-select",
  "-webkit-line-clamp",
  "-webkit-box-orient",
]);

/** A value that names a resource, a script, or an engine hook. */
const STYLE_VALUE_BANNED = /url\s*\(|expression|javascript|behaviou?r|binding|@|\\|</i;

const POSITION_VALUES = /^(?:static|relative|absolute|sticky)$/i;

const MAX_STYLE_LENGTH = 4000;
const MAX_DECLARATIONS = 40;

/**
 * Keep the declarations this file may have meant, drop everything else.
 *
 * Shorthands stay because `border: 1px solid #999` is the common case; the cost is that a
 * shorthand carries a value we only pattern-match rather than parse. Splitting on `;` is safe
 * for the same reason: a semicolon inside a declaration value only ever appears in a quoted
 * string or a `url()`, and both are rejected above.
 */
export function filterInlineStyle(value: string): string {
  const source = value.trim();
  if (!source || source.length > MAX_STYLE_LENGTH) return "";
  const kept: string[] = [];
  for (const part of source.split(";")) {
    if (kept.length >= MAX_DECLARATIONS) break;
    const at = part.indexOf(":");
    if (at < 1) continue;
    const prop = part.slice(0, at).trim().toLowerCase();
    const declaration = part.slice(at + 1).trim();
    if (!declaration || STYLE_VALUE_BANNED.test(declaration)) continue;
    if (prop.startsWith("--")) {
      kept.push(`${prop}: ${declaration}`);
      continue;
    }
    if (!STYLE_PROPS.has(prop)) continue;
    // `position: fixed` is the one property that lets a document cover the app's own chrome.
    if (prop === "position" && !POSITION_VALUES.test(declaration)) continue;
    kept.push(`${prop}: ${declaration}`);
  }
  return kept.join("; ");
}

export const DOC_CLASS_PREFIX = "doc-";

/**
 * A document's class names are renamed rather than dropped.
 *
 * They cannot style anything on their own — a `<style>` block from the document is stripped —
 * so the only class names they could ever match are the app's own, which is exactly the
 * borrowing this prefix exists to stop.
 */
export function scopeDocClasses(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((name) => (name.startsWith(DOC_CLASS_PREFIX) ? name : DOC_CLASS_PREFIX + name))
    .join(" ");
}
