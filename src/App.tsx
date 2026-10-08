import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ImagePreview from "./components/ImagePreview";
import HtmlPreview from "./components/HtmlPreview";
import Editor from "./components/Editor";
import DiffView from "./components/DiffView";
import MarkdownPreview from "./components/MarkdownPreview";
import DraftRestoreDialog from "./components/DraftRestoreDialog";
import NewGroupDialog from "./components/NewGroupDialog";
import SettingsPanel from "./components/SettingsPanel";
import FileSettingsDialog from "./components/FileSettingsDialog";
import Sidebar from "./components/Sidebar";
import SidebarResizer from "./components/SidebarResizer";
import StatusBar from "./components/StatusBar";
import TitleBar, { type PreviewMode } from "./components/TitleBar";
import Toast from "./components/Toast";
import GroupChip from "./components/GroupChip";
import DraftRestoreSummary from "./components/DraftRestoreSummary";
import ComparePickerDialog from "./components/ComparePickerDialog";
import CloseConfirmDialog from "./components/CloseConfirmDialog";
import { useDraft } from "./hooks/useDraft";
import { useEditorTabs } from "./hooks/useEditorTabs";
import { useGroups } from "./hooks/useGroups";
import { useWindowFrame } from "./hooks/useWindowFrame";
import { setLang, t } from "./lib/i18n";
import {
  basename,
  dirname,
  isBitmapImage,
  isHtml,
  isMarkdown,
  isPreviewableImage,
  isSvg,
  isUnder,
  isUntitled,
  modelUri,
  openableExtensions,
  rekeyPath,
} from "./lib/path";
import { isFileTab, pathKey, type DiffStats, type EditStats, type EditorHandle } from "./lib/types";
import {
  api,
  copyText,
  errorMessage,
  listen,
  pickFile,
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
  // The Explorer opens folded: showing the whole tree on open hides how deep the folder
  // goes, and costs one directory listing per level before anything is read.
  expandFolders: false,
  expandDepth: 1,
  // Nothing is excluded out of the box: the verb is registered per recognized type, so a
  // file the app cannot open has no menu to begin with.
  excludedExtensions: [],
  compactMode: false,
  encoding: "auto",
  renderWhitespace: "selection",
  wordWrap: false,
  stickyScroll: true,
  theme: "system",
  tabSize: 2,
  insertSpaces: true,
  detectIndentation: true,
  scrollBeyondLastLine: true,
  // A document is opened to be read and written, so the editor is what a file opens to.
  // The preview is one keystroke away; a preview nobody asked for costs a pane.
  previewLayout: "text",
}

/** The only values Monaco accepts for `renderWhitespace`. */
const WHITESPACE_MODES = ["none", "boundary", "selection", "all", "trailing"] as const;

/** Narrows the stored setting; the backend already rejects anything else. */
function whitespaceMode(value: string): (typeof WHITESPACE_MODES)[number] {
  return (WHITESPACE_MODES as readonly string[]).includes(value)
    ? (value as (typeof WHITESPACE_MODES)[number])
    : "selection";
}

/** Never let a save-on-close turn into a window that cannot be closed. */
const CLOSE_FLUSH_TIMEOUT_MS = 2000;

/**
 * Whether the OS is asking for a dark UI. `prefers-color-scheme: light` is the query to
 * watch rather than the absence of `dark`: a browser that does not support the feature
 * reports no match for either, and "no preference" has to resolve to the dark theme this
 * app has always looked like.
 */
function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => !window.matchMedia("(prefers-color-scheme: light)").matches
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => setDark(!mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return dark;
}

/** What fills the preview pane: rendered markdown, a picture, or a live HTML page. */
type PreviewKind = "markdown" | "image" | "html" | null;

