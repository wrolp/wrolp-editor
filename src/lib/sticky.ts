import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { t } from "./i18n";
import type { NoteMeta } from "./tauri";

/** What one card needs to start editing without asking the main window again. */
export interface StickyPayload {
  path: string;
  title: string;
  pinned: boolean;
  tags: string[];
  due: string | null;
}

/**
 * Open a note board in its own OS window.
 *
 * The window loads the same page as the editor, so the board picks its data up from
 * localStorage, keyed by the window's own label: a query string would have to survive both
 * the dev URL and the packaged asset URL, while a label is already there and unique.
 */
export function openStickyBoard(notes: NoteMeta[], onError: (message: string) => void): void {
  if (notes.length === 0) return;
  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const key = `wrolp.sticky.${id}`;
  const payload: StickyPayload[] = notes.map((note) => ({
    path: note.path,
    title: note.title,
    pinned: note.pinned,
    tags: note.tags,
    due: note.due,
  }));
  localStorage.setItem(key, JSON.stringify(payload));
  const columns = notes.length <= 1 ? 1 : notes.length <= 2 ? 2 : 3;
  const width = columns === 1 ? 380 : columns === 2 ? 680 : 960;
  const height = columns === 1 ? 460 : 600;
  try {
    const board = new WebviewWindow(`sticky-${id}`, {
      url: "/",
      title: t("sticky.windowTitle"),
      width,
      height,
      center: true,
      focus: true,
      decorations: false,
      transparent: true,
      visible: false,
      shadow: false,
      alwaysOnTop: true,
    });
    board.once("tauri://error", (event) => {
      localStorage.removeItem(key);
      onError(String(event.payload ?? "window_create"));
    });
  } catch (error) {
    localStorage.removeItem(key);
    onError(String(error));
  }
}