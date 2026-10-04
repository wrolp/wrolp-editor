import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "./components/Editor";
import DraftRestoreDialog from "./components/DraftRestoreDialog";
import SettingsPanel from "./components/SettingsPanel";
import Sidebar from "./components/Sidebar";
import SidebarResizer from "./components/SidebarResizer";
import StatusBar from "./components/StatusBar";
import TitleBar from "./components/TitleBar";
import Toast from "./components/Toast";
import { useDraft } from "./hooks/useDraft";
import { useEditorTabs } from "./hooks/useEditorTabs";
import { dirname } from "./lib/path";
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
};

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
  const [tabMenu, setTabMenu] = useState<{ tabId: number; x: number; y: number } | null>(null);

  const editorRef = useRef<EditorHandle | null>(null);
  const draft = useDraft(toast);

  const onFileOpened = useCallback((dir: string) => {
    // The first file that opens decides which folder Explorer shows.
    setRootDir((prev) => prev ?? dir);
  }, []);

  const tabs = useEditorTabs({ toast, draft, editorRef, onFileOpened });

  const refreshHistory = useCallback(() => {
    api.getHistory().then(setHistory).catch((e) => toast(errorMessage(e)));
  }, [toast]);

  const refreshMenu = useCallback(() => {
    api
      .contextMenuTarget()
      .then((target) => {
        setMenuTarget(target);
        if (!target.installed) {
          toast('Tip: add "Open with WROLP" to the file context menu from Settings.');
        } else if (!target.matchesCurrent) {
          toast("The context menu launches a different build. Re-enable it in Settings.");
        }
      })
      .catch((e) => toast(errorMessage(e)));
  }, [toast]);

  // Startup: settings, history, context-menu state, and files from argv or a second instance.
  useEffect(() => {
    api
      .getSettings()
      .then((s) => {
        setSettings(s);
        setSidebarVisible(s.sidebarVisible);
        setSidebarView(s.sidebarView === "history" ? "history" : "explorer");
        setSidebarWidth(s.sidebarWidth);
      })
      .catch((e) => toast(errorMessage(e)));

    refreshHistory();
    refreshMenu();

    const openStartup = async () => {
      try {
        for (const path of await api.takeStartupFiles()) await tabs.openPath(path);
      } catch (e) {
        toast(errorMessage(e));
      }
    };
    void openStartup();

    const unlisten = listen<string>("open-file", (event) => void tabs.openPath(event.payload));
    return () => {
      unlisten.then((f) => f());
    };
    // Mount only: openPath reads the current tab state through refs.
  }, []);

  // Flush pending drafts when the window loses focus to shrink what a kill can lose.
  useEffect(() => {
    const onBlur = () => void draft.flushAll();
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onBlur);
    return () => {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onBlur);
    };
  }, [draft]);

  const saveSettings = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settings, ...patch };
      setSettings(next);
      api.saveSettings(next).catch((e) => toast(errorMessage(e)));
    },
    [settings, toast]
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
    if (dir) setRootDir(dir);
  }, [toast]);

  const setMenu = useCallback(
    async (installed: boolean) => {
      setMenuBusy(true);
      try {
        if (installed) {
          const value = await api.installContextMenu();
          toast(`Context menu added: ${value}`);
        } else {
          await api.uninstallContextMenu();
          toast("Context menu removed");
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
    return tabs.tabs.find((t) => t.id === tabMenu.tabId)?.path ?? null;
  }, [tabMenu, tabs.tabs]);

  useEffect(() => {
    if (!tabMenu) return;
    const hide = () => setTabMenu(null);
    window.addEventListener("click", hide);
    window.addEventListener("contextmenu", hide);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("click", hide);
      window.removeEventListener("contextmenu", hide);
      window.removeEventListener("blur", hide);
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
        toast((await copyText(path)) ? `Path copied: ${path}` : "Copy failed");
      } else {
        setSidebarView("explorer");
        setSidebarVisible(true);
        setRootDir(dirname(path));
      }
    },
    [menuTabPath, toast]
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
    <div className="app">
      <TitleBar
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        sidebarVisible={sidebarShown}
        onSelect={tabs.selectTab}
        onClose={tabs.closeTab}
        onTabContextMenu={(tabId, x, y) => setTabMenu({ tabId, x, y })}
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

          {!editorTab && (
            <div className="editor-empty">
              Open a file with the button above, or pick one from the Explorer sidebar,
              <br />
              or right-click a file and choose "Open with WROLP".
            </div>
          )}

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
        <div className="ctx-menu" style={{ display: "block", left: tabMenu.x, top: tabMenu.y }}>
          <div className="ctx-item" onClick={() => void runTabAction("reveal")}>
            Reveal in Explorer
          </div>
          <div className="ctx-item" onClick={() => void runTabAction("copy")}>
            Copy path
          </div>
          <div className="ctx-item" onClick={() => void runTabAction("sidebar")}>
            Show folder in sidebar
          </div>
        </div>
      )}

      {tabs.restoreQueue[0] && (
        <DraftRestoreDialog
          request={tabs.restoreQueue[0]}
          count={tabs.restoreQueue.length}
          onRestore={() => void tabs.resolveRestore("restore")}
          onDiscard={() => void tabs.resolveRestore("discard")}
        />
      )}

      <Toast message={toastState.message} visible={toastState.visible} />
    </div>
  );
}
