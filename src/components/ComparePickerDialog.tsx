import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import { pathKey } from "../lib/types";
import { FileIcon } from "./FileIcon";

interface Candidate {
  path: string;
  name: string;
}

interface Props {
  /** The file the comparison starts from. It is never offered as the other side. */
  leftPath: string;
  leftName: string;
  /** Open file tabs. Unsaved buffers and the left file itself are filtered out by the caller. */
  candidates: Candidate[];
  onPick: (path: string) => void;
  /** Falls back to the system file picker, for a file that is not open in a tab. */
  onBrowse: () => void;
  onCancel: () => void;
}

/**
 * Second step of "Compare with…": pick the other file from the tabs already on screen.
 *
 * The two files being compared are usually the two being worked on, and the tab strip
 * already lists them by name — a file dialog would make the user re-find what is one
 * click away. Browsing stays available for the other case: a file in some other folder.
 */
export default function ComparePickerDialog({
  leftPath,
  leftName,
  candidates,
  onPick,
  onBrowse,
  onCancel,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useModalDrag<HTMLDivElement>();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The left file is dropped here rather than only at the call site: a file is never the
  // other side of its own comparison, and the list should hold even if the caller forgets.
  // Filtering matches the full path as well as the name — two files can share a name, and
  // the folder is what tells them apart.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return candidates
      .filter((item) => pathKey(item.path) !== pathKey(leftPath))
      .filter(
        (item) =>
          !needle ||
          item.name.toLowerCase().includes(needle) ||
          item.path.toLowerCase().includes(needle)
      );
  }, [candidates, leftPath, query]);

  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("cmp.pickTitle")}
        </h3>
        <p className="cmp-pick-left">
          <FileIcon name={leftName} />
          {leftName}
        </p>

        <input
          ref={inputRef}
          className="grp-input"
          value={query}
          placeholder={t("cmp.pickSearch")}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            // Enter takes the first match, so the keyboard alone is enough once the list
            // is filtered down to one row.
            if (e.key === "Enter" && shown.length > 0) onPick(shown[0].path);
          }}
        />

        <div className="pick-list">
          {shown.length === 0 ? (
            <div className="pick-empty">{t("cmp.pickNone")}</div>
          ) : (
            shown.map((item) => (
              <div key={item.path} className="pick-row" onClick={() => onPick(item.path)}>
                <FileIcon name={item.name} />
                <span className="pick-name">{item.name}</span>
                <span className="pick-path">{item.path}</span>
              </div>
            ))
          )}
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onBrowse}>
            {t("cmp.browse")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("fileSettings.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
