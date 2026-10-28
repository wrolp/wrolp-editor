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
  /**
   * Modification time that `original` was read at, epoch milliseconds; undefined for a buffer
   * that never came off disk. It belongs to the baseline, so anything that moves `original`
   * moves this with it — a stat that disagrees means another program wrote the file.
   */
  mtime?: number;
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
   * A read-only side-by-side diff. The text is a snapshot taken when the comparison was
   * started: the pair has no model of its own, so it is never dirty and never carries a draft.
   */
  compare?: ComparePair;
  /**
   * A whole-folder picture view rather than a file. `path` is `gallery://<folder>` and the
   * tab has no buffer, no draft and no save: everything that looks for a file has to skip it,
   * which is what `isFileTab` does.
   */
  gallery?: {
    dir: string;
    /** The picture the gallery was opened from, so "browse this folder" lands on it. */
    startPath?: string;
  };
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
  /**
   * The file on disk is an encrypted container. `bytes` and `mtime` then describe the
   * ciphertext, which is what a save has to beat when it checks that nobody else wrote it.
   */
  encrypted?: boolean;
  /**
   * Encrypted with no key this session can reach, so a read of it comes back empty and a
   * write is refused until a password is accepted. Text already on screen stays: locking
   * stops what happens next, it does not take back what was legitimately decrypted.
   */
  locked?: boolean;
}

/**
 * A locked tab the text never reached: opened encrypted, no password accepted yet, so its
 * buffer is empty because nothing was decrypted into it. This is the state that gets an
 * overlay.
 *
 * The empty baseline is what tells the two locked states apart, and it is exact rather than
 * a guess — a tab locked *after* being read holds the plaintext in `original`, so covering
 * it would hide the user's own document. An encrypted file whose plaintext really is empty
 * unlocks to `locked: false` and never comes here.
 */
export function isLockedBlank(tab: Tab): boolean {
  return !!tab.locked && tab.original === "";
}

/**
 * One side of a comparison: the content it is, plus the text to show for it.
 *
 * `kind` records where the content came from, and it is part of the side's identity
 * (`sideKey`): a file's unsaved buffer and the file on disk share a path but are two
 * different things, and comparing one against the other — the same-file case — must
 * neither collide with another pair nor collapse when the two sides are swapped.
 */
export interface CompareSide {
  path: string;
  name: string;
  content: string;
  language: string;
  /**
   * Where the text came from. A version is a third answer rather than a variety of `disk`: its
   * content is a snapshot the file no longer holds, and two versions of one file have to land on
   * two different diff models.
   */
  kind: "buffer" | "disk" | "version" | "git";
  /** The version this side was read from, present when `kind` is `version`. */
  oid?: string;
}

/** Identity of one side of a comparison, in the same shape for a side or a source. */
export function sideKey(kind: CompareSide["kind"], path: string, oid?: string): string {
  return `${kind}:${pathKey(path)}${oid ? `:${oid}` : ""}`;
}

/**
 * Which source a side of a comparison is read from: a file off the disk, or the live
 * buffer of an open tab. The buffer variant carries the tab's path as well as its id
 * so a source can be keyed (`sideKey`) without a tab lookup.
 */
export type CompareRef =
  | { kind: "disk"; path: string }
  | { kind: "buffer"; tabId: number; path: string };

export interface ComparePair {
  left: CompareSide;
  right: CompareSide;
}

/**
 * What the sidebar shows. Three rather than two, and every place that used to ask
 * `view === "history" ? … : …` has to name the third one: a pair of ternaries would file
 * versions under explorer and say nothing about it.
 */
export type SidebarView = "explorer" | "history" | "versions" | "git";

/**
 * How a git status letter is coloured in the Explorer. `ignored` is not a change: it says the
 * path is on disk but out of the repository's mind, and it is drawn as a dimmed `!`.
 */
export type GitMarkTone = "add" | "mod" | "del" | "ren" | "conflict" | "type" | "ignored";

/** One changed path as the Explorer decorates it. */
export interface GitMark {
  letter: string;
  tone: GitMarkTone;
  /** True when that letter comes from the index rather than the working tree. */
  staged: boolean;
}

/**
 * A tab backed by a real file the user can edit. Settings, comparison and gallery tabs are
 * not: they have no editable model, so everything that saves, drafts or counts edits must
 * skip them. Getting this wrong is silent — a comparison would try to save itself.
 */
export function isFileTab(tab: Tab): boolean {
  return !tab.isSettings && !tab.compare && !tab.gallery;
}

/**
 * The line ending a text came with, in the spelling the settings use: its first break. Empty
 * when the text has no break in it at all.
 */
export function firstEolOf(text: string): string {
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\r") return text[i + 1] === "\n" ? "crlf" : "cr";
    if (text[i] === "\n") return "lf";
  }
  return "";
}

/**
 * The two endings this app can offer. A carriage return on its own is not among them because
 * Monaco's model joins its lines with LF or CRLF and nothing else — a choice it cannot type is
 * a choice its status bar would have to lie about.
 */
export const LINE_ENDINGS = ["lf", "crlf"] as const;

/**
 * The line endings this tab is written with.
 *
 * One rule answers two questions — what the buffer is set to, and what the status bar says a
 * save will do — because a chip that guesses is worse than no chip. An override wins; a file
 * that came with breaks keeps them, which is what makes the global setting safe to change
 * around a folder written some other way; only a file with none takes that setting. A file
 * whose breaks are lone carriage returns becomes LF, which is what the editor already writes.
 */
export function lineEndingFor(
  tab: { original: string; fileSettings: FileSettings },
  defaultEol: string
): string {
  const wanted = tab.fileSettings.lineEnding ?? (firstEolOf(tab.original) || defaultEol);
  return wanted.toLowerCase() === "crlf" ? "crlf" : "lf";
}

/**
 * Monaco's `EndOfLineSequence` member for one of the two names, taken off the editor instance
 * rather than imported: the loader hands the namespace over at mount and that is the only copy
 * of those two values worth depending on.
 */
export function eolSequence(
  sequences: { LF: number; CRLF: number },
  choice: string
): number {
  return choice === "crlf" ? sequences.CRLF : sequences.LF;
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
