import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";

interface Props {
  /** The file name as the user knows it, so the answer is about something real. */
  name: string;
  /** Carries the launch out. Runs only after the user has said yes. */
  onRun: () => void;
  onCancel: () => void;
}

/**
 * Asked for before a file whose extension means "program, not document" is handed to the OS.
 *
 * A `.bat` or `.js` out of a checked-out repository runs, it does not open, and one click
 * must not be enough. The default focus sits on Cancel for the same reason: the safe answer
 * is the one that takes a stray Enter.
 */
export default function RunConfirmDialog({ name, onRun, onCancel }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("run.title")}
        </h3>
        <p>{t("run.body", { name })}</p>
        <div className="modal-actions">
          <button className="btn" onClick={onCancel} autoFocus>
            {t("close.cancel")}
          </button>
          <button className="btn" onClick={onRun}>
            {t("run.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
