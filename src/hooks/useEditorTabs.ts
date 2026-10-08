import { useCallback, useRef, useState, type RefObject } from "react";
import { t } from "../lib/i18n";
import { api, errorMessage, pickSaveAs, EMPTY_FILE_SETTINGS, type Draft, type FileSettings, type GroupTab } from "../lib/tauri";
import { basename, dirname, isUntitled, langOf, modelUri, rekeyPath } from "../lib/path";
import { tabKey, toStoredTab } from "../lib/group";
import { pathKey, isFileTab, type CompareSide, type EditorHandle, type PendingRestore, type Tab } from "../lib/types";
import type { DraftWriter } from "./useDraft";

interface RestoreResult {
  restored: number;
  skipped: number;
}

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
}

export function useEditorTabs({ toast, draft, editorRef, onFileOpened, encodingPref }: Options) {
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
        await activate(opened.id);
      } else {
        target = {
          id: nextId(),
          path: disk.path,
          name: basename(disk.path),
          language: langOf(disk.path),
          original: disk.content,
          dirty: false,
          // A picture arrives with no text, and the preview is the only view of it that
          // means anything. Marking it here is what keeps the editor out of the way.
          isBinary: disk.binary,
          encoding: disk.encoding,
          bom: disk.bom,
          bytes: disk.bytes,
          fileSettings: EMPTY_FILE_SETTINGS,
        };
        setTabs((prev) => [...prev, target]);
        await activate(target.id);
      }

      let draftInfo: Draft | null;
      try {
        draftInfo = await api.getDraft(disk.path);
      } catch (e) {
        toast(errorMessage(e));
        return false;
      }
      // Per-file overrides are needed before the first paint, not lazily: word wrap and
      // whitespace rendering are read while the model is being attached.
      try {
        const overrides = await api.fileSettingsView(disk.path);
        setTabs((prev) =>
          prev.map((t) => (t.id === target.id ? { ...t, fileSettings: overrides.overrides } : t))
        );
      } catch {
        // A missing override file is a normal first run; keep the global defaults.
      }
      // A document can show its own pictures, so allow the asset protocol to read the one
      // folder it sits in. Fire-and-forget: a document without images works either way.
      void api.allowAssetDir(dirname(disk.path)).catch(() => {});
      if (draftInfo && draftInfo.content !== disk.content) {
        // One prompt per file: a tab can be reached twice during startup (context menu
        // handover plus session restore) and the answer must not be asked twice.
        setRestoreQueue((q) =>
          q.some((item) => pathKey(item.path) === pathKey(target.path))
            ? q
            : [
                ...q,
                { tabId: target.id, path: target.path, name: target.name, draft: draftInfo },
              ]
        );
      } else if (draftInfo) {
        // Draft matches what is on disk: redundant, so drop it.
        await api.clearDraft(disk.path).catch((e) => toast(errorMessage(e)));
      }
      return true;
    },
    [activate, onFileOpened, toast]
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
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [toast]
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
  }, [activate]);

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
   * Open a read-only comparison of two files as its own tab.
   *
   * Both sides are read from disk here and kept in the tab, rather than pointed at the
   * live models of the two file tabs: a comparison is a snapshot of a question, and
   * sharing models would make a diff follow every keystroke in either file while dragging
   * drafts and dirty flags along. The pair is also not part of the group store, so it
   * never comes back on the next start.
   */
  const openCompare = useCallback(
    async (leftPath: string, rightPath: string) => {
      if (pathKey(leftPath) === pathKey(rightPath)) {
        toast(t("cmp.same"));
        return;
      }
      const side = async (path: string): Promise<CompareSide> => {
        const disk = await api.openFile(path, false, encodingRef.current);
        return {
          path: disk.path,
          name: basename(disk.path),
          content: disk.content,
          language: langOf(disk.path),
        };
      };
      let left: CompareSide;
      let right: CompareSide;
      try {
        [left, right] = await Promise.all([side(leftPath), side(rightPath)]);
      } catch (e) {
        toast(errorMessage(e));
        return;
      }
      // Same pair in the same order is the same question: show that tab instead of
      // stacking duplicates. Mirrors openPath, which reuses an already-open file.
      const existing = tabsRef.current.find(
        (t) =>
          !!t.compare &&
          pathKey(t.compare.left.path) === pathKey(left.path) &&
          pathKey(t.compare.right.path) === pathKey(right.path)
      );
      if (existing) {
        await activate(existing.id);
        return;
      }
      const tab: Tab = {
        id: nextId(),
        // Not a real path, and never treated as one: it is only a key for React and for
        // telling this tab apart from a file. `isFileTab` keeps it out of every path lookup.
        path: `compare://${left.path}|${right.path}`,
        name: `${left.name} ↔ ${right.name}`,
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
          name: `${right.name} ↔ ${left.name}`,
          language: left.language,
        };
      })
    );
  }, []);

  /**
   * Re-home every tab whose file moved on disk, with the Monaco model, the remembered caret
   * and the queued draft prompt that belong to it.
   *
   * The models are re-pointed rather than rebuilt: their buffers are the only place a file's
   * unsaved text and undo stack live. Everything here runs in one synchronous block, so no
   * render can ever show a tab whose model is still under the old path. Pending drafts must
   * already be flushed by the caller, or they would be written back under the old key.
   */
  const rekeyTabs = useCallback((oldRoot: string, newRoot: string) => {
    const moved = new Map<string, string>();
    for (const tab of tabsRef.current) {
      if (!isFileTab(tab) || isUntitled(tab.path)) continue;
      const next = rekeyPath(tab.path, oldRoot, newRoot);
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
        model?.updateUri(h.monaco.Uri.parse(modelUri(next)));
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
                dirty: false,
                isBinary: disk.binary,
                encoding: disk.encoding,
                bom: disk.bom,
                bytes: disk.bytes,
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

      // Drafts and overrides are independent per file, so fetch them together.
      const extras = await Promise.all(
        tabsBuilt.map(async (tab) => {
          if (!isFileTab(tab)) {
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
      // Merge overrides in one update, then surface any draft prompts.
      setTabs((prev) => prev.map((t) => {
        const ov = overrideMap.get(t.id);
        return ov ? { ...t, fileSettings: ov } : t;
      }));
      if (queued.length > 0) setRestoreQueue((q) => [...q, ...queued]);

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
          h.monaco.editor.createModel(tab.original, tab.language, uri);
        }
      };
      requestAnimationFrame(prime);

      return { restored: tabsBuilt.length, skipped };
    },
    []
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
    lastFileTabRef.current = null;
    setTabs([]);
    setActiveId(null);
  }, [editorRef]);

  const onEditorChange = useCallback(
    (value: string) => {
      const tab = tabsRef.current.find((t) => t.id === activeRef.current);
      if (!tab || !isFileTab(tab)) return;
      const dirty = value !== tab.original;
      if (dirty !== tab.dirty) {
        setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, dirty } : t)));
      }
      if (isUntitled(tab.path)) return;
      draft.schedule(tab.path, { content: value, cursor: currentOffset(), original: tab.original });
    },
    [currentOffset, draft]
  );

  /** Keep the stored cursor honest: edits and content changes can both land before a move. */
  const onCursorChange = useCallback(
    (offset: number) => {
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
   * Write one tab back to disk. Resolves false when nothing was written, which is what a
   * declined "Save as", a picture with no buffer, and a failed write all amount to: the
   * caller has to know, because a close that was asked to save must not go ahead without it.
   */
  const saveTab = useCallback(async (id: number): Promise<boolean> => {
    const tab = tabsRef.current.find((t) => t.id === id);
    const h = editorRef.current;
    // A picture has no buffer to write. Saving one would write the empty text that stands
    // in for it and destroy the file, so this is refused rather than merely discouraged.
    if (!tab || !isFileTab(tab) || tab.isBinary || !h) return false;
    // The editor only ever holds the active tab's text; another tab's live text is in its
    // model. Reading the wrong one would save the file the user is looking at instead.
    const content =
      id === activeRef.current
        ? h.editor.getValue()
        : (h.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)))?.getValue() ??
          tab.original);
    try {
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
        toast(t("menu.saved", { name: basename(saved.path) }));
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
                dirty: false,
                encoding: saved.encoding,
                bom: t.bom,
                bytes: saved.bytes,
              }
            : t
        )
      );
      toast(t("menu.saved", { name: tab.name }));
      return true;
    } catch (e) {
      toast(errorMessage(e));
      return false;
    }
  }, [draft, editorRef, onFileOpened, toast]);

  const saveActive = useCallback(
    () => (activeRef.current === null ? Promise.resolve(false) : saveTab(activeRef.current)),
    [saveTab]
  );

  /** Resolve one queued draft. Loops use it so "Restore all" is not a second implementation. */
  const applyRestore = useCallback(
    async (req: PendingRestore, mode: "restore" | "discard") => {
      const h = editorRef.current;
      const model = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(req.path)));
      if (!h || !model) return;
      const key = pathKey(req.path);

      if (mode === "discard") {
        try {
          await api.clearDraft(req.path);
          toast(t("menu.draftDiscarded"));
        } catch (e) {
          toast(errorMessage(e));
        }
        return;
      }

      // A picture is never restored into: the "buffer" here is the empty stand-in, and
      // writing text over an image would destroy it.
      if (tabsRef.current.find((t) => t.id === req.tabId)?.isBinary) {
        await api.clearDraft(req.path).catch((e) => toast(errorMessage(e)));
        return;
      }

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
      toast(t("menu.draftRestored"));
    },
    [editorRef, toast]
  );

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
      activeTab && !activeTab.isSettings ? activeTab : lastFileTabRef.current,
    /**
     * The last real file tab. Editor must stay mounted on this one even while a
     * comparison is on screen: @monaco-editor/react disposes a model when its editor
     * unmounts, and that model is the only place a file's unsaved edits and undo stack
     * live. So a comparison is shown *beside* the hidden editor, never in place of it.
     */
    fileTab: lastFileTabRef.current,
    restoreQueue,
    openPath,
    openCompare,
    swapCompare,
    openUntitled,
    openSettings,
    closeTab,
    moveTab,
    clearAllTabs,
    rekeyTabs,
    selectTab: activate,
    saveActive,
    saveTab,
    onEditorChange,
    onCursorChange,
    setFileSettings,
    resolveRestore,
    resolveAllRestores,
    snapshotTabs,
    restoreTabs,
    applyPendingCursor,
  };
}
