import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { TabIcon } from "./FileIcon";
import type { Tab } from "../lib/types";

interface Props {
  tabs: Tab[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
  /** Drop a dragged tab at this position in the strip. */
  onReorder: (id: number, toIndex: number) => void;
}

/** How far the pointer must travel before a press counts as a drag rather than a click. */
const DRAG_THRESHOLD = 4;

/**
 * Width of the strip's edge that starts scrolling, and the fastest a frame may move it.
 * The step is what makes a long strip usable: a strip several thousand pixels wide has to
 * reach its far end in a second or two of holding at the edge, not five. Slow enough to
 * land on a gap rather than past it — at 26px a frame the strip ran a tab per frame, which
 * made the drop impossible to place on anything you had actually looked at.
 */
const EDGE_ZONE = 44;
const MAX_SCROLL_STEP = 9;

export default function TabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
  onContextMenu,
  onReorder,
}: Props) {
  const barRef = useRef<HTMLDivElement>(null);
  /**
   * Drag state for reordering. The strip is not rearranged while the pointer moves: doing
   * that changes which tab sits under the cursor mid-gesture, so the strip keeps swapping
   * back and forth. Instead the drop position is tracked as an index and shown as a line,
   * and the move is committed once, on release.
   */
  const [drag, setDrag] = useState<{ id: number; x: number; index: number } | null>(null);
  /**
   * Press before the threshold is crossed: the id, the x it started at, and whether it
   * landed on the × — which decides what releasing does. Selection is settled here rather
   * than by `onClick`, because the press captures the pointer and a captured gesture never
   * delivers a `click` to the tab.
   */
  const pending = useRef<{ id: number; x: number; close: boolean } | null>(null);
  /**
   * Auto-scroll while dragging. Tabs hidden past either end are otherwise unreachable: the
   * strip only scrolls on a wheel over it, and the gesture already owns the pointer.
   */
  const pointerX = useRef(0);
  const scrollDir = useRef(0);
  const scrollStep = useRef(0);
  const raf = useRef<number | null>(null);
  /**
   * Whether a drag gesture is in progress, kept beside the pointer rather than read off
   * `drag`. The frame loop's first tick can land before React has committed the `setDrag`
   * that `beginDrag` issued — a pointermove is a continuous-priority update, so the
   * re-render is scheduled, not synchronous — and a loop that reads "no drag yet" as "the
   * gesture is over" stops for good, because `beginDrag` is the only thing that starts it
   * again. Whether a gesture is alive is a fact about the gesture, so it is recorded in the
   * same tick that starts it instead of being inferred from the render that produces.
   */
  const gesture = useRef(false);

  useEffect(() => {
    const active = barRef.current?.querySelector(".tab.active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  // The frame loop outlives the gesture if the component goes first.
  useEffect(() => stopAutoScroll, []);

  /**
   * Where a drop at `clientX` would land: the index it falls before, and the x to draw the
   * marker at. Comparing against each tab's midpoint rather than its edges is what makes the
   * two halves of a tab mean different things — pass its middle and you are dropping after
   * it, not before.
   */
  const dropAt = (clientX: number): { index: number; x: number } => {
    const boxes = Array.from(barRef.current?.querySelectorAll<HTMLElement>(".tab") ?? []);
    for (let i = 0; i < boxes.length; i++) {
      const rect = boxes[i].getBoundingClientRect();
      if (clientX < rect.left + rect.width / 2) return { index: i, x: rect.left };
    }
    const last = boxes[boxes.length - 1]?.getBoundingClientRect();
    return last
      ? { index: boxes.length, x: last.right }
      : { index: 0, x: barRef.current?.getBoundingClientRect().left ?? 0 };
  };

  /** Whether the pointer is near an end of the strip, and how fast to scroll if it is. */
  const edgeScroll = (clientX: number) => {
    const bar = barRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const room = bar.scrollWidth - bar.clientWidth;
    const zone = Math.min(EDGE_ZONE, rect.width / 4);
    if (room <= 0) {
      scrollDir.current = 0;
      return;
    }
    if (clientX < rect.left + zone && bar.scrollLeft > 0) {
      scrollDir.current = -1;
      scrollStep.current = MAX_SCROLL_STEP * Math.min(1, (rect.left + zone - clientX) / zone);
    } else if (clientX > rect.right - zone && bar.scrollLeft < room) {
      scrollDir.current = 1;
      scrollStep.current = MAX_SCROLL_STEP * Math.min(1, (clientX - (rect.right - zone)) / zone);
    } else {
      scrollDir.current = 0;
    }
  };

  const stopAutoScroll = () => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    raf.current = null;
    scrollDir.current = 0;
  };

  const autoScroll = () => {
    const bar = barRef.current;
    if (!bar || !gesture.current) {
      stopAutoScroll();
      return;
    }
    // The loop owns the scrolling, so it owns the decision too: reading the direction here
    // from the last known pointer x means a move that never reached the strip cannot leave
    // it pointing the wrong way, or keep it pointing at an edge the pointer has left.
    edgeScroll(pointerX.current);
    const dir = scrollDir.current;
    const room = bar.scrollWidth - bar.clientWidth;
    if (dir !== 0 && room > 0) {
      const next = Math.max(0, Math.min(room, bar.scrollLeft + dir * scrollStep.current));
      if (next !== bar.scrollLeft) {
        bar.scrollLeft = next;
        // The strip moved under a pointer that did not, so the gap it points into can change
        // without any pointer event — the marker has to be recomputed from the last known x.
        const spot = dropAt(pointerX.current);
        setDrag((d) => (d && (d.x !== spot.x || d.index !== spot.index) ? { ...d, x: spot.x, index: spot.index } : d));
        if (dir < 0 ? next <= 0 : next >= room) scrollDir.current = 0;
      }
    }
    raf.current = requestAnimationFrame(autoScroll);
  };

  const beginDrag = (id: number, x: number) => {
    const spot = dropAt(x);
    gesture.current = true;
    setDrag({ id, x: spot.x, index: spot.index });
    pointerX.current = x;
    // Only worth a frame loop when there is somewhere to scroll to.
    if (barRef.current && barRef.current.scrollWidth > barRef.current.clientWidth) {
      raf.current = requestAnimationFrame(autoScroll);
    }
  };

  /** The two gaps on either side of the dragged tab both mean "leave it alone". */
  const dropIsNoop = (d: { id: number; index: number }) => {
    const from = tabs.findIndex((t) => t.id === d.id);
    return from === d.index || from === d.index - 1;
  };

  const endDrag = () => {
    if (drag && !dropIsNoop(drag)) onReorder(drag.id, drag.index);
    gesture.current = false;
    setDrag(null);
    pending.current = null;
    stopAutoScroll();
  };


  /**
   * Viewport x to an offset inside the strip. The sign is the thing to get right: an
   * absolutely positioned child of a scrolled box is placed against the *content* origin,
   * which has itself moved to `-scrollLeft` in the viewport. So the offset that lands the
   * marker on a given pixel is the distance from the strip's left edge *plus* how far it is
   * scrolled — subtracting it puts the marker that far to the left of the tab it points at.
   */
  const dropOffset = (clientX: number) => {
    const bar = barRef.current;
    return bar ? clientX - bar.getBoundingClientRect().left + bar.scrollLeft : 0;
  };

  if (tabs.length === 0) {
    return (
      <div className="tabbar" ref={barRef} data-tauri-drag-region>
        <div className="tab empty" data-tauri-drag-region="false">
          {t("tab.empty")}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`tabbar${drag ? " dragging" : ""}`}
      ref={barRef}
      data-tauri-drag-region
      onWheel={(e) => {
        const bar = e.currentTarget;
        const max = bar.scrollWidth - bar.clientWidth;
        if (max <= 0 || e.deltaY === 0) return;
        bar.scrollLeft = Math.max(0, Math.min(max, bar.scrollLeft + e.deltaY));
      }}
      onPointerDown={(e) => {
        const el = (e.target as HTMLElement).closest?.(".tab") as HTMLElement | null;
        if (!el || el.classList.contains("empty")) return;
        const id = Number(el.getAttribute("data-id"));
        if (Number.isNaN(id)) return;
        if (e.button === 2) {
          // Open on the right-button press rather than on `contextmenu`. Same gesture, but
          // `contextmenu` is passive and fires late, so anything that swallows it (a drag
          // region, an embedded webview, a future overlay) leaves no fallback at all. The
          // `contextmenu` handler below stays solely to suppress the native menu.
          onContextMenu(id, e.clientX, e.clientY);
          return;
        }
        if (e.button !== 0) return;
        // A press is only a candidate: it becomes a drag once the pointer has actually
        // moved, so a plain click still selects.
        pending.current = {
          id,
          x: e.clientX,
          close: !!(e.target as HTMLElement).closest?.(".tab-close"),
        };
        // Captured on the press, not once the drag is recognised. Reaching either end of the
        // strip means leaving its box, and a `pointermove` that never passes through the
        // strip is a gesture the strip never hears about — the drag would never start, and
        // with it the auto-scroll that reveals the tabs past the end. Capture also delivers
        // moves that leave the window entirely, which is what keeps the edge scroll honest.
        // The price is that `click` is retargeted to the strip, so `onPointerUp` below
        // decides what the press meant.
        e.currentTarget.setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        pointerX.current = e.clientX;
        if (pending.current && Math.abs(e.clientX - pending.current.x) > DRAG_THRESHOLD) {
          beginDrag(pending.current.id, e.clientX);
          pending.current = null;
          return;
        }
        if (!drag) return;
        // No `edgeScroll` here: the frame loop reads the pointer itself, and one owner for
        // the direction is one fewer thing that can go stale mid-gesture.
        const spot = dropAt(e.clientX);
        if (spot.index !== drag.index || spot.x !== drag.x) {
          setDrag({ ...drag, x: spot.x, index: spot.index });
        }
      }}
      onPointerUp={(e) => {
        const press = pending.current;
        pending.current = null;
        if (drag) endDrag();
        // A press that never became a drag is a click, and the capture means no `click` is
        // coming. Deciding here is also what keeps the × from selecting the tab it closes.
        else if (press) {
          if (press.close) onClose(press.id);
          else onSelect(press.id);
        }
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      }}
      onPointerCancel={() => {
        // Cancelled rather than dropped: leave the order alone.
        gesture.current = false;
        setDrag(null);
        pending.current = null;
        stopAutoScroll();
      }}
      onContextMenu={(e) => {
        // Only swallow the native menu when it was aimed at a tab; the empty strip
        // should still get the usual browser menu.
        const el = (e.target as HTMLElement).closest?.(".tab") as HTMLElement | null;
        if (!el || el.classList.contains("empty")) return;
        e.preventDefault();
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-id={tab.id}
          // Not a drag region: Tauri's drag.js only drags on a bare attribute hit by the
          // event target, and a tab is always a descendant. Marking it false states the
          // intent and keeps it that way if the strip ever becomes "deep".
          data-tauri-drag-region="false"
          className={`tab${tab.id === activeId ? " active" : ""}${
            drag?.id === tab.id ? " dragging" : ""
          }`}
          title={
            tab.compare
              ? `${tab.compare.left.path}\n↔\n${tab.compare.right.path}`
              : tab.isSettings
                ? t("tab.settings")
                : tab.path
          }
        >
          <TabIcon tab={tab} />
          <span className="tab-name">{tab.name}</span>
          {tab.dirty && !tab.isSettings && <span className="tab-dirty">U</span>}
          {/* A real button, so it is reachable and closable from the keyboard: a press takes
              the pointer, which sends its `click` to the strip and lets `onPointerUp` do the
              closing, but a key-generated click still lands here. */}
          <button className="tab-close" title={t("tab.close")} onClick={() => onClose(tab.id)}>
            ×
          </button>
        </div>
      ))}

      {/* Where the dragged tab would land. The offset is into the strip's *content*, not the
          viewport — see `dropOffset`. Hidden when the gap is the tab's own: the two gaps
          around it both mean "leave it where it is", and a line drawn there would only
          flicker as the pointer crossed the tab. */}
      {drag && !dropIsNoop(drag) && (
        <div className="tab-drop-line" style={{ left: dropOffset(drag.x) }}
        />
      )}
    </div>
  );
}
