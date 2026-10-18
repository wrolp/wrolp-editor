import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";

/** What each half of a note is allowed to be. The backend caps the same two numbers. */
const TITLE_MAX_CHARS = 200;
const BODY_MAX_CHARS = 2000;

interface Props {
  /** The file the version is being recorded for, so the box says what it is about. */
  name: string;
  /**
   * Which gesture this box is standing in front of. As a save it is the write itself that waits,
   * so the box says "Save" and the note is what the version will be filed under; as *Create
   * version* the text is already on disk and the box records it.
   */
  intent: "save" | "create";
  /** The note, trimmed; `null` when the box was left empty, which still records. */
  onConfirm: (message: string | null) => void;
  onCancel: () => void;
}

/**
 * Ask for a word about the version being recorded.
 *
 * A title and, under it, as many lines as that needs to explain: the list shows the first line and
 * the rest is kept with the version for whoever opens it later. Only ever asked when a version is
 * asked for on purpose — not on every save, since a box in the way of `Ctrl+S` turns the recording
 * of versions into something to work around. Empty is a real answer: it records without a note,
 * which is what a save has always done.
 *
 * The note cannot be edited afterwards. It lives inside the commit it describes, so changing it
 * would rewrite that commit and every one after it — which is why the question is asked here, once,
 * rather than offered later.
 */
export default function VersionNoteDialog({ name, intent, onConfirm, onCancel }: Props) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useModalDrag<HTMLDivElement>();
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  const confirmRef = useRef(onConfirm);
  confirmRef.current = onConfirm;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape and Enter mean the same thing here as on every other dialog in the app, and the
  // handlers go through refs so a keystroke cannot meet the closure from an older render.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const submit = () => {
    const first = title.trim().slice(0, TITLE_MAX_CHARS);
    const rest = body.trim().slice(0, BODY_MAX_CHARS);
    // The two halves travel as one message, the title on its own line: that is how the backend
    // tells them apart, and it is how git stores a commit message.
    confirmRef.current(
      first || rest ? (first ? `${first}\n${rest}` : rest) : null
    );
  };

  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t(intent === "save" ? "ver.noteSaveTitle" : "ver.noteTitle", { name })}
        </h3>
        <input
          ref={inputRef}
          className="grp-input"
          value={title}
          maxLength={TITLE_MAX_CHARS}
          placeholder={t("ver.notePlaceholder")}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <textarea
          className="grp-input ver-note-body"
          value={body}
          maxLength={BODY_MAX_CHARS}
          rows={4}
          placeholder={t("ver.noteBodyPlaceholder")}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            // Enter writes a line here — this is the half meant for more than one — and the
            // combination is what hands the note over.
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <p className="muted">{t(intent === "save" ? "ver.noteHintSave" : "ver.noteHint")}</p>
        <div className="modal-actions">
          <button className="btn primary" onClick={submit}>
            {t(intent === "save" ? "ver.noteSave" : "ver.noteRecord")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("grp.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
