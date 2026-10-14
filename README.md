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
| Comparison | A read-only side-by-side diff of any two contents. Either side may be a file on disk or an unsaved buffer (an untitled tab included); a file against its own unsaved text has an entry of its own, and re-running a comparison refreshes its snapshot |
| Encrypted files | A self-describing AES-256-GCM container keyed from a password. Save as encrypted, new encrypted file, change password, remove encryption; an idle lock drops the keys; remembering a password in the Windows credential store is opt-in; drafts are sealed with the same key |
| Window | Size, position and the maximized flag come back on the next start. A window left on a monitor that is no longer connected is pulled back onto a screen you still have, and says so |

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
├── kept/<name>               rescue copies of deleted files (plaintext; see "Encrypted files")
└── state/
    ├── history.json          recently opened files, newest first, capped at 50
    ├── settings.json         fontSize, minimap, sidebarVisible, sidebarView, sidebarWidth, language,
    │                         restoreSession, sidebarRoot, encryptIdleMinutes
    ├── groups.json           the tab groups: name, tabs and caret positions
    └── window.json           x, y, width, height in physical pixels, plus the maximized flag
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

`cursor` is a Monaco model offset, so restoring puts the caret exactly where it was. The draft of
an encrypted file is not this shape but an envelope sealed with that file's own key (see
"Encrypted files"). Remembered passwords are **not here**: they live in the Windows credential store.

### Tauri commands

The whitelist is the `invoke_handler` list in `src-tauri/src/lib.rs`, and those are the only
commands the frontend can call. By purpose: open/save/drafts (`open_file`, `save_file`,
`stat_file`, `get_draft`, `save_draft`, `clear_draft`), tree and file operations (`list_dir`,
`create_file`, `create_dir`, `rename_path`, `copy_entry`, `remove_entry`, `keep_file`), groups and
session (`get_groups`, `save_groups`, `transfer_tabs`, `get_window_state`, `save_window_state`,
`plan_window_placement`), settings and the context menu (`get_settings`, `save_settings`,
`context_menu_target`, `install_context_menu`, `uninstall_context_menu`), and encryption
(`unlock_file`, `lock_file`, `lock_all`, `save_file_as_encrypted`, `create_encrypted`,
`change_password`, `remove_encryption`, `remember_password`, `forget_password`, `recall_password`,
`remembered_password_count`, `clear_remembered_passwords`).

File IO is deliberately **not** the `fs` plugin: the WebView only ever calls these fixed
commands, so no broad disk scope is exposed to the frontend. Passwords cross IPC in one direction
only, and never back: `recall_password` answers whether a path has a password remembered, a single
boolean, because a value in a JavaScript heap is a value in a devtools console.

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

## File comparison

A read-only side-by-side diff of any two contents, in a tab of its own (titled `a.txt ↔ b.txt`).

- **Either side may be unsaved.** A tab's buffer — an untitled one included — is a side like any other:
  unsaved vs saved and unsaved vs unsaved both work. The left side is the tab you started from, comparing
  its **current** text rather than what is on disk; the right side is picked from what is already open, or
  browsed from a file that is not.
- **A file against its own unsaved text** is the tab menu's *Compare with saved version*: the disk side is
  read fresh on the left, the buffer on the right, the sides labelled "· on disk" / "· unsaved" — the same
  orientation the conflict prompt uses when another program has written the file.
- **Snapshot.** Both texts are frozen into the tab when it opens; later edits to either source do not
  change it. **Re-running the same comparison** (same pair of sources, same order) refreshes it. The tab's
  context menu can swap the two sides.
- **Read-only.** Open either file to edit it.
- **Picker badges:** "unsaved" means the tab holds edits that were never saved; "untitled" means there is
  no file behind it. Pictures, the settings panel and other comparisons are never offered as a side, and a
  source is never both sides at once — disk vs disk and buffer vs buffer are refused, while buffer vs disk
  is allowed (that is the same-file case above).
- A comparison tab is temporary: it is not part of the group store and does not come back on the next
  start. Closing a source tab leaves an open comparison alone (it holds its own snapshot) — it just cannot
  be refreshed, and re-running it then says the tab was closed.

