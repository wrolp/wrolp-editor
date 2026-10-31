import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

interface Props {
  /** What the export is doing right now. */
  message: string;
  cancelLabel: string;
  onCancel: () => void;
  cancelDisabled: boolean;
}

/**
 * The floating "export is running" panel.
 *
 * An export can spend seconds reading pictures before the print dialog appears, and the panel
 * sits over the document while that happens. It can be dragged out of the way — anywhere in the
 * window — and stays where it was put for as long as it is on screen. The Cancel button keeps its
 * own click: a press that starts on a button does not begin a drag.
 */
export default function ExportProgress({
  message,
  cancelLabel,
  onCancel,
  cancelDisabled,
}: Props) {
  /** Viewport position once dragged; null keeps the CSS default at the bottom centre. */
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    const rect = event.currentTarget.getBoundingClientRect();
    drag.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const moveDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointer !== event.pointerId) return;
    // Kept inside the window: a panel dragged half off-screen would be unreachable again.
    const x = Math.min(
      Math.max(0, current.left + event.clientX - current.x),
      Math.max(0, window.innerWidth - current.width)
    );
    const y = Math.min(
      Math.max(0, current.top + event.clientY - current.y),
      Math.max(0, window.innerHeight - current.height)
    );
    setAt({ x, y });
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  };

  return (
    <div
      className={`export-progress${at ? " dragged" : ""}`}
      role="status"
      style={at ? { left: at.x, top: at.y, bottom: "auto", transform: "none" } : undefined}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <span>{message}</span>
      <button className="btn small" onClick={onCancel} disabled={cancelDisabled}>
        {cancelLabel}
      </button>
    </div>
  );
}
