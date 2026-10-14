/**
 * The two things Monaco's own right-click menu cannot do for this app.
 *
 * The editor keeps Monaco's menu rather than an overlay of the app's own, so these go through
 * the internals that build it (declared in `src/monaco-internals.d.ts`) and run once, at module
 * load, before any editor exists. Import this from `src/lib/monaco.ts`.
 */
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import * as monaco from "monaco-editor";
import { MenuId, MenuRegistry } from "monaco-editor/platform/actions/common/actions";
import { CommandsRegistry } from "monaco-editor/platform/commands/common/commands";

/**
 * Add "Select All".
 *
 * The command exists — `Ctrl+A` runs it — but 0.57 registers the menu entry only for
 * `MenuId.SimpleEditorContext`, while the standalone editor asks for `MenuId.EditorContext`
 * (`codeEditorWidget.js:198`), so the item never appeared. The title is a literal rather than an
 * `i18n` key: the three entries beside it are Monaco's own, frozen in English when the bundle
 * loads, and a fourth that followed the app's language would change without them.
 */
MenuRegistry.appendMenuItem(MenuId.EditorContext, {
  command: { id: "editor.action.selectAll", title: "Select All" },
  group: "9_select",
  order: 1,
});

/**
 * Make the Paste that is already in the menu read the clipboard somewhere it can be read.
 *
 * Monaco's paste asks the web clipboard, and WebView2 refuses `clipboard-read` unless the host
 * grants it, so the entry did nothing while `Ctrl+V` worked — the browser handles that key
 * itself, and Monaco deliberately does not bind it. Re-registering the id is enough: the command
 * registry keeps a list per id and reads the head of it, and a menu entry resolves its command
 * through the command service at click time. Cut and Copy are left as Monaco wrote them, since
 * those go through `execCommand`, which is not blocked.
 */
CommandsRegistry.registerCommand("editor.action.clipboardPasteAction", async () => {
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
