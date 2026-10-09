import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconFolder, IconGoUp, IconTreeChevron } from "./icons";
import FileIcon from "./FileIcon";
import DeleteEntryDialog from "./DeleteEntryDialog";
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

/** A tree node an action is aimed at. `name` keeps the folder's trailing separator. */
interface NodeTarget {
  path: string;
  name: string;
  isDir: boolean;
}

/** A tree node the Explorer context menu is acting on. */
interface MenuTarget extends NodeTarget {
  x: number;
  y: number;
}

/**
 * A new entry being named: the folder it will go into, and what it will be.
 *
 * `null` when nothing is being created. Only one at a time, because there is one input.
 */
interface CreatingTarget {
  dir: string;
  isDir: boolean;
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

/**
 * The name of a tree row, or the input that stands in for it while that row is renamed.
 *
 * The text being typed lives here rather than in the sidebar: one row edits at a time, and
 * the draft belongs to that edit alone, so nothing has to track which node it came from.
 * An empty or unchanged name is taken as a cancellation, the same way Explorer reads it —
 * which is also the rule a new entry is named by, so the two share this component.
 */
function RowName({
  editing,
  name,
  placeholder,
  onCommit,
  onCancel,
}: {
  editing: boolean;
  name: string;
  /** Shown in place of the name while an empty input waits to be filled in. */
  placeholder?: string;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  // A folder's listing carries a trailing separator, which is not part of its name.
  const current = name.replace(/\/$/, "");
  const [value, setValue] = useState(current);
  const busy = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // A row that was already on screen when the edit started has to be seeded from the entry
  // rather than keep whatever the last edit left behind.
  useEffect(() => {
    if (editing) setValue(current);
  }, [editing, current]);

  if (!editing) return <span className="tn">{current}</span>;

  const submit = () => {
    if (busy.current) return;
    const next = value.trim();
    if (!next || next === current) {
      onCancel();
      return;
    }
    // One gesture can both press Enter and take the focus away, and the rename is a
    // filesystem operation that must not be asked for twice.
    busy.current = true;
    void onCommit(next).then((ok) => {
      busy.current = false;
      // A refused name stays open, with the text picked out so it can be retyped.
      if (!ok) inputRef.current?.select();
    });
  };

  return (
    <input
      ref={inputRef}
      className="tree-rename"
      value={value}
      placeholder={placeholder}
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      // The row opens the file on any click that reaches it, and the sidebar dismisses an
      // edit on any click it does not own, so neither must see these.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") submit();
        if (e.key === "Escape") onCancel();
      }}
      onBlur={submit}
    />
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
  onContextMenu: (target: NodeTarget, x: number, y: number) => void;
  /** `pathKey` of the node whose name is being edited in place, or null. */
  renaming: string | null;
  /** Renames a node on disk; resolves false when the name was refused. */
  onRename: (target: NodeTarget, name: string) => Promise<boolean>;
  /** Gives up on the edit in progress without touching the disk. */
  onRenameEnd: () => void;
  /** The folder a new entry is being named in, and what it will be; null when idle. */
  creating: CreatingTarget | null;
  /** Creates a node on disk; resolves false when the name or the disk refused it. */
  onCreate: (dir: string, name: string, isDir: boolean) => Promise<boolean>;
  /** Gives up on the new entry without touching the disk. */
  onCreateEnd: () => void;
  /**
   * Per-folder refetch counters. A rename only invalidates the listing of the folder that
   * held the entry, and re-reading just that one is what leaves the rest of the tree
   * expanded the way the user left it.
   */
  refreshed: Record<string, number>;
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

/**
 * The row a new file or folder is named in, shown at the end of the folder it will go into.
 *
 * It is an ordinary row with the name replaced by the input, because that is where the eye
 * already goes for a rename and where a name belongs in a tree. It carries no name of its
 * own, so `RowName` reads an empty one as "cancel" — which is what makes Escape and a
 * click elsewhere mean no without a case of its own.
 */
function NewRow({
  depth,
  isDir,
  onCommit,
  onCancel,
}: {
  depth: number;
  isDir: boolean;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  return (
    <div className="tree-row file" style={indent(depth)}>
      <span className="chev" />
      <span className="ti">{isDir ? <IconFolder /> : <FileIcon name="" />}</span>
      <RowName
        editing
        name=""
        placeholder={t(isDir ? "side.newFolderName" : "side.newFileName")}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

function FileRow({
  entry,
  depth,
  activePath,
  onOpenPath,
  renaming,
  onRename,
  onRenameEnd,
  onContextMenu: openMenu,
}: NodeProps & { entry: FsEntry }) {
  const active = !!activePath && pathKey(activePath) === pathKey(entry.path);
  const editing = renaming === pathKey(entry.path);
  return (
    <TreeTooltip name={entry.name} detail={entry.path}>
      <div
        className={`tree-row file${active ? " ctx-active" : ""}`}
        style={indent(depth)}
        // A click inside the row is the edit taking or losing the focus, not a request to
        // open the file the row happens to name.
        onClick={editing ? undefined : () => onOpenPath(entry.path)}
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
        <RowName
          editing={editing}
          name={entry.name}
          onCommit={(name) =>
            onRename({ path: entry.path, name: entry.name, isDir: false }, name)
          }
          onCancel={onRenameEnd}
        />
      </div>
    </TreeTooltip>
  );
}

function FolderNode({
  entry,
  depth,
  renaming,
  onRename,
  onRenameEnd,
  creating,
  onCreate,
  onCreateEnd,
  onContextMenu: openMenu,
  expandLimit,
  refreshed,
  ...handlers
}: NodeProps & { entry: FsEntry }) {
  // The initial state only: a folder the user folded stays folded, so the setting applies
  // when a directory is opened (or refreshed), not to the tree already on screen.
  const [collapsed, setCollapsed] = useState(depth >= expandLimit);
  /**
   * The listing, with the refetch counter it was read for. Keeping the counter next to the
   * entries is what lets one folder be re-read without touching the rest of the tree: a
   * plain state reset would fold it as well, and the rows the user opened are the reason
   * the folder was worth expanding.
   */
  const [listing, setListing] = useState<{ token: number; entries: FsEntry[] } | null>(null);
  const token = refreshed[pathKey(entry.path)] ?? 0;
  const editing = renaming === pathKey(entry.path);
  const naming = !!creating && pathKey(creating.dir) === pathKey(entry.path);

  // A folder being added to has to be open: an input row created inside a collapsed folder
  // would be off screen, taking the focus with it.
  useEffect(() => {
    if (naming) setCollapsed(false);
  }, [naming]);

  useEffect(() => {
    if (collapsed || listing?.token === token) return;
    let alive = true;
    api
      .listDir(entry.path)
      .then((list) => {
        if (alive) setListing({ token, entries: list });
      })
      .catch((e) => {
        if (alive) setListing({ token, entries: [] });
        handlers.onError(`${entry.name}: ${errorMessage(e)}`);
      });
    return () => {
      alive = false;
    };
    // handlers only report failures; they are not part of the fetch condition
  }, [collapsed, listing?.token, token, entry.name, entry.path]);

  const children = listing?.token === token ? listing.entries : null;

  return (
    <>
      <TreeTooltip name={entry.name.replace(/\/$/, "")} detail={entry.path}>
        <div
          className={`tree-row folder${collapsed ? " collapsed" : ""}`}
          style={indent(depth)}
          onClick={editing ? undefined : () => setCollapsed((v) => !v)}
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
          <RowName
            editing={editing}
            name={entry.name}
            onCommit={(name) =>
              onRename({ path: entry.path, name: entry.name, isDir: true }, name)
            }
            onCancel={onRenameEnd}
          />
        </div>
      </TreeTooltip>
      {!collapsed && (
        <>
          {children === null ? (
            <div className="empty" style={indent(depth + 1)}>
              {t("side.loading")}
            </div>
          ) : (
            <TreeLevel
              {...handlers}
              entries={children}
              depth={depth + 1}
              expandLimit={expandLimit}
              renaming={renaming}
              onRename={onRename}
              onRenameEnd={onRenameEnd}
              creating={creating}
              onCreate={onCreate}
              onCreateEnd={onCreateEnd}
              onContextMenu={openMenu}
              refreshed={refreshed}
            />
          )}
          {/* At the end of the listing, where an entry sorts to anyway once it exists. It
              does not wait for the listing: the folder is known, so the input can be there
              while the rows above it are still on their way. */}
          {naming && (
            <NewRow
              depth={depth + 1}
              isDir={creating.isDir}
              onCommit={(name) => onCreate(entry.path, name, creating.isDir)}
              onCancel={onCreateEnd}
            />
          )}
        </>
      )}
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

interface Props extends Omit<
  TreeHandlers,
  | "onContextMenu"
  | "expandLimit"
  | "renaming"
  | "onRenameEnd"
  | "refreshed"
  | "creating"
  | "onCreate"
  | "onCreateEnd"
> {
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
  /**
   * Creates a file or a folder in `dir`; resolves false when the name was refused, which
   * leaves the input open with the text picked out.
   */
  onCreate: (dir: string, name: string, isDir: boolean) => Promise<boolean>;
  /**
   * Copies `source` into the folder `target`, whole if it is a folder. Resolves false when
   * nothing was copied, in which case the tree is left showing what it already has.
   */
  onPaste: (source: string, target: string) => Promise<boolean>;
  /**
   * Deletes a file, or a folder and everything in it. The prompt is asked here rather than
   * in the tree, and the caller is only reached once the user has answered it.
   */
  onDelete: (target: NodeTarget) => Promise<boolean>;
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
  /** `pathKey` of the node whose name is being edited in place. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The folder a new entry is being named in, and what it will be. */
  const [creating, setCreating] = useState<CreatingTarget | null>(null);
  /** The node waiting on the delete prompt, or null. */
  const [deleting, setDeleting] = useState<NodeTarget | null>(null);
  /**
   * What "Copy" last took, waiting to be pasted.
   *
   * A path rather than the bytes: the tree is a view of the disk, and the copy is done by
   * the backend at paste time, so a folder copied and then edited still pastes what is there
   * now. It is also why the entry has to still exist when the paste happens — a copy is a
   * promise about a place, not a snapshot carried across.
   */
  const [clipboard, setClipboard] = useState<NodeTarget | null>(null);
  const [refreshed, setRefreshed] = useState<Record<string, number>>({});
  // 0 means "collapse everything", which is what having the setting off has to mean: a
  // negative or missing depth would otherwise expand the top level by accident.
  const expandLimit = props.expandFolders ? Math.max(1, Math.floor(props.expandDepth)) : 0;
  // `parentOf` answers "" for a drive root and a UNC share, which is what hides the row
  // there: there is genuinely nowhere to go up to.
  const parentDir = rootDir ? parentOf(rootDir) : "";
  // `C:\` is its own name, and a UNC share keeps both segments; only the trailing separator
  // goes, so the tooltip never names a dangling backslash.
  const parentName = parentDir ? parentDir.replace(/[\\/]+$/, "") || parentDir : "";

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

  /**
   * Re-read one folder's listing. The tree root is one more listing of its own, keyed the
   * same way, so a change in it goes through here as well and leaves every folder the user
   * had opened exactly as they were.
   */
  const bumpFolder = (dir: string) => {
    const key = pathKey(dir);
    setRefreshed((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  /**
   * Rename a node through the caller, then re-read just the folder that held it. Only a
   * rename that the disk accepted gets that far: a refused name leaves the edit open so it
   * can be corrected.
   */
  const commitRename = async (target: NodeTarget, name: string) => {
    if (!(await props.onRename(target, name))) return false;
    setRenaming(null);
    const parent = parentOf(target.path);
    if (!parent) {
      // A folder the tree is rooted at: the caller re-points the Explorer, and the new
      // `rootDir` brings the new listing by itself.
      setRefreshKey((k) => k + 1);
      return true;
    }
    bumpFolder(parent);
    return true;
  };

  /** Create the entry being named, then re-read the folder it went into. */
  const commitCreate = async (dir: string, name: string, isDir: boolean) => {
    if (!(await props.onCreate(dir, name, isDir))) return false;
    setCreating(null);
    bumpFolder(dir);
    return true;
  };

  /**
   * A paste lands inside a folder, and a file has no inside. Right-clicking one still means
   * "here", so the folder holding it is where the copy goes — the same reading Explorer
   * gives, and the one that makes a paste offered next to any row do something useful.
   */
  const pasteTarget = (target: NodeTarget | null): string | null => {
    if (!target) return null;
    // A right-click on the blank area names the folder being shown, which is the folder the
    // copy goes into — the only reading that is not a dead end.
    if (!target.path) return rootDir;
    if (target.isDir) return target.path;
    return parentOf(target.path) || rootDir;
  };

  /** Paste the copied entry into a folder, then re-read that folder so the copy shows. */
  const runPaste = async (target: NodeTarget | null) => {
    const dir = pasteTarget(target);
    if (!clipboard || !dir) return;
    if (!(await props.onPaste(clipboard.path, dir))) return;
    bumpFolder(dir);
  };

  /**
   * Carry out a delete the user has confirmed. The prompt is the only thing standing
   * between the menu and this, which is why nothing else calls the caller's delete.
   */
  const confirmDelete = async () => {
    const target = deleting;
    if (!target) return;
    const gone = await props.onDelete(target);
    setDeleting(null);
    // Only a delete that happened needs the folder re-read: a refused one left the listing
    // the tree already holds correct.
    if (gone) {
      // `parentOf` answers "" for a drive or share root, where the folder holding the
      // entry is the one the Explorer itself is showing.
      bumpFolder(parentOf(target.path) || rootDir || "");
    }
  };

  // The Explorer's own folder is one more listing, so renaming the root re-reads it here.
  const rootToken = rootDir ? (refreshed[pathKey(rootDir)] ?? 0) : 0;

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
    // Re-fetch on view switch, explicit refresh and a rename in this folder.
  }, [rootDir, onError, view, refreshKey, rootToken]);

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

      <div
        className={`side-view${view === "explorer" ? " active" : ""}`}
        // Every part of the Explorer answers a right-click with the tree's own menu: the
        // path bar, the buttons and the blank space below the rows alike. The browser's menu
        // offers nothing here a text editor can do, and a native one opening over a dark
        // panel reads as a broken app. `preventDefault` is unconditional for that reason —
        // even where no folder is open yet, there is one thing worth offering.
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // A right-click on a row is that row's business; its own handler has already
          // answered it and stopped the event.
          if ((e.target as HTMLElement).closest(".tree-row")) return;
          setMenu({ path: "", name: "", isDir: true, x: e.clientX, y: e.clientY });
        }}
      >
        <div className="side-root" title={rootDir ?? undefined}>
          <span className="side-root-path">{rootDir ?? t("side.noFolder")}</span>
          <button
            className="side-root-up"
            title={parentDir ? t("side.upToParentNamed", { name: parentName }) : t("side.noParent")}
            aria-label={t("side.upToParent")}
            disabled={!parentDir}
            onClick={() => parentDir && onSetRoot(parentDir)}
          >
            <IconGoUp size={13} />
          </button>
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
        {/* The handler the tree used to carry now sits on the whole view, so the blank
            space below the rows is covered by the same one: the round trip to the root
            folder's own row is the only way to create anything in it. */}
        <div className="tree">
          {rootDir === null ? (
            <div className="empty">{t("side.noFolder")}</div>
          ) : (
            <>
              <TreeLevel
                key={refreshKey}
                entries={entries}
                depth={0}
                activePath={activePath}
                onOpenPath={onOpenPath}
                onCompare={onCompare}
                expandLimit={expandLimit}
                onError={onError}
                renaming={renaming}
                onRename={commitRename}
                onRenameEnd={() => setRenaming(null)}
                creating={creating}
                onCreate={commitCreate}
                onCreateEnd={() => setCreating(null)}
                refreshed={refreshed}
                onContextMenu={(target, x, y) => setMenu({ ...target, x, y })}
              />
              {creating && pathKey(creating.dir) === pathKey(rootDir) && (
                <NewRow
                  depth={0}
                  isDir={creating.isDir}
                  onCommit={(name) => commitCreate(rootDir, name, creating.isDir)}
                  onCancel={() => setCreating(null)}
                />
              )}
            </>
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
          {/* No node was aimed at: the menu is about the folder being shown. With no folder
              open there is nothing to put anything in, so the only thing on offer is
              choosing one — which is what the panel's own button does. */}
          {!menu.path ? (
            rootDir === null ? (
              <div
                className="ctx-item"
                onClick={() => {
                  onPickFolder();
                  setMenu(null);
                }}
              >
                {t("side.openFolder")}
              </div>
            ) : (
              <>
                <div
                  className="ctx-item"
                  onClick={() => {
                    setCreating({ dir: rootDir, isDir: false });
                    setMenu(null);
                  }}
                >
                  {t("side.menuNewFile")}
                </div>
                <div
                  className="ctx-item"
                  onClick={() => {
                    setCreating({ dir: rootDir, isDir: true });
                    setMenu(null);
                  }}
                >
                  {t("side.menuNewFolder")}
                </div>
                {/* The folder being shown has no row of its own, so this is the only place
                    a paste into it can be asked for. */}
                {clipboard && (
                  <div
                    className="ctx-item"
                    onClick={() => {
                      void runPaste({ path: "", name: "", isDir: true });
                      setMenu(null);
                    }}
                  >
                    {t("side.menuPaste")}
                  </div>
                )}
              </>
            )
          ) : (
            <>
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
              {/* Both edits replace this menu, so the node they were aimed at is
                  remembered first. A new entry goes *into* a folder, never out of a
                  file, which is why these two are offered on a folder only. */}
              {menu.isDir && (
                <>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      setCreating({ dir: menu.path, isDir: false });
                      setMenu(null);
                    }}
                  >
                    {t("side.menuNewFile")}
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      setCreating({ dir: menu.path, isDir: true });
                      setMenu(null);
                    }}
                  >
                    {t("side.menuNewFolder")}
                  </div>
                </>
              )}
              <div
                className="ctx-item"
                onClick={() => {
                  setRenaming(pathKey(menu.path));
                  setMenu(null);
                }}
              >
                {t("side.menuRename")}
              </div>
              <div className="ws-sep" />
              {/* A copy here and a paste there, so both are offered on every row: what is
                  taken is the path, not the bytes, which is what lets a folder be copied
                  whole and pasted somewhere the tree can then show it. */}
              <div
                className="ctx-item"
                onClick={() => {
                  setClipboard({ path: menu.path, name: menu.name, isDir: menu.isDir });
                  // Nothing else moves when a copy is taken, so without a word about it the
                  // menu closing would be the only sign that anything happened.
                  onError(t("side.copyReady", { name: menu.name.replace(/\/$/, "") }));
                  setMenu(null);
                }}
              >
                {t("side.menuCopy")}
              </div>
              {clipboard && (
                <div
                  className="ctx-item"
                  onClick={() => {
                    void runPaste(menu);
                    setMenu(null);
                  }}
                >
                  {t("side.menuPaste")}
                </div>
              )}
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
              <div className="ws-sep" />
              {/* Delete opens a prompt rather than acting, so the target is handed over
                  whole: it is the prompt that shows the name and calls the delete. */}
              <div
                className="ctx-item ctx-danger"
                onClick={() => {
                  setDeleting({ path: menu.path, name: menu.name, isDir: menu.isDir });
                  setMenu(null);
                }}
              >
                {t("side.menuDelete")}
              </div>
            </>
          )}
        </div>
      )}

      {deleting && (
        <DeleteEntryDialog
          name={deleting.name.replace(/\/$/, "")}
          isDir={deleting.isDir}
          onDelete={() => void confirmDelete()}
          onCancel={() => setDeleting(null)}
        />
      )}
    </div>
  );
}
