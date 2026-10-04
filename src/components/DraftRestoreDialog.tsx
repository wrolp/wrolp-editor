import type { PendingRestore } from "../lib/types";

interface Props {
  request: PendingRestore;
  count: number;
  onRestore: () => void;
  onDiscard: () => void;
}

export default function DraftRestoreDialog({ request, count, onRestore, onDiscard }: Props) {
  const updated = new Date(request.draft.updatedAt).toLocaleString();
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>Unsaved draft found</h3>
        <p>
          "{request.name}" has edits that were never saved (draft updated {updated}).
          {count > 1 && <span> {count - 1} more file(s) waiting.</span>}
        </p>
        <p className="muted">Restore the edits from the last session?</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={onRestore} autoFocus>
            Restore draft
          </button>
          <button className="btn" onClick={onDiscard}>
            Discard and open file
          </button>
        </div>
      </div>
    </div>
  );
}
