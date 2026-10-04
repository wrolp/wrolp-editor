import { useEffect, useRef } from "react";
import { t } from "../lib/i18n";
import { tabIcon } from "../lib/path";
import type { Tab } from "../lib/types";

export function TabGlyph({ name }: { name: string }) {
  const icon = tabIcon(name);
  return <span className={`tab-icon ${icon.cls}`}>{icon.sym}</span>;
}

interface Props {
  tabs: Tab[];
  activeId: number | null;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onContextMenu: (id: number, x: number, y: number) => void;
}

export default function TabBar({ tabs, activeId, onSelect, onClose, onContextMenu }: Props) {
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const active = barRef.current?.querySelector(".tab.active");
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId, tabs.length]);

  if (tabs.length === 0) {
    return (
      <div className="tabbar" ref={barRef} data-tauri-drag-region>
        <div className="tab empty">{t("tab.empty")}</div>
      </div>
    );
  }

  return (
    <div
      className="tabbar"
      ref={barRef}
      data-tauri-drag-region
      onWheel={(e) => {
        const bar = e.currentTarget;
        const max = bar.scrollWidth - bar.clientWidth;
        if (max <= 0 || e.deltaY === 0) return;
        bar.scrollLeft = Math.max(0, Math.min(max, bar.scrollLeft + e.deltaY));
      }}
      onContextMenu={(e) => {
        const target = (e.target as HTMLElement).closest(".tab");
        if (!target || target.classList.contains("empty")) return;
        const id = Number(target.getAttribute("data-id"));
        if (!Number.isNaN(id)) {
          e.preventDefault();
          onContextMenu(id, e.clientX, e.clientY);
        }
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-id={tab.id}
          className={`tab${tab.id === activeId ? " active" : ""}`}
          onClick={() => onSelect(tab.id)}
          title={tab.isSettings ? t("tab.settings") : tab.path}
        >
          {tab.isSettings ? (
            <span className="tab-icon icon-file">⚙</span>
          ) : (
            <TabGlyph name={tab.name} />
          )}
          <span className="tab-name">{tab.name}</span>
          {tab.dirty && !tab.isSettings && <span className="tab-dirty">U</span>}
          <button
            className="tab-close"
            title={t("tab.close")}
            onClick={(e) => {
              e.stopPropagation();
              onClose(tab.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
