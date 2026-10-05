import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { LANGUAGES, t } from "../lib/i18n";
import SettingCheck from "./SettingCheck";
import SettingField from "./SettingField";
import type { MenuTarget, Settings } from "../lib/tauri";

type Category = "context" | "general" | "about";

interface Props {
  settings: Settings;
  menu: MenuTarget | null;
  menuBusy: boolean;
  onSaveSettings: (patch: Partial<Settings>) => void;
  onSetMenu: (installed: boolean) => void;
}

const NAV: { cat: Category; key: string }[] = [
  { cat: "context", key: "settings.catContext" },
  { cat: "general", key: "settings.catGeneral" },
  { cat: "about", key: "settings.catAbout" },
];

const WHITESPACE_MODES = ["none", "boundary", "selection", "all", "trailing"] as const;
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
}: Props) {
  const [category, setCategory] = useState<Category>("context");
  const [version, setVersion] = useState("…");

  // Read the packaged version instead of hardcoding it, so About cannot drift from tauri.conf.json.
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("unknown"));
  }, []);

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
                    ? t("settings.contextInstalled")
                    : t("settings.contextMissing")}
              </p>
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
              <p className="muted">{t("settings.persisted")}</p>
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
