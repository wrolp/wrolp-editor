import MonacoEditor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/loader";
import { useCallback, useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { t } from "../lib/i18n";
import "../lib/monaco";
import { modelUri } from "../lib/path";
import type { CursorPos, EditStats, EditorHandle, Tab } from "../lib/types";

interface Props {
  tab: Tab;
  fontSize: number;
  minimap: boolean;
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  wordWrap: boolean;
  stickyScroll: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  /** Allow scrolling past the last line instead of stopping at it. */
  scrollBeyondLastLine: boolean;
  onChange: (value: string) => void;
  onCursor: (position: CursorPos, offset: number) => void;
  /** Selection and document totals, refreshed on every selection or content change. */
  onStats: (stats: EditStats) => void;
  /** Scroll position as 0..1, so a side-by-side preview can track it. */
  onScrollRatio: (ratio: number) => void;
  onReady: (handle: EditorHandle | null) => void;
}

export default function Editor({
  tab,
  fontSize,
  minimap,
  renderWhitespace,
  wordWrap,
  stickyScroll,
  tabSize,
  insertSpaces,
  detectIndentation,
  scrollBeyondLastLine,
  onChange,
  onCursor,
  onStats,
  onScrollRatio,
  onReady,
}: Props) {
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  const scrollRef = useRef(onScrollRatio);
  scrollRef.current = onScrollRatio;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const instanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);

  /** Read the counters straight off the model; both numbers are O(1) lookups. */
  const report = useCallback(() => {
    const instance = instanceRef.current;
    const model = instance?.getModel();
    if (!instance || !model) {
      statsRef.current({ selectionChars: 0, selectionLines: 0, totalChars: 0 });
      return;
    }
    // A plain caret is not a selection, so only non-empty ranges count.
    const ranges = (instance.getSelections() ?? []).filter((s) => !s.isEmpty());
    let selectionChars = 0;
    if (ranges.length > 0) {
      // Monaco returns the ranges in document order and they never overlap across
      // cursors, so summing is exact and the first/last pair give the whole span.
      for (const range of ranges) selectionChars += model.getValueLengthInRange(range);
    }
    statsRef.current({
      selectionChars,
      selectionLines:
        ranges.length === 0
          ? 0
          : ranges[ranges.length - 1].positionLineNumber - ranges[0].selectionStartLineNumber + 1,
      totalChars: model.getValueLength(),
    });
  }, []);

  const handleMount = useCallback(
    (instance: editor.IStandaloneCodeEditor, m: Monaco) => {
      instanceRef.current = instance;
      readyRef.current({ editor: instance, monaco: m });
      // `automaticLayout` watches for size changes, but a pane that was `display: none`
      // and is now shown has no size to watch from, so the editor keeps the zero it
      // measured while hidden: the content overflows a viewport it believes is empty and
      // the wheel does nothing. One re-measure after the frame that reveals it is the fix.
      requestAnimationFrame(() => instance.layout());
      instance.onDidChangeCursorPosition((e) => {
        const model = instance.getModel();
        if (!model) return;
        cursorRef.current(e.position, model.getOffsetAt(e.position));
      });
      instance.onDidChangeCursorSelection(report);
      // Fires for typing, undo/redo and programmatic setValue (a draft restore), which
      // is why the total is taken from the model event rather than the React onChange.
      instance.onDidChangeModelContent(report);
      instance.onDidScrollChange((e) => {
        // The event carries no viewport height, so ask the editor for its layout.
        const max = e.scrollHeight - instance.getLayoutInfo().height;
        scrollRef.current(max > 0 ? e.scrollTop / max : 0);
      });
      report();
    },
    [report]
  );

  // A new model starts empty; without this the previous tab's numbers linger until the
  // next event. The frame retry covers Monaco attaching the model after this effect.
  useEffect(() => {
    statsRef.current({ selectionChars: 0, selectionLines: 0, totalChars: 0 });
    const raf = requestAnimationFrame(report);
    return () => cancelAnimationFrame(raf);
  }, [report, tab.path]);

  // Release the handle on unmount so async callbacks cannot touch a disposed instance.
  useEffect(() => () => readyRef.current(null), []);

  return (
    <MonacoEditor
      path={modelUri(tab.path)}
      defaultValue={tab.initialValue ?? tab.original}
      language={tab.language}
      theme="vs-dark"
      loading={<div className="editor-empty">{t("app.loading")}</div>}
      onChange={(value) => value !== undefined && onChange(value)}
      onMount={handleMount}
      options={{
        fontSize,
        minimap: { enabled: minimap },
        automaticLayout: true,
        tabSize,
        insertSpaces,
        // On by default so a file keeps the indentation style it was written with; the
        // two settings above then act as the fallback for files it cannot guess about.
        detectIndentation,
        // When on, the document scrolls past its end, so the last line can sit above the
        // bottom edge instead of being glued to it.
        scrollBeyondLastLine,
        fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
        renderWhitespace,
        wordWrap: wordWrap ? "on" : "off",
        // Keeps the enclosing scope pinned while scrolling a long file.
        stickyScroll: { enabled: stickyScroll },
      }}
    />
  );
}
