import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Editor from "./components/Editor";
import DraftRestoreDialog from "./components/DraftRestoreDialog";
import NewGroupDialog from "./components/NewGroupDialog";
import SettingsPanel from "./components/SettingsPanel";
import Sidebar from "./components/Sidebar";
import SidebarResizer from "./components/SidebarResizer";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toast from "./components/Toast";
import GroupChip from "./components/GroupChip";
import DraftRestoreSummary from "./components/DraftRestoreSummary";
import { useDraft } from "./hooks/useDraft";
import { useEditorTabs } from "./hooks/useEditorTabs";
import { useGroups } from "./hooks/useGroups";
import { setLang, t } from "./lib/i18n";
import { basename, dirname } from "./lib/path";
import type { EditorHandle } from "./lib/types";
import {
  api,
  errorMessage,
  listen,
  pickFiles,
  pickFolder,
  revealItemInDir,
  type HistoryEntry,
  type MenuTarget,
  type Settings,
} from "./lib/tauri";

const DEFAULT_SETTINGS: Settings = {
  fontSize: 14,
  minimap: true,
  sidebarVisible: true,
  sidebarView: "explorer",
  sidebarWidth: 240,
  language: "en",
  restoreSession: true,
  sidebarRoot: "",
  compactMode: false,
};

/** Never let a save-on-close turn into a window that cannot be closed. */
const CLOSE_FLUSH_TIMEOUT_MS = 2000;

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  }
}

