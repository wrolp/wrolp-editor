import { useEffect, useRef, useState, type MouseEvent } from "react";

/** How long the pointer has to rest before the bubble appears. */
const TIP_DELAY_MS = 500;

/**
 * How far the bubble starts from the pointer when it is anchored to the cursor.
 *
 * Wide enough that the pointer's own glyph — drawn from its hotspot to the right and down —
 * cannot sit on top of the bubble. The bubble also starts below the row, so the name it is
 * describing stays readable while it is being described.
 */
const POINTER_GAP = 18;

/** Roughly the tallest a two-line bubble gets; used only to decide whether it goes above. */
const TIP_HEIGHT = 60;

/** Where a bubble is drawn, in viewport coordinates. */
export interface TipSpot {
  x: number;
  y: number;
  /** Right-align the bubble to the cursor, for a pointer near the right edge. */
  alignEnd: boolean;
}

/**
 * Which point the bubble hangs from.
 *
 * `pointer` puts it beside the cursor and under the row, which is what a list of rows wants:
 * neither the pointer nor the bubble covers the name it is describing, and the space to the
 * right of the sidebar takes the overflow. `below` puts it directly under the hovered box, for
 * a strip where the cursor sits on a wide element and a bubble over the neighbouring items
 * would read as being about them.
 */
export type TipAnchor = "pointer" | "below";

/**
 * The hover state behind [`PathTip`]: where the bubble goes, and the two handlers that arm or
 * cancel it. Shared by the tree and the tab strip so the delay, the placement and the edge
 * handling cannot drift apart.
 *
 * `key` names whatever the bubble is currently for — a tab id, for the strip — so a component
 * that draws many hoverable things can keep one bubble and still know which one it describes.
 */
export function useHoverTip<K = undefined>(anchor: TipAnchor = "pointer") {
  const [tip, setTip] = useState<{ spot: TipSpot; key: K } | null>(null);
  const pending = useRef<number | undefined>(undefined);
  // A row can unmount while its bubble is still being waited for, when the folder holding it
  // is collapsed. The timer has to go with it rather than fire into a component that is gone.
  useEffect(() => () => window.clearTimeout(pending.current), []);

  const show = (event: MouseEvent<HTMLElement>, key?: K) => {
    // Measured here rather than inside the timeout: this is the last moment the row is
    // guaranteed to be under the pointer.
    const rect = event.currentTarget.getBoundingClientRect();
    const widest = 444; // the CSS max-width plus a little breathing room
    const alignEnd = event.clientX > window.innerWidth - widest;
    const at: TipSpot =
      anchor === "pointer"
        ? {
            // Beside the cursor, never under it. Near the right edge the bubble is mirrored
            // to its other side rather than pushed off the window.
            x: alignEnd ? event.clientX - 8 : event.clientX + POINTER_GAP,
            // Under the row rather than at the cursor's height: a bubble starting inside the
            // row would sit on the rest of the name. Above it only when the bottom of the
            // window is too close for a full bubble.
            y: rect.bottom + TIP_HEIGHT > window.innerHeight
              ? Math.max(8, rect.top - TIP_HEIGHT)
              : rect.bottom,
            alignEnd,
          }
        : { x: event.clientX, y: rect.bottom, alignEnd };
    window.clearTimeout(pending.current);
    pending.current = window.setTimeout(() => setTip({ spot: at, key: key as K }), TIP_DELAY_MS);
  };

  const hide = () => {
    // Cancels a bubble still on its way, which is the point of the delay: leaving early has
    // to mean never showing at all.
    window.clearTimeout(pending.current);
    setTip(null);
  };

  return { tip, show, hide };
}

/**
 * Two-line hover bubble: a name on top, the dimmed place it lives underneath.
 *
 * A native `title` attribute cannot do this — it renders one unstyled string in an OS-drawn
 * bubble, so the path would end up on the same line and could not be dimmed. Hence the
 * overlay. Where it hangs from is the anchor's business (`useHoverTip`): beside the cursor
 * for a tree row, under the tab for the strip. Nothing is drawn when there is no detail to
 * show, which keeps a tab with no place of its own (settings, an untitled buffer) from
 * getting an empty bubble.
 */
export default function PathTip({
  spot,
  name,
  detail,
}: {
  spot: TipSpot | null;
  name: string;
  detail: string;
}) {
  if (!spot || !detail) return null;
  return (
    <div
      className={`tree-tip${spot.alignEnd ? " align-end" : ""}`}
      style={{ left: spot.x, top: spot.y }}
      role="tooltip"
    >
      <span className="tree-tip-name">{name}</span>
      <span className="tree-tip-path">{detail}</span>
    </div>
  );
}
