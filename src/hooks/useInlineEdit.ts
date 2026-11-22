import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  Range as MonacoRange,
  editor as monacoEditor,
} from "monaco-editor";
import type { EditorHandle } from "../lib/types";
import { t, translateError } from "../lib/i18n";
import { api, type AiChatEvent, type AiEditRequest } from "../lib/tauri";

/** The same batched-render interval the chat panel uses. */
const FLUSH_MS = 50;

export type InlineEditPhase = "idle" | "input" | "generating" | "preview" | "error";

export interface AiInlineEditController {
  /** The DOM node a portal renders the panel into; null while no edit is open. */
  node: HTMLElement | null;
  phase: InlineEditPhase;
  instruction: string;
  preview: string;
  error: string | null;
  setInstruction: (text: string) => void;
  submit: () => void;
  apply: () => void;
  cancel: () => void;
  retry: () => void;
  /** Re-anchor the content widget after its contents changed height. */
  layout: () => void;
}

interface Options {
  enabled: boolean;
  handle: EditorHandle | null;
}

interface EditSession {
  editor: EditorHandle["editor"];
  model: monacoEditor.ITextModel;
  range: MonacoRange;
  selected: string;
  before: string;
  after: string;
  versionId: number;
  widget: monacoEditor.IContentWidget;
  decorations: string[];
  opId: string | null;
}

/**
 * `Ctrl+I` on the main editor: ask for a rewrite of the selection (or the current line),
 * preview it inside the editor, and write it only when the reader accepts.
 *
 * The model is never touched before `Enter`; the original range is marked while the answer
 * streams and the replacement is shown in a content widget above it. A document edited while
 * the answer was being written is refused on apply — the range the answer was written for is
 * no longer the range that is there.
 */
