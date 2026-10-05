import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

/** Where the drag currently stands. A ref, not state: see `useModalDrag`. */
interface DragState {
  active: boolean;
  /** Pointer position where the drag started, in client coordinates. */
  fromX: number;
  fromY: number;
  /** Offset the dialog already had when the drag started. */
  baseX: number;
  baseY: number;
  /** Offsets that put a dialog edge on a viewport edge, measured at drag start. */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Elements that keep their own click rather than starting a drag. */
const INTERACTIVE = "button, a, input, select, textarea, [role='button']";

/**
 * Makes a dialog draggable by its title bar.
 *
 * Two decisions worth stating. The offset is written straight to the node and kept in a
 * ref instead of going through state, because a drag fires a pointermove per frame and a
 * re-render per frame would also re-render whatever the dialog holds — a settings form, a
 * draft list. And dragging is confined to the title: a dialog body can hold selectable
 * text, a `<select>`, a scrollable list and number inputs, so a drag starting there would
 * either select text or fight those controls.
 *
 * The move and release listeners go on `window` rather than through `setPointerCapture`.
 * Capture is the tidier API but the part most likely to fail quietly — a pointer id that
 * is no longer active throws — and once it does the dialog stops following the mouse the
 * moment the pointer leaves the title. Window listeners also cover a drag that ends outside
 * the window, which is what the `blur` listener is for.
 */
export function useModalDrag<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const offset = useRef({ x: 0, y: 0 });
  const drag = useRef<DragState>({
    active: false, fromX: 0, fromY: 0, baseX: 0, baseY: 0,
    minX: 0, maxX: 0, minY: 0, maxY: 0,
  });
  /** Ends the current drag, and tidies up if the dialog unmounts mid-gesture. */
  const stop = useRef<(() => void) | null>(null);

  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    // Middle and right buttons open context menus; they must not move the dialog.
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest(INTERACTIVE)) return;
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // The bounds below are in *offset* space, so they have to be derived from where the
    // dialog sits before any transform. Reading them off the live rect instead silently
    // skews every bound by the current offset — which is invisible on the first drag, when
    // the offset is still zero, and lets the dialog walk off screen on every one after it.
    const base = { x: offset.current.x, y: offset.current.y };
    const left = rect.left - base.x;
    const top = rect.top - base.y;
    // The overlay centres the dialog with flexbox, so that untransformed position is the
    // zero point. These four are the offsets that bring each edge to a viewport edge, which
    // is what keeps a dialog from being dragged somewhere it cannot be reached from.
    drag.current = {
      active: true,
      fromX: e.clientX,
      fromY: e.clientY,
      baseX: base.x,
      baseY: base.y,
      minX: -left,
      maxX: window.innerWidth - (left + rect.width),
      minY: -top,
      maxY: window.innerHeight - (top + rect.height),
    };
    el.dataset.dragging = "";
    e.preventDefault();
    const move = (ev: PointerEvent) => {
      const state = drag.current;
      const node = ref.current;
      if (!state.active || !node) return;
      const x = clamp(state.baseX + ev.clientX - state.fromX, state.minX, state.maxX);
      const y = clamp(state.baseY + ev.clientY - state.fromY, state.minY, state.maxY);
      offset.current = { x, y };
      node.style.transform = `translate(${x}px, ${y}px)`;
    };
    const stopDrag = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stopDrag);
      window.removeEventListener("pointercancel", stopDrag);
      window.removeEventListener("blur", stopDrag);
      if (ref.current) delete ref.current.dataset.dragging;
      drag.current.active = false;
      stop.current = null;
    };
    stop.current = stopDrag;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stopDrag);
    window.addEventListener("pointercancel", stopDrag);
    window.addEventListener("blur", stopDrag);
  }, []);

  return {
    /** Goes on the dialog element itself, the one that moves. */
    ref,
    /** Spread onto the title element. */
    handleProps: { onPointerDown },
  };
}

/**
 * Clamp into `[min, max]`, or pass the value through when the range is empty — which is
 * the normal case for a dialog taller than the window, where no offset can keep both top
 * and bottom on screen. Pinning to one end would make it jump as soon as the drag starts.
 */
function clamp(value: number, min: number, max: number): number {
  if (max < min) return value;
  return Math.min(max, Math.max(min, value));
}