## Encrypted files

An encrypted file is a **self-describing container**, not a "txt that happens to be encrypted":
it is recognised by its magic bytes, never by its extension.

> **Lose the password, lose the file.** There is no master password, no recovery code and no
> back door. The key is derived from the password plus a per-file random salt with Argon2id, and
> nothing that could lead back to the password is stored anywhere.

### Container format

```text
off   len   contents
0     8     magic "WROLPENC"
8     1     format version (1 today)
9     1     KDF id (1 = argon2id)
10    4     m_cost, KiB (u32 LE)
14    4     t_cost (u32 LE)
18    4     p_cost (u32 LE)
22    16    salt, random per file
38    12    nonce, re-randomised on every write
50    ...   AES-256-GCM(plaintext) || 16-byte tag
```

- **The whole 50-byte header is the AEAD associated data.** Changing any byte of it — including
  lowering `m_cost` to make a brute force cheaper — fails authentication instead of being honoured.
- The default KDF parameters are Argon2id with m=65536 KiB, t=3, p=1, measured at roughly 70 ms per
  derivation in a release build on this machine. They live in the header, so changing the defaults
  never locks an older file out, and **a save reuses the file's own salt and parameters**: no new
  salt, no quiet change of cost. Changing the password is the one operation that picks a fresh salt.
- Every write is atomic — a temporary file plus a rename. A truncated ciphertext is not damaged, it
  is gone, so there is no alternative here.
- The size cap is applied to the **ciphertext** and is still 8 MiB. A 7.9 MiB plaintext crosses the
  line once encrypted and reports `file_too_large`; that is not the editor misbehaving.
- `age` is the one foreign format named explicitly (`age-encryption.org/` header) and refused with
  `encrypted_foreign_format`: it is not opened as text and not written back. Any other foreign
  binary stays the ordinary undecodable error. **No foreign encryption format is read or written.**

### The three ways in

| Entry | Behaviour |
| --- | --- |
| Tab menu → "Save as encrypted…" | Path first, password second; the buffer is written out as a new container and the tab becomes encrypted and unlocked |
| Explorer menu → "New encrypted file" | Asks for a password, writes an empty container, opens it; a name that is taken is refused |
| Tab menu → "Change password…" / "Remove encryption…" | The first checks the current password and re-encrypts the whole file; the second checks it and writes the text back as plain UTF-8 |

A new file typed without an extension gets `.wrolpenc`. Naming it after the container rather than
after a text format matters here: nothing else can read the file, and an extension that promised
text would invite the user to open it in a tool that shows them noise. Recognition does not depend
on the extension, so a container under any name is still recognised. Removing encryption writes
UTF-8, so a file that was GBK becomes UTF-8.

Changing a password **requires the current one** and will not accept a cached key instead: the user
is asserting what the old password is, and acting on a wrong assertion is how somebody gets locked
out of their own file.

### Unlocking, the key cache and the idle lock

- A password is used once. The key derived from it is kept in process memory, indexed by normalized
  path; the password itself is dropped, never written to disk and never sent back to the frontend.
- The **idle lock** is Settings → Encryption → *Lock encrypted files after*, 10 minutes by default,
  `0` for never, capped at 1440. When it fires, drafts are flushed first — the key still exists at
  that point, so a draft can still be sealed — and then every key in memory is dropped. Any keypress
  or click counts as presence, not only typing.
- **The lock does not clear the screen**, which is a deliberate trade: the text on display was
  decrypted with a password the user typed, and what the lock means is that nothing more can be
  written or drafted from here, not that the document is taken back from somebody reading it. What
  that buys is an intact undo stack and an intact dirty flag; what it costs is that a locked window
  can still be screenshotted or read over a shoulder. A locked tab's editor is read-only, and saving
  it fails loudly and asks for the password — nothing is dropped silently.
- A tab that was never decrypted shows a locked overlay instead, and clicking it asks again. It does
  **not** pass placeholder text off as content, so it stays out of undo, out of comparisons and out
  of the dirty flag; a reload from disk cannot wipe it either.
