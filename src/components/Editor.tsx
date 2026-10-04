import MonacoEditor from "@monaco-editor/react";
import type { Monaco } from "@monaco-editor/loader";
import { useCallback, useEffect, useRef } from "react";
import type { editor } from "monaco-editor";
import { t } from "../lib/i18n";
import "../lib/monaco";
import { modelUri } from "../lib/path";
import type { CursorPos, EditorHandle, Tab } from "../lib/types";

interface Props {
  tab: Tab;
  fontSize: number;
  minimap: boolean;
  onChange: (value: string) => void;
  onCursor: (position: CursorPos, offset: number) => void;
  onReady: (handle: EditorHandle | null) => void;
}

export default function Editor({ tab, fontSize, minimap, onChange, onCursor, onReady }: Props) {
  const cursorRef = useRef(onCursor);
  cursorRef.current = onCursor;
  const readyRef = useRef(onReady);
  readyRef.current = onReady;

  const handleMount = useCallback((instance: editor.IStandaloneCodeEditor, m: Monaco) => {
    readyRef.current({ editor: instance, monaco: m });
    instance.onDidChangeCursorPosition((e) => {
      const model = instance.getModel();
      if (!model) return;
      cursorRef.current(e.position, model.getOffsetAt(e.position));
    });
  }, []);

  // Release the handle on unmount so async callbacks cannot touch a disposed instance.
  useEffect(() => () => readyRef.current(null), []);

  return (
    <MonacoEditor
      path={modelUri(tab.path)}
      defaultValue={tab.original}
      language={tab.language}
      theme="vs-dark"
      loading={<div className="editor-empty">{t("app.loading")}</div>}
      onChange={(value) => value !== undefined && onChange(value)}
      onMount={handleMount}
      options={{
        fontSize,
        minimap: { enabled: minimap },
        automaticLayout: true,
        tabSize: 2,
        scrollBeyondLastLine: false,
        fontFamily: 'Consolas, "Cascadia Mono", "Courier New", monospace',
        renderWhitespace: "selection",
      }}
    />
  );
}