export default function App() {
  const [toastState, setToastState] = useState({ message: "", visible: false });
  const toastTimer = useRef<number | undefined>(undefined);
  const toast = useCallback((message: string) => {
    setToastState({ message, visible: true });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastState((s) => ({ ...s, visible: false })), 1800);
  }, []);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SETTINGS.sidebarWidth);
  const [sidebarView, setSidebarView] = useState<"explorer" | "history">("explorer");
  const [rootDir, setRootDir] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const [tabMenu, setTabMenu] = useState<{
    tabId: number;
    x: number;
    y: number;
    panel: "root" | "move" | "copy" | "moveAll";
  } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  /** "Review individually" in the batch dialog: walk the queue one file at a time. */
  const [reviewEach, setReviewEach] = useState(false);
  /** A group is named by the user, so creating one needs a name first. */
  const [newGroupOpen, setNewGroupOpen] = useState(false);

  const editorRef = useRef<EditorHandle | null>(null);
  const draft = useDraft(toast);

  // Stable callback for useEditorTabs: the real work needs the group plumbing below,
  // which in turn needs the tabs, so it is reached through a ref instead of a dependency.
  const fileOpened = useRef<(dir: string) => void>(() => {});
  const onFileOpened = useCallback((dir: string) => fileOpened.current(dir), []);

  const tabs = useEditorTabs({ toast, draft, editorRef, onFileOpened });
  const groups = useGroups({ onError: toast });
  /** Startup must finish before the live state is mirrored into the store. */
  const [booted, setBooted] = useState(false);

  const refreshHistory = useCallback(() => {
    api.getHistory().then(setHistory).catch((e) => toast(errorMessage(e)));
  }, [toast]);

  const refreshMenu = useCallback(() => {
    api
      .contextMenuTarget()
      .then((target) => {
        setMenuTarget(target);
        if (!target.installed) {
          toast(t("app.tipMenu"));
        } else if (!target.matchesCurrent) {
          toast(t("app.tipStaleMenu"));
        }
      })
      .catch((e) => toast(errorMessage(e)));
  }, [toast]);

  // Startup: settings, group session, then files from argv or a second instance.
  const bootStarted = useRef(false);
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    const boot = async () => {
      let loadedSettings = DEFAULT_SETTINGS;
      try {
        loadedSettings = await api.getSettings();
      } catch (e) {
        toast(errorMessage(e));
      }
      setLang(loadedSettings.language);
      setSettings(loadedSettings);
      setSidebarVisible(loadedSettings.sidebarVisible);
      setSidebarView(loadedSettings.sidebarView === "history" ? "history" : "explorer");
      setSidebarWidth(loadedSettings.sidebarWidth);
      // The Explorer folder is global view state; a group only remembers tabs.
      setRootDir(loadedSettings.sidebarRoot || null);

      const store = await groups.load().catch((e) => {
        toast(errorMessage(e));
        return null;
      });
      const active = store?.active ? store.items.find((w) => w.id === store.active) ?? null : null;
      if (active && loadedSettings.restoreSession && active.tabs.length > 0) {
        const result = await tabs.restoreTabs(active.tabs, active.active);
        if (result.skipped > 0) toast(t("grp.skipped", { n: result.skipped }));
      }

      try {
        // Anything handed over by the context menu lands in the group already on screen.
        for (const path of await api.takeStartupFiles()) await tabs.openPath(path);
      } catch (e) {
        toast(errorMessage(e));
      }
      setBooted(true);
    };
    void boot();
    // Mount only: openPath reads the current tab state through refs.
  }, []);

  // A second instance hands its file to this window; that listener must exist on every
  // mount, unlike the boot sequence which must only run once.
  useEffect(() => {
    refreshHistory();
    refreshMenu();
    const unlisten = listen<string>("open-file", (event) => void tabs.openPath(event.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  /** What the store should remember about the screen right now. */
  const pausedCommit = useRef(false);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const snapshotOf = useRef(tabs.snapshotTabs);
  snapshotOf.current = tabs.snapshotTabs;
  const rootRef = useRef<string | null>(null);
  rootRef.current = rootDir;
  const saveSettingsRef = useRef<(patch: Partial<Settings>) => void>(() => {});

  const commitLive = useCallback((immediate?: boolean) => {
    // Suspended while a switch is rebuilding the tab set, otherwise the half-cleared tabs
    // would be written into the group being switched to.
    if (pausedCommit.current) return;
    groupsRef.current.commit(snapshotOf.current(), immediate);
  }, []);

  useEffect(() => {
    if (!booted) return;
    commitLive();
  }, [booted, commitLive, tabs.tabs, tabs.activeId, tabs.cursorRev]);

  fileOpened.current = (dir: string) => {
    // The Explorer follows a file only while it has no folder of its own; after that,
    // moving it is a deliberate action (Open folder… / Show folder in sidebar).
    if (!rootRef.current) {
      rootRef.current = dir;
      setRootDir(dir);
      saveSettingsRef.current({ sidebarRoot: dir });
    }
    commitLive(true);
  };

  /**
   * There is always somewhere to put a tab: a window with no groups starts with a default one,
   * so nothing depends on the user remembering to create it before work gets persisted. The
   * snapshot is committed right away because the tab that triggered this may already be open —
   * its own commit ran while there was no group to write into.
   */
  useEffect(() => {
    if (!booted || groups.store.items.length > 0) return;
    groupsRef.current.create(t("grp.default"));
    commitLive(true);
  }, [booted, commitLive, groups.store.items.length]);

  // Land the caret where the group remembered, once the model for that tab is attached.
  useEffect(() => {
    tabs.applyPendingCursor();
    // The readout only follows Monaco's cursor events, which a model switch may not fire:
    // without this the status bar keeps showing the previous tab's position.
    const raf = requestAnimationFrame(() => {
      const position = editorRef.current?.editor.getPosition();
      if (position) setCursor({ line: position.lineNumber, column: position.column });
    });
    return () => cancelAnimationFrame(raf);
  }, [tabs, tabs.activeId]);

  /** Replace the whole tab set with another group's, keeping the outgoing one intact. */
  const switchGroup = useCallback(
    async (id: string) => {
      const target = groupsRef.current.store.items.find((w) => w.id === id);
      if (!target) return;
      pausedCommit.current = true;
      try {
        await draft.flushAll();
        groupsRef.current.commit(snapshotOf.current(), true);
        groupsRef.current.select(id);
        tabs.clearAllTabs();
        if (target.tabs.length > 0) {
          const result = await tabs.restoreTabs(target.tabs, target.active);
          if (result.skipped > 0) toast(t("grp.skipped", { n: result.skipped }));
        }
        // Files that could not be read must not stay in the store for next startup to retry.
        groupsRef.current.commit(snapshotOf.current(), true);
      } finally {
        pausedCommit.current = false;
      }
      toast(t("grp.switched", { name: target.name }));
    },
    [draft, tabs, toast]
  );

  /**
   * Open a group with a name the user typed. It starts empty: the tabs on screen belong to
   * the group they came from, so those are parked first and the window is cleared after.
   */
  const createGroup = useCallback(
    async (name: string) => {
      pausedCommit.current = true;
      try {
        await draft.flushAll();
        groupsRef.current.commit(snapshotOf.current(), true);
        const { group: created, problem } = groupsRef.current.create(name);
        if (!created) {
          // The dialog validated the name already; a race here just leaves things as they were.
          if (problem === "duplicate") toast(t("grp.nameDuplicate"));
          return null;
        }
        tabs.clearAllTabs();
        groupsRef.current.commit({ tabs: [], active: "" }, true);
        return created;
      } finally {
        pausedCommit.current = false;
      }
    },
    [draft, tabs, toast]
  );

  /** Forget the current context but keep the entry, per the "Close group" menu item. */
  /** Forget a group's tabs but keep the entry; the sidebar folder is global and stays. */
  const clearGroup = useCallback(
    async (id: string) => {
      const target = groupsRef.current.store.items.find((w) => w.id === id);
      pausedCommit.current = true;
      try {
        await draft.flushAll();
        groupsRef.current.clearContents(id);
        tabs.clearAllTabs();
        if (target) toast(t("grp.cleared", { name: target.name }));
      } finally {
        pausedCommit.current = false;
      }
    },
    [draft, tabs, toast]
  );

  const flushEverything = useCallback(async () => {
    await draft.flushAll();
    await groups.flush();
  }, [draft, groups]);

  // Flush pending drafts when the window loses focus to shrink what a kill can lose.
  useEffect(() => {
    const onBlur = () => void flushEverything();
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, [flushEverything]);

  // Closing the window is the last moment the session is still intact, so write it now.
  const flushRef = useRef(flushEverything);
  flushRef.current = flushEverything;
  const closeApproved = useRef(false);
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested(async (event) => {
      if (closeApproved.current) return;
      event.preventDefault();
      closeApproved.current = true;
      const timeout = new Promise((resolve) => setTimeout(resolve, CLOSE_FLUSH_TIMEOUT_MS));
      try {
        await Promise.race([flushRef.current(), timeout]);
      } catch {
        // A state file that will not write must not trap the window open.
      }
      // destroy(), not close(): close() would raise CloseRequested again, and the window
      // would sit waiting for a handler that correctly declines to interfere.
      await getCurrentWindow().destroy();
    });
    return () => {
      void unlisten.then((f) => f());
    };
  }, []);

  const saveSettings = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settings, ...patch };
      if (patch.language) setLang(patch.language);
      setSettings(next);
      api.saveSettings(next).catch((e) => toast(errorMessage(e)));
    },
    [settings, toast]
  );
  saveSettingsRef.current = saveSettings;

  /** Move the Explorer to another folder. Global view state: it does not open or switch a group. */
  const setSidebarRoot = useCallback(
    (dir: string) => {
      rootRef.current = dir;
      setRootDir(dir);
      saveSettings({ sidebarRoot: dir });
    },
    [saveSettings]
  );

  const openFiles = useCallback(async () => {
    const paths = await pickFiles().catch((e) => {
      toast(errorMessage(e));
      return [];
    });
    for (const path of paths) await tabs.openPath(path);
  }, [tabs, toast]);

  const pickRootFolder = useCallback(async () => {
    const dir = await pickFolder().catch((e) => {
      toast(errorMessage(e));
      return null;
    });
    if (dir) setSidebarRoot(dir);
  }, [setSidebarRoot, toast]);

  const setMenu = useCallback(
    async (installed: boolean) => {
      setMenuBusy(true);
      try {
        if (installed) {
          const value = await api.installContextMenu();
          toast(t("menu.added", { value }));
        } else {
          await api.uninstallContextMenu();
          toast(t("menu.removed"));
        }
        refreshMenu();
      } catch (e) {
        toast(errorMessage(e));
      } finally {
        setMenuBusy(false);
      }
    },
    [refreshMenu, toast]
  );

  const menuTabPath = useMemo(() => {
    if (!tabMenu) return null;
    return tabs.tabs.find((tab) => tab.id === tabMenu.tabId)?.path ?? null;
  }, [tabMenu, tabs.tabs]);

  useEffect(() => {
    if (!tabMenu) return;
    const hide = (e: MouseEvent) => {
      // Panel switching happens by clicking inside the menu; that must not close it.
      const target = e.target as Node | null;
      if (target && tabMenuRef.current?.contains(target)) return;
      setTabMenu(null);
    };
    window.addEventListener("click", hide);
    window.addEventListener("contextmenu", hide);
    window.addEventListener("blur", () => setTabMenu(null));
    return () => {
      window.removeEventListener("click", hide);
      window.removeEventListener("contextmenu", hide);
    };
  }, [tabMenu]);

  const runTabAction = useCallback(
    async (action: "reveal" | "copy" | "sidebar") => {
      const path = menuTabPath;
      if (!path) return;
      if (action === "reveal") {
        try {
          await revealItemInDir(path);
        } catch (e) {
          toast(errorMessage(e));
        }
      } else if (action === "copy") {
        toast((await copyText(path)) ? t("title.copied", { path }) : t("title.copyFailed"));
      } else {
        setSidebarView("explorer");
        setSidebarVisible(true);
        // A view action only: the folder belongs to the sidebar, not to the group.
        setSidebarRoot(dirname(path));
      }
    },
    [menuTabPath, setSidebarRoot, toast]
  );

  /**
   * Move or copy the menu's tab into another group. The store travels to the backend
   * and comes back whole, so one write covers both sides — never "gone from A, missing in B".
   */
  const runTransfer = useCallback(
    async (panel: "move" | "copy" | "moveAll", toId: string) => {
      const key = menuTabPath;
      if (!key) return;
      const fromId = groupsRef.current.store.active;
      const tabId = tabMenu?.tabId ?? null;
      pausedCommit.current = true;
      try {
        commitLive(true);
        const out = await api
          .transferTabs(groupsRef.current.snapshotStore(), {
            action: panel === "copy" ? "copy" : "move",
            from: fromId,
            to: toId,
            tab: panel === "moveAll" ? null : key,
          })
          .catch((e) => {
            toast(errorMessage(e));
            return null;
          });
        if (!out) return;
        groupsRef.current.replace(out);
        const target = out.items.find((w) => w.id === toId);
        if (panel !== "copy") {
          if (panel === "moveAll") tabs.clearAllTabs();
          else if (tabId !== null) void tabs.closeTab(tabId);
        }
        const name = target?.name ?? "";
        toast(
          panel === "moveAll"
            ? t("grp.movedCount", { n: target?.tabs.length ?? 0, grp: name })
            : t(panel === "copy" ? "grp.copied" : "grp.moved", { name: basename(key), grp: name })
        );
      } finally {
        pausedCommit.current = false;
        setTabMenu(null);
      }
    },
    [commitLive, menuTabPath, tabMenu, tabs, toast]
  );

  const toggleSidebar = useCallback(() => {
    const next = !sidebarVisible;
    setSidebarVisible(next);
    saveSettings({ sidebarVisible: next });
  }, [saveSettings, sidebarVisible]);

  const commitSidebarWidth = useCallback(
    (width: number) => {
      setSidebarWidth(width);
      saveSettings({ sidebarWidth: width });
    },
    [saveSettings]
  );

  /** Every group except the one on screen: the destination list for move and copy. */
  const transferTargets = useMemo(
    () => groups.store.items.filter((w) => w.id !== groups.store.active),
    [groups.store]
  );

  const changeView = useCallback(
    (view: "explorer" | "history") => {
      setSidebarView(view);
      setSidebarVisible(true);
      saveSettings({ sidebarView: view });
    },
    [saveSettings]
  );

  const { saveActive, openUntitled, openSettings, closeTab } = tabs;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const key = e.key.toLowerCase();
      if (key === "s") {
        e.preventDefault();
        void saveActive();
      } else if (key === "o") {
        e.preventDefault();
        void openFiles();
      } else if (key === "n") {
        e.preventDefault();
        void openUntitled();
      } else if (key === "b") {
        e.preventDefault();
        toggleSidebar();
      } else if (key === "w") {
        e.preventDefault();
        if (tabs.activeId !== null) void closeTab(tabs.activeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeTab, openFiles, openUntitled, saveActive, tabs.activeId, toggleSidebar]);

  const showSettings = tabs.activeTab?.isSettings === true;
  const sidebarShown = sidebarVisible && !showSettings;
  const editorTab = tabs.editorTab;

  return (
    <div className="app" data-density={settings.compactMode ? "compact" : "cozy"}>
      <TitleBar
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        sidebarVisible={sidebarShown}
        groupSlot={
          <GroupChip
            groups={groups.store.items}
            activeId={groups.store.active}
            onSwitch={(id) => void switchGroup(id)}
            onNew={() => setNewGroupOpen(true)}
            onRename={groups.rename}
            onClear={(id) => void clearGroup(id)}
            onRemove={groups.remove}
          />
        }
        onSelect={tabs.selectTab}
        onClose={tabs.closeTab}
        onTabContextMenu={(tabId, x, y) => setTabMenu({ tabId, x, y, panel: "root" })}
        onToggleSidebar={toggleSidebar}
        onNewFile={openUntitled}
        onOpenFiles={openFiles}
        onOpenSettings={openSettings}
      />

      <div className="main">
        <Sidebar
          visible={sidebarShown}
          width={sidebarWidth}
          view={sidebarView}
          rootDir={rootDir}
          history={history}
          activePath={editorTab?.path ?? null}
          onSetView={changeView}
          onPickFolder={pickRootFolder}
          onOpenPath={tabs.openPath}
          onRemoveHistory={(path) =>
            api
              .removeHistory(path)
              .then(setHistory)
              .catch((e) => toast(errorMessage(e)))
          }
          onError={toast}
        />
        {sidebarShown && (
          <SidebarResizer
            value={sidebarWidth}
            defaultValue={DEFAULT_SETTINGS.sidebarWidth}
            onChange={setSidebarWidth}
            onCommit={commitSidebarWidth}
          />
        )}

        <div className="editor-wrap">
          {editorTab && (
            <div className="editor-host" style={{ display: showSettings ? "none" : "block" }}>
              <Editor
                tab={editorTab}
                fontSize={settings.fontSize}
                minimap={settings.minimap}
                onChange={tabs.onEditorChange}
                onCursor={(position, offset) => {
                  setCursor({ line: position.lineNumber, column: position.column });
                  tabs.onCursorChange(offset);
                }}
                onReady={(handle) => {
                  editorRef.current = handle;
                }}
              />
            </div>
          )}

          {!editorTab && <div className="editor-empty">{t("app.empty")}</div>}

          {showSettings && (
            <SettingsPanel
              settings={settings}
              menu={menuTarget}
              menuBusy={menuBusy}
              onSaveSettings={saveSettings}
              onSetMenu={setMenu}
            />
          )}
        </div>
      </div>

      <StatusBar tab={tabs.activeTab} line={cursor.line} column={cursor.column} />

      {tabMenu && menuTabPath && (
        <div
          className="ctx-menu"
          ref={tabMenuRef}
          style={{ display: "block", left: tabMenu.x, top: tabMenu.y }}
        >
          {tabMenu.panel === "root" ? (
            <>
              <div
                className="ctx-item"
                onClick={() => {
                  void runTabAction("reveal");
                  setTabMenu(null);
                }}
              >
                {t("title.menuReveal")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  void runTabAction("copy");
                  setTabMenu(null);
                }}
              >
                {t("title.menuCopy")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  void runTabAction("sidebar");
                  setTabMenu(null);
                }}
              >
                {t("title.menuSidebar")}
              </div>
              <div className="ws-sep" />
              {(["move", "copy", "moveAll"] as const).map((panel) => (
                <div key={panel} className="ctx-item" onClick={() => setTabMenu({ ...tabMenu, panel })}>
                  {t(
                    panel === "move"
                      ? "grp.moveTitle"
                      : panel === "copy"
                        ? "grp.copyTitle"
                        : "grp.moveAllTitle"
                  )}
                </div>
              ))}
            </>
          ) : (
            <>
              <div className="ctx-item" onClick={() => setTabMenu({ ...tabMenu, panel: "root" })}>
                ← {t("grp.back")}
              </div>
              <div className="ws-sep" />
              {transferTargets.length === 0 ? (
                <div className="dd-empty">{t("grp.noOther")}</div>
              ) : (
                transferTargets.map((w) => (
                  <div key={w.id} className="ctx-item" onClick={() => void runTransfer(tabMenu.panel as "move" | "copy" | "moveAll", w.id)}>
                    {w.name}
                  </div>
                ))
              )}
            </>
          )}
        </div>
      )}

      {newGroupOpen && (
        <NewGroupDialog
          validate={(name) => {
            if (!name.trim()) return "empty";
            return groups.isNameTaken(name) ? "duplicate" : "ok";
          }}
          onConfirm={async (name) => {
            const created = await createGroup(name);
            setNewGroupOpen(false);
            if (created) toast(t("grp.created", { name: created.name }));
          }}
          onCancel={() => setNewGroupOpen(false)}
        />
      )}

      {tabs.restoreQueue.length > 1 && !reviewEach ? (
        <DraftRestoreSummary
          requests={tabs.restoreQueue}
          onRestoreAll={() => void tabs.resolveAllRestores("restore")}
          onDiscardAll={() => void tabs.resolveAllRestores("discard")}
          onReviewEach={() => setReviewEach(true)}
        />
      ) : (
        tabs.restoreQueue[0] && (
          <DraftRestoreDialog
            request={tabs.restoreQueue[0]}
            count={tabs.restoreQueue.length}
            onRestore={() => {
              void tabs.resolveRestore("restore");
              setReviewEach(false);
            }}
            onDiscard={() => {
              void tabs.resolveRestore("discard");
              setReviewEach(false);
            }}
          />
        )
      )}

      <Toast message={toastState.message} visible={toastState.visible} />
    </div>
  );
}
