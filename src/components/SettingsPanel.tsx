import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { LANGUAGES, t } from "../lib/i18n";
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
              <label className="setting-row">
                <input
                  type="checkbox"
                  checked={menu?.installed ?? false}
                  disabled={menuBusy}
                  onChange={(e) => onSetMenu(e.target.checked)}
                />
                <div>
                  <div className="setting-title">{t("settings.contextAdd")}</div>
                  <div className="setting-desc">{t("settings.contextDesc")}</div>
                </div>
              </label>
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
              <label className="setting-row">
                <span className="setting-title">{t("settings.language")}</span>
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
              </label>
              <p className="muted">{t("settings.languageDesc")}</p>
              <label className="setting-row">
                <span>{t("settings.fontSize")}</span>
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
              </label>
              <label className="setting-row">
                <input
                  type="checkbox"
                  checked={settings.minimap}
                  onChange={(e) => onSaveSettings({ minimap: e.target.checked })}
                />
                <span>{t("settings.minimap")}</span>
              </label>
              <label className="setting-row">
                <input
                  type="checkbox"
                  checked={settings.restoreSession}
                  onChange={(e) => onSaveSettings({ restoreSession: e.target.checked })}
                />
                <span>{t("settings.restoreSession")}</span>
              </label>
              <p className="muted">{t("settings.restoreSessionDesc")}</p>
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
