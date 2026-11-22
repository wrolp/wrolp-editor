import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "../lib/i18n";

const MIN_WIDTH = 180;
const MAX_WIDTH = 640;
const RESERVE = 420;

interface Props {
  value: number;
  defaultValue: number;
  /** Live width while dragging; nothing is written to disk here. */
  onChange: (width: number) => void;
  /** Final width when the drag ends, persisted by the caller. */
  onCommit: (width: number) => void;
  /** The pane's inner edge. A right-hand dock grows as the pointer moves left. */
  side?: "left" | "right";
  min?: number;
  max?: number;
  /** Pixels the rest of the window keeps when the pane is pulled to its widest. */
  reserve?: number;
}

function clamp(width: number, min: number, max: number, reserve: number) {
  const limit = Math.min(max, Math.max(min, window.innerWidth - reserve));
  return Math.round(Math.min(limit, Math.max(min, width)));
}

/** The divider on a pane's inner edge: the sidebar's tree, or the AI chat dock. */
export default function SidebarResizer({
  value,
  defaultValue,
  onChange,
  onCommit,
  side = "left",
  min = MIN_WIDTH,
  max = MAX_WIDTH,
  reserve = RESERVE,
}: Props) {
  const drag = useRef<{ startX: number; startWidth: number; width: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    drag.current = { startX: e.clientX, startWidth: value, width: value };
    setDragging(true);
    document.body.classList.add("resizing");
    // Capture keeps the gesture on the 5px handle; it can throw for an inactive pointer id,
    // so the listeners below live on window and work either way.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* best effort */
    }
  };

  useEffect(() => {
    if (!dragging) return;

    const move = (e: PointerEvent) => {
      const state = drag.current;
      if (!state) return;
      const delta = side === "right" ? state.startX - e.clientX : e.clientX - state.startX;
      state.width = clamp(state.startWidth + delta, min, max, reserve);
      onChange(state.width);
    };
    const finish = () => {
      if (drag.current) onCommit(drag.current.width);
      drag.current = null;
      document.body.classList.remove("resizing");
      setDragging(false);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
    };
  }, [dragging, max, min, onChange, onCommit, reserve, side]);

  return (
    <div
      className={`sidebar-resizer${dragging ? " active" : ""}`}
      title={t("side.resizeHint")}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCommit(defaultValue)}
    />
  );
}