- On session restore, encrypted tabs queue for their passwords and one dialog asks them in turn. A
  wrong password is retried in place rather than dropping the question.

### Remembering passwords (opt-in, off by default)

- Only ticking "Remember this password on this computer" stores anything, and it goes into the
  **Windows credential store** as service `com.wrolp.editor`, account `enc-<sha256 of the path in
  hex>`. What is stored is a digest of the path, not the path, so the store does not show your file
  names.
- The cap is 64 entries and a further one is refused. That is not a security limit — the store is
  encrypted per user either way — but an abandoned file should not leave an entry behind forever
  without anybody noticing how many have piled up.
- A remembered password that does not open the file (usually because it was re-encrypted elsewhere)
  counts as **no key**, not as a wrong password: you are asked, and the useless entry is deleted.
  Reporting "wrong password" to somebody who typed nothing is telling them they did something they
  did not do.
- Settings → Encryption shows how many are kept and forgets them all.
- **Renaming forgets.** The remembered entry for a renamed file is dropped and the password has to
  be typed again. A credential's account is a digest of the path and cannot be reversed, so when a
  *directory* is renamed there is no way to tell which entries should move; forgetting is the only
  honest answer. The key in the session cache **does** move with the path: renaming does not touch
  the file's contents, and locking a document somebody is editing because they renamed it is not
  defensible.
- **Uninstalling does not clear the credential store.** Unlike the context-menu registry entry, the
  `enc-*` entries are system-level residue and survive. Use "Forget all" before uninstalling, or
  delete them under `com.wrolp.editor` yourself.

### Drafts and deletion

- The draft of an encrypted file is sealed with **that file's own key** and stored as
  `{"v":2,"path":"<plaintext path>","nonce":"<hex>","data":"<hex>"}`, where `data` is the ciphertext
  of the ordinary draft JSON. Keeping the path outside the envelope is deliberate: a path is not a
  secret (it is a file name in a directory listing), and having it in the clear is what lets a
  rename move a sealed draft to its new key **without** the key. The older unwrapped JSON is still
  readable, so there is no migration step.
- Whether a file is encrypted is decided by **the disk** — the first 50 bytes of the header, never a
  whole read — and not by a flag from the frontend: another window may have removed the encryption,
  or the file may have been replaced outright.
- With no key a draft cannot be written and is **dropped silently**: drafting is background
  behaviour and an error there is an interruption, while the save path fails loudly and asks for the
  password, so nothing is lost without the user hearing about it. With no key a draft is read as
  "no draft" but the file is **not deleted** — unlocking and opening the same path decrypts it again.
- A draft shares the file's key, and so shares one nonce birthday bound with it (about 2^32 writes).
  That is unreachable at text-editor scale; it is recorded rather than fixed.
- Deleting an encrypted file parks a **plaintext** rescue copy under `kept/`, on purpose: a rescue
  copy that cannot be opened is not a rescue. The dialog says so.

## Window state

The window reopens where you left it: same size, same spot, same maximized-or-not.

- **Physical pixels.** `window.json` stores `outerPosition`/`outerSize`, which are physical, not
  DIPs. On a 200 % display a 1193×748 window is recorded as 2386×1495.
- **Maximized keeps two facts.** While maximized only the flag is written; the last un-maximized
  rectangle is kept from before the maximize. Unmaximizing therefore returns to the size you chose,
  and a window that was maximized comes back maximized.
- **A moved/connected monitor is handled.** The saved rectangle is checked against the monitors that
  exist *now* before it is applied: only the top strip needs to be reachable, because the frameless
  window is dragged by that strip. A rectangle that no longer intersects any monitor is clamped back
  onto the primary at its saved size and a notice says why. Junk or absurdly large sizes fall back to
  the size a first run gets (1180×740, the same value as `tauri.conf.json`, duplicated as a Rust
  constant — change one, change the other), clamped to fit the screen.
- **When it is written:** a ~600 ms debounce after moving or resizing, and a synchronous flush in the
  close sequence alongside drafts and groups.
- **First run** keeps the size from `tauri.conf.json` and centers the window — no saved file, no
  surprise position.

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
