import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { t, translateError } from "./i18n";

export interface OpenedFile {
  path: string;
  content: string;
  mtime: number;
}

export interface SavedFile {
  path: string;
  mtime: number;
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

export const api = {
  takeStartupFiles: () => invoke<string[]>("take_startup_files"),
  /** `record: false` keeps a session restore from rewriting the recent-files history. */
  openFile: (path: string, record = true) => invoke<OpenedFile>("open_file", { path, record }),
  saveFile: (path: string, content: string) => invoke<SavedFile>("save_file", { path, content }),
  getDraft: (path: string) => invoke<Draft | null>("get_draft", { path }),
  saveDraft: (path: string, content: string, cursor: number) =>
    invoke<Draft>("save_draft", { path, content, cursor }),
  clearDraft: (path: string) => invoke<boolean>("clear_draft", { path }),
  listDir: (path: string) => invoke<FsEntry[]>("list_dir", { path }),
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
