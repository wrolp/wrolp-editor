import { isUntitled } from "./path";
import type { Group, GroupStore, GroupTab } from "./tauri";

/** Tabs are identified by their path; untitled tabs already carry `untitled://<name>`. */
export function tabKey(path: string): string {
  return path;
}


export function newGroupId(): string {
  return `grp-${crypto.randomUUID()}`;
}

/** Everything the store needs to know about what is on screen right now. */
export interface LiveSnapshot {
  tabs: GroupTab[];
  /** Key of the selected tab, empty when none. */
  active: string;
}

/**
 * Write the live tab set into the group it belongs to, leaving the other groups untouched.
 * Returns the same object when nothing changed, so callers can skip a save.
 */
export function applySnapshot(store: GroupStore, snapshot: LiveSnapshot): GroupStore {
  if (!store.active) {
    // No group on screen: the window is showing loose tabs, nothing to remember.
    return store;
  }
  let changed = false;
  const items = store.items.map((item) => {
    if (item.id !== store.active) return item;
    const next: Group = { ...item, tabs: snapshot.tabs, active: snapshot.active };
    if (next.active !== item.active || JSON.stringify(next.tabs) !== JSON.stringify(item.tabs)) {
      changed = true;
    }
    return next;
  });
  return changed ? { ...store, items } : store;
}

/** Case-insensitive label comparison: two identically named groups cannot be told apart. */
export function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Turn a live tab into its stored form. File tabs never carry content: drafts own that. */
export function toStoredTab(input: {
  path: string;
  name: string;
  cursor: number;
  value: string;
}): GroupTab {
  if (isUntitled(input.path)) {
    return { path: "", cursor: 0, untitled: input.name, content: input.value };
  }
  return { path: input.path, cursor: input.cursor, untitled: "", content: "" };
}
