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
| Tab groups | A group is a **named set of open tabs**. The chip in the title bar switches between them inside the same window; tabs and caret positions come back on the next start |
| Move / copy tabs | A tab can be re-homed into another group from its context menu. This changes *which group lists the tab*, never the file on disk |

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
    ├── settings.json         fontSize, minimap, sidebarVisible, sidebarView, sidebarWidth, language,
    │                         restoreSession, sidebarRoot
    └── groups.json           the tab groups: name, tabs and caret positions
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
`get_groups`, `save_groups`, `transfer_tabs`,
`context_menu_target`, `install_context_menu`, `uninstall_context_menu`.

File IO is deliberately **not** the `fs` plugin: the WebView only ever calls these fixed
commands, so no broad disk scope is exposed to the frontend.

## Tab groups

A group is a **named set of open tabs**. The chip in the title bar shows the current name and
switches between groups inside the same window. Which folder the Explorer shows is a separate,
global view setting (`sidebarRoot`), so two groups may sit on the same folder and one group may
hold files from several folders.

- **There is always a group.** A window with no groups starts with one called *Default*, so tabs are
  persisted from the first moment without the user having to create anything. *New group…* asks for a
  name and refuses an empty one or a name already in use — two rows reading the same thing could not be
  told apart. Renaming the default group is allowed; if you remove every group, the next start creates
  a fresh default.
- **Files join the group on screen.** Opening a file from the Explorer context menu adds it to the
  current group; a right-click never changes your context under you. *Open folder…* and *Show folder
  in sidebar* move the sidebar only — they do not create or switch a group.
- **What is remembered:** the tab order, which tab was selected, and the caret position per tab
  (`Settings → Reopen tabs from last time` turns this off), plus the text of untitled tabs, which
  have no draft file so the group is their only copy. Capped at 32 groups, 200 tabs each, 64 KB of
  scratch text per tab.
- **Content is never duplicated.** File-backed tabs store only path + caret; unsaved text stays in
  the draft file, keyed by path. That is why a tab can be moved to another group without touching
  its draft, and why the draft prompt follows the file there.
- **Move / copy tab** (tab context menu) re-homes a tab between groups. It never renames or moves
  the file on disk — that would orphan the draft keyed to its path.
- **Deleted files** are skipped on restore with one aggregated notice and dropped from the group.
  *Remove from list* deletes only the record: files and drafts are left alone.

`groups.json` is whole-store, single-writer (the app is single instance) and written through a temp
file + rename. Tab paths use the same normalized form the drafts hash, so one file cannot appear
twice inside a group. A build that still has the older `workspaces.json` and no `groups.json` migrates
on **read**: the legacy file is parsed, written out under the new name, and only then deleted — so a
corrupt or unreadable legacy file is never destroyed by a later save. Unknown fields in old records
(`root`, `autoName`, `sidebarView`) are ignored, which is why the rename needed no migration step.

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

## License

MIT — see [LICENSE](LICENSE).
