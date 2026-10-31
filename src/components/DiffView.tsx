import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiffEditor, type MonacoDiffEditor } from "@monaco-editor/react";
import { t } from "../lib/i18n";
import "../lib/monaco";
import { sideKey, type ComparePair, type DiffStats } from "../lib/types";
import type { FoldChange } from "../lib/diffFold";
import { IconFold, IconModeSplit, IconModeText, IconWordWrap } from "./icons";

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
  /**
   * The original line number behind each line of each side, when the texts have been folded.
   * A folded model is a different document whose gutter would otherwise count from 1 in every
   * hunk; absent means the texts are the files themselves and their own numbers are right.
   */
  lineNumbers?: { left: number[]; right: number[] };
  /**
   * The editor-like reading layout: unchanged stretches collapse into a "N hidden lines" row, a
   * narrow pane falls back to one column, and the header gains a split/unified switch. Absent for
   * the version dialog and the conflict comparison, whose layout stays exactly as it was.
   */
  layout?: boolean;
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
  lineNumbers,
  layout,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  /** The pane is too narrow for two columns, measured rather than guessed. */
  const [narrow, setNarrow] = useState(false);
  /**
   * The reader's own choice, or null while the width decides. Clicking the switch takes over;
   * a narrow pane opens unified without anybody asking, which is what the width is for.
   */
  const [splitChoice, setSplitChoice] = useState<boolean | null>(null);
  const sideBySide = splitChoice ?? !narrow;

  useEffect(() => {
    if (!layout) return;
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setNarrow(host.clientWidth > 0 && host.clientWidth < 720);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [layout]);

  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  const changesRef = useRef(onChanges);
  changesRef.current = onChanges;
  /** The mounted diff editor, so the gutter can be re-pointed when the fold changes. */
  const diffRef = useRef<MonacoDiffEditor | null>(null);
  const numbersRef = useRef(lineNumbers);
  numbersRef.current = lineNumbers;
  /** The switch as it is *now*, so a toggle that lands before Monaco finishes mounting wins. */
  const wrapRef = useRef(wordWrap);
  wrapRef.current = wordWrap;

  /**
   * Point each side's gutter at the original line behind it.
   *
   * `lineNumbers` as a function is the only way to do this without rewriting the text: the
   * alternative — putting the number into the line — would make it editable content and show
   * up in a copy. The argument is 1-based, and beyond the map there is nothing better to say
   * than the line's own number.
   */
  const applyLineNumbers = (instance: MonacoDiffEditor | null) => {
    if (!instance) return;
    const maps = numbersRef.current;
    const sides: ["left" | "right", number[] | undefined][] = [
      ["left", maps?.left],
      ["right", maps?.right],
    ];
    for (const [side, numbers] of sides) {
      const target = side === "left" ? instance.getOriginalEditor() : instance.getModifiedEditor();
      if (!numbers || numbers.length === 0) {
        target.updateOptions({ lineNumbers: "on" });
        continue;
      }
      const widest = String(Math.max(...numbers)).length;
      target.updateOptions({
        lineNumbers: (line: number) =>
          line >= 1 && line <= numbers.length ? String(numbers[line - 1]) : String(line),
        lineNumbersMinChars: Math.max(3, widest),
      });
    }
  };

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

  // Re-point both gutters whenever the fold changes. The models are rebuilt with the folded
  // texts, but `lineNumbers` is an editor option and lives on the editor, not the model.
  useEffect(() => {
    applyLineNumbers(diffRef.current);
  }, [lineNumbers]);

  /**
   * Wrapping is set on the two embedded editors as well as on the diff widget.
   *
   * The diff editor's own `wordWrap` is not reliably pushed to both sides in this version —
   * toggling it could leave the original column unwrapped while the modified one folded over,
   * which is the one thing side-by-side must never do. Setting both explicitly keeps the two
   * columns on the same setting, before and after a toggle.
   */
  useEffect(() => {
    const instance = diffRef.current;
    if (!instance) return;
    const option = {
      wordWrap: wordWrap ? "on" : "off",
      // The override layers are what the diff editor itself writes (`diffWordWrap` lands in
      // `wordWrapOverride1`), so the switch is set on the layer above it too: whatever the
      // widget re-applies on its own options pass cannot outrank this.
      wordWrapOverride2: wordWrap ? "on" : "off",
    } as const;
    instance.getOriginalEditor().updateOptions(option);
    instance.getModifiedEditor().updateOptions(option);
    // Also after a split/unified switch: the diff editor turns wrapping off on the original
    // side while it is the hidden column, and does not put it back when both are shown again.
  }, [wordWrap, sideBySide]);

  return (
    <div className="diff-view" title={t("cmp.readOnly")}>
      <div className="diff-head">
        <span className="diff-name" title={pair.left.path}>
          {pair.left.name}
        </span>
        <span className="diff-name" title={pair.right.path}>
          {pair.right.name}
        </span>
        {(fold || wrap || layout) && (
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
            {layout && (
              <button
                className={`diff-tool${sideBySide ? " on" : ""}`}
                onClick={() => setSplitChoice(!sideBySide)}
                // The picture is what the click will switch *to*, like the other two switches.
                title={t(sideBySide ? "cmp.unifiedView" : "cmp.splitView")}
                aria-label={t(sideBySide ? "cmp.unifiedView" : "cmp.splitView")}
                aria-pressed={sideBySide}
              >
                {sideBySide ? <IconModeText size={14} /> : <IconModeSplit size={14} />}
              </button>
            )}
          </div>
        )}
      </div>
      <div className="diff-host" ref={hostRef}>
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
            diffRef.current = instance;
            // `tabSize` and friends live in monaco's IGlobalEditorOptions, which the diff
            // editor's construction options do not include, so they are applied to the two
            // embedded editors instead. Built as a variable: passing a literal here would
            // be re-checked against the narrower IEditorOptions and rejected.
            const indent = { tabSize, insertSpaces, detectIndentation };
            instance.getModifiedEditor().updateOptions(indent);
            instance.getOriginalEditor().updateOptions(indent);
            // Both sides wrap or neither does: see the `wordWrap` effect above.
            const wrapping = {
              wordWrap: wrapRef.current ? "on" : "off",
              wordWrapOverride2: wrapRef.current ? "on" : "off",
            } as const;
            instance.getOriginalEditor().updateOptions(wrapping);
            instance.getModifiedEditor().updateOptions(wrapping);
            applyLineNumbers(instance);
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
            // Split by default, one column when the pane is too narrow or the reader asks for it.
            renderSideBySide: layout ? sideBySide : true,
            // The width is decided here rather than by Monaco's own fallback, which would keep
            // forcing one column on a narrow pane after the reader had asked for split.
            useInlineViewWhenSpaceIsLimited: !layout,
            // VS Code's reading aid: unchanged stretches fold into a "N hidden lines" row that
            // can be opened again.
            hideUnchangedRegions: layout
              ? { enabled: true, contextLineCount: 3, minimumLineCount: 3, revealLineCount: 20 }
              : undefined,
            // Defaults are on; named so a reader does not have to look them up. The revert arrow
            // only appears while the modified side is editable, which this read-only view is not.
            renderMarginRevertIcon: true,
            renderOverviewRuler: false,
            scrollBeyondLastLine,
            fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
            renderWhitespace,
            wordWrap: wordWrap ? "on" : "off",
            // The diff editor's own switch, so the two panes are told explicitly rather than
            // inheriting whatever default this version applies.
            diffWordWrap: wordWrap ? "on" : "off",
            ignoreTrimWhitespace: false,
          }}
        />
      </div>
    </div>
  );
}
