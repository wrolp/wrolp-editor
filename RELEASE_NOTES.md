# WROLP Editor Release Notes

[中文说明](./RELEASE_NOTES.zh.md) · [English](#)

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
