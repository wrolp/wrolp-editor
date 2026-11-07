# WROLP Editor Release Notes

[中文说明](./RELEASE_NOTES.zh.md) · [English](#)

---

## v0.0.3 — 2026-11-07

The third release: PDFs get a reader of their own, the tab menu grows a flyout for the per-file settings, and files can be pasted or dropped into the Explorer from Windows.

### Features

- **PDF reader** — a PDF opens in its own tab drawn by a reader: pages are read by byte range and drawn on demand, the view scrolls on its own, and the page is remembered so a reopened document continues where it was left. The status bar names the file as a PDF, shows the page and seeks to it, bookmarks fold out as a scale tree with expand and collapse all, and the reader's tools sit behind a corner tab.
- **Markdown outline** — the contents column lives behind a corner tab and can open by default.
- **Tab strip** — the hover bubble names the file and the folder holding it; long tab names are cut with the same ellipsis setting as the tree; tabs close all at once or to one side; a tab moves to either end from its menu; and the strip's tabs size to their labels.
- **Tab menu: file settings** — *File settings* opens a flyout beside the row instead of a panel that replaces the menu: preview, minimap and the ten per-file overrides (visible whitespace, wrap, sticky scroll, indentation width, insert spaces, detect indentation, minimap, encoding, line ending, version history) are switched in place, each with its current value and a list of choices. The dialog stays, for the detected encoding and for resetting everything to the global defaults.
- **Explorer** — files pasted from Windows (Ctrl+V) or dropped from it land in the folder under the pointer, which lights up while dragging; a drop anywhere else opens the files as tabs. *Properties* shows a file's or folder's size, timestamps and attributes in the app's own dialog.
- **Source control** — clone a remote from the panel; manage staged and locally ignored paths; overflow the header actions into a menu as the panel narrows; fold unchanged regions and switch split or unified; edit remote addresses; open a changed file from a row's menu; group the change list by folder, remembered across restarts; and stop a push that is already running.
- **Settings** — the General page is grouped into cards, the status bar can be hidden, and the language and theme follow the system by default.
- **Updates** — a new release is looked for after startup and every six hours, and the updater reads every published release.

### Fixes

- A hover bubble shows its path whole rather than cutting it, and stays inside the window; the Source panel's bubble names the folder instead of repeating the file name.
- Tooltips stay clear of the pointer and of the row name they describe.
- Shortcuts stay behind dialogs, and parent paths can be copied from the tree.
- The Explorer tree and the Source panel stay responsive on large trees and long histories.
- A wide mermaid flowchart lays out correctly.
- A staged count truncates instead of wrapping.
- The native context menu is suppressed over the app's own menus.
- A picture keeps its own colours on a turned page.
- Saves stay durable and git secrets stay out of the configuration file.

### Internal

- Version bumped to 0.0.3
- The release build cleans `target/` and `dist/` before it starts

---

## v0.0.2 — 2026-10-31

The second release: source control arrives, comparison learns to fold and wrap, Markdown gains export, and the editor and preview get their own right-click menus.

### Features

- **Source control** — a fourth sidebar view for the real git repositories behind the group's folder: staged and unstaged changes, diffs, stage / unstage / discard, commits and amend, history with the commit graph, branches, and fetch / pull / push over HTTPS or SSH with progress, cancellation and a trusted-host check. A merge resolves conflict blocks one by one in a three-pane editor, and a folder can hold more than one repository.
- **Local-only git state** — ignore an untracked path through `.git/info/exclude`, or assume a tracked file unchanged in the index; both are reversible from *Local Git Settings*.
- **Commit diff tabs** — right-click a commit to open every file it changed in one read-only tab: files folded by name and expandable, with each diff foldable down to its changed lines.
- **Comparison** — one comparison tab is reused by default instead of stacking a new one (switchable in Settings), and the diff header carries *show only the changes* and *wrap lines* switches. Folding keeps the real line numbers.
- **Context menus** — the editor and the Markdown preview draw their own right-click menu: cut / copy / paste / select all in the editor, and copy / copy code / copy link / select all in the preview, in the interface language.
- **Markdown rendering** — a document's own HTML is rendered through a stricter sanitiser (inline and block tags, tables, media, `details`), inline SVG is drawn, and image names are decoded.
- **Export** — a Markdown document exports to PDF through the print dialog or to `.docx`; pictures are inlined (large ones re-encoded), a progress panel reports how far it got and can be dragged aside, and the printed PDF is named after the document.
- **Explorer** — batch rename, each tab group keeps its own folder, names sort naturally, and a folder's pictures open in a gallery tab. The Source Control panel can point the Explorer at a repository's folder, and a file the editor cannot read opens with the default app.
- **Smaller additions** — a colour behind transparent pictures, recent files can be cleared or removed in bulk, and the history is refreshed when HEAD or a remote ref moves.

### Fixes

- The printed PDF is named after the document instead of the app.
- A hovered toast waits a moment before it closes.
- A commit's file diff is read from the selected repository, not the folder above it.
- The history refreshes after a commit even when the log was empty, and after a fetch, pull or push.
- A refused SSH host key is kept so the panel can ask about it.
- A configuration restore is no longer undone by the reload that follows it.
- The backup folder opens through the backend, and a restore confirmation sits under the row it belongs to.
- The Explorer keeps its folders open when refreshing, and the recent-files list follows changes to it.
- The wheel scrolls the recent-folders menu.
- The updater reads every published release and ranks a prerelease below the release it previews.
- Saving a CRLF file tints its real changes, not its line endings.
- Version times show `yyyy-MM-dd HH:mm:ss`.
- A window is placed before it is shown, so a maximized start does not flash.
- Only the release script signs updater artifacts.
- An empty group no longer adopts the departing tabs.
- Asset paths are matched case-insensitively before the scope check.
- The Markdown outline stays in step with the preview, and the preview keeps its slot when the outline appears.

### Internal

- Version bumped to 0.0.2
- Git commit wrappers kept behind `cfg(test)`; the merge test call collapsed by rustfmt
- The release script gates a release on its own tag and on a version ahead of what is live

---

## v0.0.1 — 2026-10-21

The first release.

### What it is

A small local text editor for Windows, built on Tauri v2 + React + TypeScript, with Monaco as the editing surface.

### What it does

- **Tabs and editing** — one window, many files; highlighting by extension, minimap, per-tab cursor and dirty marker, tab dropdown and tab context menu
- **Saving** — `Ctrl+S`; an untitled tab goes through Save As. Two cleanups are optional and off by default: trimming trailing whitespace, and adding a final line break a file is missing
- **Unsaved changes** — lines that differ from the file on disk are tinted green where text was added and amber where saved text was replaced; the marks clear on save
- **Line endings** — read from the file and written back as they are, with a per-file override and the status bar showing what a save will write
- **Drafts** — kept while you type, flushed on tab switch, close and window blur, and restored on open, with a Restore / Discard dialog available
- **Auto-save** — off by default; on, the file on screen is written on a pause rather than mid-sentence
- **Sidebar** — Explorer tree with lazy folders, recently opened files, and a version history; resizable, with the width persisted
- **Version history** — off by default; any two versions, or either against what is open, can be compared side by side and folded down to the changes
- **Encrypted files** — a self-describing AES-256-GCM container keyed from a password, with an idle lock and opt-in password remembering in the Windows credential store
- **Single instance** — a second launch hands its path to the running window
- **Languages** — English and 简体中文, switchable in Settings
- **Updates** — Settings → About checks the GitHub release on request, then downloads the signed installer and hands it to the passive installer

Losing an encrypted file's password loses the file: there is no recovery code and no master password.
