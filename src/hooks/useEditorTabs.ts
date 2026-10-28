import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { t } from "../lib/i18n";
import {
  api,
  errorMessage,
  pickSaveAs,
  EMPTY_FILE_SETTINGS,
  type Draft,
  type FileSettings,
  type FileStat,
  type GroupTab,
  type OpenedFile,
  type SavedFile,
} from "../lib/tauri";
import { basename, dirname, isUntitled, langOf, modelUri, rekeyPath } from "../lib/path";
import { cleanupEdits } from "../lib/saveText";
import type { editor } from "monaco-editor";
import { tabKey, toStoredTab } from "../lib/group";
import {
  eolSequence,
  lineEndingFor,
  pathKey,
  isFileTab,
  isLockedBlank,
  sideKey,
  type ComparePair,
  type CompareRef,
  type CompareSide,
  type EditorHandle,
  type PendingRestore,
  type Tab,
} from "../lib/types";
import type { DraftWriter } from "./useDraft";
import type { VersionRecorder } from "./useVersions";

interface RestoreResult {
  restored: number;
  skipped: number;
}

/**
 * How a save is asked for. `overwrite` answers the "the file changed on disk" question yes in
 * advance; `quiet` holds back the notice, which the automatic save has no click to attach one to;
 * `note` is the word about this save that *Create version* typed, and it goes onto the version the
 * write produces. A save that the conflict question stops takes the note down with it.
 */
type SaveOpts = { overwrite?: boolean; quiet?: boolean; note?: string | null };

/** A tab whose file no longer matches what it holds, waiting for the user to answer for it. */
interface StaleAsk {
  tabId: number;
  /**
   * Raised by a write that would land on top of the other program's change, which is what
   * makes "keep mine" a save rather than just a dismissal.
   */
  fromSave: boolean;
  /**
   * The disk mtime that raised it, kept here because it is what "keep mine" pins: the check
   * compares against the file as it is now, so the baseline the tab was built on would never
   * match and the same write would ask again on every sweep.
   */
  mtime: number;
}

/**
 * A tab whose file has gone off the disk entirely, waiting for the user to say whether the
 * text still in the editor should be kept.
 *
 * Different from a conflict, where the file is there and merely disagrees: here there is
 * nothing on disk to compare against or reload from, and the buffer is the only copy left.
 */
interface GoneAsk {
  tabId: number;
  path: string;
  name: string;
}

/**
 * What a password was asked for, to be run once it has been accepted.
 *
 * The ask is not only "let me read this file": saving and reloading both end up needing the
 * key too, and the three that invent a password have a file to write afterwards. Each has a
 * different thing to do with the answer, so the follow-up travels with the question instead of
 * being guessed from the tab's state when the answer arrives.
 *
 * A `create` carries the text to encrypt rather than reading it later: the dialog is modal, so
 * the buffer cannot change while it is open, and holding the text here means the write does not
 * depend on the tab still being there.
 */
type PasswordThen =
  | { kind: "open" }
  | { kind: "save"; overwrite: boolean }
  | { kind: "create"; target: string; content: string }
  | { kind: "newFile"; parent: string; name: string }
  | { kind: "change" }
  | { kind: "remove" }
  | { kind: "none" };

/** A password this dialog is waiting for, and what happens to the file once it arrives. */
interface PasswordAsk {
  /**
   * Identity of the question rather than of the file. The dialog is keyed on it so that asking
   * about the same path twice — unlocked now, password changed later — starts from an empty
   * field instead of showing the password that was typed the first time.
   */
  id: number;
  /** The tab the ask came from, or null when it came from the Explorer and has no tab yet. */
  tabId: number | null;
  /** What the password is for: the file being unlocked, or the file about to be written. */
  path: string;
  name: string;
  then: PasswordThen;
}

/** Hands out `PasswordAsk.id`. Module scope because an ask outlives no state that could hold it. */
let nextAskId = 1;
/**
 * Which dialog an ask needs.
 *
 * Read off the follow-up rather than stored beside it: the two would then be able to disagree
 * about what was asked, and a dialog that says "unlock" over a call that writes a new file is a
 * lie the user has no way to check.
 */
function passwordModeOf(
  then: PasswordThen | undefined
): "unlock" | "create" | "change" | "remove" {
  switch (then?.kind) {
    case "create":
    case "newFile":
      return "create";
    case "change":
      return "change";
    case "remove":
      return "remove";
    default:
      return "unlock";
  }
}

/**
 * How often the open files are re-statted. A stat is one metadata call per tab, cheap enough to
 * ask on a timer rather than only when the window is refocused — which is exactly the case that
 * matters here: another program writing the file while this window keeps focus.
 */
const DISK_POLL_MS = 4000;

interface Options {
  toast: (message: string) => void;
  draft: DraftWriter;
  editorRef: RefObject<EditorHandle | null>;
  /** Called after a file opens so the sidebar can follow its folder. */
  onFileOpened?: (dir: string) => void;
  /**
   * Preferred encoding for opening files. `auto` lets the backend sniff each one; a
   * fixed value forces it. Kept in a ref so changing the setting never rebuilds the
   * callbacks that depend on it.
   */
  encodingPref?: string;
  /**
   * `auto` loads a reopened session's drafts straight into the tabs; `ask` queues the
   * Restore / Discard dialog for each one. Kept in a ref like `encodingPref`, so changing
   * it never rebuilds the callbacks that read it.
   */
  draftRestorePref?: string;
  /**
   * The line ending for a file that has none of its own, as the global setting names it. In a
   * ref like the two above: a save reads it when it runs, so changing the setting never rebuilds
   * the callbacks.
   */
  lineEndingPref?: string;
  /**
   * The two cleanups a save applies: trailing whitespace and a missing final line break. Read
   * when a save runs, like the preferences above.
   */
  cleanupPref?: { trimTrailingWhitespace: boolean; insertFinalNewline: boolean };
  /**
   * The automatic save: whether it is on, and how long the file on screen must go without an edit
   * before its write happens. Off by default, and it only ever writes a file that already exists —
   * an untitled buffer would have to be asked for a name, which is not something a timer gets to
   * decide.
   *
   * The number is a quiet period, not a polling interval, and it is counted for the active tab
   * only: typing restarts that file's countdown, and a tab left in the background neither starts
   * one nor loses one already running.
   */
  autoSave?: { enabled: boolean; intervalSec: number };
  /**
   * Recording a version of what was just saved. Read through a ref like the preferences above,
   * and never allowed to fail a save: by the time this runs the file is already written, and a
   * version that could not be recorded is worth a notice rather than a lost save.
   */
  versions?: VersionRecorder;
  /**
   * Whether a write the automatic save made should be offered to the recorder at all. Off by
   * default, and only a saving of effort on this side: the backend applies the same switch, so a
   * stale value here can skip a recording but never invent one.
   */
  autoSaveVersions?: boolean;
}

