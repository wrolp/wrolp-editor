import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";

interface Props {
  /** The name as the tree shows it, so the answer is about something the user can see. */
  name: string;
  isDir: boolean;
  /** Carries the delete out. Runs only after the user has said yes. */
  onDelete: () => void;
  onCancel: () => void;
}

/**
 * Asked for before anything is deleted from disk.
 *
 * Nothing here is moved, so there is no undo to offer and no Recycle Bin to fall back on:
 * saying yes is the whole of the way back. That is also why the folder case says what a
 * folder means — a recursive delete of a folder the user was only looking through is the one
 * that cannot be undone by editing a name.
 *
 * What a delete does *not* take is the unsaved text: the drafts outlive the file, and are
 * offered back if the same path ever opens again. The file case says so, because otherwise
 * "cannot be undone" would read as "your unsaved work is gone too", which is not true.
 */
export default function DeleteEntryDialog({ name, isDir, onDelete, onCancel }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("del.title")}
        </h3>
        <p>{t("del.body", { name })}</p>
        <p className="muted">{t(isDir ? "del.folderNote" : "del.fileNote")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onDelete} autoFocus>
            {t("del.confirm")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("close.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
