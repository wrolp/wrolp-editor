import { useLayoutEffect, useState } from "react";

/** Gap kept between the menu and the window edge, in pixels. */
const EDGE_GAP = 8;

/**
 * Place a `fixed` menu at the pointer, inside the window.
 *
 * A menu opened near the bottom edge used to run past it: the rows below the edge were drawn
 * outside the window, so they could not be read or clicked. It is measured after render and
 * before paint, which is why the raw position is never seen; with no room below the pointer it
 * opens upward from it, and with no room to the right it is pulled back from the edge.
 *
 * `anchor` is the pointer position. A new object means a new anchor, so the menu is measured
 * again — its contents can change while it stays open (the tab menu swaps panels). The ref is
 * the caller's because those menus also use it to tell an inside click from an outside one.
 */
export function useMenuPlacement(
  anchor: { x: number; y: number } | null,
  ref: { current: HTMLDivElement | null }
): { left: number; top: number } {
  const [at, setAt] = useState({ left: 0, top: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!anchor || !el) return;
    const place = () => {
      const { width, height } = el.getBoundingClientRect();
      const left = Math.max(
        EDGE_GAP,
        Math.min(anchor.x, window.innerWidth - width - EDGE_GAP)
      );
      const top =
        anchor.y + height + EDGE_GAP <= window.innerHeight
          ? anchor.y
          : Math.max(EDGE_GAP, anchor.y - height);
      setAt((prev) => (prev.left === left && prev.top === top ? prev : { left, top }));
    };
    place();
    // Fonts, a panel swap or a language change can all alter the height after the first
    // measurement, and a taller menu is as capable of running off the edge as a new one.
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [anchor, ref]);

  return at;
}
