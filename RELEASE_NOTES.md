# WROLP Editor 0.0.1

The first release.

## What it is

A small local text editor for Windows, built on Tauri v2 + React + TypeScript, with Monaco as the editing surface.

## What it does

- **Tabs and editing** — one window, many files; highlighting by extension, minimap, per-tab cursor and dirty marker, tab dropdown and tab context menu
- **Saving** — `Ctrl+S`; an untitled tab goes through Save As. Two cleanups are optional and off by default: trimming trailing whitespace, and adding a final line break a file is missing
- **Unsaved changes** — lines that differ from the file on disk are tinted green where text was added and amber where saved text was replaced; the marks clear on save
- **Line endings** — read from the file and written back as they are, with a per-file override and the status bar showing what a save will write
- **Drafts** — kept while you type, flushed on tab switch, close and window blur, and restored on open, with a Restore / Discard dialog available
- **Auto-save** — off by default; on, the file on screen is written on a pause rather than mid-sentence
- **Sidebar** — Explorer tree with lazy folders, recently opened files, and a version history; resizable, with the width persisted
- **Version history** — off by default; any two versions, or either against what is open, can be compared side by side and folded down to the changes
- **Encrypted files** — a self-describing AES-256-GCM container keyed from a password, with an idle lock and opt-in password remembering in the Windows credential store
- **Merge editor** — a three-pane merge for each conflicted file: ours, theirs and an editable result; take either side or both per block, undo, jump between conflicts, and Apply writes the result back in the file's own encoding, BOM and line endings
- **Multiple repositories** — the Source Control view lists the repository behind the group's folder, repositories found in its subdirectories (depth configurable, default 2), and repositories added by hand; pick one to work on it, with Explorer marks and the status bar following the selection
- **Source control** — a fourth sidebar view for the real git repository behind the group's folder: staged and unstaged changes, diffs, stage / unstage / discard, commits and history, branches, and fetch / pull / push over HTTPS or SSH with progress, cancellation, conflict resolution and a trusted-host check
- **Local-only git state** — ignore an untracked path through `.git/info/exclude`, or assume a tracked file unchanged in the index; both are available from the Explorer and the changed rows, and can be undone in *Local Git Settings*
- **Single instance** — a second launch hands its path to the running window
- **Languages** — English and 简体中文, switchable in Settings
- **Updates** — Settings → About checks the GitHub release on request, then downloads the signed installer and hands it to the passive installer

Losing an encrypted file's password loses the file: there is no recovery code and no master password.
