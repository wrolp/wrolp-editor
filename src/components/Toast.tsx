import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { copyText } from "../lib/tauri";

interface Props {
  message: string;
  visible: boolean;
  /**
   * A pointer resting on the toast holds it up — a message worth reading is a message worth
   * keeping on screen — and leaving it is what lets it go.
   */
  onHold: () => void;
  onRelease: () => void;
}

export default function Toast({ message, visible, onHold, onRelease }: Props) {
  /** What the last double-click did, shown for a moment after the message. */
  const [note, setNote] = useState<"copied" | "failed" | null>(null);
  const noteTimer = useRef<number | undefined>(undefined);

  // A new message is a new sentence; the note belongs to the one that was copied.
  useEffect(() => {
    setNote(null);
    window.clearTimeout(noteTimer.current);
  }, [message]);
  useEffect(() => () => window.clearTimeout(noteTimer.current), []);

  const copyOnDoubleClick = () => {
    void copyText(message).then((ok) => {
      setNote(ok ? "copied" : "failed");
      window.clearTimeout(noteTimer.current);
      noteTimer.current = window.setTimeout(() => setNote(null), 1400);
    });
  };

  return (
    <div
      className={`toast${visible ? " show" : ""}`}
      role="status"
      title={t("toast.copyHint")}
      onMouseEnter={onHold}
      onMouseLeave={onRelease}
      onDoubleClick={copyOnDoubleClick}
    >
      {message}
      {note && (
        <span className={`toast-note${note === "failed" ? " failed" : ""}`}>
          {t(note === "copied" ? "toast.copied" : "side.copyFailed")}
        </span>
      )}
    </div>
  );
}
