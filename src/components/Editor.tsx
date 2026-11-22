import MonacoEditor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/loader";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import type { editor } from "monaco-editor";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import monaco from "../lib/monaco";
import { t } from "../lib/i18n";
import { api, errorMessage } from "../lib/tauri";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import { dirtyRanges } from "../lib/dirtyDiff";
import { dirOf } from "../lib/markdownAsset";
import { isMarkdown, isUntitled, modelUri } from "../lib/path";
import { setImagePasteHandler } from "../lib/editorMenu";
import {
  isFileTab,
  type AiSelection,
  type AiSelectionAction,
  type CursorPos,
  type EditStats,
  type EditorHandle,
  type Tab,
} from "../lib/types";

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
  /** Highlight this tab as another language; null goes back to detecting it. */
  onLanguage: (language: string | null) => void;
  /** Something the editor could not do, said where every other failure is said. */
  onError: (message: string) => void;
  /** Ask for a name and write a pasted picture; resolves when the dialog is finished. */
  onRequestImageSave: (
    dir: string,
    defaultName: string,
    save: (name: string) => Promise<void>
  ) => Promise<boolean>;
  /**
   * Ask the AI about the selected text. The group appears only while a non-empty selection is
   * under the right-click; a plain caret has nothing to ask about.
   */
  onAiAction?: (action: AiSelectionAction, selected: AiSelection) => void;
}

/**
 * Every language Monaco can highlight, as `[id, label]`, sorted by the label a reader looks
 * for. Built on first use rather than at import: the registry is complete by then, and a
 * picker nobody opens costs nothing.
 */
let languageChoices: [string, string][] | null = null;
function languages(): [string, string][] {
  if (!languageChoices) {
    languageChoices = monaco.languages
      .getLanguages()
      .map((entry): [string, string] => [entry.id, entry.aliases?.[0] ?? entry.id])
      .sort((a, b) => a[1].localeCompare(b[1]));
  }
  return languageChoices;
}

/** The label Monaco uses for a language id, or the id itself when it has none. */
function languageName(id: string): string {
  return languages().find(([candidate]) => candidate === id)?.[1] ?? id;
}

/**
 * The base64 body of a pasted File.
 *
 * A paste event hands the picture over as a File, and the backend that writes it wants the
 * bytes rather than a second read of the system clipboard: what was pasted is what lands.
 * `readAsDataURL` rather than `btoa` over the array, which would exceed the argument limit
 * on a full-screen screenshot.
 */
function fileBase64(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        resolve(null);
        return;
      }
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

