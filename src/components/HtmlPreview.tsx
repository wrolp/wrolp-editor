import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";

interface Props {
  /** The buffer. The document is rendered from this, not read off disk, so unsaved edits show. */
  text: string;
  /** The document's own path: what its relative URLs resolve against. */
  path: string;
  /** Fraction 0..1 of the editor's scroll position, so the two panes can track. */
  scrollRatio: number;
  /** Let the page scroll past its end, so the last line can sit above the bottom edge. */
  beyondEnd: boolean;
  /** Called when the page scrolls, to drive the editor instead. */
  onScrollRatio: (ratio: number) => void;
}

/**
 * Every frame the document posts carries this, and the parent only trusts a message that
 * carries it back. A sandboxed frame has an opaque origin, which means `event.origin` is
 * `null` and so cannot authenticate anything — there is nothing to check it against. The
 * token stands in for that: it is minted per mount, handed to the frame in its source, and
 * never appears anywhere the page could read it out of its own DOM.
 */
type FrameMessage =
  | { t: "wrolp:ready" }
  | { t: "wrolp:ratio"; ratio: number; token: string };

/** Parent to frame. Distinct names from the frame's own so neither can be confused. */
type HostMessage = { t: "wrolp:scroll"; ratio: number } | { t: "wrolp:tail"; px: number };

/**
 * The file's own URL, in the one form that makes relative URLs resolve.
 *
 * `convertFileSrc` cannot be used directly. It percent-encodes a whole Windows path into a
 * *single* URL segment (`C%3A%5Crepro%5Cpage.html`), and the backend decodes the entire path
 * at once (`asset.rs`: `percent_decode(path[1..])`) — so a browser sees one segment, works
 * out that the directory is `/`, and resolves `css/style.css` to `asset://localhost/css/style.css`,
 * with the folder dropped. It also encodes a second time if handed an already-encoded path,
 * which is how the separators come out as `%2F` and the directory is lost a second time.
 *
 * So its scheme and host are borrowed and the path is appended here, segmented and encoded
 * one part at a time: the directory becomes `/C:/repro/` and a relative URL lands where it
 * should, decoding back to the `C:/repro/css/style.css` the backend wants. Each segment is
 * encoded separately because a directory holding `#`, `?` or a space would otherwise be cut
 * short or rejected by the URL parser.
 */
function documentUrl(path: string): string {
  const encoded = path.replace(/\\/g, "/").split("/").map(encodeURIComponent).join("/");
  // Derived from the real helper rather than hardcoded, so the scheme stays right on every
  // platform and if Tauri ever changes it.
  const probe = convertFileSrc("p");
  return probe.slice(0, probe.lastIndexOf("/") + 1) + encoded;
}

/**
 * Runs inside the frame, before anything the document itself contains.
 *
 * Tauri's injected globals are removed here, and that is not belt-and-braces: wry states
 * that on Windows "scripts are always added to subframes regardless of the
 * `for_main_frame_only` option" (wry `lib.rs`), so `__TAURI_INTERNALS__` — `invoke`,
 * `convertFileSrc`, the event system — is present inside this frame too. The sandbox stops
 * the page reaching the *parent document* and stops its IPC from being accepted (an opaque
 * origin sends `Origin: null`, which the IPC layer rejects before dispatching, and the
 * frame's own URL is not a local one, which trips the remote-origin guard). Capabilities,
 * though, are granted per window rather than per frame, so those two gates are the only
 * things standing between a local HTML file and this window's permissions. Taking the bridge
 * away as well means a page cannot reach it even if they regress.
 *
 * Both forms are attempted because Tauri's `Object.defineProperty` calls carry no
 * `configurable: true`, which may make the `delete` fail; assigning `undefined` afterwards
 * covers that case.
 */
const HARDENING = `<script>(function(){
  var names = ["__TAURI_INTERNALS__", "__TAURI__", "ipc", "webkit", "chrome"];
  for (var i = 0; i < names.length; i++) {
    try { delete window[names[i]]; } catch (e) {}
    try { window[names[i]] = undefined; } catch (e) {}
  }
})();</script>`;

/**
 * How long after this page reports a position of its own the echo of it is ignored. Long
 * enough to cover the report → React state → message round trip, short enough that a
 * deliberate scroll of the editor is not swallowed.
 */
const ECHO_MS = 300;

