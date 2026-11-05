import { useCallback, useEffect, useMemo, useRef } from "react";
import { api, errorMessage } from "../lib/tauri";
import { isUntitled } from "../lib/path";

const DEBOUNCE_MS = 500;

interface PendingEntry {
  content: string;
  cursor: number;
  original: string;
}

export interface DraftWriter {
  /** On each edit: persist after a 500ms debounce, or clear the draft once content matches disk. */
  schedule(path: string, entry: PendingEntry): void;
  /** Write any pending draft for this path right now (tab switch, close, save). */
  flush(path: string): Promise<void>;
  flushAll(): Promise<void>;
  /** Drop pending content (saved successfully, draft already cleared). */
  forget(path: string): void;
}

export function useDraft(onError: (message: string) => void): DraftWriter {
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const pending = useRef(new Map<string, PendingEntry>());
  /**
   * The write in flight for each path, and the generation of the write that last queued it.
   * Writes for one path are chained rather than run side by side: two overlapping save_draft
   * calls could land in either order, and the older text would be the one kept on disk.
   */
  const writing = useRef(new Map<string, Promise<void>>());
  const writeGen = useRef(new Map<string, number>());

  const write = useCallback(
    (path: string): Promise<void> => {
      const timer = timers.current.get(path);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(path);
      }
      const entry = pending.current.get(path);
      // Nothing new to write: still wait for the write already on its way, so a caller that
      // flushes before reading the file sees the result of both.
      if (!entry) return writing.current.get(path) ?? Promise.resolve();
      pending.current.delete(path);

      const generation = (writeGen.current.get(path) ?? 0) + 1;
      writeGen.current.set(path, generation);
      const previous = writing.current.get(path) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          try {
            if (isUntitled(path) || entry.content === entry.original) {
              await api.clearDraft(path);
            } else {
              await api.saveDraft(path, entry.content, entry.cursor);
            }
          } catch (e) {
            onError(errorMessage(e));
          } finally {
            // Only the last write queued for this path may clear the entry: a newer one has
            // already replaced it, and dropping that promise would let a flush miss it.
            if (writeGen.current.get(path) === generation) {
              writeGen.current.delete(path);
              writing.current.delete(path);
            }
          }
        });
      writing.current.set(path, next);
      return next;
    },
    [onError]
  );

  const schedule = useCallback(
    (path: string, entry: PendingEntry) => {
      pending.current.set(path, entry);
      const timer = timers.current.get(path);
      if (timer) clearTimeout(timer);
      timers.current.set(path, setTimeout(() => void write(path), DEBOUNCE_MS));
    },
    [write]
  );

  const flush = useCallback((path: string) => write(path), [write]);

  const flushAll = useCallback(async () => {
    // Pending and in-flight both have to be waited for: a path whose debounce already fired
    // has no pending entry left, but its write is exactly the one a quit or a switch must not
    // cut through.
    const paths = new Set<string>([...pending.current.keys(), ...writing.current.keys()]);
    await Promise.all([...paths].map((path) => write(path)));
  }, [write]);

  const forget = useCallback((path: string) => {
    const timer = timers.current.get(path);
    if (timer) clearTimeout(timer);
    timers.current.delete(path);
    pending.current.delete(path);
  }, []);

  useEffect(
    () => () => {
      timers.current.forEach((t) => clearTimeout(t));
      timers.current.clear();
      pending.current.clear();
    },
    []
  );

  return useMemo(
    () => ({ schedule, flush, flushAll, forget }),
    [schedule, flush, flushAll, forget]
  );
}
