import { useEffect, useRef, useState } from "react";
import type {
  CancellationToken,
  Position,
  editor as monacoEditor,
  languages as monacoLanguages,
} from "monaco-editor";
import type { EditorHandle } from "../lib/types";
import { api } from "../lib/tauri";

/** How long a pause Monaco waits for before asking, set on the provider. */
const DEBOUNCE_MS = 300;

interface Options {
  enabled: boolean;
  /** The mounted editor, or null while none is on screen. */
  handle: EditorHandle | null;
  /** Files larger than this are only completed when asked for by `Alt+\`. */
  maxFileSize: number;
}

export interface InlineCompletionState {
  /** A request is in flight; the status bar says so while it is. */
  busy: boolean;
}

/**
 * Inline completions for the main editor.
 *
 * The provider is registered once per mounted editor and takes over the editor's own caret
 * suggestions. Monaco cancels the previous request when the caret moves on, and the backend is
 * told to drop it too; every failure — no key, an endpoint that is down, a malformed answer —
 * is silent, because a completion is a guess offered while typing and an error toast over it
 * is only noise.
 */
export function useInlineCompletion({
  enabled,
  handle,
  maxFileSize,
}: Options): InlineCompletionState {
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(0);
  const manual = useRef(false);
  const maxSizeRef = useRef(maxFileSize);
  maxSizeRef.current = maxFileSize;

  useEffect(() => {
    const setInline = (on: boolean) => {
      try {
        handle?.editor.updateOptions({
          inlineSuggest: {
            enabled: on,
            // The ordinary suggest list opens on most keystrokes; without this the ghost text
            // would be suppressed by it, which reads as "inline completion never works".
            experimental: { showOnSuggestConflict: "always" },
          } as unknown as monacoEditor.IEditorOptions["inlineSuggest"],
        });
      } catch {
        // The editor was disposed in the same commit that made the handle null.
      }
    };
    if (!handle || !enabled) {
      setInline(false);
      inFlight.current = 0;
      setBusy(false);
      return;
    }
    const { editor, monaco } = handle;
    let disposed = false;
    setInline(true);

    const provider = monaco.languages.registerInlineCompletionsProvider("*", {
      debounceDelayMs: DEBOUNCE_MS,
      async provideInlineCompletions(
        model: monacoEditor.ITextModel,
        position: Position,
        _context: monacoLanguages.InlineCompletionContext,
        token: CancellationToken
      ) {
        if (disposed || token.isCancellationRequested) return { items: [] };
        // The registry is global: a comparison or merge editor has a model of its own, and
        // its text is a snapshot that must never be completed.
        if (model !== editor.getModel() || !editor.hasTextFocus()) return { items: [] };
        const asked = manual.current;
        manual.current = false;
        if (!asked && model.getValueLength() > maxSizeRef.current) return { items: [] };

        const text = model.getValue();
        const offset = model.getOffsetAt(position);
        const prefix = text.slice(0, offset);
        const suffix = text.slice(offset);
        if (!prefix && !suffix) return { items: [] };

        const opId = crypto.randomUUID();
        const listener = token.onCancellationRequested(() => {
          void api.aiCancel(opId).catch(() => undefined);
        });
        inFlight.current += 1;
        setBusy(true);
        try {
          const completion = await api.aiComplete(
            opId,
            prefix,
            suffix,
            model.getLanguageId()
          );
          if (token.isCancellationRequested) return { items: [] };
          // Trailing line breaks would put an empty line after the ghost text; leading
          // whitespace is indentation and has to stay.
          const insertText = completion.replace(/[\r\n]+$/, "");
          return insertText ? { items: [{ insertText }] } : { items: [] };
        } catch {
          return { items: [] };
        } finally {
          listener.dispose();
          inFlight.current = Math.max(0, inFlight.current - 1);
          if (!disposed && inFlight.current === 0) setBusy(false);
        }
      },
      disposeInlineCompletions() {},
    });

    const triggerManual = () => {
      manual.current = true;
      editor.focus();
      editor.trigger("wrolp.ai", "editor.action.inlineSuggest.trigger", null);
    };
    const action = editor.addAction({
      id: "wrolp.ai.inlineCompletion",
      label: "AI inline completion",
      run: triggerManual,
    });
    // Bind Alt+\ while a key belongs to this editor. A capture listener on the window is
    // deliberately above Monaco's keybinding service and the suggest widget: both can swallow
    // the shortcut, and the action added above then never runs.
    const dom = editor.getDomNode();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.code !== "Backslash" && event.key !== "\\") return;
      if (!editor.hasTextFocus() && !dom?.contains(document.activeElement)) return;
      event.preventDefault();
      event.stopPropagation();
      triggerManual();
    };
    window.addEventListener("keydown", onKeyDown, true);

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKeyDown, true);
      action.dispose();
      provider.dispose();
      setInline(false);
      inFlight.current = 0;
      setBusy(false);
    };
  }, [enabled, handle]);

  return { busy };
}
