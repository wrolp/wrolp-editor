import { useEffect, useState, type ReactNode } from "react";
import { IconFolder, IconTreeChevron } from "./icons";
import FileIcon from "./FileIcon";
import { t } from "../lib/i18n";
import {
  api,
  copyText,
  errorMessage,
  parentOf,
  type FsEntry,
  type HistoryEntry,
} from "../lib/tauri";
import { pathKey } from "../lib/types";

/** A tree node the Explorer context menu is acting on. */
interface MenuTarget {
  path: string;
  name: string;
  isDir: boolean;
  x: number;
  y: number;
}

interface TipProps {
  children: ReactNode;
  /** First line: the name as shown in the tree. */
  name: string;
  /** Second line: the full path, dimmed so the name reads first. */
  detail?: string;
}

/**
 * Two-line tooltip for the file tree: name on top, full path underneath.
 *
 * A native `title` attribute cannot do this — it renders one unstyled string in an
 * OS-drawn bubble, so the path would end up on the same line and could not be dimmed.
 * Hence the overlay. It sits below the row unconditionally: a tooltip above the cursor
 * covers the very thing being pointed at, and the tree reserves room at the bottom.
 */
function TreeTooltip({ children, name, detail }: TipProps) {
  // `alignEnd` right-aligns the bubble to the cursor when there is not enough room to
  // the right, which is what keeps it on screen near the window edge.
  const [tip, setTip] = useState<{ x: number; y: number; alignEnd: boolean } | null>(null);
  return (
    <>
      <div
        onMouseEnter={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const widest = 444; // the CSS max-width plus a little breathing room
          setTip({
            x: e.clientX,
            y: rect.bottom,
            alignEnd: e.clientX > window.innerWidth - widest,
          });
        }}
        onMouseLeave={() => setTip(null)}
      >
        {children}
      </div>
      {tip && detail && (
        <div
          className={`tree-tip${tip.alignEnd ? " align-end" : ""}`}
          style={{ left: tip.x, top: tip.y }}
          role="tooltip"
        >
          <span className="tree-tip-name">{name}</span>
          <span className="tree-tip-path">{detail}</span>
        </div>
      )}
    </>
  );
}

interface TreeHandlers {
  activePath: string | null;
  onOpenPath: (path: string) => void;
  /** Opens a side-by-side comparison between this file and another one. */
  onCompare: (path: string) => void;
  onError: (message: string) => void;
  /**
   * A folder starts collapsed once its depth reaches this. 0 collapses every level, which
   * is the default: an Explorer that opens already unfolded hides how deep the folder
   * goes, and a deep tree costs a listing per level before anything is read.
   */
  expandLimit: number;
  /** Opens the Explorer context menu for a node. */
  onContextMenu: (target: Omit<MenuTarget, "x" | "y">, x: number, y: number) => void;
}

interface NodeProps extends TreeHandlers {
  depth: number;
}

interface LevelProps extends NodeProps {
  entries: FsEntry[];
}

function indent(depth: number) {
  return { paddingLeft: 12 + depth * 16 };
}

function FileRow({
  entry,
  depth,
  activePath,
  onOpenPath,
  onContextMenu: openMenu,
}: NodeProps & { entry: FsEntry }) {
  const active = !!activePath && pathKey(activePath) === pathKey(entry.path);
  return (
    <TreeTooltip name={entry.name} detail={entry.path}>
      <div
        className={`tree-row file${active ? " ctx-active" : ""}`}
        style={indent(depth)}
        onClick={() => onOpenPath(entry.path)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu({ path: entry.path, name: entry.name, isDir: false }, e.clientX, e.clientY);
        }}
      >
        <span className="chev" />
        <span className="ti">
          <FileIcon name={entry.name} />
        </span>
        <span className="tn">{entry.name}</span>
      </div>
    </TreeTooltip>
  );
}

