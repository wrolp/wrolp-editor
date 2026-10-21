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
- **Single instance** — a second launch hands its path to the running window
- **Languages** — English and 简体中文, switchable in Settings
- **Updates** — Settings → About checks the GitHub release on request, then downloads the signed installer and hands it to the passive installer

Losing an encrypted file's password loses the file: there is no recovery code and no master password.
