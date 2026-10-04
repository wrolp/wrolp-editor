import { useCallback, useRef, useState, type RefObject } from "react";
import { api, errorMessage, pickSaveAs, type Draft } from "../lib/tauri";
import { basename, dirname, isUntitled, langOf, modelUri } from "../lib/path";
import { pathKey, type EditorHandle, type PendingRestore, type Tab } from "../lib/types";
import type { DraftWriter } from "./useDraft";

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

  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const queueRef = useRef(restoreQueue);
  queueRef.current = restoreQueue;
  const lastFileTabRef = useRef<Tab | null>(null);
  const seq = useRef(0);
  const untitledSeq = useRef(0);

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
        if (content !== undefined && content !== prev.original && !isUntitled(prev.path)) {
          draft.schedule(prev.path, { content, cursor: currentOffset(), original: prev.original });
        }
        await draft.flush(prev.path);
      }
      setActiveId(id);
    },
    [currentOffset, draft, editorRef]
  );

  const openPath = useCallback(
    async (raw: string) => {
      let disk;
      try {
        disk = await api.openFile(raw);
      } catch (e) {
        toast(errorMessage(e));
        return;
      }
      const opened = tabsRef.current.find(
        (t) => !t.isSettings && pathKey(t.path) === pathKey(disk.path)
      );
      onFileOpened?.(dirname(disk.path));

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
        return;
      }
      if (draftInfo && draftInfo.content !== disk.content) {
        setRestoreQueue((q) => [
          ...q,
          { tabId: target.id, path: target.path, name: target.name, draft: draftInfo },
        ]);
      } else if (draftInfo) {
        // Draft matches what is on disk: redundant, so drop it.
        await api.clearDraft(disk.path).catch((e) => toast(errorMessage(e)));
      }
    },
    [activate, onFileOpened, toast]
  );

  const openUntitled = useCallback(async () => {
    const name = `Untitled-${++untitledSeq.current}`;
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

  const openSettings = useCallback(async () => {
    const existing = tabsRef.current.find((t) => t.isSettings);
    if (existing) {
      await activate(existing.id);
      return;
    }
    const tab: Tab = {
      id: nextId(),
      path: "__settings__",
      name: "Settings",
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
      if (!tab || tab.isSettings || !tab.dirty || isUntitled(tab.path)) return;
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
        toast(`Saved ${basename(saved.path)}`);
        return;
      }

      await api.saveFile(tab.path, content);
      draft.forget(tab.path);
      await api.clearDraft(tab.path);
      setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, original: content, dirty: false } : t)));
      toast(`Saved ${tab.name}`);
    } catch (e) {
      toast(errorMessage(e));
    }
  }, [draft, editorRef, onFileOpened, toast]);

  const resolveRestore = useCallback(
    async (mode: "restore" | "discard") => {
      const req = queueRef.current[0];
      setRestoreQueue((q) => q.slice(1));
      if (!req) return;
      const h = editorRef.current;
      const model = h?.monaco.editor.getModel(h.monaco.Uri.parse(modelUri(req.path)));
      if (!h || !model) return;

      if (mode === "discard") {
        try {
          await api.clearDraft(req.path);
          toast("Draft discarded");
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
      if (activeRef.current === req.tabId) {
        const offset = Math.min(req.draft.cursor, model.getValueLength());
        const position = model.getPositionAt(offset);
        h.editor.setPosition(position);
        h.editor.revealPositionInCenter(position);
        h.editor.focus();
      }
      toast("Draft restored");
    },
    [editorRef, toast]
  );

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  if (activeTab && !activeTab.isSettings) lastFileTabRef.current = activeTab;

  return {
    tabs,
    activeId,
    activeTab,
    /** Where Editor takes path/defaultValue: keeps the last file tab while Settings is active. */
    editorTab: activeTab && !activeTab.isSettings ? activeTab : lastFileTabRef.current,
    restoreQueue,
    openPath,
    openUntitled,
    openSettings,
    closeTab,
    selectTab: activate,
    saveActive,
    onEditorChange,
    onCursorChange,
    resolveRestore,
  };
}
