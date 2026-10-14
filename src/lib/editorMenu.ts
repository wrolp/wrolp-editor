/**
 * The three things Monaco's own right-click menu cannot do for this app.
 *
 * The editor keeps Monaco's menu rather than an overlay of the app's own, so these go through the
 * internals that build it (declared in `src/monaco-internals.d.ts`) and run once, at module load,
 * before any editor exists. Import this from `src/lib/monaco.ts`.
 */
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import * as monaco from "monaco-editor";
import { t } from "./i18n";
import { MenuId, MenuRegistry } from "monaco-editor/platform/actions/common/actions";
import { CommandsRegistry } from "monaco-editor/platform/commands/common/commands";

/**
 * Add "Select All".
 *
 * The command exists — `Ctrl+A` runs it — but 0.57 registers the menu entry only for
 * `MenuId.SimpleEditorContext`, while the standalone editor asks for `MenuId.EditorContext`
 * (`codeEditorWidget.js:198`), so the menu never showed it. It is registered in English, the way
 * the three above it are; the loop below is what turns it to the app's language.
 */
MenuRegistry.appendMenuItem(MenuId.EditorContext, {
  command: { id: "editor.action.selectAll", title: "Select All" },
  group: "9_select",
  order: 1,
});

/** The entries this app wants the language for, keyed by the command each one runs. */
const MENU_TITLES: Record<string, string> = {
  "editor.action.clipboardCutAction": "editor.cut",
  "editor.action.clipboardCopyAction": "editor.copy",
  "editor.action.clipboardPasteAction": "editor.paste",
  "editor.action.selectAll": "editor.selectAll",
};

/**
 * Make those entries follow the interface language.
 *
 * Monaco picks its own labels when the bundle loads — `localize()` in the shipped ESM returns a
 * finished string, not something that re-reads a catalog — so the menu cannot track a language
 * switch on its own. It is *built* on every right-click, though, and the label is read then
 * (`actions.js:424`), so an entry can be given a getter instead of a string. Writing to them works
 * because `getMenuItems` copies the list but not its elements (`actions.js:379`), so what is held
 * here is what the registry will hand to the next menu.
 *
 * A future Monaco that stores its entries immutably would simply leave the menu English: nothing
 * else about it changes, and that is the worst case worth accepting for this.
 */
for (const item of MenuRegistry.getMenuItems(MenuId.EditorContext)) {
  const command = item.command;
  if (!command) continue;
  const key = MENU_TITLES[command.id];
  if (!key) continue;
  const title = { get value() { return t(key); } };
  command.title = title;
  // A submenu entry carries its title beside the command rather than inside it.
  if (item.title !== undefined) item.title = title;
}

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
