import { useEffect, useRef } from "react";
import { check } from "@tauri-apps/plugin-updater";

/** Wait this long after startup before the first check, so it never competes with opening. */
const FIRST_CHECK_MS = 15_000;
/** How often to look again while the window stays open. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Ask the release endpoint whether a newer version exists, without being asked.
 *
 * Only the check is automatic: the handle is closed as soon as its version has been read, and
 * installing stays in Settings → About, where a fresh check produces a handle the page can use.
 * A failed check is silent — offline, no release yet and a malformed manifest are all things a
 * background check should not turn into a message over the document being read.
 *
 * `onFound` is called once per version per session: the same answer every six hours must not
 * repeat the notice.
 */
export function useUpdateCheck(enabled: boolean, onFound: (version: string) => void) {
  const latest = useRef(onFound);
  latest.current = onFound;

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: number | undefined;
    /** The version already announced in this session. */
    let announced: string | null = null;

    const run = async () => {
      try {
        const found = await check();
        if (cancelled) {
          if (found) void found.close();
          return;
        }
        if (found) {
          const version = found.version;
          // This view does not install; the About page runs its own check when the user acts.
          void found.close();
          if (version !== announced) {
            announced = version;
            latest.current(version);
          }
        }
      } catch {
        // Silent on purpose: a background check has no user waiting on an answer.
      }
      if (!cancelled) timer = window.setTimeout(run, INTERVAL_MS);
    };

    timer = window.setTimeout(run, FIRST_CHECK_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [enabled]);
}
