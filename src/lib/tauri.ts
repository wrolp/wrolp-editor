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
}

export interface SavedFile {
  path: string;
  mtime: number;
  /** Encoding actually written, after resolving aliases. */
  encoding: string;
  /** Bytes actually written; differs from the text length for legacy encodings. */
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
  /** Tighten the app chrome. Does not touch the editor's font size or line height. */
  compactMode: boolean;
  /** `auto` sniffs every file; the rest force one encoding. */
  encoding: string;
  /** none | boundary | selection | all | trailing. */
  renderWhitespace: string;
  wordWrap: boolean;
  stickyScroll: boolean;
  /** Columns per indentation level, 1..8. */
  tabSize: number;
  /** Insert spaces rather than a tab character. */
  insertSpaces: boolean;
  /** Let a file's own content decide the indentation instead of the two settings above. */
  detectIndentation: boolean;
  /** Allow scrolling past the end so the last line can sit above the bottom edge. */
  scrollBeyondLastLine: boolean;
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

/** Re-homing a tab: `tab` is a tab key, or null for every tab of the source group. */
export type TabTransfer =
  | { action: "move"; from: string; to: string; tab: string | null }
  | { action: "copy"; from: string; to: string; tab: string | null };

export interface MenuTarget {
  installed: boolean;
  registered: string | null;
  expected: string;
  matchesCurrent: boolean;
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
  saveFile: (path: string, content: string, encoding?: string, bom?: boolean) =>
    invoke<SavedFile>("save_file", { path, content, encoding: encoding ?? null, bom: bom ?? null }),
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
  getHistory: () => invoke<HistoryEntry[]>("get_history"),
  removeHistory: (path: string) => invoke<HistoryEntry[]>("remove_history", { path }),
  getSettings: () => invoke<Settings>("get_settings"),
  saveSettings: (settings: Settings) => invoke<Settings>("save_settings", { settings }),
  getGroups: () => invoke<GroupStore>("get_groups"),
  saveGroups: (store: GroupStore) => invoke<GroupStore>("save_groups", { store }),
  transferTabs: (store: GroupStore, transfer: TabTransfer) =>
    invoke<GroupStore>("transfer_tabs", { store, transfer }),
  contextMenuTarget: () => invoke<MenuTarget>("context_menu_target"),
  installContextMenu: () => invoke<string>("install_context_menu"),
  uninstallContextMenu: () => invoke<void>("uninstall_context_menu"),
};

export { invoke, listen, open, save, revealItemInDir };

const fileFilters = () => [{ name: t("dialog.allFiles"), extensions: ["*"] }];

export function pickFiles(): Promise<string[]> {
  return open({ multiple: true, filters: fileFilters() }).then((r) =>
    Array.isArray(r) ? r : r ? [r] : []
  );
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
export function parentOf(path: string): string {
  const cut = path.replace(/[\\/][^\\/]*$/, "");
  return cut || ".";
}
