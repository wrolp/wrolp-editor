import { useEffect, useState } from "react";
import { api, errorMessage, type FsEntry, type HistoryEntry } from "../lib/tauri";
import { pathKey } from "../lib/types";

interface TreeHandlers {
  activePath: string | null;
  onOpenPath: (path: string) => void;
  onError: (message: string) => void;
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

function FileRow({ entry, depth, activePath, onOpenPath }: NodeProps & { entry: FsEntry }) {
  const active = !!activePath && pathKey(activePath) === pathKey(entry.path);
  return (
    <div
      className={`tree-row file${active ? " ctx-active" : ""}`}
      style={indent(depth)}
      title={entry.path}
      onClick={() => onOpenPath(entry.path)}
    >
      <span className="chev" />
      <span className="ti">📄</span>
      <span className="tn">{entry.name}</span>
    </div>
  );
}

function FolderNode({ entry, depth, ...handlers }: NodeProps & { entry: FsEntry }) {
  const [collapsed, setCollapsed] = useState(depth >= 1);
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
      <div
        className={`tree-row folder${collapsed ? " collapsed" : ""}`}
        style={indent(depth)}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="chev">▾</span>
        <span className="ti">📁</span>
        <span className="tn">{entry.name.replace(/\/$/, "")}</span>
      </div>
      {!collapsed &&
        (children === null ? (
          <div className="empty" style={indent(depth + 1)}>
            Loading…
          </div>
        ) : (
          <TreeLevel {...handlers} entries={children} depth={depth + 1} />
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

interface Props extends TreeHandlers {
  visible: boolean;
  width: number;
  view: "explorer" | "history";
  rootDir: string | null;
  history: HistoryEntry[];
  onSetView: (view: "explorer" | "history") => void;
  onPickFolder: () => void;
  onRemoveHistory: (path: string) => void;
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
    onError,
    onSetView,
    onPickFolder,
    onRemoveHistory,
  } = props;
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

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
          Explorer
        </button>
        <button
          className={`side-tab${view === "history" ? " active" : ""}`}
          onClick={() => onSetView("history")}
        >
          History
        </button>
      </div>

      <div className={`side-view${view === "explorer" ? " active" : ""}`}>
        <div className="side-actions">
          <button className="side-btn" onClick={onPickFolder}>
            Open folder…
          </button>
          <button
            className="side-btn side-btn-icon"
            title="Refresh"
            onClick={() => setRefreshKey((k) => k + 1)}
          >
            ↻
          </button>
        </div>
        <div className="tree">
          {rootDir === null ? (
            <div className="empty">No folder open</div>
          ) : (
            <TreeLevel
              key={refreshKey}
              entries={entries}
              depth={0}
              activePath={activePath}
              onOpenPath={onOpenPath}
              onError={onError}
            />
          )}
        </div>
      </div>

      <div className={`side-view${view === "history" ? " active" : ""}`}>
        {history.length === 0 ? (
          <div className="empty">No recently opened files</div>
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
                title="Remove from history"
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
    </div>
  );
}
