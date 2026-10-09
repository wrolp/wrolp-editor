import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import type { Tab } from "../lib/types";

interface Props {
  tab: Tab;
  /** The prompt came from a save, so declining it has an action attached: write anyway. */
  fromSave: boolean;
  /** Open the comparison over this prompt, which stays up behind it. */
  onCompare: () => void;
  /** Give up the tab's text and rebuild it from disk. */
  onReload: () => void;
  /** Keep the tab's text. */
  onKeep: () => void;
}

/**
 * Asked for when another program wrote the file this tab is built on.
 *
 * A reload the user chose can assume they meant to lose their edits; this cannot, because both
 * sides are somebody's work and only the user knows which one. So the mask stays clear — the
 * text being argued about has to stay visible — and "Compare" opens the two versions over this
 * prompt instead of replacing it, because looking at the difference is not an answer to it.
 */
export default function StaleChangeDialog({ tab, fromSave, onCompare, onReload, onKeep }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  return (
    <div className="modal-overlay clear">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("stale.title")}
        </h3>
        <p>{t("stale.body", { name: tab.name })}</p>
        {tab.dirty && <p>{t("stale.bodyDirty")}</p>}
        <p className="muted">{t("stale.note")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onCompare} autoFocus>
            {t("stale.diff")}
          </button>
          <button className="btn" onClick={onReload}>
            {t("stale.reload")}
          </button>
          <button className="btn" onClick={onKeep}>
            {fromSave ? t("stale.keepSave") : t("stale.keep")}
          </button>
        </div>
      </div>
    </div>
  );
}
