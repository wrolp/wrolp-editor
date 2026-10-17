import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

/** Which edge is being dragged: width, height, or both. */
export type ResizeDir = "x" | "y" | "xy";

/** Smaller than this and the comparison says nothing: two columns of text plus their gutters. */
const MIN_WIDTH = 520;
const MIN_HEIGHT = 240;
/** Leave this much viewport at each edge, so a maximised dialog cannot swallow its own title bar. */
const EDGE_GAP = 16;

interface Size {
  width: number;
  height: number;
}

/**
 * Makes a dialog resizable by its edges and corners.
 *
 * The same shape as `useModalDrag`, for the same two reasons. The size is written straight to the
 * node and kept in a ref, because a resize fires a pointermove per frame and a re-render per frame
 * would re-measure the diff editor sitting inside the dialog. And the listeners go on `window`
 * rather than through pointer capture, so a drag that ends outside the dialog — or outside the
 * window — still stops cleanly instead of leaving the edge stuck to the pointer.
 */
export function useModalResize<T extends HTMLElement>(
  ref: RefObject<T | null>,
  /** While the dialog is maximised there is no size to drag: the viewport is the size. */
  disabled: boolean
) {
  const stop = useRef<(() => void) | null>(null);
  const disabledRef = useRef(disabled);
  disabledRef.current = disabled;

  useEffect(() => () => stop.current?.(), []);

  /** Put a size on the node, or take the inline size off so the stylesheet's own applies. */
  const apply = useCallback(
    (next: Size | null) => {
      const node = ref.current;
      if (!node) return;
      if (next) {
        node.style.width = `${next.width}px`;
        node.style.height = `${next.height}px`;
      } else {
        node.style.width = "";
        node.style.height = "";
      }
    },
    [ref]
  );

  const onPointerDown = useCallback(
    (dir: ResizeDir) => (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || disabledRef.current) return;
      const node = ref.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      const start = { width: rect.width, height: rect.height };
      const fromX = e.clientX;
      const fromY = e.clientY;
      // A maximised dialog has no size of its own, so the first drag un-maximises it by taking the
      // size it is drawn at — the alternative is a handle that appears to do nothing.
      apply(start);
      e.preventDefault();
      const move = (ev: PointerEvent) => {
        const width =
          dir === "y"
            ? start.width
            : Math.min(
                window.innerWidth - EDGE_GAP,
                Math.max(MIN_WIDTH, start.width + (ev.clientX - fromX))
              );
        const height =
          dir === "x"
            ? start.height
            : Math.min(
                window.innerHeight - EDGE_GAP,
                Math.max(MIN_HEIGHT, start.height + (ev.clientY - fromY))
              );
        apply({ width, height });
      };
      const stopResize = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", stopResize);
        window.removeEventListener("pointercancel", stopResize);
        window.removeEventListener("blur", stopResize);
        stop.current = null;
      };
      stop.current = stopResize;
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", stopResize);
      window.addEventListener("pointercancel", stopResize);
      window.addEventListener("blur", stopResize);
    },
    [apply, ref]
  );

  return {
    /** Give this the three handles: right edge, bottom edge, bottom-right corner. */
    handleProps: (dir: ResizeDir) => ({ onPointerDown: onPointerDown(dir) }),
    /**
     * Put a size on the dialog, or take the inline size off with `null` so the stylesheet's own
     * size shows through — which is what maximising needs, since an inline width would beat the
     * maximised rule.
     */
    apply,
  };
}
