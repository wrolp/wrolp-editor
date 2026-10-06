import { useCallback, useEffect, useMemo, useRef } from "react";
import { DiffEditor, type MonacoDiffEditor } from "@monaco-editor/react";
import { t } from "../lib/i18n";
import "../lib/monaco";
import type { ComparePair, DiffStats } from "../lib/types";

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
}: Props) {
  const statsRef = useRef(onStats);
  statsRef.current = onStats;

  /**
   * Derived from the pair *in order*: swapping the two sides has to yield different URIs.
   * A stable per-tab URI would not, and the diff editor reuses whatever model already
   * sits at the path it is handed — the swap would keep showing the old sides.
   */
  const base = useMemo(
    () =>
      `inmemory://compare/${encodeURIComponent(pair.left.path)}~${encodeURIComponent(pair.right.path)}`,
    [pair.left.path, pair.right.path]
  );

  /**
   * Monaco reports changed regions, not two totals. A pure insertion has no original
   * range (0) and a pure deletion has no modified one, which is how the two sides are
   * told apart.
   */
  const report = useCallback((instance: MonacoDiffEditor) => {
    let added = 0;
    let removed = 0;
    for (const change of instance.getLineChanges() ?? []) {
      if (change.modifiedStartLineNumber > 0) {
        added += change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1;
      }
      if (change.originalStartLineNumber > 0) {
        removed += change.originalEndLineNumber - change.originalStartLineNumber + 1;
      }
    }
    statsRef.current({ added, removed });
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
