import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor, { type Monaco } from "@monaco-editor/react";
import { Range, editor as monacoEditor } from "monaco-editor";
import "../lib/monaco";
import { errorMessage } from "../lib/tauri";
import { api } from "../lib/tauri";
import { t } from "../lib/i18n";
import {
  alignSides,
  conflictChoice,
  parseConflicts,
  type MergeConflictSegment,
  type MergeParseResult,
} from "../lib/mergeConflicts";
import type { MergeTabData } from "../lib/types";

interface Props {
  data: MergeTabData;
  /** `vs` or `vs-dark`, matching the application theme. */
  theme: "vs" | "vs-dark";
  language: string;
  fontSize: number;
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  scrollBeyondLastLine: boolean;
  onDirty: (dirty: boolean) => void;
  /** Keep the tab's snapshot in step so switching tabs does not lose block decisions. */
  onResult: (text: string) => void;
  /** The conflict was written (or removed); close the tab and refresh. */
  onApplied: () => void;
  onClose: () => void;
  onError: (message: string) => void;
}

const PARSE_DELAY_MS = 150;

function stripCrlf(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function editorOptions(props: Props, readOnly: boolean) {
  return {
    fontSize: props.fontSize,
    automaticLayout: true,
    readOnly,
    scrollBeyondLastLine: props.scrollBeyondLastLine,
    renderWhitespace: props.renderWhitespace,
    wordWrap: props.wordWrap ? ("on" as const) : ("off" as const),
    tabSize: props.tabSize,
    insertSpaces: props.insertSpaces,
    detectIndentation: props.detectIndentation,
    minimap: { enabled: false },
    fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
    stickyScroll: { enabled: false },
  };
}

export default function MergeView(props: Props) {
  const { data } = props;
  const initial = useMemo(() => stripCrlf(data.merged), [data.merged]);
  const baseline = useMemo(() => stripCrlf(data.originalMerged), [data.originalMerged]);
  const oursText = useMemo(() => stripCrlf(data.ours ?? ""), [data.ours]);
  const theirsText = useMemo(() => stripCrlf(data.theirs ?? ""), [data.theirs]);
  const [parsed, setParsed] = useState<MergeParseResult>(() => parseConflicts(initial));
  const [ready, setReady] = useState(0);
  const [applying, setApplying] = useState(false);
  const [deleteAsk, setDeleteAsk] = useState(false);
  const parsedRef = useRef(parsed);
  parsedRef.current = parsed;
  const dirtyRef = useRef(false);
  const onDirtyRef = useRef(props.onDirty);
  onDirtyRef.current = props.onDirty;
  const onResultRef = useRef(props.onResult);
  onResultRef.current = props.onResult;
  const applyRef = useRef<() => void>(() => {});
  const parseTimer = useRef<number | undefined>(undefined);

  const resultRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const oursRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const theirsRef = useRef<monacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorations = useRef<Record<"result" | "ours" | "theirs", string[]>>({
    result: [],
    ours: [],
    theirs: [],
  });
  const widgets = useRef<monacoEditor.IContentWidget[]>([]);
  const syncing = useRef(false);
  /** The three models this view created; disposed together when the tab closes. */
  const modelPaths = useMemo(
    () => ({
      ours: `merge://${encodeURIComponent(data.path)}/${Math.random().toString(36).slice(2)}/ours`,
      result: `merge://${encodeURIComponent(data.path)}/${Math.random().toString(36).slice(2)}/result`,
      theirs: `merge://${encodeURIComponent(data.path)}/${Math.random().toString(36).slice(2)}/theirs`,
    }),
    [data.path]
  );

  const aligned = useMemo(
    () => alignSides(parsed.conflicts, oursText, theirsText),
    [parsed.conflicts, oursText, theirsText]
  );

  const apply = useCallback(async () => {
    const editor = resultRef.current;
    if (!editor || applying) return;
    const current = parseConflicts(editor.getValue());
    if (!current.ok || current.conflicts.length > 0) {
      setParsed(current);
      return;
    }
    setApplying(true);
    try {
      if (data.ours === null && data.theirs === null) {
        await api.gitDeleteResolution(data.root, data.path);
      } else {
        await api.gitWriteResolution(data.root, data.path, editor.getValue());
      }
      props.onApplied();
    } catch (error) {
      props.onError(errorMessage(error));
      const raw = typeof error === "string" ? error : "";
      if (raw.startsWith("git_not_conflicted")) props.onApplied();
    } finally {
      setApplying(false);
    }
  }, [applying, data, props]);
  applyRef.current = () => void apply();

  const deleteFile = useCallback(async () => {
    if (applying) return;
    setApplying(true);
    try {
      await api.gitDeleteResolution(data.root, data.path);
      props.onApplied();
    } catch (error) {
      props.onError(errorMessage(error));
      const raw = typeof error === "string" ? error : "";
      if (raw.startsWith("git_not_conflicted")) props.onApplied();
    } finally {
      setApplying(false);
    }
  }, [applying, data, props]);

  const replaceBlock = useCallback(
    (conflict: MergeConflictSegment, choice: "ours" | "theirs" | "both") => {
      const editor = resultRef.current;
      if (!editor) return;
      const model = editor.getModel();
      if (!model) return;
      // The widget was built for the current parse, but an edit may have landed between the
      // click and this call; derive the block again from the live model.
      const live = parseConflicts(model.getValue());
      const block = live.conflicts.find(
        (item) => item.from === conflict.from && item.startMarker === conflict.startMarker
      );
      if (!block) return;
      const eol = model.getEOL();
      const text = conflictChoice(block, choice).replace(/\n/g, eol);
      const lastLine = model.getLineCount();
      const range =
        block.to + 1 < lastLine
          ? new Range(block.from + 1, 1, block.to + 2, 1)
          : new Range(
              block.from + 1,
              1,
              block.to + 1,
              model.getLineMaxColumn(block.to + 1)
            );
      const insert = block.to + 1 < lastLine && text !== "" ? `${text}${eol}` : text;
      editor.executeEdits("merge", [{ range, text: insert, forceMoveMarkers: true }]);
      editor.pushUndoStop();
      const value = editor.getValue();
      const next = parseConflicts(value);
      parsedRef.current = next;
      setParsed(next);
      onResultRef.current(value);
      onDirtyRef.current(true);
    },
    []
  );

  const jump = useCallback(
    (direction: 1 | -1) => {
      const editor = resultRef.current;
      const conflicts = parsedRef.current.conflicts;
      if (!editor || conflicts.length === 0) return;
      const line = editor.getPosition()?.lineNumber ?? 1;
      const sorted = conflicts.map((conflict) => conflict.from + 1).sort((a, b) => a - b);
      if (direction === 1) {
        const next = sorted.find((item) => item > line) ?? sorted[0];
        editor.revealLineInCenter(next);
        editor.setPosition({ lineNumber: next, column: 1 });
      } else {
        const previous = [...sorted].reverse().find((item) => item < line) ?? sorted[sorted.length - 1];
        editor.revealLineInCenter(previous);
        editor.setPosition({ lineNumber: previous, column: 1 });
      }
    },
    []
  );

  /** Line on one side that belongs with a line on the other, using conflict starts as anchors. */
  const mapLine = useCallback(
    (from: "result" | "ours" | "theirs", to: "result" | "ours" | "theirs", line: number) => {
      const pairs: { from: number; to: number }[] = [{ from: 1, to: 1 }];
      for (const conflict of parsedRef.current.conflicts) {
        const side = aligned.get(conflict.from);
        const range = to === "ours" ? side?.ours : to === "theirs" ? side?.theirs : null;
        if (to === "result") {
          const source = from === "ours" ? side?.ours : side?.theirs;
          if (source) pairs.push({ from: source.from + 1, to: conflict.from + 1 });
        } else if (range) {
          pairs.push({ from: conflict.from + 1, to: range.from + 1 });
        }
      }
      pairs.sort((a, b) => a.from - b.from);
      let previous = pairs[0];
      let next: { from: number; to: number } | null = null;
      for (const pair of pairs) {
        if (pair.from <= line) previous = pair;
        else {
          next = pair;
          break;
        }
      }
      if (next && next.from > previous.from) {
        const ratio = (line - previous.from) / (next.from - previous.from);
        return Math.round(previous.to + ratio * (next.to - previous.to));
      }
      return Math.max(1, previous.to + (line - previous.from));
    },
    [aligned]
  );

  const syncScrollers = useCallback(
    (source: "result" | "ours" | "theirs") => {
      if (syncing.current) return;
      const editors = { result: resultRef.current, ours: oursRef.current, theirs: theirsRef.current };
      const from = editors[source];
      if (!from) return;
      const top = from.getVisibleRanges()[0]?.startLineNumber ?? 1;
      syncing.current = true;
      for (const targetKey of ["result", "ours", "theirs"] as const) {
        if (targetKey === source) continue;
        const target = editors[targetKey];
        if (!target) continue;
        target.revealLineNearTop(Math.max(1, mapLine(source, targetKey, top)));
      }
      window.setTimeout(() => {
        syncing.current = false;
      }, 0);
    },
    [mapLine]
  );

  // Decorations and the per-block widgets are rebuilt from the latest parse. The result
  // editor's blocks move as edits land; the sides are aligned by their own line ranges.
  useEffect(() => {
    if (!ready) return;
    const result = resultRef.current;
    const ours = oursRef.current;
    const theirs = theirsRef.current;
    if (!result || !ours || !theirs) return;

    const resultDecorations = parsed.conflicts.map((conflict) => ({
      range: new Range(conflict.from + 1, 1, conflict.to + 1, 1),
      options: {
        isWholeLine: true,
        className: "merge-conflict-line",
        linesDecorationsClassName: "merge-conflict-gutter",
      },
    }));
    decorations.current.result = result.deltaDecorations(
      decorations.current.result,
      resultDecorations
    );

    const sideDecorations = (
      ranges: ("ours" | "theirs")[]
    ) => {
      const out: monacoEditor.IModelDeltaDecoration[] = [];
      for (const conflict of parsed.conflicts) {
        const alignedSide = aligned.get(conflict.from);
        for (const side of ranges) {
          const range = alignedSide?.[side];
          if (!range) continue;
          out.push({
            range: new Range(range.from + 1, 1, range.to + 1, 1),
            options: { isWholeLine: true, className: "merge-side-line" },
          });
        }
      }
      return out;
    };
    decorations.current.ours = ours.deltaDecorations(
      decorations.current.ours,
      sideDecorations(["ours"])
    );
    decorations.current.theirs = theirs.deltaDecorations(
      decorations.current.theirs,
      sideDecorations(["theirs"])
    );

    for (const widget of widgets.current) result.removeContentWidget(widget);
    widgets.current = [];
    parsed.conflicts.forEach((conflict, index) => {
      const dom = document.createElement("div");
      dom.className = "merge-widget";
      const button = (label: string, action: () => void) => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = "merge-widget-btn";
        element.textContent = label;
        element.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          action();
        });
        dom.appendChild(element);
      };
      button(t("merge.ours"), () => replaceBlock(conflict, "ours"));
      button(t("merge.theirs"), () => replaceBlock(conflict, "theirs"));
      button(t("merge.both"), () => replaceBlock(conflict, "both"));
      button(t("merge.undo"), () => resultRef.current?.trigger("merge", "undo", null));
      const widget: monacoEditor.IContentWidget = {
        getId: () => `merge-block-${conflict.from}-${index}`,
        getDomNode: () => dom,
        getPosition: () => ({
          position: { lineNumber: conflict.from + 1, column: 1 },
          preference: [monacoEditor.ContentWidgetPositionPreference.ABOVE],
        }),
      };
      widgets.current.push(widget);
      result.addContentWidget(widget);
    });
  }, [ready, parsed, aligned, replaceBlock]);

  useEffect(
    () => () => {
      for (const widget of widgets.current) resultRef.current?.removeContentWidget(widget);
      widgets.current = [];
      const monaco = monacoRef.current;
      if (!monaco) return;
      for (const path of Object.values(modelPaths)) {
        const model = monaco.editor.getModel(monaco.Uri.parse(path));
        model?.dispose();
      }
    },
    [modelPaths]
  );

  const unresolved = parsed.ok ? parsed.conflicts.length : 0;
  const noContent = data.ours === null && data.theirs === null;
  const canApply = parsed.ok && unresolved === 0 && !applying && !noContent;

  return (
    <div className="merge-view">
      <div className="merge-toolbar">
        <button className="merge-tool" onClick={() => jump(-1)} title={t("merge.prevTitle")}>
          ↑
        </button>
        <button className="merge-tool" onClick={() => jump(1)} title={t("merge.nextTitle")}>
          ↓
        </button>
        <span className={`merge-count${unresolved > 0 ? " pending" : ""}`}>
          {parsed.ok
            ? unresolved > 0
              ? t("merge.unresolved", { n: unresolved })
              : t("merge.ready")
            : t(
                parsed.problem === "diff3"
                  ? "merge.diff3"
                  : parsed.problem === "unterminated"
                    ? "merge.unterminated"
                    : "merge.unordered"
              )}
        </span>
        <span className="merge-spacer" />
        <button
          className="merge-tool"
          title={t("merge.undoTitle")}
          onClick={() => resultRef.current?.trigger("merge", "undo", null)}
        >
          {t("merge.undo")}
        </button>
        <button
          className="merge-tool primary"
          disabled={!canApply}
          onClick={() => void apply()}
        >
          {applying ? t("merge.applying") : t("merge.apply")}
        </button>
        <button className="merge-tool" onClick={props.onClose}>
          {t("merge.close")}
        </button>
      </div>

      {(data.ours === null || data.theirs === null) && (
        <div className="merge-banner">
          <span>
            {noContent ? t("merge.bothDeleted") : t("merge.oneDeleted")}
          </span>
          {deleteAsk ? (
            <>
              <button className="merge-tool danger" disabled={applying} onClick={() => void deleteFile()}>
                {t("merge.deleteConfirm")}
              </button>
              <button className="merge-tool" onClick={() => setDeleteAsk(false)}>
                {t("merge.cancel")}
              </button>
            </>
          ) : (
            <button className="merge-tool" onClick={() => setDeleteAsk(true)}>
              {t("merge.deleteFile")}
            </button>
          )}
        </div>
      )}

      <div className="merge-panes">
        <section className="merge-pane">
          <div className="merge-head">
            {t("merge.oursHead")}
            <span className="merge-head-note">{t("merge.readonly")}</span>
          </div>
          <div className="merge-editor">
            <Editor
              path={modelPaths.ours}
              defaultValue={oursText}
              language={props.language}
              theme={props.theme}
              options={editorOptions(props, true)}
              onMount={(editor, monaco) => {
                oursRef.current = editor;
                monacoRef.current = monaco;
                editor.onDidScrollChange(() => syncScrollers("ours"));
                setReady((value) => value + 1);
              }}
            />
          </div>
        </section>
        <section className="merge-pane result">
          <div className="merge-head">
            {t("merge.resultHead")}
            <span className="merge-head-note">{t("merge.editable")}</span>
          </div>
          <div className="merge-editor">
            <Editor
              path={modelPaths.result}
              defaultValue={initial}
              language={props.language}
              theme={props.theme}
              options={editorOptions(props, false)}
              onMount={(editor, monaco) => {
                resultRef.current = editor;
                monacoRef.current = monaco;
                editor.onDidScrollChange(() => syncScrollers("result"));
                editor.onDidChangeModelContent(() => {
                  const dirty = editor.getValue() !== baseline;
                  if (dirty !== dirtyRef.current) {
                    dirtyRef.current = dirty;
                    onDirtyRef.current(dirty);
                  }
                  window.clearTimeout(parseTimer.current);
                  parseTimer.current = window.setTimeout(() => {
                    const text = editor.getValue();
                    onResultRef.current(text);
                    const next = parseConflicts(text);
                    parsedRef.current = next;
                    setParsed(next);
                  }, PARSE_DELAY_MS);
                });
                editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
                  applyRef.current();
                });
                editor.addCommand(monaco.KeyCode.F7, () => jump(1));
                editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.F7, () => jump(-1));
                setReady((value) => value + 1);
              }}
            />
          </div>
        </section>
        <section className="merge-pane">
          <div className="merge-head">
            {t("merge.theirsHead")}
            <span className="merge-head-note">{t("merge.readonly")}</span>
          </div>
          <div className="merge-editor">
            <Editor
              path={modelPaths.theirs}
              defaultValue={theirsText}
              language={props.language}
              theme={props.theme}
              options={editorOptions(props, true)}
              onMount={(editor, monaco) => {
                theirsRef.current = editor;
                monacoRef.current = monaco;
                editor.onDidScrollChange(() => syncScrollers("theirs"));
                setReady((value) => value + 1);
              }}
            />
          </div>
        </section>
      </div>
    </div>
  );
}
