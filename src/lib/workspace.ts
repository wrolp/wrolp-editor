import { isUntitled } from "./path";
import type { Workspace, WorkspaceStore, WorkspaceTab } from "./tauri";
import { EMPTY_WORKSPACE_STORE } from "./tauri";

/** Tabs are identified by their path; untitled tabs already carry `untitled://<name>`. */
export function tabKey(path: string): string {
  return path;
}

/** Compare roots the way the backend normalizes them: unified separators, trailing slash off, case-insensitive. */
export function rootKey(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

export function newWorkspaceId(): string {
  return `ws-${crypto.randomUUID()}`;
}

/** Everything the store needs to know about what is on screen right now. */
export interface LiveSnapshot {
  tabs: WorkspaceTab[];
  /** Key of the selected tab, empty when none. */
  active: string;
  /** Omitted when the switch is only about tabs and should leave the folder as stored. */
  root?: string;
  sidebarView?: string;
}

export function emptyStore(): WorkspaceStore {
  return { ...EMPTY_WORKSPACE_STORE, items: [] };
}

/**
 * Write the live screen into the workspace it belongs to, leaving the other workspaces
 * untouched. Returns the same object when nothing changed, so callers can skip a save.
 */
export function applySnapshot(store: WorkspaceStore, snapshot: LiveSnapshot): WorkspaceStore {
  if (!store.active) {
    // No context on screen: the window is showing a bare tab set, nothing to remember.
    return store;
  }
  let changed = false;
  const items = store.items.map((item) => {
    if (item.id !== store.active) return item;
    const root = snapshot.root ?? item.root;
    const next: Workspace = {
      ...item,
      root,
      name: item.autoName ? basenameOf(root) || item.name : item.name,
      tabs: snapshot.tabs,
      active: snapshot.active,
      sidebarView: snapshot.sidebarView ?? item.sidebarView,
    };
    if (
      next.root !== item.root ||
      next.active !== item.active ||
      next.sidebarView !== item.sidebarView ||
      JSON.stringify(next.tabs) !== JSON.stringify(item.tabs)
    ) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...store, items } : store;
}

/** Turn a live tab into its stored form. File tabs never carry content: drafts own that. */
export function toStoredTab(input: {
  path: string;
  name: string;
  cursor: number;
  value: string;
}): WorkspaceTab {
  if (isUntitled(input.path)) {
    return { path: "", cursor: 0, untitled: input.name, content: input.value };
  }
  return { path: input.path, cursor: input.cursor, untitled: "", content: "" };
}
