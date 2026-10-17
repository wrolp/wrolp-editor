import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DiffView from "./DiffView";
import { formatWhen, t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import { useModalResize } from "../hooks/useModalResize";
import { foldPair, type FoldChange } from "../lib/diffFold";
import { IconClose, IconFold, IconMaximize, IconRestore, IconRevert, IconSwap } from "./icons";
import { errorMessage, type VersionEntry } from "../lib/tauri";
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

/** The live buffer, spelled as an id so a side can be either a version or what is on screen. */
const CURRENT = "current";

interface Props extends View {
  path: string;
  name: string;
  /** The file's language, so both sides highlight the same way. */
  language: string;
  /** Every recorded version of this file, newest first. */
  versions: VersionEntry[];
  /** The text in the editor when the comparison opened. */
  currentText: string;
  /** One version's text, read from the history. */
  loadContent: (oid: string) => Promise<string>;
  /** The version the row was clicked on: it goes on the left. */
  initialOid: string;
  /** Put a version back into the editor, unsaved. */
  onRestore: (oid: string) => void;
  onClose: () => void;
}

/**
 * Two sides of one file's history, beside each other.
 *
 * Either side can be a recorded version or the text on screen, because the two questions people
 * ask are different: "what did I change since then" and "what changed between those two saves".
 *
 * Read-only, and the restore is the only write it can ask for. A version is worth looking at
 * because something might have gone wrong, and the answer to that is a text the user then decides
 * to keep — not a file rewritten the moment a row was clicked.
 */
export default function VersionDiffModal(props: Props) {
  const { path, name, language, versions, currentText, loadContent, initialOid, onRestore, onClose } = props;
  const drag = useModalDrag<HTMLDivElement>();
  const [maximized, setMaximized] = useState(false);
  const resize = useModalResize<HTMLDivElement>(drag.ref, maximized);
  const [stats, setStats] = useState<DiffStats>({ added: 0, removed: 0 });
  const [left, setLeft] = useState(initialOid);
  const [right, setRight] = useState(CURRENT);
  /** Version texts already read. A version's content never changes, so this never needs invalidating. */
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [fold, setFold] = useState(false);
  /** The changed ranges of the whole texts, which is what the fold cuts by. */
  const [changes, setChanges] = useState<readonly FoldChange[] | null>(null);
  const loadSeq = useRef(0);
  /** Versions with a read in flight, so a re-render does not start the same read twice. */
  const pending = useRef(new Set<string>());

  // Escape leaves the comparison.
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

  /**
   * Read a version the first time a side is set to it.
   *
   * Two guards, both for the same reason — a side can be changed faster than a read comes back.
   * The sequence number means a slow answer for a choice that has already been replaced cannot
   * overwrite the new one, and `pending` keeps a re-render (which rebuilds the caller's `loadContent`
   * and so this effect) from starting a second read of the same version.
   */
  useEffect(() => {
    const wanted = [left, right].filter(
      (side) => side !== CURRENT && texts[side] === undefined && !pending.current.has(side)
    );
    if (wanted.length === 0) return;
    for (const oid of wanted) pending.current.add(oid);
    const seq = ++loadSeq.current;
    let alive = true;
    Promise.all(wanted.map(async (oid) => [oid, await loadContent(oid)] as const))
      .then((pairs) => {
        if (!alive || seq !== loadSeq.current) return;
        setError(null);
        setTexts((prev) => {
          const next = { ...prev };
          for (const [oid, text] of pairs) next[oid] = text;
          return next;
        });
      })
      .catch((e) => {
        if (alive && seq === loadSeq.current) setError(errorMessage(e));
      })
      .finally(() => {
        for (const oid of wanted) pending.current.delete(oid);
      });
    return () => {
      alive = false;
    };
  }, [left, right, texts, loadContent]);

  const textOf = useCallback(
    (side: string) => (side === CURRENT ? currentText : (texts[side] ?? "")),
    [currentText, texts]
  );

  /** The name of a side wherever it comes from: the buffer, or a version by its moment and name. */
  const labelFor = useCallback(
    (side: string) => {
      if (side === CURRENT) return t("ver.current");
      const index = versions.findIndex((v) => v.oid === side);
      if (index < 0) return side.slice(0, 8);
      return versionLabel(versions[index], index, versions.length);
    },
    [versions]
  );

  const full = useMemo(() => ({ left: textOf(left), right: textOf(right) }), [textOf, left, right]);

  /**
   * The fold cuts the whole texts down to their hunks, using the ranges Monaco computed for those
   * same whole texts. That is why `changes` is only collected while the fold is off: once the
   * models hold the truncated pair, the ranges Monaco reports describe the truncation, not the
   * file, and folding with them would cut a second time from an already-cut text.
   */
  const folded = useMemo(() => {
    if (!fold || !changes) return null;
    return foldPair(full.left, full.right, changes);
  }, [fold, changes, full]);

  const pair: ComparePair = useMemo(() => {
    const source = folded ?? full;
    return {
      left: {
        path,
        name: labelFor(left),
        content: source.left,
        language,
        kind: kindOf(left),
        oid: left === CURRENT ? undefined : left,
      },
      right: {
        path,
        name: labelFor(right),
        content: source.right,
        language,
        kind: kindOf(right),
        oid: right === CURRENT ? undefined : right,
      },
    };
  }, [folded, full, labelFor, language, left, path, right]);

  /** The restore puts back whichever side is an actual version, preferring the left. */
  const restoreOid = left !== CURRENT ? left : right !== CURRENT ? right : null;

  const choose = useCallback((setter: (side: string) => void) => (value: string) => {
    setter(value);
    // Back to the whole texts: the ranges the fold would cut by belong to the pair being replaced.
    setFold(false);
    setChanges(null);
  }, []);

  const swap = useCallback(() => {
    setLeft(right);
    setRight(left);
    setFold(false);
    setChanges(null);
  }, [left, right]);

  /**
   * Filling the viewport and going back.
   *
   * The size the dialog had is remembered before it grows, because the maximised state comes from a
   * class and an inline `width` would win over it — so maximising has to take the inline size off,
   * and giving up the maximised state has to put it back. Somebody who resized the comparison to
   * read a long line should not lose that choice when they look away and back.
   */
  const restoredSize = useRef<{ width: number; height: number } | null>(null);
  const toggleMaximize = useCallback(() => {
    const node = drag.ref.current;
    if (!node) return;
    if (!maximized) {
      const rect = node.getBoundingClientRect();
      restoredSize.current = { width: rect.width, height: rect.height };
      resize.apply(null);
      setMaximized(true);
    } else {
      resize.apply(restoredSize.current);
      setMaximized(false);
    }
  }, [drag, maximized, resize]);

  return (
    <div className="modal-overlay">
      <div
        className={`modal diff-modal${maximized ? " maximized" : ""}`}
        ref={drag.ref}
      >
        <h3 className="modal-title" {...drag.handleProps}>
          <span className="modal-title-text">{t("ver.diffTitle", { name, version: labelFor(left) })}</span>
          {/* The three window controls sit in the title, out of the way of the text they act on.
              They are buttons, so the drag handler leaves them alone rather than moving the
              dialog out from under the click. */}
          <span className="modal-title-actions">
            <button
              className={`btn small icon-btn${fold ? " on" : ""}`}
              onClick={() => setFold(!fold)}
              disabled={!changes || changes.length === 0}
              title={t("ver.fold")}
              aria-label={t("ver.fold")}
              aria-pressed={fold}
            >
              <IconFold size={14} />
            </button>
            <button
              className="btn small icon-btn"
              onClick={toggleMaximize}
              title={t(maximized ? "ver.restoreSize" : "ver.maximize")}
              aria-label={t(maximized ? "ver.restoreSize" : "ver.maximize")}
            >
              {maximized ? <IconRestore size={14} /> : <IconMaximize size={14} />}
            </button>
            <button
              className="btn small icon-btn"
              onClick={onClose}
              title={t("tab.close")}
              aria-label={t("tab.close")}
            >
              <IconClose size={14} />
            </button>
          </span>
        </h3>
        <div className="diff-tools">
          <label className="diff-side">
            <span>{t("ver.leftSide")}</span>
            <SideSelect value={left} versions={versions} onChange={choose(setLeft)} />
          </label>
          <label className="diff-side">
            <span>{t("ver.rightSide")}</span>
            <SideSelect value={right} versions={versions} onChange={choose(setRight)} />
          </label>
          {/* Two more icon-only controls, for the same reason as the fold one: this bar is where the
              text gets its width back, and a label of "Swap sides" in three languages would be the
              widest thing in it. The words go to the tooltip and `aria-label`. */}
          <button
            className="btn small icon-btn"
            onClick={swap}
            disabled={left === right}
            title={t("cmp.swap")}
            aria-label={t("cmp.swap")}
          >
            <IconSwap size={14} />
          </button>
          {restoreOid && (
            <button
              className="btn small icon-btn primary"
              onClick={() => onRestore(restoreOid)}
              title={t("ver.restoreTitle", { version: labelFor(restoreOid) })}
              aria-label={t("ver.restoreTitle", { version: labelFor(restoreOid) })}
            >
              <IconRevert size={14} />
            </button>
          )}
        </div>
        {error && <p className="modal-error">{error}</p>}
        <div className="diff-modal-body">
          <DiffView
            // Remount per pair: the two models are keyed by the sides' identities, and the view
            // only releases the ones it attached at unmount.
            key={`${left}|${right}`}
            pair={pair}
            fontSize={props.fontSize}
            renderWhitespace={props.renderWhitespace}
            wordWrap={props.wordWrap}
            tabSize={props.tabSize}
            insertSpaces={props.insertSpaces}
            detectIndentation={props.detectIndentation}
            scrollBeyondLastLine={props.scrollBeyondLastLine}
            onStats={setStats}
            onChanges={fold ? undefined : setChanges}
          />
        </div>
        {/* Numbers only, and thin: this row reports what is on screen, and every pixel it takes is
            taken from the two texts it is describing. */}
        <div className="diff-modal-foot slim">
          <span className="sb-diff">
            {stats.added > 0 || stats.removed > 0 ? (
              <>
                {stats.added > 0 && <span className="add">+{stats.added}</span>}
                {stats.removed > 0 && <span className="del">−{stats.removed}</span>}
              </>
            ) : (
              t("cmp.identical")
            )}
            {folded?.folded && (
              <span className="ver-hidden">
                {t("ver.hiddenLines", { left: folded.hiddenLeft, right: folded.hiddenRight })}
              </span>
            )}
            {fold && !folded?.folded && <span className="ver-hidden">{t("ver.nothingHidden")}</span>}
          </span>
        </div>
        {!maximized && (
          <>
            <div className="resize-edge right" {...resize.handleProps("x")} />
            <div className="resize-edge bottom" {...resize.handleProps("y")} />
            <div className="resize-edge corner" {...resize.handleProps("xy")} />
          </>
        )}
      </div>
    </div>
  );
}

/** One side's dropdown: every recorded version, newest first, and the live buffer. */
function SideSelect({
  value,
  versions,
  onChange,
}: {
  value: string;
  versions: VersionEntry[];
  onChange: (value: string) => void;
}) {
  return (
    <select className="select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={CURRENT}>{t("ver.current")}</option>
      {versions.map((v, i) => (
        <option key={v.oid} value={v.oid}>
          {versionLabel(v, i, versions.length)}
        </option>
      ))}
    </select>
  );
}

/**
 * How a version is named on screen. A version has no number of its own, so the row is described by
 * when it was saved and what it was called, with newest/oldest marked because a bare timestamp does
 * not say which end of the history it sits at, and counting rows to find out is not a reader's job.
 */
function versionLabel(entry: VersionEntry, index: number, total: number): string {
  const when = formatWhen(entry.ts);
  const rank = index === 0 ? t("ver.newest") : index === total - 1 ? t("ver.oldest") : "";
  const named = entry.message ? ` · ${entry.message}` : "";
  return rank ? `${when}${named} (${rank})` : `${when}${named}`;
}

/** The diff model's side kind, which is only about how the text arrived. */
function kindOf(side: string): "buffer" | "version" {
  return side === CURRENT ? "buffer" : "version";
}