/**
 * The scroll bridge. It exists because the frame is sandboxed *without* `allow-same-origin`,
 * so the parent cannot read `contentDocument` and the two panes cannot track each other the
 * way the markdown preview does directly.
 *
 * The bridge stays quiet for a moment after it is told where to go, the same guard the
 * markdown preview uses and for the same reason: without it the page's own scroll would be
 * echoed back and the two would nudge each other forever.
 */
function bridge(token: string): string {
  return `<script>(function(){
  var TOKEN = ${JSON.stringify(token)};
  // A position we were told to take is not one the reader chose. Reporting it back would
  // drive the editor from our own write, and that echo would return as another write — the
  // page then fights the wheel. A window rather than one animation frame: the scroll event
  // this assignment produces can be dispatched after the frame callback that would have
  // cleared a flag.
  var silentUntil = 0;
  function max() {
    var d = document.scrollingElement || document.documentElement;
    return Math.max(0, d.scrollHeight - d.clientHeight);
  }
  function report() {
    if (Date.now() < silentUntil) return;
    var m = max();
    parent.postMessage({ t: "wrolp:ratio", ratio: m > 0 ? document.scrollingElement.scrollTop / m : 0, token: TOKEN }, "*");
  }
  addEventListener("scroll", report, { passive: true });
  addEventListener("message", function(e) {
    var d = e.data;
    if (!d) return;
    if (d.t === "wrolp:scroll") {
      var m = max();
      silentUntil = Date.now() + 120;
      (document.scrollingElement || document.documentElement).scrollTop = m * d.ratio;
    } else if (d.t === "wrolp:tail") {
      var el = document.getElementById("wrolp-tail");
      if (!el) { el = document.createElement("div"); el.id = "wrolp-tail"; document.body.appendChild(el); }
      el.style.height = Math.max(0, d.px) + "px";
    }
  });
  parent.postMessage({ t: "wrolp:ready", token: TOKEN }, "*");
  report();
})();</script>`;
}

/**
 * Builds the document source.
 *
 * The order is the security property, not a style choice: the hardening script has to be
 * parsed and run before any script the page contains, and the `<base>` has to precede the
 * page's own markup for its relative URLs to resolve against the right place.
 *
 * Where those go depends on what the file already has. A real `.html` file opens with its own
 * doctype and `<html>`, and prepending a second document makes the parser discard the author's
 * structure — so the pieces are injected into the head it already has. That branch has to
 * carry the bridge too, not just the hardening: an earlier version injected only the hardening
 * there, and every full document silently came up with no scroll sync at all.
 *
 * A `<base>` the document declares itself is superseded, deliberately. Only the first one in
 * tree order applies, and ours is first, which is what makes a relative URL mean "next to this
 * file" rather than whatever the page last decided it meant.
 */
