// Monaco is bundled locally: workers are inlined by Vite and the loader points at the
// local instance, so nothing is fetched from a CDN at runtime.
// monaco-editor's exports map is "./*" -> "./esm/vs/*.js", so subpaths must not carry
// the esm/vs prefix.
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";
import cssWorker from "monaco-editor/language/css/css.worker?worker";
import editorWorker from "monaco-editor/editor/editor.worker?worker";
import htmlWorker from "monaco-editor/language/html/html.worker?worker";
import jsonWorker from "monaco-editor/language/json/json.worker?worker";
import tsWorker from "monaco-editor/language/typescript/ts.worker?worker";

declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (workerId: string | undefined, label: string) => Worker;
    };
  }
}

window.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case "json":
        return new jsonWorker();
      case "css":
      case "scss":
      case "less":
        return new cssWorker();
      case "html":
      case "handlebars":
      case "razor":
        return new htmlWorker();
      case "typescript":
      case "javascript":
        return new tsWorker();
      default:
        return new editorWorker();
    }
  },
};

loader.config({ monaco });

export default monaco;
