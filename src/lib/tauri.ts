import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
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

export interface HistoryEntry {
  path: string;
  name: string;
  openedAt: string;
}

/**
 * A folder the Explorer has been pointed at. `exists` is settled by the backend on every read
 * rather than remembered when the folder was recorded, so a drive that was unplugged while the
 * app was closed greys its row instead of offering somewhere that is not there.
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

export interface Settings {
  fontSize: number;
  minimap: boolean;
  sidebarVisible: boolean;
  sidebarView: string;
  sidebarWidth: number;
  /** Language code; unknown values are stored as-is and fall back to English in the UI. */
  language: string;
  /** Reopen the tabs of the active group on startup. */
  restoreSession: boolean;
  /** Folder the Explorer shows. Global view state, not part of a group. */
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
  /** Allow scrolling past the end so the last line can sit above the bottom edge. */
  scrollBeyondLastLine: boolean;
  /**
   * How a file that has a preview opens: `auto` | `text` | `split` | `preview`.
   * `text` is the default; `auto` is the per-kind behaviour (markdown and SVG side by side).
   * A picture is not covered by this — its bytes are not text, so it always opens as itself.
   */
  previewLayout: string;
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
   * Delete a file, or a folder and everything in it, and stop the store pointing at it.
   *
   * Nothing is moved, so there is nothing to undo and nothing reaches the Recycle Bin: the
   * caller is expected to have asked the user first. Unsaved work is not thrown away with
   * the entry — the drafts stay, and are offered again if the same path ever comes back.
   */
  removeEntry: (path: string) => invoke<void>("remove_entry", { path }),
  getDraft: (path: string) => invoke<Draft | null>("get_draft", { path }),
  saveDraft: (path: string, content: string, cursor: number) =>
    invoke<Draft>("save_draft", { path, content, cursor }),
  clearDraft: (path: string) => invoke<boolean>("clear_draft", { path }),
  listDir: (path: string) => invoke<FsEntry[]>("list_dir", { path }),
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
  getFolderHistory: () => invoke<FolderHistoryEntry[]>("get_folder_history"),
  recordFolderHistory: (dir: string) => invoke<void>("record_folder_history", { dir }),
  removeFolderHistory: (path: string) =>
    invoke<FolderHistoryEntry[]>("remove_folder_history", { path }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
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

export { invoke, listen, open, save, revealItemInDir };

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
