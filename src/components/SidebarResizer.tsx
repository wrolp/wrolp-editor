import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { t } from "../lib/i18n";

const MIN_WIDTH = 180;
const MAX_WIDTH = 640;

interface Props {
  value: number;
  defaultValue: number;
  /** Live width while dragging; nothing is written to disk here. */
  onChange: (width: number) => void;
  /** Final width when the drag ends, persisted by the caller. */
  onCommit: (width: number) => void;
}

function clamp(width: number) {
  const limit = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - 420));
  return Math.round(Math.min(limit, Math.max(MIN_WIDTH, width)));
}

export default function SidebarResizer({ value, defaultValue, onChange, onCommit }: Props) {
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
      state.width = clamp(state.startWidth + e.clientX - state.startX);
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
  }, [dragging, onChange, onCommit]);

  return (
    <div
      className="sidebar-resizer"
      title={t("side.resizeHint")}
      onPointerDown={onPointerDown}
      onDoubleClick={() => onCommit(defaultValue)}
    />
  );
}
