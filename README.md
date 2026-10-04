# WROLP Editor

A small local text editor for Windows.

Built on Tauri v2 + React + TypeScript, with Monaco Editor as the editing surface.

## Feature overview

| Area | Behaviour |
| --- | --- |
| Tabs | One window, many files; per-tab dirty marker, tab list dropdown, right-click menu on a tab |
| Editing | Monaco: syntax highlighting by extension, minimap, multi-model per file, cursor restored per tab |
| Saving | `Ctrl+S` writes the file and clears its draft; a never-saved `Untitled-N` tab goes through Save As |
| Drafts | Debounced ~500 ms after each edit; also flushed on tab switch, tab close and window blur |
| Restore | On open, disk content is compared with the draft; a differing draft raises a Restore / Discard dialog |
| Sidebar | Explorer file tree (lazy folders, refresh button) and a History list of recently opened files. Drag the divider to resize (180–640 px, double-click resets); the width is persisted |
| Single instance | Launching a second time hands the path to the running window, adds a tab and focuses it |
| Settings | Context-menu switch, editor font size, minimap, UI language; persisted and applied live. The context-menu page also shows the command the entry currently launches, and warns when it points at a different build or when this is a debug build |
| Language | English by default, switchable to 中文 from a dropdown in Settings. All strings, including messages coming from the Rust side, resolve through one key table |
| Workspaces | A workspace is one sidebar folder plus the tabs opened in it. Switching workspaces swaps that whole context inside the same window; tabs and caret positions come back on the next start |
| Move / copy tabs | A tab can be re-homed into another workspace from its context menu. This changes *where the tab is listed*, never the file on disk |

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Ctrl+S` | Save (Save As for untitled tabs) |
| `Ctrl+O` | Open file(s) |
| `Ctrl+N` | New untitled tab |
| `Ctrl+W` | Close the current tab (its draft is kept) |
| `Ctrl+B` | Toggle the sidebar |

Scrolling the mouse wheel over the tab strip scrolls it sideways.

## Getting started

### Requirements

- Windows 10/11 with the WebView2 runtime (preinstalled on current Windows)
- Rust with the MSVC toolchain (`x86_64-pc-windows-msvc`) and the Visual Studio C++ Build Tools workload
- Node.js `^20.19` or `>=22.12` (required by Vite 8), with npm

### Develop

```bash
npm install
npm run tauri dev
```

A debug build renders the page served by Vite at `localhost:1420`. If the context-menu entry
points at `target/debug/wrolp-editor.exe`, right-clicking a file only works while that dev
server is running — otherwise the window shows a connection-refused page. Point the entry at
the installed build for normal use (Settings → context menu shows which path is registered).

### Build an installer

```bash
npm run tauri build
# -> src-tauri/target/release/bundle/nsis/WROLP Editor_<version>_x64-setup.exe
```

Only the NSIS target is configured (`bundle.targets: ["nsis"]`).

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server on port 1420 (used by `tauri dev`) |
| `npm run build` | `tsc --noEmit`-style type check plus production bundle into `dist/` |
| `npm run tauri` | Tauri CLI passthrough (`dev`, `build`, `icon`, …) |

## Where data lives

Everything is under the app config directory — `%APPDATA%\com.wrolp.editor` on Windows:

```
wrolp/
├── drafts/<sha256>.draft     one draft per file
└── state/
    ├── history.json          recently opened files, newest first, capped at 50
    ├── settings.json         fontSize, minimap, sidebarVisible, sidebarView, sidebarWidth, language, restoreSession
    └── workspaces.json       the workspaces: root folder, tabs and caret positions
```

`<sha256>` is the hash of the **normalized** path: absolute, `\\?\` verbatim prefix removed, separators unified, lowercased on Windows. A draft looks like:

```json
{
  "path": "d:\\notes\\a.txt",
  "content": "unsaved text",
  "cursor": 12,
  "updatedAt": "2026-10-04T01:13:36Z"
}
```

`cursor` is a Monaco model offset, so restoring puts the caret exactly where it was.

### Tauri commands

`take_startup_files`, `open_file`, `save_file`, `get_draft`, `save_draft`, `clear_draft`,
`list_dir`, `get_history`, `remove_history`, `get_settings`, `save_settings`,
`get_workspaces`, `save_workspaces`, `transfer_tabs`,
`context_menu_target`, `install_context_menu`, `uninstall_context_menu`.

File IO is deliberately **not** the `fs` plugin: the WebView only ever calls these fixed
commands, so no broad disk scope is exposed to the frontend.

## Workspaces

A workspace is **one sidebar folder plus the tabs opened in it**, and the name in the title bar
switches between them inside the same window. Nothing else in the app is per-workspace: the
sidebar width and the language are global settings.

- **A workspace appears on its own.** Opening the first file in a bare window makes a workspace
  for that file's folder. Files opened later from the Explorer context menu join the workspace
  that is on screen — a right-click never changes your whole context under you. To point at a
  different folder deliberately, use *Open folder…* or *Show folder in sidebar* on a tab.
- **What is remembered:** the tab order, which tab was selected, the caret position per tab
  (`Settings → Reopen tabs from last time` turns this off), the sidebar view, and for untitled
  tabs their text — scratch tabs have no draft file, so the workspace is their only copy.
  Capped at 32 workspaces, 200 tabs each and 64 KB of scratch text per tab.
- **Content is never duplicated.** File-backed tabs store only path + caret; unsaved text stays
  in the draft file, keyed by path. That is why a tab can be moved to another workspace without
  touching its draft, and why the draft prompt follows the file there.
- **Move / copy tab** (tab context menu) re-homes a tab between workspaces. It never renames or
  moves the file on disk — that would orphan the draft keyed to its path.
- **A workspace that points at deleted files** skips them on restore with one aggregated notice
  and drops them from the store. *Remove from list* deletes only the record: files and drafts
  are left alone.

`workspaces.json` is whole-store, single-writer (the app is single instance) and written through
a temp file + rename. Tab paths are the same normalized form the drafts hash, so one file cannot
appear twice inside a workspace.

## Interface language

English is the default and the fallback; Settings → General → *UI language* is a dropdown, so
adding a language does not change any layout.

Strings never live in components. `src/lib/i18n.ts` holds one flat key table per language and
exposes `t(key, params)` with `{placeholder}` substitution:

```ts
{ "status.cursor": "Ln {line} · Col {column}" }        // en
{ "status.cursor": "第 {line} 行 · 第 {column} 列" }    // zh
```

The Rust side does not translate. Commands fail with a stable **code**, optionally followed by
the raw detail after the first `:`, e.g. `file_too_large:8`, `file_read:os error 5`,
`path_empty`. `translateError()` splits on that first `:`, looks up `err.<code>` and injects the
detail as `{detail}`, so an unknown code still shows something readable instead of nothing.

To add a language:

1. Add a table in `src/lib/i18n.ts` and register it in `TABLES` plus `LANGUAGES` (native name as
   its own label). Key sets must stay identical — `t()` falls back to English for missing keys.
2. Nothing else. `Settings.language` is an opaque string stored as-is, and the dropdown,
   the fallback and the error mapping pick the new entry up automatically.
3. Localize the app description if you ship it (`tauri.conf.json` → `bundle.shortDescription`);
   the Windows context-menu entry stays English on purpose, since it is registered once and
   shared by every language.
