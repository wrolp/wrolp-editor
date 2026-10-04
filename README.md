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
| Sidebar | Explorer file tree (lazy folders, refresh button) and a History list of recently opened files |
| Single instance | Launching a second time hands the path to the running window, adds a tab and focuses it |
| Settings | Context-menu switch, editor font size, minimap; persisted and applied live. The context-menu page also shows the command the entry currently launches, and warns when it points at a different build or when this is a debug build |

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
    └── settings.json         fontSize, minimap, sidebarVisible, sidebarView
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
`context_menu_target`, `install_context_menu`, `uninstall_context_menu`.

File IO is deliberately **not** the `fs` plugin: the WebView only ever calls these fixed
commands, so no broad disk scope is exposed to the frontend.
