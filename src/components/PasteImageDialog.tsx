import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";

interface Props {
  /** The folder the picture will be written into, shown so the choice is not blind. */
  dir: string;
  /** The free stem the backend proposes: `image-<moment>`, numbered when needed. */
  defaultName: string;
  /**
   * Save under the chosen stem. A failure comes back as a localized message and keeps this
   * dialog open, so a taken or invalid name is fixed here rather than discovered later.
   */
  onSave: (name: string) => Promise<string | null>;
  /** `saved` is true only when `onSave` finished without an error. */
  onClose: (saved: boolean) => void;
}

/** What Windows refuses inside a single path segment. */
const INVALID = /[\\/:*?"<>|]/;

/** A typed `.png` folds into the fixed suffix rather than becoming `.png.png`. */
function stemOf(value: string): string {
  const trimmed = value.trim();
  return /\.png$/i.test(trimmed) ? trimmed.slice(0, -4) : trimmed;
}

/**
 * The name a pasted picture is saved under.
 *
 * The default is a free timestamped stem, and the reader may change it before anything is
 * written: a screenshot is often named for what it shows, and the moment it was taken is
 * only a useful fallback. The extension is fixed because the bytes are re-encoded as PNG —
 * a `.jpg` label on PNG bytes would be a lie the next program has to discover.
 */
export default function PasteImageDialog({ dir, defaultName, onSave, onClose }: Props) {
  const [value, setValue] = useState(defaultName);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useModalDrag<HTMLDivElement>();

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // The default is a suggestion; selecting it lets a typed name replace it in one gesture.
    input.select();
  }, []);

  const submit = async () => {
    if (busy) return;
    const stem = stemOf(value);
    if (!stem) {
      setProblem(t("imgName.empty"));
      return;
    }
    if (INVALID.test(stem) || stem.endsWith(".") || stem === "." || stem === "..") {
      setProblem(t("imgName.invalid"));
      return;
    }
    setBusy(true);
    const failure = await onSave(stem);
    if (failure) {
      setBusy(false);
      setProblem(failure);
      return;
    }
    onClose(true);
  };

  return (
    <div className="modal-overlay">
      <div className="modal paste-name-modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("imgName.title")}
        </h3>
        <label className="paste-name-label" htmlFor="paste-image-name">
          {t("imgName.hint")}
        </label>
        <div className="paste-name-row">
          <input
            id="paste-image-name"
            ref={inputRef}
            className="grp-input"
            value={value}
            spellCheck={false}
            disabled={busy}
            onChange={(event) => {
              setValue(event.target.value);
              if (problem) setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submit();
              // A save already in flight is not canceled by the keyboard: the file may
              // still be written, and closing the dialog would hide what happened.
              if (event.key === "Escape" && !busy) onClose(false);
            }}
          />
          <span className="paste-name-suffix">.png</span>
        </div>
        <div className="paste-name-dir" title={dir}>
          {dir}
        </div>
        {problem && <p className="modal-error">{problem}</p>}
        <div className="modal-actions">
          <button className="btn primary" onClick={() => void submit()} disabled={busy}>
            {busy ? t("imgName.saving") : t("imgName.save")}
          </button>
          <button className="btn" onClick={() => onClose(false)} disabled={busy}>
            {t("grp.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
