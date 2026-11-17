import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { parentOf } from "../lib/tauri";
import { useModalDrag } from "../hooks/useModalDrag";
import { useModalResize } from "../hooks/useModalResize";
import { FileIcon } from "./FileIcon";
import NameText from "./NameText";

/** One open tab that can be the other side of a comparison. */
interface Candidate {
  /** Side identity of the tab's buffer, so the left source can be dropped from the list. */
  key: string;
  tabId: number;
  path: string;
  name: string;
  /** The tab holds edits that were never saved. */
  dirty: boolean;
  /** The tab has no file behind it: `Untitled-N`. */
  untitled: boolean;
}

interface Props {
  /** Side identity of the source the comparison starts from; never the other side. */
  leftKey: string;
  leftName: string;
  /** Open tabs that can be the other side. */
  candidates: Candidate[];
  onPick: (tabId: number) => void;
  /** Falls back to the system file picker, for a file that is not open in a tab. */
  onBrowse: () => void;
  onCancel: () => void;
}

/**
 * Second step of "Compare with…": pick the other side from what is already on screen.
 *
 * The two sides of a comparison are usually the two being worked on, and the tab strip
 * already lists them by name — a file dialog would make the user re-find what is one
 * click away. Browsing stays available for the other case: a file in some other folder.
 * Unsaved buffers are sides like any other, so each row says whether it holds edits that
 * were never saved, or has no file behind it at all.
 */
export default function ComparePickerDialog({
  leftKey,
  leftName,
  candidates,
  onPick,
  onBrowse,
  onCancel,
}: Props) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useModalDrag<HTMLDivElement>();
  /** The list is the reason this dialog can be as tall as the window: the size is the user's. */
  const resize = useModalResize<HTMLDivElement>(drag.ref, false, { minWidth: 250 });

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The left source is dropped here rather than only at the call site: a source is never
  // the other side of its own comparison, and the list should hold even if the caller
  // forgets. Filtering matches the full path as well as the name — two files can share a
  // name, and the folder is what tells them apart.
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return candidates
      .filter((item) => item.key !== leftKey)
      .filter(
        (item) =>
          !needle ||
          item.name.toLowerCase().includes(needle) ||
          item.path.toLowerCase().includes(needle)
      );
  }, [candidates, leftKey, query]);

  return (
    <div className="modal-overlay">
      <div className="modal cmp-pick" ref={drag.ref}>
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
            if (e.key === "Enter" && shown.length > 0) onPick(shown[0].tabId);
          }}
        />

        <div className="pick-list">
          {shown.length === 0 ? (
            <div className="pick-empty">{t("cmp.pickNone")}</div>
          ) : (
            shown.map((item) => {
              // `untitled://` is an identity, not a path, so it has no folder to show.
              const dir = item.untitled ? "" : parentOf(item.path);
              return (
                // The name on the first line, the folder holding it underneath: two files can
                // share a name, and the folder is what tells them apart.
                <div key={item.key} className="pick-row" onClick={() => onPick(item.tabId)}>
                  <FileIcon name={item.name} />
                  <div className="pick-text">
                    <div className="pick-head">
                      <NameText name={item.name} mode="middle" className="pick-name" tooltip />
                      {/* An untitled buffer is unsaved by its name, so it carries only that
                          badge; a file with edits that were never saved says so instead. */}
                      {item.untitled ? (
                        <span className="pick-badge">{t("cmp.untitled")}</span>
                      ) : item.dirty ? (
                        <span className="pick-badge">{t("cmp.unsaved")}</span>
                      ) : null}
                    </div>
                    {dir && (
                      <NameText name={dir} mode="middle" className="pick-path" tooltip />
                    )}
                  </div>
                </div>
              );
            })
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
        {/* The size is the user's: the list is what they came to read, and how much of it is
            useful depends on what is open and on the window behind. */}
        <div className="resize-edge right" {...resize.handleProps("x")} />
        <div className="resize-edge bottom" {...resize.handleProps("y")} />
        <div className="resize-edge corner" {...resize.handleProps("xy")} />
      </div>
    </div>
  );
}
