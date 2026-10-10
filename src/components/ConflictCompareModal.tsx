import { useEffect, useRef, useState } from "react";
import DiffView from "./DiffView";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import type { ComparePair, DiffStats } from "../lib/types";

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
  /** What disk holds against what the tab holds, taken when the popup was opened. */
  pair: ComparePair;
  /** The file's own name, for the title. */
  name: string;
  /** Give up the tab's text and rebuild it from disk. */
  onTakeDisk: () => void;
  /** Write the tab's text over what is on disk now. */
  onKeepSave: () => void;
  /** Put the comparison away. The prompt it came from stays where it was. */
  onClose: () => void;
}

/**
 * The conflict comparison, as a popup over the prompt that offered it.
 *
 * Both versions have to be readable at once to answer "what did the other program actually
 * change", and the choice is made here rather than on the prompt: the prompt only got this far,
 * while this has both texts in front of the user. Saving from it settles the prompt too, so
 * there is never a question left up behind an answer already given.
 */
export default function ConflictCompareModal(props: Props) {
  const { pair, name, onTakeDisk, onKeepSave, onClose } = props;
  const drag = useModalDrag<HTMLDivElement>();
  const [stats, setStats] = useState<DiffStats>({ added: 0, removed: 0 });

  // Escape leaves the comparison, which is where the prompt it came from is still waiting.
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
          {t("stale.diffName", { name })}
        </h3>
        <div className="diff-modal-body">
          <DiffView
            // Remount per file: the two models are keyed by the pair's paths, and the view only
            // releases the ones it attached at unmount.
            key={`${pair.left.path}|${pair.right.path}`}
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
            <button className="btn" onClick={onTakeDisk}>
              {t("stale.reload")}
            </button>
            <button className="btn primary" onClick={onKeepSave}>
              {t("stale.keepSave")}
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
