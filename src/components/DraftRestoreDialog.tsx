import { getLang, t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import type { PendingRestore } from "../lib/types";

interface Props {
  request: PendingRestore;
  count: number;
  onRestore: () => void;
  onDiscard: () => void;
}

export default function DraftRestoreDialog({ request, count, onRestore, onDiscard }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  const updated = new Date(request.draft.updatedAt).toLocaleString(
    getLang() === "zh" ? "zh-CN" : "en-US"
  );
  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("dialog.title")}
        </h3>
        <p>
          {t("dialog.body", { name: request.name, time: updated })}
          {count > 1 && <span> {t("dialog.more", { count: count - 1 })}</span>}
        </p>
        <p className="muted">{t("dialog.ask")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onRestore} autoFocus>
            {t("dialog.restore")}
          </button>
          <button className="btn" onClick={onDiscard}>
            {t("dialog.discard")}
          </button>
        </div>
      </div>
    </div>
  );
}
