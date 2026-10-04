import type { Monaco } from "@monaco-editor/loader";
import type { editor } from "monaco-editor";
import type { Draft } from "./tauri";

export interface Tab {
  id: number;
  /** Normalized absolute path from the backend, or untitled://xxx for new files. */
  path: string;
  name: string;
  language: string;
  /** Baseline content on disk, used to decide whether the tab is dirty. */
  original: string;
  dirty: boolean;
  /**
   * Text to seed the Monaco model with when it is first created. Only restored scratch
   * tabs use it: their content has no draft file to come back from.
   */
  initialValue?: string;
  isSettings?: boolean;
}

export interface EditorHandle {
  editor: editor.IStandaloneCodeEditor;
  monaco: Monaco;
}

/** Monaco cursor position (structural, so it does not depend on internal type names). */
export interface CursorPos {
  lineNumber: number;
  column: number;
}

export interface PendingRestore {
  tabId: number;
  path: string;
  name: string;
  draft: Draft;
}

/** Comparison key for paths: Windows is case-insensitive, separators unified. */
export function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}
