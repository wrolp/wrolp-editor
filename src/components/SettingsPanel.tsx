import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import type { Settings } from "../lib/tauri";

type Category = "context" | "general" | "about";

interface Props {
  settings: Settings;
  menuInstalled: boolean;
  menuBusy: boolean;
  onSaveSettings: (patch: Partial<Settings>) => void;
  onSetMenu: (installed: boolean) => void;
}

const NAV: { cat: Category; label: string }[] = [
  { cat: "context", label: "Context menu" },
  { cat: "general", label: "General" },
  { cat: "about", label: "About" },
];

export default function SettingsPanel({
  settings,
  menuInstalled,
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
        <div className="settings-nav-title">Settings</div>
        {NAV.map((item) => (
          <button
            key={item.cat}
            className={`settings-nav-item${category === item.cat ? " active" : ""}`}
            onClick={() => setCategory(item.cat)}
          >
            {item.label}
          </button>
        ))}
      </aside>

      <div className="settings-content">
        {category === "context" && (
          <div className="settings-cat">
            <h2>Explorer context menu</h2>
            <div className="setting-group">
              <label className="setting-row">
                <input
                  type="checkbox"
                  checked={menuInstalled}
                  disabled={menuBusy}
                  onChange={(e) => onSetMenu(e.target.checked)}
                />
                <div>
                  <div className="setting-title">Add to the context menu</div>
                  <div className="setting-desc">
                    Shows "Open with WROLP" when right-clicking a file in Explorer
                  </div>
                </div>
              </label>
              <p className="muted">
                {menuBusy
                  ? "Writing to the registry…"
                  : menuInstalled
                    ? "Installed at HKCU\\Software\\Classes\\*\\shell\\WROLP Editor"
                    : "Not installed. Writes to HKCU for the current user, no administrator rights needed."}
              </p>
            </div>
          </div>
        )}

        {category === "general" && (
          <div className="settings-cat">
            <h2>General</h2>
            <div className="setting-group">
              <label className="setting-row">
                <span>Editor font size</span>
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
                <span>Show minimap</span>
              </label>
              <p className="muted">
                Changes apply immediately and are stored in {`<app data>/wrolp/state/settings.json`}.
              </p>
            </div>
          </div>
        )}

        {category === "about" && (
          <div className="settings-cat">
            <h2>About WROLP Editor</h2>
            <div className="setting-group">
              <p>Version {version}</p>
              <p className="muted">A lightweight local text editor built on Tauri v2 + Monaco Editor.</p>
              <p className="muted">
                Unsaved edits go to <code>wrolp/drafts/&lt;sha256&gt;.draft</code> and are offered
                back the next time the same file is opened.
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
