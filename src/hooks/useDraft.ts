import { useCallback, useEffect, useRef } from "react";
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
  const writing = useRef(new Map<string, Promise<void>>());

  const write = useCallback(
    (path: string): Promise<void> => {
      const timer = timers.current.get(path);
      if (timer) {
        clearTimeout(timer);
        timers.current.delete(path);
      }
      const entry = pending.current.get(path);
      if (!entry) return writing.current.get(path) ?? Promise.resolve();
      pending.current.delete(path);

      const inFlight = (async () => {
        try {
          if (isUntitled(path) || entry.content === entry.original) {
            await api.clearDraft(path);
          } else {
            await api.saveDraft(path, entry.content, entry.cursor);
          }
        } catch (e) {
          onError(errorMessage(e));
        } finally {
          writing.current.delete(path);
        }
      })();
      writing.current.set(path, inFlight);
      return inFlight;
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
    await Promise.all([...pending.current.keys()].map((path) => write(path)));
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

  return { schedule, flush, flushAll, forget };
}
