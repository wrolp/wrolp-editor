import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import type { Workspace } from "../lib/tauri";

interface Props {
  items: Workspace[];
  activeId: string;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onClear: (id: string) => void;
  onRemove: (id: string) => void;
}

/** Workspace name in the title bar, and the only way to move between whole editing contexts. */
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
    setEditing(true);
  };

  const commitRename = () => {
    if (active && draftName.trim()) onRename(active.id, draftName);
    setEditing(false);
  };

  return (
    <div className="ws-wrap" ref={wrapRef}>
      <button
        className="ws-chip"
        title={active?.root || t("ws.noWorkspace")}
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
                onChange={(e) => setDraftName(e.target.value)}
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
                  title={w.root}
                  onClick={() => {
                    onSwitch(w.id);
                    setOpen(false);
                  }}
                >
                  <span className="ws-row-name">{w.name}</span>
                  <span className="ws-row-meta">
                    {w.tabs.length > 0 ? t("ws.currentTabs", { n: w.tabs.length }) : t("ws.noTabs")}
                  </span>
                </div>
              ))}
              <div className="ws-sep" />
              <div className="ws-item" onClick={() => { onNew(); setOpen(false); }}>
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
