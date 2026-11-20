import { useCallback, useEffect, useState } from "react";
import { t } from "../lib/i18n";
import SettingField from "./SettingField";
import {
  api,
  errorMessage,
  type ArchiveRuleInput,
  type ArchiveRuleView,
  type ArchivePasswordState,
} from "../lib/tauri";

/**
 * Archive passwords: the default and the rules that name one.
 *
 * Passwords never come back from Rust — the panel only learns whether a default exists and
 * what a rule's pattern is. Editing a rule without typing a new password keeps the old one,
 * which is what lets a pattern be corrected without the secret passing through this component.
 */
export default function ArchivePasswordSettings({
  onNotice,
}: {
  onNotice: (message: string) => void;
}) {
  const [state, setState] = useState<ArchivePasswordState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [defaultPassword, setDefaultPassword] = useState("");
  const [testing, setTesting] = useState("");
  const [testAnswer, setTestAnswer] = useState<string | null>(null);
  /** The rule being edited; `null` means the form is closed. */
  const [editing, setEditing] = useState<ArchiveRuleView | "new" | null>(null);
  const [form, setForm] = useState({
    pattern: "",
    flags: "",
    target: "name",
    note: "",
    password: "",
    enabled: true,
  });

  const load = useCallback(async () => {
    try {
      setState(await api.archivePasswordState());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openRule = (rule: ArchiveRuleView | "new") => {
    setEditing(rule);
    setForm(
      rule === "new"
        ? {
            pattern: "",
            flags: "",
            target: "name",
            note: "",
            password: "",
            enabled: true,
          }
        : {
            pattern: rule.pattern,
            flags: rule.flags,
            target: rule.target,
            note: rule.note,
            password: "",
            enabled: rule.enabled,
          }
    );
  };

  const saveRule = async () => {
    const input: ArchiveRuleInput = {
      id: editing && editing !== "new" ? editing.id : "",
      pattern: form.pattern,
      flags: form.flags,
      target: form.target,
      note: form.note,
      enabled: form.enabled,
      password: form.password === "" ? undefined : form.password,
    };
    try {
      await api.archiveSavePasswordRule(input);
      setEditing(null);
      await load();
      onNotice(t("arc.saved"));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const saveDefault = async () => {
    if (defaultPassword === "") return;
    try {
      await api.archiveSetDefaultPassword(defaultPassword);
      setDefaultPassword("");
      await load();
      onNotice(t("arc.defaultSaved"));
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const runTest = async () => {
    const name = testing.trim();
    if (name === "") {
      setTestAnswer(null);
      return;
    }
    try {
      const answer = await api.archiveTestPasswordRule(name, name);
      setTestAnswer(
        answer.rule
          ? t("arc.testHit", { pattern: answer.rule.pattern })
          : answer.defaultSet
            ? t("arc.testDefault")
            : t("arc.testNone")
      );
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const rules = state?.rules ?? [];

  return (
    <div className="setting-group">
      <h3>{t("arc.category")}</h3>
      <p className="muted">{t("arc.warning")}</p>

      <SettingField label={t("arc.default")}>
        {state?.defaultSet ? (
          <button
            className="btn small"
            onClick={() =>
              void api
                .archiveClearDefaultPassword()
                .then(load)
                .catch((e) => setError(errorMessage(e)))
            }
          >
            {t("arc.clearDefault")}
          </button>
        ) : (
          <span className="muted">{t("arc.noDefault")}</span>
        )}
      </SettingField>
      <div className="arc-inline">
        <input
          className="grp-input"
          type="password"
          autoComplete="off"
          value={defaultPassword}
          placeholder={t("arc.defaultPlaceholder")}
          onChange={(e) => setDefaultPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void saveDefault();
          }}
        />
        <button
          className="btn small"
          disabled={defaultPassword === ""}
          onClick={() => void saveDefault()}
        >
          {t("arc.saveDefault")}
        </button>
      </div>

      <SettingField label={t("arc.rules")}>
        <button className="btn small" onClick={() => openRule("new")}>
          {t("arc.addRule")}
        </button>
      </SettingField>
      {rules.length === 0 && <p className="muted">{t("arc.noRules")}</p>}
      {rules.map((rule, index) => (
        <div className="arc-rule" key={rule.id}>
          <label className="arc-rule-head">
            <input
              type="checkbox"
              checked={rule.enabled}
              onChange={(e) => {
                const input: ArchiveRuleInput = {
                  id: rule.id,
                  pattern: rule.pattern,
                  flags: rule.flags,
                  target: rule.target,
                  note: rule.note,
                  enabled: e.target.checked,
                };
                void api
                  .archiveSavePasswordRule(input)
                  .then(load)
                  .catch((err) => setError(errorMessage(err)));
              }}
            />
            <code>{rule.pattern}</code>
            <span className="muted">
              {rule.target === "path" ? t("arc.targetPath") : t("arc.targetName")}
              {rule.flags ? ` · ${rule.flags}` : ""}
            </span>
          </label>
          {rule.note && <p className="muted">{rule.note}</p>}
          <div className="arc-rule-actions">
            <button
              className="btn small"
              disabled={index === 0}
              onClick={() =>
                void api
                  .archiveMovePasswordRule(rule.id, -1)
                  .then(load)
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              ↑
            </button>
            <button
              className="btn small"
              disabled={index === rules.length - 1}
              onClick={() =>
                void api
                  .archiveMovePasswordRule(rule.id, 1)
                  .then(load)
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              ↓
            </button>
            <button className="btn small" onClick={() => openRule(rule)}>
              {t("arc.edit")}
            </button>
            <button
              className="btn small"
              onClick={() =>
                void api
                  .archiveDeletePasswordRule(rule.id)
                  .then(load)
                  .catch((e) => setError(errorMessage(e)))
              }
            >
              {t("arc.delete")}
            </button>
          </div>
        </div>
      ))}

      {editing && (
        <div className="arc-rule arc-editor">
          <SettingField label={t("arc.pattern")}>
            <input
              className="grp-input"
              value={form.pattern}
              placeholder={t("arc.patternPlaceholder")}
              onChange={(e) => setForm({ ...form, pattern: e.target.value })}
            />
          </SettingField>
          <SettingField label={t("arc.flags")}>
            <input
              className="grp-input"
              value={form.flags}
              placeholder="i"
              onChange={(e) => setForm({ ...form, flags: e.target.value })}
            />
          </SettingField>
          <SettingField label={t("arc.target")}>
            <select
              className="select"
              value={form.target}
              onChange={(e) => setForm({ ...form, target: e.target.value })}
            >
              <option value="name">{t("arc.targetName")}</option>
              <option value="path">{t("arc.targetPath")}</option>
            </select>
          </SettingField>
          <SettingField label={t("arc.note")}>
            <input
              className="grp-input"
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </SettingField>
          <SettingField label={t("arc.password")}>
            <input
              className="grp-input"
              type="password"
              autoComplete="off"
              value={form.password}
              placeholder={
                editing === "new" ? "" : t("arc.passwordKeep")
              }
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </SettingField>
          <div className="arc-rule-actions">
            <button
              className="btn small primary"
              disabled={
                form.pattern.trim() === "" ||
                (editing === "new" && form.password === "")
              }
              onClick={() => void saveRule()}
            >
              {t("arc.save")}
            </button>
            <button className="btn small" onClick={() => setEditing(null)}>
              {t("arc.cancel")}
            </button>
          </div>
        </div>
      )}

      <SettingField label={t("arc.test")}>
        <div className="arc-inline">
          <input
            className="grp-input"
            value={testing}
            placeholder={t("arc.testPlaceholder")}
            onChange={(e) => {
              setTesting(e.target.value);
              setTestAnswer(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runTest();
            }}
          />
          <button className="btn small" onClick={() => void runTest()}>
            {t("arc.testRun")}
          </button>
        </div>
      </SettingField>
      {testAnswer && <p className="muted">{testAnswer}</p>}
      {error && <p className="setting-warn">{error}</p>}
    </div>
  );
}