export function useEditorTabs({
  toast,
  draft,
  editorRef,
  onFileOpened,
  encodingPref,
  draftRestorePref,
  lineEndingPref,
  cleanupPref,
  autoSave,
  versions,
  autoSaveVersions,
}: Options) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [restoreQueue, setRestoreQueue] = useState<PendingRestore[]>([]);
  /**
   * Bumped on every caret move. The tab list alone says nothing about *where* inside a
   * file the user was, so the group commit effect listens here instead.
   */
  const [cursorRev, setCursorRev] = useState(0);

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const queueRef = useRef(restoreQueue);
  queueRef.current = restoreQueue;
  const lastFileTabRef = useRef<Tab | null>(null);
  const seq = useRef(0);
  const untitledSeq = useRef(0);
  /** Last known cursor offset per tab, including tabs the editor is not showing. */
  const cursors = useRef(new Map<string, number>());
  /** Restored offsets waiting for their tab to be mounted. */
  const pendingCursors = useRef(new Set<string>());
  const encodingRef = useRef(encodingPref ?? "auto");
  encodingRef.current = encodingPref ?? "auto";
  const draftRestoreRef = useRef(draftRestorePref ?? "auto");
  draftRestoreRef.current = draftRestorePref ?? "auto";
  const lineEndingRef = useRef(lineEndingPref ?? "lf");
  lineEndingRef.current = lineEndingPref ?? "lf";
  const cleanupRef = useRef(
    cleanupPref ?? { trimTrailingWhitespace: false, insertFinalNewline: false }
  );
  cleanupRef.current = cleanupPref ?? cleanupRef.current;
  // In a ref like the preferences above: the recorder is rebuilt whenever the toast it reports
  // through is, and a save must not be rebuilt along with it.
  const versionsRef = useRef(versions);
  versionsRef.current = versions ?? versionsRef.current;
  const autoSaveVersionsRef = useRef(autoSaveVersions ?? false);
  autoSaveVersionsRef.current = autoSaveVersions ?? autoSaveVersionsRef.current;
  /**
   * Set while a reload rewrites a buffer. The change and cursor events that rewrite fires are
   * read by the handlers below against the tab object React has not re-rendered yet, so
   * without this the arriving disk text looks like a fresh edit: the tab would be marked
   * dirty and the draft the reload just dropped would be scheduled again.
   */
  const mutating = useRef(false);
  /** Conflict prompts waiting for an answer, in the order they were found. */
  const [stale, setStale] = useState<StaleAsk[]>([]);
  const staleRef = useRef(stale);
  staleRef.current = stale;
  /**
   * The mtime per file already answered with "keep mine". The periodic check must not ask
   * about the same write twice; a later write is a different question and is asked again.
   */
  const dismissed = useRef(new Map<string, number>());
  /**
   * The conflict comparison popup, or null. Its pair is a snapshot of the moment it was opened:
   * the tab keeps being editable behind it, so a live view would move under the reader.
   */
  const [conflict, setConflict] = useState<{ tabId: number; pair: ComparePair } | null>(null);
  /** Files that have gone off the disk while they were open, waiting for an answer. */
  const [gone, setGone] = useState<GoneAsk[]>([]);
  const goneRef = useRef(gone);
  goneRef.current = gone;
  /** Encrypted files waiting for a password, one dialog at a time, in the order asked. */
  const [passwordAsk, setPasswordAsk] = useState<PasswordAsk[]>([]);
  const passwordRef = useRef(passwordAsk);
  passwordRef.current = passwordAsk;
  /** Why the last password failed, or null. The ask stays queued so it can be retried. */
  const [passwordError, setPasswordError] = useState<string | null>(null);
  /** Set while a password is being checked, so Enter cannot start a second attempt. */
  const [passwordBusy, setPasswordBusy] = useState(false);

  const currentOffset = useCallback(() => {
    const h = editorRef.current;
    const model = h?.editor.getModel();
    const position = h?.editor.getPosition();
    if (!h || !model || !position) return 0;
    return model.getOffsetAt(position);
  }, [editorRef]);

  const nextId = () => ++seq.current;

  /** Switch tabs: first flush the outgoing tab's cursor and pending draft. */
  const activate = useCallback(
    async (id: number | null) => {
      const prev = tabsRef.current.find((t) => t.id === activeRef.current);
      if (prev && isFileTab(prev)) {
        const h = editorRef.current;
        const content = h?.editor.getValue();
        const offset = currentOffset();
        const key = pathKey(prev.path);
        // Remember where the caret was even in a clean tab: the group stores it.
        // Skip it while a restored caret is still waiting to be placed, otherwise the
        // model's default position (0) would overwrite the position we just restored.
        if (!pendingCursors.current.has(key)) cursors.current.set(key, offset);
        setCursorRev((rev) => rev + 1);
        if (content !== undefined && content !== prev.original && !isUntitled(prev.path)) {
          draft.schedule(prev.path, { content, cursor: offset, original: prev.original });
        }
        await draft.flush(prev.path);
      }
      setActiveId(id);
    },
    [currentOffset, draft, editorRef]
  );

  /**
   * Queue a password question. One per file: a startup handover and a session restore can
   * both reach the same encrypted file, and being asked twice for one password is being
   * asked once too often.
   *
   * Returns the id the question was given, or null when one for that path is already waiting.
   * The id is handed out here rather than read back from the state because a caller that is
   * waiting on the answer needs to know which question is theirs.
   */
  const askPassword = useCallback(
    (tabId: number | null, path: string, then: PasswordThen): number | null => {
      // Checked against the mirror as well as inside the updater: the updater runs later than
      // the call that queued it, so a caller asking "was this asked?" cannot wait for it.
      if (passwordRef.current.some((a) => pathKey(a.path) === pathKey(path))) return null;
      const id = nextAskId++;
      setPasswordError(null);
      setPasswordAsk((q) =>
        q.some((a) => pathKey(a.path) === pathKey(path))
          ? q
          : [...q, { id, tabId, path, name: basename(path), then }]
      );
      return id;
    },
    []
  );

  /** Queue a question for a tab that is already known to be locked. */
  const askForTab = useCallback(
    (id: number, then: PasswordThen) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (tab) askPassword(id, tab.path, then);
    },
    [askPassword]
  );

  /**
   * Callers waiting on a question that has no tab of its own.
   *
   * The Explorer's "new encrypted file" is the case this exists for: the file is not on disk
   * until the password is accepted, so the tree cannot be refreshed from the click, and no
   * part of the create is visible to the caller that started it.
   */
  const askWaiters = useRef(new Map<number, (created: boolean) => void>());

  /** Answer a waiter exactly once, whether the answer is that the file exists or that it does not. */
  const settleAsk = useCallback((id: number, created: boolean) => {
    const settle = askWaiters.current.get(id);
    if (!settle) return;
    askWaiters.current.delete(id);
    settle(created);
  }, []);

  // A question that leaves the queue without succeeding is one the waiter would never hear
  // about: a cancel drops it, a lock empties the whole queue, and a duplicate never joins it.
  // Settling those false is what keeps the name input from waiting on a file that is not coming.
  useEffect(() => {
    const live = new Set(passwordAsk.map((a) => a.id));
    for (const id of [...askWaiters.current.keys()]) {
      if (!live.has(id)) settleAsk(id, false);
    }
  }, [passwordAsk, settleAsk]);

  /**
   * Wait for the Monaco model of a path to exist. Startup commits its whole tab set before
   * the editor has built any model for it, so anything that has to write into one asks here
   * instead of guessing how long a cold start takes — the same way the restored caret waits.
   * Null means it never arrived, and gives the caller nothing to write into.
   */
  const waitForModel = useCallback(
    async (path: string, timeoutMs = 3000) => {
      const deadline = performance.now() + timeoutMs;
      for (;;) {
        const h = editorRef.current;
        const model = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(path)));
        if (h && model) return { h, model };
        if (performance.now() >= deadline) return null;
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      }
    },
    [editorRef]
  );

  /**
   * Give the buffer the line endings this file is written with.
   *
   * A file that came with breaks already has them in its model, so this is a no-op in the common
   * case — deliberately so: it is what lets the global setting change without rewriting a folder
   * of files somebody else prepared. Two cases are left: a document with no breaks at all, where
   * the choice decides what the first Enter inserts, and an override, which decides outright.
   *
   * Wrapped in `mutating` because Monaco reports an EOL switch as a content change, and nothing
   * here is an edit — it must not mark the tab unsaved or draft the text for it.
   */
  const applyLineEnding = useCallback(
    async (path: string, original: string, fileSettings: FileSettings) => {
      const choice = lineEndingFor({ original, fileSettings }, lineEndingRef.current);
      const mark = choice === "crlf" ? "\r\n" : "\n";
      const got = await waitForModel(path);
      if (!got || got.model.getEOL() === mark) return;
      mutating.current = true;
      try {
        got.model.setEOL(eolSequence(got.h.monaco.editor.EndOfLineSequence, choice));
      } finally {
        mutating.current = false;
      }
    },
    [waitForModel]
  );

  /**
   * Answer one draft question: put the draft back, or drop it. `restoreTabs` and `finishOpen`
   * call this for the drafts nobody was asked about, and the dialog's loops call it too, so
   * "Restore all" and a quiet load are not separate implementations of the same answer.
   * `quiet` holds back the per-file notice for a caller that reports the whole batch itself.
   *
   * @returns whether text actually went into an editor, which a batch caller needs in order to
   * count what it loaded rather than what it was handed.
   */
  const applyRestore = useCallback(
    async (req: PendingRestore, mode: "restore" | "discard", quiet = false): Promise<boolean> => {
      const key = pathKey(req.path);

      if (mode === "discard") {
        try {
          await api.clearDraft(req.path);
          if (!quiet) toast(t("menu.draftDiscarded"));
        } catch (e) {
          toast(errorMessage(e));
        }
        return false;
      }

      // A picture is never restored into: the "buffer" here is the empty stand-in, and
      // writing text over an image would destroy it.
      if (tabsRef.current.find((t) => t.id === req.tabId)?.isBinary) {
        await api.clearDraft(req.path).catch((e) => toast(errorMessage(e)));
        return false;
      }

      // Startup answers its drafts before every tab has a model: the tabs are committed
      // first, and the models arrive as the editor mounts and as `restoreTabs` primes the
      // rest. A draft whose model never showed up is left on disk, still offered next time.
      const waited = await waitForModel(req.path);
      if (!waited) return false;
      const { h, model } = waited;

      model.setValue(req.draft.content);
      setTabs((prev) => prev.map((t) => (t.id === req.tabId ? { ...t, dirty: true } : t)));
      try {
        // Re-persist immediately: an unsaved tab the user has not visited yet must survive a quit.
        await api.saveDraft(req.path, req.draft.content, req.draft.cursor);
      } catch (e) {
        toast(errorMessage(e));
      }
      // A draft cursor belongs to the draft's content, so it overrides the group's.
      cursors.current.set(key, req.draft.cursor);
      if (activeRef.current === req.tabId) {
        pendingCursors.current.delete(key);
        const offset = Math.min(req.draft.cursor, model.getValueLength());
        const position = model.getPositionAt(offset);
        h.editor.setPosition(position);
        h.editor.revealPositionInCenter(position);
        h.editor.focus();
      } else {
        pendingCursors.current.add(key);
      }
      if (!quiet) toast(t("menu.draftRestored"));
      // Setting the whole buffer re-detects its line endings from the draft's text, so the
      // choice this file is written with has to be put back afterwards — otherwise the tab,
      // the file and the status bar would each describe a different break.
      const restoredInto = tabsRef.current.find((t) => t.id === req.tabId);
      if (restoredInto) {
        void applyLineEnding(req.path, restoredInto.original, restoredInto.fileSettings);
      }
      return true;
    },
    [applyLineEnding, editorRef, waitForModel, toast]
  );

  /**
   * Put one version's text into the editor, without writing it to disk.
   *
   * Shaped like a draft restore for a reason: the buffer changes, the tab is marked unsaved, and
   * the draft is written straight away so a crash now does not lose what was just recovered. A
   * user who does not like what came back closes without saving or undoes the change — which is
   * the whole point of asking before writing. Restoring records no version either: the row it came
   * from already is one, and a version per restore would make the timeline a record of looking at
   * history rather than of saving.
   */
  const restoreVersion = useCallback(
    async (path: string, content: string): Promise<boolean> => {
      const key = pathKey(path);
      const tab = tabsRef.current.find((t) => isFileTab(t) && pathKey(t.path) === key);
      if (!tab) return false;
      const waited = await waitForModel(tab.path);
      if (!waited) return false;
      const { h, model } = waited;
      model.setValue(content);
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, dirty: true } : t)));
      const position = activeRef.current === tab.id ? h.editor.getPosition() : null;
      const cursor = position ? model.getOffsetAt(position) : 0;
      try {
        await api.saveDraft(tab.path, content, cursor);
      } catch (e) {
        toast(errorMessage(e));
      }
      // As after a draft: replacing the whole buffer re-detects the line endings from the text
      // that arrived, and this file's own choice has to go back over it.
      void applyLineEnding(tab.path, tab.original, tab.fileSettings);
      toast(t("ver.restored"));
      return true;
    },
    [applyLineEnding, toast, waitForModel]
  );

  /**
   * The half of an open that only makes sense once the text is in hand: comparing the draft
   * against it, reading this file's own view overrides, and letting a document show its own
   * pictures.
   *
   * Its own function because an encrypted file gets here twice — the first read stops at the
   * password question with no text at all, and the accepted password brings the text and runs
   * this. Sharing it is what keeps that from becoming a second open path that has to be told
   * about every future change to the first one.
   */
  const finishOpen = useCallback(
    async (disk: OpenedFile, tabId: number) => {
      let draftInfo: Draft | null;
      try {
        draftInfo = await api.getDraft(disk.path);
      } catch (e) {
        toast(errorMessage(e));
        return;
      }
      // Per-file overrides are needed before the first paint, not lazily: word wrap and
      // whitespace rendering are read while the model is being attached.
      let own: FileSettings = EMPTY_FILE_SETTINGS;
      try {
        const overrides = await api.fileSettingsView(disk.path);
        own = overrides.overrides;
        setTabs((prev) =>
          prev.map((t) => (t.id === tabId ? { ...t, fileSettings: overrides.overrides } : t))
        );
      } catch {
        // A missing override file is a normal first run; keep the global defaults.
      }
      // The break this file will be written with, put on the buffer as it opens. A file that
      // came with breaks keeps them; only one without takes the override or the setting.
      void applyLineEnding(disk.path, disk.content, own);
      // A document can show its own pictures, so allow the asset protocol to read the one
      // folder it sits in. Fire-and-forget: a document without images works either way.
      void api.allowAssetDir(dirname(disk.path)).catch(() => {});
      if (draftInfo && draftInfo.content !== disk.content) {
        const req: PendingRestore = {
          tabId,
          path: disk.path,
          name: basename(disk.path),
          draft: draftInfo,
        };
        if (draftRestoreRef.current === "ask") {
          setRestoreQueue((q) =>
            q.some((item) => pathKey(item.path) === pathKey(disk.path)) ? q : [...q, req]
          );
        } else {
          // The same answer the dialog gives, asked of the setting instead of the user. Not
          // awaited: a file opened cold gets its model a frame or two after this returns, and
          // `applyRestore` waits for it there.
          void applyRestore(req, "restore");
        }
      } else if (draftInfo) {
        // Draft matches what is on disk: redundant, so drop it.
        await api.clearDraft(disk.path).catch((e) => toast(errorMessage(e)));
      }
    },
    [applyLineEnding, applyRestore, toast]
  );

  /** @returns false when the file could not be read, so a session restore can count skips. */
  const openPath = useCallback(
    async (raw: string, opts?: { record?: boolean }): Promise<boolean> => {
      const record = opts?.record !== false;
      let disk;
      try {
        disk = await api.openFile(raw, record, encodingRef.current);
      } catch (e) {
        if (record) toast(errorMessage(e));
        return false;
      }
      const opened = tabsRef.current.find(
        (t) => isFileTab(t) && pathKey(t.path) === pathKey(disk.path)
      );
      if (record) onFileOpened?.(dirname(disk.path));

      let target: Tab;
      if (opened) {
        target = opened;
        // Only the two lock flags follow the disk here. An open of a file that is already
        // open does not touch its text — that would throw away the edits in it — and the
        // flags are what every later save, reload and comparison asks before it acts.
        if (opened.encrypted !== disk.encrypted || opened.locked !== disk.locked) {
          setTabs((prev) =>
            prev.map((t) =>
              t.id === opened.id ? { ...t, encrypted: disk.encrypted, locked: disk.locked } : t
            )
          );
        }
        await activate(opened.id);
      } else {
        target = {
          id: nextId(),
          path: disk.path,
          name: basename(disk.path),
          language: langOf(disk.path),
          original: disk.content,
          mtime: disk.mtime,
          dirty: false,
          // A picture arrives with no text, and the preview is the only view of it that
          // means anything. Marking it here is what keeps the editor out of the way.
          isBinary: disk.binary,
          encoding: disk.encoding,
          bom: disk.bom,
          bytes: disk.bytes,
          encrypted: disk.encrypted,
          locked: disk.locked,
          fileSettings: EMPTY_FILE_SETTINGS,
        };
        setTabs((prev) => [...prev, target]);
        await activate(target.id);
      }
      // A locked read carries no text, so there is nothing to compare a draft against and
      // nothing to show. The tab exists and says it is locked; the rest of the open runs
      // once a password has been accepted.
      if (disk.locked) {
        askPassword(target.id, disk.path, { kind: "open" });
        return true;
      }
      await finishOpen(disk, target.id);
      return true;
    },
    [activate, askPassword, finishOpen, onFileOpened, toast]
  );

  /**
   * Persist this file's overrides, then reflect them on the tab. The backend drops
   * entries that match the default, so "reset" is a normal save with nulls.
   */
  const setFileSettings = useCallback(
    async (path: string, next: FileSettings) => {
      try {
        const saved = await api.saveFileSettings(path, next);
        setTabs((prev) =>
          prev.map((t) => (t.path === path ? { ...t, fileSettings: saved } : t))
        );
        // The override is about the buffer on screen, not only the next save: without this the
        // tab would go on typing the break it started with until it is closed and opened again.
        void applyLineEnding(path, tabsRef.current.find((t) => t.path === path)?.original ?? "", saved);
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [applyLineEnding, toast]
  );

  const openUntitled = useCallback(async () => {
    const name = t("tab.untitled", { n: ++untitledSeq.current });
    const tab: Tab = {
      id: nextId(),
      path: `untitled://${name}`,
      name,
      language: "plaintext",
      original: "",
      dirty: false,
      encoding: "UTF-8",
      bom: false,
      bytes: null,
      fileSettings: EMPTY_FILE_SETTINGS,
    };
    setTabs((prev) => [...prev, tab]);
    await activate(tab.id);
    // A buffer that starts empty has no line ending to call its own, which is exactly the case
    // the setting speaks for: without this the first Enter inserts LF whatever it says.
    void applyLineEnding(tab.path, tab.original, tab.fileSettings);
  }, [activate, applyLineEnding]);

  /**
   * Move a tab to another position in the strip. Only the order changes: the active tab is
   * tracked by id, so dropping it elsewhere does not disturb what is on screen.
   *
   * `toIndex` is the gap to drop into, counted with the dragged tab still in place: 0 is
   * before the first tab and `length` is after the last, so it may equal the length. Removing
   * the tab first shifts everything after it along, which is why a drop later in the strip
   * has to land one place earlier than the gap it pointed at.
   */
  const moveTab = useCallback((id: number, toIndex: number) => {
    setTabs((prev) => {
      const from = prev.findIndex((t) => t.id === id);
      if (from < 0) return prev;
      const to = Math.max(0, Math.min(prev.length, toIndex));
      // Already there: either side of the gap it is sitting in means the same position.
      if (from === to || from === to - 1) return prev;
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(from < to ? to - 1 : to, 0, moved);
      return next;
    });
  }, []);

  /**
   * The text a tab holds right now. It lives in a Monaco model, not in React state: the editor
   * only ever shows one tab, so a background tab's live text is reachable through its model and
   * nowhere else. Undefined means the tab has no model yet, which is to say it still holds
   * exactly what it was built from.
   */
  const liveContent = useCallback(
    (tab: Tab): string | undefined => {
      const h = editorRef.current;
      if (!h) return undefined;
      if (tab.id === activeRef.current) return h.editor.getValue();
      return h.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)))?.getValue();
    },
    [editorRef]
  );

  /**
   * The text a tab holds right now, for a caller that has its id rather than the editor.
   *
   * The same three rungs the comparison uses: the live model, the text a restored tab was seeded
   * with, and the content it was opened with. Skipping a rung would hand back nothing for a tab
   * whose model has not been mounted yet, and recording that as a version would say the file went
   * blank.
   */
  const tabText = useCallback(
    (id: number): string | null => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || !isFileTab(tab)) return null;
      return liveContent(tab) ?? tab.initialValue ?? tab.original;
    },
    [liveContent]
  );

  /**
   * Open a read-only comparison of two sources as its own tab.
   *
   * A source is either a file read off the disk or the live buffer of an open tab, and
   * the buffer is what makes an unsaved edit comparable — against a saved file or
   * against another unsaved buffer. Either way the text is snapshotted into the tab
   * rather than pointed at the live models: a comparison is a snapshot of a question,
   * and sharing models would make a diff follow every keystroke in either file while
   * dragging drafts and dirty flags along. The pair is also not part of the group
   * store, so it never comes back on the next start.
   *
   * The synthetic `compare://` path below is a React key and an identity, never a real
   * one: it embeds whatever the sides were named (an `untitled://` key included), and
   * `isFileTab` keeps it out of every path lookup. Nothing may try to parse it.
   */
  /**
   * Show two already-resolved sides as a comparison tab. The sources in `openCompare` are read
   * here; a caller that already holds the text (a git blob, the index, a commit) goes straight to
   * this. The pair is also not part of the group store, so it never comes back on the next start.
   */
  const showCompare = useCallback(
    async (leftIn: CompareSide, rightIn: CompareSide) => {
      let left = leftIn;
      let right = rightIn;
      const leftKey = sideKey(left.kind, left.path, left.oid);
      const rightKey = sideKey(right.kind, right.path, right.oid);
      if (leftKey === rightKey) {
        toast(t("cmp.same"));
        return;
      }
      // The same path on both sides is the same-file comparison, and the kind is all
      // that tells the two apart — so the disk side says so, the way the conflict prompt
      // labels its two versions. The buffer side already carries its own "unsaved"
      // marker when it holds edits, and a clean buffer needs no marker of its own.
      if (pathKey(left.path) === pathKey(right.path)) {
        const labelDisk = (side: CompareSide): CompareSide =>
          side.kind === "disk"
            ? { ...side, name: t("stale.diskSide", { name: side.name }) }
            : side;
        left = labelDisk(left);
        right = labelDisk(right);
      }
      // Same pair in the same order is the same question: refresh it in place rather
      // than stacking duplicates. Re-running a comparison is how a snapshot gets
      // refreshed — either source may have moved on since it was opened. Mirrors
      // openPath, which reuses an already-open file.
      const existing = tabsRef.current.find(
        (tab) =>
          !!tab.compare &&
          sideKey(tab.compare.left.kind, tab.compare.left.path, tab.compare.left.oid) ===
            leftKey &&
          sideKey(tab.compare.right.kind, tab.compare.right.path, tab.compare.right.oid) ===
            rightKey
      );
      if (existing) {
        setTabs((prev) =>
          prev.map((tab) =>
            tab.id === existing.id
              ? {
                  ...tab,
                  name: t("cmp.label", { left: left.name, right: right.name }),
                  compare: { left, right },
                }
              : tab
          )
        );
        await activate(existing.id);
        return;
      }
      const tab: Tab = {
        id: nextId(),
        // Not a real path, and never treated as one: it is only a key for React and for
        // telling this tab apart from a file. `isFileTab` keeps it out of every path lookup.
        path: `compare://${leftKey}|${rightKey}`,
        name: t("cmp.label", { left: left.name, right: right.name }),
        language: right.language,
        original: "",
        dirty: false,
        compare: { left, right },
        encoding: "UTF-8",
        bom: false,
        bytes: null,
        fileSettings: EMPTY_FILE_SETTINGS,
      };
      setTabs((prev) => [...prev, tab]);
      await activate(tab.id);
    },
    [activate, toast]
  );

  const openCompare = useCallback(
    async (leftRef: CompareRef, rightRef: CompareRef) => {
      if (sideKey(leftRef.kind, leftRef.path) === sideKey(rightRef.kind, rightRef.path)) {
        toast(t("cmp.same"));
        return;
      }
      /**
       * A tab's buffer as one side. `null` means the tab is gone — closed while a picker
       * was open — and the caller says so rather than snapshotning nothing.
       */
      const bufferSide = (ref: CompareRef & { kind: "buffer" }): CompareSide | null => {
        const tab = tabsRef.current.find((item) => item.id === ref.tabId);
        if (!tab) return null;
        // An unsaved file reads as "{name} · unsaved", the wording the conflict prompt
        // already uses; an untitled buffer is unsaved by its name and needs no suffix.
        const unsaved = tab.dirty && !isUntitled(tab.path);
        return {
          path: tab.path,
          name: unsaved ? t("stale.mineSide", { name: tab.name }) : tab.name,
          // A tab restored from the group store but never mounted has no model yet, so
          // its text is the value the model would be seeded with, and failing that the
          // baseline it was opened with. Skipping a rung snapshots an empty file.
          content: liveContent(tab) ?? tab.initialValue ?? tab.original,
          language: tab.language,
          kind: "buffer",
        };
      };
      const diskSide = async (ref: CompareRef & { kind: "disk" }): Promise<CompareSide> => {
        const disk = await api.openFile(ref.path, false, encodingRef.current);
        // A locked file reads back empty, and an empty side would be shown as a real
        // difference against everything instead of as a file this session cannot open.
        // Thrown as the code the backend uses, so the catch below localizes it the same way.
        if (disk.locked) throw "encrypted_locked";
        return {
          path: disk.path,
          name: basename(disk.path),
          content: disk.content,
          language: langOf(disk.path),
          kind: "disk",
        };
      };
      let left: CompareSide;
      let right: CompareSide;
      try {
        const [maybeLeft, maybeRight] = await Promise.all([
          leftRef.kind === "buffer" ? Promise.resolve(bufferSide(leftRef)) : diskSide(leftRef),
          rightRef.kind === "buffer" ? Promise.resolve(bufferSide(rightRef)) : diskSide(rightRef),
        ]);
        if (!maybeLeft || !maybeRight) {
          toast(t("cmp.gone"));
          return;
        }
        left = maybeLeft;
        right = maybeRight;
      } catch (e) {
        toast(errorMessage(e));
        return;
      }
      await showCompare(left, right);
    },
    [liveContent, showCompare, toast]
  );

  /**
   * Put the right file on the left. Both sides are already in the tab, so this reorders
   * without touching the disk — and the diff models are keyed by the ordered pair, so
   * Monaco builds fresh ones instead of reusing the models it already has.
   */
  const swapCompare = useCallback((id: number) => {
    setTabs((prev) =>
      prev.map((tab) => {
        if (tab.id !== id || !tab.compare) return tab;
        const { left, right } = tab.compare;
        return {
          ...tab,
          compare: { left: right, right: left },
          name: t("cmp.label", { left: right.name, right: left.name }),
          language: left.language,
        };
      })
    );
  }, []);

  /**
   * Re-home every tab whose file moved on disk, with the Monaco model, the remembered caret
   * and the queued draft prompt that belong to it.
   *
   * The buffers are the only place a file's unsaved text lives, so they come across; the undo
   * stack cannot, because Monaco has no way to rename a model's URI and a rebuilt model starts
   * with an empty history. That is the price of the move and the reason the rebuild happens
   * here rather than as a reopen: the text, the language and the caret are all kept.
   * Everything here runs in one synchronous block, so no render can ever show a tab whose
   * model is still under the old path. Pending drafts must already be flushed by the caller,
   * or they would be written back under the old key.
   */
  const rekeyTabsMany = useCallback((pairs: { oldPath: string; path: string }[]) => {
    // One simultaneous substitution. A batch can swap two names, so every pair is tried
    // against the path as it was and the first match wins; entries of a batch never nest,
    // which is what makes one match the right number.
    const mapPath = (path: string) => {
      for (const pair of pairs) {
        const next = rekeyPath(path, pair.oldPath, pair.path);
        if (next !== path) return next;
      }
      return path;
    };
    const moved = new Map<string, string>();
    for (const tab of tabsRef.current) {
      if (!isFileTab(tab) || isUntitled(tab.path)) continue;
      const next = mapPath(tab.path);
      if (next !== tab.path) moved.set(pathKey(tab.path), next);
    }
    if (moved.size === 0) return;

    const h = editorRef.current;
    if (h) {
      for (const tab of tabsRef.current) {
        const next = moved.get(pathKey(tab.path));
        if (!next) continue;
        const model = h.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
        // A tab that has never mounted has no model to move; Editor builds it under the new
        // path the first time the tab is shown.
        if (!model) continue;
        const uri = h.monaco.Uri.parse(modelUri(next));
        if (h.monaco.editor.getModel(uri)) {
          // A tab left over for the new path already keeps a model there. That model belongs
          // to the path, so this one is dropped rather than made to fight it for the URI.
          model.dispose();
          continue;
        }
        // Monaco 0.57 has no API to rename a model's URI; the model is rebuilt under the new
        // path with its text and its language, and the editor follows it when it is showing it.
        const rebuilt = h.monaco.editor.createModel(model.getValue(), model.getLanguageId(), uri);
        if (h.editor.getModel() === model) h.editor.setModel(rebuilt);
        model.dispose();
      }
    }
    for (const [key, next] of moved) {
      const target = pathKey(next);
      const offset = cursors.current.get(key);
      if (offset !== undefined) {
        cursors.current.delete(key);
        cursors.current.set(target, offset);
      }
      if (pendingCursors.current.delete(key)) pendingCursors.current.add(target);
    }
    const rekeyed = (tab: Tab): Tab => {
      const next = moved.get(pathKey(tab.path));
      return !next || !isFileTab(tab)
        ? tab
        : { ...tab, path: next, name: basename(next), language: langOf(next) };
    };
    setTabs((prev) => prev.map(rekeyed));
    setRestoreQueue((q) =>
      q.map((req) => {
        const next = moved.get(pathKey(req.path));
        return next ? { ...req, path: next, name: basename(next) } : req;
      })
    );
    // This tab is what the editor keeps showing behind a Settings or comparison tab, so it
    // has to move with its tab rather than be re-derived from the stale object.
    const last = lastFileTabRef.current;
    if (last) lastFileTabRef.current = rekeyed(last);
    // A document can point at its own pictures, and the grant covered the old folder.
    for (const next of moved.values()) void api.allowAssetDir(dirname(next)).catch(() => {});
  }, []);

  /** One pair, for a rename that moves a single entry. */
  const rekeyTabs = useCallback(
    (oldRoot: string, newRoot: string) => rekeyTabsMany([{ oldPath: oldRoot, path: newRoot }]),
    [rekeyTabsMany]
  );

  /** Serializable view of the open tabs, for the group store. */
  const snapshotTabs = useCallback((): { tabs: GroupTab[]; active: string } => {
    const h = editorRef.current;
    const live = tabsRef.current.filter(isFileTab);
    const tabs = live.map((tab) => {
      const model = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
      return toStoredTab({
        path: tab.path,
        name: tab.name,
        cursor: cursors.current.get(pathKey(tab.path)) ?? 0,
        value: model ? model.getValue() : (tab.initialValue ?? tab.original),
      });
    });
    const activeTab = live.find((t) => t.id === activeRef.current);
    return { tabs, active: activeTab ? tabKey(activeTab.path) : "" };
  }, [editorRef]);

  /**
   * Reopen a whole group at once. Every file is read in parallel and all tab objects are
   * built up front, then committed in a single `setTabs` — so the tab strip appears fully
   * populated and the editor lands straight on the file the user last viewed, instead of the
   * sequential open where each tab flashes into focus as it is read. Drafts and per-file
   * overrides are fetched in parallel afterwards and merged in one more update.
   *
   * The old per-tab path activated each tab as it loaded, which both caused the flicker and
   * incidentally created a Monaco model for every tab (the draft-restore prompt needs a model
   * for any tab, not just the active one). Here the non-active models are primed explicitly
   * once the editor mounts, so a later draft answer still applies without ever showing those
   * tabs during startup.
   */
  const restoreTabs = useCallback(
    async (entries: GroupTab[], activeKey: string): Promise<RestoreResult> => {
      // Read every file in parallel; a dead path yields a null slot that becomes a skip.
      const built = await Promise.all(
        entries.map(async (entry): Promise<Tab | null> => {
          if (entry.path) {
            try {
              const disk = await api.openFile(entry.path, false, encodingRef.current);
              return {
                id: nextId(),
                path: disk.path,
                name: basename(disk.path),
                language: langOf(disk.path),
                original: disk.content,
                mtime: disk.mtime,
                dirty: false,
                isBinary: disk.binary,
                encoding: disk.encoding,
                bom: disk.bom,
                bytes: disk.bytes,
                encrypted: disk.encrypted,
                locked: disk.locked,
                fileSettings: EMPTY_FILE_SETTINGS,
              };
            } catch {
              return null;
            }
          }
          if (entry.untitled) {
            const trailing = /(\d+)$/.exec(entry.untitled);
            if (trailing) untitledSeq.current = Math.max(untitledSeq.current, Number(trailing[1]));
            return {
              id: nextId(),
              path: `untitled://${entry.untitled}`,
              name: entry.untitled,
              language: "plaintext",
              original: "",
              dirty: entry.content !== "",
              initialValue: entry.content,
              encoding: "UTF-8",
              bom: false,
              bytes: null,
              fileSettings: EMPTY_FILE_SETTINGS,
            };
          }
          return null;
        })
      );
      const tabsBuilt = built.filter((t): t is Tab => t !== null);
      const skipped = entries.length - tabsBuilt.length;

      // Land on the file the user left selected, or the last tab as a fallback.
      const wanted = tabsBuilt.find(
        (t) => isFileTab(t) && pathKey(t.path) === pathKey(activeKey)
      );
      const active = wanted ?? tabsBuilt[tabsBuilt.length - 1];
      // Remember restored carets before the editor mounts: the active tab's is placed by the
      // cursor-restore effect, and the rest are ready when that tab is eventually visited.
      for (const entry of entries) {
        if (entry.path && entry.cursor > 0) {
          const key = pathKey(entry.path);
          cursors.current.set(key, entry.cursor);
          pendingCursors.current.add(key);
        }
      }

      // One commit: the strip fills in all at once and the editor opens on the active file.
      setTabs(tabsBuilt);
      setActiveId(active ? active.id : null);
      // The tab list is read through a ref by callers that snapshot it in the same turn
      // (switching groups commits the new group's tabs right after this returns). React has
      // not rendered yet, so without this the snapshot would still be the outgoing group's.
      tabsRef.current = tabsBuilt;
      activeRef.current = active ? active.id : null;

      // An encrypted file nobody has decrypted yet is restored as a lock, and its password is
      // asked for in the order the tabs sit in the strip — one dialog at a time, which is what
      // makes a session holding several of them survivable. Each answer runs `finishOpen`, so
      // the draft and override work below is skipped here rather than done twice.
      setPasswordAsk((q) => [
        ...q,
        ...tabsBuilt
          .filter((tab) => tab.locked)
          .filter((tab) => !q.some((a) => pathKey(a.path) === pathKey(tab.path)))
          .map((tab) => ({
            id: nextAskId++,
            tabId: tab.id,
            path: tab.path,
            name: tab.name,
            then: { kind: "open" } as PasswordThen,
          })),
      ]);

      // Drafts and overrides are independent per file, so fetch them together.
      const extras = await Promise.all(
        tabsBuilt.map(async (tab) => {
          if (!isFileTab(tab) || tab.locked) {
            return { id: tab.id, overrides: EMPTY_FILE_SETTINGS, draft: null as Draft | null };
          }
          const [draft, view] = await Promise.all([
            api.getDraft(tab.path).catch(() => null),
            api.fileSettingsView(tab.path).catch(() => ({ overrides: EMPTY_FILE_SETTINGS })),
          ]);
          void api.allowAssetDir(dirname(tab.path)).catch(() => {});
          return { id: tab.id, overrides: view.overrides, draft };
        })
      );
      const overrideMap = new Map(extras.map((e) => [e.id, e.overrides]));
      const queued: PendingRestore[] = [];
      for (const e of extras) {
        if (!e.draft) continue;
        const tab = tabsBuilt.find((t) => t.id === e.id);
        if (tab && e.draft.content !== tab.original) {
          queued.push({ tabId: e.id, path: tab.path, name: tab.name, draft: e.draft });
        } else if (tab) {
          await api.clearDraft(tab.path).catch(() => {});
        }
      }
      // Merge overrides in one update, then hand the drafts to their answer: `ask` queues the
      // dialog, `auto` runs the same `applyRestore` the dialog's "Restore all" uses, so a
      // quiet load is not a second implementation of that answer.
      setTabs((prev) => prev.map((t) => {
        const ov = overrideMap.get(t.id);
        return ov ? { ...t, fileSettings: ov } : t;
      }));
      if (queued.length > 0) {
        if (draftRestoreRef.current === "ask") setRestoreQueue((q) => [...q, ...queued]);
        else {
          // Not awaited: these models arrive as the editor mounts and as `prime` below builds
          // the ones nobody has visited, and startup must not wait on a file nobody opened.
          void (async () => {
            let loaded = 0;
            for (const req of queued) if (await applyRestore(req, "restore", true)) loaded++;
            if (loaded > 0) toast(t("draft.autoRestored", { n: loaded }));
          })();
        }
      }

      // A restored tab never goes through an open, so its line endings are settled here. For a
      // file that came with breaks the model already has them and this changes nothing; what it
      // covers is the override, and the file with no breaks at all.
      for (const e of extras) {
        const tab = tabsBuilt.find((t) => t.id === e.id);
        if (tab) void applyLineEnding(tab.path, tab.original, e.overrides);
      }

      // Prime the editor's model registry with every restored file so a switch shows its
      // content immediately and a draft prompt can be applied to any tab, not just the
      // active one. The active tab's model is owned by <Editor> and already exists.
      const prime = () => {
        const h = editorRef.current;
        if (!h) {
          requestAnimationFrame(prime);
          return;
        }
        for (const tab of tabsBuilt) {
          if (!isFileTab(tab)) continue;
          const uri = h.monaco.Uri.parse(modelUri(tab.path));
          if (h.monaco.editor.getModel(uri)) continue;
          // `initialValue` first: a restored untitled tab keeps its text there, while
          // `original` is empty for a buffer with no file behind it. Priming the empty
          // string would make <Editor> reuse that model and silently drop the text —
          // both when the tab is first visited and when anything reads it before then.
          h.monaco.editor.createModel(tab.initialValue ?? tab.original, tab.language, uri);
        }
      };
      requestAnimationFrame(prime);

      return { restored: tabsBuilt.length, skipped };
    },
    // Both are stable: `toast` is a `useCallback` with no dependencies and the two callbacks
    // reached here read the editor through refs, so this is not rebuilt when settings change.
    [applyLineEnding, applyRestore, toast]
  );

  /**
   * Move the caret to a restored offset once that tab's model is actually attached.
   * Called whenever the active tab changes; retried for a few frames because the editor
   * swaps models in its own effect.
   */
  const applyPendingCursor = useCallback(
    (until = 0) => {
      const tab = tabsRef.current.find((t) => t.id === activeRef.current);
      if (!tab || !isFileTab(tab)) return;
      const key = pathKey(tab.path);
      if (!pendingCursors.current.has(key)) return;
      const deadline = until || performance.now() + 3000;
      const h = editorRef.current;
      const model = h?.editor.getModel();
      // Compare through Uri.parse: uri.toString() percent-encodes the drive colon, so a
      // raw string compare against modelUri() never matches and the caret is never placed.
      const wanted = h ? h.monaco.Uri.parse(modelUri(tab.path)).toString() : "";
      if (!h || !model || model.uri.toString() !== wanted) {
        // The first model of a cold start is created after the editor worker boots, so this
        // waits on the model rather than on a fixed number of frames.
        if (performance.now() < deadline) requestAnimationFrame(() => applyPendingCursor(deadline));
        return;
      }
      pendingCursors.current.delete(key);
      const offset = Math.min(cursors.current.get(key) ?? 0, model.getValueLength());
      const position = model.getPositionAt(offset);
      h.editor.setPosition(position);
      h.editor.revealPositionInCenterIfOutsideViewport(position);
    },
    [editorRef]
  );

  const openSettings = useCallback(async () => {    const existing = tabsRef.current.find((t) => t.isSettings);
    if (existing) {
      await activate(existing.id);
      return;
    }
    const tab: Tab = {
      id: nextId(),
      path: "__settings__",
      name: t("tab.settings"),
      language: "plaintext",
      original: "",
      dirty: false,
      isSettings: true,
      encoding: "UTF-8",
      bom: false,
      bytes: null,
      fileSettings: EMPTY_FILE_SETTINGS,
    };
    setTabs((prev) => [...prev, tab]);
    await activate(tab.id);
  }, [activate]);

  /**
   * Show a folder's pictures in its own tab.
   *
   * Same folder asked for twice activates the tab that is already there rather than piling up
   * another view of it. `startPath` is the picture to land on; the gallery resolves it to an
   * index once the listing is in, because the tab is created before the files are known.
   */
  const openGallery = useCallback(
    async (dir: string, startPath?: string) => {
      const existing = tabsRef.current.find(
        (t) => t.gallery && pathKey(t.gallery.dir) === pathKey(dir)
      );
      if (existing) {
        setTabs((prev) =>
          prev.map((t) =>
            t.id === existing.id ? { ...t, gallery: { dir, startPath } } : t
          )
        );
        await activate(existing.id);
        return;
      }
      const tab: Tab = {
        id: nextId(),
        path: `gallery://${dir}`,
        name: basename(dir) || dir,
        language: "plaintext",
        original: "",
        dirty: false,
        gallery: { dir, startPath },
        encoding: "UTF-8",
        bom: false,
        bytes: null,
        fileSettings: EMPTY_FILE_SETTINGS,
      };
      setTabs((prev) => [...prev, tab]);
      await activate(tab.id);
    },
    [activate]
  );

  const closeTab = useCallback(
    async (id: number) => {
      const list = tabsRef.current;
      const index = list.findIndex((t) => t.id === id);
      if (index < 0) return;
      const tab = list[index];
      const isActive = activeRef.current === id;
      const remaining = list.filter((t) => t.id !== id);
      const focus = isActive ? remaining[Math.max(0, index - 1)] ?? null : null;

      if (isActive) setActiveId(focus ? focus.id : null);
      if (isFileTab(tab)) {
        if (isActive && !isUntitled(tab.path)) {
          const content = editorRef.current?.editor.getValue();
          if (content !== undefined && content !== tab.original) {
            draft.schedule(tab.path, { content, cursor: currentOffset(), original: tab.original });
          }
        }
        await draft.flush(tab.path);
      }
      setTabs(remaining);
      // A prompt about a tab that no longer exists would sit in front of the ones still waiting.
      setStale((q) => q.filter((a) => a.tabId !== id));
      // Same for a password question: the file it would unlock is no longer open, and leaving
      // it queued would ask for a password with nothing behind the answer.
      setPasswordAsk((q) => q.filter((a) => a.tabId !== id));
      setConflict((c) => (c && c.tabId === id ? null : c));
      // A closed tab's caret is no longer anybody's; the next open starts at 0.
      cursors.current.delete(pathKey(tab.path));
      pendingCursors.current.delete(pathKey(tab.path));

      // The active model is disposed by Editor itself on unmount/switch; release the rest
      // so closing tabs does not leak models.
      const h = editorRef.current;
      if (h && isFileTab(tab)) {
        setTimeout(() => {
          const model = h.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
          if (model && model !== h.editor.getModel()) model.dispose();
        }, 0);
      }
    },
    [currentOffset, draft, editorRef]
  );

  /** Drop the whole tab set (switching groups). Drafts were flushed by the caller. */
  const clearAllTabs = useCallback(() => {
    const h = editorRef.current;
    for (const tab of tabsRef.current) {
      if (!isFileTab(tab)) continue;
      const model = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
      if (model && model !== h?.editor.getModel()) model.dispose();
    }
    cursors.current.clear();
    pendingCursors.current.clear();
    // Unanswered draft prompts belong to the context that raised them, not the next one;
    // the drafts themselves stay on disk and are offered again where the tab now lives.
    setRestoreQueue([]);
    // A conflict prompt belongs to the tabs that raised it, exactly as a draft prompt does.
    setStale([]);
    // So does a password question: the encrypted file it was about belongs to the group being
    // left, and the next group's locks ask for themselves when they are opened.
    setPasswordAsk([]);
    setPasswordError(null);
    dismissed.current.clear();
    setConflict(null);
    lastFileTabRef.current = null;
    setTabs([]);
    setActiveId(null);
    // Same reason as in `restoreTabs`: a group switch snapshots the live tabs immediately
    // after clearing them, and an empty group must be committed as empty rather than
    // inheriting the tabs that were just on screen.
    tabsRef.current = [];
    activeRef.current = null;
  }, [editorRef]);

  const onEditorChange = useCallback(
    (value: string) => {
      // A reload replaces the buffer on purpose; see `mutating`.
      if (mutating.current) return;
      const tab = tabsRef.current.find((t) => t.id === activeRef.current);
      if (!tab || !isFileTab(tab)) return;
      const dirty = value !== tab.original;
      if (dirty !== tab.dirty) {
        setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, dirty } : t)));
      }
      if (isUntitled(tab.path)) return;
      draft.schedule(tab.path, { content: value, cursor: currentOffset(), original: tab.original });
      // An edit is what the quiet period counts from: the countdown for this one tab starts over,
      // so the automatic write follows the pause rather than landing in the middle of typing.
      if (dirty) autoSaveArm.current(tab.id);
    },
    [currentOffset, draft]
  );

  /** Keep the stored cursor honest: edits and content changes can both land before a move. */
  const onCursorChange = useCallback(
    (offset: number) => {
      // `setValue` in a reload parks the caret at the start, and the reload puts it back
      // itself; reading the event would overwrite both with 0.
      if (mutating.current) return;
      const tab = tabsRef.current.find((t) => t.id === activeRef.current);
      if (!tab || !isFileTab(tab)) return;
      // Swapping models emits a cursor event for a position nobody chose. Trusting it
      // would erase both the remembered caret and the draft's caret for that tab.
      if (editorRef.current?.editor.hasTextFocus() !== true) return;
      const key = pathKey(tab.path);
      cursors.current.set(key, offset);
      // The caret moved under the user, so a restored offset for this tab is now stale.
      pendingCursors.current.delete(key);
      setCursorRev((rev) => rev + 1);
      if (isUntitled(tab.path)) return;
      const content = editorRef.current?.editor.getValue();
      // Compare against the disk baseline instead of tab.dirty: the dirty flag comes from
      // a React state update, so a caret move that follows the first edit can arrive before
      // the tab is known to be dirty, and the draft would keep the caret at 0.
      if (content === undefined || content === tab.original) return;
      draft.schedule(tab.path, { content, cursor: offset, original: tab.original });
    },
    [draft, editorRef]
  );

  /**
   * Apply the save cleanups — trailing whitespace, a missing final line break — to the buffer
   * itself, before its text is written. The alternative, tidying only the bytes on the way out,
   * would leave three texts to disagree: the one on screen, the one on disk, and the one the tab
   * keeps to decide whether it is unsaved.
   *
   * Under `mutating`, because these are the app tidying up rather than the user typing: they
   * must not mark the tab unsaved or schedule a draft for the text they produce. They do go
   * through the undo stack, so one Ctrl+Z takes them back.
   */
  const applySaveCleanup = useCallback((model: editor.ITextModel) => {
    const { trimTrailingWhitespace, insertFinalNewline } = cleanupRef.current;
    if (!trimTrailingWhitespace && !insertFinalNewline) return;
    const lines: string[] = [];
    for (let i = 1; i <= model.getLineCount(); i++) lines.push(model.getLineContent(i));
    const edits = cleanupEdits(lines, {
      trimTrailingWhitespace,
      insertFinalNewline,
      eol: model.getEOL(),
    });
    if (edits.length === 0) return;
    mutating.current = true;
    try {
      model.applyEdits(
        edits.map((edit) => ({
          range: {
            startLineNumber: edit.startLine,
            startColumn: edit.startColumn,
            endLineNumber: edit.endLine,
            endColumn: edit.endColumn,
          },
          text: edit.text,
        }))
      );
    } finally {
      mutating.current = false;
    }
  }, []);

  /**
   * Write one tab back to disk. Resolves false when nothing was written, which is what a
   * declined "Save as", a picture with no buffer, a file another program has since changed,
   * and a failed write all amount to: the caller has to know, because a close that was asked
   * to save must not go ahead without it.
   *
   * `quiet` is for the automatic save, which has no click behind it to acknowledge: the notice
   * that a save was asked for would then arrive on its own, every few seconds, over a file the
   * user is not looking at.
   */
  const saveTab = useCallback(async (id: number, opts?: SaveOpts): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.id === id);
    const h = editorRef.current;
    // A picture has no buffer to write. Saving one would write the empty text that stands
    // in for it and destroy the file, so this is refused rather than merely discouraged.
    if (!tab || !isFileTab(tab) || tab.isBinary || !h) return false;
    // An encrypted file with no key behind it cannot be written: the backend refuses it, and
    // for a tab that was never unlocked the buffer is empty, so writing it would be writing
    // nothing over a document. Ask for the password and run the save again once it is
    // accepted — the question is worth more than an error toast the user has to act on anyway.
    if (tab.locked) {
      askForTab(tab.id, { kind: "save", overwrite: !!opts?.overwrite });
      return false;
    }
    // The editor only ever holds the active tab's text; another tab's live text is in its
    // model. Reading the wrong one would save the file the user is looking at instead.
    const model =
      id === activeRef.current
        ? h.editor.getModel()
        : h.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
    // A write replaces whatever is there now, so when that is not what this tab was built on
    // the question is asked first — and asked again however many times the save is attempted:
    // unlike the periodic check, this one is an answer the user already declined once and is
    // now overriding on purpose. An untitled buffer has no file to disagree with yet.
    if (!isUntitled(tab.path) && !opts?.overwrite && tab.mtime !== undefined) {
      // A failed stat is not a conflict: the file may be gone, or on a share that is not
      // answering, and guessing from that would refuse writes that are perfectly fine.
      const stat = await api.statFile(tab.path).catch(() => null);
      if (stat && (stat.mtime !== tab.mtime || stat.bytes !== tab.bytes)) {
        setStale((q) => {
          // Raised by a save now, even if the same file is already on the list from a
          // periodic check: the answer for that one only closes a prompt, this one writes.
          const ask = { tabId: tab.id, fromSave: true, mtime: stat.mtime };
          return q.some((a) => a.tabId === tab.id)
            ? q.map((a) => (a.tabId === tab.id ? ask : a))
            : [...q, ask];
        });
        return false;
      }
    }
    try {
      // The cleanups happen once the save is committed to happening: turning down the "changed on
      // disk" question above should not leave the text tidied as a side effect of not saving.
      if (model) applySaveCleanup(model);
      const content = model ? model.getValue() : tab.original;
      if (isUntitled(tab.path)) {
        const target = await pickSaveAs(tab.name);
        if (!target) return false;
        const saved = await api.saveFile(target, content, encodingRef.current, false);
        draft.forget(tab.path);
        const oldUri = h.monaco.Uri.parse(modelUri(tab.path));
        const oldModel = h.monaco.editor.getModel(oldUri);
        setTabs((prev) =>
          prev.map((t) =>
            t.id === tab.id
              ? {
                  ...t,
                  path: saved.path,
                  name: basename(saved.path),
                  language: langOf(saved.path),
                  original: content,
                  mtime: saved.mtime,
                  dirty: false,
                  encoding: saved.encoding,
                  bom: false,
                  bytes: saved.bytes,
                }
              : t
          )
        );
        setTimeout(() => oldModel?.dispose(), 0);
        onFileOpened?.(dirname(saved.path));
        // Recorded after the write. A file that has just been named has no earlier state to stand
        // on, so the text that went to disk is its first version rather than a second row.
        if (!tab.encrypted) {
          await versionsRef.current?.recordSave(saved.path, content, null, false, opts?.note);
        }
        if (!opts?.quiet) toast(t("menu.saved", { name: basename(saved.path) }));
        return true;
      }

      // Write back in the encoding this file was read in, or a GBK file would be
      // saved as UTF-8 and read as garbage by every other Windows tool.
      const saved = await api.saveFile(tab.path, content, tab.encoding, tab.bom);
      draft.forget(tab.path);
      await api.clearDraft(tab.path);
      setTabs((prev) =>
        prev.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                original: content,
                mtime: saved.mtime,
                dirty: false,
                encoding: saved.encoding,
                bom: t.bom,
                bytes: saved.bytes,
              }
            : t
        )
      );
      // Whether this save is worth a version is the backend's call, and it is told who made the
      // write: `quiet` is the automatic save's mark, and recording those is its own switch, off by
      // default — a timer that runs while nobody is at the keyboard would otherwise fill the
      // timeline with half-typed lines. The check here only skips the call for a setting that is
      // off; the same switch is applied again in `add_version`, so a stale value can skip a
      // recording but never invent one.
      //
      // An encrypted file is left out of versioning entirely. A version is the text as it was, kept
      // in the app's data folder, and storing that in the clear beside a document the user chose to
      // encrypt undoes the encryption — drafts are sealed with the file's own key for exactly this
      // reason, and a version history has no key at write time to seal itself with.
      //
      // From the tab as it was before this save: `tab.original` is the text the file held when it
      // was opened, and `setTabs` above has just replaced it. Getting the baseline after that would
      // record the new text twice and leave no row for the file as it was found.
      const automatic = !!opts?.quiet;
      if (!tab.encrypted && (!automatic || autoSaveVersionsRef.current)) {
        await versionsRef.current?.recordSave(
          tab.path,
          content,
          { content: tab.original, mtimeMs: tab.mtime },
          automatic,
          opts?.note
        );
      }
      // A save writes the file back into existence, so a prompt saying it is gone would be
      // answering a question that stopped being true — and keeping it would then park a
      // second copy of text that already has a home.
      setGone((q) => q.filter((a) => a.tabId !== tab.id));
      if (!opts?.quiet) toast(t("menu.saved", { name: tab.name }));
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    }
  }, [applySaveCleanup, askForTab, draft, editorRef, onFileOpened, toast]);

  /**
   * The automatic save. Reached through a ref because `saveTab` is rebuilt whenever an unrelated
   * callback is, and a timer that restarts on every render would never fire.
   */
  const saveTabRef = useRef(saveTab);
  saveTabRef.current = saveTab;
  const autoSaveRef = useRef(autoSave);
  autoSaveRef.current = autoSave ?? autoSaveRef.current;
  /** One pending write per tab, keyed by its id. */
  const autoSaveTimers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  /** Why this tab must not be written by the timer, or `false` when it may. */
  const autoSaveBlocked = useCallback(
    (tab: Tab): boolean => {
      // A picture has no buffer, a lock has no key, and an untitled buffer has no file: the first
      // two cannot be written and the third would have to be asked for a name.
      if (!isFileTab(tab) || !tab.dirty || tab.isBinary || tab.locked || isUntitled(tab.path))
        return true;
      // A file another program has changed, or one that is gone from the disk, already has a
      // question in front of the user. Answering it by writing is their call, not a timer's — and
      // raising that question from the background would put a dialog over a file nobody is touching.
      if (staleRef.current.some((ask) => ask.tabId === tab.id)) return true;
      return goneRef.current.some((ask) => ask.tabId === tab.id);
    },
    []
  );

  /**
   * Restart one tab's quiet countdown, and write it when that countdown is allowed to finish.
   *
   * In a ref like `saveTabRef`: the keystroke handler and the retry below both need the current
   * closure, and neither of them can afford to become a dependency of the other.
   */
  const autoSaveArm = useRef<(id: number) => void>(() => {});
  autoSaveArm.current = (id: number) => {
    const setting = autoSaveRef.current;
    if (!setting?.enabled) return;
    const prior = autoSaveTimers.current.get(id);
    if (prior) window.clearTimeout(prior);
    const timer = window.setTimeout(() => {
      autoSaveTimers.current.delete(id);
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || autoSaveBlocked(tab)) return;
      void saveTabRef.current(id, { quiet: true }).then((saved) => {
        if (saved) return;
        // A write that did not happen leaves the tab dirty, so try again after another pause —
        // while it is still the tab being edited, and unless the reason it failed is a question the
        // user has to answer, which retrying cannot solve and would only bring back every few
        // seconds. A tab that has since lost focus waits for it to be selected again: the countdown
        // belongs to the file in front of somebody, not to everything with pending edits.
        const after = tabsRef.current.find((t) => t.id === id);
        if (after?.dirty && activeRef.current === id && !autoSaveBlocked(after))
          autoSaveArm.current(id);
      });
    }, Math.max(1, setting.intervalSec) * 1000);
    autoSaveTimers.current.set(id, timer);
  };

  /**
   * Start the automatic save for the tab on screen.
   *
   * Only that tab: a countdown is a promise about the file somebody is editing, and a background
   * tab's unsaved text is already held by its draft, which survives a quit. The one exception is
   * that a countdown already running is left to finish when its tab loses focus — the write it
   * promised is for text that stopped changing N seconds ago, and dropping it on the floor because
   * the user moved on would mean the pause they made did not save anything after all. No new round
   * starts for a tab that is not in front.
   *
   * Watching the tab list and the selection rather than only keystrokes is what arms a tab made
   * dirty by something else — a draft restored at startup, a version put back — as soon as it is
   * looked at.
   */
  useEffect(() => {
    if (!autoSave?.enabled) {
      autoSaveTimers.current.forEach((timer) => window.clearTimeout(timer));
      autoSaveTimers.current.clear();
      return;
    }
    for (const tab of tabs) {
      const pending = autoSaveTimers.current.get(tab.id);
      if (autoSaveBlocked(tab)) {
        if (pending) {
          window.clearTimeout(pending);
          autoSaveTimers.current.delete(tab.id);
        }
        continue;
      }
      if (!pending && tab.id === activeId) autoSaveArm.current(tab.id);
    }
  }, [activeId, autoSave?.enabled, autoSave?.intervalSec, autoSaveBlocked, gone, stale, tabs]);

  const saveActive = useCallback(
    () => (activeRef.current === null ? Promise.resolve(false) : saveTab(activeRef.current)),
    [saveTab]
  );

  /**
   * Replace what a tab holds with what is on disk right now.
   *
   * This is the answer to "the file changed while I was in it", so it re-reads the file and
   * makes the tab agree with it: the baseline (`original`) moves to the new text, the model
   * is overwritten and the tab stops being dirty. Everything that belonged to the buffer being
   * replaced goes with it — the undo stack, as a side effect of `setValue`, and the draft,
   * which would otherwise offer the discarded edits back the next time this file opens.
   *
   * The model is rewritten synchronously, before React can re-render the patched tab, which is
   * why the whole buffer swap runs inside `mutating` (see its declaration). The draft is
   * cleared only after that flag is down: an `await` with the flag still set would swallow
   * whatever the user typed in the meantime.
   */
  const reloadTab = useCallback(
    async (id: number) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      // A comparison has no buffer of its own, and a scratch buffer has nothing on disk to
      // read: both would silently do nothing here.
      if (!tab || !isFileTab(tab) || isUntitled(tab.path)) return;
      // Reading an encrypted file needs a key this session no longer has, and the read comes
      // back empty rather than failing. That empty text would then be poured over whatever is
      // on screen — including plaintext the user was legitimately given before an idle lock,
      // which is still there on purpose — with `setValue` taking the undo stack that could
      // have brought it back. Ask for the password and leave the buffer exactly as it is; the
      // reload is not performed, because deciding to throw a buffer away is a separate
      // question and has to be asked about the text, not about a lock.
      if (tab.locked) {
        askForTab(tab.id, { kind: "none" });
        return;
      }
      let disk;
      try {
        // `record: false`: a reload is not a new open, so it must not touch the history.
        disk = await api.openFile(tab.path, false, encodingRef.current);
      } catch (e) {
        // Most often the file was moved or deleted underneath the tab.
        toast(errorMessage(e));
        return;
      }
      // The file can become locked between the check above and this read — re-encrypted
      // elsewhere under a password this session does not have — and the answer is empty for
      // exactly the reason the check exists.
      if (disk.locked) {
        askForTab(tab.id, { kind: "none" });
        return;
      }
      const key = pathKey(tab.path);
      const h = editorRef.current;
      const model = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
      // Taken before the buffer is replaced: `setValue` parks the caret at the very start,
      // and afterwards the old offset is no longer recoverable from the editor. Only the
      // editor's own offset means this tab — for a background tab it is another file's, and a
      // tab nobody has visited has no caret to keep, so it starts at the top like a new open.
      const caret =
        cursors.current.get(key) ?? (activeRef.current === id ? currentOffset() : 0);
      const patch = (t: Tab): Tab =>
        t.id !== id
          ? t
          : {
              ...t,
              original: disk.content,
              mtime: disk.mtime,
              dirty: false,
              // The file may have been rewritten as something else entirely since it was
              // opened, so what it is now is read from the same response as its text.
              isBinary: disk.binary,
              encoding: disk.encoding,
              bom: disk.bom,
              bytes: disk.bytes,
              // The file may have been put under encryption, or had it taken off, since the
              // tab was built; both are answered by the same read that brought the text.
              encrypted: disk.encrypted,
              locked: false,
            };

      mutating.current = true;
      try {
        setTabs((prev) => prev.map(patch));
        // A tab that has never been shown has no model yet: Editor builds it from the new
        // `original` the first time the tab is displayed, so there is nothing to push here.
        if (model && model.getValue() !== disk.content) model.setValue(disk.content);
        // The new text can be shorter than the offset the caret was left at, so it is
        // clamped rather than trusted, and the remembered offset is corrected with it.
        const offset = Math.min(caret, model?.getValueLength() ?? disk.content.length);
        cursors.current.set(key, offset);
        // Whatever caret this tab was restored with belonged to the text just replaced.
        pendingCursors.current.delete(key);
        if (h && model && activeRef.current === id) {
          const position = model.getPositionAt(offset);
          h.editor.setPosition(position);
          h.editor.revealPositionInCenterIfOutsideViewport(position);
        }
      } finally {
        mutating.current = false;
      }
      // The editor keeps this one mounted behind the Settings panel, so it has to be
      // re-derived from the patched tab rather than left holding the old baseline.
      const last = lastFileTabRef.current;
      if (last && last.id === id) lastFileTabRef.current = patch(last);
      // `forget` drops the debounced write of the text that is on its way out; without it
      // that write would land after the clear below and resurrect what was discarded.
      draft.forget(tab.path);
      await api.clearDraft(tab.path).catch((e) => toast(errorMessage(e)));
      // The tab now agrees with disk, so any prompt about this file is answered by definition.
      setStale((q) => q.filter((a) => a.tabId !== id));
      // The reload just re-read the file, so any password question about it is answered by
      // definition — leaving one up would ask for a key that is already in the cache.
      setPasswordAsk((q) => q.filter((a) => a.tabId !== id));
      toast(t("menu.reloaded", { name: tab.name }));
    },
    [askForTab, currentOffset, draft, editorRef, toast]
  );

  /**
   * Put the text a password just bought into the tab that was waiting for it.
   *
   * Only a tab that never had any text is written into. One that was read before it was
   * locked still holds that document, possibly with edits on top of it, and replacing the
   * buffer would destroy the work the lock exists to protect — so there the flags are the
   * only thing that changes.
   *
   * `tabsRef` is written as well as the state, which the rest of this file leaves to the
   * render that follows. Here it cannot: `submitPassword` goes straight on to retry a save
   * that was refused, and a save reading the pre-unlock tab would see it still locked and
   * ask for the same password again.
   */
  const applyUnlocked = useCallback(
    (tabId: number, opened: OpenedFile) => {
      const tab = tabsRef.current.find((t) => t.id === tabId);
      if (!tab) return;
      const blank = isLockedBlank(tab);
      const patch = (t: Tab): Tab =>
        t.id !== tabId
          ? t
          : {
              ...t,
              original: blank ? opened.content : t.original,
              dirty: blank ? false : t.dirty,
              mtime: opened.mtime,
              encoding: opened.encoding,
              bom: opened.bom,
              bytes: opened.bytes,
              encrypted: true,
              locked: false,
            };
      const next = tabsRef.current.map(patch);
      tabsRef.current = next;
      setTabs(next);
      // The editor keeps the last file tab mounted behind other views, so it has to be
      // re-derived from the patched tab rather than left holding the locked one.
      const last = lastFileTabRef.current;
      if (last && last.id === tabId) lastFileTabRef.current = patch(last);
      if (!blank) return;
      const h = editorRef.current;
      const model = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
      if (!h || !model || model.getValue() === opened.content) return;
      // Under `mutating` for the same reason a reload is: the change event this fires is
      // read against a tab object React has not re-rendered yet, and would otherwise mark
      // the freshly unlocked file dirty and schedule a draft for it.
      mutating.current = true;
      try {
        model.setValue(opened.content);
      } finally {
        mutating.current = false;
      }
    },
    [editorRef]
  );

  /**
   * Take a file that was rewritten in place — a new password, or the encryption taken off — and
   * make the tab agree with what is now on disk.
   *
   * The text does not change, so neither does the baseline or the dirty flag: the buffer is the
   * same document it was, and calling it clean or dirty here would be a claim about edits nobody
   * made. What does change is everything a later save compares against, because both rewrites
   * replace the file: its size, its stamp, and which of the two forms it is in.
   */
  const applyRewritten = useCallback(
    (tabId: number | null, saved: SavedFile, stillEncrypted: boolean) => {
      if (tabId === null) return;
      const patch = (prev: Tab): Tab =>
        prev.id !== tabId
          ? prev
          : {
              ...prev,
              mtime: saved.mtime,
              bytes: saved.bytes,
              encoding: saved.encoding,
              encrypted: stillEncrypted,
              // Whichever way it went, the password just typed is the one that opens the file,
              // so nothing here is locked.
              locked: false,
            };
      const next = tabsRef.current.map(patch);
      tabsRef.current = next;
      setTabs(next);
      const last = lastFileTabRef.current;
      if (last && last.id === tabId) lastFileTabRef.current = patch(last);
    },
    []
  );

  /**
   * Move a tab onto a file that was just written for it, which is what an encrypted save-as
   * ends with.
   *
   * The tab follows the file it now holds, the way an untitled buffer follows the path its first
   * save picked. The file the tab came from is left exactly as it was on disk — what moves is
   * the tab, not the bytes.
   */
  const finishCreated = useCallback(
    async (tabId: number, from: string, saved: SavedFile, content: string) => {
      const h = editorRef.current;
      const oldModel = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(from)));
      // The text has a home now, so no draft should offer it back: not the old path's, which no
      // longer holds these edits, and not the new one's, which holds them properly.
      draft.forget(from);
      await api.clearDraft(from).catch(() => {});
      await api.clearDraft(saved.path).catch(() => {});
      const patch = (prev: Tab): Tab =>
        prev.id !== tabId
          ? prev
          : {
              ...prev,
              path: saved.path,
              name: basename(saved.path),
              language: langOf(saved.path),
              original: content,
              // Cleared rather than carried over: a restored tab keeps its text here, and the
              // editor reads this field first when it builds the model for the new path, so
              // leaving it would show the pre-save text over the file just written.
              initialValue: undefined,
              mtime: saved.mtime,
              dirty: false,
              encoding: saved.encoding,
              bom: false,
              bytes: saved.bytes,
              encrypted: true,
              locked: false,
            };
      const next = tabsRef.current.map(patch);
      tabsRef.current = next;
      setTabs(next);
      const last = lastFileTabRef.current;
      if (last && last.id === tabId) lastFileTabRef.current = patch(last);
      // Nothing in the old model is unsaved any more, and keeping it would keep the undo stack
      // of a document this tab no longer shows.
      setTimeout(() => oldModel?.dispose(), 0);
      onFileOpened?.(dirname(saved.path));
      toast(t("enc.encrypted", { name: basename(saved.path) }));
    },
    [draft, editorRef, onFileOpened, toast]
  );

  /**
   * Take the password the dialog collected and try it.
   *
   * A failure leaves the ask at the head of the queue: a wrong password is a reason to type
   * it again, not a reason to give up on the file. On success the question leaves the queue
   * and whatever asked it is carried out, which is what makes an unlock reached from a save
   * behave like the save the user pressed.
   *
   * The three asks that *invent* a password never reach the unlock call: there is no key to
   * check one against, and each of them writes a file of its own.
   */
  const submitPassword = useCallback(
    async (password: string, remember: boolean, previous?: string) => {
      const ask = passwordRef.current[0];
      if (!ask || passwordBusy) return;
      setPasswordBusy(true);
      setPasswordError(null);
      try {
        if (ask.then.kind === "create") {
          const { target, content } = ask.then;
          const saved = await api.saveFileAsEncrypted(target, content, password);
          if (remember) {
            // After the write, never instead of as part of it: the file exists either way, and
            // a credential store that refuses is one toast rather than a failed save.
            await api
              .rememberPassword(saved.path, password)
              .catch((e) => toast(errorMessage(e)));
          }
          setPasswordAsk((q) => q.slice(1));
          if (ask.tabId !== null) await finishCreated(ask.tabId, ask.path, saved, content);
          return;
        }
        if (ask.then.kind === "newFile") {
          const made = await api.createEncrypted(ask.then.parent, ask.then.name, password);
          // Settled before the ask leaves the queue, so the waiter hears "created" rather than
          // the queue-empty effect hearing "gone".
          settleAsk(ask.id, true);
          if (remember) {
            await api
              .rememberPassword(made.path, password)
              .catch((e) => toast(errorMessage(e)));
          }
          setPasswordAsk((q) => q.slice(1));
          toast(t("side.created", { name: made.name }));
          // Opened through the normal path rather than built here: the key is cached by the
          // create, so this reads the container back as an ordinary unlocked encrypted file,
          // and every half of an open that is not about the text still happens.
          await openPath(made.path);
          return;
        }
        if (ask.then.kind === "change") {
          const saved = await api.changePassword(ask.path, previous ?? "", password);
          setPasswordAsk((q) => q.slice(1));
          applyRewritten(ask.tabId, saved, true);
          toast(t("enc.passwordChanged", { name: ask.name }));
          return;
        }
        if (ask.then.kind === "remove") {
          const saved = await api.removeEncryption(ask.path, password);
          setPasswordAsk((q) => q.slice(1));
          applyRewritten(ask.tabId, saved, false);
          toast(t("enc.encryptionRemoved", { name: ask.name }));
          return;
        }

        const opened = await api.unlockFile(ask.path, password);
        if (remember) {
          // After the unlock, never instead of as part of it: the file is open either way, and
          // a credential store that refuses is one toast rather than a failed unlock.
          await api.rememberPassword(ask.path, password).catch((e) => toast(errorMessage(e)));
        }
        setPasswordAsk((q) => q.slice(1));
        // An ask with no tab came from the Explorer, which has no buffer to put the text in;
        // opening the file is that caller's next step, not this one's.
        if (ask.tabId === null) return;
        applyUnlocked(ask.tabId, opened);
        if (ask.then.kind !== "save") toast(t("enc.unlocked", { name: ask.name }));
        if (ask.then.kind === "open") {
          await finishOpen(opened, ask.tabId);
        } else if (ask.then.kind === "save") {
          await saveTab(ask.tabId, { overwrite: ask.then.overwrite });
        }
      } catch (e) {
        setPasswordError(errorMessage(e));
      } finally {
        setPasswordBusy(false);
      }
    },
    [
      applyRewritten,
      applyUnlocked,
      finishCreated,
      finishOpen,
      openPath,
      passwordBusy,
      saveTab,
      settleAsk,
      toast,
    ]
  );

  /** Leave a file locked. The tab keeps its lock, and nothing about the buffer changes. */
  const cancelPassword = useCallback(() => {
    setPasswordAsk((q) => q.slice(1));
    setPasswordError(null);
  }, []);

  /** Ask again for a tab the user clicked on, which is how the lock overlay is answered. */
  const unlockTab = useCallback(
    (id: number) => askForTab(id, { kind: "none" }),
    [askForTab]
  );

  /**
   * Write a tab's text out as a new encrypted file, chosen first and passworded second.
   *
   * The path is picked before the password is asked for, because the dialog is where the flow
   * ends: asking first would mean holding a password in state while a file dialog is open, which
   * is exactly the thing the dialog exists to avoid. The text travels with the ask for the same
   * reason — the modal cannot be typed into while it is up, so the snapshot is still the buffer.
   *
   * Available for an unsaved buffer as well as a file: encrypting text that has no home yet is
   * the moment a password is most worth asking for.
   */
  const saveAsEncrypted = useCallback(
    async (id: number) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || !isFileTab(tab) || tab.isBinary) return;
      const content = liveContent(tab) ?? tab.initialValue ?? tab.original;
      const target = await pickSaveAs(tab.name);
      if (!target) return;
      askPassword(id, target, { kind: "create", target, content });
    },
    [askPassword, liveContent]
  );

  /** Ask for a new password for a file that already has one. */
  const changeEncryptedPassword = useCallback(
    (id: number) => askForTab(id, { kind: "change" }),
    [askForTab]
  );

  /**
   * Ask for the password of an encrypted file in order to take the encryption off it.
   *
   * The password is verified rather than taken from the session cache, so this works on a locked
   * tab too — and it is the one way to get out of a file whose key has been dropped without
   * first unlocking it.
   */
  const removeEncryptionFrom = useCallback(
    (id: number) => askForTab(id, { kind: "remove" }),
    [askForTab]
  );

  /**
   * Create an empty encrypted file in the Explorer's tree.
   *
   * The ask carries no tab, because there is no file yet and so nothing to show; the tab is
   * opened once the write has succeeded. The path here is a key and a title rather than a
   * promise — the backend still validates the name, supplies the extension and refuses a name
   * that is taken, and what it made is what gets opened.
   *
   * Resolves once the password question has been answered, true only when the container is on
   * disk. The tree re-reads from that answer rather than from the click, and a question that
   * was cancelled, replaced or dropped resolves false so the name being typed is not lost.
   */
  const createEncryptedIn = useCallback(
    (parent: string, name: string): Promise<boolean> => {
      const shown = `${parent.replace(/[\\/]+$/, "")}\\${name}`;
      const id = askPassword(null, shown, { kind: "newFile", parent, name });
      if (id === null) return Promise.resolve(false);
      return new Promise<boolean>((resolve) => {
        askWaiters.current.set(id, resolve);
      });
    },
    [askPassword]
  );

  /**
   * Mark every encrypted tab locked, which is what the idle lock does once the keys are gone.
   *
   * The text stays on screen. It was decrypted with a password the user typed, and what the
   * lock means is that nothing more can be written or drafted from here — taking the document
   * off the screen as well would punish having read it, and the plaintext is in the model for
   * as long as the window is open either way.
   */
  const lockEncrypted = useCallback(() => {
    if (!tabsRef.current.some((t) => t.encrypted && !t.locked)) return;
    const next = tabsRef.current.map((t) => (t.encrypted ? { ...t, locked: true } : t));
    tabsRef.current = next;
    setTabs(next);
    const last = lastFileTabRef.current;
    if (last && last.encrypted) lastFileTabRef.current = { ...last, locked: true };
    // A question nobody can answer any more: the key it would have produced is exactly what
    // was just dropped, so it is retired rather than left up to fail.
    setPasswordAsk([]);
    setPasswordError(null);
  }, []);

  /** Set while one sweep is running, so the timer and a focus change cannot interleave two. */
  const checking = useRef(false);

  /**
   * Ask the disk what every open file is now, and make the tabs agree with the answer.
   *
   * A tab whose text still equals its baseline has nothing to lose, so it quietly takes the new
   * text — that is the whole point of checking. A tab carrying unsaved edits cannot be answered
   * for by anybody but the user, so it joins the queue the prompt works through.
   *
   * A file that is simply not there any more is asked about too: the text left in the editor
   * is then the only copy of it, and whether to keep that is not a question this app can
   * answer on the user's behalf. A *failed* stat is deliberately still nothing at all: a
   * share that is not answering says nothing about the file, and reading it as "gone" would
   * drop a prompt on work that is perfectly safe.
   */
  const checkDisk = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const waiting = new Set(queueRef.current.map((r) => pathKey(r.path)));
      const asked = new Set([
        ...staleRef.current.map((a) => a.tabId),
        ...goneRef.current.map((a) => a.tabId),
      ]);
      for (const tab of tabsRef.current) {
        // A picture has no text in it: the "buffer" behind one is the empty stand-in for its
        // bytes, so there is nothing here to keep and the preview going blank is the whole
        // of what happened.
        if (!isFileTab(tab) || isUntitled(tab.path) || tab.mtime === undefined || tab.isBinary) {
          continue;
        }
        // A lock with no text behind it has nothing to compare and nothing to keep: every
        // question this sweep asks would be about a file the window cannot read.
        if (isLockedBlank(tab)) continue;
        // A tab with a draft prompt open is already being asked about, and one with a
        // conflict prompt open is waiting for an answer: reloading either would move the
        // text under a dialog that describes it.
        if (asked.has(tab.id) || waiting.has(pathKey(tab.path))) continue;
        let stat: FileStat | null;
        try {
          stat = await api.statFile(tab.path);
        } catch {
          continue;
        }
        if (stat === null) {
          // Deleted, moved, or renamed by something outside the app. The tab keeps holding
          // the text, so nothing is lost yet — but nothing can be saved back either.
          setGone((q) =>
            q.some((a) => a.tabId === tab.id) ? q : [...q, { tabId: tab.id, path: tab.path, name: tab.name }]
          );
          continue;
        }
        // A locked tab that does hold text: whether the file is still there is worth knowing,
        // but taking the new text is not possible, so the sweep stops at the answer above.
        if (tab.locked) continue;
        if (stat.mtime === tab.mtime && stat.bytes === tab.bytes) continue;
        // The same write, already answered. A later write is a different question.
        if (dismissed.current.get(pathKey(tab.path)) === stat.mtime) continue;
        // Everything above awaited, so the tab is looked up again: it may have been saved,
        // edited or closed in the meantime, and a reload decided on a stale picture of it
        // would throw away an undo stack for nothing.
        const now = tabsRef.current.find((t) => t.id === tab.id);
        if (!now || now.mtime !== tab.mtime) continue;
        if (now.dirty) {
          setStale((q) =>
            q.some((a) => a.tabId === now.id)
              ? q
              : [...q, { tabId: now.id, fromSave: false, mtime: stat.mtime }]
          );
          continue;
        }
        // Typing that landed while the stat was in flight makes the live text differ from the
        // baseline the dirty flag was built on. Same reason to stop as above: it is unsaved work.
        const live = liveContent(now);
        if (live !== undefined && live !== now.original) continue;
        await reloadTab(now.id);
      }
    } finally {
      checking.current = false;
    }
  }, [liveContent, reloadTab]);

  // `checkDisk` changes identity on every render, because the draft plumbing it reaches through
  // `reloadTab` is returned as a fresh object each time. Depending on it directly would restart
  // the timer on every keystroke, and a sweep would then only ever run in a pause long enough to
  // fit one in — which is the opposite of what it is for.
  const sweepRef = useRef(checkDisk);
  sweepRef.current = checkDisk;
  useEffect(() => {
    const timer = setInterval(() => void sweepRef.current(), DISK_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  /**
   * Close a conflict prompt. `mute` pins the mtime that raised it, so the periodic check stops
   * interrupting about the same write — that is what "look at the difference first" needs, and
   * it is not a resolution: a save still asks, because deciding to write is a separate answer.
   */
  const answerStale = useCallback((id: number, mute: boolean) => {
    if (mute) {
      const ask = staleRef.current.find((a) => a.tabId === id);
      const tab = tabsRef.current.find((t) => t.id === id);
      if (ask && tab) dismissed.current.set(pathKey(tab.path), ask.mtime);
    }
    setStale((q) => q.filter((a) => a.tabId !== id));
  }, []);

  /**
   * Write the text still in a deleted file's tab out as a file of its own, and point the tab
   * at it.
   *
   * The buffer is the only copy left, so this is what stops a quit or a closed tab from
   * being the end of it. The tab moves to the parked copy rather than keeping the dead path:
   * staying there would leave a file that cannot be saved, reopened or compared, and the
   * parked one is a real file that can be all three. Everything keyed by the old path comes
   * along, because `rekeyTabs` already knows how to move a tab with its buffer and its caret,
   * neither of which a fresh open would have.
   */
  const keepDeletedFile = useCallback(
    async (id: number): Promise<boolean> => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || !isFileTab(tab) || isUntitled(tab.path)) return false;
      const content = liveContent(tab) ?? tab.original;
      const saved = await api
        .keepFile(tab.path, content, tab.encoding, tab.bom)
        .catch((e) => {
          toast(errorMessage(e));
          return null;
        });
      if (!saved) return false;
      const oldPath = tab.path;
      rekeyTabs(oldPath, saved.path);
      // The baseline is what was written out, and the mtime is what the disk now says: with
      // both set, the next sweep sees a file that agrees with its tab instead of one that
      // has vanished.
      setTabs((prev) =>
        prev.map((t) =>
          t.id === id
            ? {
                ...t,
                original: content,
                dirty: false,
                mtime: saved.mtime,
                encoding: saved.encoding,
                bytes: saved.bytes,
              }
            : t
        )
      );
      // The draft described text this file no longer holds: the parked copy is that text
      // now, and a draft left behind would offer the same edits back a second time.
      draft.forget(oldPath);
      await api.clearDraft(oldPath).catch(() => {});
      toast(t("gone.kept", { name: basename(saved.path) }));
      return true;
    },
    [draft, liveContent, rekeyTabs, toast]
  );

  /**
   * Answer for a file that has gone: keep the text as a file of its own, or close the tab.
   *
   * A keep that failed leaves the question on the list. The text is still only in the
   * buffer, so quietly retiring the prompt would be the same as answering "close" — and
   * that is the one answer here that cannot be taken back.
   */
  const answerGone = useCallback(
    async (id: number, mode: "keep" | "close") => {
      if (mode === "keep") {
        if (await keepDeletedFile(id)) {
          setGone((q) => q.filter((a) => a.tabId !== id));
        }
        return;
      }
      setGone((q) => q.filter((a) => a.tabId !== id));
      await closeTab(id);
    },
    [closeTab, keepDeletedFile]
  );

  /**
   * Show what a conflict is: the text on disk against the text in the tab.
   *
   * The comparison is a popup held here rather than a tab, because the question it answers is
   * asked while the prompt is still up — and a tab would put the answer somewhere the user has
   * to leave the prompt to go and read. Built from the live model on one side, which is also why
   * it does not go through `openCompare`: reading both sides off disk would compare a file with
   * itself and show the user their own edits as the difference.
   */
  const showConflict = useCallback(
    async (id: number) => {
      const tab = tabsRef.current.find((t) => t.id === id);
      if (!tab || !isFileTab(tab) || isUntitled(tab.path)) return;
      let disk;
      try {
        // `record: false`: looking at a conflict is not opening the file.
        disk = await api.openFile(tab.path, false, encodingRef.current);
      } catch (e) {
        toast(errorMessage(e));
        return;
      }
      // The disk side of a conflict is read the same way, so a file the session lost the key
      // for has nothing to show against the buffer.
      if (disk.locked) {
        toast(errorMessage("encrypted_locked"));
        return;
      }
      const name = basename(tab.path);
      const language = langOf(disk.path);
      setConflict({
        tabId: id,
        pair: {
          left: {
            path: disk.path,
            name: t("stale.diskSide", { name }),
            content: disk.content,
            language,
            kind: "disk",
          },
          right: {
            path: disk.path,
            name: t("stale.mineSide", { name }),
            content: liveContent(tab) ?? tab.original,
            language,
            kind: "buffer",
          },
        },
      });
    },
    [liveContent, toast]
  );

  const hideConflict = useCallback(() => setConflict(null), []);

  const resolveRestore = useCallback(
    async (mode: "restore" | "discard") => {
      const req = queueRef.current[0];
      setRestoreQueue((q) => q.slice(1));
      if (!req) return;
      await applyRestore(req, mode);
    },
    [applyRestore]
  );

  /** Batch answer for a restored session that brought back several drafts at once. */
  const resolveAllRestores = useCallback(
    async (mode: "restore" | "discard") => {
      const queue = queueRef.current;
      setRestoreQueue([]);
      for (const req of queue) await applyRestore(req, mode);
    },
    [applyRestore]
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  // A comparison tab has no buffer of its own, so it must not become the fallback the
  // editor keeps showing behind the Settings tab.
  if (activeTab && isFileTab(activeTab)) lastFileTabRef.current = activeTab;

  return {
    tabs,
    activeId,
    activeTab,
    cursorRev,
    /** Where Editor takes path/defaultValue: keeps the last file tab while Settings shows. */
    editorTab:
      activeTab && !activeTab.isSettings && !activeTab.gallery
        ? activeTab
        : lastFileTabRef.current,
    /**
     * The last real file tab. Editor must stay mounted on this one even while a
     * comparison is on screen: @monaco-editor/react disposes a model when its editor
     * unmounts, and that model is the only place a file's unsaved edits and undo stack
     * live. So a comparison is shown *beside* the hidden editor, never in place of it.
     */
    fileTab: lastFileTabRef.current,
    restoreQueue,
    /** Conflict prompts, one at a time, in the order the files were found changed. */
    stale,
    /** Files found to be gone from the disk, one prompt at a time. */
    gone,
    answerGone,
    /** Encrypted files waiting for a password, one dialog at a time. */
    passwordAsk,
    /** Which dialog the head of that queue needs. */
    passwordMode: passwordModeOf(passwordAsk[0]?.then),
    /** Why the password at the head of that queue last failed, or null. */
    passwordError,
    passwordBusy,
    submitPassword,
    cancelPassword,
    /** Ask again for a tab that is already open and locked. */
    unlockTab,
    /** Pick a path, then ask for the password the copy of this buffer will be written under. */
    saveAsEncrypted,
    /** Ask for a new password for a file that already has one. */
    changeEncryptedPassword,
    /** Ask for the password in order to write the file back as plain UTF-8. */
    removeEncryptionFrom,
    /** Ask for the password of an encrypted file the Explorer is about to create. */
    createEncryptedIn,
    /** Mark every encrypted tab locked; the caller has already dropped the keys. */
    lockEncrypted,
    /** The conflict comparison popup, while it is open. */
    conflict,
    showConflict,
    hideConflict,
    checkDisk,
    answerStale,
    openPath,
    openCompare,
    /** A comparison from two sides whose text the caller already holds (git means this). */
    openSnapshotCompare: showCompare,
    /** The text a tab holds now, for a caller that only has its id. */
    tabText,
    swapCompare,
    openUntitled,
    openSettings,
    openGallery,
    closeTab,
    moveTab,
    clearAllTabs,
    rekeyTabs,
    /** Re-home every tab after a batch of renames, as one simultaneous substitution. */
    rekeyTabsMany,
    selectTab: activate,
    saveActive,
    saveTab,
    reloadTab,
    onEditorChange,
    onCursorChange,
    setFileSettings,
    resolveRestore,
    /** Put a version's text into the editor, unsaved. */
    restoreVersion,
    resolveAllRestores,
    snapshotTabs,
    restoreTabs,
    applyPendingCursor,
  };
}
