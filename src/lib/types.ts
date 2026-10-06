import type { Monaco } from "@monaco-editor/loader";
import type { editor } from "monaco-editor";
import type { Draft, FileSettings } from "./tauri";

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
  /**
   * A picture rather than a document. Its buffer is never decoded, so `original` is empty
   * and any edit would be nonsense: the file is only ever drawn, never saved from the tab.
   */
  isBinary?: boolean;
  /**
   * A read-only side-by-side diff of two files. The text is a snapshot taken when the
   * comparison was started: the pair has no model of its own, so it is never dirty and
   * never carries a draft.
   */
  compare?: ComparePair;
  /**
   * Encoding the file on disk turned out to be, and whether it carried a BOM. A save
   * must write the same encoding back or a legacy file comes out mangled.
   */
  encoding: string;
  bom: boolean;
  /** Size on disk in bytes; null when there is no file yet (untitled, settings). */
  bytes: number | null;
  /** This file's overrides of the global editor view settings; null means "inherit". */
  fileSettings: FileSettings;
}

/** One side of a comparison: the file it is, plus the text to show for it. */
export interface CompareSide {
  path: string;
  name: string;
  content: string;
  language: string;
}

export interface ComparePair {
  left: CompareSide;
  right: CompareSide;
}

/**
 * A tab backed by a real file the user can edit. Settings and comparison tabs are not:
 * they have no editable model, so everything that saves, drafts or counts edits must
 * skip them. Getting this wrong is silent — a comparison would try to save itself.
 */
export function isFileTab(tab: Tab): boolean {
  return !tab.isSettings && !tab.compare;
}

/** Added and removed line counts of a comparison, as Monaco reports them. */
export interface DiffStats {
  added: number;
  removed: number;
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

/**
 * Live counters shown in the status bar. Reported as one snapshot so the selection
 * figures and the document total can never disagree for a frame.
 */
export interface EditStats {
  /** Selected characters across all cursors; 0 when nothing is selected. */
  selectionChars: number;
  /** Line span of the selection; 1 for a single-line selection, 0 when empty. */
  selectionLines: number;
  /** Whole-document length, newlines included. */
  totalChars: number;
}
