import { useEffect, useRef, useState } from "react";
import DiffView from "./DiffView";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import { sideKey, type ComparePair, type DiffStats } from "../lib/types";

interface View {
  fontSize: number;
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  scrollBeyondLastLine: boolean;
}

interface Props extends View {
  /** The version on the left, what the editor holds on the right. */
  pair: ComparePair;
  /** The file's own name, for the title. */
  name: string;
  /** How the version being looked at is described: its time, or the name it was given. */
  versionLabel: string;
  /** Put the version's text into the editor, marked unsaved. */
  onRestore: () => void;
  onClose: () => void;
}

/**
 * One version beside what is on screen now.
 *
 * Read-only, and the restore is the only write it can ask for. A version is worth looking at
 * because something might have gone wrong, and the answer to that is a text the user then decides
 * to keep — not a file rewritten the moment a row was clicked.
 */
export default function VersionDiffModal(props: Props) {
  const { pair, name, versionLabel, onRestore, onClose } = props;
  const drag = useModalDrag<HTMLDivElement>();
  const [stats, setStats] = useState<DiffStats>({ added: 0, removed: 0 });

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="modal-overlay">
      <div className="modal diff-modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("ver.diffTitle", { name, version: versionLabel })}
        </h3>
        <div className="diff-modal-body">
          <DiffView
            // Remount per pair: the two models are keyed by the sides' identities, and the view
            // only releases the ones it attached at unmount.
            key={`${sideKey(pair.left.kind, pair.left.path, pair.left.oid)}|${sideKey(
              pair.right.kind,
              pair.right.path
            )}`}
            pair={pair}
            fontSize={props.fontSize}
            renderWhitespace={props.renderWhitespace}
            wordWrap={props.wordWrap}
            tabSize={props.tabSize}
            insertSpaces={props.insertSpaces}
            detectIndentation={props.detectIndentation}
            scrollBeyondLastLine={props.scrollBeyondLastLine}
            onStats={setStats}
          />
        </div>
        <div className="diff-modal-foot">
          <span className="sb-diff">
            {stats.added > 0 || stats.removed > 0 ? (
              <>
                {stats.added > 0 && <span className="add">+{stats.added}</span>}
                {stats.removed > 0 && <span className="del">−{stats.removed}</span>}
              </>
            ) : (
              t("cmp.identical")
            )}
          </span>
          <div className="modal-actions">
            <button className="btn primary" onClick={onRestore}>
              {t("ver.restore")}
            </button>
            <button className="btn" onClick={onClose}>
              {t("tab.close")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