export default function App() {
  const [toastState, setToastState] = useState({ message: "", visible: false });
  const toastTimer = useRef<number | undefined>(undefined);
  const toast = useCallback((message: string) => {
    setToastState({ message, visible: true });
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToastState((s) => ({ ...s, visible: false })), 1800);
  }, []);

  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  // `system` is resolved here rather than in the backend: the OS preference can change while
  // the app is open, and only the frontend is listening to it.
  const systemDark = usePrefersDark();
  const theme = settings.theme === "light" ? "light" : settings.theme === "dark" ? "dark" : systemDark ? "dark" : "light";

  // The palette is keyed on :root[data-theme] rather than on the app node, and that is not
  // cosmetic: body and html sit outside .app, and the alias variables (--titlebar and
  // friends) are substituted where they are declared, so a theme that only reached .app
  // would leave the window background and the title bar on the dark palette.
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SETTINGS.sidebarWidth);
  const [sidebarView, setSidebarView] = useState<"explorer" | "history">("explorer");
  const [rootDir, setRootDir] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState({ line: 1, column: 1 });
  /**
   * Preview layout per file. A missing key means "auto": markdown opens side by side,
   * anything else is text only. Storing the choice is what makes it stick per file.
   */
  const [previewPref, setPreviewPref] = useState<Record<string, PreviewMode>>({});
  const [scrollRatio, setScrollRatio] = useState(0);
  const [stats, setStats] = useState<EditStats>({
    selectionChars: 0,
    selectionLines: 0,
    totalChars: 0,
  });
  const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
  /** Added/removed lines of the comparison on screen; null for every other tab. */
  const [diffStats, setDiffStats] = useState<DiffStats | null>(null);
  const [menuBusy, setMenuBusy] = useState(false);
  const [fileSettingsPath, setFileSettingsPath] = useState<string | null>(null);
  const [tabMenu, setTabMenu] = useState<{
    tabId: number;
    x: number;
    y: number;
    panel: "root" | "move" | "copy" | "moveAll";
  } | null>(null);
  const tabMenuRef = useRef<HTMLDivElement>(null);
  /** The tab whose name is being edited in place, or null. */
  const [renamingTab, setRenamingTab] = useState<number | null>(null);
  /** The tab waiting on the unsaved-changes prompt, or null. */
  const [closeAsk, setCloseAsk] = useState<number | null>(null);
  /** "Review individually" in the batch dialog: walk the queue one file at a time. */
  const [reviewEach, setReviewEach] = useState(false);
  /** A group is named by the user, so creating one needs a name first. */
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  /** Path of the file a comparison starts from, while the other side is being chosen. */
  const [compareFrom, setCompareFrom] = useState<string | null>(null);

  const editorRef = useRef<EditorHandle | null>(null);
  const draft = useDraft(toast);

  // Stable callback for useEditorTabs: the real work needs the group plumbing below,
  // which in turn needs the tabs, so it is reached through a ref instead of a dependency.
  const fileOpened = useRef<(dir: string) => void>(() => {});
  const onFileOpened = useCallback((dir: string) => fileOpened.current(dir), []);

  const tabs = useEditorTabs({
    toast,
    draft,
    editorRef,
    onFileOpened,
    encodingPref: settings.encoding,
  });
  const groups = useGroups({ onError: toast });
  // The window goes back where it was before anything else measures it.
  const frame = useWindowFrame({ onError: toast, onNotice: toast });
  /** Startup must finish before the live state is mirrored into the store. */
  const [booted, setBooted] = useState(false);

  const refreshHistory = useCallback(() => {
    api.getHistory().then(setHistory).catch((e) => toast(errorMessage(e)));
  }, [toast]);

  /** The per-file panel only makes sense for a real file, not an untitled buffer. */
  const setFileSettingsFor = useCallback((path: string) => {
    setFileSettingsPath(isUntitled(path) ? null : path);
  }, []);

  const refreshMenu = useCallback(async () => {
    // The probe walks the known file types to count the exclusion masks, so it needs that
    // list — but the menu covers every file, so nothing else about the answer depends on it.
    try {
      const target = await api.contextMenuTarget(openableExtensions());
      setMenuTarget(target);
      if (!target.installed) {
        toast(t("app.tipMenu"));
      } else if (!target.matchesCurrent) {
        toast(t("app.tipStaleMenu"));
      }
      return target;
    } catch (e) {
      toast(errorMessage(e));
      return null;
    }
  }, [settings.excludedExtensions, toast]);

  // Startup: settings, group session, then files from argv or a second instance.
  const bootStarted = useRef(false);
  useEffect(() => {
    if (bootStarted.current) return;
    bootStarted.current = true;
    const boot = async () => {
      // Geometry first: measuring tabs and the editor against the wrong width would
      // just have to be redone a frame later.
      await frame.restore();
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
    const unlisten = listen<string>("open-file", (event) => void tabs.openPath(event.payload));
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  // Probing the menu means asking about one specific set of file types, so it waits for the
  // settings that carry the exclusions. Doing it at mount would ask about the wrong set.
  // The callback is reached through a ref so that changing the exclusion list does not
  // re-probe — and re-show the "add the menu" tip — every time a setting is saved.
  const refreshMenuRef = useRef(refreshMenu);
  refreshMenuRef.current = refreshMenu;
  useEffect(() => {
    if (!booted) return;
    void refreshMenuRef.current().then((target) => {
      // A build that wrote the entries under a spelling the shell never reads leaves the
      // user with a menu that cannot appear and a switch that reads "on". Rewriting it here
      // restores what they asked for, instead of making them toggle it off and on again.
      if (target?.staleLayout) void reapplyMenu(settingsRef.current.excludedExtensions);
    });
    // The settings are read through a ref for the same reason the callback is: this must
    // run once, when startup finishes.
  }, [booted]);

  /** What the store should remember about the screen right now. */
  const pausedCommit = useRef(false);
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const snapshotOf = useRef(tabs.snapshotTabs);
  snapshotOf.current = tabs.snapshotTabs;
  const rootRef = useRef<string | null>(null);
  rootRef.current = rootDir;
  const saveSettingsRef = useRef<(patch: Partial<Settings>) => void>(() => {});
  /** Latest settings, for the one-shot startup work that must not re-run on every change. */
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

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
    await frame.flush();
  }, [draft, frame, groups]);

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

  /**
   * Rewrite the verb for the current exclusion list. Called after that setting changes so
   * the new list takes effect by itself: the registry entries are the only place an
   * exclusion is honored, and making the user toggle the switch off and on again would be a
   * step that exists only because of how the registry works.
   */
  const reapplyMenu = useCallback(
    async (excluded: string[]) => {
      try {
        await api.installContextMenu(openableExtensions(), excluded);
        refreshMenu();
      } catch (e) {
        toast(errorMessage(e));
      }
    },
    [refreshMenu, toast]
  );

  const saveSettings = useCallback(
    (patch: Partial<Settings>) => {
      const next = { ...settings, ...patch };
      if (patch.language) setLang(patch.language);
      setSettings(next);
      api.saveSettings(next).catch((e) => toast(errorMessage(e)));
      // The verb is registered per file type, so a new exclusion only takes effect once the
      // entries are rewritten — and only if the menu is on; otherwise the list is simply
      // waiting for the next install.
      if (patch.excludedExtensions && menuTarget?.installed) {
        void reapplyMenu(next.excludedExtensions);
      }
    },
    [menuTarget, reapplyMenu, settings, toast]
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

  /**
   * Rename a file or a folder on disk, then move everything the app keys by its path.
   *
   * Pending drafts are written first: a debounced draft that landed after the backend had
   * re-homed them would put one back under the old path. Everything after the rename is one
   * synchronous batch, so no render can catch a tab whose model is still under the old one.
   * Resolves false when the name was refused, which is what keeps the edit open.
   */
  const renameEntry = useCallback(
    async (path: string, name: string): Promise<boolean> => {
      await draft.flushAll();
      const out = await api.renamePath(path, name).catch((e) => {
        toast(errorMessage(e));
        return null;
      });
      if (!out) return false;
      // A name that differs only in spelling Windows folds away moves nothing, and there is
      // then nothing to re-home.
      if (out.path === out.oldPath) return true;
      tabs.rekeyTabs(out.oldPath, out.path);
      groupsRef.current.rekeyPaths(out.oldPath, out.path);
      // Both of these are keyed by path: the layout choice for this session, and the file
      // whose per-file panel is open.
      setPreviewPref((prev) => {
        const next: Record<string, PreviewMode> = {};
        for (const [key, mode] of Object.entries(prev)) {
          next[rekeyPath(key, out.oldPath, out.path)] = mode;
        }
        return next;
      });
      setFileSettingsPath((prev) => (prev === null ? prev : rekeyPath(prev, out.oldPath, out.path)));
      if (rootRef.current && isUnder(rootRef.current, out.oldPath)) {
        setSidebarRoot(rekeyPath(rootRef.current, out.oldPath, out.path));
      }
      refreshHistory();
      toast(t("rename.done", { name: basename(out.path) }));
      return true;
    },
    [draft, refreshHistory, setSidebarRoot, tabs, toast]
  );

  const renameTab = useCallback(
    async (id: number, name: string) => {
      const tab = tabs.tabs.find((t) => t.id === id);
      if (!tab) return false;
      if (!(await renameEntry(tab.path, name))) return false;
      setRenamingTab(null);
      return true;
    },
    [renameEntry, tabs.tabs]
  );

  const openFiles = useCallback(async () => {
    const paths = await pickFiles().catch((e) => {
      toast(errorMessage(e));
      return [];
    });
    for (const path of paths) await tabs.openPath(path);
  }, [tabs, toast]);

  /** Open tabs that can be the other side of a comparison against `left`. */
  const otherFileTabs = useCallback(
    (left: string) =>
      tabs.tabs
        .filter((tab) => isFileTab(tab) && !isUntitled(tab.path))
        .filter((tab) => pathKey(tab.path) !== pathKey(left))
        .map((tab) => ({ path: tab.path, name: tab.name })),
    [tabs.tabs]
  );

  /** The system file picker, for a file that is not open in a tab. */
  const browseCompareWith = useCallback(
    async (left: string) => {
      const right = await pickFile().catch((e) => {
        toast(errorMessage(e));
        return null;
      });
      if (!right) return;
      if (pathKey(left) === pathKey(right)) {
        toast(t("cmp.same"));
        return;
      }
      await tabs.openCompare(left, right);
    },
    [tabs, toast]
  );

  /**
   * Compare one file with another. The first file is the one the user acted on; the
   * second is picked from the files already open in tabs, because comparing two files you
   * are working on is the common case and the tab strip already lists them. When nothing
   * else is open — or the other file lives in another folder — the system file picker
   * takes over, so the pair is not limited to what happens to be open.
   */
  const startCompare = useCallback(
    async (left: string) => {
      if (otherFileTabs(left).length > 0) {
        setCompareFrom(left);
        return;
      }
      await browseCompareWith(left);
    },
    [browseCompareWith, otherFileTabs]
  );

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
        // Uninstalling clears the verb and every mask, so it gets the full set of known
        // types: a type excluded now may have been written by an earlier build.
        const all = openableExtensions();
        if (installed) {
          const value = await api.installContextMenu(all, settings.excludedExtensions);
          toast(t("menu.added", { value }));
        } else {
          await api.uninstallContextMenu(all);
          toast(t("menu.removed"));
        }
        refreshMenu();
      } catch (e) {
        toast(errorMessage(e));
      } finally {
        setMenuBusy(false);
      }
    },
    [refreshMenu, settings.excludedExtensions, toast]
  );

  const menuTabPath = useMemo(() => {
    if (!tabMenu) return null;
    return tabs.tabs.find((tab) => tab.id === tabMenu.tabId)?.path ?? null;
  }, [tabMenu, tabs.tabs]);

  /**
   * Flip the minimap for one file. The menu is a quick toggle, so it writes a concrete
   * true/false; "follow global" stays reachable through the per-file dialog. Other
   * overrides on the same file are carried over, since saving replaces the whole entry.
   */
  const toggleFileMinimap = useCallback(
    (path: string) => {
      const tab = tabs.tabs.find((t) => t.path === path);
      if (!tab) return;
      const on = tab.fileSettings.minimap ?? settings.minimap;
      void tabs.setFileSettings(path, { ...tab.fileSettings, minimap: !on });
    },
    [settings.minimap, tabs]
  );

  useEffect(() => {
    if (!tabMenu) return;
    const hide = (e: MouseEvent) => {
      const target = e.target as Node | null;
      // Panel switching happens by clicking inside the menu; that must not close it.
      if (target && tabMenuRef.current?.contains(target)) return;
      // A right-click on a tab is TabBar's business: it opens or re-points the menu.
      // Closing here would race the pointerdown that just opened it, because the native
      // contextmenu event arrives after React has already committed the menu.
      if ((target as HTMLElement | null)?.closest?.(".tab")) return;
      setTabMenu(null);
    };
    window.addEventListener("click", hide);
    window.addEventListener("contextmenu", hide);
    // Capture phase, because a press that opens another menu never reaches a bubble-phase
    // listener here: the Explorer rows call `stopPropagation` on their own context menu, and
    // React dispatches from the root container, which sits below the window. Without this the
    // two menus can be on screen at once, one of them dead to the click that raised the other.
    window.addEventListener("mousedown", hide, true);
    const onBlur = () => setTabMenu(null);
    window.addEventListener("blur", onBlur);
    // The blur handler has to come back off too: as an inline arrow it was left
    // attached forever, so every open stacked another one on the window.
    return () => {
      window.removeEventListener("click", hide);
      window.removeEventListener("contextmenu", hide);
      window.removeEventListener("mousedown", hide, true);
      window.removeEventListener("blur", onBlur);
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

  /**
   * Closing is asked for rather than assumed: a tab with unsaved edits has to be answered for
   * first. Everything clean — and a comparison or the Settings panel, which have no buffer at
   * risk — goes straight through.
   */
  const requestClose = useCallback(
    (id: number) => {
      const tab = tabs.tabs.find((t) => t.id === id);
      if (!tab?.dirty) {
        void tabs.closeTab(id);
        return;
      }
      setCloseAsk(id);
    },
    [tabs]
  );

  /** The prompt's answer: the tab only goes if the save it asked for actually happened. */
  const closeAfterSave = useCallback(
    async (id: number) => {
      setCloseAsk(null);
      if (await tabs.saveTab(id)) void tabs.closeTab(id);
    },
    [tabs]
  );

  const closeWithoutSaving = useCallback(
    (id: number) => {
      setCloseAsk(null);
      void tabs.closeTab(id);
    },
    [tabs]
  );

  const { saveActive, openUntitled, openSettings } = tabs;
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
        if (tabs.activeId !== null) requestClose(tabs.activeId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFiles, openUntitled, requestClose, saveActive, tabs.activeId, toggleSidebar]);

  const showSettings = tabs.activeTab?.isSettings === true;
  const sidebarShown = sidebarVisible && !showSettings;
  const editorTab = tabs.editorTab;
  // Per-file overrides win over the global defaults, one field at a time.
  const fileSettingsTab =
    fileSettingsPath === null
      ? null
      : tabs.tabs.find((t) => t.path === fileSettingsPath) ?? null;
  const renderWhitespaceMode = whitespaceMode(
    editorTab?.fileSettings.renderWhitespace ?? settings.renderWhitespace
  );
  // The menu acts on the right-clicked tab, which is not necessarily the active one.
  const menuTab = tabs.tabs.find((t) => t.path === menuTabPath) ?? null;
  /** The tab the unsaved-changes prompt is about; gone if it was closed from elsewhere. */
  const closeAskTab = closeAsk === null ? null : tabs.tabs.find((t) => t.id === closeAsk) ?? null;
  /** Only a real file tab has a path for the path actions (reveal, copy, per-file settings). */
  const menuTabIsFile = !!menuTab && isFileTab(menuTab);
  const menuMinimapOn = menuTab?.fileSettings.minimap ?? settings.minimap;
  const wordWrap = editorTab?.fileSettings.wordWrap ?? settings.wordWrap;
  const stickyScroll = editorTab?.fileSettings.stickyScroll ?? settings.stickyScroll;
  const minimap = editorTab?.fileSettings.minimap ?? settings.minimap;
  const tabSize = editorTab?.fileSettings.tabSize ?? settings.tabSize;
  const insertSpaces = editorTab?.fileSettings.insertSpaces ?? settings.insertSpaces;
  const detectIndentation =
    editorTab?.fileSettings.detectIndentation ?? settings.detectIndentation;
  /**
   * The layout a previewable file opens in. Global rather than per file: it is the answer to
   * "what does opening one of these look like", asked once, and a per-file choice on top of
   * it is what `previewPref` already remembers for the session.
   */
  const previewLayout = settings.previewLayout;

  /**
   * What the preview pane can draw for this file, or null when it has nothing to preview.
   * Markdown and images share the pane; only what fills it differs.
   */
  const previewKind: PreviewKind = editorTab
    ? isMarkdown(editorTab.path)
      ? "markdown"
      : isHtml(editorTab.path)
        ? "html"
        : isPreviewableImage(editorTab.path)
          ? "image"
          : null
    : null;
/**
   * The layout a file opens in when it has no stored choice of its own.
   *
   * A picture is settled before the setting is consulted: its bytes are not text, so
   * "editor only" would put an editable-looking buffer in front of a photo and any keystroke
   * would corrupt it. Everything else that has a preview follows the setting, and a file with
   * nothing to preview is always text. `auto` keeps the per-kind behaviour this replaced —
   * markdown is read as prose, and SVG and HTML are edited as source and read as a rendering
   * of that source, so all three open side by side.
   */
const defaultModeFor = useCallback(
    (path: string): PreviewMode => {
      if (isBitmapImage(path)) return "preview";
      if (!isMarkdown(path) && !isSvg(path) && !isHtml(path)) return "text";
      if (previewLayout === "split" || previewLayout === "preview") return previewLayout;
      if (previewLayout === "text") return "text";
      return "split";
    },
    [previewLayout]
  );
  // A photo has no text to edit, and showing its bytes decoded as text is how an image
  // gets corrupted by a stray keystroke. So for a raster image the layout is not a choice:
  // it is always the picture, and the controls that would change it are not offered.
  const lockedToPicture = !!editorTab && isBitmapImage(editorTab.path);
  // The choice is remembered per file, so a document left in "preview only" reopens that way.
  // A picture cannot opt out of the preview the way a document can: the bytes behind it are
  // not text, and "editor only" would put an editable-looking buffer in front of a photo.
  // A comparison is text and nothing else: it already has two panes of its own.
  const previewMode: PreviewMode = lockedToPicture
    ? "preview"
    : editorTab?.compare
      ? "text"
      : (editorTab && previewPref[editorTab.path]) ||
        (editorTab ? defaultModeFor(editorTab.path) : "text");
  const showEditor = previewMode !== "preview";
  const showPreview = previewMode !== "text" && !!editorTab;
  /** A comparison owns the pane; the text editor is only hidden behind it. */
  const showDiff = !!editorTab?.compare;
  /**
   * A picture that is being shown as text, and the editor is not what should be on screen.
   * Reachable by switching the layout — which used to be a silent no-op from the user's
   * point of view, since the pane simply stayed empty. The hint names the cause and offers
   * the way back, instead of leaving a file that looks broken.
   */
  const showPictureAsText = previewKind === "image" && previewMode === "text" && !lockedToPicture;
  const setPreviewMode = useCallback((mode: PreviewMode) => {
    const path = tabs.activeTab?.path;
    if (!path) return;
    setPreviewPref((prev) => ({ ...prev, [path]: mode }));
  }, [tabs.activeTab?.path]);

  /**
   * Context-menu shortcut: walks the layouts this file actually has instead of a fixed
   * pair, so an SVG reaches every one of them — it is a picture, but it is also text the user
   * may well want to read and edit.
   */
  const togglePreview = useCallback(
    (path: string) => {
      setPreviewPref((prev) => {
        const current = prev[path] ?? defaultModeFor(path);
        if (current === "text") return { ...prev, [path]: defaultModeFor(path) };
        if (current === "preview") return { ...prev, [path]: "split" };
        return { ...prev, [path]: "text" };
      });
    },
    [defaultModeFor]
  );

  /** The preview is the driver when the user scrolls it, so mirror it into the editor. */
  const scrollEditorToRatio = useCallback((ratio: number) => {
    setScrollRatio(ratio);
    const editor = editorRef.current?.editor;
    if (!editor) return;
    const max = editor.getScrollHeight() - editor.getLayoutInfo().height;
    if (max > 0) editor.setScrollTop(max * ratio);
  }, []);

  // A fresh document starts at the top rather than inheriting the last scroll position.
  useEffect(() => {
    setScrollRatio(0);
    // The previous comparison's totals must not linger while the next one computes.
    setDiffStats(null);
  }, [editorTab?.path]);

  /**
   * Monaco measures its own box once and then trusts it, so a pane that changed width
   * without the window changing size — the preview opening beside the editor, or the editor
   * coming back from behind the picture — leaves it scrolling against stale dimensions and
   * the wheel does nothing. Re-measuring on the next frame is the fix, and it has to wait
   * for the browser to have laid the new size out.
   */
  useEffect(() => {
    const raf = requestAnimationFrame(() => editorRef.current?.editor.layout());
    return () => cancelAnimationFrame(raf);
  }, [previewMode, showDiff, editorTab?.path]);

  // Preview text is read straight off the model on every render rather than mirrored
  // into state: `editorRef` is only filled in by `onReady`, which lands after the first
  // render, so an effect that seeds it would see a null handle and never retry. Reading
  // the model for the *current* path also avoids a one-frame flash of the previous file.
  // `setStats` fires on every content change, so this stays in step while typing.
  const docText = (() => {
    const handle = editorRef.current;
    const path = editorTab?.path;
    if (!path) return "";
    if (!handle) {
      // The editor can be unmounted (settings tab is showing). Fall back to the tab's
      // baseline content rather than rendering nothing.
      return editorTab?.original ?? "";
    }
    const model = handle.monaco.editor.getModel(handle.monaco.Uri.parse(modelUri(path)));
    return model?.getValue() ?? editorTab?.original ?? "";
  })();

  return (
    <div
      className="app"
      data-density={settings.compactMode ? "compact" : "cozy"}
      data-theme={theme}
    >
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
        previewMode={
          editorTab && !editorTab.compare && previewKind && !lockedToPicture ? previewMode : null
        }
        onPreviewMode={setPreviewMode}
        onSelect={tabs.selectTab}
        onClose={requestClose}
        onReorder={tabs.moveTab}
        onTabContextMenu={(tabId, x, y) => setTabMenu({ tabId, x, y, panel: "root" })}
        renamingId={renamingTab}
        onRenameTab={renameTab}
        onRenameTabEnd={() => setRenamingTab(null)}
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
          expandFolders={settings.expandFolders}
          expandDepth={settings.expandDepth}
          history={history}
          activePath={editorTab?.path ?? null}
          onSetView={changeView}
          onPickFolder={pickRootFolder}
          onOpenPath={tabs.openPath}
          onCompare={(path) => void startCompare(path)}
          onRename={(target, name) => renameEntry(target.path, name)}
          onRemoveHistory={(path) =>
            api
              .removeHistory(path)
              .then(setHistory)
              .catch((e) => toast(errorMessage(e)))
          }
          onReveal={(path) => {
            revealItemInDir(path).catch((e) => toast(errorMessage(e)));
          }}
          onSetRoot={(dir) => {
            setSidebarView("explorer");
            setSidebarVisible(true);
            setSidebarRoot(dir);
          }}
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

        <div
          className={`editor-wrap${
            previewMode === "split" ? " split" : previewMode === "preview" ? " preview-only" : ""
          }`}
        >
          {/* The editor stays mounted in preview-only mode and is only hidden: unmounting
              would let @monaco-editor/react dispose the model, and the live buffer —
              unsaved edits and undo stack included — exists only in that model.
              `automaticLayout` re-measures it once it becomes visible again. */}
          {tabs.fileTab && (
            <div
              className="editor-host"
              style={{
                display: showSettings || !showEditor || showDiff ? "none" : "block",
              }}
            >
              <Editor
                tab={tabs.fileTab}
                fontSize={settings.fontSize}
                minimap={minimap}
                renderWhitespace={renderWhitespaceMode}
                wordWrap={wordWrap}
                stickyScroll={stickyScroll}
                tabSize={tabSize}
                insertSpaces={insertSpaces}
                detectIndentation={detectIndentation}
                scrollBeyondLastLine={settings.scrollBeyondLastLine}
              theme={theme}
                onChange={tabs.onEditorChange}
                onCursor={(position, offset) => {
                  setCursor({ line: position.lineNumber, column: position.column });
                  tabs.onCursorChange(offset);
                }}
                onStats={setStats}
                onScrollRatio={setScrollRatio}
                onReady={(handle) => {
                  editorRef.current = handle;
                }}
              />
            </div>
          )}

          {/* A comparison takes the pane but never replaces the editor above: that one
              holds the file's live buffer, and unmounting it would dispose the model. */}
          {showDiff && editorTab?.compare && (
            <div className="editor-host">
              <DiffView
                // Keyed by the ordered pair: swapping the sides remounts the view, which
                // is what releases the two models it had attached. Re-pointing the model
                // paths alone would detach them without disposing, and the library only
                // disposes the models attached at unmount.
                key={`${editorTab.compare.left.path}|${editorTab.compare.right.path}`}
                pair={editorTab.compare}
                fontSize={settings.fontSize}
                renderWhitespace={renderWhitespaceMode}
                wordWrap={wordWrap}
                tabSize={tabSize}
                insertSpaces={insertSpaces}
                detectIndentation={detectIndentation}
                scrollBeyondLastLine={settings.scrollBeyondLastLine}
                onStats={setDiffStats}
              />
            </div>
          )}

          {showPreview && !showSettings && editorTab && previewKind === "image" && (
            <ImagePreview path={editorTab.path} text={isSvg(editorTab.path) ? docText : null} />
          )}

          {showPictureAsText && editorTab && (
            <div className="pane-hint">
              <span>{t("preview.hintImage")}</span>
              <button
                className="btn small"
                onClick={() => setPreviewMode(defaultModeFor(editorTab.path))}
              >
                {t("preview.hintShow")}
              </button>
            </div>
          )}

          {showPreview && !showSettings && editorTab && previewKind === "markdown" && (
            <MarkdownPreview
              text={docText}
              path={editorTab.path}
              scrollRatio={scrollRatio}
              onScrollRatio={scrollEditorToRatio}
              beyondEnd={settings.scrollBeyondLastLine}
              theme={theme}
            />
          )}

          {showPreview && !showSettings && editorTab && previewKind === "html" && (
            <HtmlPreview
              text={docText}
              path={editorTab.path}
              scrollRatio={scrollRatio}
              onScrollRatio={scrollEditorToRatio}
              beyondEnd={settings.scrollBeyondLastLine}
            />
          )}

          {!editorTab && !showDiff && <div className="editor-empty">{t("app.empty")}</div>}

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

      <StatusBar
        tab={tabs.activeTab}
        line={cursor.line}
        column={cursor.column}
        stats={stats}
        diff={diffStats}
      />

      {tabMenu && menuTabPath && (
        <div
          className="ctx-menu"
          ref={tabMenuRef}
          style={{ display: "block", left: tabMenu.x, top: tabMenu.y }}
        >
          {tabMenu.panel === "root" && !menuTabIsFile ? (
            /* A comparison or the Settings panel is not a file, so every path action in
               the full menu would be meaningless on it. What still applies: swapping the
               two sides, and closing. */
            <>
              {menuTab?.compare && (
                <div
                  className="ctx-item"
                  onClick={() => {
                    tabs.swapCompare(menuTab.id);
                    setTabMenu(null);
                  }}
                >
                  {t("cmp.swap")}
                </div>
              )}
              <div
                className="ctx-item"
                onClick={() => {
                  if (menuTab) requestClose(menuTab.id);
                  setTabMenu(null);
                }}
              >
                {t("tab.close")}
              </div>
            </>
          ) : tabMenu.panel === "root" ? (
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
              {/* Both of these act on a file that is on disk: an unsaved buffer has no entry
                  to rename, and nothing to read the other file against. */}
              {menuTabIsFile && !isUntitled(menuTabPath) && (
                <>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      setRenamingTab(tabMenu.tabId);
                      setTabMenu(null);
                    }}
                  >
                    {t("side.menuRename")}
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      void startCompare(menuTabPath);
                      setTabMenu(null);
                    }}
                  >
                    {t("cmp.menu")}
                  </div>
                </>
              )}
              <div
                className="ctx-item"
                onClick={() => {
                  setTabMenu(null);
                  setFileSettingsFor(menuTabPath);
                }}
              >
                {t("title.menuFileSettings")}
              </div>
              <div
                className="ctx-item"
                onClick={() => {
                  if (menuTabPath) toggleFileMinimap(menuTabPath);
                  setTabMenu(null);
                }}
              >
                <span className="ctx-tick">{menuMinimapOn ? "✓" : ""}</span>
                {t("title.menuMinimap")}
              </div>
              {/* A raster image has no text pane to toggle to, so it is not offered. */}
              {!isBitmapImage(menuTabPath) && (
                <div
                  className="ctx-item"
                  onClick={() => {
                    if (menuTabPath) togglePreview(menuTabPath);
                    setTabMenu(null);
                  }}
                >
                  <span className="ctx-tick">
                    {menuTabPath &&
                    (previewPref[menuTabPath] ?? defaultModeFor(menuTabPath)) !== "text"
                      ? "✓"
                      : ""}
                  </span>
                  {t("title.menuPreview")}
                </div>
              )}
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

      {fileSettingsTab && (
        <FileSettingsDialog
          path={fileSettingsTab.path}
          name={fileSettingsTab.name}
          detectedEncoding={fileSettingsTab.encoding}
          onSave={(p, next) => tabs.setFileSettings(p, next)}
          onClose={() => setFileSettingsPath(null)}
          onError={toast}
        />
      )}

      {compareFrom && (
        <ComparePickerDialog
          leftPath={compareFrom}
          leftName={basename(compareFrom)}
          candidates={otherFileTabs(compareFrom)}
          onPick={(right) => {
            setCompareFrom(null);
            void tabs.openCompare(compareFrom, right);
          }}
          onBrowse={() => {
            const left = compareFrom;
            setCompareFrom(null);
            void browseCompareWith(left);
          }}
          onCancel={() => setCompareFrom(null)}
        />
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

      {closeAskTab && (
        <CloseConfirmDialog
          tab={closeAskTab}
          onSave={() => void closeAfterSave(closeAskTab.id)}
          onDiscard={() => closeWithoutSaving(closeAskTab.id)}
          onCancel={() => setCloseAsk(null)}
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
