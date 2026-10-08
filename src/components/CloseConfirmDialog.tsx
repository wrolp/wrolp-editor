import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import { isUntitled } from "../lib/path";
import type { Tab } from "../lib/types";

interface Props {
  tab: Tab;
  /** Writes the file first, and closes only if that happened. */
  onSave: () => void;
  /** Closes without writing. */
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * Asked for before a tab with unsaved edits goes away.
 *
 * Two kinds of unsaved are on offer, and they are not the same risk: a file keeps its edits
 * as a draft and is offered them again on the next open, while a scratch buffer's text lives
 * only in the group that is showing it, so closing it really does lose the work. The dialog
 * says which one the user is looking at instead of offering one blanket warning.
 */
export default function CloseConfirmDialog({ tab, onSave, onDiscard, onCancel }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  const scratch = isUntitled(tab.path);
  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("close.title")}
        </h3>
        <p>{t("close.body", { name: tab.name })}</p>
        <p className="muted">{t(scratch ? "close.untitledNote" : "close.draftNote")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onSave} autoFocus>
            {t("close.save")}
          </button>
          <button className="btn" onClick={onDiscard}>
            {t(scratch ? "close.discardScratch" : "close.discard")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("close.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
