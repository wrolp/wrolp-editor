import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import type { Tab } from "../lib/types";

interface Props {
  tab: Tab;
  /** Reads the file again, throwing the unsaved edits away. */
  onReload: () => void;
  onCancel: () => void;
}

/**
 * Asked for before a reload throws unsaved edits away.
 *
 * Closing a dirty tab can offer to keep the work as a draft, so it never has to be a total
 * loss. A reload cannot: taking the text from disk is the whole point, so the edits it
 * replaces have nowhere to go. That makes this the one buffer change that has to be answered
 * for even though a draft exists — the dialog says so rather than leaning on the same wording
 * as the close prompt, where the answer would be the opposite one.
 */
export default function ReloadConfirmDialog({ tab, onReload, onCancel }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("reload.title")}
        </h3>
        <p>{t("reload.body", { name: tab.name })}</p>
        <p className="muted">{t("reload.note")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onReload} autoFocus>
            {t("reload.confirm")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("close.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
