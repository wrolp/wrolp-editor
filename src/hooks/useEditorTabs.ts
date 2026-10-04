import { useCallback, useRef, useState, type RefObject } from "react";
import { t } from "../lib/i18n";
import { api, errorMessage, pickSaveAs, type Draft, type WorkspaceTab } from "../lib/tauri";
import { basename, dirname, isUntitled, langOf, modelUri } from "../lib/path";
import { tabKey, toStoredTab } from "../lib/workspace";
import { pathKey, type EditorHandle, type PendingRestore, type Tab } from "../lib/types";
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
}

export function useEditorTabs({ toast, draft, editorRef, onFileOpened }: Options) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [restoreQueue, setRestoreQueue] = useState<PendingRestore[]>([]);
  /**
   * Bumped on every caret move. The tab list alone says nothing about *where* inside a
   * file the user was, so the workspace commit effect listens here instead.
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
      if (prev && !prev.isSettings) {
        const h = editorRef.current;
        const content = h?.editor.getValue();
        const offset = currentOffset();
        const key = pathKey(prev.path);
        // Remember where the caret was even in a clean tab: the workspace stores it.
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
        disk = await api.openFile(raw, record);
      } catch (e) {
        if (record) toast(errorMessage(e));
        return false;
      }
      const opened = tabsRef.current.find(
        (t) => !t.isSettings && pathKey(t.path) === pathKey(disk.path)
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

  const openUntitled = useCallback(async () => {
    const name = t("tab.untitled", { n: ++untitledSeq.current });
    const tab: Tab = {
      id: nextId(),
      path: `untitled://${name}`,
      name,
      language: "plaintext",
      original: "",
      dirty: false,
    };
    setTabs((prev) => [...prev, tab]);
    await activate(tab.id);
  }, [activate]);

  /** Restored scratch tab: its text lives in the workspace file, so seed the model with it. */
  const openScratch = useCallback(
    async (name: string, content: string) => {
      const path = `untitled://${name}`;
      const existing = tabsRef.current.find((t) => t.path === path);
      if (existing) {
        await activate(existing.id);
        return;
      }
      const tab: Tab = {
        id: nextId(),
        path,
        name,
        language: "plaintext",
        original: "",
        // Unsaved by definition: it never reached a file.
        dirty: content !== "",
        initialValue: content,
      };
      setTabs((prev) => [...prev, tab]);
      await activate(tab.id);
    },
    [activate]
  );

  /** Serializable view of the open tabs, for the workspace store. */
  const snapshotTabs = useCallback((): { tabs: WorkspaceTab[]; active: string } => {
    const h = editorRef.current;
    const live = tabsRef.current.filter((t) => !t.isSettings);
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

  /** Reopen a workspace. Unreadable entries are skipped so one dead path cannot eat the session. */
  const restoreTabs = useCallback(
    async (entries: WorkspaceTab[], activeKey: string): Promise<RestoreResult> => {
      let restored = 0;
      let skipped = 0;
      for (const entry of entries) {
        if (entry.path) {
          if (!(await openPath(entry.path, { record: false }))) {
            skipped++;
            continue;
          }
          const key = pathKey(entry.path);
          if (entry.cursor > 0) {
            cursors.current.set(key, entry.cursor);
            pendingCursors.current.add(key);
          }
        } else if (entry.untitled) {
          await openScratch(entry.untitled, entry.content);
          const trailing = /(\d+)$/.exec(entry.untitled);
          if (trailing) untitledSeq.current = Math.max(untitledSeq.current, Number(trailing[1]));
        } else {
          skipped++;
          continue;
        }
        restored++;
      }
      // openPath activated each tab as it went, so land on the one the user left selected.
      const wanted = tabsRef.current.find(
        (t) => !t.isSettings && pathKey(t.path) === pathKey(activeKey)
      );
      await activate(wanted?.id ?? tabsRef.current[tabsRef.current.length - 1]?.id ?? null);
      return { restored, skipped };
    },
    [activate, openPath, openScratch]
  );

  /**
   * Move the caret to a restored offset once that tab's model is actually attached.
   * Called whenever the active tab changes; retried for a few frames because the editor
   * swaps models in its own effect.
   */
  const applyPendingCursor = useCallback(
    (until = 0) => {
      const tab = tabsRef.current.find((t) => t.id === activeRef.current);
      if (!tab || tab.isSettings) return;
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

  const openSettings = useCallback(async () => {
    const existing = tabsRef.current.find((t) => t.isSettings);
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
      if (!tab.isSettings) {
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
      if (h && !tab.isSettings) {
        setTimeout(() => {
          const model = h.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(tab.path)));
          if (model && model !== h.editor.getModel()) model.dispose();
        }, 0);
      }
    },
    [currentOffset, draft, editorRef]
  );

  /** Drop the whole tab set (switching workspaces). Drafts were flushed by the caller. */
  const clearAllTabs = useCallback(() => {
    const h = editorRef.current;
    for (const tab of tabsRef.current) {
      if (tab.isSettings) continue;
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
      if (!tab || tab.isSettings) return;
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
      if (!tab || tab.isSettings) return;
      // Swapping models emits a cursor event for a position nobody chose. Trusting it
      // would erase both the remembered caret and the draft's caret for that tab.
      if (editorRef.current?.editor.hasTextFocus() !== true) return;
      const key = pathKey(tab.path);
      cursors.current.set(key, offset);
      // The caret moved under the user, so a restored offset for this tab is now stale.
      pendingCursors.current.delete(key);
      setCursorRev((rev) => rev + 1);
      if (!tab.dirty || isUntitled(tab.path)) return;
      const content = editorRef.current?.editor.getValue();
      if (content === undefined) return;
      draft.schedule(tab.path, { content, cursor: offset, original: tab.original });
    },
    [draft, editorRef]
  );

  const saveActive = useCallback(async () => {
    const tab = tabsRef.current.find((t) => t.id === activeRef.current);
    const h = editorRef.current;
    if (!tab || tab.isSettings || !h) return;
    const content = h.editor.getValue();
    try {
      if (isUntitled(tab.path)) {
        const target = await pickSaveAs(tab.name);
        if (!target) return;
        const saved = await api.saveFile(target, content);
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
                }
              : t
          )
        );
        setTimeout(() => oldModel?.dispose(), 0);
        onFileOpened?.(dirname(saved.path));
        toast(t("menu.saved", { name: basename(saved.path) }));
        return;
      }

      await api.saveFile(tab.path, content);
      draft.forget(tab.path);
      await api.clearDraft(tab.path);
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, original: content, dirty: false } : t)));
      toast(t("menu.saved", { name: tab.name }));
    } catch (e) {
      toast(errorMessage(e));
    }
  }, [draft, editorRef, onFileOpened, toast]);

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

      model.setValue(req.draft.content);
      setTabs((prev) => prev.map((t) => (t.id === req.tabId ? { ...t, dirty: true } : t)));
      try {
        // Re-persist immediately: an unsaved tab the user has not visited yet must survive a quit.
        await api.saveDraft(req.path, req.draft.content, req.draft.cursor);
      } catch (e) {
        toast(errorMessage(e));
      }
      // A draft cursor belongs to the draft's content, so it overrides the workspace's.
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
  if (activeTab && !activeTab.isSettings) lastFileTabRef.current = activeTab;

  return {
    tabs,
    activeId,
    activeTab,
    cursorRev,
    /** Where Editor takes path/defaultValue: keeps the last file tab while Settings is active. */
    editorTab: activeTab && !activeTab.isSettings ? activeTab : lastFileTabRef.current,
    restoreQueue,
    openPath,
    openUntitled,
    openSettings,
    closeTab,
    clearAllTabs,
    selectTab: activate,
    saveActive,
    onEditorChange,
    onCursorChange,
    resolveRestore,
    resolveAllRestores,
    snapshotTabs,
    restoreTabs,
    applyPendingCursor,
  };
}
