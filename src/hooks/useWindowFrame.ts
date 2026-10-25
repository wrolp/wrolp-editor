import { useCallback, useEffect, useRef } from "react";
import { availableMonitors, getCurrentWindow, type Window } from "@tauri-apps/api/window";
import { t } from "../lib/i18n";
import { api, errorMessage, type MonitorRect, type WindowState } from "../lib/tauri";

const DEBOUNCE_MS = 600;

interface Options {
  onError: (message: string) => void;
  onNotice: (message: string) => void;
}

/** The window's current rectangle, in physical pixels. */
async function readGeometry(w: Window): Promise<WindowState> {
  const [position, size] = await Promise.all([w.outerPosition(), w.outerSize()]);
  return {
    x: position.x,
    y: position.y,
    width: size.width,
    height: size.height,
    maximized: false,
  };
}

export interface WindowFrame {
  /** Load the saved rectangle and maximized state. Must finish before anything measures the window. */
  restore(): Promise<void>;
  /** Write what is pending, plus the geometry as it is right now. */
  flush(): Promise<void>;
}

/**
 * Keeps the window where the user left it: size, position, and whether it was maximized.
 *
 * Only the un-maximized rectangle is ever stored as a rectangle. While maximized Windows
 * reports the maximized frame, so storing what we see would replace the user's restore
 * size with full-screen numbers that come back wrong the next time.
 */
export function useWindowFrame({ onError, onNotice }: Options): WindowFrame {
  const win = useRef(getCurrentWindow());
  const normal = useRef<WindowState | null>(null);
  const maximized = useRef(false);
  const ready = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const writing = useRef<Promise<void>>(Promise.resolve());

  const persist = useCallback(
    () => {
      const current = normal.current;
      if (!current) return writing.current;
      const state: WindowState = { ...current, maximized: maximized.current };
      writing.current = writing.current
        .catch(() => undefined)
        .then(() =>
          api
            .saveWindowState(state)
            .then(() => undefined)
            .catch((e) => onError(errorMessage(e)))
        );
      return writing.current;
    },
    [onError]
  );

  const capture = useCallback(async () => {
    if (!ready.current) return;
    const w = win.current;
    try {
      maximized.current = await w.isMaximized();
      if (!maximized.current) {
        const position = await w.outerPosition();
        const size = await w.outerSize();
        normal.current = {
          x: position.x,
          y: position.y,
          width: size.width,
          height: size.height,
          maximized: false,
        };
      }
      await persist();
    } catch (e) {
      onError(errorMessage(e));
    }
  }, [onError, persist]);

  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void capture(), DEBOUNCE_MS);
  }, [capture]);

  /**
   * The backend placed the window in `setup`, before it was first shown, so there is no
   * geometry left to apply here. What remains is the bookkeeping: remember the rectangle to
   * fall back to when the window is maximized, since the window only reports the maximized
   * frame in that state.
   */
  const restore = useCallback(async () => {
    const w = win.current;
    try {
      const saved = await api.getWindowState();
      const maximizedNow = await w.isMaximized();
      maximized.current = maximizedNow;
      if (!saved) {
        // First run: the configured size and `center` are the right answer.
        normal.current = await readGeometry(w);
        ready.current = true;
        return;
      }

      const monitors: MonitorRect[] = (await availableMonitors()).map((m) => ({
        x: m.position.x,
        y: m.position.y,
        width: m.size.width,
        height: m.size.height,
      }));
      const plan = await api.planWindowPlacement(saved, monitors);
      normal.current = maximizedNow
        ? {
            x: plan.x,
            y: plan.y,
            width: plan.width,
            height: plan.height,
            maximized: false,
          }
        : await readGeometry(w);
      ready.current = true;
      // A window that teleports between monitors without explanation reads as a bug.
      if (plan.adjusted) onNotice(t("win.relocated"));
    } catch (e) {
      ready.current = true;
      onError(errorMessage(e));
    }
  }, [onError, onNotice]);

  useEffect(() => {
    const w = win.current;
    const unlisten: Array<() => void> = [];
    w.onResized(() => schedule()).then((f) => unlisten.push(f));
    w.onMoved(() => schedule()).then((f) => unlisten.push(f));
    return () => {
      window.clearTimeout(timer.current);
      unlisten.forEach((f) => f());
    };
  }, [schedule]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    await capture();
    await writing.current;
  }, [capture]);

  return { restore, flush };
}
