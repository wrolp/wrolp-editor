import MonacoEditor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/loader";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { editor } from "monaco-editor";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import monaco from "../lib/monaco";
import { t } from "../lib/i18n";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import { dirtyRanges } from "../lib/dirtyDiff";
import { isUntitled, modelUri } from "../lib/path";
import { isFileTab, type CursorPos, type EditStats, type EditorHandle, type Tab } from "../lib/types";

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
  /** Resolved scheme, not the raw setting: system has to have become dark or light. */
  theme: string;
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
  theme,
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
  /** The app's own right-click menu; Monaco's is turned off in the options below. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAt = useMenuPlacement(menu, menuRef);
  /** The tab as of this render, read by the callbacks that outlive the render that made them. */
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /** The unsaved-change marks, owned by the editor rather than by any one model. */
  const dirtyMarks = useRef<editor.IEditorDecorationsCollection | null>(null);
  const dirtyTimer = useRef<number | undefined>(undefined);
  const savedText = useRef("");
  const savedLines = useRef<string[]>([""]);

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

  /**
   * Tint the lines that differ from what the file on disk holds. The standalone editor draws no
   * such strip — the workbench does, and the library keeps its diff computer behind the diff
   * widget — so this is it, with `dirtyRanges` doing the comparison.
   *
   * Skipped for anything that cannot be saved as text: an untitled buffer has no saved version to
   * differ from, a picture has no text to differ in, and a locked file's buffer is not the file.
   */
  const reportDirty = useCallback(() => {
    const marks = dirtyMarks.current;
    const model = instanceRef.current?.getModel();
    const shown = tabRef.current;
    if (!marks || !model) return;
    if (!isFileTab(shown) || shown.isBinary || shown.locked || isUntitled(shown.path)) {
      marks.clear();
      return;
    }
    // The saved text is split when it changes, not on every pass: it is rewritten once per save,
    // while the buffer is walked on every pause between keystrokes.
    if (savedText.current !== shown.original) {
      savedText.current = shown.original;
      savedLines.current = shown.original.split(/\r\n|\r|\n/);
    }
    marks.set(
      dirtyRanges(savedLines.current, model.getLineCount(), (index) =>
        model.getLineContent(index + 1)
      ).map((run) => ({
        range: {
          startLineNumber: run.from,
          startColumn: 1,
          endLineNumber: run.to,
          endColumn: model.getLineMaxColumn(run.to),
        },
        options: {
          isWholeLine: true,
          className: run.added ? "dirty-added" : "dirty-modified",
          // The accent bar lives in the line-decorations margin, not on the tinted line itself,
          // so it has room between it and the first character.
          linesDecorationsClassName: run.added ? "dirty-gutter dirty-gutter-added" : "dirty-gutter dirty-gutter-modified",
        },
      }))
    );
  }, []);

  /**
   * Recompute the marks after a pause, so typing never waits on a walk of the file. `ms` is a
   * parameter because a model switch or a save wants the answer now, not a beat later.
   */
  const scheduleDirty = useCallback(
    (ms = 250) => {
      window.clearTimeout(dirtyTimer.current);
      dirtyTimer.current = window.setTimeout(reportDirty, ms);
    },
    [reportDirty]
  );

  const handleMount = useCallback(
    (instance: editor.IStandaloneCodeEditor, m: Monaco) => {
      instanceRef.current = instance;
      readyRef.current({ editor: instance, monaco: m });
      // The marks survive a model switch because they are the editor's, but their ranges belong
      // to whichever model is attached, so every switch recomputes them.
      dirtyMarks.current = instance.createDecorationsCollection([]);
      instance.onDidChangeModel(() => scheduleDirty(0));
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
      instance.onDidChangeModelContent(() => {
        report();
        scheduleDirty();
      });
      instance.onDidScrollChange((e) => {
        // The event carries no viewport height, so ask the editor for its layout.
        const max = e.scrollHeight - instance.getLayoutInfo().height;
        scrollRef.current(max > 0 ? e.scrollTop / max : 0);
      });
      report();
      // A tab that arrives already changed (a draft loaded at startup, a file reopened with
      // edits waiting) fires no event of its own, so the marks are drawn on mount as well.
      scheduleDirty(0);
    },
    [report, scheduleDirty]
  );

  // A new model starts empty; without this the previous tab's numbers linger until the
  // next event. The frame retry covers Monaco attaching the model after this effect.
  useEffect(() => {
    setMenu(null);
    statsRef.current({ selectionChars: 0, selectionLines: 0, totalChars: 0 });
    const raf = requestAnimationFrame(report);
    return () => cancelAnimationFrame(raf);
  }, [report, tab.path]);

  // The marks are recomputed now rather than after the typing pause whenever the tab underneath
  // moved or the file was saved: a save clears every mark, and waiting a beat for that would show
  // the previous file's changes in the new one.
  useEffect(() => {
    scheduleDirty(0);
  }, [scheduleDirty, tab.original, tab.path]);

  // No decoration outlives the editor it was drawn in, and no timer outlives this component.
  useEffect(
    () => () => {
      window.clearTimeout(dirtyTimer.current);
      dirtyMarks.current?.clear();
    },
    []
  );

  // Release the handle on unmount so async callbacks cannot touch a disposed instance.
  useEffect(() => () => readyRef.current(null), []);

  /**
   * What Copy puts on the clipboard: the selected text, or the line under each cursor when there
   * is no selection. The second half is the reason this menu exists — a menu opened over a plain
   * caret has nothing to copy otherwise.
   */
  const selectionText = useCallback((): string | null => {
    const instance = instanceRef.current;
    const model = instance?.getModel();
    if (!instance || !model) return null;
    const selections = instance.getSelections() ?? [];
    const filled = selections.filter((selection) => !selection.isEmpty());
    if (filled.length > 0) {
      return filled.map((selection) => model.getValueInRange(selection)).join("\n");
    }
    const lines = new Set<string>();
    for (const selection of selections) {
      const line = selection.positionLineNumber;
      const text = model.getLineContent(line);
      lines.add(line < model.getLineCount() ? `${text}\n` : text);
    }
    return [...lines].join("\n");
  }, []);

  /** The ranges Cut removes without a selection: whole lines, with their own line breaks. */
  const lineRanges = (model: editor.ITextModel, selections: monaco.Selection[]) => {
    const lines = [...new Set(selections.map((selection) => selection.positionLineNumber))].sort(
      (a, b) => a - b
    );
    return lines.map((line) => {
      const last = model.getLineCount();
      if (line < last) return new monaco.Range(line, 1, line + 1, 1);
      if (line > 1) {
        return new monaco.Range(
          line - 1,
          model.getLineMaxColumn(line - 1),
          line,
          model.getLineMaxColumn(line)
        );
      }
      return new monaco.Range(1, 1, 1, model.getLineMaxColumn(1));
    });
  };

  const runMenu = (action: "cut" | "copy" | "paste" | "selectAll") => {
    const instance = instanceRef.current;
    if (!instance) return;
    setMenu(null);
    const editable = !tabRef.current.locked;
    if (action === "copy") {
      const text = selectionText();
      if (text !== null) void writeText(text).catch(() => {});
      instance.focus();
      return;
    }
    if (action === "cut") {
      if (!editable) return;
      const text = selectionText() ?? "";
      void (async () => {
        // A failed clipboard write must leave the text in the document: cutting is a move, and
        // moving something to nowhere loses it.
        const copied = text.length === 0 ? true : await writeText(text).then(() => true).catch(() => false);
        if (!copied) return;
        const model = instance.getModel();
        if (!model) return;
        const selections = instance.getSelections() ?? [];
        const filled = selections.filter((selection) => !selection.isEmpty());
        const ranges = filled.length > 0 ? filled : lineRanges(model, selections);
        instance.executeEdits(
          "cut",
          ranges.map((range) => ({ range, text: "", forceMoveMarkers: true }))
        );
        instance.focus();
      })();
      return;
    }
    if (action === "paste") {
      if (!editable) return;
      instance.focus();
      // The command is redirected to the Tauri clipboard in `lib/editorMenu.ts`.
      instance.trigger("editorMenu", "editor.action.clipboardPasteAction", null);
      return;
    }
    instance.focus();
    instance.trigger("editorMenu", "editor.action.selectAll", null);
  };

  const openMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    // A right-click on the open menu is its own business; reopening it there would move it.
    if ((event.target as HTMLElement).closest(".editor-menu")) return;
    event.preventDefault();
    event.stopPropagation();
    const instance = instanceRef.current;
    if (!instance) return;
    // A right-click outside the selection puts the caret where the pointer is, which is what the
    // menu's Copy/Cut then act on. Inside a selection the selection is kept, so it can be copied.
    const target = instance.getTargetAtClientPoint(event.clientX, event.clientY);
    const position = target?.position;
    if (position) {
      const selections = instance.getSelections() ?? [];
      if (!selections.some((selection) => selection.containsPosition(position))) {
        instance.setPosition(position);
      }
    }
    setMenu({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  return (
    <div className="editor-frame" onContextMenuCapture={openMenu}>
      <MonacoEditor
        path={modelUri(tab.path)}
        defaultValue={tab.initialValue ?? tab.original}
        language={tab.language}
        theme={theme === "light" ? "vs" : "vs-dark"}
        loading={<div className="editor-empty">{t("app.loading")}</div>}
        onChange={(value) => value !== undefined && onChange(value)}
        onMount={handleMount}
        options={{
          fontSize,
          minimap: { enabled: minimap },
          automaticLayout: true,
          // A locked encrypted file is read-only rather than merely covered: text decrypted
          // earlier in the session stays on screen and stays readable, but edits typed after
          // the key was dropped could neither be saved nor drafted, so accepting them would be
          // accepting work this app cannot keep.
          readOnly: !!tab.locked,
          domReadOnly: !!tab.locked,
          // The app draws its own menu (below): Monaco's has no "copy the current line" and
          // builds its labels when the bundle loads, so they cannot follow a language switch.
          // Paste is still Monaco's command, redirected to the Tauri clipboard in
          // `src/lib/editorMenu.ts`.
          contextmenu: false,
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

      {menu && (
        <div
          className="ctx-menu editor-menu"
          ref={menuRef}
          style={{ display: "block", left: menuAt.left, top: menuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {!tab.locked && (
            <div className="ctx-item" onClick={() => runMenu("cut")}>
              {t("editor.cut")}
            </div>
          )}
          <div className="ctx-item" onClick={() => runMenu("copy")}>
            {t("editor.copy")}
          </div>
          {!tab.locked && (
            <div className="ctx-item" onClick={() => runMenu("paste")}>
              {t("editor.paste")}
            </div>
          )}
          {!tab.locked && <div className="ws-sep" />}
          <div className="ctx-item" onClick={() => runMenu("selectAll")}>
            {t("editor.selectAll")}
          </div>
        </div>
      )}
    </div>
  );
}
