import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import type { Workspace } from "../lib/tauri";
import type { NameProblem } from "./NewWorkspaceDialog";

interface Props {
  items: Workspace[];
  activeId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => NameProblem;
  onClear: (id: string) => void;
  onRemove: (id: string) => void;
}

/** A named group of open tabs, and the only way to move between whole editing contexts. */
export default function WorkspaceChip({
  items,
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
  const active = items.find((w) => w.id === activeId) ?? null;

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

  const rowLabel = (w: Workspace) =>
    w.tabs.length > 0 ? t("ws.currentTabs", { n: w.tabs.length }) : t("ws.noTabs");

  return (
    <div className="ws-wrap" ref={wrapRef}>
      <button
        className="ws-chip"
        title={active ? `${active.name} - ${rowLabel(active)}` : t("ws.noWorkspace")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="ws-name">{active?.name ?? t("ws.noWorkspace")}</span>
      </button>

      {open && (
        <div className="ws-panel">
          {editing ? (
            <div className="ws-rename">
              <input
                className="ws-input"
                value={draftName}
                placeholder={t("ws.renameHint")}
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
                {t("ws.rename")}
              </button>
            </div>
          ) : (
            <>
              <div className="ws-heading">{t("ws.chip")}</div>
              {items.map((w) => (
                <div
                  key={w.id}
                  className={`ws-row${w.id === activeId ? " active" : ""}`}
                  onClick={() => {
                    onSwitch(w.id);
                    setOpen(false);
                  }}
                >
                  <span className="ws-row-name">{w.name}</span>
                  <span className="ws-row-meta">{rowLabel(w)}</span>
                </div>
              ))}
              {problem !== "ok" && (
                <div className="ws-error">
                  {t(problem === "duplicate" ? "ws.nameDuplicate" : "ws.nameEmpty")}
                </div>
              )}
              <div className="ws-sep" />
              <div
                className="ws-item"
                onClick={() => {
                  onNew();
                  setOpen(false);
                }}
              >
                {t("ws.new")}
              </div>
              {active && (
                <>
                  <div className="ws-item" onClick={startRename}>
                    {t("ws.rename")}
                  </div>
                  <div
                    className="ws-item"
                    onClick={() => {
                      onClear(active.id);
                      setOpen(false);
                    }}
                  >
                    {t("ws.clear")}
                  </div>
                  <div
                    className="ws-item danger"
                    onClick={() => {
                      onRemove(active.id);
                      setOpen(false);
                    }}
                  >
                    {t("ws.remove")}
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
