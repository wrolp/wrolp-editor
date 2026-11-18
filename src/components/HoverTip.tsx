import { useLayoutEffect, useRef } from "react";

/** Where a bubble is drawn, in viewport coordinates. */
export interface TipSpot {
  x: number;
  y: number;
  /** Right-align the bubble to the cursor, for a pointer near the right edge. */
  alignEnd: boolean;
}

/**
 * One hover bubble, drawn at a spot the caller has already chosen.
 *
 * The bubble is nobody's private tooltip: the whole app shares `GlobalTip`, which reads a
 * hovered element's `data-tip` / `data-tip-detail` (or the `title` a native bubble would have
 * drawn) and places the answer here. A name on the first line and a dimmed place or detail
 * underneath is the shape a row and a tab need; a single-line hint is the same bubble with
 * only the first line.
 */
export default function HoverTip({
  spot,
  name,
  detail,
}: {
  spot: TipSpot | null;
  name: string;
  detail: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  /**
   * A wrapped path makes the bubble taller than the two-line estimate its anchor placed it
   * with, so the bottom is measured once and pulled back inside the window when it does not
   * fit. Written straight to the node: this is a correction of one placement, not state the
   * next render would need.
   */
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !spot) return;
    el.style.left = `${spot.x}px`;
    el.style.top = `${spot.y}px`;
    const rect = el.getBoundingClientRect();
    // Below the row unless that would run past the bottom; mirrored to the cursor's left near
    // the right edge, which can in turn overhang the left one.
    const below = rect.bottom - (window.innerHeight - 8);
    if (below > 0) el.style.top = `${Math.max(8, spot.y - below)}px`;
    const left = 8 - rect.left;
    if (left > 0) el.style.left = `${spot.x + left}px`;
  }, [spot, name, detail]);

  if (!spot || (!name && !detail)) return null;
  return (
    <div
      ref={ref}
      className={`hover-tip${spot.alignEnd ? " align-end" : ""}`}
      style={{ left: spot.x, top: spot.y }}
      role="tooltip"
    >
      {name && <span className="hover-tip-name">{name}</span>}
      {detail && <span className="hover-tip-path">{detail}</span>}
    </div>
  );
}
