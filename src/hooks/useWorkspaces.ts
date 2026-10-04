import { useCallback, useRef, useState } from "react";
import { api, errorMessage, type Workspace, type WorkspaceStore } from "../lib/tauri";
import {
  applySnapshot,
  basenameOf,
  emptyStore,
  newWorkspaceId,
  rootKey,
  type LiveSnapshot,
} from "../lib/workspace";

const DEBOUNCE_MS = 400;

interface Options {
  onError: (message: string) => void;
}

export interface WorkspaceCommitter {
  store: WorkspaceStore;
  loaded: boolean;
  load(): Promise<WorkspaceStore>;
  /** Mirror what is on screen into the active workspace. */
  commit(snapshot: LiveSnapshot, immediate?: boolean): void;
  /** Write whatever is pending right now. */
  flush(): Promise<void>;
  active(): Workspace | null;
  /** The store exactly as it will be written, bypassing React's render lag. */
  snapshotStore(): WorkspaceStore;
  /** Adopt a store produced elsewhere (a transfer) and persist it at once. */
  replace(next: WorkspaceStore): void;
  /** Returns the workspace for this folder, creating it only if it is genuinely new. */
  openOrCreate(root: string, sidebarView: string): { workspace: Workspace; created: boolean };
  select(id: string): void;
  rename(id: string, name: string): void;
  /** Forget the tabs and root but keep the entry in the list. */
  clearContents(id: string): void;
  /** Drop the record. Drafts and files on disk are deliberately left alone. */
  remove(id: string): void;
}

/**
 * Owns the workspace store: the single source of truth for "which folder and which tabs".
 * Live tab state flows in through commit(); structural operations mutate the store directly.
 */
export function useWorkspaces({ onError }: Options): WorkspaceCommitter {
  const [store, setStore] = useState<WorkspaceStore>(emptyStore);
  const storeRef = useRef(store);
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  // Serialize writes: two overlapping save_workspaces calls would race on one file.
  const writing = useRef<Promise<void>>(Promise.resolve());

  const write = useCallback(
    (next: WorkspaceStore) => {
      storeRef.current = next;
      setStore(next);
      writing.current = writing.current
        .catch(() => undefined)
        .then(() =>
          api
            .saveWorkspaces(next)
            // The backend cleans and re-times the store, so its answer is the new truth.
            .then((saved) => {
              storeRef.current = saved;
              setStore(saved);
            })
            .catch((e) => onError(errorMessage(e)))
        );
    },
    [onError]
  );

  const schedule = useCallback(
    (next: WorkspaceStore, immediate?: boolean) => {
      if (immediate) {
        window.clearTimeout(timer.current);
        write(next);
        return;
      }
      storeRef.current = next;
      setStore(next);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => write(storeRef.current), DEBOUNCE_MS);
    },
    [write]
  );

  const load = useCallback(async () => {
    const s = await api.getWorkspaces();
    storeRef.current = s;
    setStore(s);
    setLoaded(true);
    return s;
  }, []);

  const commit = useCallback(
    (snapshot: LiveSnapshot, immediate?: boolean) => {
      const next = applySnapshot(storeRef.current, snapshot);
      if (next === storeRef.current) return;
      schedule(next, immediate);
    },
    [schedule]
  );

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const pending = storeRef.current;
    await write(pending);
    await writing.current;
  }, [write]);

  const active = useCallback(() => {
    const s = storeRef.current;
    return s.items.find((item) => item.id === s.active) ?? null;
  }, []);

  const snapshotStore = useCallback(() => storeRef.current, []);

  const replace = useCallback((next: WorkspaceStore) => schedule(next, true), [schedule]);

  const openOrCreate = useCallback(
    (root: string, sidebarView: string) => {
      const s = storeRef.current;
      const existing = s.items.find((item) => rootKey(item.root) === rootKey(root));
      if (existing) {
        schedule({ ...s, active: existing.id });
        return { workspace: existing, created: false };
      }
      const workspace: Workspace = {
        id: newWorkspaceId(),
        name: basenameOf(root),
        autoName: true,
        root,
        tabs: [],
        active: "",
        sidebarView,
        updatedAt: "",
      };
      schedule({ ...s, active: workspace.id, items: [...s.items, workspace] });
      return { workspace, created: true };
    },
    [schedule]
  );

  const select = useCallback(
    (id: string) => {
      const s = storeRef.current;
      if (!s.items.some((item) => item.id === id) || s.active === id) return;
      schedule({ ...s, active: id }, true);
    },
    [schedule]
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const s = storeRef.current;
      schedule({
        ...s,
        items: s.items.map((item) =>
          item.id === id ? { ...item, name: trimmed, autoName: false } : item
        ),
      });
    },
    [schedule]
  );

  const clearContents = useCallback(
    (id: string) => {
      const s = storeRef.current;
      schedule({
        ...s,
        items: s.items.map((item) =>
          item.id === id ? { ...item, root: "", tabs: [], active: "" } : item
        ),
      });
    },
    [schedule]
  );

  const remove = useCallback(
    (id: string) => {
      const s = storeRef.current;
      const items = s.items.filter((item) => item.id !== id);
      const active = s.active === id ? items[0]?.id ?? "" : s.active;
      schedule({ ...s, items, active }, true);
    },
    [schedule]
  );

  return {
    store,
    loaded,
    load,
    commit,
    flush,
    active,
    snapshotStore,
    replace,
    openOrCreate,
    select,
    rename,
    clearContents,
    remove,
  };
}

export type { LiveSnapshot };
