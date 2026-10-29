/**
 * Make Monaco's Paste command read the clipboard somewhere it can be read.
 *
 * The app draws its own right-click menu (`Editor.tsx`), and its Paste entry runs this command.
 * Monaco's paste asks the web clipboard, and WebView2 refuses `clipboard-read` unless the host
 * grants it, so the entry did nothing while `Ctrl+V` worked — the browser handles that key
 * itself, and Monaco deliberately does not bind it. Re-registering the id is enough: the command
 * registry keeps a list per id and reads the head of it, and the menu resolves the command
 * through the command service at click time.
 *
 * Copy and Cut are the app's own: they need "copy the current line" when there is no selection
 * and a Tauri clipboard write, so they do not go through Monaco's commands.
 */
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import * as monaco from "monaco-editor";

monaco.editor.registerCommand("editor.action.clipboardPasteAction", async () => {
  const target = monaco.editor.getEditors().find((editor) => editor.hasTextFocus());
  if (!target || !target.getModel()) return;
  const text = await readText().catch(() => null);
  // Nothing readable on the board: the document stays as it is, which is what an empty
  // clipboard means anywhere else.
  if (text === null) return;
  // `getSelections` answers null for a model that went away mid-click, which is the one case
  // the guard above cannot cover.
  const selections = target.getSelections();
  if (!selections) return;
  // One edit per cursor, so a paste with several carets puts the text at each of them. A
  // read-only document — a locked encrypted file included — is refused by `executeEdits` itself.
  target.executeEdits(
    "paste",
    selections.map((selection) => ({
      range: selection,
      text,
      forceMoveMarkers: true,
    }))
  );
  target.focus();
});
