import { useLayoutEffect, useRef, type MouseEvent } from "react";
import { cutMiddle, type NameEllipsis } from "../lib/nameEllipsis";

interface Props {
  name: string;
  mode: NameEllipsis;
  /** The class the label is drawn with, e.g. the tree's `tn` or a tab's `tab-name`. */
  className?: string;
  /**
   * Keep the width the whole name would take while showing a cut one.
   *
   * A row does not need this: its width comes from the column around it. A tab is sized by its
   * content, so replacing the text in place narrows the tab, and the next measurement cuts a
   * little more — measured in the repro, a long name lost a character per frame and ended on a
   * bare ellipsis. The hidden copy stays in flow to hold the width, and the cut text is drawn
   * over it.
   */
  pinned?: boolean;
  /**
   * Put the whole name in a native tooltip while it is cut. Opt-in: rows that already hang a
   * hover bubble of their own (the Explorer, the tab strip) would otherwise show two.
   *
   * A middle cut knows when it cut — it did the cutting — so its title is written with the
   * text. An end cut is the browser's, and whether it cut is only known from the laid-out
   * widths; that is asked at hover, so a list pays for the answer one row at a time instead of
   * measuring every row as it is drawn.
   */
  tooltip?: boolean;
}

/** One label waiting for its cut. */
interface Fit {
  /** The element whose width the text is measured against. */
  box: HTMLSpanElement;
  /** Where the cut goes: the box itself, or the copy drawn over a pinned ghost. */
  target: HTMLSpanElement;
  name: string;
  /** A pinned label is sized by its whole name, so its cut may use every pixel of it. */
  exact: boolean;
  tooltip: boolean;
}

/**
 * The labels waiting to be fitted, and whether a flush is already booked.
 *
 * A label works out its width and then writes the cut text into itself, and that write
 * invalidates the layout the next label's measurement needs. Done row by row, a few thousand
 * changed paths laid the whole document out once per path — which is why switching to a
 * repository with many untracked files stopped the window. Queued, every width is read before
 * any text is written, so one layout answers the whole list; the cuts themselves are measured on
 * a canvas, which forces no layout at all.
 */
let pending: Fit[] = [];
let booked = false;

function queueFit(fit: Fit) {
  pending.push(fit);
  if (booked) return;
  booked = true;
  // A microtask rather than a frame: the queue is filled by layout effects, which run before the
  // commit is painted, so a name is cut the first time its row is on screen.
  queueMicrotask(flushFits);
}

function flushFits() {
  booked = false;
  const jobs = pending;
  pending = [];
  // Read: every width, with no write in between.
  const widths = new Array<number>(jobs.length);
  for (let i = 0; i < jobs.length; i += 1) {
    const { box } = jobs[i];
    widths[i] = box.isConnected ? box.getBoundingClientRect().width : 0;
  }
  // Write: the cuts. A width of 0 is a row outside the viewport and skipped
  // (`content-visibility`), and cutting those down to the ellipsis would be worse than the full
  // name; a row that has since gone has nothing to write into.
  for (let i = 0; i < jobs.length; i += 1) {
    const { box, target, name, exact, tooltip } = jobs[i];
    if (!box.isConnected) continue;
    const width = widths[i];
    // A pinned label is sized by its whole name, so the box already holds the text and only a
    // flex squeeze overflows it. Ask the layout rather than the canvas: at some DPIs the two
    // disagree by a pixel, and that disagreement used to cut a name that was fully on screen —
    // the box kept its width for the whole name, the cut copy silently got shorter.
    if (exact && width > 1 && box.scrollWidth <= Math.ceil(width) + 1) {
      if (target.textContent !== name) target.textContent = name;
      if (tooltip && box.title) box.title = "";
      continue;
    }
    // A row keeps a pixel so its own cut never touches the edge; a pinned tab is already sized
    // by the whole name, and taking one away there would cut a name that fits.
    const next = width > 1 ? cutMiddle(box, name, exact ? width : width - 1) : name;
    if (target.textContent !== next) target.textContent = next;
    // The title goes on the box rather than the cut text, so a pinned label is covered as well.
    // It is only there while something is missing from the name on screen.
    const hint = tooltip && next !== name ? name : "";
    if (box.title !== hint) box.title = hint;
  }
}

/**
 * A name, shortened in the middle or at the end, measured against the space it is given.
 *
 * What to cut is never state: the text is written straight to the node, because a cut is not a
 * new value the app has to render — an observer callback that set state would repaint the whole
 * row a frame later, for a name that was already on screen.
 */
export default function NameText({ name, mode, className, pinned = false, tooltip = false }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const cutRef = useRef<HTMLSpanElement>(null);
  // Only a middle cut needs the pinned layout: `end` is what `text-overflow` already does.
  const ghost = pinned && mode === "middle";

  useLayoutEffect(() => {
    // `end` is the stylesheet's own `text-overflow`: the name is written out whole and the
    // browser draws the ellipsis. There is nothing to measure, and nothing to watch.
    if (mode !== "middle") return;
    const box = boxRef.current;
    if (!box) return;
    // A row writes into the node it measures; a pinned tab measures the wrapper — sized by the
    // hidden copy — and writes into the copy drawn over it.
    const target = ghost ? cutRef.current : box;
    if (!target) return;
    const fit: Fit = { box, target, name, exact: ghost, tooltip };
    queueFit(fit);
    // A row's width can move without its name changing: the sidebar is resized, a sibling label
    // is cut, the window is widened.
    const observer = new ResizeObserver(() => queueFit(fit));
    observer.observe(box);
    return () => observer.disconnect();
  }, [name, mode, ghost, tooltip]);

  // The whole name, for the browser's ellipsis case only: an end cut leaves the text in place,
  // so `scrollWidth` against `clientWidth` is what says whether anything is hidden.
  const hintOnHover = (e: MouseEvent<HTMLSpanElement>) => {
    const el = e.currentTarget;
    const hint = el.scrollWidth > el.clientWidth ? name : "";
    if (el.title !== hint) el.title = hint;
  };

  return (
    <span
      ref={boxRef}
      className={className ? `${className}${ghost ? " pinned" : ""}` : undefined}
      // Only the end cut needs this: a middle cut already wrote its own title while fitting.
      onMouseEnter={tooltip && mode === "end" ? hintOnHover : undefined}
    >
      {ghost ? (
        <>
          {/* What the tab would be wide without any cutting, kept out of sight. */}
          <span className="name-ghost" aria-hidden="true">
            {name}
          </span>
          <span className="name-cut" ref={cutRef} />
        </>
      ) : (
        name
      )}
    </span>
  );
}
