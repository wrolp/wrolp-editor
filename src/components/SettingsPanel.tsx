import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { LANGUAGES, t } from "../lib/i18n";
import { parseExtensionList } from "../lib/path";
import SettingCheck from "./SettingCheck";
import SettingField from "./SettingField";
import { api, errorMessage, type MenuTarget, type Settings } from "../lib/tauri";

type Category = "context" | "general" | "encryption" | "about";

interface Props {
  settings: Settings;
  menu: MenuTarget | null;
  menuBusy: boolean;
  onSaveSettings: (patch: Partial<Settings>) => void;
  onSetMenu: (installed: boolean) => void;
  /** Says what a change here did, which for the credential store is the only report there is. */
  onToast: (message: string) => void;
}

const NAV: { cat: Category; key: string }[] = [
  { cat: "general", key: "settings.catGeneral" },
  { cat: "context", key: "settings.catContext" },
  { cat: "encryption", key: "enc.category" },
  { cat: "about", key: "settings.catAbout" },
];

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

export default function SettingsPanel({
  settings,
  menu,
  menuBusy,
  onSaveSettings,
  onSetMenu,
  onToast,
}: Props) {
  // The first entry in NAV, so opening Settings lands on it rather than on the second one.
  const [category, setCategory] = useState<Category>("general");
  const [version, setVersion] = useState("…");
  /** How many passwords the credential store is holding, or null when it would not say. */
  const [remembered, setRemembered] = useState<number | null>(null);
  const [rememberedError, setRememberedError] = useState<string | null>(null);
  // The exclusion list is typed as free text, so what is being edited and what is stored
  // are two things: `excludedText` is the field's own state (it takes `png, JPG` and
  // `.png` alike) and is only parsed on the way out. The stored value is written back into
  // the field whenever it changes elsewhere, which is also how a rejected entry gets
  // corrected instead of being left on screen looking saved.
  const joined = settings.excludedExtensions.join(", ");
  const [excludedText, setExcludedText] = useState(joined);
  useEffect(() => setExcludedText(joined), [joined]);

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
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

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

        {category === "about" && (
          <div className="settings-cat">
            <h2>{t("settings.aboutHeading")}</h2>
            <div className="setting-group">
              <p>{t("settings.version", { version })}</p>
              <p className="muted">{t("settings.aboutLine")}</p>
              <p className="muted">{t("settings.draftLine")}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
