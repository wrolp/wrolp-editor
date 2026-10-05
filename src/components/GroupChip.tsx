import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import type { Group } from "../lib/tauri";
import type { NameProblem } from "../hooks/useGroups";

interface Props {
  groups: Group[];
  activeId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => NameProblem;
  onClear: (id: string) => void;
  onRemove: (id: string) => void;
}

/** A named set of open tabs, and the only way to move between whole editing contexts. */
export default function GroupChip({
  groups,
  activeId,
  onSwitch,
  onNew,
  onRename,
  onClear,
  onRemove,
}: Props) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [problem, setProblem] = useState<NameProblem>("ok");
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = groups.find((g) => g.id === activeId) ?? null;

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  }, [open]);

  const startRename = () => {
    if (!active) return;
    setDraftName(active.name);
    setProblem("ok");
    setEditing(true);
  };

  const commitRename = () => {
    if (!active) return;
    const result = onRename(active.id, draftName);
    if (result === "ok") {
      setEditing(false);
      return;
    }
    setProblem(result);
  };

  const rowLabel = (g: Group) =>
    g.tabs.length > 0 ? t("grp.currentTabs", { n: g.tabs.length }) : t("grp.noTabs");

  return (
    <div className="grp-wrap" ref={wrapRef}>
      <button
        className="grp-chip"
        title={active ? `${active.name} - ${rowLabel(active)}` : t("grp.noGroup")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="grp-name">{active?.name ?? t("grp.noGroup")}</span>
      </button>

      {open && (
        <div className="grp-panel">
          {editing ? (
            <div className="grp-rename">
              <input
                className="grp-input"
                value={draftName}
                placeholder={t("grp.renameHint")}
                autoFocus
                onChange={(e) => {
                  setDraftName(e.target.value);
                  if (problem !== "ok") setProblem("ok");
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename();
                  if (e.key === "Escape") setEditing(false);
                }}
              />
              <button className="btn primary small" onClick={commitRename}>
                {t("grp.rename")}
              </button>
            </div>
          ) : (
            <>
              <div className="grp-heading">{t("grp.chip")}</div>
              {groups.map((g) => (
                <div
                  key={g.id}
                  className={`grp-row${g.id === activeId ? " active" : ""}`}
                  onClick={() => {
                    onSwitch(g.id);
                    setOpen(false);
                  }}
                >
                  <span className="grp-row-name">{g.name}</span>
                  <span className="grp-row-meta">{rowLabel(g)}</span>
                </div>
              ))}
              {problem !== "ok" && (
                <div className="grp-error">
                  {t(problem === "duplicate" ? "grp.nameDuplicate" : "grp.nameEmpty")}
                </div>
              )}
              <div className="grp-sep" />
              <div
                className="grp-item"
                onClick={() => {
                  onNew();
                  setOpen(false);
                }}
              >
                {t("grp.new")}
              </div>
              {active && (
                <>
                  <div className="grp-item" onClick={startRename}>
                    {t("grp.rename")}
                  </div>
                  <div
                    className="grp-item"
                    onClick={() => {
                      onClear(active.id);
                      setOpen(false);
                    }}
                  >
                    {t("grp.clear")}
                  </div>
                  <div
                    className="grp-item danger"
                    onClick={() => {
                      onRemove(active.id);
                      setOpen(false);
                    }}
                  >
                    {t("grp.remove")}
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
