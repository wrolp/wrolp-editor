import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import SettingCheck from "./SettingCheck";
import { api, errorMessage, EMPTY_FILE_SETTINGS, type FileSettings, type FileSettingsView } from "../lib/tauri";

interface Props {
  path: string;
  name: string;
  /** The encoding the file was actually read in, shown so the override has context. */
  detectedEncoding: string;
  onSave: (path: string, next: FileSettings) => Promise<void>;
  onClose: () => void;
  onError: (message: string) => void;
}

export default function FileSettingsDialog({
  path,
  name,
  detectedEncoding,
  onSave,
  onClose,
  onError,
}: Props) {
  const [view, setView] = useState<FileSettingsView | null>(null);
  const [overrides, setOverrides] = useState<FileSettings | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let live = true;
    api
      .fileSettingsView(path)
      .then((v) => {
        if (!live) return;
        setView(v);
        setOverrides(v.overrides);
      })
      .catch((e) => onError(errorMessage(e)));
    return () => {
      live = false;
    };
  }, [path, onError]);

  // Escape closes, matching the editor's own habits.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const set = (patch: Partial<FileSettings>) =>
    setOverrides((prev) => (prev ? { ...prev, ...patch } : prev));

  const save = async () => {
    if (overrides) await onSave(path, overrides);
    onClose();
  };

  const resetAll = async () => {
    try {
      await api.clearFileSettings(path);
    } catch (e) {
      onError(errorMessage(e));
      return;
    }
    await onSave(path, EMPTY_FILE_SETTINGS);
    onClose();
  };

  const hasOverride =
    !!overrides &&
    (overrides.renderWhitespace !== null ||
      overrides.wordWrap !== null ||
      overrides.stickyScroll !== null ||
      overrides.encoding !== null);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("fileSettings.title", { name })}</h3>
        {!view || !overrides ? (
          <p className="muted">{t("app.loading")}</p>
        ) : (
          <>
            <p className="muted">
              {t("fileSettings.detected", { encoding: detectedEncoding })}
            </p>
            <div className="setting-group">
              <FollowSelect
                label={t("settings.renderWhitespace")}
                value={overrides.renderWhitespace}
                inherited={view.defaults.renderWhitespace}
                options={view.whitespace.map((m) => [m, t(`settings.whitespace.${m}`)])}
                onChange={(v) => set({ renderWhitespace: v })}
              />
              <SettingCheck
                label={t("settings.wordWrap")}
                checked={overrides.wordWrap ?? view.defaults.wordWrap ?? false}
                indeterminate={overrides.wordWrap === null}
                hint={overrides.wordWrap === null ? t("fileSettings.inherits", { value: String(view.defaults.wordWrap) }) : undefined}
                onChange={(v) => set({ wordWrap: v })}
              />
              <SettingCheck
                label={t("settings.stickyScroll")}
                checked={overrides.stickyScroll ?? view.defaults.stickyScroll ?? false}
                indeterminate={overrides.stickyScroll === null}
                hint={overrides.stickyScroll === null ? t("fileSettings.inherits", { value: String(view.defaults.stickyScroll) }) : undefined}
                onChange={(v) => set({ stickyScroll: v })}
              />
              <SettingCheck
                label={t("settings.minimap")}
                checked={overrides.minimap ?? view.defaults.minimap ?? false}
                indeterminate={overrides.minimap === null}
                hint={
                  overrides.minimap === null
                    ? t("fileSettings.inherits", { value: String(view.defaults.minimap) })
                    : undefined
                }
                onChange={(v) => set({ minimap: v })}
              />
              <FollowSelect
                label={t("settings.encoding")}
                value={overrides.encoding}
                inherited={view.defaults.encoding}
                options={view.encodings.map(([v, k]) => [v, t(`settings.enc.${k}`)])}
                onChange={(v) => set({ encoding: v })}
              />
            </div>
            <p className="muted">{t("fileSettings.scopeNote")}</p>
            <div className="modal-actions">
              <button className="btn" onClick={() => void resetAll()} disabled={!hasOverride}>
                {t("fileSettings.resetAll")}
              </button>
              <button className="btn" onClick={onClose}>
                {t("fileSettings.cancel")}
              </button>
              <button className="btn primary" onClick={() => void save()}>
                {t("fileSettings.save")}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

type Option = [string, string];

/** A select whose first entry means "inherit the global value". */
function FollowSelect({
  label,
  value,
  inherited,
  options,
  onChange,
}: {
  label: string;
  value: string | null;
  inherited: string | null;
  options: Option[];
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="setting-row">
      <span className="setting-title">{label}</span>
      <select
        className="select"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value)}
      >
        <option value="">{t("fileSettings.follow", { value: inherited ?? "" })}</option>
        {options.map(([v, text]) => (
          <option key={v} value={v}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
}
