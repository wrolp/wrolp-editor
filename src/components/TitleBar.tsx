import { useEffect, useRef, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import TabBar from "./TabBar";
import { TabIcon } from "./FileIcon";
import { t } from "../lib/i18n";
import {
  IconChevron,
  IconClose,
  IconMaximize,
  IconMinimize,
  IconModePreview,
  IconModeSplit,
  IconModeText,
  IconOpenFolder,
  IconRestore,
  IconSettings,
  IconSidebar,
} from "./icons";
import type { Tab } from "../lib/types";

/** How the editor and the markdown preview share the space. */
export type PreviewMode = "text" | "split" | "preview";

const MODE_ICON = {
  text: IconModeText,
  split: IconModeSplit,
  preview: IconModePreview,
} as const;

interface Props {
  tabs: Tab[];
  activeId: number | null;
  sidebarVisible: boolean;
  /** Rendered at the left of the tab strip: the group switcher. */
  groupSlot?: ReactNode;
  /** Current preview layout; null hides the control (not a markdown document). */
  previewMode: PreviewMode | null;
  onPreviewMode: (mode: PreviewMode) => void;
  onSelect: (id: number) => void;
  onClose: (id: number) => void;
  onTabContextMenu: (id: number, x: number, y: number) => void;
  /** Drop a dragged tab at this position in the strip. */
  onReorder: (id: number, toIndex: number) => void;
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
  /**
   * Whether the window is maximized, which decides whether the middle button offers
   * "Restore" or "Maximize" and which glyph it draws. It cannot be derived from state:
   * the window can also be maximized by double-clicking the title bar, by snapping it to
   * a screen edge, or by the system, none of which go through the button.
   */
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = appWindow.current;
    const sync = () => {
      win.isMaximized()
        .then(setMaximized)
        .catch(() => {});
    };
    sync();
    // Resizing covers maximize, restore, snap and the taskbar jumps alike: one event for
    // every way the state can change, and it fires for the button press as well.
    let dispose: (() => void) | undefined;
    void win.onResized(sync).then((unlisten) => {
      dispose = unlisten;
    });
    return () => dispose?.();
  }, []);

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
        title={t("title.toggleSidebar")}
        onClick={props.onToggleSidebar}
      >
        <IconSidebar />
      </button>

      {props.groupSlot}

      <TabBar
        tabs={tabs}
        activeId={activeId}
        onSelect={props.onSelect}
        onClose={props.onClose}
        onContextMenu={props.onTabContextMenu}
        onReorder={props.onReorder}
      />

      {/* Drag handle for the empty space at the end of the tab strip. It sits before the
          tab-list and new-file buttons on purpose: they belong with the window controls on
          the right, and a flexible gap here is what leaves the drag area free without
          pushing them into the middle of the bar. */}
      <div className="titlebar-drag" data-tauri-drag-region aria-hidden="true" />

      <div className="tab-list-wrap">
        <button
          className="tab-list-btn"
          ref={btnRef}
          title={t("title.openFiles")}
          onClick={() => setDropdownOpen((v) => !v)}
        >
          <IconChevron />
        </button>

        {dropdownOpen && (
          <div className="tab-dropdown">
            {tabs.length === 0 ? (
              <div className="dd-empty">{t("tab.empty")}</div>
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
                  <TabIcon tab={tab} />
                  <span className="dd-name">{tab.name}</span>
                  <button
                    className="dd-close"
                    title={t("tab.close")}
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
      </div>

      <button className="tab-new" title={t("title.newFile")} onClick={props.onNewFile}>
        +
      </button>

      <div className="titlebar-actions">
        {props.previewMode && (
          <div
            className="mode-seg"
            role="group"
            aria-label={t("preview.label")}
            data-tauri-drag-region="false"
          >
            {(["text", "split", "preview"] as const).map((mode) => {
              const Glyph = MODE_ICON[mode];
              const active = props.previewMode === mode;
              return (
                <button
                  key={mode}
                  className={`mode-btn${active ? " active" : ""}`}
                  title={t(`preview.${mode}`)}
                  aria-pressed={active}
                  onClick={() => props.onPreviewMode(mode)}
                >
                  <Glyph />
                </button>
              );
            })}
          </div>
        )}
        <button className="tb-icon" title={t("title.open")} onClick={props.onOpenFiles}>
          <IconOpenFolder />
        </button>
        <button className="tb-icon" title={t("title.settings")} onClick={props.onOpenSettings}>
          <IconSettings />
        </button>
        <div className="win-controls">
          <button className="win-btn" title={t("title.minimize")} onClick={() => appWindow.current.minimize()}>
            <IconMinimize />
          </button>
          <button
            className="win-btn"
            title={maximized ? t("title.restore") : t("title.maximize")}
            onClick={() => appWindow.current.toggleMaximize()}
          >
            {maximized ? <IconRestore /> : <IconMaximize />}
          </button>
          <button className="win-btn win-close" title={t("tab.close")} onClick={() => appWindow.current.close()}>
            <IconClose />
          </button>
        </div>
      </div>
    </div>
  );
}
