import { Channel, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { openPath, openUrl, revealItemInDir } from "@tauri-apps/plugin-opener";
import { t, translateError } from "./i18n";

export interface OpenedFile {
  path: string;
  content: string;
  mtime: number;
  /** Encoding the bytes actually turned out to be. */
  encoding: string;
  /** The file carried a BOM that was stripped from `content`. */
  bom: boolean;
  /** Size on disk in bytes. */
  bytes: number;
  /** A picture: `content` is empty and the editor must stay out of the way. */
  binary: boolean;
  /** The file on disk is an encrypted container. `mtime` and `bytes` then describe the
   * ciphertext, which is what a later save has to beat. */
  encrypted: boolean;
  /** Encrypted with no key available, so `content` is empty because nothing was decrypted.
   * This is a lock to be shown, not an empty buffer to be typed into. */
  locked: boolean;
}

export interface SavedFile {
  path: string;
  mtime: number;
  /** Encoding actually written, after resolving aliases. */
  encoding: string;
  /** Bytes actually written; differs from the text length for legacy encodings. */
  bytes: number;
}

/** What a file on disk currently is, without reading its bytes. */
export interface FileStat {
  path: string;
  mtime: number;
  bytes: number;
}

export interface Draft {
  path: string;
  content: string;
  cursor: number;
  updatedAt: string;
}

export interface FsEntry {
  name: string;
  path: string;
  isDir: boolean;
}

/** One picture in a gallery listing. Metadata only; the image itself is read by the webview. */
export interface ImageEntry {
  name: string;
  path: string;
  bytes: number;
}

/** Pictures in a folder, in natural order, plus what the walk did. */
export interface ImageList {
  items: ImageEntry[];
  /** The folder held more pictures than one listing returns. */
  truncated: boolean;
  /** Directory entries examined to build the list. */
  scanned: number;
}

/** What pasting the system clipboard produced: the copies made, and sources it could not take. */
export interface ClipboardPaste {
  copied: FsEntry[];
  failed: number;
}

export interface HistoryEntry {
  path: string;
  name: string;
  openedAt: string;
}

/**
 * A folder the Explorer has been pointed at. Each group keeps its own list of these; the id is
 * passed to every call that reads or writes one. `exists` is settled by the backend on every
 * read rather than remembered when the folder was recorded, so a drive that was unplugged while
 * the app was closed greys its row instead of offering somewhere that is not there.
 */
export interface FolderHistoryEntry {
  path: string;
  name: string;
  openedAt: string;
  exists: boolean;
}

/** What moved after a rename: both spellings are backend-normalized. */
export interface Renamed {
  oldPath: string;
  path: string;
}

/** One entry of a batch rename: a bare name for the entry at `path`. */
export interface RenameInput {
  path: string;
  name: string;
}

export interface Settings {
  fontSize: number;
  minimap: boolean;
  sidebarVisible: boolean;
  sidebarView: string;
  sidebarWidth: number;
  /** Sidebar text size in CSS pixels, 11 to 20. 12 is the size the file tree was pinned at. */
  sidebarFont: number;
  /** Language code; unknown values are stored as-is and fall back to English in the UI. */
  language: string;
  /** Reopen the tabs of the active group on startup. */
  restoreSession: boolean;
  /** Replace the comparison tab on screen with the next comparison instead of opening another. */
  compareReuseTab: boolean;
  /**
   * What a reopened session does with a draft the file on disk does not have: `auto` loads
   * it without asking, `ask` raises the Restore / Discard dialog per file. `auto` is the
   * default because the draft is the only copy of that typing and a dialog is one reflex
   * away from discarding it.
   */
  draftRestore: string;
  /** Where the Explorer stood before groups kept their own folder; read once at startup. */
  sidebarRoot: string;
  /** Expand folders when a directory is opened. Off by default. */
  expandFolders: boolean;
  /** Levels to expand while `expandFolders` is on: 1 is the folders under the root. */
  expandDepth: number;
  /**
   * File types that must not show "Open with WROLP" in Explorer's context menu, as
   * extensions without the dot. Changing this rewrites the registry entries.
   */
  excludedExtensions: string[];
  /** Tighten the app chrome. Does not touch the editor's font size or line height. */
  compactMode: boolean;
  /** `auto` sniffs every file; the rest force one encoding. */
  encoding: string;
  /** none | boundary | selection | all | trailing. */
  renderWhitespace: string;
  wordWrap: boolean;
  stickyScroll: boolean;
  /** system | dark | light. `system` follows the OS preference at runtime. */
  theme: string;
  /** Columns per indentation level, 1..8. */
  tabSize: number;
  /** Insert spaces rather than a tab character. */
  insertSpaces: boolean;
  /** Let a file's own content decide the indentation instead of the two settings above. */
  detectIndentation: boolean;
  /**
   * How a document with no line endings of its own is written: `lf` | `crlf`. A file that was
   * read with breaks in it keeps them whatever this says — only the per-file override rewrites
   * an existing file, and that is by design, because a setting must not turn a folder of CRLF
   * files into a diff nobody asked for.
   */
  lineEnding: string;
  /** Drop spaces and tabs at the end of a line as the file is saved. Off by default. */
  trimTrailingWhitespace: boolean;
  /** Add the line break a file is missing when it is saved. Off by default. */
  insertFinalNewline: boolean;
  /** Write dirty files back on a timer. Off by default, and it never touches an untitled buffer. */
  autoSave: boolean;
  /** Seconds between two sweeps of the automatic save; only read while `autoSave` is on. */
  autoSaveInterval: number;
  /** Allow scrolling past the end so the last line can sit above the bottom edge. */
  scrollBeyondLastLine: boolean;
  /**
   * How a file that has a preview opens: `auto` | `text` | `split` | `preview`.
   * `text` is the default; `auto` is the per-kind behaviour (markdown and SVG side by side).
   * A picture is not covered by this — its bytes are not text, so it always opens as itself.
   */
  previewLayout: string;
  /**
   * How wide the rendered markdown body is inside its pane: `narrow` | `wide` | `full`.
   * The first two cap the line length for readability and centre it; `full` lets the text
   * run the width of the pane. Only the markdown preview is measured this way — an HTML
   * preview renders a document that sets its own width.
   */
  previewWidth: string;
  /**
   * Layout each previewable file was last left in, keyed by absolute path: `text` | `split` |
   * `preview`. A missing key means the file follows `previewLayout`; the backend drops values
   * it does not recognise, so this map only ever carries explicit choices.
   */
  previewModes: Record<string, string>;
  /**
   * Which side the markdown outline takes in preview-only mode: `left` | `right`. Right by
   * default, so the column does not sit against the Explorer.
   */
  tocSide: string;
  /** Seconds a gallery slideshow keeps one picture on screen, 1 to 60. */
  galleryInterval: number;
  /** After the last picture, the slideshow starts over instead of stopping. */
  galleryLoop: boolean;
  /**
   * What sits behind a picture's transparent pixels: `checker` for the theme's checkerboard, or
   * a lowercase `#rrggbb` colour. It is a colour rather than a swatch name because the picker is
   * the browser's own, and its output is the value. The backend keeps only those two shapes.
   */
  imageBackdrop: string;
  /**
   * Minutes an encrypted file stays unlocked without being touched. 0 means never lock
   * automatically, and is a choice rather than a missing value: the backend keeps it as
   * written, so the frontend has to carry it back or a save would reset it to the default.
   */
  encryptIdleMinutes: number;
  /**
   * Record a version of a file each time it is saved by hand. Off by default: versioning writes on
   * every save and does not clean up afterwards, so it is a thing to switch on rather than to find
   * switched on.
   */
  versioningEnabled: boolean;
  /**
   * How many versions of one file the list reads. Not a retention limit — history is never trimmed
   * from the middle, so this only bounds how far it is walked.
   */
  versioningShowLimit: number;
  /** Files bigger than this are left out of versioning, in bytes. 0 is read as the default. */
  versioningMaxFileSize: number;
  /** Directory levels below the group folder scanned for repositories (0..=5). */
  gitScanDepth: number;
  /**
   * Whether a write made by the automatic save also records a version. Off by default: the timer
   * runs whether or not anybody is at the keyboard, and recording it fills the timeline with
   * whatever the interval happened to catch. Only ever applies to a file versioning tracks.
   */
  autoSaveVersions: boolean;
  /**
   * Whether a save asked for by hand is stopped first, to ask what that version is for. Its own
   * switch: a box in the way of `Ctrl+S` is only tolerable once somebody chose it.
   */
  askNoteOnSave: boolean;
  /** Where configuration snapshots are written; empty means `wrolp/backups`. */
  backupDir: string;
  /** How many snapshots are kept. Older ones are removed when a new one is written. */
  backupRetain: number;
}

/**
 * The folders the app's own files live in, resolved by the backend. The frontend is not
 * given the layout because it would then have to be right twice.
 */
export interface StoreDirs {
  /** settings.json, groups.json, history.json, window.json, file-settings.json. */
  state: string;
  /** One file per document with unsaved edits. */
  drafts: string;
  /** One shadow repository per versioned file. Only there once something has been recorded. */
  versions: string;
  /** Whether `versions` exists to be opened. */
  versionsPresent: boolean;
}

/** One configuration snapshot, as the backend found it on disk. */
export interface BackupInfo {
  path: string;
  file: string;
  /** ISO-8601 with the local offset it was written at. */
  createdAt: string;
  /** `auto`, `manual` or `pre-restore`. */
  kind: string;
  bytes: number;
  /** What restoring it would bring back, read from the snapshot rather than the live state. */
  groups: number;
  tabs: number;
  files: number;
}

export interface BackupList {
  /** The folder in use, after resolving an empty setting to the default. */
  dir: string;
  dirExists: boolean;
  /** Newest first. Damaged files are left out rather than offered for restore. */
  backups: BackupInfo[];
}

/** One recorded version of a file: a point in its history, without its text. */
export interface VersionEntry {
  /** Opaque id every later call needs — read it, never show it. */
  oid: string;
  /** ISO-8601 UTC. */
  ts: string;
  /** What the user called this version: one line, in the language it was written in. */
  message: string | null;
  /** What they said under that line, if anything. Keep it out of the row; show it when opened. */
  body: string | null;
}

/** A file that carries history, as the store reports it. */
export interface VersionSummary {
  path: string;
  name: string;
  /** ISO-8601 UTC of the newest version. */
  latestTs: string;
}

/** What recording a version did. */
export type AppendOutcome =
  | { status: "created"; oid: string }
  | { status: "skipped" };

/** The versioning rules as they stand for one file. */
export interface VersionState {
  /** Whether this file's saves are recorded. */
  tracking: boolean;
  /** `on` / `off`, or null while the file follows the global default. */
  override: string | null;
}

/**
 * The content a file had before the editor changed it, sent with the save that replaced it.
 * The store cannot have it — by the time a version is recorded, the file holds the new text.
 */
export interface VersionBaseline {
  content: string;
  message: string | null;
  /** When the file last changed on disk, in epoch seconds, read before the save overwrote it. */
  at: number | null;
}

/** What HEAD points at, as the Source Control panel reads it. */
export interface GitHeadInfo {
  /** `main` for a branch; null when detached. */
  branch: string | null;
  oid: string | null;
  short: string | null;
  detached: boolean;
  /** A branch with no commit yet: a repository right after `git init`. */
  unborn: boolean;
  /** `origin/main` when the current branch tracks a remote one. */
  upstream: string | null;
  ahead: number;
  behind: number;
}

/** Where the repository is and what state it is in. */
export interface GitRepoInfo {
  /** The work tree, which may sit above the group's folder. */
  root: string;
  gitDir: string;
  /** The folder the panel asked about. */
  requested: string;
  head: GitHeadInfo;
  /** clean | merge | revert | cherry-pick | bisect | rebase | apply-mailbox */
  state: string;
}

export interface GitStatusEntry {
  /** Repository-relative, forward slashes. */
  path: string;
  /** Absolute path for opening, revealing and diffing. */
  abs: string;
  oldPath: string | null;
  /** One letter for the index half: A, M, D, R or T. */
  index: string | null;
  /** One letter for the working-tree half: ?, M, D, R or T. */
  workdir: string | null;
  kind: "tracked" | "untracked" | "conflicted" | "ignored";
  submodule: boolean;
}

export interface GitStatusView {
  repo: GitRepoInfo;
  files: GitStatusEntry[];
  staged: number;
  changed: number;
  untracked: number;
  conflicted: number;
  /** The repository had more changed paths than this answer carried. */
  truncated: boolean;
}

export interface GitDiffSide {
  path: string;
  name: string;
  text: string;
  oid: string | null;
  missing: boolean;
}

export interface GitDiffText {
  left: GitDiffSide;
  right: GitDiffSide;
  binary: boolean;
  tooLarge: boolean;
  submodule: boolean;
  encrypted: boolean;
}

export interface GitBranchInfo {
  name: string;
  remote: boolean;
  current: boolean;
  short: string | null;
  upstream: string | null;
}

/** A name pointing at a commit: HEAD, a branch, a remote-tracking branch or a tag. */
export interface GitRefLabel {
  name: string;
  kind: "head" | "local" | "remote" | "tag";
}

export interface GitLogEntry {
  oid: string;
  short: string;
  summary: string;
  message: string;
  author: string;
  email: string;
  /** ISO-8601 UTC. */
  time: string;
  parents: string[];
  /** HEAD first, then local branches, remotes and tags. Empty is ordinary. */
  refs: GitRefLabel[];
}

/** One path a commit changed, as the commit view lists it. */
export interface GitCommitFile {
  path: string;
  oldPath: string | null;
  status: string;
  abs: string;
}

/** One path's local-only git state, for the Explorer's context menu. */
export interface GitLocalPathState {
  repoRoot: string;
  /** An index entry exists at some stage, so ignore rules cannot hide it. */
  tracked: boolean;
  /** The stage-0 entry carries assume-unchanged. */
  assumed: boolean;
  /** Read-only for now: this feature never writes the skip-worktree bit. */
  skipWorktree: boolean;
  ignored: boolean;
  /** The line in `info/exclude` covering this path, when the app can name one. */
  localPattern: string | null;
  excludePath: string;
}

export interface GitLocalFile {
  path: string;
  abs: string;
}

/** What the local git settings dialog lists for one repository. */
export interface GitLocalView {
  repoRoot: string;
  excludePath: string;
  excludeExists: boolean;
  /** Non-empty, non-comment lines of `info/exclude`, in file order. */
  ignores: string[];
  /** Stage-0 entries carrying assume-unchanged. */
  assumed: GitLocalFile[];
  truncated: boolean;
}

export interface GitCommitResult {
  oid: string;
  short: string;
  summary: string;
}

/** The commit HEAD points at, used to prefill the amend box. */
export interface GitHeadCommit {
  oid: string;
  short: string;
  message: string;
}

/** One repository the Source Control panel lists. Manual entries are added by the frontend. */
export interface GitRepoEntry {
  /** Work tree, in the spelling the filesystem uses. */
  root: string;
  gitDir: string;
  name: string;
  /** `.`, `../name`, `packages/app`, or an absolute path for a manual repository. */
  relative: string;
  source: "root" | "parent" | "scan" | "manual";
}

export interface GitScanView {
  repos: GitRepoEntry[];
  /** The walk hit a directory or repository limit before finishing. */
  truncated: boolean;
  scannedDirs: number;
  skipped: number;
}

/** One repository row's counts, without the file list. */
export interface GitRepoSummary {
  repo: GitRepoInfo;
  staged: number;
  changed: number;
  untracked: number;
  conflicted: number;
  files: number;
}

/** What a diff is comparing: index → working tree, HEAD → index, or a commit's parent → it. */
export type GitScope = "workdir" | "index" | "commit";

/** One step of a network operation, streamed while it runs. */
export interface GitProgress {
  /** starting | receiving | message | merging | writing | done */
  phase: string;
  received: number;
  total: number;
  bytes: number;
  percent: number;
  /** A line of server output (sideband), when there is one. */
  text: string | null;
}

export interface GitRemote {
  name: string;
  /** With any user info stripped. */
  url: string;
  host: string | null;
}

export interface GitPullOutcome {
  result: "up_to_date" | "fast_forward" | "merged" | "conflicted";
  conflicted: string[];
  repo: GitRepoInfo;
}

export interface GitPushOutcome {
  repo: GitRepoInfo;
  upstream: string | null;
}

/** The three versions of a conflicted path the index holds; missing sides are null. */
export interface GitConflictSides {
  path: string;
  base: string | null;
  ours: string | null;
  theirs: string | null;
  /** The working-tree text, markers included; null for a deleted file. */
  merged: string | null;
  /** A graphical merge is not possible. */
  binary: boolean;
  /** Encoding of the working tree, for display only: the backend writes with the same rule. */
  encoding: string;
  bom: boolean;
  /** lf | crlf | "" */
  eol: string;
  /** The working tree is above the diff ceiling. */
  tooLarge: boolean;
}

export interface GitIdentity {
  name: string;
  email: string;
}

/** A stored credential, without the secret itself. */
export interface GitCredentialView {
  host: string;
  kind: "https" | "ssh";
  username: string | null;
  keyPath: string | null;
  hasSecret: boolean;
  hasPassphrase: boolean;
}

export interface GitKnownHostView {
  host: string;
  fingerprint: string;
}

export interface GitAuthView {
  identity: GitIdentity | null;
  credentials: GitCredentialView[];
  knownHosts: GitKnownHostView[];
}

/** One restored tab: either a file (path + cursor) or scratch text (untitled + content). */
export interface GroupTab {
  path: string;
  cursor: number;
  untitled: string;
  content: string;
}

export interface Group {
  id: string;
  /** Chosen by the user; the only thing that tells one group from another. */
  name: string;
  tabs: GroupTab[];
  /** Key of the selected tab: its path, or `untitled://<name>`. Empty when none. */
  active: string;
  /** Folder the Explorer shows while this group is on screen; empty when it has none. */
  root: string;
  /** Repositories added by hand to the Source Control panel, outside the scan depth. */
  gitRoots: string[];
  /** Repository the Source Control panel was showing; empty means "pick the usual one". */
  gitSelected: string;
  updatedAt: string;
}

export interface GroupStore {
  version: number;
  active: string;
  items: Group[];
}

/** Where the window was left, in physical pixels. `maximized` is the state to enter with. */
export interface WindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

export interface MonitorRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A stored rectangle plus the monitors that exist today, judged on the Rust side. */
export interface Placement extends WindowState {
  /** True when the saved rectangle could not be used as it was. */
  adjusted: boolean;
}

/** Re-homing a tab: `tab` is a tab key, or null for every tab of the source group. */
export type TabTransfer =
  | { action: "move"; from: string; to: string; tab: string | null }
  | { action: "copy"; from: string; to: string; tab: string | null };

export interface MenuTarget {
  installed: boolean;
  registered: string | null;
  expected: string;
  matchesCurrent: boolean;
  /** How many file types are currently masked out of the menu. */
  excludedCount: number;
  /**
   * Entries exist only under a key spelling that never worked, so the menu is invisible
   * even though the user had it switched on. The app repairs that on startup.
   */
  staleLayout: boolean;
  debugBuild: boolean;
}

export const EMPTY_GROUP_STORE: GroupStore = { version: 1, active: "", items: [] };

/**
 * Per-file overrides. A missing field means "follow the global default", which is why
 * every one is optional rather than carrying a copy of the default.
 */
export interface FileSettings {
  renderWhitespace: string | null;
  wordWrap: boolean | null;
  stickyScroll: boolean | null;
  minimap: boolean | null;
  tabSize: number | null;
  insertSpaces: boolean | null;
  detectIndentation: boolean | null;
  encoding: string | null;
  /**
   * Write this file's line breaks as `lf` or `crlf`. Unlike every other field here, `null` does
   * not mean "take the global setting": it means the file keeps the endings it was read with,
   * which is why the global value is never shown as this one's fallback.
   */
  lineEnding: string | null;
  /**
   * Record this file's saves as versions: `on`, `off`, or null to follow the global default.
   * Unlike `lineEnding` the fallback is the setting, so the panel shows what following means.
   */
  versioning: string | null;
}

export const EMPTY_FILE_SETTINGS: FileSettings = {
  renderWhitespace: null,
  wordWrap: null,
  stickyScroll: null,
  minimap: null,
  tabSize: null,
  insertSpaces: null,
  detectIndentation: null,
  encoding: null,
  lineEnding: null,
  versioning: null,
};

export interface FileSettingsView {
  defaults: FileSettings;
  overrides: FileSettings;
  /** `[value, i18n key suffix]` pairs straight from the backend's accepted list. */
  encodings: [string, string][];
  whitespace: string[];
}

export const api = {
  takeStartupFiles: () => invoke<string[]>("take_startup_files"),
  /** `record: false` keeps a session restore from rewriting the recent-files history. */
  openFile: (path: string, record = true, encoding?: string) =>
    invoke<OpenedFile>("open_file", { path, record, encoding: encoding ?? null }),
  /** Hand a file to the OS's default application. Validated on the backend, not via scope. */
  openInSystem: (path: string) => invoke<void>("open_in_system", { path }),
  /** Read one image a document references, as base64, under the asset-protocol scope. */
  readExportAsset: (path: string) => invoke<string>("read_export_asset", { path }),
  /** Write an exported document (.docx/.pdf); base64 so big bytes stay off the JSON wire. */
  writeExport: (path: string, data: string) => invoke<void>("write_export", { path, data }),
  /**
   * Metadata only, so a background check of every open file stays cheap.
   *
   * `null` is an answer, not a failure: the file is not there any more. Only a failure to
   * *look* rejects, and that is deliberately left as "unknown", so a share that is not
   * answering cannot be read as a change.
   */
  statFile: (path: string) => invoke<FileStat | null>("stat_file", { path }),
  /**
   * Write the text of a file that was deleted while it was open into the folder this app
   * keeps for that, under the name it had.
   *
   * The buffer is the only place the text still exists, and this makes it a file again —
   * editable, saveable, and openable later from the recent-files list.
   */
  keepFile: (path: string, content: string, encoding?: string, bom?: boolean) =>
    invoke<SavedFile>("keep_file", { path, content, encoding: encoding ?? null, bom: bom ?? null }),
  saveFile: (path: string, content: string, encoding?: string, bom?: boolean) =>
    invoke<SavedFile>("save_file", { path, content, encoding: encoding ?? null, bom: bom ?? null }),
  /**
   * Rename a file or a folder on disk, and re-home every piece of state keyed by the old
   * path. `name` is a bare name: the backend refuses one carrying a separator, because
   * moving an entry between folders is a different action from renaming it.
   */
  renamePath: (path: string, name: string) =>
    invoke<Renamed>("rename_path", { path, name }),
  /**
   * Rename several entries at once.
   *
   * The whole batch is checked before anything moves, so a refused name leaves the disk
   * alone; names that are still occupied by other entries of the batch — a numbering that
   * shifts, a swap — are handled by the backend stepping through a temporary name. Returns
   * one `oldPath`/`path` pair per item, in the order asked for.
   */
  renameEntries: (items: RenameInput[]) =>
    invoke<Renamed[]>("rename_entries", { items }),
  /**
   * Create an empty file inside a folder. `name` is a bare name, and the backend appends
   * `.txt` to one typed without any dot, so the result is a text file rather than a name
   * every other tool reads as an unknown binary.
   */
  createFile: (parent: string, name: string) =>
    invoke<FsEntry>("create_file", { parent, name }),
  /** Create a folder inside a folder. `name` is a bare name, as for a rename. */
  createDir: (parent: string, name: string) =>
    invoke<FsEntry>("create_dir", { parent, name }),
  /**
   * Copy a file, or a folder and everything in it, into `target`.
   *
   * Nothing is replaced: the copy takes the next free spelling of the name, which is why the
   * entry it made is handed back — the caller shows the name the paste actually got.
   */
  copyEntry: (source: string, target: string) =>
    invoke<FsEntry>("copy_entry", { source, target }),
  /**
   * Copy the files on the system clipboard (what Explorer put there) into `target`.
   *
   * Each one lands by the same rules as `copyEntry`. A source that cannot be taken does not
   * stop the rest; nothing landing at all is an error carrying the first reason.
   */
  pasteClipboardFiles: (target: string) =>
    invoke<ClipboardPaste>("paste_clipboard_files", { target }),
  /**
   * Delete a file, or a folder and everything in it, and stop the store pointing at it.
   *
   * Nothing is moved, so there is nothing to undo and nothing reaches the Recycle Bin: the
   * caller is expected to have asked the user first. Unsaved work is not thrown away with
   * the entry — the drafts stay, and are offered again if the same path ever comes back.
   */
  removeEntry: (path: string) => invoke<void>("remove_entry", { path }),
  getDraft: (path: string) => invoke<Draft | null>("get_draft", { path }),
  /** `null` means nothing was written because the file is encrypted and locked. Drafting
   * runs in the background, so that is an answer rather than an error. */
  saveDraft: (path: string, content: string, cursor: number) =>
    invoke<Draft | null>("save_draft", { path, content, cursor }),
  clearDraft: (path: string) => invoke<boolean>("clear_draft", { path }),
  /**
   * Decrypt a file with a password the user just typed, and cache the key for the session.
   *
   * The password goes one way: neither it nor the key is ever handed back, so the only
   * thing a caller can do with a success is read the returned document.
   */
  unlockFile: (path: string, password: string) =>
    invoke<OpenedFile>("unlock_file", { path, password }),
  /** Drop every cached key, which is what the idle lock asks for. */
  lockAll: () => invoke<void>("lock_all"),
  /**
   * Put the password in the OS credential store, so a later session opens the file without
   * asking. Best-effort by design: it is called after an unlock that already succeeded, and
   * a credential store that refuses must not be reported as a failure to open the file.
   */
  rememberPassword: (path: string, password: string) =>
    invoke<void>("remember_password", { path, password }),
  /** Stop keeping the password of one file. The session key is untouched, so an open tab
   * stays readable until it is locked. */
  forgetPassword: (path: string) => invoke<void>("forget_password", { path }),
  /**
   * Only whether a password is kept, never the password: it stays in Rust, because a value in
   * a JavaScript heap is a value in a devtools console.
   */
  recallPassword: (path: string) => invoke<boolean>("recall_password", { path }),
  rememberedPasswordCount: () => invoke<number>("remembered_password_count"),
  clearRememberedPasswords: () => invoke<number>("clear_remembered_passwords"),
  /** Drop the session key of one file, locking it without waiting for the idle limit. */
  lockFile: (path: string) => invoke<void>("lock_file", { path }),
  /**
   * Write text out as a brand new encrypted file. The container gets a fresh salt at the
   * current cost, and the key is cached, so the tab that follows opens unlocked.
   */
  saveFileAsEncrypted: (path: string, content: string, password: string) =>
    invoke<SavedFile>("save_file_as_encrypted", { path, content, password }),
  /** Create an empty encrypted file in `parent`; the backend supplies `.wrolpenc` when the
   * typed name has no extension of its own. */
  createEncrypted: (parent: string, name: string, password: string) =>
    invoke<FsEntry>("create_encrypted", { parent, name, password }),
  /**
   * Re-encrypt a file under a new password. The old one is verified rather than taken from the
   * cache: the user is asserting what it is, and acting on a wrong assertion would hand back a
   * file they can no longer open.
   */
  changePassword: (path: string, oldPassword: string, newPassword: string) =>
    invoke<SavedFile>("change_password", { path, oldPassword, newPassword }),
  /** Verify the password and write the plaintext back out as UTF-8. */
  removeEncryption: (path: string, password: string) =>
    invoke<SavedFile>("remove_encryption", { path, password }),
  listDir: (path: string) => invoke<FsEntry[]>("list_dir", { path }),
  /**
   * Pictures in a folder, files only and in natural order (`IMG_2` before `IMG_10`).
   * A recursive listing walks up to four levels and skips `node_modules`/`target`/`dist`/`.git`.
   */
  listImages: (dir: string, recursive: boolean) =>
    invoke<ImageList>("list_images", { dir, recursive }),
  fileSettingsView: (path: string) => invoke<FileSettingsView>("file_settings_view", { path }),
  saveFileSettings: (path: string, settings: FileSettings) =>
    invoke<FileSettings>("save_file_settings", { path, settings }),
  clearFileSettings: (path: string) => invoke<void>("clear_file_settings", { path }),
  /**
   * Grant the asset protocol read access to one directory, so markdown can render
   * relative images. Called with the opened file's own folder and nothing wider.
   */
  allowAssetDir: (dir: string) => invoke<void>("allow_asset_dir", { dir }),
  /**
   * Render a diagram with a locally installed program, returning SVG.
   *
   * `kind` is `graphviz` or `plantuml`; anything else is refused by the backend before a
   * process is started. The error string is shown to the user as-is, so it is written to be
   * read ("diagram_missing:plantuml" says the program is not installed).
   */
  renderDiagram: (kind: string, source: string) =>
    invoke<string>("render_diagram", { kind, source }),
  getHistory: () => invoke<HistoryEntry[]>("get_history"),
  removeHistory: (path: string) => invoke<HistoryEntry[]>("remove_history", { path }),
  removeHistoryMany: (paths: string[]) =>
    invoke<HistoryEntry[]>("remove_history_many", { paths }),
  clearHistory: () => invoke<void>("clear_history"),
  getFolderHistory: (group: string) =>
    invoke<FolderHistoryEntry[]>("get_folder_history", { group }),
  recordFolderHistory: (group: string, dir: string) =>
    invoke<void>("record_folder_history", { group, dir }),
  removeFolderHistory: (group: string, path: string) =>
    invoke<FolderHistoryEntry[]>("remove_folder_history", { group, path }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  getStoreDirs: () => invoke<StoreDirs>("get_store_dirs"),
  createConfigBackup: () => invoke<BackupInfo>("create_config_backup"),
  listConfigBackups: () => invoke<BackupList>("list_config_backups"),
  /** Opens the backup folder in the file manager; the backend resolves it from the setting. */
  openBackupFolder: () => invoke<void>("open_backup_folder"),
  /** Replaces the state files with a snapshot; returns how many were written. */
  restoreConfigBackup: (path: string) =>
    invoke<number>("restore_config_backup", { path }),
  /**
   * Refresh the day's automatic snapshot. `force` is the open/close path, which replaces
   * today's automatic one; without it the hourly check only fills in a missing day. Null
   * means nothing was written.
   */
  maybeAutoBackup: (force = false) =>
    invoke<BackupInfo | null>("maybe_auto_backup", { force }),
  /** Which rule this file is under: the override it carries and what that resolves to. */
  versioningState: (path: string) => invoke<VersionState>("versioning_state", { path }),
  /** `null` lets the file follow the global default again. */
  setVersionOverride: (path: string, mode: string | null) =>
    invoke<VersionState>("set_version_override", { path, mode }),
  /**
   * Record a save. `baseline` is the text the file had before this edit, which only the editor
   * still holds, and the backend writes it first when the file has no history yet. `automatic`
   * says the write came from the timer — the backend decides from the settings whether that counts,
   * so the caller reports rather than judges.
   */
  addVersion: (
    path: string,
    content: string,
    message: string | null,
    baseline: VersionBaseline | null,
    automatic: boolean
  ) => invoke<AppendOutcome>("add_version", { path, content, message, baseline, automatic }),
  getVersions: (path: string) => invoke<VersionEntry[]>("get_versions", { path }),
  /** One version's text, read when it is about to be shown or restored. */
  getVersionContent: (path: string, oid: string) =>
    invoke<string>("get_version_content", { path, oid }),
  listVersions: () => invoke<VersionSummary[]>("list_versions"),
  clearVersions: () => invoke<void>("clear_versions"),
  gitStatus: (root: string) => invoke<GitStatusView>("git_status", { root }),
  gitRepoInfo: (root: string) => invoke<GitRepoInfo>("git_repo_info", { root }),
  gitScanRepos: (root: string, depth: number) =>
    invoke<GitScanView>("git_scan_repos", { root, depth }),
  gitRepoSummary: (root: string) => invoke<GitRepoSummary>("git_repo_summary", { root }),
  gitInit: (root: string) => invoke<void>("git_init", { root }),
  /**
   * A file's two texts for the diff editor. `scope` picks the pair; `oldPath` is the repository
   * path a rename came from, used only for the left-hand lookup.
   */
  gitDiff: (
    root: string,
    path: string,
    scope: GitScope,
    oldPath?: string | null,
    rev?: string | null
  ) =>
    invoke<GitDiffText>("git_diff", {
      root,
      path,
      oldPath: oldPath ?? null,
      scope,
      rev: rev ?? null,
    }),
  gitStage: (root: string, paths: string[]) => invoke<void>("git_stage", { root, paths }),
  gitUnstage: (root: string, paths: string[]) => invoke<void>("git_unstage", { root, paths }),
  gitDiscard: (root: string, paths: string[]) => invoke<void>("git_discard", { root, paths }),
  /** The repository's own exclude file and the index's assume-unchanged bit. */
  gitLocalState: (path: string) => invoke<GitLocalPathState>("git_local_state", { path }),
  gitLocalIgnore: (path: string) => invoke<void>("git_local_ignore", { path }),
  gitLocalUnignore: (root: string, pattern: string) =>
    invoke<void>("git_local_unignore", { root, pattern }),
  gitAssumeUnchanged: (root: string, paths: string[], enabled: boolean) =>
    invoke<number>("git_assume_unchanged", { root, paths, enabled }),
  gitLocalView: (root: string) => invoke<GitLocalView>("git_local_view", { root }),
  gitExcludeOpen: (root: string) => invoke<string>("git_exclude_open", { root }),
  /** Commits what is staged. Nothing is added on the way; `amend` replaces HEAD instead. */
  gitCommit: (root: string, message: string, amend: boolean) =>
    invoke<GitCommitResult>("git_commit", { root, message, amend }),
  /** The message of the commit HEAD points at; null on an unborn branch. */
  gitHeadCommit: (root: string) => invoke<GitHeadCommit | null>("git_head_commit", { root }),
  /** `all` walks every branch, tag and remote-tracking ref instead of HEAD alone. */
  gitLog: (root: string, limit?: number, skip?: number, all = false) =>
    invoke<GitLogEntry[]>("git_log", {
      root,
      limit: limit ?? null,
      skip: skip ?? null,
      all,
    }),
  gitCommitFiles: (root: string, rev: string) =>
    invoke<GitCommitFile[]>("git_commit_files", { root, rev }),
  gitBranches: (root: string) => invoke<GitBranchInfo[]>("git_branches", { root }),
  gitCreateBranch: (root: string, name: string, checkout: boolean) =>
    invoke<void>("git_create_branch", { root, name, checkout }),
  gitSwitchBranch: (root: string, name: string) =>
    invoke<void>("git_switch_branch", { root, name }),
  gitDeleteBranch: (root: string, name: string, force = false) =>
    invoke<void>("git_delete_branch", { root, name, force }),
  gitRemotes: (root: string) => invoke<GitRemote[]>("git_remotes", { root }),
  /** Long operations take an `opId` so `git_cancel` can stop them, and stream progress. */
  gitFetch: (
    root: string,
    remote: string | null,
    opId: string,
    onProgress: (progress: GitProgress) => void
  ) => {
    const channel = new Channel<GitProgress>();
    channel.onmessage = onProgress;
    return invoke<GitRepoInfo>("git_fetch", {
      root,
      remote,
      opId,
      onProgress: channel,
    });
  },
  gitPull: (
    root: string,
    remote: string | null,
    opId: string,
    onProgress: (progress: GitProgress) => void
  ) => {
    const channel = new Channel<GitProgress>();
    channel.onmessage = onProgress;
    return invoke<GitPullOutcome>("git_pull", {
      root,
      remote,
      opId,
      onProgress: channel,
    });
  },
  gitPush: (
    root: string,
    remote: string | null,
    opId: string,
    onProgress: (progress: GitProgress) => void
  ) => {
    const channel = new Channel<GitProgress>();
    channel.onmessage = onProgress;
    return invoke<GitPushOutcome>("git_push", {
      root,
      remote,
      opId,
      onProgress: channel,
    });
  },
  gitCancel: (opId: string) => invoke<void>("git_cancel", { opId }),
  gitConflictSides: (root: string, path: string) =>
    invoke<GitConflictSides>("git_conflict_sides", { root, path }),
  /** `choice` is `ours`, `theirs` or `markers`. */
  gitResolveConflict: (root: string, path: string, choice: string) =>
    invoke<void>("git_resolve_conflict", { root, path, choice }),
  /** Write an arbitrary resolution over the working tree and mark the path resolved. */
  gitWriteResolution: (root: string, path: string, content: string) =>
    invoke<SavedFile>("git_write_resolution", { root, path, content }),
  /** Resolve by removing the file (the chosen side is a deletion). */
  gitDeleteResolution: (root: string, path: string) =>
    invoke<void>("git_delete_resolution", { root, path }),
  gitMergeAbort: (root: string) => invoke<void>("git_merge_abort", { root }),
  gitAuthView: () => invoke<GitAuthView>("git_auth_view"),
  gitSaveHttps: (host: string, username: string, secret: string) =>
    invoke<void>("git_save_https", { host, username, secret }),
  gitSaveSsh: (
    host: string,
    keyPath: string,
    passphrase: string | null,
    rememberPassphrase: boolean
  ) => invoke<void>("git_save_ssh", { host, keyPath, passphrase, rememberPassphrase }),
  gitForgetCredential: (host: string) => invoke<void>("git_forget_credential", { host }),
  gitSaveIdentity: (name: string, email: string) =>
    invoke<void>("git_save_identity", { name, email }),
  gitClearIdentity: () => invoke<void>("git_clear_identity"),
  gitTrustHost: (host: string, fingerprint: string) =>
    invoke<void>("git_trust_host", { host, fingerprint }),
  gitForgetHost: (host: string) => invoke<void>("git_forget_host", { host }),
  getGroups: () => invoke<GroupStore>("get_groups"),
  saveGroups: (store: GroupStore) => invoke<GroupStore>("save_groups", { store }),
  transferTabs: (store: GroupStore, transfer: TabTransfer) =>
    invoke<GroupStore>("transfer_tabs", { store, transfer }),
  getWindowState: () => invoke<WindowState | null>("get_window_state"),
  saveWindowState: (state: WindowState) => invoke<WindowState>("save_window_state", { state }),
  planWindowPlacement: (state: WindowState, monitors: MonitorRect[]) =>
    invoke<Placement>("plan_window_placement", { state, monitors }),
  contextMenuTarget: (extensions: string[]) => invoke<MenuTarget>("context_menu_target", { extensions }),
  installContextMenu: (extensions: string[], excluded: string[]) =>
    invoke<string>("install_context_menu", { extensions, excluded }),
  uninstallContextMenu: (extensions: string[]) => invoke<void>("uninstall_context_menu", { extensions }),
};

/**
 * `openUrl` hands a URL to the OS default application. The `opener:default` capability already
 * scopes it to `http`, `https`, `mailto` and `tel`, so a document cannot name an application.
 *
 * `openPath` is the wider of the two — it hands a filesystem path to whatever the OS has
 * registered for it — so it is granted separately and used only for folders the backend named:
 * the two in `getStoreDirs`. A path from anywhere else never reaches it. The backup folder is
 * opened by the backend instead (`openBackupFolder`), because it can be a folder the user
 * picked, which a compile-time allow-list cannot cover.
 */
export { invoke, listen, open, save, revealItemInDir, openUrl, openPath };

const fileFilters = () => [{ name: t("dialog.allFiles"), extensions: ["*"] }];

export function pickFiles(): Promise<string[]> {
  return open({ multiple: true, filters: fileFilters() }).then((r) =>
    Array.isArray(r) ? r : r ? [r] : []
  );
}

/** One file, for a flow that needs a second path (currently: pick the other side of a diff). */
export function pickFile(): Promise<string | null> {
  return open({ multiple: false, filters: fileFilters() }).then((r) => (typeof r === "string" ? r : null));
}

export function pickSaveAs(defaultPath?: string): Promise<string | null> {
  return save({ filters: fileFilters(), defaultPath }).then((r) => r ?? null);
}

export function pickFolder(): Promise<string | null> {
  return open({ directory: true }).then((r) => (typeof r === "string" ? r : null));
}

/** Backend errors arrive as "code" or "code:detail"; other throws carry a message. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return translateError(e);
  if (e instanceof Error) return e.message;
  return String(e);
}

/**
 * Copy text to the clipboard.
 *
 * `navigator.clipboard` is unavailable outside a secure context, which includes a Tauri
 * window served from a custom scheme, so the `execCommand` path is kept as a real
 * fallback rather than as legacy. It has to run inside the user gesture, so callers
 * should invoke this directly from a click handler.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}

/** Path of the directory containing `path`, or "." when there is no parent. */
/** A UNC share root, e.g. `\\server\share`. There is nothing above one. */
const UNC_SHARE = /^\\\\[^\\]+\\[^\\]+$/;

/**
 * Parent directory of a path, or `""` when the path is already a root.
 *
 * The awkward cases are all Windows ones. Stripping the last segment from `C:\Users`
 * leaves `C:`, which is not the root but the drive's *current directory*, so the
 * separator has to go back on; and `C:\` itself must report no parent rather than
 * returning itself. A bare `C:` designator and a UNC share root likewise have no parent.
 */
export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (/^[A-Za-z]:$/.test(trimmed) || UNC_SHARE.test(trimmed)) return "";
  const cut = trimmed.replace(/[\\/][^\\/]*$/, "");
  // Nothing was stripped, so the path was a bare name: `foo` is its own non-parent.
  if (cut === trimmed) return "";
  if (/^[A-Za-z]:$/.test(cut)) return `${cut}\\`;
  return UNC_SHARE.test(cut) ? "" : cut;
}
