import { useCallback, useEffect, useMemo, useRef } from "react";
import { DiffEditor, type MonacoDiffEditor } from "@monaco-editor/react";
import { t } from "../lib/i18n";
import "../lib/monaco";
import { sideKey, type ComparePair, type DiffStats } from "../lib/types";
import type { FoldChange } from "../lib/diffFold";
import { IconFold, IconWordWrap } from "./icons";

interface Props {
  pair: ComparePair;
  fontSize: number;
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  scrollBeyondLastLine: boolean;
  /** Added/removed line counts, recomputed whenever Monaco recomputes the diff. */
  onStats: (stats: DiffStats) => void;
  /**
   * The changed line ranges themselves, for a caller that wants to show only those and their
   * surroundings. Monaco's own numbers, so nothing here is a second diff algorithm.
   */
  onChanges?: (changes: readonly FoldChange[]) => void;
  /**
   * An optional control for folding the two texts down to their changed lines. Absent means the
   * header keeps its two columns exactly as it is — the version dialog and the conflict
   * comparison pass nothing and are untouched.
   */
  fold?: {
    on: boolean;
    canFold: boolean;
    /** Lines dropped from each side while folded, or null when nothing was dropped. */
    hidden: { left: number; right: number } | null;
    nothingHidden: boolean;
    onToggle: () => void;
  };
  /**
   * An optional switch for wrapping long lines in this view. Like `fold`, absent means nothing is
   * rendered; the global setting stays the default this view starts from.
   */
  wrap?: { on: boolean; onToggle: () => void };
}

/**
 * Read-only side-by-side diff of two files.
 *
 * The text is a snapshot taken when the comparison started rather than the live buffers:
 * a diff answers a question ("how do these two differ right now") and answering it must
 * not drag drafts, dirty flags or save paths into the picture. The two models live under
 * `inmemory:` URIs unique to this pair, so the diff editor can never attach to — or
 * dispose — the model a real file tab is using.
 */
export default function DiffView({
  pair,
  fontSize,
  renderWhitespace,
  wordWrap,
  tabSize,
  insertSpaces,
  detectIndentation,
  scrollBeyondLastLine,
  onStats,
  onChanges,
  fold,
  wrap,
}: Props) {
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  const changesRef = useRef(onChanges);
  changesRef.current = onChanges;

  /**
   * Derived from the pair *in order*: swapping the two sides has to yield different URIs.
   * A stable per-tab URI would not, and the diff editor reuses whatever model already
   * sits at the path it is handed — the swap would keep showing the old sides. The side
   * identity carries the kind as well as the path, so a file compared against its own
   * unsaved buffer (same path on both sides) still gets two distinct models.
   */
  const base = useMemo(
    () =>
      `inmemory://compare/${encodeURIComponent(
        sideKey(pair.left.kind, pair.left.path, pair.left.oid)
      )}~${encodeURIComponent(sideKey(pair.right.kind, pair.right.path, pair.right.oid))}`,
    [pair.left.kind, pair.left.path, pair.left.oid, pair.right.kind, pair.right.path, pair.right.oid]
  );

  /**
   * Monaco reports changed regions, not two totals. A pure insertion has no original
   * range (0) and a pure deletion has no modified one, which is how the two sides are
   * told apart.
   */
  const report = useCallback((instance: MonacoDiffEditor) => {
    let added = 0;
    let removed = 0;
    const changes = instance.getLineChanges() ?? [];
    for (const change of changes) {
      if (change.modifiedStartLineNumber > 0) {
        added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
      }
      if (change.originalStartLineNumber > 0) {
        removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
      }
    }
    statsRef.current({ added, removed });
    changesRef.current?.(changes);
  }, []);

  // The mount handler reports for the new pair, but the previous comparison's totals must
  // not sit in the status bar in between.
  useEffect(() => {
    statsRef.current({ added: 0, removed: 0 });
  }, [base]);

  return (
    <div className="diff-view" title={t("cmp.readOnly")}>
      <div className="diff-head">
        <span className="diff-name" title={pair.left.path}>
          {pair.left.name}
        </span>
        <span className="diff-name" title={pair.right.path}>
          {pair.right.name}
        </span>
        {(fold || wrap) && (
          <div className="diff-tools">
            {fold?.hidden && (
              <span
                className="diff-tools-note"
                title={t("ver.hiddenLines", { left: fold.hidden.left, right: fold.hidden.right })}
              >
                {t("cmp.foldHidden", { left: fold.hidden.left, right: fold.hidden.right })}
              </span>
            )}
            {fold?.nothingHidden && (
              <span className="diff-tools-note">{t("ver.nothingHidden")}</span>
            )}
            {fold && (
              <button
                className={`diff-tool${fold.on ? " on" : ""}`}
                onClick={fold.onToggle}
                disabled={!fold.canFold}
                title={t("ver.fold")}
                aria-label={t("ver.fold")}
                aria-pressed={fold.on}
              >
                <IconFold size={14} />
              </button>
            )}
            {wrap && (
              <button
                className={`diff-tool${wrap.on ? " on" : ""}`}
                onClick={wrap.onToggle}
                title={t("settings.wordWrap")}
                aria-label={t("settings.wordWrap")}
                aria-pressed={wrap.on}
              >
                <IconWordWrap size={14} />
              </button>
            )}
          </div>
        )}
      </div>
      <div className="diff-host">
        <DiffEditor
          original={pair.left.content}
          modified={pair.right.content}
          originalLanguage={pair.left.language}
          modifiedLanguage={pair.right.language}
          // Unique per pair: a shared URI would make two comparisons fight over one model,
          // and the editor disposes the model it did not keep on unmount.
          originalModelPath={`${base}/left`}
          modifiedModelPath={`${base}/right`}
          theme="vs-dark"
          loading={<div className="editor-empty">{t("app.loading")}</div>}
          onMount={(instance) => {
            // `tabSize` and friends live in monaco's IGlobalEditorOptions, which the diff
            // editor's construction options do not include, so they are applied to the two
            // embedded editors instead. Built as a variable: passing a literal here would
            // be re-checked against the narrower IEditorOptions and rejected.
            const indent = { tabSize, insertSpaces, detectIndentation };
            instance.getModifiedEditor().updateOptions(indent);
            instance.getOriginalEditor().updateOptions(indent);
            // The first computation can land before this listener is attached, so the
            // totals are read once here as well as on every later update.
            report(instance);
            instance.onDidUpdateDiff(() => report(instance));
          }}
          options={{
            fontSize,
            automaticLayout: true,
            readOnly: true,
            originalEditable: false,
            // Side by side is the whole point; inline would stack the two into one column.
            renderSideBySide: true,
            renderOverviewRuler: false,
            scrollBeyondLastLine,
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            renderWhitespace,
            wordWrap: wordWrap ? "on" : "off",
            ignoreTrimWhitespace: false,
          }}
        />
      </div>
    </div>
  );
}