/** The URL-safe spelling of a file name inside a Markdown image destination. */
function markdownImageRef(name: string): string {
  return encodeURIComponent(name).replace(/\(/g, "%28").replace(/\)/g, "%29");
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
  onLanguage,
  onError,
  onRequestImageSave,
  onAiAction,
}: Props) {
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const statsRef = useRef(onStats);
  statsRef.current = onStats;
  const scrollRef = useRef(onScrollRatio);
  scrollRef.current = onScrollRatio;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const instanceRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  /** The app's own right-click menu; Monaco's is turned off in the options below. */
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  /** Which page the menu shows: the clipboard actions, or the language list. */
  const [menuPage, setMenuPage] = useState<"main" | "language">("main");
  /** What narrows the language list; cleared every time the menu opens. */
  const [languageQuery, setLanguageQuery] = useState("");
  /** What the AI group would ask about, captured when the menu opened. */
  const [menuSelection, setMenuSelection] = useState<AiSelection | null>(null);
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

  /** Hand the selection captured at open time to the AI, then give the keyboard back. */
  const runAi = (action: AiSelectionAction) => {
    const selected = menuSelection;
    if (!selected || !onAiAction) return;
    setMenu(null);
    setMenuPage("main");
    onAiAction(action, selected);
    instanceRef.current?.focus();
  };

  /**
   * Turn a clipboard picture into a named file beside the Markdown document, and a link
   * where the caret is.
   *
   * The name dialog runs before anything is written: the default is a free timestamped
   * stem, and whatever the reader types is the name the file actually gets — a taken one is
   * reported in the dialog rather than silently numbered. The picture is saved before the
   * buffer is touched: a link to a file that was never written would be a broken reference
   * the reader discovers on the next open. If the tab moves while the file is being
   * written, the link is not inserted — the model is gone and whatever is attached now is a
   * document the reader never pointed at.
   *
   * `imageData` is the paste event's own bytes. Without it — the menu's Paste, or a
   * FileReader that could not deliver — the backend reads the system clipboard instead.
   */
  const pasteImage = useCallback(
    async (instance: editor.ICodeEditor, imageData: string | null): Promise<boolean> => {
      const current = tabRef.current;
      // The menu path has only text to go on, so ask the clipboard before opening a dialog.
      const clipboardIsPicture =
        imageData !== null ||
        (await api.clipboardPasteKind().catch(() => "empty" as const)) === "image";
      if (!clipboardIsPicture) return false;
      if (!isFileTab(current) || isUntitled(current.path)) {
        errorRef.current(t("editor.imagePasteSaveFirst"));
        return true;
      }
      if (!isMarkdown(current.path)) {
        errorRef.current(t("editor.imagePasteMarkdown"));
        return true;
      }
      if (current.locked) {
        errorRef.current(t("editor.imagePasteLocked"));
        return true;
      }
      if (current.archiveSource) {
        errorRef.current(t("err.archive_read_only"));
        return true;
      }
      const model = instance.getModel();
      const selections = instance.getSelections();
      if (!model || !selections || selections.length === 0) return false;
      const dir = dirOf(current.path);
      let defaultName: string;
      try {
        defaultName = await api.pastedImageName(dir);
      } catch (e) {
        errorRef.current(errorMessage(e));
        return true;
      }
      await onRequestImageSave(dir, defaultName, async (name) => {
        const entry = imageData
          ? await api.savePastedImage(dir, imageData, name)
          : await api.pasteClipboardImage(dir, name);
        if (instanceRef.current !== instance || instance.getModel() !== model) return;
        instance.executeEdits(
          "paste-image",
          selections.map((selection) => ({
            range: selection,
            text: `![](${markdownImageRef(entry.name)})`,
            forceMoveMarkers: true,
          }))
        );
        instance.focus();
        // The picture is next to the document, so a gallery or Explorer already looking at
        // that folder is now one entry behind.
        window.dispatchEvent(new CustomEvent("wrolp:folder-changed", { detail: dir }));
      });
      return true;
    },
    [onRequestImageSave]
  );

  // The menu's Paste command lives in `lib/editorMenu.ts`, outside this component's state.
  // It asks this handler only when the clipboard carried no text.
  useEffect(() => {
    setImagePasteHandler(async (target) =>
      target === instanceRef.current ? pasteImage(target, null) : false
    );
    return () => setImagePasteHandler(null);
  }, [pasteImage]);

  /**
   * A screenshot arrives through the same Ctrl+V as text. The paste event carries the
   * clipboard's items before Monaco turns them into text, so a picture with no text beside it
   * is taken here; a clipboard carrying both is left to the ordinary text paste.
   */
  const onPasteCapture = (event: ReactClipboardEvent<HTMLDivElement>) => {
    const data = event.clipboardData;
    if (!data) return;
    let file: File | null = null;
    let text = false;
    for (const item of Array.from(data.items)) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        file ??= item.getAsFile();
      } else if (item.kind === "string") {
        text = true;
      }
    }
    // Some WebViews list the picture only through `files`, not through `items`.
    if (!file) {
      file =
        Array.from(data.files).find((candidate) => candidate.type.startsWith("image/")) ?? null;
    }
    // A rich clipboard (HTML and an image together) keeps the text paste it would otherwise
    // have; only a picture on its own is taken here.
    const hasText =
      text ||
      data.getData("text/plain") !== "" ||
      data.getData("text/html") !== "" ||
      data.getData("text/uri-list") !== "";
    if (!file || hasText) return;
    const picked = file;
    const instance = instanceRef.current;
    if (!instance) return;
    event.preventDefault();
    event.stopPropagation();
    void (async () => {
      const imageData = await fileBase64(picked);
      await pasteImage(instance, imageData);
    })();
  };

  /** Apply a language — null meaning "detect" — and hand the keyboard back to the buffer. */
  const pickLanguage = (language: string | null) => {
    setMenu(null);
    setMenuPage("main");
    setLanguageQuery("");
    onLanguage(language);
    instanceRef.current?.focus();
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
    // Captured after the caret may have moved, so a right-click outside the selection asks
    // about nothing — the selection is gone by then.
    const model = instance.getModel();
    const filled = (instance.getSelections() ?? []).filter((selection) => !selection.isEmpty());
    const selected = model
      ? filled.map((selection) => model.getValueInRange(selection)).join("\n")
      : "";
    if (selected.trim()) {
      setMenuSelection({
        text: selected,
        startLine: filled[0].startLineNumber,
        endLine: filled[filled.length - 1].endLineNumber,
      });
    } else {
      setMenuSelection(null);
    }
    // Every open starts on the actions: the language list is a page of its own, and coming
    // back to a menu already holding ninety rows would bury the four that were wanted.
    setMenuPage("main");
    setLanguageQuery("");
    setMenu({ x: event.clientX, y: event.clientY });
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // A wheel over the menu belongs to the menu: the language list is long enough to scroll,
    // and closing it on the first notch would make the list unusable.
    const onWheel = (event: WheelEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // Walked only while the page is up: the list is what the query is for, and a closed menu has
  // no reason to touch the registry.
  const query = languageQuery.trim().toLowerCase();
  const languageRows =
    menuPage === "language"
      ? languages().filter(
          ([id, label]) => !query || label.toLowerCase().includes(query) || id.includes(query)
        )
      : [];

  return (
    <div className="editor-frame" onContextMenuCapture={openMenu} onPasteCapture={onPasteCapture}>
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
          className={`ctx-menu editor-menu${menuPage === "language" ? " ctx-language" : ""}`}
          ref={menuRef}
          style={{ display: "block", left: menuAt.left, top: menuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          {menuPage === "language" ? (
            <>
              <div className="ctx-item" onClick={() => setMenuPage("main")}>
                <span className="ctx-icon">←</span>
                {t("grp.back")}
              </div>
              <div className="ws-sep" />
              <input
                className="ctx-search"
                value={languageQuery}
                onChange={(event) => setLanguageQuery(event.target.value)}
                placeholder={t("editor.languageSearch")}
                autoFocus
                spellCheck={false}
              />
              {/* Detection is an answer of its own, not the absence of one: choosing it is how
                  a hand-picked language is given back. */}
              <div className="ctx-item" onClick={() => pickLanguage(null)}>
                {t("editor.languageAuto")}
              </div>
              <div className="ws-sep" />
              {languageRows.map(([id, label]) => (
                <div key={id} className="ctx-item" onClick={() => pickLanguage(id)}>
                  {label}
                  <span className="ctx-check">{tab.language === id ? "✓" : ""}</span>
                </div>
              ))}
            </>
          ) : (
            <>
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
              {onAiAction && menuSelection && (
                <>
                  <div className="ws-sep" />
                  <div className="ctx-item" onClick={() => runAi("explain")}>
                    {t("editor.aiExplain")}
                  </div>
                  <div className="ctx-item" onClick={() => runAi("optimize")}>
                    {t("editor.aiOptimize")}
                  </div>
                  <div className="ctx-item" onClick={() => runAi("comment")}>
                    {t("editor.aiComment")}
                  </div>
                  <div className="ctx-item" onClick={() => runAi("translate")}>
                    {t("editor.aiTranslate")}
                  </div>
                </>
              )}
              <div className="ws-sep" />
              <div className="ctx-item" onClick={() => setMenuPage("language")}>
                {t("editor.language")}
                <span className="ctx-value">{languageName(tab.language)}</span>
                <span className="ctx-sub">›</span>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