function buildSource(html: string, path: string, token: string): string {
  const injected = `<base href="${documentUrl(path)}">` + HARDENING + bridge(token);
  const headOpen = /<head(\s[^>]*)?>/i.exec(html);
  if (headOpen) {
    return html.slice(0, headOpen.index + headOpen[0].length) + injected + html.slice(headOpen.index + headOpen[0].length);
  }
  const htmlOpen = /<html(\s[^>]*)?>/i.exec(html);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    // No head of its own: give it one, so the pieces have a home that parses.
    return html.slice(0, at) + `<head>${injected}</head>` + html.slice(at);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${injected}</head><body>${html}</body></html>`;
}

/**
 * Renders an HTML file the way a browser would, next to its source.
 *
 * An iframe rather than sanitized markup injected into our own document, because the point
 * of previewing HTML is the stylesheet and the layout, and neither survives that: the
 * allow-list that keeps markdown safe strips `<style>` and inline `style` outright. The
 * frame is sandboxed with `allow-scripts` and nothing else — the page runs its own
 * JavaScript, but in an opaque origin where it cannot reach this document, cannot navigate
 * us, and cannot submit forms or open windows.
 */
export default function HtmlPreview({ text, path, scrollRatio, beyondEnd, onScrollRatio }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  /** Minted per mount; see `FrameMessage`. */
  const token = useMemo(() => Math.random().toString(36).slice(2) + Date.now().toString(36), []);
  /** Set once the frame says it is listening, so a ratio from before then is not lost. */
  const [ready, setReady] = useState(false);
  /**
   * Which document the frame is showing. Every new `srcDoc` reloads it, and the bridge in the
   * fresh page reports its position immediately — a zero that used to arrive while the reader
   * was typing and scroll the editor back to the top of the document. A ratio is only trusted
   * once the new page has said it is ready and its single opening report has been discarded.
   */
  const generation = useRef(0);
  const readyRef = useRef(false);
  const readyFor = useRef(-1);
  const skipRatios = useRef(0);
  /**
   * When this page last reported a position of its own.
   *
   * A push that follows a report is the echo of a scroll the page made itself. The report
   * travels through React and comes back as a `wrolp:scroll` message, and by the time that
   * message lands the wheel has usually moved again — writing the older position back drags
   * the page backwards a few pixels on every tick, which reads as the page shaking under the
   * hand. A time window is what covers the round trip; a one-frame flag does not, because the
   * scroll event that a programmatic write produces can be dispatched after that frame.
   */
  const lastReport = useRef(0);

  const source = useMemo(() => buildSource(text, path, token), [text, path, token]);

  /**
   * A new `srcDoc` means a new document, and that document will announce itself and then
   * report the position it starts at. That opening report is not where the reader is, and
   * accepting it dragged the editor to the top of the file a moment after every reload —
   * which, while typing, looked like the view jumping under the caret.
   */
  useEffect(() => {
    generation.current += 1;
    readyRef.current = false;
    skipRatios.current = 0;
    setReady(false);
  }, [source]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // Only this frame, and only with the token it was given: an opaque origin gives us
      // nothing to check an origin against, and any document that ends up in this frame can
      // post whatever it likes.
      if (e.source !== frameRef.current?.contentWindow) return;
      const data = e.data as FrameMessage | null;
      if (!data || typeof data !== "object" || (data as FrameMessage & { token?: string }).token !== token) {
        return;
      }
      if (data.t === "wrolp:ready") {
        // The page that is now listening belongs to the document just loaded. Its one
        // opening report is dropped; a ratio after that is a scroll someone made.
        readyRef.current = true;
        readyFor.current = generation.current;
        skipRatios.current = 1;
        setReady(true);
        return;
      }
      if (data.t !== "wrolp:ratio") return;
      // A report from a document that has been replaced, or from one that never announced
      // itself, describes a page that is no longer on screen.
      if (!readyRef.current || readyFor.current !== generation.current) return;
      if (skipRatios.current > 0) {
        skipRatios.current -= 1;
        return;
      }
      lastReport.current = performance.now();
      onScrollRatio(data.ratio);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [token, onScrollRatio]);

  /** Push the editor's position into the page; the caller decides when that is right. */
  const post = useCallback(
    (message: HostMessage) => frameRef.current?.contentWindow?.postMessage(message, "*"),
    []
  );

  /**
   * Keyed on `ready` as well as the ratio, so the first push happens once the frame is
   * listening. A ref would not do: it changes without re-rendering, and an effect that had
   * already run would never run again, leaving the page wherever it started.
   */
  useEffect(() => {
    if (!ready) return;
    // A page that just reported its own position is already there: sending it back is what
    // makes the two panes chase each other. Only a move that came from somewhere else —
    // the editor — is worth pushing.
    if (performance.now() - lastReport.current < ECHO_MS) return;
    post({ t: "wrolp:scroll", ratio: scrollRatio });
  }, [ready, scrollRatio, post]);

  /**
   * `scrollBeyondLastLine`'s other half, inside the frame. Monaco's slack is the viewport
   * height minus where its content ends, which cannot be computed for someone else's
   * document from out here — the bridge owns the measurement, and this only asks for a size.
   */
  useEffect(() => {
    if (!ready || !beyondEnd) return;
    post({ t: "wrolp:tail", px: tailHeight });
  }, [ready, beyondEnd, post]);

  return (
    <div className="html-preview">
      <iframe ref={frameRef} sandbox="allow-scripts" srcDoc={source} title={path} />
    </div>
  );
}

/**
 * Slack appended to the page so its last line can sit above the bottom edge instead of
 * being glued to it. Measured rather than derived for the reason the markdown preview
 * documents at length: the space is not a constant, because it depends on what the document
 * ends with. There is no frame access here to measure it from, so this is the compromise —
 * a fixed band, which errs only for pages whose content ends flush with the viewport.
 */
const tailHeight = 80;