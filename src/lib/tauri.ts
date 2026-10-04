import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

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
}

export interface MenuTarget {
  installed: boolean;
  registered: string | null;
  expected: string;
  matchesCurrent: boolean;
  debugBuild: boolean;
}

export const api = {
  takeStartupFiles: () => invoke<string[]>("take_startup_files"),
  openFile: (path: string) => invoke<OpenedFile>("open_file", { path }),
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
  contextMenuTarget: () => invoke<MenuTarget>("context_menu_target"),
  installContextMenu: () => invoke<string>("install_context_menu"),
  uninstallContextMenu: () => invoke<void>("uninstall_context_menu"),
};

export { invoke, listen, open, save, revealItemInDir };

const FILE_FILTERS = [{ name: "All files", extensions: ["*"] }];

export function pickFiles(): Promise<string[]> {
  return open({ multiple: true, filters: FILE_FILTERS }).then((r) =>
    Array.isArray(r) ? r : r ? [r] : []
  );
}

export function pickSaveAs(defaultPath?: string): Promise<string | null> {
  return save({ filters: FILE_FILTERS, defaultPath }).then((r) => r ?? null);
}

export function pickFolder(): Promise<string | null> {
  return open({ directory: true }).then((r) => (typeof r === "string" ? r : null));
}

/** Backend errors arrive as strings; other throws carry a message. Flatten to display text. */
export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