function FolderNode({
  entry,
  depth,
  onContextMenu: openMenu,
  expandLimit,
  ...handlers
}: NodeProps & { entry: FsEntry }) {
  // The initial state only: a folder the user folded stays folded, so the setting applies
  // when a directory is opened (or refreshed), not to the tree already on screen.
  const [collapsed, setCollapsed] = useState(depth >= expandLimit);
  const [children, setChildren] = useState<FsEntry[] | null>(null);

  useEffect(() => {
    if (collapsed || children !== null) return;
    let alive = true;
    api
      .listDir(entry.path)
      .then((list) => {
        if (alive) setChildren(list);
      })
      .catch((e) => {
        if (alive) setChildren([]);
        handlers.onError(`${entry.name}: ${errorMessage(e)}`);
      });
    return () => {
      alive = false;
    };
    // handlers only report failures; they are not part of the fetch condition
  }, [collapsed, children, entry.name, entry.path]);

  return (
    <>
      <TreeTooltip name={entry.name.replace(/\/$/, "")} detail={entry.path}>
        <div
          className={`tree-row folder${collapsed ? " collapsed" : ""}`}
          style={indent(depth)}
          onClick={() => setCollapsed((v) => !v)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu({ path: entry.path, name: entry.name, isDir: true }, e.clientX, e.clientY);
          }}
        >
          {/* An icon, not a character: it stays crisp at any DPI, and the expanded
              state is the same glyph turned a quarter turn (see the CSS). */}
          <span className="chev">
            <IconTreeChevron />
          </span>
          <span className="ti">
            <IconFolder />
          </span>
          <span className="tn">{entry.name.replace(/\/$/, "")}</span>
        </div>
      </TreeTooltip>
      {!collapsed &&
        (children === null ? (
          <div className="empty" style={indent(depth + 1)}>
            {t("side.loading")}
          </div>
        ) : (
          <TreeLevel
            {...handlers}
            entries={children}
            depth={depth + 1}
            expandLimit={expandLimit}
            onContextMenu={openMenu}
          />
        ))}
    </>
  );
}

function TreeLevel({ entries, depth, ...handlers }: LevelProps) {
  return (
    <>
      {entries.map((entry) =>
        entry.isDir ? (
          <FolderNode key={entry.path} {...handlers} entry={entry} depth={depth} />
        ) : (
          <FileRow key={entry.path} {...handlers} entry={entry} depth={depth} />
        )
      )}
    </>
  );
}

interface Props extends Omit<TreeHandlers, "onContextMenu" | "expandLimit"> {
  visible: boolean;
  width: number;
  view: "explorer" | "history";
  rootDir: string | null;
  history: HistoryEntry[];
  /** Expand folders when a directory is opened; off means every folder starts folded. */
  expandFolders: boolean;
  /** How many levels to expand when `expandFolders` is on. */
  expandDepth: number;
  onSetView: (view: "explorer" | "history") => void;
  onPickFolder: () => void;
  onRemoveHistory: (path: string) => void;
  /** Reveals a path in the Windows Explorer. */
  onReveal: (path: string) => void;
  /** Points the Explorer at a folder, the same action as the tab menu's. */
  onSetRoot: (dir: string) => void;
}

