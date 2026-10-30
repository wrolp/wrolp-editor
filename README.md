<p align="center">
  <img src="branding/logo.png" width="128" height="128" alt="WROLP Editor logo" />
</p>

# WROLP Editor

English | [简体中文](README.zh.md)

A small local text editor for Windows.

Built on Tauri v2 + React + TypeScript, with Monaco Editor as the editing surface.

## Feature overview

| Area | Behaviour |
| --- | --- |
| Tabs | One window, many files; per-tab dirty marker, tab list dropdown, right-click menu on a tab |
| Editing | Monaco: syntax highlighting by extension, minimap, multi-model per file, cursor restored per tab |
| Saving | `Ctrl+S` writes the file and clears its draft; a never-saved `Untitled-N` tab goes through Save As. Two cleanups are optional and off by default: trimming trailing whitespace, and adding a final line break a file is missing — both are applied to the buffer first, so the screen ends up showing the bytes written |
| Unsaved changes | Lines that differ from the file on disk are tinted — green where text was added, amber where saved text was replaced — and the marks clear on save. The workbench has this built in; the standalone editor needs the comparison, which is `src/lib/dirtyDiff.ts` |
| Line endings | Read from the file and written back as they are. One file can be forced to LF or CRLF from that tab's File settings, and a document with no breaks yet — a new file above all — takes what Settings → General names. The status bar shows the ending a save will write. A lone CR is not offered: Monaco's model joins lines with LF or CRLF and nothing else |
| Drafts | Debounced ~500 ms after each edit; also flushed on tab switch, tab close and window blur |
| Auto-save | Off by default. On, the file **on screen** is written once it has gone N seconds without an edit — typing restarts that file's countdown, so the write lands on a pause rather than mid-sentence. A tab you are not looking at neither starts a countdown nor loses one already running, and its unsaved text stays held by its draft. Untitled buffers, locked files, pictures, and anything the disk check already has a question about are left alone. Its writes record no version unless Settings → Versions says otherwise |
| Restore | On open, disk content is compared with the draft; a differing draft is loaded back and the tab stays marked unsaved. Settings can switch this to a per-file Restore / Discard dialog |
| Sidebar | Explorer file tree (lazy folders, refresh button, folders first and names in natural order — `2.txt` before `10.txt`), a History list of recently opened files, a Versions view, and a Source Control view. Drag the divider to resize (180–640 px, double-click resets); the width is persisted. The tree's text size is a setting, 11–20 px |
| Markdown preview | A `.md` tab renders beside its source: GitHub-flavoured markdown, a table of contents, code coloured by Monaco, `mermaid` / `plantuml` / `graphviz` fences drawn as SVG, and pictures that sit beside the document loaded through the asset protocol. What the document spells in HTML is rendered too, within an allow-list: the tags that mean something in a document, inline `style` filtered down to presentational properties, and no script, event handler, `<style>` block or `id` |
| Picture gallery | A whole folder in one tab, in natural order (`IMG_2` before `IMG_10`): stacked, one at a time, slideshow, or a grid. Subfolders are opt-in and walked four levels deep; one listing stops at 2,000 pictures and says so. Pictures are drawn through the asset protocol, so the editor's text-size limit does not apply. HEIC and TIFF are listed and marked as formats this renderer cannot draw |
| Batch rename | Multi-select rows or rename a whole folder at once; one pattern (`{name}`, `{ext}`, `{n}`) or a regular expression with a replacement, a live preview, and an order — name, extension, modified time or manual — that `{n}` counts. See [Batch rename](#batch-rename) |
| Version history | Off by default. On, every save by hand records what the file said, and any two of them — a version against a version, or either against what is open — can be compared side by side, folded down to the changes, or put back into the editor. One file's saves can be excluded, or forced in, from its tab menu. See [Version history](#version-history) |
| Source control | Explorer rows carry their git letter — a dimmed `!` for paths git ignores, with the row and its icon stepped back — and folders the count of changes beneath them. A fourth sidebar view for the real repositories behind the group's folder — found in subdirectories up to a configurable depth, or added by hand — with staged and unstaged changes, per-file diffs, stage / unstage / discard, commits with history, branches, conflict resolution including a three-pane merge editor. See [Source control](#source-control) |
| Remotes | Fetch, pull (fast-forward or merge) and push over HTTPS or SSH, with progress and a Cancel button. Credentials live in `state/git.json`, never in Settings or its backups |
| Single instance | Launching a second time hands the path to the running window, adds a tab and focuses it |
| Settings | Context-menu switch, editor font size, minimap, UI language; persisted and applied live. The context-menu page also shows the command the entry currently launches, and warns when it points at a different build or when this is a debug build |
| Language | English by default, switchable to 中文 from a dropdown in Settings. All strings, including messages coming from the Rust side, resolve through one key table |
| Updates | Settings → About checks the latest GitHub release on request, then downloads and hands the signed NSIS package to the passive installer, which restarts the app. Nothing checks in the background |
| Tab groups | A group is a **named set of open tabs plus the folder the Explorer shows**. The chip in the title bar switches between them inside the same window — tabs, caret positions and the tree come back with it |
| Move / copy tabs | A tab can be re-homed into another group from its context menu. This changes *which group lists the tab*, never the file on disk |
| Configuration backups | Timestamped snapshots of groups, settings, recent files and folder history, refreshed when the app opens and closes and on demand; older ones are pruned to a count you set, and any snapshot can be restored from Settings → Backups. Drafts and version history are not included |
| Comparison | A read-only side-by-side diff of any two contents. Either side may be a file on disk or an unsaved buffer (an untitled tab included); a file against its own unsaved text has an entry of its own, and re-running a comparison refreshes its snapshot. One comparison tab by default, switchable to a new tab per comparison |
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

## Picture gallery

Right-click a folder in the Explorer — or the blank space under the tree — and choose **Browse pictures**. The folder opens in its own tab with four ways to look at the same naturally ordered list:

- **Stacked** (the default): every picture one after another, at most its own width and never stretched, with its name, size and dimensions above it.
- **One by one**: one picture with zoom, fit and 100%, plus a filmstrip of the folder.
- **Slideshow**: the same pane advancing on a timer. Hovering the picture pauses it, and so does leaving the window; the pace and looping are settings, and also reachable from the gallery toolbar.
- **Grid**: square thumbnails, small or large. Clicking any picture opens it one-by-one at that position.

A picture opened in a normal tab has a **Browse folder** button that opens its folder and lands on it. The gallery reads only local folders — it does not contact an image host, upload anything or produce links.

Behind a picture's transparent pixels sits a checkerboard taken from the theme. The row of swatches in the picture's toolbar — the same ones are in Settings → General — swaps that for white, black, or any colour the system picker gives you, which is how a white logo stops vanishing into a light backdrop; the choice covers the gallery's thumbnails as well, and is remembered for every picture.

Only pictures near the viewport are mounted, and ones two screens away are removed from the DOM so Chromium can release the decoded bitmap; in the stacked view the space they occupied is kept, so scrolling back does not jump. In the stacked view `Up`/`Down` scroll the column and `Left`/`Right` move between pictures; in one-by-one and slideshow `Left`/`Right` move between pictures. `Home`/`End` jump to the ends, `Space` plays or pauses a slideshow (and pages the stacked view), and `Esc` returns to one-by-one. Folder changes made in the Explorer refresh an open gallery. `gallery://` tabs are never written into a saved group, so restarting brings back files only.

## Batch rename

Rename many entries at once from the Explorer: `Ctrl+click` rows (or `Shift+click` for a run of them), then **Rename N items…** in the row menu. A folder can be renamed whole without selecting anything — **Rename everything in this folder…** is on the folder's own menu and on a file's menu (for the folder holding it), and the blank area's menu offers the same command for the folder the Explorer is showing.

Every name is worked out and checked before anything on disk changes, so a refused name leaves the folder as it was. The dialog shows the new name of every row as it is typed, and marks a row that would collide with another row of the same batch.

Two rules are offered:

- **Pattern** — tokens for the parts of a name: `{name}` is the old name without its extension, `{ext}` the extension including its dot, and `{n}` a counter. `{name}{ext}` changes nothing, `photo-{n}{ext}` numbers a folder, and `{name}-backup{ext}` appends to every name. The counter starts at *Start at* and is padded to *Digits*, so `01`, `02`, … rather than `1`, `2`, ….
- **Regex** — a regular expression matched against the whole name, extension included, plus a replacement. `$1` refers to a capture group, *Ignore case* adds the `i` flag, and rows the expression does not match keep their name. The replacement takes `{name}`, `{ext}` and `{n}` as well, so a group and a counter can be combined: `^(.+)\.jpe?g$` → `photo-{n}-$1.jpg`.

The counter counts rows in the list, not matches: under a regular expression, a row that does not match still takes its number, which keeps a sequence stable when only some of the files are affected.

Before applying, the list can be ordered — *As given*, *Name* (numbers read as numbers, so `photo-9` comes before `photo-10`), *Extension*, *Modified*, or *Manual* — and flipped between ascending and descending. Dragging a row, or the arrows that appear on hover, fine-tunes the order, and `{n}` follows whatever is on screen, so the numbering can be nudged until it reads the way it should. A name already taken by an entry outside the batch is refused by the backend with a message rather than overwriting it; a folder and something inside it cannot move in one batch.

A renamed file keeps its text, its caret and any unsaved edits in the tab that is showing it. The undo stack of that document starts over, because Monaco has no way to move a buffer to another path. A name in the preview that is too long to fit keeps its full text as a tooltip.

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

A debug build renders the page served by Vite at `localhost:1520`. If the context-menu entry
points at `target/debug/wrolp-editor.exe`, right-clicking a file only works while that dev
server is running — otherwise the window shows a connection-refused page. Point the entry at
the installed build for normal use (Settings → context menu shows which path is registered).

### Build an installer

```bash
npm run tauri build
# -> src-tauri/target/release/bundle/nsis/WROLP Editor_<version>_x64-setup.exe
```

Only the NSIS target is configured (`bundle.targets: ["nsis"]`).

### Publish a release

```bash
npm run release   # build the installer; exits first if the three version fields disagree
npm run upload    # create or resume the GitHub release v<version> and upload the setup.exe
# or: npm run publish
```

`upload` needs the `gh` CLI, authenticated with push access to the repository; the repository
comes from `git remote get-url origin` (override with `--repo owner/name`), and the command
accepts `--tag`, `--notes`, `--draft`, `--pre` and `--dry-run`.

The build is signed with `.tauri/priv.key` (untracked; generate it with
`npx tauri signer generate -w .tauri/priv.key` and keep it backed up — losing it means existing
installs can no longer accept updates). `release` writes `latest.json` beside the installer and
`upload` attaches both; the app reads it from
`https://github.com/wrolp/wrolp-editor/releases/latest/download/latest.json`. Bump all three
version fields before building.

The release notes are two hand-written files at the repository root, one per language:
`RELEASE_NOTES.md` (English) and `RELEASE_NOTES.zh.md` (简体中文). `release` reads them for
`latest.json`'s `notes` and `upload` for the GitHub release body, joined as one text with the
English above a rule and the Chinese under it; `--notes "..."` overrides both for a one-off
about a single build.

### Scripts

| Script | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server on port 1520 (used by `tauri dev`) |
| `npm run build` | `tsc --noEmit`-style type check plus production bundle into `dist/` |
| `npm run tauri` | Tauri CLI passthrough (`dev`, `build`, `icon`, …) |
| `npm run release` | Version check, signed build, then `latest.json` |
| `npm run upload` | Upload the installer and `latest.json` to a GitHub release |
| `npm run publish` | `release` followed by `upload` |

## Where data lives

Everything is under the app config directory — `%APPDATA%\com.wrolp.editor` on Windows — and
Settings → About prints the folders' full paths and opens any one of them in Explorer; the
Backups page does the same for its folder:

```
wrolp/
├── backups/wrolp-backup-<time>-<kind>.json   settings, groups, recent files and folder history
├── drafts/<name>-<sha256>.draft   one draft per file, named after the file it belongs to
├── kept/<name>               rescue copies of deleted files (plaintext; see "Encrypted files")
├── shadow/<name>-<sha256>.git/   one version history per file, once versioning is on
└── state/
    ├── history.json          recently opened files, newest first, capped at 50
    ├── settings.json         fontSize, minimap, sidebarVisible, sidebarView, sidebarWidth, sidebarFont,
    │                         language, restoreSession, draftRestore, lineEnding,
    │                         trimTrailingWhitespace, insertFinalNewline, autoSave, autoSaveInterval,
    │                         versioningEnabled, versioningShowLimit, versioningMaxFileSize, autoSaveVersions,
    │                         askNoteOnSave, backupDir, backupRetain,
    │                         encryptIdleMinutes
    ├── file-settings.json    per-file overrides: encoding, line ending, view settings, versioning
    ├── groups.json           the tab groups: name, tabs, caret positions and the Explorer folder
    ├── git.json              git credentials, commit identity fallback, trusted SSH host keys
    │                         (plain text; deliberately not part of configuration backups)
    └── window.json           x, y, width, height in physical pixels, plus the maximized flag
```

`<sha256>` is the hash of the **normalized** path: absolute, `\\?\` verbatim prefix removed, separators unified, lowercased on Windows. It, not the readable `<name>` in front of it, is what a draft is keyed by — two `notes.md` files in two folders never share one. The name is there because a folder of bare digests is a folder of anonymous files; a draft written under the older `<sha256>.draft` name is read and renamed on the first load, and cleared under both names. A draft looks like:

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
`plan_window_placement`), settings, backups and the context menu (`get_settings`, `save_settings`,
`get_store_dirs`, `create_config_backup`, `list_config_backups`, `restore_config_backup`,
`maybe_auto_backup`, `context_menu_target`, `install_context_menu`, `uninstall_context_menu`), version
history (`versioning_state`, `set_version_override`, `add_version`, `get_versions`,
`get_version_content`, `list_versions`, `clear_versions`), and encryption
(`unlock_file`, `lock_file`, `lock_all`, `save_file_as_encrypted`, `create_encrypted`,
`change_password`, `remove_encryption`, `remember_password`, `forget_password`, `recall_password`,
`remembered_password_count`, `clear_remembered_passwords`), and git (`git_status`, `git_repo_info`,
`git_init`, `git_diff`, `git_stage`, `git_unstage`, `git_discard`, `git_commit`, `git_log`,
`git_commit_files`, `git_branches`, `git_create_branch`, `git_switch_branch`, `git_delete_branch`,
`git_remotes`, `git_fetch`, `git_pull`, `git_push`, `git_cancel`, `git_conflict_sides`,
`git_resolve_conflict`, `git_write_resolution`, `git_delete_resolution`, `git_merge_abort`, plus
`git_auth_*` for the credential and host-key store).

File IO is deliberately **not** the `fs` plugin: the WebView only ever calls these fixed
commands, so no broad disk scope is exposed to the frontend. Passwords cross IPC in one direction
only, and never back: `recall_password` answers whether a path has a password remembered, a single
boolean, because a value in a JavaScript heap is a value in a devtools console.

## Tab groups

A group is a **named set of open tabs** plus the **folder the Explorer shows** while it is on
screen. The chip in the title bar shows the current name and switches between groups inside the
same window; the tree switches with it. A group may still hold files from several folders — the
folder is where the next file is picked from, not where the open ones came from.

- **There is always a group.** A window with no groups starts with one called *Default*, so tabs are
  persisted from the first moment without the user having to create anything. *New group…* asks for a
  name and refuses an empty one or a name already in use — two rows reading the same thing could not be
  told apart. Renaming the default group is allowed; if you remove every group, the next start creates
  a fresh default.
- **Files join the group on screen.** Opening a file from the Explorer context menu adds it to the
  current group; a right-click never changes your context under you. *Open folder…* and *Show folder
  in sidebar* move the Explorer and record the folder in that group — they do not create or switch
  a group. A new group starts where the window already is, and can move on its own after that.
- **What is remembered:** the tab order, which tab was selected, the caret position per tab
  (`Settings → Reopen tabs from last time` turns this off), and the Explorer folder, plus the text
  of untitled tabs, which have no draft file so the group is their only copy. Capped at 32 groups,
  200 tabs each, 64 KB of
  scratch text per tab.
- **Content is never duplicated.** File-backed tabs store only path + caret; unsaved text stays in
  the draft file, keyed by path. That is why a tab can be moved to another group without touching
  its draft, and why the draft follows the file there.
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

## Configuration backups

Settings → Backups keeps timestamped copies of the configuration, because losing the group store
takes the tab session with it and there is no undo for that. The default folder is
`%APPDATA%\com.wrolp.editor\wrolp\backups`; *Change…* picks another one and *Use the default
folder* returns to it. The folder and the retention count are stored in `settings.json`
(`backupDir`, `backupRetain`).

- **One file per snapshot.** Each is named `wrolp-backup-<YYYYMMDD-HHMMSS-mmm>-<kind>.json`, with
  kind `auto`, `manual` or `pre-restore`. The files are bundled into one record rather than copied
  one by one, because a group and its folder menu are tied together by the group id: restoring one
  without the other can leave the menu pointing at a group that is no longer there.
- **What is inside:** `settings.json`, `groups.json`, `file-settings.json`, `history.json` and
  `folder-history.json`, each kept as the exact text it had. **Drafts and version history are not
  included** — those are user data rather than configuration, and copying them would let a snapshot
  grow to the size of the work it protects. A snapshot is plain JSON, like the files it copies.
- **Automatic and manual.** The day's automatic snapshot is refreshed when the app opens and when
  it closes, so it holds the configuration as it stood at that transition. Each refresh replaces
  the earlier automatic one from the same day, while manual snapshots stay; a window left open
  past midnight gets one from the hourly check. *Back up now* takes a manual snapshot at any time.
  *Snapshots to keep* (1–100, default 20) is enforced when the next snapshot is written, so
  lowering it does not delete anything until then.
- **Restoring.** The list is newest first and shows when each snapshot was taken, its kind, the
  group and tab counts it holds, and its size. Picking one asks once, then flushes drafts and
  groups, takes a `pre-restore` safety snapshot of the current state, replaces the five files and
  reloads the window. Drafts are not part of a snapshot, so they survive the restore and the
  reload. `window.json` is not touched, and the window stays where it is.
- **Only this folder, only these names.** A restore is refused for a path outside the configured
  backup folder, a file not named `wrolp-backup-*.json`, a snapshot newer than the format this
  build knows, and a damaged bundle — the list leaves those out rather than offering them.

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
  context menu can swap the two sides. By default there is one comparison tab: a new comparison replaces
  the one on screen (re-running the same pair still refreshes in place); turn off *Reuse one comparison
  tab* in Settings → General to give every comparison a tab of its own.
- **Show only the changes.** The fold button in the header keeps the changed lines and a few lines
  of context around each, hiding the stretches that did not change, and says how many lines it
  dropped. The tab's snapshot is not touched, so unfolding gives the whole text back — but while
  folded the line numbers are those of the folded text, and find and copy reach only what is shown.
- **Read-only.** Open either file to edit it.
- **Picker badges:** "unsaved" means the tab holds edits that were never saved; "untitled" means there is
  no file behind it. Pictures, the settings panel and other comparisons are never offered as a side, and a
  source is never both sides at once — disk vs disk and buffer vs buffer are refused, while buffer vs disk
  is allowed (that is the same-file case above).
- A comparison tab is temporary: it is not part of the group store and does not come back on the next
  start. Closing a source tab leaves an open comparison alone (it holds its own snapshot) — it just cannot
  be refreshed, and re-running it then says the tab was closed.

## Version history

Off by default. Settings → Versions turns it on, and from then on every save you ask for — `Ctrl+S`,
or the tab menu's *Create version* — records what the file said. The word "version" is deliberate:
this is not a repository you branch or push, and nothing about it reaches the folder you are editing.

- **What gets recorded.** A file that already exists on disk, saved by hand, under a rule that says
  yes. The first save of a file records two rows: the text the file held when it was opened — dated
  when the file last changed on disk, not when the editor saw it — and then what you just saved. That
  first row is why a version can be diffed against "how this file started" rather than only against
  an earlier save.
- **What does not.** The automatic save writes the file and records nothing — unless Settings →
  Versions says otherwise, in which case its writes are recorded like any other. Off by default
  because a pause in typing is not somebody answering "keep this", and history is never trimmed, so
  recording every pause fills the list faster with moments nobody chose. An **encrypted** file is never versioned, unlocked or not: a
  version is that text stored in the clear in the app's own folder, beside a document you chose to
  encrypt — drafts are sealed with the file's key to avoid exactly that, and a version has no key at
  write time to seal itself with. A file bigger than the configured limit is saved normally and left
  out, with one notice per session. Pictures are never offered. And a save whose text is identical to
  the last recorded version adds nothing, so pressing `Ctrl+S` four times leaves one row — unless a
  note was written for it, which is the one thing that makes a save of unchanged text worth keeping.
- **Two switches, one rule.** Settings → Versions is the default for every file; a single file can
  override it from its tab menu (*Record versions for this file* / *Stop recording this file*) or in
  that file's Settings. `Create version` works whatever the switches say, and taking one turns that
  file on — asking for a version once is a decision about that file. It asks for a word about the
  version first: a line for the list, and as many lines under it as the reason needs. Both are
  optional, both are kept with the version, and neither can be edited afterwards, because the note
  lives inside the record it describes rather than beside it — which is why the question is asked
  once, there, and not offered later. The body is shown when the version is opened for comparison,
  and in the row's tooltip. Since a version is of the file as it stands on disk, asking for one while
  the tab has unsaved text writes the text first, and the note goes on the version that save
  produces rather than on a second row for the same thing.
- **A save that asks first.** *Ask for a note when I save* (Settings → Versions, off) puts the same
  box in front of a save you make by hand — `Ctrl+S`, or the mark on a tab — so the note is written
  while the version still has no message to be added to. Leaving it empty is the ordinary answer: it
  saves without a note. `Escape` saves nothing, which is what `Escape` means everywhere else in this
  app. Nothing is asked when a save cannot hold a version — a picture, an encrypted file, a new
  untitled tab, a file with nothing to write — nor by the automatic save, which has nobody at the
  keyboard to answer. Typing a note there does the same thing *Create version* does to the switches:
  it takes that file into history.
- **Comparing and restoring.** The Versions view lists the open file's history newest first. Each row
  opens the comparison popup, which shows any **two** sides of that history side by side: either side
  can be a recorded version or the text in the editor, with the clicked row on the left to start.
  Its controls are icons with the words in their tooltips — swap the two sides and *Restore* in the
  toolbar under the dropdowns, and show only the changes / fill the window / close at the right end
  of the title bar — because that bar is where the two texts get their width back, and a label in
  three languages would be the widest thing in it.
  The bar can be dragged, and the dialog resized from its right edge, bottom edge or corner; the size
  it had is kept across maximising, and both are forgotten when it closes, because a comparison is a
  look, not a layout. *Show only the changes* folds the view down to the hunks and a few lines around
  them, and the thin row under the diff says how many lines
  each side dropped, since a comparison that hides most of a file and says nothing about it can be
  argued into a wrong answer. Restoring puts a version's text into the editor and marks the tab
  unsaved; it never writes the file. Close without saving and nothing has changed on disk. Restoring
  does not record a version.
- **Not a cleanup.** Recorded history is never trimmed, and one version cannot be deleted on its own:
  history is stored as a chain, and taking a link out of the middle means rewriting everything after
  it. Settings → Versions → *Versions to list* bounds what is read, not what is kept; the only way to
  reclaim the disk is *Clear all versions*, which asks twice. If the growth ever matters more than the
  history, that is the switch to turn off.
- **Where it lives.** `<app data>\wrolp\shadow\`, one folder per file, named after the file the way
  drafts are. Each is a git repository with a single branch, and its content is your text — the same
  privacy level as the drafts folder, and deleted with it on uninstall. Nothing is written to the
  folders you edit, and a repository is never created for a file that was only opened.
- **Path is the identity.** Rename a file **inside the editor** and its history follows: the folder
  moves and the recorded name inside it stays as it was, which is what lets the timeline survive a
  rename without rewriting it. Rename it outside — Explorer, a sync client, `git mv` — and the new
  path finds nothing, so the list starts over. The old history is not lost, it is just no longer
  connected. Renaming onto a name that already has history keeps that name's own timeline and leaves
  the other one where it is; two histories are never merged.
- **Messages keep the language they were written in.** The label on a version is stored with it, so a
  history recorded in 中文 still says 初始版本 after you switch the interface to English.

## Source control

The fourth sidebar view is the set of real git repositories behind the group's folder: the one
the folder sits in (possibly above it), the ones found in its subdirectories, and any added by
hand. A compact list at the top switches between them; the panel below is the single-repository
panel described here. This is the opposite of [Version history](#version-history), which is a
private store per file and never touches the folders you edit.

- **Repositories.** Settings → Git → *Subdirectory depth* bounds the scan (0–5, default 2). The
  scan does not enter a repository it has found, skips `node_modules`, `target`, `dist`, bare
  repositories and links/junctions, and leaves submodules and linked worktrees to *Add
  repository*. A row shows the branch, ahead/behind and changed-file count; picking it switches
  the panel and is remembered per group. Manual entries, including repositories outside the
  folder, are stored in `groups.json` (so they come back with a configuration backup) and
  removing one only forgets the listing. One scan returns at most 50 repositories from 5,000
  directories. A parent repository is shown whole: its own changes list can include paths outside
  the group folder and untracked content of nested repositories, exactly as git reports them.
- **Changes.** Two lists, `Staged` and `Changes`, with the same one-letter badges `git status
  --short` uses. A path can be in both (staged text and further working-tree edits); each row acts
  on its own half. Clicking a row opens a read-only comparison tab — index against working tree, or
  HEAD against index — using the same diff viewer as every other comparison. A row with unsaved
  editor text says so; staging and committing always use the file on disk.
- **Actions.** Stage, unstage, discard one file or all of them. Discarding a tracked file checks the
  index version back out; discarding an untracked file deletes it, after a confirmation that names
  the count. A conflicted path is never discarded here — it is resolved through the merge flow.
- **Commit.** Only what is staged is committed, so the two lists mean what they say. The identity is
  the repository's own `user.name`/`user.email`; when those are missing, Settings → Git can supply a
  fallback, and with neither the commit is refused rather than signed by an invented person. The
  History section lists commits and the paths each one changed, and a changed path opens the same
  comparison against its first parent. A merge in progress takes no extra staging and commits with
  two parents.
- **Local-only state.** An untracked path can be *ignored locally*, which appends an anchored
  pattern to `.git/info/exclude`; a tracked one can be *assumed unchanged*, which sets the index's
  assume-unchanged bit so working-tree edits stop being reported. Both are reachable from the
  Explorer's context menu, a changed row's context menu, and *Local Git Settings* in the panel
  header; the dialog lists every entry, removes them one by one, and opens the exclude file. Assume
  unchanged is a promise: a checkout can overwrite those files.
- **Commit diff tabs.** Hover a history row for the full commit message; right-click it and choose
  *Open commit diff tab* to see every file the commit changed stacked vertically, each showing its
  diff against the first parent, and each foldable down to the changed lines. Binary, submodule,
  encrypted and oversized files say why instead of showing an empty diff; opening the same commit
  in the same repository again reuses its tab, while the same oid in another repository gets its
  own.
- **Branches.** The branch button lists local and remote-tracking branches, creates one from the
  current commit, switches and deletes with confirmation — a branch whose commits are not merged
  anywhere asks a second, explicit question before it is deleted. Picking a remote-tracking branch
  makes the local branch of the same name and sets it to track that remote one. Switching is refused while the index or
  the working tree has changes: a branch switch that half-succeeds is worse than one that asks you
  to commit or discard first.
- **Remotes.** Fetch, pull and push use libgit2 over the system's WinHTTP stack for HTTPS and
  libssh2 for SSH. Progress is shown while it runs and can be cancelled. Pull fast-forwards when it
  can; otherwise it merges, and a conflict opens a `Conflicts` list where each path can be taken as
  ours, as theirs, or opened in a three-pane merge editor: ours on the left, theirs on the right,
  and the result in the middle. Each marked block can take ours, theirs, or both, with undo; Apply
  writes the result back in the file's own encoding, BOM and line endings and marks the path
  resolved. Committing the result records
  the merge, and *Abort merge* puts the files back as they were before it started. Push sets the
  upstream on the first push and reports a rejected non-fast-forward in words rather than as a
  transport error.
- **Credentials.** HTTPS takes a username and a personal access token; SSH takes a private key and
  an optional passphrase. They are kept in `state/git.json` in plain text, like the rest of this
  app's state, and are **not** included in configuration backups, so a token is not copied into
  every safety snapshot. The credential dialog masks the secret with a reveal button, and the Rust
  side never hands a stored secret back to the frontend. The first connection to an SSH host asks
  you to trust its SHA-256 fingerprint; later connections compare against what you approved and
  refuse a changed key. Settings → Git lists stored hosts and lets you forget them.
- **Explorer marks and the status bar.** The Explorer collects marks from every listed
  repository under the folder; when a path is reported by two of them, the nearest repository
  owns it. Above 12 repositories only the selected one and the folder's own repository are
  decorated, and the list says so. The status bar follows the selected repository, with its
  folder name in front when more than one is listed.
- **What it deliberately does not do.** No stash, tags, rebase, cherry-pick, blame or clone wizard;
  no diff3 auto-merge, character-level or binary merge — the editor works on line-level two-way
  markers, and a repository configured for diff3 markers is refused with the three quick actions
  as the fallback; nested repositories and
  submodules are shown as single paths rather than aggregated; libgit2 does not run hooks, so
  `pre-commit`/`post-checkout` scripts and git-lfs are not applied. Status stops at 5,000 paths and
  a diff side over 2 MB is reported rather than rendered. The panel refreshes every five seconds
  while it is visible, after a save, and when the window regains focus.

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
- **Applied before the window is shown.** The window is created hidden, placed in Rust during
  setup, and only then shown, so the saved size is the first frame painted. Restoring from the page
  instead showed the configured 1180×740 window for as long as the webview took to boot and then
  resized it — a maximized window flashed up small before filling the screen.
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
