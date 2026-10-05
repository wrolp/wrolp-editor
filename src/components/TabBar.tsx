import { useEffect, useRef } from "react";
import { t } from "../lib/i18n";
import FileIcon from "./FileIcon";
import type { Tab } from "../lib/types";

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
        <div className="tab empty" data-tauri-drag-region="false">
          {t("tab.empty")}
        </div>
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
      onPointerDown={(e) => {
        // Open on the right-button press rather than on `contextmenu`. Same gesture, but
        // `contextmenu` is passive and fires late, so anything that swallows it (a drag
        // region, an embedded webview, a future overlay) leaves no fallback at all. The
        // `contextmenu` handler below stays solely to suppress the native menu.
        if (e.button !== 2) return;
        const el = (e.target as HTMLElement).closest?.(".tab") as HTMLElement | null;
        if (!el || el.classList.contains("empty")) return;
        const id = Number(el.getAttribute("data-id"));
        if (!Number.isNaN(id)) onContextMenu(id, e.clientX, e.clientY);
      }}
      onContextMenu={(e) => {
        // Only swallow the native menu when it was aimed at a tab; the empty strip
        // should still get the usual browser menu.
        const el = (e.target as HTMLElement).closest?.(".tab") as HTMLElement | null;
        if (!el || el.classList.contains("empty")) return;
        e.preventDefault();
      }}
    >
      {tabs.map((tab) => (
        <div
          key={tab.id}
          data-id={tab.id}
          // Not a drag region: Tauri's drag.js only drags on a bare attribute hit by the
          // event target, and a tab is always a descendant. Marking it false states the
          // intent and keeps it that way if the strip ever becomes "deep".
          data-tauri-drag-region="false"
          className={`tab${tab.id === activeId ? " active" : ""}`}
          onClick={() => onSelect(tab.id)}
          title={tab.isSettings ? t("tab.settings") : tab.path}
        >
          {tab.isSettings ? (
            <span className="file-glyph icon-settings">⚙</span>
          ) : (
            <FileIcon name={tab.name} />
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
