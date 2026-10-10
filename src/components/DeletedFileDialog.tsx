import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import type { Tab } from "../lib/types";

interface Props {
  tab: Tab;
  /** Write the text out under this name in the folder the app keeps, and keep the tab. */
  onKeep: () => void;
  onClose: () => void;
}

/**
 * Asked for when a file disappears from the disk while its tab is open.
 *
 * The tab still holds the text, so nothing has been lost yet — but there is nothing to save
 * it back to, and a quit or a stray close would take it. That makes this the one prompt here
 * whose second answer is not "carry on" but "throw it away", which is why the two are spelled
 * out rather than left as yes and no.
 *
 * Keeping is not a draft: a draft is offered back when its own file opens again, and this
 * file is never opening again on its own. Keeping writes a whole file out, so the text
 * survives this tab, this session, and the app being closed in between.
 */
export default function DeletedFileDialog({ tab, onKeep, onClose }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("gone.title")}
        </h3>
        <p>{t("gone.body", { name: tab.name })}</p>
        {tab.dirty && <p className="muted">{t("gone.bodyDirty")}</p>}
        <p className="muted">{t("gone.note")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onKeep} autoFocus>
            {t("gone.keep")}
          </button>
          <button className="btn" onClick={onClose}>
            {t("gone.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
