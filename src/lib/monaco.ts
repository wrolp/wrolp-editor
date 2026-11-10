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

// JSON Lines is one JSON value per line, so it cannot borrow the `json` language id: that id is
// wired to Monaco's JSON language service, which parses the whole file as a single document and
// would flag every record after the first. A language of its own, tokenized line by line, keeps
// the JSON colours (`string.key.json` and friends are the names the JSON tokenizer emits) while
// letting each line stand on its own. The tokenizer holds no state across lines, which is what
// "one value per line" means.
monaco.languages.register({
  id: "jsonl",
  extensions: [".jsonl", ".ndjson"],
  aliases: ["JSON Lines", "jsonl", "ndjson"],
  mimetypes: ["application/x-ndjson"],
});

monaco.languages.setLanguageConfiguration("jsonl", {
  wordPattern: /(-?\d*\.\d\w*)|([^\[\{\]\}\:\"\,\s]+)/g,
  // Line comments only: a block comment would be the one thing about JSONL that runs across
  // lines, and in a one-value-per-line format there is nothing for it to be about.
  comments: { lineComment: "//" },
  brackets: [
    ["{", "}"],
    ["[", "]"],
  ],
  autoClosingPairs: [
    { open: "{", close: "}", notIn: ["string"] },
    { open: "[", close: "]", notIn: ["string"] },
    { open: '"', close: '"', notIn: ["string"] },
  ],
});

monaco.languages.setMonarchTokensProvider("jsonl", {
  // Empty on purpose: the names below are the JSON theme scopes themselves, not a
  // `jsonl`-suffixed copy of them, so the file looks exactly like a `.json` file.
  tokenPostfix: "",
  tokenizer: {
    root: [
      [/[ \t\r\n]+/, "white"],
      [/\/\/.*$/, "comment.line.json"],
      [/\{|\}/, "delimiter.bracket.json"],
      [/\[|\]/, "delimiter.array.json"],
      [/:/, "delimiter.colon.json"],
      [/,/, "delimiter.comma.json"],
      // A string followed by a colon is an object key; every other string is a value.
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/, "string.key.json"],
      [/"(?:[^"\\]|\\.)*"/, "string.value.json"],
      [/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?/, "number.json"],
      [/\b(?:true|false|null)\b/, "keyword.json"],
      // An unterminated string colours to the end of its own line, not past it.
      [/"(?:[^"\\]|\\.)*$/, "string.value.json"],
    ],
  },
});

// The editor draws its own right-click menu; the one Monaco command it still relies on is Paste,
// which has to read the Tauri clipboard. Imported for that side effect, after `monaco-editor`
// above so this registration is the one at the head of the command list.
import "./editorMenu";

export default monaco;
