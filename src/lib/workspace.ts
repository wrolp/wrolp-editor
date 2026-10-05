import { isUntitled } from "./path";
import type { Workspace, WorkspaceStore, WorkspaceTab } from "./tauri";

/** Tabs are identified by their path; untitled tabs already carry `untitled://<name>`. */
export function tabKey(path: string): string {
  return path;
}

export function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("\\"), trimmed.lastIndexOf("/"));
  return idx < 0 ? trimmed : trimmed.slice(idx + 1);
}

/** Name a brand new group after the folder its first file came from. Only a label. */
export function groupNameFor(dir: string, fallback: string): string {
  return basenameOf(dir) || fallback;
}

export function newWorkspaceId(): string {
  return `ws-${crypto.randomUUID()}`;
}

/** Everything the store needs to know about what is on screen right now. */
export interface LiveSnapshot {
  tabs: WorkspaceTab[];
  /** Key of the selected tab, empty when none. */
  active: string;
}

export function emptyStore(): WorkspaceStore {
  return { version: 1, active: "", items: [] };
}

/**
 * Write the live tab set into the group it belongs to, leaving the other groups untouched.
 * Returns the same object when nothing changed, so callers can skip a save.
 */
export function applySnapshot(store: WorkspaceStore, snapshot: LiveSnapshot): WorkspaceStore {
  if (!store.active) {
    // No group on screen: the window is showing loose tabs, nothing to remember.
    return store;
  }
  let changed = false;
  const items = store.items.map((item) => {
    if (item.id !== store.active) return item;
    const next: Workspace = { ...item, tabs: snapshot.tabs, active: snapshot.active };
    if (
      next.active !== item.active ||
      JSON.stringify(next.tabs) !== JSON.stringify(item.tabs)
    ) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...store, items } : store;
}

/** Case-insensitive label comparison, because two identically named groups cannot be told apart in the switcher. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
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
