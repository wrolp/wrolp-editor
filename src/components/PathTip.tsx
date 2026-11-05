import { useEffect, useRef, useState, type MouseEvent } from "react";

/** How long the pointer has to rest before the bubble appears. */
const TIP_DELAY_MS = 500;

/** Where a bubble is drawn, in viewport coordinates. */
export interface TipSpot {
  x: number;
  y: number;
  /** Right-align the bubble to the cursor, for a pointer near the right edge. */
  alignEnd: boolean;
}

/**
 * The hover state behind [`PathTip`]: where the bubble goes, and the two handlers that arm or
 * cancel it. Shared by the tree and the tab strip so the delay, the placement below the thing
 * being pointed at and the edge handling cannot drift apart.
 *
 * `key` names whatever the bubble is currently for — a tab id, for the strip — so a component
 * that draws many hoverable things can keep one bubble and still know which one it describes.
 */
export function useHoverTip<K = undefined>() {
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
    const at = {
      x: event.clientX,
      y: rect.bottom,
      alignEnd: event.clientX > window.innerWidth - widest,
    };
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
 * overlay. It sits below the thing being pointed at: a bubble above the cursor covers the very
 * item it describes. Nothing is drawn when there is no detail to show, which is what keeps a
 * tab with no place of its own (a settings page, an untitled buffer) from getting an empty one.
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
