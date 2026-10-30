import { Fragment, useCallback, useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { check, type Update } from "@tauri-apps/plugin-updater";
import logoUrl from "../../branding/logo.svg";
import { formatWhen, LANGUAGES, t } from "../lib/i18n";
import { parseExtensionList } from "../lib/path";
import { LINE_ENDINGS } from "../lib/types";
import SettingCheck from "./SettingCheck";
import SettingField from "./SettingField";
import BackdropPicker from "./BackdropPicker";
import {
  api,
  errorMessage,
  openPath,
  pickFolder,
  type BackupInfo,
  type BackupList,
  type GitAuthView,
  type MenuTarget,
  type Settings,
  type StoreDirs,
} from "../lib/tauri";

type Category = "context" | "general" | "versions" | "git" | "backups" | "encryption" | "about";

interface Props {
  settings: Settings;
  menu: MenuTarget | null;
  menuBusy: boolean;
  onSaveSettings: (patch: Partial<Settings>) => void | Promise<unknown>;
  onSetMenu: (installed: boolean) => void;
  /** Says what a change here did, which for the credential store is the only report there is. */
  onToast: (message: string) => void;
  /** Called after the version store is emptied so the sidebar stops listing files that have none. */
  onVersionsChanged?: () => void;
  /** Replaces the state with a snapshot; the app reloads when this resolves. */
  onRestoreBackup: (path: string) => Promise<void>;
}

const NAV: { cat: Category; key: string }[] = [
  { cat: "general", key: "settings.catGeneral" },
  { cat: "context", key: "settings.catContext" },
  { cat: "versions", key: "ver.category" },
  { cat: "git", key: "settings.catGit" },
  { cat: "backups", key: "settings.catBackups" },
  { cat: "encryption", key: "enc.category" },
  { cat: "about", key: "settings.catAbout" },
];

/** The three kinds of snapshot, keyed by the kind the backend records. */
const BACKUP_KIND: Record<string, string> = {
  auto: "backup.kindAuto",
  manual: "backup.kindManual",
  "pre-restore": "backup.kindPreRestore",
};

/** Bytes as the About page and the status bar read them: 1024-based, at most one decimal. */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Idle limits offered, in minutes, with 0 last because it is the one that turns the lock off.
 *
 * A list rather than a number field: "never" has no minute count to type, and a field that
 * took 0 for it would show a bare `0` where the choice deserves a word.
 */
const IDLE_MINUTES = [5, 10, 30, 60, 240, 0];

const WHITESPACE_MODES = ["none", "boundary", "selection", "all", "trailing"] as const;
/** `auto` last: it is the fallback that decides by file type, not a layout of its own. */
const PREVIEW_LAYOUTS = ["text", "split", "preview", "auto"] as const;
const PREVIEW_WIDTHS = ["narrow", "wide", "full"] as const;
/** Right first: it is the default, and it keeps the outline off the Explorer's edge. */
const TOC_SIDES = ["right", "left"] as const;
/** Slideshow paces, in seconds. A select rather than a number field for the same reason as
 * the idle limits: these are the paces worth offering, and a typed 0 has no meaning. */
const GALLERY_INTERVALS = [2, 3, 5, 8, 10, 15, 30] as const;
const THEMES = ["system", "dark", "light"] as const;
/** `auto` first: it is the default, and `ask` is the opt-in for anyone who wants to see each draft before it lands. */
const DRAFT_MODES = ["auto", "ask"] as const;
const ENCODINGS = [
  "auto",
  "utf-8",
  "gbk",
  "gb18030",
  "big5",
  "shift-jis",
  "euc-kr",
  "utf-16le",
  "utf-16be",
];

/**
 * The size units the largest-file setting offers, 1024-based like the status bar's readout.
 *
 * The stored value is always bytes — the backend limit is a byte count and nothing else reads
 * this setting — so a unit is only how the field is written and read back. GB is left out on
 * purpose: the ceiling on the setting is 32 MB, and a unit that can only be chosen past it is
 * a choice that cannot be used.
 */
const SIZE_UNITS = [
  { key: "B", factor: 1 },
  { key: "KB", factor: 1024 },
  { key: "MB", factor: 1024 * 1024 },
] as const;

type SizeUnitKey = (typeof SIZE_UNITS)[number]["key"];

/** The unit a byte count reads in most naturally: the smallest one where it is at least 1. */
function sizeUnitOf(bytes: number): SizeUnitKey {
  if (bytes >= 1024 * 1024) return "MB";
  return bytes >= 1024 ? "KB" : "B";
}

export default function SettingsPanel({
  settings,
  menu,
  menuBusy,
  onSaveSettings,
  onSetMenu,
  onToast,
  onVersionsChanged,
  onRestoreBackup,
}: Props) {
  // The first entry in NAV, so opening Settings lands on it rather than on the second one.
  const [category, setCategory] = useState<Category>("general");
  const [version, setVersion] = useState("…");
  /**
   * Update check state. The `Update` handle is kept because installing needs the same object
   * the check returned; a second check while one is on screen would replace it, so the button
   * is disabled for the duration.
   */
  const [updatePhase, setUpdatePhase] = useState<
    "idle" | "checking" | "available" | "latest" | "downloading" | "installing"
  >("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ done: number; total: number } | null>(null);
  /** The two storage folders, or null while the backend has not said where they are. */
  const [dirs, setDirs] = useState<StoreDirs | null>(null);
  const [dirsError, setDirsError] = useState<string | null>(null);
  /**
   * Whether the button that empties the version store is armed. Two clicks because what it
   * deletes cannot be got back: the history is the only copy of those earlier texts.
   */
  const [versionsArmed, setVersionsArmed] = useState(false);
  /** How many passwords the credential store is holding, or null when it would not say. */
  const [remembered, setRemembered] = useState<number | null>(null);
  const [rememberedError, setRememberedError] = useState<string | null>(null);
  /** Snapshots on disk, or null when the folder could not be read. */
  const [backups, setBackups] = useState<BackupList | null>(null);
  const [backupError, setBackupError] = useState<string | null>(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [gitAuth, setGitAuth] = useState<GitAuthView | null>(null);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  /** The snapshot a second, explicit click would restore. */
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null);
  // The exclusion list is typed as free text, so what is being edited and what is stored
  // are two things: `excludedText` is the field's own state (it takes `png, JPG` and
  // `.png` alike) and is only parsed on the way out. The stored value is written back into
  // the field whenever it changes elsewhere, which is also how a rejected entry gets
  // corrected instead of being left on screen looking saved.
  const joined = settings.excludedExtensions.join(", ");
  const [excludedText, setExcludedText] = useState(joined);
  useEffect(() => setExcludedText(joined), [joined]);

  /**
   * The unit the largest-file field is written in. Starts wherever the stored value reads best
   * and belongs to the reader from then on; both controls write the same bytes back, so the
   * field always shows what is stored rather than what was typed.
   */
  const [sizeUnit, setSizeUnit] = useState<SizeUnitKey>(() =>
    sizeUnitOf(settings.versioningMaxFileSize)
  );
  const sizeFactor = SIZE_UNITS.find((u) => u.key === sizeUnit)?.factor ?? 1;

  const commitExcluded = (text: string) => {
    const list = parseExtensionList(text);
    // Compared as text: the order of a list the user cannot see is not a change worth a
    // registry rewrite.
    if (list.join(",") === settings.excludedExtensions.join(",")) {
      setExcludedText(joined);
      return;
    }
    onSaveSettings({ excludedExtensions: list });
  };

  // Read the packaged version instead of hardcoding it, so About cannot drift from tauri.conf.json.
  // The folders are read at the same moment: both are things only the running build knows, and
  // the About page is small enough that a second call costs nothing.
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
    api
      .getStoreDirs()
      .then((found) => {
        setDirs(found);
        setDirsError(null);
      })
      .catch((e) => setDirsError(errorMessage(e)));
  }, []);

  /**
   * Ask the release endpoint whether a newer version exists.
   *
   * A failed check is a toast rather than state on the page: offline, no release yet, and a
   * malformed latest.json are all things the row cannot act on, and an idle row after a toast
   * is less alarming than one frozen on an error.
   */
  const checkForUpdate = async () => {
    setUpdatePhase("checking");
    setUpdate(null);
    setUpdateProgress(null);
    try {
      const found = await check();
      if (found) {
        // The handle is a Rust resource; a second check makes the first one unreachable.
        if (update) void update.close();
        setUpdate(found);
        setUpdatePhase("available");
      } else {
        setUpdatePhase("latest");
      }
    } catch (e) {
      setUpdatePhase("idle");
      onToast(errorMessage(e));
    }
  };

  /**
   * Download the update and hand it to the installer.
   *
   * On Windows the passive installer takes over and restarts the app, so anything after the
   * await only runs when it finished without closing this process.
   */
  const installUpdate = async () => {
    if (!update) return;
    setUpdatePhase("downloading");
    setUpdateProgress({ done: 0, total: 0 });
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setUpdateProgress({ done: 0, total: event.data.contentLength ?? 0 });
        } else if (event.event === "Progress") {
          setUpdateProgress((prev) =>
            prev ? { done: prev.done + event.data.chunkLength, total: prev.total } : prev
          );
        } else {
          setUpdatePhase("installing");
        }
      });
      setUpdatePhase("available");
    } catch (e) {
      setUpdatePhase("available");
      onToast(errorMessage(e));
    }
  };

  const updatePercent =
    updateProgress && updateProgress.total > 0
      ? Math.min(100, Math.round((updateProgress.done / updateProgress.total) * 100))
      : 0;

  /**
   * Hand one of those folders to the shell. Only the two paths the backend just returned are
   * ever passed here — `opener:allow-open-path` opens a path with its registered application,
   * which is why nothing from a document or a click is allowed to reach it.
   */
  const openFolder = (path?: string) => {
    if (path) openPath(path).catch((e) => onToast(errorMessage(e)));
  };

  /**
   * Ask the credential store how much it is holding.
   *
   * Read when the panel opens rather than when the encryption page is chosen: it is one call,
   * and a count that arrives a beat after the click reads as a page still loading. Only the
   * number is ever asked for, never the passwords themselves — those stay in Rust.
   */
  const readRemembered = () => {
    api
      .rememberedPasswordCount()
      .then((n) => {
        setRemembered(n);
        setRememberedError(null);
      })
      .catch((e) => {
        setRemembered(null);
        setRememberedError(errorMessage(e));
      });
  };
  useEffect(() => {
    readRemembered();
  }, []);

  /** Read the snapshot list. A folder change calls this again once the setting is written. */
  const refreshBackups = useCallback(() => {
    api
      .listConfigBackups()
      .then((list) => {
        setBackups(list);
        setBackupError(null);
      })
      .catch((e) => {
        setBackups(null);
        setBackupError(errorMessage(e));
      });
  }, []);
  useEffect(() => {
    refreshBackups();
  }, [refreshBackups]);

  /**
   * Change the folder and read the list only once the setting is on disk: the backend resolves
   * the folder from that file, so asking sooner would describe the one being replaced.
   */
  const saveBackupDir = (dir: string) => {
    Promise.resolve(onSaveSettings({ backupDir: dir }))
      .then(refreshBackups)
      .catch((e) => onToast(errorMessage(e)));
  };

  const chooseBackupDir = () => {
    pickFolder()
      .then((picked) => {
        if (picked) saveBackupDir(picked);
      })
      .catch((e) => onToast(errorMessage(e)));
  };

  const loadGitAuth = useCallback(() => {
    api
      .gitAuthView()
      .then((view) => {
        setGitAuth(view);
        setGitName(view.identity?.name ?? "");
        setGitEmail(view.identity?.email ?? "");
      })
      .catch((e) => onToast(errorMessage(e)));
  }, [onToast]);

  useEffect(() => {
    if (category === "git" && !gitAuth) loadGitAuth();
  }, [category, gitAuth, loadGitAuth]);

  const saveGitIdentity = async () => {
    if (gitBusy || !gitName.trim() || !gitEmail.trim()) return;
    setGitBusy(true);
    try {
      await api.gitSaveIdentity(gitName.trim(), gitEmail.trim());
      loadGitAuth();
    } catch (e) {
      onToast(errorMessage(e));
    } finally {
      setGitBusy(false);
    }
  };

  const clearGitIdentity = async () => {
    try {
      await api.gitClearIdentity();
      loadGitAuth();
    } catch (e) {
      onToast(errorMessage(e));
    }
  };

  const forgetGitCredential = async (host: string) => {
    try {
      await api.gitForgetCredential(host);
      loadGitAuth();
    } catch (e) {
      onToast(errorMessage(e));
    }
  };

  const forgetGitHost = async (host: string) => {
    try {
      await api.gitForgetHost(host);
      loadGitAuth();
    } catch (e) {
      onToast(errorMessage(e));
    }
  };

  const backupNow = () => {
    if (backupBusy) return;
    setBackupBusy(true);
    api
      .createConfigBackup()
      .then((info) => {
        onToast(t("backup.done", { file: info.file }));
        refreshBackups();
      })
      .catch((e) => onToast(errorMessage(e)))
      .finally(() => setBackupBusy(false));
  };

  /**
   * Restore the picked snapshot. Success reloads the window, so only a failure returns here;
   * the confirmation stays up so the same choice can be tried again.
   */
  const restoreNow = () => {
    if (!restoreTarget || backupBusy) return;
    setBackupBusy(true);
    onRestoreBackup(restoreTarget.path).catch((e) => {
      setBackupBusy(false);
      onToast(errorMessage(e));
    });
  };

  const clearRemembered = () => {
    api
      .clearRememberedPasswords()
      .then((n) => {
        setRemembered(0);
        setRememberedError(null);
        onToast(t("enc.clearedRemembered", { n: String(n) }));
      })
      .catch((e) => {
        setRemembered(null);
        setRememberedError(errorMessage(e));
      });
  };

  /**
   * Empty the version store. The first click only arms the button; the second one deletes.
   *
   * Arming is dropped after a few seconds rather than left set: a button that stays armed until
   * something else is clicked is one misclick away from the thing the confirmation exists to stop.
   */
  const clearVersions = () => {
    if (!versionsArmed) {
      setVersionsArmed(true);
      return;
    }
    setVersionsArmed(false);
    api
      .clearVersions()
      .then(() => {
        onVersionsChanged?.();
        onToast(t("ver.cleared"));
      })
      .catch((e) => onToast(errorMessage(e)));
  };

  useEffect(() => {
    if (!versionsArmed) return;
    const off = window.setTimeout(() => setVersionsArmed(false), 8000);
    return () => window.clearTimeout(off);
  }, [versionsArmed]);

  return (
    <div className="settings-panel" style={{ display: "flex" }}>
      <aside className="settings-side">
        <div className="settings-nav-title">{t("settings.nav")}</div>
        {NAV.map((item) => (
          <button
            key={item.cat}
            className={`settings-nav-item${category === item.cat ? " active" : ""}`}
            onClick={() => setCategory(item.cat)}
          >
            {t(item.key)}
          </button>
        ))}
      </aside>

      <div className="settings-content">
        {category === "context" && (
          <div className="settings-cat">
            <h2>{t("settings.contextHeading")}</h2>
            <div className="setting-group">
              <SettingCheck
                label={t("settings.contextAdd")}
                checked={menu?.installed ?? false}
                disabled={menuBusy}
                onChange={onSetMenu}
                description={t("settings.contextDesc")}
              />
              <p className="muted">
                {menuBusy
                  ? t("settings.contextBusy")
                  : menu?.installed
                    ? t("settings.contextRegistered", { n: menu.excludedCount })
                    : t("settings.contextMissing")}
              </p>
              <SettingField label={t("settings.menuExclude")}>
                <input
                  className="settings-text"
                  type="text"
                  spellCheck={false}
                  value={excludedText}
                  placeholder={t("settings.menuExcludePlaceholder")}
                  onChange={(e) => setExcludedText(e.target.value)}
                  onBlur={() => commitExcluded(excludedText)}
                  onKeyDown={(e) => {
                    // Applied on blur too, so Enter is a shortcut rather than the only way
                    // to commit — a field that needs Enter would look broken otherwise.
                    if (e.key === "Enter") {
                      commitExcluded(excludedText);
                      e.currentTarget.blur();
                    }
                    if (e.key === "Escape") {
                      setExcludedText(joined);
                      e.currentTarget.blur();
                    }
                  }}
                />
              </SettingField>
              <p className="muted">{t("settings.menuExcludeDesc")}</p>
              {menu?.staleLayout && <p className="setting-warn">{t("settings.warnLayout")}</p>}
              {menu?.registered && (
                <div className="setting-target">
                  <div className="setting-desc">{t("settings.currentlyLaunches")}</div>
                  <code>{menu.registered}</code>
                </div>
              )}
              {menu?.installed && !menu.matchesCurrent && (
                <p className="setting-warn">{t("settings.warnStale")}</p>
              )}
              {menu?.debugBuild && <p className="setting-warn">{t("settings.warnDebug")}</p>}
            </div>
          </div>
        )}

        {category === "general" && (
          <div className="settings-cat">
            <h2>{t("settings.generalHeading")}</h2>
            <div className="setting-group">
              <SettingField label={t("settings.language")}>
                <select
                  className="select"
                  value={settings.language}
                  onChange={(e) => onSaveSettings({ language: e.target.value })}
                >
                  {LANGUAGES.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.languageDesc")}</p>
              <SettingField label={t("settings.fontSize")}>
                <input
                  type="number"
                  min={10}
                  max={32}
                  value={settings.fontSize}
                  onChange={(e) => {
                    const size = Number(e.target.value);
                    if (!Number.isNaN(size)) onSaveSettings({ fontSize: size });
                  }}
                />
              </SettingField>
              {/* The same shape as the editor's own size, but clamped before it is stored: the
                  range belongs to the app, and a browser's own limit message arrives in the
                  interface language of the engine rather than the one this app is showing. */}
              <SettingField label={t("settings.sidebarFont")}>
                <input
                  type="number"
                  value={settings.sidebarFont}
                  onChange={(e) => {
                    const size = Number(e.target.value);
                    if (Number.isNaN(size)) return;
                    // Stored whether or not it changed: saving the clamped number is also what
                    // puts that number back into the box, so the field never shows a size the app
                    // is not using.
                    onSaveSettings({ sidebarFont: Math.min(Math.max(size, 11), 20) });
                  }}
                />
              </SettingField>
              <p className="muted">{t("settings.sidebarFontDesc")}</p>
              <SettingCheck
                label={t("settings.minimap")}
                checked={settings.minimap}
                onChange={(v) => onSaveSettings({ minimap: v })}
              />
              <SettingCheck
                label={t("settings.restoreSession")}
                checked={settings.restoreSession}
                onChange={(v) => onSaveSettings({ restoreSession: v })}
              />
              <p className="muted">{t("settings.restoreSessionDesc")}</p>
              <SettingCheck
                label={t("settings.compareReuseTab")}
                checked={settings.compareReuseTab}
                onChange={(v) => onSaveSettings({ compareReuseTab: v })}
              />
              <p className="muted">{t("settings.compareReuseTabDesc")}</p>
              <SettingField label={t("settings.draftRestore")}>
                <select
                  className="select"
                  value={settings.draftRestore}
                  onChange={(e) => onSaveSettings({ draftRestore: e.target.value })}
                >
                  {DRAFT_MODES.map((option) => (
                    <option key={option} value={option}>
                      {t(`settings.draftRestore.${option}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.draftRestoreDesc")}</p>
              <SettingCheck
                label={t("settings.expandFolders")}
                checked={settings.expandFolders}
                onChange={(v) => onSaveSettings({ expandFolders: v })}
              />
              <SettingField label={t("settings.expandDepth")}>
                <input
                  type="number"
                  min={1}
                  max={8}
                  disabled={!settings.expandFolders}
                  value={settings.expandDepth}
                  onChange={(e) => {
                    const depth = Number(e.target.value);
                    if (!Number.isNaN(depth) && depth >= 1) onSaveSettings({ expandDepth: depth });
                  }}
                />
              </SettingField>
              <p className="muted">{t("settings.expandFoldersDesc")}</p>
              <SettingCheck
                label={t("settings.compactMode")}
                checked={settings.compactMode}
                onChange={(v) => onSaveSettings({ compactMode: v })}
              />
              <p className="muted">{t("settings.compactModeDesc")}</p>
              <SettingField label={t("settings.renderWhitespace")}>
                <select
                  className="select"
                  value={settings.renderWhitespace}
                  onChange={(e) => onSaveSettings({ renderWhitespace: e.target.value })}
                >
                  {WHITESPACE_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`settings.whitespace.${mode}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <SettingField label={t("settings.previewLayout")}>
                <select
                  className="select"
                  value={settings.previewLayout}
                  onChange={(e) => onSaveSettings({ previewLayout: e.target.value })}
                >
                  {PREVIEW_LAYOUTS.map((layout) => (
                    <option key={layout} value={layout}>
                      {t(`settings.layout.${layout}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.previewLayoutDesc")}</p>
              <SettingField label={t("settings.previewWidth")}>
                <select
                  className="select"
                  value={settings.previewWidth}
                  onChange={(e) => onSaveSettings({ previewWidth: e.target.value })}
                >
                  {PREVIEW_WIDTHS.map((width) => (
                    <option key={width} value={width}>
                      {t(`settings.width.${width}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.previewWidthDesc")}</p>
              <SettingField label={t("settings.tocSide")}>
                <select
                  className="select"
                  value={settings.tocSide}
                  onChange={(e) => onSaveSettings({ tocSide: e.target.value })}
                >
                  {TOC_SIDES.map((side) => (
                    <option key={side} value={side}>
                      {t(`settings.tocSide.${side}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.tocSideDesc")}</p>
              <SettingField label={t("settings.galleryInterval")}>
                <select
                  className="select"
                  value={settings.galleryInterval}
                  onChange={(e) =>
                    onSaveSettings({
                      galleryInterval: Number(e.target.value),
                    })
                  }
                >
                  {GALLERY_INTERVALS.map((sec) => (
                    <option key={sec} value={sec}>
                      {t("settings.gallerySeconds", { n: sec })}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.galleryIntervalDesc")}</p>
              <SettingCheck
                label={t("settings.galleryLoop")}
                checked={settings.galleryLoop}
                onChange={(v) => onSaveSettings({ galleryLoop: v })}
                description={t("settings.galleryLoopDesc")}
              />
              <SettingField label={t("settings.imageBackdrop")}>
                <BackdropPicker
                  value={settings.imageBackdrop}
                  onChange={(v) => onSaveSettings({ imageBackdrop: v })}
                />
              </SettingField>
              <p className="muted">{t("settings.imageBackdropDesc")}</p>
              <SettingCheck
                label={t("settings.wordWrap")}
                checked={settings.wordWrap}
                onChange={(v) => onSaveSettings({ wordWrap: v })}
              />
              <SettingCheck
                label={t("settings.stickyScroll")}
                checked={settings.stickyScroll}
                onChange={(v) => onSaveSettings({ stickyScroll: v })}
              />
              <p className="muted">{t("settings.stickyScrollDesc")}</p>
              <SettingField label={t("settings.tabSize")}>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={settings.tabSize}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (!Number.isNaN(n) && n >= 1) onSaveSettings({ tabSize: n });
                  }}
                />
              </SettingField>
              <SettingCheck
                label={t("settings.insertSpaces")}
                checked={settings.insertSpaces}
                onChange={(v) => onSaveSettings({ insertSpaces: v })}
              />
              <SettingCheck
                label={t("settings.detectIndentation")}
                checked={settings.detectIndentation}
                onChange={(v) => onSaveSettings({ detectIndentation: v })}
              />
              <p className="muted">{t("settings.detectIndentationDesc")}</p>
              <SettingCheck
                label={t("settings.scrollBeyondLastLine")}
                checked={settings.scrollBeyondLastLine}
                onChange={(v) => onSaveSettings({ scrollBeyondLastLine: v })}
              />
              <p className="muted">{t("settings.scrollBeyondLastLineDesc")}</p>
              <SettingField label={t("settings.encoding")}>
                <select
                  className="select"
                  value={settings.encoding}
                  onChange={(e) => onSaveSettings({ encoding: e.target.value })}
                >
                  {ENCODINGS.map((enc) => (
                    <option key={enc} value={enc}>
                      {t(`settings.enc.${enc}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.encodingDesc")}</p>
              <SettingField label={t("settings.lineEnding")}>
                <select
                  className="select"
                  value={settings.lineEnding}
                  onChange={(e) => onSaveSettings({ lineEnding: e.target.value })}
                >
                  {LINE_ENDINGS.map((option) => (
                    <option key={option} value={option}>
                      {t(`settings.lineEnding.${option}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.lineEndingDesc")}</p>
              <SettingCheck
                label={t("settings.trimTrailing")}
                checked={settings.trimTrailingWhitespace}
                onChange={(v) => onSaveSettings({ trimTrailingWhitespace: v })}
              />
              <p className="muted">{t("settings.trimTrailingDesc")}</p>
              <SettingCheck
                label={t("settings.finalNewline")}
                checked={settings.insertFinalNewline}
                onChange={(v) => onSaveSettings({ insertFinalNewline: v })}
              />
              <p className="muted">{t("settings.finalNewlineDesc")}</p>
              <SettingCheck
                label={t("settings.autoSave")}
                checked={settings.autoSave}
                onChange={(v) => onSaveSettings({ autoSave: v })}
              />
              <SettingField label={t("settings.autoSaveInterval")}>
                <input
                  type="number"
                  min={1}
                  max={3600}
                  step={1}
                  disabled={!settings.autoSave}
                  value={settings.autoSaveInterval}
                  onChange={(e) => {
                    const sec = Math.trunc(Number(e.target.value));
                    if (Number.isNaN(sec) || sec < 1) return;
                    onSaveSettings({ autoSaveInterval: Math.min(sec, 3600) });
                  }}
                />
              </SettingField>
              <p className="muted">{t("settings.autoSaveDesc")}</p>
              <SettingField label={t("settings.theme")}>
                <select
                  className="select"
                  value={settings.theme}
                  onChange={(e) => onSaveSettings({ theme: e.target.value })}
                >
                  {THEMES.map((option) => (
                    <option key={option} value={option}>
                      {t(`settings.theme.${option}`)}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("settings.persisted")}</p>
            </div>
          </div>
        )}

        {category === "git" && (
          <div className="settings-cat git-settings">
            <h2>{t("git.settingsHeading")}</h2>
            <p className="muted">{t("git.settingsHint")}</p>
            <div className="setting-group">
              <h3>{t("git.settingsScan")}</h3>
              <p className="muted">{t("git.settingsScanDesc")}</p>
              <SettingField label={t("git.settingsScanDepth")}>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={settings.gitScanDepth}
                  onChange={(e) => {
                    const depth = Number(e.target.value);
                    if (Number.isNaN(depth)) return;
                    onSaveSettings({ gitScanDepth: Math.min(Math.max(depth, 0), 5) });
                  }}
                />
              </SettingField>
            </div>
            <div className="setting-group">
              <h3>{t("git.settingsIdentity")}</h3>
              <p className="muted">{t("git.settingsIdentityDesc")}</p>
              <SettingField label={t("git.identityName")}>
                <input className="settings-text" value={gitName} onChange={(e) => setGitName(e.target.value)} />
              </SettingField>
              <SettingField label={t("git.identityEmail")}>
                <input className="settings-text" value={gitEmail} onChange={(e) => setGitEmail(e.target.value)} />
              </SettingField>
              <div className="git-setting-actions">
                <button
                  className="btn"
                  disabled={gitBusy || !gitName.trim() || !gitEmail.trim()}
                  onClick={() => void saveGitIdentity()}
                >
                  {t("git.identitySave")}
                </button>
                {gitAuth?.identity && (
                  <button className="btn" disabled={gitBusy} onClick={() => void clearGitIdentity()}>
                    {t("git.identityClear")}
                  </button>
                )}
              </div>
            </div>
            <div className="setting-group">
              <h3>{t("git.settingsCredentials")}</h3>
              {(gitAuth?.credentials.length ?? 0) === 0 ? (
                <p className="muted">{t("git.settingsNoCredentials")}</p>
              ) : (
                gitAuth!.credentials.map((credential) => (
                  <div key={`${credential.kind}:${credential.host}`} className="git-setting-row">
                    <span className="git-setting-name">
                      {credential.host} · {credential.kind}
                      {credential.username ? ` · ${credential.username}` : ""}
                      {credential.keyPath ? ` · ${credential.keyPath}` : ""}
                    </span>
                    <button className="btn" onClick={() => void forgetGitCredential(credential.host)}>
                      {t("git.settingsForget")}
                    </button>
                  </div>
                ))
              )}
            </div>
            <div className="setting-group">
              <h3>{t("git.settingsHosts")}</h3>
              {(gitAuth?.knownHosts.length ?? 0) === 0 ? (
                <p className="muted">{t("git.settingsNoHosts")}</p>
              ) : (
                gitAuth!.knownHosts.map((host) => (
                  <div key={host.host} className="git-setting-row">
                    <span className="git-setting-name" title={host.fingerprint}>
                      {host.host} · {host.fingerprint.slice(0, 16)}…
                    </span>
                    <button className="btn" onClick={() => void forgetGitHost(host.host)}>
                      {t("git.settingsForget")}
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {category === "backups" && (
          <div className="settings-cat">
            <h2>{t("backup.heading")}</h2>
            <div className="setting-group">
              <p className="muted">{t("backup.desc")}</p>
              <SettingField label={t("backup.dir")}>
                <button className="btn small" onClick={chooseBackupDir}>
                  {t("backup.changeDir")}
                </button>
              </SettingField>
              <p className="muted store-path">
                {settings.backupDir || backups?.dir || ""}
              </p>
              {!settings.backupDir && <p className="muted">{t("backup.defaultHint")}</p>}
              {settings.backupDir && (
                <button className="btn small backup-reset" onClick={() => saveBackupDir("")}>
                  {t("backup.useDefault")}
                </button>
              )}
              <SettingField label={t("backup.retain")}>
                <input
                  type="number"
                  step={1}
                  value={settings.backupRetain}
                  onChange={(e) => {
                    const n = Math.trunc(Number(e.target.value));
                    if (Number.isNaN(n)) return;
                    onSaveSettings({ backupRetain: Math.min(Math.max(n, 1), 100) });
                  }}
                />
              </SettingField>
              <p className="muted">{t("backup.retainDesc")}</p>
              <div className="backup-actions">
                <button className="btn small" disabled={backupBusy} onClick={backupNow}>
                  {t("backup.now")}
                </button>
                <button
                  className="btn small"
                  disabled={!backups?.dirExists}
                  onClick={() => {
                    // Through the backend: the webview's `openPath` is scoped to the three
                    // folders About opens, and a backup folder can be anywhere the user picked.
                    api.openBackupFolder().catch((e) => onToast(errorMessage(e)));
                  }}
                >
                  {t("backup.openFolder")}
                </button>
              </div>
              <p className="muted">{t("backup.autoHint")}</p>
              {backupError && <p className="setting-warn">{backupError}</p>}
              {backups && backups.backups.length === 0 && (
                <p className="muted">{t("backup.empty")}</p>
              )}
              {backups && backups.backups.length > 0 && (
                <div className="backup-list">
                  {backups.backups.map((snapshot) => (
                    <Fragment key={snapshot.path}>
                      <div className="backup-row">
                        <span className="backup-kind">
                          {t(BACKUP_KIND[snapshot.kind] ?? "backup.kindManual")}
                        </span>
                        <span className="backup-when" title={snapshot.createdAt}>
                          {formatWhen(snapshot.createdAt)}
                        </span>
                        <span className="backup-summary">
                          {t("backup.summary", { groups: snapshot.groups, tabs: snapshot.tabs })}
                          {" · "}
                          {sizeLabel(snapshot.bytes)}
                        </span>
                        {/* Clicking the same row again folds the question away. */}
                        <button
                          className="btn small"
                          disabled={backupBusy}
                          onClick={() =>
                            setRestoreTarget((prev) =>
                              prev?.path === snapshot.path ? null : snapshot
                            )
                          }
                        >
                          {t("backup.restore")}
                        </button>
                      </div>
                      {/* Under the row it is about, not under the whole list: the snapshot that
                          would be replaced stays visible above the question. */}
                      {restoreTarget?.path === snapshot.path && (
                        <div className="backup-confirm">
                          <div className="backup-confirm-title">{t("backup.confirmTitle")}</div>
                          <p className="muted">
                            {t("backup.confirmBody", {
                              when: formatWhen(restoreTarget.createdAt),
                            })}
                          </p>
                          <div className="backup-actions">
                            <button
                              className="btn primary small"
                              disabled={backupBusy}
                              onClick={restoreNow}
                            >
                              {t("backup.confirm")}
                            </button>
                            <button
                              className="btn small"
                              disabled={backupBusy}
                              onClick={() => setRestoreTarget(null)}
                            >
                              {t("backup.cancel")}
                            </button>
                          </div>
                        </div>
                      )}
                    </Fragment>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {category === "encryption" && (
          <div className="settings-cat">
            <h2>{t("enc.category")}</h2>
            <div className="setting-group">
              <SettingField label={t("enc.idleMinutes")}>
                <select
                  className="select"
                  value={settings.encryptIdleMinutes}
                  onChange={(e) =>
                    onSaveSettings({ encryptIdleMinutes: Number(e.target.value) })
                  }
                >
                  {IDLE_MINUTES.map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes === 0
                        ? t("enc.idleNever")
                        : t("enc.idleMinutesValue", { n: String(minutes) })}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("enc.idleHint")}</p>
              {/* The store is asked how many it holds rather than counted here: the list of
                  remembered passwords lives in Rust and in Windows, and neither is something
                  this panel should keep a second copy of. */}
              <SettingField label={t("enc.remembered")}>
                <button
                  className="btn small"
                  disabled={remembered === 0}
                  onClick={clearRemembered}
                >
                  {t("enc.clearRemembered")}
                </button>
              </SettingField>
              <p className="muted">
                {remembered === null
                  ? t("enc.rememberedUnknown")
                  : remembered === 0
                    ? t("enc.rememberedNone")
                    : t("enc.rememberedCount", { n: String(remembered) })}
              </p>
              {rememberedError && <p className="setting-warn">{rememberedError}</p>}
            </div>
          </div>
        )}

        {category === "versions" && (
          <div className="settings-cat">
            <h2>{t("ver.category")}</h2>
            <div className="setting-group">
              <SettingCheck
                label={t("ver.defaultEnabled")}
                checked={settings.versioningEnabled}
                onChange={(v) => onSaveSettings({ versioningEnabled: v })}
              />
              <p className="muted">{t("ver.defaultEnabledDesc")}</p>
              <SettingCheck
                label={t("ver.autoSaveVersions")}
                checked={settings.autoSaveVersions}
                onChange={(v) => onSaveSettings({ autoSaveVersions: v })}
              />
              <p className="muted">{t("ver.autoSaveVersionsDesc")}</p>
              <SettingCheck
                label={t("ver.askNote")}
                checked={settings.askNoteOnSave}
                onChange={(v) => onSaveSettings({ askNoteOnSave: v })}
              />
              <p className="muted">{t("ver.askNoteDesc")}</p>
              {/* No `min`/`max` on either field: the browser answers an out-of-range keystroke
                  with its own message in its own language, and this app has already translated
                  everything else. The number is clamped here and always written back, so the
                  field shows what is stored rather than what was typed. */}
              <SettingField label={t("ver.showLimit")}>
                <input
                  type="number"
                  step={1}
                  value={settings.versioningShowLimit}
                  onChange={(e) => {
                    const n = Math.trunc(Number(e.target.value));
                    if (Number.isNaN(n)) return;
                    onSaveSettings({ versioningShowLimit: Math.min(Math.max(n, 1), 500) });
                  }}
                />
              </SettingField>
              <p className="muted">{t("ver.showLimitDesc")}</p>
              {/* A number and a unit rather than a bare byte count: the default alone is an
                  eight-digit box to type into, and the ceiling is eight digits. Both controls
                  write bytes, so the unit only changes how the number reads. */}
              <SettingField label={t("ver.maxFileSize")}>
                <input
                  className="num-wide"
                  type="number"
                  value={settings.versioningMaxFileSize / sizeFactor}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isNaN(n)) return;
                    const bytes = Math.round(n * sizeFactor);
                    onSaveSettings({
                      versioningMaxFileSize: Math.min(Math.max(bytes, 1024), 33554432),
                    });
                  }}
                />
                <select
                  className="select"
                  value={sizeUnit}
                  onChange={(e) => setSizeUnit(e.target.value as SizeUnitKey)}
                >
                  {SIZE_UNITS.map((unit) => (
                    <option key={unit.key} value={unit.key}>
                      {unit.key}
                    </option>
                  ))}
                </select>
              </SettingField>
              <p className="muted">{t("ver.maxFileSizeDesc")}</p>
              <SettingField label={t("ver.clear")}>
                <button className="btn small" onClick={clearVersions}>
                  {t(versionsArmed ? "ver.clearAgain" : "ver.clearNow")}
                </button>
              </SettingField>
              <p className="muted">{t("ver.clearDesc")}</p>
            </div>
          </div>
        )}

        {category === "about" && (
          <div className="settings-cat">
            <h2>{t("settings.aboutHeading")}</h2>
            <div className="setting-group">
              <img className="about-logo" src={logoUrl} alt={t("app.name")} />
              <p>{t("settings.version", { version })}</p>
              {/* The only row here that touches the network, and only when asked: an editor
                  does not need to phone home on every start to be opened. */}
              <SettingField label={t("settings.updates")}>
                <button
                  className="btn small"
                  disabled={
                    updatePhase === "checking" ||
                    updatePhase === "downloading" ||
                    updatePhase === "installing"
                  }
                  onClick={() => void checkForUpdate()}
                >
                  {t(
                    updatePhase === "checking"
                      ? "settings.updateChecking"
                      : "settings.updateCheck"
                  )}
                </button>
              </SettingField>
              <p className="muted">
                {updatePhase === "idle" && t("settings.updateIdle")}
                {updatePhase === "checking" && t("settings.updateChecking")}
                {updatePhase === "latest" && t("settings.updateLatest", { version })}
                {updatePhase === "available" &&
                  update &&
                  t("settings.updateFound", { version: update.version })}
                {updatePhase === "downloading" &&
                  t("settings.updateDownloading", { percent: updatePercent })}
                {updatePhase === "installing" && t("settings.updateInstalling")}
              </p>
              {updatePhase === "available" && update && (
                <SettingField label={t("settings.updateInstall")}>
                  <button className="btn small primary" onClick={() => void installUpdate()}>
                    {t("settings.updateInstallAction")}
                  </button>
                </SettingField>
              )}
              <p className="muted">{t("settings.aboutLine")}</p>
              <p className="muted">{t("settings.draftLine")}</p>
              {/* The folders are named by the backend and opened by the shell rather than
                  listed here: the layout is `wrolp_dir`'s to decide, and a copy of a path the
                  app can already resolve is a path that can go stale. */}
              <SettingField label={t("settings.stateDir")}>
                <button
                  className="btn small"
                  disabled={!dirs}
                  onClick={() => openFolder(dirs?.state)}
                >
                  {t("settings.openFolder")}
                </button>
              </SettingField>
              <p className="muted store-path">{dirs?.state ?? ""}</p>
              <SettingField label={t("settings.draftsDir")}>
                <button
                  className="btn small"
                  disabled={!dirs}
                  onClick={() => openFolder(dirs?.drafts)}
                >
                  {t("settings.openFolder")}
                </button>
              </SettingField>
              <p className="muted store-path">{dirs?.drafts ?? ""}</p>
              {/* The version store is offered only once it exists. It is created by the first
                  recorded save rather than at startup, so an absent folder is the honest answer
                  to "where are my versions" — and a button that opens nothing would not be. */}
              <SettingField label={t("ver.dir")}>
                <button
                  className="btn small"
                  disabled={!dirs?.versionsPresent}
                  onClick={() => openFolder(dirs?.versions)}
                >
                  {t("settings.openFolder")}
                </button>
              </SettingField>
              <p className="muted store-path">
                {dirs?.versionsPresent ? dirs?.versions : t("ver.dirAbsent")}
              </p>
              {dirsError && <p className="setting-warn">{dirsError}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
