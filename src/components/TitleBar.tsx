import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TabBar, { TabGlyph } from "./TabBar";
import { IconChevron, IconOpenFolder, IconSettings, IconSidebar } from "./icons";
import type { Tab } from "../lib/types";

interface Props {
  tabs: Tab[];
  activeId: number | null;
  sidebarVisible: boolean;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onTabContextMenu: (id: number, x: number, y: number) => void;
  onToggleSidebar: () => void;
  onNewFile: () => void;
  onOpenFiles: () => void;
  onOpenSettings: () => void;
}

export default function TitleBar(props: Props) {
  const { tabs, activeId, sidebarVisible } = props;
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const appWindow = useRef(getCurrentWindow());

  useEffect(() => {
    if (!dropdownOpen) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current?.contains(target)) return;
      if ((target as HTMLElement).closest?.(".tab-dropdown")) return;
      setDropdownOpen(false);
    };
    document.addEventListener("click", onDocClick, true);
    return () => document.removeEventListener("click", onDocClick, true);
  }, [dropdownOpen]);

  return (
    <div className="titlebar" data-tauri-drag-region>
      <button
        className={`title-toggle${sidebarVisible ? " active" : ""}`}
        title="Toggle sidebar (Ctrl+B)"
        onClick={props.onToggleSidebar}
      >
        <IconSidebar />
      </button>

      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={props.onSelect}
        onClose={props.onClose}
        onContextMenu={props.onTabContextMenu}
      />

      <button
        className="tab-list-btn"
        ref={btnRef}
        title="Open files"
        onClick={() => setDropdownOpen((v) => !v)}
      >
        <IconChevron />
      </button>

      {dropdownOpen && (
        <div className="tab-dropdown">
          {tabs.length === 0 ? (
            <div className="dd-empty">No open files</div>
          ) : (
            tabs.map((tab) => (
              <div
                key={tab.id}
                className={`dd-row${tab.id === activeId ? " active" : ""}`}
                onClick={() => {
                  props.onSelect(tab.id);
                  setDropdownOpen(false);
                }}
              >
                <TabGlyph name={tab.name} />
                <span className="dd-name">{tab.name}</span>
                <button
                  className="dd-close"
                  title="Close"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onClose(tab.id);
                  }}
                >
                  ×
                </button>
              </div>
            ))
          )}
        </div>
      )}

      <button className="tab-new" title="New file (Ctrl+N)" onClick={props.onNewFile}>
        +
      </button>

      <div className="titlebar-actions">
        <button className="tb-icon" title="Open (Ctrl+O)" onClick={props.onOpenFiles}>
          <IconOpenFolder />
        </button>
        <button className="tb-icon" title="Settings" onClick={props.onOpenSettings}>
          <IconSettings />
        </button>
        <div className="win-controls">
          <button className="win-btn" title="Minimize" onClick={() => appWindow.current.minimize()}>
            —
          </button>
          <button
            className="win-btn"
            title="Maximize"
            onClick={() => appWindow.current.toggleMaximize()}
          >
            ▢
          </button>
          <button className="win-btn win-close" title="Close" onClick={() => appWindow.current.close()}>
            ✕
          </button>
        </div>
      </div>
    </div>
  );
}
