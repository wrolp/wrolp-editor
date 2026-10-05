import { useCallback, useRef, useState } from "react";
import { api, errorMessage, type Group, type GroupStore } from "../lib/tauri";
import { applySnapshot, newGroupId, sameName, type LiveSnapshot } from "../lib/group";

const DEBOUNCE_MS = 400;

export type NameProblem = "ok" | "empty" | "duplicate";

interface Options {
  onError: (message: string) => void;
}

export interface GroupStoreCommitter {
  store: GroupStore;
  load(): Promise<GroupStore>;
  /** Mirror the live tab set into the group on screen. */
  commit(snapshot: LiveSnapshot, immediate?: boolean): void;
  /** Write whatever is pending right now. */
  flush(): Promise<void>;
  active(): Group | null;
  snapshotStore(): GroupStore;
  /** Adopt a store produced elsewhere (a transfer) and persist it at once. */
  replace(next: GroupStore): void;
  create(name: string): { group: Group | null; problem: NameProblem };
  select(id: string): void;
  rename(id: string, name: string): NameProblem;
  isNameTaken(name: string, exceptId?: string): boolean;
  /** Forget the tabs; the group stays in the list. */
  clearContents(id: string): void;
  /** Drop the record. Drafts and files on disk are deliberately left alone. */
  remove(id: string): void;
}

/**
 * Owns the group store: a group is a name plus the tabs opened under it. The sidebar folder
 * is not part of it — that is global view state in settings.
 */
export function useGroups({ onError }: Options): GroupStoreCommitter {
  const [store, setStore] = useState<GroupStore>({ version: 1, active: "", items: [] });
  const storeRef = useRef(store);
  const timer = useRef<number | undefined>(undefined);
  // Serialize writes: two overlapping save_groups calls would race on one file.
  const writing = useRef<Promise<void>>(Promise.resolve());

  const write = useCallback(
    (next: GroupStore) => {
      storeRef.current = next;
      setStore(next);
      writing.current = writing.current
        .catch(() => undefined)
        .then(() =>
          api
            .saveGroups(next)
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
    (next: GroupStore, immediate?: boolean) => {
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
    const s = await api.getGroups();
    storeRef.current = s;
    setStore(s);
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
    await write(storeRef.current);
    await writing.current;
  }, [write]);

  const active = useCallback(() => {
    const s = storeRef.current;
    return s.items.find((item) => item.id === s.active) ?? null;
  }, []);

  const snapshotStore = useCallback(() => storeRef.current, []);

  const replace = useCallback((next: GroupStore) => schedule(next, true), [schedule]);

  const isNameTaken = useCallback((name: string, exceptId?: string) => {
    return storeRef.current.items.some((item) => item.id !== exceptId && sameName(item.name, name));
  }, []);

  const create = useCallback(
    (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return { group: null, problem: "empty" as NameProblem };
      if (isNameTaken(trimmed)) return { group: null, problem: "duplicate" as NameProblem };
      const s = storeRef.current;
      const group: Group = {
        id: newGroupId(),
        name: trimmed,
        tabs: [],
        active: "",
        updatedAt: "",
      };
      schedule({ ...s, active: group.id, items: [...s.items, group] });
      return { group, problem: "ok" as NameProblem };
    },
    [isNameTaken, schedule]
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
      if (!trimmed) return "empty" as const;
      if (isNameTaken(trimmed, id)) return "duplicate" as const;
      const s = storeRef.current;
      schedule({
        ...s,
        items: s.items.map((item) => (item.id === id ? { ...item, name: trimmed } : item)),
      });
      return "ok" as const;
    },
    [isNameTaken, schedule]
  );

  const clearContents = useCallback(
    (id: string) => {
      const s = storeRef.current;
      schedule({
        ...s,
        items: s.items.map((item) =>
          item.id === id ? { ...item, tabs: [], active: "" } : item
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
    load,
    commit,
    flush,
    active,
    snapshotStore,
    replace,
    create,
    select,
    rename,
    isNameTaken,
    clearContents,
    remove,
  };
}

export type { LiveSnapshot };