export default function Sidebar(props: Props) {
  const {
    visible,
    width,
    view,
    rootDir,
    history,
    activePath,
    onOpenPath,
    onCompare,
    onError,
    onSetView,
    onPickFolder,
    onRemoveHistory,
    onReveal,
    onSetRoot,
  } = props;
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  // 0 means "collapse everything", which is what having the setting off has to mean: a
  // negative or missing depth would otherwise expand the top level by accident.
  const expandLimit = props.expandFolders ? Math.max(1, Math.floor(props.expandDepth)) : 0;

  // Any click elsewhere, a scroll, or losing focus dismisses the menu. `mousedown` rather
  // than `click` so the click that opened it cannot immediately close it again.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const copy = async (text: string) => {
    const ok = await copyText(text);
    onError(ok ? t("side.copied", { value: text }) : t("side.copyFailed"));
  };

  /** Path relative to the tree root, which is what a teammate would want pasted. */
  const relativeToRoot = (path: string) => {
    if (!rootDir) return path;
    const root = rootDir.replace(/[\\/]+$/, "");
    return pathKey(path).startsWith(pathKey(root) + "/")
      ? path.slice(root.length + 1)
      : path;
  };

  useEffect(() => {
    if (!rootDir) {
      setEntries([]);
      return;
    }
    let alive = true;
    api
      .listDir(rootDir)
      .then((list) => {
        if (alive) setEntries(list);
      })
      .catch((e) => {
        if (!alive) return;
        setEntries([]);
        onError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
    // Re-fetch on view switch and explicit refresh so the listing cannot go stale.
  }, [rootDir, onError, view, refreshKey]);

  if (!visible) return null;

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar-head">
        <button
          className={`side-tab${view === "explorer" ? " active" : ""}`}
          onClick={() => onSetView("explorer")}
        >
          {t("side.explorer")}
        </button>
        <button
          className={`side-tab${view === "history" ? " active" : ""}`}
          onClick={() => onSetView("history")}
        >
          {t("side.history")}
        </button>
      </div>

      <div className={`side-view${view === "explorer" ? " active" : ""}`}>
        <div className="side-root" title={rootDir ?? undefined}>
          <span className="side-root-label">{t("side.rootLabel")}</span>
          <span className="side-root-path">{rootDir ?? t("side.noFolder")}</span>
        </div>
        <div className="side-actions">
          <button className="side-btn" onClick={onPickFolder}>
            {t("side.openFolder")}
          </button>
          <button
            className="side-btn side-btn-icon"
            title={t("side.refresh")}
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            ↻
          </button>
        </div>
        <div className="tree">
          {rootDir === null ? (
            <div className="empty">{t("side.noFolder")}</div>
          ) : (
            <TreeLevel
              key={refreshKey}
              entries={entries}
              depth={0}
              activePath={activePath}
              onOpenPath={onOpenPath}
              onCompare={onCompare}
              expandLimit={expandLimit}
              onError={onError}
              onContextMenu={(target, x, y) => setMenu({ ...target, x, y })}
            />
          )}
        </div>
      </div>

      <div className={`side-view${view === "history" ? " active" : ""}`}>
        {history.length === 0 ? (
          <div className="empty">{t("side.noHistory")}</div>
        ) : (
          history.map((item) => (
            <div
              key={item.path}
              className="hist-item"
              title={item.path}
              onClick={() => onOpenPath(item.path)}
            >
              <span className="hi-name">{item.name}</span>
              <span className="hi-path">{item.path}</span>
              <button
                className="hist-remove"
                title={t("side.removeHistory")}
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveHistory(item.path);
                }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>

      {menu && (
        <div
          className="ctx-menu"
          style={{ display: "block", left: menu.x, top: menu.y }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div
            className="ctx-item"
            onClick={() => {
              if (menu.isDir) onReveal(menu.path);
              else onOpenPath(menu.path);
              setMenu(null);
            }}
          >
            {t("side.menuOpen")}
          </div>
          {!menu.isDir && (
            <div
              className="ctx-item"
              onClick={() => {
                onCompare(menu.path);
                setMenu(null);
              }}
            >
              {t("cmp.menu")}
            </div>
          )}
          <div
            className="ctx-item"
            onClick={() => {
              onReveal(menu.path);
              setMenu(null);
            }}
          >
            {t("side.menuReveal")}
          </div>
          <div className="ws-sep" />
          <div className="ctx-item" onClick={() => { void copy(menu.name); setMenu(null); }}>
            {t("side.menuCopyName")}
          </div>
          <div className="ctx-item" onClick={() => { void copy(menu.path); setMenu(null); }}>
            {t("side.menuCopyPath")}
          </div>
          <div
            className="ctx-item"
            onClick={() => { void copy(relativeToRoot(menu.path)); setMenu(null); }}
          >
            {t("side.menuCopyRelative")}
          </div>
          <div
            className="ctx-item"
            onClick={() => { void copy(parentOf(menu.path)); setMenu(null); }}
          >
            {t("side.menuCopyParent")}
          </div>
          {menu.isDir && (
            <>
              <div className="ws-sep" />
              <div
                className="ctx-item"
                onClick={() => {
                  onSetRoot(menu.path);
                  setMenu(null);
                }}
              >
                {t("side.menuSetRoot")}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
