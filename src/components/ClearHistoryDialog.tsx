import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";

interface Props {
  /** How many entries will be forgotten, shown so the decision is about a real number. */
  count: number;
  /** Carries the clear out. Runs only after the user has said yes. */
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Asked for before the whole recent-files list is dropped.
 *
 * Clearing history is not destructive in the way a delete is — no file is touched, and the
 * unsaved drafts live in a separate store — so the dialog says what is *not* lost, to keep the
 * confirmation from reading as scarier than the action is.
 */
export default function ClearHistoryDialog({ count, onConfirm, onCancel }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("side.clearTitle")}
        </h3>
        <p>{t("side.clearBody", { n: count })}</p>
        <p className="muted">{t("side.clearNote")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onConfirm} autoFocus>
            {t("side.clearConfirm")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("close.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
