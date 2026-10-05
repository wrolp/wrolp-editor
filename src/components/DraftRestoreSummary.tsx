import { getLang, t } from "../lib/i18n";
import type { PendingRestore } from "../lib/types";

interface Props {
  requests: PendingRestore[];
  onRestoreAll: () => void;
  onDiscardAll: () => void;
  onReviewEach: () => void;
}

/**
 * One answer for a session that came back with several drafts. Without it, restoring a
 * group would mean dismissing this dialog once per file before seeing any text.
 */
export default function DraftRestoreSummary({ requests, onRestoreAll, onDiscardAll, onReviewEach }: Props) {
  const locale = getLang() === "zh" ? "zh-CN" : "en-US";
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>{t("draft.summaryTitle", { n: requests.length })}</h3>
        <p className="muted">{t("draft.summaryDesc")}</p>
        <div className="draft-list">
          {requests.map((req) => (
            <div className="draft-row" key={req.path}>
              <span className="draft-name">{req.name}</span>
              <span className="draft-time">{new Date(req.draft.updatedAt).toLocaleString(locale)}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn primary" onClick={onRestoreAll} autoFocus>
            {t("draft.restoreAll")}
          </button>
          <button className="btn" onClick={onDiscardAll}>
            {t("draft.discardAll")}
          </button>
          <button className="btn" onClick={onReviewEach}>
            {t("draft.reviewEach")}
          </button>
        </div>
      </div>
    </div>
  );
}