export function useInlineEdit({ enabled, handle }: Options): AiInlineEditController {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const [phase, setPhase] = useState<InlineEditPhase>("idle");
  const [instruction, setInstructionState] = useState("");
  const [preview, setPreviewState] = useState("");
  const [error, setError] = useState<string | null>(null);

  const session = useRef<EditSession | null>(null);
  const handleRef = useRef(handle);
  handleRef.current = handle;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const instructionRef = useRef("");
  const previewRef = useRef("");
  const flushTimer = useRef<number | null>(null);
  const startRef = useRef<() => void>(() => {});

  const setInstruction = useCallback((text: string) => {
    instructionRef.current = text;
    setInstructionState(text);
  }, []);

  const clearTimer = useCallback(() => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
  }, []);

  /** Leave the editor as it is and take the widget down. */
  const close = useCallback(
    (focus: boolean) => {
      const active = session.current;
      session.current = null;
      clearTimer();
      if (active) {
        if (active.opId) void api.aiCancel(active.opId).catch(() => undefined);
        try {
          active.model.deltaDecorations(active.decorations, []);
        } catch {
          // The model went away with a closed tab.
        }
        try {
          active.editor.removeContentWidget(active.widget);
        } catch {
          // The editor was disposed first.
        }
        if (focus) {
          try {
            active.editor.focus();
          } catch {
            // Same.
          }
        }
      }
      previewRef.current = "";
      instructionRef.current = "";
      setPreviewState("");
      setInstructionState("");
      setNode(null);
      setPhase("idle");
      setError(null);
    },
    [clearTimer]
  );

  const start = useCallback(() => {
    const current = handleRef.current;
    if (!enabledRef.current || !current) return;
    const { editor, monaco } = current;
    const model = editor.getModel();
    if (!model) return;
    if (editor.getOption(monaco.editor.EditorOption.readOnly)) return;
    close(false);

    const selection = editor.getSelection();
    let range: MonacoRange;
    if (selection && !selection.isEmpty()) {
      const from = selection.getStartPosition();
      const to = selection.getEndPosition();
      range = new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column);
    } else {
      const line = editor.getPosition()?.lineNumber ?? 1;
      range = new monaco.Range(line, 1, line, model.getLineMaxColumn(line));
    }

    const selected = model.getValueInRange(range);
    const before = model.getValueInRange(
      new monaco.Range(1, 1, range.startLineNumber, range.startColumn)
    );
    const lastLine = model.getLineCount();
    const after = model.getValueInRange(
      new monaco.Range(
        range.endLineNumber,
        range.endColumn,
        lastLine,
        model.getLineMaxColumn(lastLine)
      )
    );

    const domNode = document.createElement("div");
    domNode.className = "ai-edit-portal";
    const widget: monacoEditor.IContentWidget = {
      getId: () => "wrolp.ai.inlineEdit",
      getDomNode: () => domNode,
      getPosition: () => ({
        position: { lineNumber: range.startLineNumber, column: range.startColumn },
        preference: [
          monaco.editor.ContentWidgetPositionPreference.ABOVE,
          monaco.editor.ContentWidgetPositionPreference.BELOW,
        ],
      }),
      allowEditorOverflow: true,
    };
    const decorations = model.deltaDecorations(
      [],
      [{ range, options: { className: "ai-edit-original" } }]
    );
    editor.addContentWidget(widget);

    session.current = {
      editor,
      model,
      range,
      selected,
      before,
      after,
      versionId: model.getVersionId(),
      widget,
      decorations,
      opId: null,
    };
    previewRef.current = "";
    instructionRef.current = "";
    setPreviewState("");
    setInstructionState("");
    setError(null);
    setPhase("input");
    setNode(domNode);
  }, [close]);
  startRef.current = start;

  const submit = useCallback(() => {
    const active = session.current;
    if (!active) return;
    const instruction = instructionRef.current.trim();
    if (!instruction) {
      setError(t("err.ai_no_instruction"));
      return;
    }
    if (active.opId) void api.aiCancel(active.opId).catch(() => undefined);
    const opId = crypto.randomUUID();
    active.opId = opId;
    clearTimer();
    previewRef.current = "";
    setPreviewState("");
    setError(null);
    setPhase("generating");

    const request: AiEditRequest = {
      opId,
      instruction,
      selected: active.selected,
      before: active.before,
      after: active.after,
      language: active.model.getLanguageId(),
    };
    const onEvent = (event: AiChatEvent) => {
      const current = session.current;
      if (!current || current.opId !== opId) return;
      if (event.type === "delta") {
        previewRef.current += event.text;
        if (flushTimer.current === null) {
          flushTimer.current = window.setTimeout(() => {
            flushTimer.current = null;
            setPreviewState(previewRef.current);
          }, FLUSH_MS);
        }
        return;
      }
      clearTimer();
      if (event.type === "done") {
        previewRef.current = event.text;
        setPreviewState(event.text);
        current.opId = null;
        setPhase("preview");
        return;
      }
      current.opId = null;
      setError(
        translateError(`${event.code}${event.detail ? `:${event.detail}` : ""}`)
      );
      setPhase("error");
    };

    void api.aiEdit(request, onEvent).catch((e) => {
      const current = session.current;
      if (!current || current.opId !== opId) return;
      clearTimer();
      current.opId = null;
      const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      setError(translateError(raw));
      setPhase("error");
    });
  }, [clearTimer]);

  const apply = useCallback(() => {
    const active = session.current;
    if (!active) return;
    if (
      active.model.isDisposed() ||
      active.model.getVersionId() !== active.versionId
    ) {
      setError(t("err.ai_selection_changed"));
      setPhase("error");
      return;
    }
    const text = previewRef.current;
    close(false);
    try {
      active.editor.pushUndoStop();
      active.editor.executeEdits("ai-edit", [
        { range: active.range, text, forceMoveMarkers: true },
      ]);
      active.editor.pushUndoStop();
    } catch {
      // The editor went away between the check and the edit.
    }
    try {
      active.editor.focus();
    } catch {
      // Same.
    }
  }, [close]);

  const cancel = useCallback(() => close(true), [close]);

  const retry = useCallback(() => {
    setError(null);
    submit();
  }, [submit]);

  const layout = useCallback(() => {
    const active = session.current;
    if (!active) return;
    try {
      active.editor.layoutContentWidget(active.widget);
    } catch {
      // The editor is gone.
    }
  }, []);

  useEffect(() => {
    const current = handleRef.current;
    if (!current || !enabled) return;
    const action = current.editor.addAction({
      id: "wrolp.ai.inlineEdit",
      label: "AI inline edit",
      keybindings: [
        current.monaco.KeyMod.CtrlCmd | current.monaco.KeyCode.KeyI,
      ],
      run: () => startRef.current(),
    });
    return () => action.dispose();
  }, [enabled, handle]);

  useEffect(() => {
    if (!handle) return;
    const listener = handle.editor.onDidChangeModel(() => close(false));
    return () => listener.dispose();
  }, [handle, close]);

  useEffect(() => {
    if (enabled) return;
    close(false);
  }, [enabled, close]);

  useEffect(() => () => close(false), [close]);

  useEffect(() => {
    if (phase === "idle") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
        return;
      }
      if (phase !== "preview" || event.key !== "Enter" || event.shiftKey) return;
      const tag = (event.target as HTMLElement | null)?.tagName;
      // A focused button activates itself; a textarea/input is still being typed in.
      if (tag === "BUTTON" || tag === "INPUT" || tag === "TEXTAREA") return;
      event.preventDefault();
      event.stopPropagation();
      apply();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [phase, close, apply]);

  return useMemo(
    () => ({
      node,
      phase,
      instruction,
      preview,
      error,
      setInstruction,
      submit,
      apply,
      cancel,
      retry,
      layout,
    }),
    [
      node,
      phase,
      instruction,
      preview,
      error,
      setInstruction,
      submit,
      apply,
      cancel,
      retry,
      layout,
    ]
  );
}
