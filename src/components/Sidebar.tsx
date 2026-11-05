import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { formatWhen, t } from "../lib/i18n";
import {
  IconChevron,
  IconCompare,
  IconCopy,
  IconEye,
  IconEyeOff,
  IconFile,
  IconFileLock,
  IconFilePlus,
  IconFolder,
  IconFolderPlus,
  IconGoUp,
  IconImage,
  IconOpenFolder,
  IconPaste,
  IconPencil,
  IconReload,
  IconRestore,
  IconSettings,
  IconTarget,
  IconTrash,
  IconTreeChevron,
  IconVersions,
} from "./icons";
import FileIcon from "./FileIcon";
import DeleteEntryDialog from "./DeleteEntryDialog";
import BatchRenameDialog from "./BatchRenameDialog";
import {
  api,
  copyText,
  errorMessage,
  parentOf,
  type FolderHistoryEntry,
  type FsEntry,
  type GitLocalPathState,
  type HistoryEntry,
  type VersionEntry,
  type VersionSummary,
} from "../lib/tauri";
import { basename, isUnder, isUntitled } from "../lib/path";
import type { NameEllipsis } from "../lib/nameEllipsis";
import NameText from "./NameText";
import PathTip, { useHoverTip } from "./PathTip";
import { pathKey, type GitMark, type SidebarView } from "../lib/types";
import { useMenuPlacement } from "../hooks/useMenuPlacement";

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
 * What the name being typed will produce.
 *
 * An encrypted file is a kind of its own rather than a flag on "file": nothing is written
 * until a password has been accepted, so both the row it is named in and the call it ends up
 * making differ from a plain new file's.
 */
export type EntryKind = "file" | "dir" | "encrypted";

/**
 * A new entry being named: the folder it will go into, and what it will be.
 *
 * `null` when nothing is being created. Only one at a time, because there is one input.
 */
interface CreatingTarget {
  dir: string;
  kind: EntryKind;
}

/** The naming row's placeholder, which is the only place the three kinds read differently. */
function kindPlaceholder(kind: EntryKind) {
  if (kind === "dir") return t("side.newFolderName");
  if (kind === "encrypted") return t("side.newEncryptedName");
  return t("side.newFileName");
}

/**
 * A refresh aimed at one folder: `path` is the folder, `token` says how far along the request
 * is. Every folder it covers re-reads, and nothing else does.
 *
 * Only the latest request is kept, so a folder has to remember the highest token it has been
 * given rather than compare for equality: two requests that cover different subtrees must not
 * send a folder that has already answered one of them back to the disk.
 */
interface RefreshRequest {
  path: string;
  token: number;
}

/**
 * The token `path` has to answer for, or 0 when this request is not about it.
 *
 * A folder covers itself, so refreshing a folder refreshes what is inside it: a file added
 * two levels down is not visible until the folders above it are read again.
 */
function covers(refresh: RefreshRequest | null, path: string): number {
  if (!refresh) return 0;
  return isUnder(path, refresh.path) ? refresh.token : 0;
}

interface TipProps {
  children: ReactNode;
  /** First line: the name as shown in the tree. */
  name: string;
  /** Second line: the full path, dimmed so the name reads first. */
  detail?: string;
}

/** `.folder-menu`'s CSS width. The panel is placed by hand, so the number is needed twice. */
const FOLDER_MENU_WIDTH = 260;

/**
 * How often the folders on screen are asked for their stamp. A stamp is one metadata call per
 * open folder — far cheaper than re-reading a listing — and 1.2 s is short enough that a file
 * created by another program is already in the tree by the time the user looks back at it.
 */
const DIR_POLL_MS = 1200;

/**
 * Tells the panel that a folder is open on screen, so a change another program makes inside it
 * can be noticed and only that folder read again. Returns the call that stops watching.
 */
type WatchDir = (path: string) => () => void;

/** How tall `.folder-menu`'s caret is, and so how far below the arrow the panel starts. */
const FOLDER_MENU_CARET = 6;

/**
 * How many rows one folder may draw in a single commit.
 *
 * A listing of a few thousand names otherwise turns into a few thousand rows in one go: the
 * commit and layout of that block the window for seconds, which is what reading it as "the
 * app froze" was. One screenful appears immediately and the rest follows a chunk per frame,
 * so the rows above stay clickable while the folder fills in.
 */
const LEVEL_CHUNK = 200;

/**
 * Two-line tooltip for the file tree: name on top, full path underneath.
 *
 * A native `title` attribute cannot do this — it renders one unstyled string in an
 * OS-drawn bubble, so the path would end up on the same line and could not be dimmed.
 * Hence the overlay. It hangs beside the cursor, clear of the pointer: a bubble placed at
 * the pointer's own position leaves the arrow sitting on the first characters of the name.
 */
function TreeTooltip({ children, name, detail }: TipProps) {
  const { tip, show, hide } = useHoverTip();
  return (
    <>
      <div onMouseEnter={show} onMouseLeave={hide}>
        {children}
      </div>
      <PathTip spot={tip?.spot ?? null} name={name} detail={detail ?? ""} />
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
  mode = "middle",
  placeholder,
  onCommit,
  onCancel,
}: {
  editing: boolean;
  name: string;
  /** How a name wider than the row is shortened. Unused while it is being edited. */
  mode?: NameEllipsis;
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

  if (!editing) return <NameText name={current} mode={mode} className="tn" />;

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
  /** Where a name too wide for its row is cut: both ends (`middle`) or the end (`end`). */
  nameEllipsis: NameEllipsis;
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
  /** `pathKey`s of the rows selected for a batch action. */
  selected: ReadonlySet<string>;
  /** Adds a row to the selection or takes it out, without opening anything (Ctrl+click). */
  onToggleSelect: (target: NodeTarget) => void;
  /** Selects every sibling between the anchor and this row (Shift+click). */
  onSelectRange: (target: NodeTarget, siblings: NodeTarget[]) => void;
  /** The folder a new entry is being named in, and what it will be; null when idle. */
  creating: CreatingTarget | null;
  /** Creates a node on disk; resolves false when the name or the disk refused it. */
  onCreate: (dir: string, name: string, kind: EntryKind) => Promise<boolean>;
  /** Gives up on the new entry without touching the disk. */
  onCreateEnd: () => void;
  /**
   * Per-folder refetch counters. A change to one entry only invalidates the listing of the
   * folder that held it, and re-reading just that one is what leaves the rest of the tree
   * expanded the way the user left it.
   */
  refreshed: Record<string, number>;
  /**
   * The refresh aimed at a folder, which reaches everything inside it. The latest one only:
   * a folder remembers the highest token it was given, so a request about one subtree never
   * sends another one back to the disk.
   */
  refresh: RefreshRequest | null;
  /**
   * An open folder tells the panel it is on screen, so a change made inside it by another
   * program can be noticed and only that folder read again. Returns the call that stops.
   */
  watchDir: WatchDir;
  /** Changed paths by `pathKey`, drawn as a one-letter badge on the row. */
  gitMarks: ReadonlyMap<string, GitMark>;
  /** How many changed paths sit under each folder, by `pathKey`. */
  gitDirs: ReadonlyMap<string, number>;
}

interface NodeProps extends TreeHandlers {
  depth: number;
  /**
   * Folded folders, by `pathKey`: the user's own answer. It lives above the rows because
   * showing another view unmounts the Explorer, and a fold is a choice about the folder rather
   * than about the view on screen. A folder with no entry follows `expandLimit`.
   */
  folded: ReadonlyMap<string, boolean>;
  /** Folds or opens a folder, remembering the answer for this root folder. */
  onFold: (key: string, folded: boolean) => void;
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
  kind,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: EntryKind;
  onCommit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  return (
    <div className="tree-row file" style={indent(depth)}>
      <span className="chev" />
      <span className="ti">
        {kind === "dir" ? (
          <IconFolder />
        ) : kind === "encrypted" ? (
          <IconFileLock />
        ) : (
          <FileIcon name="" />
        )}
      </span>
      <RowName
        editing
        name=""
        placeholder={kindPlaceholder(kind)}
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
  nameEllipsis,
  onOpenPath,
  renaming,
  onRename,
  onRenameEnd,
  onContextMenu: openMenu,
  selected,
  onToggleSelect,
  onSelectRange,
  siblings,
  gitMarks,
}: NodeProps & { entry: FsEntry; siblings: NodeTarget[] }) {
  const key = pathKey(entry.path);
  const active = !!activePath && pathKey(activePath) === key;
  const editing = renaming === key;
  const mark = gitMarks.get(key);
  // Ignored is not a change to act on, so the row reads as present but out of the project.
  const ignored = mark?.tone === "ignored";
  const target: NodeTarget = { path: entry.path, name: entry.name, isDir: false };
  return (
    <TreeTooltip name={entry.name} detail={entry.path}>
      <div
        className={`tree-row file${active ? " ctx-active" : ""}${selected.has(key) ? " sel" : ""}${
          ignored ? " ctx-ignored" : ""
        }`}
        style={indent(depth)}
        // A click inside the row is the edit taking or losing the focus, not a request to
        // open the file the row happens to name.
        onClick={
          editing
            ? undefined
            : (e) => {
                // A modified click is about the selection, not about opening: it stops here
                // so the view's own handler does not clear what it just changed.
                if (e.ctrlKey || e.metaKey) {
                  e.stopPropagation();
                  onToggleSelect(target);
                  return;
                }
                if (e.shiftKey) {
                  e.stopPropagation();
                  onSelectRange(target, siblings);
                  return;
                }
                onOpenPath(entry.path);
              }
        }
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          openMenu(target, e.clientX, e.clientY);
        }}
      >
        <span className="chev" />
        <span className="ti">
          <FileIcon name={entry.name} />
        </span>
        <RowName
          editing={editing}
          name={entry.name}
          mode={nameEllipsis}
          onCommit={(name) =>
            onRename({ path: entry.path, name: entry.name, isDir: false }, name)
          }
          onCancel={onRenameEnd}
        />
        {mark && (
          <span
            className={`tree-git ${mark.tone}`}
            title={t("git.markTitle", {
              letter: mark.letter,
              state: t(
                mark.tone === "ignored"
                  ? "git.markIgnored"
                  : mark.staged
                    ? "git.markStaged"
                    : "git.markUnstaged",
              ),
            })}
          >
            {mark.letter}
          </span>
        )}
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
  refresh,
  selected,
  onToggleSelect,
  onSelectRange,
  siblings,
  ...handlers
}: NodeProps & { entry: FsEntry; siblings: NodeTarget[] }) {
  const key = pathKey(entry.path);
  // The setting decides a folder nobody has touched. Once this one is folded or opened by hand,
  // that answer outlives the rows: another view unmounts them, and a fold is about the folder,
  // not about which view is looked at. Read on mount only, so folding one folder re-renders
  // that node rather than every row on screen.
  const [collapsed, setCollapsed] = useState(
    () => handlers.folded.get(key) ?? depth >= expandLimit
  );
  /**
   * The listing, with the refetch counter it was read for. Keeping the counter next to the
   * entries is what lets one folder be re-read without touching the rest of the tree: a
   * plain state reset would fold it as well, and the rows the user opened are the reason
   * the folder was worth expanding.
   */
  const [listing, setListing] = useState<{ token: number; entries: FsEntry[] } | null>(null);
  // Two ways to be asked for the same listing again: a counter of this folder's own, and the
  // counter of a refresh aimed at a folder above it. The higher one wins, so a folder always
  // re-reads at the newest request that covers it and never falls back to a stale question.
  const token = Math.max(refreshed[key] ?? 0, covers(refresh, entry.path));
  const editing = renaming === key;
  const naming = !!creating && pathKey(creating.dir) === key;
  const folderCount = handlers.gitDirs.get(key) ?? 0;
  // An ignored directory is reported by git as one path ending in a slash, so the folder row
  // itself is what dims — there is no file inside it to carry the mark.
  const folderIgnored = handlers.gitMarks.get(key)?.tone === "ignored";
  const target: NodeTarget = { path: entry.path, name: entry.name, isDir: true };

  // A folder being added to has to be open: an input row created inside a collapsed folder
  // would be off screen, taking the focus with it.
  useEffect(() => {
    if (!naming || !collapsed) return;
    setCollapsed(false);
    handlers.onFold(key, false);
  }, [naming, collapsed, key, handlers.onFold]);

  // An open folder is the only kind a change outside the app can make wrong: it has rows on
  // screen, and those rows are a reading of the disk that may no longer hold. Closing it
  // unregisters — the rows go with it, and opening it again reads the disk afresh.
  useEffect(() => {
    if (collapsed) return;
    return handlers.watchDir(entry.path);
  }, [collapsed, entry.path, handlers.watchDir]);

  useEffect(() => {
    // `>=` and not `===`: a listing read for a later counter than this folder has been asked
    // for is still current, and re-reading it would be work for no newer answer.
    if (collapsed || (listing !== null && listing.token >= token)) return;
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

  // The rows already read stay on screen while a newer listing is on its way. Blanking them
  // for a loading row would unmount every folder open inside, and a folder that mounts starts
  // folded — which is exactly the shape the refresh was supposed to keep.
  const children = listing ? listing.entries : null;

  return (
    <>
      <TreeTooltip name={entry.name.replace(/\/$/, "")} detail={entry.path}>
        <div
          className={`tree-row folder${collapsed ? " collapsed" : ""}${selected.has(key) ? " sel" : ""}${
            folderIgnored ? " ctx-ignored" : ""
          }`}
          style={indent(depth)}
          onClick={
            editing
              ? undefined
              : (e) => {
                  if (e.ctrlKey || e.metaKey) {
                    e.stopPropagation();
                    onToggleSelect(target);
                    return;
                  }
                  if (e.shiftKey) {
                    e.stopPropagation();
                    onSelectRange(target, siblings);
                    return;
                  }
                  const next = !collapsed;
                  setCollapsed(next);
                  handlers.onFold(key, next);
                }
          }
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openMenu(target, e.clientX, e.clientY);
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
            mode={handlers.nameEllipsis}
            onCommit={(name) =>
              onRename({ path: entry.path, name: entry.name, isDir: true }, name)
            }
            onCancel={onRenameEnd}
          />
          {folderCount > 0 && (
            <span
              className="tree-git-count"
              title={t("git.dirChanges", { n: folderCount })}
            >
              {folderCount}
            </span>
          )}
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
              selected={selected}
              onToggleSelect={onToggleSelect}
              onSelectRange={onSelectRange}
              refreshed={refreshed}
              refresh={refresh}
            />
          )}
          {/* At the end of the listing, where an entry sorts to anyway once it exists. It
              does not wait for the listing: the folder is known, so the input can be there
              while the rows above it are still on their way. */}
          {naming && (
            <NewRow
              depth={depth + 1}
              kind={creating.kind}
              onCommit={(name) => onCreate(entry.path, name, creating.kind)}
              onCancel={onCreateEnd}
            />
          )}
        </>
      )}
    </>
  );
}

function TreeLevel({ entries, depth, ...handlers }: LevelProps) {
  // The rows of this one folder, in the order they are drawn: what a Shift+click selects
  // between. Built once per listing rather than per row, and passed to every chunk because
  // a selection spans the rows of the folder, not just the chunk the click landed in.
  const siblings = useMemo<NodeTarget[]>(
    () => entries.map((entry) => ({ path: entry.path, name: entry.name, isDir: entry.isDir })),
    [entries]
  );
  // A folder can hold thousands of names. Making a row for every one of them in a single
  // commit blocks the paint for seconds, so the listing is cut into fixed chunks and each
  // frame draws one more. Cutting it once is what lets `TreeChunk`'s memo leave the chunks
  // already on screen alone when another one arrives.
  const chunks = useMemo(() => {
    const out: FsEntry[][] = [];
    for (let start = 0; start < entries.length; start += LEVEL_CHUNK) {
      out.push(entries.slice(start, start + LEVEL_CHUNK));
    }
    return out;
  }, [entries]);
  const [drawn, setDrawn] = useState(1);
  // A re-read can return fewer entries than the one already drawn (a deletion). The counter
  // has to come back down with it, or the next read would start by drawing everything.
  useEffect(() => {
    if (drawn > chunks.length) setDrawn(chunks.length);
  }, [drawn, chunks.length]);
  useEffect(() => {
    if (drawn >= chunks.length) return;
    const frame = window.requestAnimationFrame(() => setDrawn((n) => n + 1));
    return () => window.cancelAnimationFrame(frame);
  }, [drawn, chunks.length]);
  return (
    <>
      {chunks.slice(0, drawn).map((chunk, index) => (
        <TreeChunk key={index} {...handlers} entries={chunk} depth={depth} siblings={siblings} />
      ))}
    </>
  );
}

/**
 * One frame's worth of a listing.
 *
 * It is a component of its own so that appending the next chunk does not reconcile the rows
 * already drawn: their props are the same arrays and callbacks, so `memo` stops right there.
 */
const TreeChunk = memo(function TreeChunk({
  entries,
  depth,
  siblings,
  ...handlers
}: NodeProps & { entries: FsEntry[]; siblings: NodeTarget[] }) {
  return (
    <>
      {entries.map((entry) =>
        entry.isDir ? (
          <FolderNode
            key={entry.path}
            {...handlers}
            entry={entry}
            depth={depth}
            siblings={siblings}
          />
        ) : (
          <FileRow
            key={entry.path}
            {...handlers}
            entry={entry}
            depth={depth}
            siblings={siblings}
          />
        )
      )}
    </>
  );
});

interface Props extends Omit<
  TreeHandlers,
  | "onContextMenu"
  | "expandLimit"
  | "renaming"
  | "onRenameEnd"
  | "refreshed"
  | "refresh"
  | "watchDir"
  | "creating"
  | "onCreate"
  | "onCreateEnd"
  | "selected"
  | "onToggleSelect"
  | "onSelectRange"
> {
  visible: boolean;
  width: number;
  /**
   * Text size in CSS pixels for the sidebar's list content: the file tree, the recent files and
   * the folder menu. It reaches them as the `--sidebar-font` custom property, because each of
   * those rules sets its own size and an inherited value on this element was simply overridden.
   * The panel's chrome — tabs, buttons, tooltips — keeps its own sizes.
   */
  fontSize: number;
  /** Where a tree row's name is cut when the column cannot hold it: both ends, or the end. */
  nameEllipsis: NameEllipsis;
  view: SidebarView;
  rootDir: string | null;
  history: HistoryEntry[];
  /** Every file the store holds versions of, newest activity first. */
  versionList: VersionSummary[];
  /** The active file's timeline, newest first. Empty when it has no versions. */
  activeVersions: VersionEntry[];
  /** Expand folders when a directory is opened; off means every folder starts folded. */
  expandFolders: boolean;
  /** How many levels to expand when `expandFolders` is on. */
  expandDepth: number;
  onSetView: (view: SidebarView) => void;
  onPickFolder: () => void;
  onRemoveHistory: (path: string) => void;
  /** Remove several entries in one write; the paths are the ones the list shows. */
  onRemoveHistoryMany: (paths: string[]) => void;
  /** Ask to forget every opened file; the caller owns the confirmation dialog. */
  onClearHistory: () => void;
  /** Hand a file to the OS's default application (validated on the backend). */
  onOpenSystem: (path: string) => void;
  /** Folders this group's Explorer has been pointed at, newest first. */
  folderHistory: FolderHistoryEntry[];
  /** Forgets one folder so it stops being offered. */
  onRemoveFolder: (path: string) => void;
  /** Reveals a path in the Windows Explorer. */
  onReveal: (path: string) => void;
  /** Points the Explorer at a folder, the same action as the tab menu's. */
  onSetRoot: (dir: string) => void;
  /** Opens the folder's pictures in a gallery tab. */
  onBrowseImages: (dir: string) => void;
  /** Open one version beside what the editor holds now. */
  onCompareVersion: (path: string, oid: string) => void;
  /** Put a version's text into the editor, marked unsaved. */
  onRestoreVersion: (path: string, oid: string) => void;
  /**
   * Creates a file, a folder or an encrypted file in `dir`; resolves false when the name was
   * refused, which leaves the input open with the text picked out. An encrypted one also
   * resolves false when the password question was answered with nothing, and resolves only
   * once the container is on disk.
   */
  onCreate: (dir: string, name: string, kind: EntryKind) => Promise<boolean>;
  /**
   * Copies `source` into the folder `target`, whole if it is a folder. Resolves false when
   * nothing was copied, in which case the tree is left showing what it already has.
   */
  onPaste: (source: string, target: string) => Promise<boolean>;
  /**
   * Pastes the files sitting on the system clipboard — the ones Explorer copied — into `dir`.
   * Resolves false when nothing landed, which leaves the tree showing what it already has.
   */
  onPasteFiles: (dir: string) => Promise<boolean>;
  /**
   * Deletes a file, or a folder and everything in it. The prompt is asked here rather than
   * in the tree, and the caller is only reached once the user has answered it.
   */
  onDelete: (target: NodeTarget) => Promise<boolean>;
  /**
   * Renames the entries the tree has selected, as one batch. Every name is checked before
   * anything moves, so a refused one leaves the disk as it was. Resolves false then, which
   * keeps the dialog up with the names the user typed.
   */
  onBatchRename: (items: { path: string; name: string }[]) => Promise<boolean>;
  /** Explorer decorations for the active repository's changed paths. */
  gitMarks: ReadonlyMap<string, GitMark>;
  gitDirs: ReadonlyMap<string, number>;
  /**
   * A local-only git change was made from the tree (ignore, assume). The repository root is
   * handed back because the affected repository is not necessarily the one the panel shows.
   */
  onGitLocalChanged: (repoRoot: string) => void;
  /** Open the local Git settings dialog for a repository. */
  onOpenLocalSettings: (repoRoot: string) => void;
  /**
   * The Source Control panel, mounted here so it shares the sidebar's width and scroll area.
   * It is passed as a node rather than as a dozen props: every one of its decisions is the
   * panel's own, and Sidebar only owns the column it sits in.
   */
  gitPanel: ReactNode;
}

export default function Sidebar(props: Props) {
  const {
    visible,
    width,
    fontSize,
    nameEllipsis,
    view,
    rootDir,
    history,
    versionList,
    activeVersions,
    activePath,
    onOpenPath,
    onCompare,
    onError,
    onSetView,
    onPickFolder,
    onRemoveHistory,
    onRemoveHistoryMany,
    onClearHistory,
    onOpenSystem,
    folderHistory,
    onRemoveFolder,
    onReveal,
    onSetRoot,
    onBrowseImages,
    onCompareVersion,
    onRestoreVersion,
    onGitLocalChanged,
    onOpenLocalSettings,
  } = props;
  /**
   * The files with history that are not the one on screen. Compared by `pathKey` rather than by
   * string, because the store spells paths the way the filesystem does and a tab may have been
   * opened with a different case or separator.
   */
  const others = useMemo(() => {
    const active = activePath ? pathKey(activePath) : "";
    return versionList.filter((item) => pathKey(item.path) !== active);
  }, [activePath, versionList]);
  const [entries, setEntries] = useState<FsEntry[]>([]);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  /** History rows picked for a bulk remove, by `pathKey`. Independent of the tree's selection. */
  const [histSelected, setHistSelected] = useState<Set<string>>(new Set());
  /** The row a Shift+click measures its range from, within the history list. */
  const [histAnchor, setHistAnchor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAt = useMenuPlacement(menu, menuRef);
  /** The node's local git state once the probe has answered; null while asking or outside a repo. */
  const [localGit, setLocalGit] = useState<GitLocalPathState | null>(null);
  /** The path the probe was asked about, so a late answer for another row is dropped. */
  const localGitFor = useRef<string | null>(null);
  /** `pathKey` of the node whose name is being edited in place. */
  const [renaming, setRenaming] = useState<string | null>(null);
  /** The folder a new entry is being named in, and what it will be. */
  const [creating, setCreating] = useState<CreatingTarget | null>(null);
  /** The node waiting on the delete prompt, or null. */
  const [deleting, setDeleting] = useState<NodeTarget | null>(null);
  /**
   * The rows picked for a batch, by `pathKey`, each with the name it answers to.
   *
   * A map rather than a set of paths: the dialog needs names, and a rename between picking
   * and opening it would leave a set of paths that no row explains any more.
   */
  const [selected, setSelected] = useState<Map<string, NodeTarget>>(new Map());
  /** `pathKey` of the row a Shift+click measures its range from. */
  const [anchor, setAnchor] = useState<string | null>(null);
  /** The entries waiting in the batch rename dialog, or null. */
  const [batch, setBatch] = useState<NodeTarget[] | null>(null);
  /** Whether the recent-folders menu is open under the picker button. */
  const [foldersOpen, setFoldersOpen] = useState(false);
  /**
   * Where the open panel sits: the arrow's screen rect, taken the moment it opens.
   *
   * The panel is `fixed` rather than anchored to the arrow, because every box between the two
   * of them scrolls and a scroll container clips both axes. See `.folder-menu`.
   *
   * `caret` is where the arrow's middle landed inside the panel, so the triangle keeps pointing
   * at it even when the clamp below has slid the panel back into the window.
   */
  const [foldersAt, setFoldersAt] = useState<{
    left: number;
    top: number;
    caret: number;
  } | null>(null);
  const foldersArrow = useRef<HTMLButtonElement>(null);
  /** The open panel itself, so a wheel inside it can be told from a wheel anywhere else. */
  const foldersPanel = useRef<HTMLDivElement>(null);
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
  /** The refresh aimed at one folder, and what it covers. See `covers`. */
  const [refresh, setRefresh] = useState<RefreshRequest | null>(null);
  /** Only ever counts up: a folder compares tokens with `>=`, which is what needs that. */
  const refreshSeq = useRef(0);
  /**
   * The folders on screen, by path, with the stamp last read for each.
   *
   * `null` means "no reading yet": the folder has just been opened, or the app itself has just
   * re-read it. The next stamp becomes the baseline instead of counting as a change — otherwise
   * every listing the app writes would be followed by a second read of its own making.
   */
  const watchedDirs = useRef(new Map<string, number | null>());
  const watchDir = useCallback<WatchDir>((path) => {
    watchedDirs.current.set(path, null);
    return () => {
      watchedDirs.current.delete(path);
    };
  }, []);
  // 0 means "collapse everything", which is what having the setting off has to mean: a
  // negative or missing depth would otherwise expand the top level by accident.
  const expandLimit = props.expandFolders ? Math.max(1, Math.floor(props.expandDepth)) : 0;
  // `parentOf` answers "" for a drive root and a UNC share, which is what hides the row
  // there: there is genuinely nowhere to go up to.
  const parentDir = rootDir ? parentOf(rootDir) : "";
  // `C:\` is its own name, and a UNC share keeps both segments; only the trailing separator
  // goes, so the tooltip never names a dangling backslash.
  const parentName = parentDir ? parentDir.replace(/[\\/]+$/, "") || parentDir : "";

  /**
   * Ask which repository the row belongs to and what this machine already decided about it.
   * A failure is silence: a folder outside git has nothing to offer here, and an error toast
   * over a context menu would be noise about a menu the user has not chosen anything from.
   */
  const probeLocalGit = useCallback(async (path: string) => {
    const wanted = pathKey(path);
    localGitFor.current = wanted;
    setLocalGit(null);
    try {
      const state = await api.gitLocalState(path);
      if (localGitFor.current === wanted) setLocalGit(state);
    } catch {
      if (localGitFor.current === wanted) setLocalGit(null);
    }
  }, []);

  /** What the local git group would offer for the row under the pointer. */
  const localGitActions = localGit
    ? {
        ignore: !localGit.tracked && !localGit.ignored,
        gitignore: !localGit.tracked && !localGit.ignored,
        unignore: !localGit.tracked && localGit.ignored && !!localGit.localPattern,
        assume: localGit.tracked && !localGit.assumed,
        unassume: localGit.tracked && localGit.assumed,
      }
    : null;


  /**
   * Apply one local-only change. Both outcomes are reported through `onError`, which is what
   * this panel already uses for a sentence that is not a failure (a copy, a paste).
   */
  const runLocalGit = async (
    kind: "ignore" | "gitignore" | "unignore" | "assume" | "unassume"
  ) => {
    const target = menu;
    const state = localGit;
    if (!target || !state) return;
    setMenu(null);
    localGitFor.current = null;
    setLocalGit(null);
    const name = target.name.replace(/\/$/, "");
    try {
      if (kind === "ignore") {
        await api.gitLocalIgnore(target.path);
        onError(t("side.localIgnoreDone", { name }));
      } else if (kind === "gitignore") {
        await api.gitRepoIgnore(target.path);
        onError(t("side.gitignoreDone", { name }));
      } else if (kind === "unignore") {
        if (!state.localPattern) return;
        await api.gitLocalUnignore(state.repoRoot, state.localPattern);
        onError(t("side.localUnignoreDone", { name }));
      } else {
        await api.gitAssumeUnchanged(state.repoRoot, [target.path], kind === "assume");
        onError(t(kind === "assume" ? "side.assumeDone" : "side.unassumeDone", { name }));
      }
      onGitLocalChanged(state.repoRoot);
    } catch (e) {
      onError(errorMessage(e));
    }
  };

  // Any click elsewhere, a scroll, or losing focus dismisses the menu. `mousedown` rather
  // than `click` so the click that opened it cannot immediately close it again.
  useEffect(() => {
    if (!menu) return;
    const close = () => {
      localGitFor.current = null;
      setLocalGit(null);
      setMenu(null);
    };
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

  // The same dismissal for the folder menu: the button's own click stops propagation, so a
  // click elsewhere closes this and only this while the context menu keeps its own rules.
  useEffect(() => {
    if (!foldersOpen) return;
    const close = () => setFoldersOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    // A wheel over the panel is how one reaches the folders at the bottom of a long history, so
    // it cannot dismiss it: inside the panel the gesture belongs to the list. Everywhere else
    // it still closes, which is what the rest of the menus do. (Dismissing on `mousedown` stays
    // right even for the scrollbar, because Chromium delivers no DOM mouse event for that.)
    const onWheel = (e: WheelEvent) => {
      if (foldersPanel.current?.contains(e.target as Node)) return;
      close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", onWheel, { passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [foldersOpen]);

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
   * Re-read one folder, and everything open inside it.
   *
   * The counter goes into that folder's own slot as well as into the request, because the
   * tree root has no folder component to inherit the request and reads its counter directly.
   * Refreshing a folder reaches what is inside it on purpose: a file added two levels down is
   * not on screen until the folders above it are read again, and re-reading only the folder
   * that was clicked is how a tree ends up looking refreshed but still lying.
   *
   * Every other folder keeps the expansion and the listing it had, which is the whole point:
   * the rows the user opened are the reason the tree was worth opening.
   */
  const bumpFolder = (dir: string) => {
    const token = ++refreshSeq.current;
    setRefreshed((prev) => ({ ...prev, [pathKey(dir)]: token }));
    setRefresh({ path: dir, token });
    // What is about to be read becomes the folder's new baseline, so the poll does not report
    // this read's own change back as if another program had made it.
    if (watchedDirs.current.has(dir)) watchedDirs.current.set(dir, null);
    // A gallery tab is not part of the tree, so it cannot be bumped directly. The folder name
    // is enough for it to decide whether the change was inside what it is showing.
    window.dispatchEvent(
      new CustomEvent<string>("wrolp:folder-changed", { detail: dir })
    );
  };

  /**
   * Rename a node through the caller, then re-read just the folder that held it. Only a
   * rename that the disk accepted gets that far: a refused name leaves the edit open so it
   * can be corrected.
   */
  const commitRename = async (target: NodeTarget, name: string) => {
    if (!(await props.onRename(target, name))) return false;
    setRenaming(null);
    // `parentOf` answers "" for a drive or share root, where the folder holding the entry is
    // the one the Explorer itself is showing.
    const parent = parentOf(target.path) || rootDir;
    // A missing parent means there is no tree either: nothing is on screen that the rename
    // could have changed, so there is nothing to re-read.
    if (parent) bumpFolder(parent);
    return true;
  };

  /**
   * Create the entry being named, then re-read the folder it went into.
   *
   * An encrypted file resolves once its password has been accepted and the container is on
   * disk, so the re-read happens after the file exists rather than after the click. A password
   * that was never given resolves false and leaves the name input where it was.
   */
  const commitCreate = async (dir: string, name: string, kind: EntryKind) => {
    if (!(await props.onCreate(dir, name, kind))) return false;
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
   * Paste what Windows Explorer copied into a folder. There is no internal clipboard involved:
   * the files come from the system one, and the backend names them the same way a copy inside
   * the tree does.
   */
  const runPasteFiles = async (target: NodeTarget | null) => {
    const dir = pasteTarget(target);
    if (!dir) return;
    if (!(await props.onPasteFiles(dir))) return;
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

  /**
   * The selection, and the two gestures that build it.
   *
   * A plain click leaves it alone as far as this is concerned — it is handled by the view and
   * clears the selection — so holding more than one row always takes a modifier, which is
   * also what keeps a plain click on a row meaning "open it" for everybody else.
   */
  const toggleSelect = (target: NodeTarget) => {
    const key = pathKey(target.path);
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, target);
      return next;
    });
    setAnchor(key);
  };

  /** Everything between the anchor and this row, in the order the folder draws them. */
  const selectRange = (target: NodeTarget, siblings: NodeTarget[]) => {
    const key = pathKey(target.path);
    const to = siblings.findIndex((item) => pathKey(item.path) === key);
    const from =
      anchor === null ? -1 : siblings.findIndex((item) => pathKey(item.path) === anchor);
    // No anchor in this folder — a first Shift+click, or one after a click in another folder:
    // the range is then the row itself, which is the only reading that is not a guess.
    if (from < 0 || to < 0) {
      setSelected(new Map([[key, target]]));
      setAnchor(key);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    setSelected(
      new Map(siblings.slice(start, end + 1).map((item) => [pathKey(item.path), item]))
    );
  };

  const clearSelection = () => {
    setSelected(new Map());
    setAnchor(null);
  };

  /** Ctrl+click on a history row: in or out of the bulk selection, nothing opened. */
  const toggleHistSelect = (path: string) => {
    const key = pathKey(path);
    setHistSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    setHistAnchor(key);
  };

  /** Shift+click on a history row: everything between the anchor and it, in list order. */
  const histSelectRange = (path: string) => {
    const key = pathKey(path);
    const keys = history.map((item) => pathKey(item.path));
    const to = keys.indexOf(key);
    const from = histAnchor === null ? -1 : keys.indexOf(histAnchor);
    if (from < 0 || to < 0) {
      setHistSelected(new Set([key]));
      setHistAnchor(key);
      return;
    }
    const [start, end] = from <= to ? [from, to] : [to, from];
    setHistSelected(new Set(keys.slice(start, end + 1)));
  };

  /**
   * Carry out a batch the dialog has worked out, then re-read every folder an entry came
   * from: rows are listings of one folder, so those folders are the whole of what changed.
   */
  const applyBatch = async (items: { path: string; name: string }[]): Promise<boolean> => {
    const targets = batch;
    if (!targets) return false;
    if (!(await props.onBatchRename(items))) return false;
    const dirs = new Set<string>();
    for (const target of targets) {
      const parent = parentOf(target.path) || rootDir;
      if (parent) dirs.add(parent);
    }
    for (const dir of dirs) bumpFolder(dir);
    setBatch(null);
    clearSelection();
    return true;
  };

  /**
   * Open the batch dialog on everything a folder holds, without the user selecting it row by
   * row. The listing is read here rather than taken from the tree: a folder may be folded, and
   * a command that only saw the rows on screen would be a different, hidden one.
   */
  const batchFolder = async (dir: string) => {
    const list = await api.listDir(dir).catch((e) => {
      onError(errorMessage(e));
      return null;
    });
    if (!list) return;
    if (list.length === 0) {
      onError(t("batch.emptyFolder"));
      return;
    }
    setBatch(
      list.map((entry) => ({
        path: entry.path,
        // Folders carry their trailing separator here; the dialog works on bare names.
        name: basename(entry.path),
        isDir: entry.isDir,
      }))
    );
  };

  // The Explorer's own folder is one more listing, so it takes the same pair of counters any
  // other folder does: its own slot, and a request aimed at it or at something above it.
  const rootToken = rootDir
    ? Math.max(refreshed[pathKey(rootDir)] ?? 0, covers(refresh, rootDir))
    : 0;

  useEffect(() => {
    if (!rootDir) {
      setEntries([]);
      return;
    }
    let alive = true;
    // A refresh that arrives while this read is in flight re-runs the effect and `alive`
    // drops the older answer, so the last question asked is the one that gets answered.
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
    // Re-fetch on view switch, explicit refresh and a rename in this folder. The token only
    // ever counts up, so these do not re-run for a refresh aimed somewhere else in the tree.
  }, [rootDir, onError, view, rootToken]);

  /**
   * `bumpFolder` through a ref: the poll below must not restart every time the tree re-renders,
   * and the function it calls is rebuilt on each of those.
   */
  const bumpRef = useRef(bumpFolder);
  bumpRef.current = bumpFolder;

  // The tree of another folder is another set of open folders: the ones registered against the
  // old root went with it.
  useEffect(() => {
    watchedDirs.current.clear();
  }, [rootDir]);

  /**
   * Keep the open folders honest about the disk.
   *
   * A directory's own stamp moves when an entry inside it is created, removed or renamed, so
   * one metadata call per open folder is enough to notice a file that appeared or went behind
   * the app's back — a `git checkout`, another program's save, a terminal `rm`. Only the
   * folders on screen are asked about: a folded folder has no rows to correct, and re-reading
   * the whole tree on a timer is how a sidebar becomes a source of disk load.
   *
   * The rows that changed are re-read through the same path the refresh button uses, so the
   * expansion and the folders below stay exactly as the user left them.
   */
  useEffect(() => {
    if (!visible || view !== "explorer" || !rootDir) return;
    // The root is a listing like any other but has no folder row of its own, so nothing else
    // registers it.
    if (!watchedDirs.current.has(rootDir)) watchedDirs.current.set(rootDir, null);
    let alive = true;
    let reported = false;
    const tick = async () => {
      const paths = [...watchedDirs.current.keys()];
      if (paths.length === 0) return;
      // A folder that cannot be read answers 0, which is a change like any other: the re-read
      // is what makes a row disappear once its folder is gone.
      const stamps = await api.dirStamps(paths).catch((e: unknown) => {
        // Worth saying once: without this the feature simply does nothing, and a silent
        // no-op is the hardest kind of bug to report. The usual cause is a build whose
        // backend predates the command.
        if (!reported) {
          reported = true;
          console.warn("explorer: folder stamps unavailable", e);
        }
        return null;
      });
      if (!alive || !stamps) return;
      for (const stamp of stamps) {
        const seen = watchedDirs.current.get(stamp.path);
        // Closed while the answer was on its way: nothing on screen to correct.
        if (seen === undefined) continue;
        watchedDirs.current.set(stamp.path, stamp.mtime);
        if (seen !== null && seen !== stamp.mtime) bumpRef.current(stamp.path);
      }
    };
    const timer = window.setInterval(() => {
      // A window nobody is looking at has no rows to correct.
      if (!document.hidden) void tick();
    }, DIR_POLL_MS);
    // Coming back to the window is the moment a stale tree is most likely to be looked at, so
    // the next reading is taken right away rather than up to a poll later.
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [visible, view, rootDir]);

  // Rows of another folder are not rows of this one, so a selection does not outlive a change
  // of what the tree is showing. The history's own selection dies on the same boundary: a
  // bulk remove aimed at the list must not stay armed once the list is off screen.
  useEffect(() => {
    setSelected(new Map());
    setAnchor(null);
    setHistSelected(new Set());
    setHistAnchor(null);
  }, [view, rootDir]);

  /**
   * Folded folders by `pathKey`, the user's own answer. A ref rather than state: it is read
   * only when a row is created, and remembering a fold must not re-render a tree that already
   * shows the answer. It lives here because showing another view unmounts the Explorer, and the
   * fold is about the folder rather than about the view on screen.
   */
  const folded = useRef(new Map<string, boolean>());
  const rememberFold = useCallback((key: string, value: boolean) => {
    folded.current.set(key, value);
  }, []);
  // Another root folder is another tree, so the folds that named rows of the old one are
  // dropped before the new rows are created, not after: clearing once the tree was built could
  // hand a folder of the new root a fold that was made about a same-named folder of the old one.
  const foldedRoot = useRef(rootDir);
  if (foldedRoot.current !== rootDir) {
    foldedRoot.current = rootDir;
    folded.current.clear();
  }

  /**
   * Where each view was scrolled to, by name. Only the active view is mounted, so its scrollTop
   * goes with it; this is what brings the position back when the view returns.
   */
  const scrollTops = useRef(new Map<string, number>());
  const viewHost = useRef<HTMLDivElement | null>(null);

  // Scroll does not bubble, but a capture listener still reaches the element that owns the bar:
  // the view itself in one stylesheet, the Explorer's tree in another. Remembering the target's
  // position covers both without asking which one is in force.
  useEffect(() => {
    const host = viewHost.current;
    if (!host) return;
    const remember = (e: Event) => {
      if (!(e.target instanceof HTMLElement) || !e.target.isConnected) return;
      scrollTops.current.set(view, e.target.scrollTop);
    };
    host.addEventListener("scroll", remember, true);
    return () => host.removeEventListener("scroll", remember, true);
  }, [view]);

  useLayoutEffect(() => {
    const host = viewHost.current;
    const saved = scrollTops.current.get(view);
    if (!host || saved === undefined) return;
    const tree = host.querySelector<HTMLElement>(".tree");
    const apply = () => {
      host.scrollTop = saved;
      if (tree) tree.scrollTop = saved;
    };
    apply();
    if (saved === 0) return;
    // An Explorer that comes back re-reads the folders that were open, so the height the saved
    // position needs may not exist yet. Every row that lands is a chance to put it back, and
    // the user's first gesture ends the attempt so the view never fights them.
    const observer = new MutationObserver(apply);
    observer.observe(host, { childList: true, subtree: true });
    const stop = () => observer.disconnect();
    host.addEventListener("wheel", stop, { passive: true });
    host.addEventListener("pointerdown", stop);
    host.addEventListener("keydown", stop);
    return () => {
      observer.disconnect();
      host.removeEventListener("wheel", stop);
      host.removeEventListener("pointerdown", stop);
      host.removeEventListener("keydown", stop);
    };
  }, [view]);

  if (!visible) return null;

  return (
    <div
      className="sidebar"
      // A custom property, not a `fontSize` here: three rules set their own size, and an
      // inherited value was simply overridden by the tree's own rule, which is why a font size
      // set at this element changed nothing on screen.
      style={{ width, "--sidebar-font": `${fontSize}px` } as CSSProperties}
    >
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
        <button
          className={`side-tab${view === "versions" ? " active" : ""}`}
          onClick={() => onSetView("versions")}
        >
          {t("side.versions")}
        </button>
        <button
          className={`side-tab${view === "git" ? " active" : ""}`}
          onClick={() => onSetView("git")}
        >
          {t("side.git")}
        </button>
      </div>

      {view === "explorer" && (
      <div
        // `explorer` rather than only `active`: this is the one view with a header of its own
        // above the rows, and the stylesheet pins that header and scrolls the tree instead.
        className={`side-view explorer${view === "explorer" ? " active" : ""}`}
        ref={viewHost}
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
          // The root menu has no node of its own: a probe still in flight for a row must not
          // paint its local-git group under this one.
          localGitFor.current = null;
          setLocalGit(null);
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
          {/* A split button: the picker on the left, the recent-folders menu as its right
              half. They belong together because they are two ways to answer the same
              question — where the Explorer should look — and splitting one control in two
              makes the alternative a click further away than it needs to be. `mousedown` is
              stopped so the window listener that dismisses the menu cannot close it on the
              very click that opened it. */}
          <div
            className="side-split"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button className="side-btn side-split-main" onClick={onPickFolder}>
              {t("side.openFolder")}
            </button>
            <div className="side-split-tail">
              <button
                ref={foldersArrow}
                className={`side-btn side-split-arrow${foldersOpen ? " active" : ""}`}
                title={t("side.recentFolders")}
                aria-label={t("side.recentFolders")}
                aria-expanded={foldersOpen}
                onClick={() => {
                  // Placed on the way open, not kept up to date: the panel closes itself on
                  // the next wheel or click, so the rect cannot go stale while it is shown.
                  if (!foldersOpen) {
                    const r = foldersArrow.current?.getBoundingClientRect();
                    if (r) {
                      // Centred on the arrow, so the panel reads as the arrow's own dropdown
                      // rather than as something hanging off its left edge.
                      const mid = r.left + r.width / 2;
                      const left = Math.max(
                        8,
                        Math.min(
                          mid - FOLDER_MENU_WIDTH / 2,
                          window.innerWidth - FOLDER_MENU_WIDTH - 8,
                        ),
                      );
                      setFoldersAt({
                        left,
                        top: r.bottom + FOLDER_MENU_CARET,
                        caret: mid - left,
                      });
                    }
                  }
                  setFoldersOpen((v) => !v);
                }}
              >
                {/* Down, not sideways: this opens a panel below itself, and `IconTreeChevron`
                    points right because it means "expand" in the tree. */}
                <IconChevron size={14} />
              </button>
              {foldersOpen && foldersAt && (
                <div
                  ref={foldersPanel}
                  className="folder-menu"
                  style={
                    {
                      left: foldersAt.left,
                      top: foldersAt.top,
                      // Where the arrow's middle sits inside the panel, so the caret points at
                      // it from wherever the panel ended up after the clamp.
                      "--caret": `${foldersAt.caret}px`,
                    } as CSSProperties
                  }
                >
                  {/* The list scrolls rather than the panel, because the caret is drawn outside
                      the panel's box and a scroll container would clip it away. */}
                  <div className="folder-menu-list" role="menu">
                    {folderHistory.length === 0 ? (
                      <div className="empty">{t("side.noFolderHistory")}</div>
                    ) : (
                      folderHistory.map((item) => (
                        <div
                          key={item.path}
                          className={`ctx-item folder-item${item.exists ? "" : " gone"}`}
                          title={item.exists ? item.path : `${item.path} — ${t("side.folderGone")}`}
                          // A folder that is not there cannot be pointed at, so the row is
                          // shown but inert: greyed, and saying why on hover rather than
                          // failing on click.
                          onClick={() => {
                            if (!item.exists) return;
                            onSetRoot(item.path);
                            setFoldersOpen(false);
                          }}
                        >
                          <span className="ctx-icon">
                            <IconOpenFolder size={14} />
                          </span>
                          <span className="folder-item-name">{item.name}</span>
                          <button
                            className="folder-item-remove"
                            title={t("side.removeFolder")}
                            onClick={(e) => {
                              e.stopPropagation();
                              onRemoveFolder(item.path);
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <button
            className="side-btn side-btn-icon"
            title={t("side.refresh")}
            onClick={() => {
              // The whole tree is the root folder's own subtree, so this is the same request
              // the root's context menu makes: every open folder re-reads and stays open.
              if (!rootDir) return;
              bumpFolder(rootDir);
              // The rows a selection was made against are re-read, so it does not survive
              // the refresh; the folders' expansion does.
              clearSelection();
            }}
          >
            ↻
          </button>
        </div>
        {/* The handler the tree used to carry now sits on the whole view, so the blank
            space below the rows is covered by the same one: the round trip to the root
            folder's own row is the only way to create anything in it. */}
        <div className="tree" onClick={clearSelection}>
          {rootDir === null ? (
            <div className="empty">{t("side.noFolder")}</div>
          ) : (
            <>
              <TreeLevel
                // A different folder is a different listing: remounting resets how much of
                // it has been drawn, while a refresh of the same folder keeps the rows the
                // user already had on screen.
                key={rootDir}
                entries={entries}
                depth={0}
                activePath={activePath}
                nameEllipsis={nameEllipsis}
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
                refresh={refresh}
                watchDir={watchDir}
                folded={folded.current}
                onFold={rememberFold}
                gitMarks={props.gitMarks}
                gitDirs={props.gitDirs}
                selected={new Set(selected.keys())}
                onToggleSelect={toggleSelect}
                onSelectRange={selectRange}
                onContextMenu={(target, x, y) => {
                  // A right-click outside the selection means that row alone: keeping a
                  // selection the user is not looking at would make the menu act on rows
                  // other than the one under the pointer.
                  if (!selected.has(pathKey(target.path))) {
                    setSelected(new Map());
                    setAnchor(pathKey(target.path));
                  }
                  setMenu({ ...target, x, y });
                  void probeLocalGit(target.path);
                }}
              />
              {creating && pathKey(creating.dir) === pathKey(rootDir) && (
                <NewRow
                  depth={0}
                  kind={creating.kind}
                  onCommit={(name) => commitCreate(rootDir, name, creating.kind)}
                  onCancel={() => setCreating(null)}
                />
              )}
            </>
          )}
        </div>
      </div>
      )}

      {view === "history" && (
      <div className={`side-view${view === "history" ? " active" : ""}`} ref={viewHost}>
        {history.length > 0 && (
          <div className="side-actions">
            {histSelected.size > 0 && (
              <button
                className="side-btn"
                onClick={() => {
                  onRemoveHistoryMany(
                    history
                      .filter((h) => histSelected.has(pathKey(h.path)))
                      .map((h) => h.path)
                  );
                  setHistSelected(new Set());
                  setHistAnchor(null);
                }}
              >
                {t("side.removeSelected", { n: histSelected.size })}
              </button>
            )}
            <button className="side-btn" onClick={onClearHistory}>
              {t("side.clearHistory")}
            </button>
          </div>
        )}
        {history.length === 0 ? (
          <div className="empty">{t("side.noHistory")}</div>
        ) : (
          history.map((item) => {
            const key = pathKey(item.path);
            return (
              <div
                key={item.path}
                className={`hist-item${histSelected.has(key) ? " selected" : ""}`}
                title={item.path}
                onClick={(e) => {
                  // Multi-select rides the same modifiers as the tree: Ctrl toggles, Shift
                  // spans. A plain click keeps opening the file, but first drops a selection
                  // that would otherwise keep a bulk remove armed against rows off screen.
                  if (e.ctrlKey || e.metaKey) {
                    toggleHistSelect(item.path);
                    return;
                  }
                  if (e.shiftKey) {
                    histSelectRange(item.path);
                    return;
                  }
                  if (histSelected.size > 0) {
                    setHistSelected(new Set());
                    setHistAnchor(null);
                  }
                  onOpenPath(item.path);
                }}
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
            );
          })
        )}
      </div>
      )}

      {/* Versions: the active file's timeline opened, everything else folded to one line. The
          list of other files comes from the store's own folders, so it costs no history walk to
          show — which is why it says when a file was last recorded rather than how many times. */}
      {view === "versions" && (
      <div className={`side-view${view === "versions" ? " active" : ""}`} ref={viewHost}>
        {activePath && !isUntitled(activePath) ? (
          <div className="ver-current">
            <div className="ver-head" title={activePath}>
              <IconVersions size={13} />
              <span className="ver-head-name">{basename(activePath)}</span>
            </div>
            {activeVersions.length === 0 ? (
              <div className="empty">{t("ver.noneForThis")}</div>
            ) : (
              activeVersions.map((v) => (
                <div
                  key={v.oid}
                  className="ver-item"
                  // The row truncates its note, so the whole of it belongs in the tooltip: the title
                  // it shows, the lines written under that, and the ISO instant behind the formatted
                  // time.
                  title={`${formatWhen(v.ts)}${v.message ? ` · ${v.message}` : ""}\n${v.ts}${
                    v.body ? `\n\n${v.body}` : ""
                  }`}
                >
                  <span className="vi-when">{formatWhen(v.ts)}</span>
                  {v.message && <span className="vi-note">{v.message}</span>}
                  <span className="vi-actions">
                    <button
                      className="vi-btn"
                      title={t("ver.compare")}
                      onClick={() => onCompareVersion(activePath, v.oid)}
                    >
                      <IconCompare size={13} />
                    </button>
                    <button
                      className="vi-btn"
                      title={t("ver.restore")}
                      onClick={() => onRestoreVersion(activePath, v.oid)}
                    >
                      <IconRestore size={13} />
                    </button>
                  </span>
                </div>
              ))
            )}
          </div>
        ) : (
          <div className="empty">{t("ver.noFile")}</div>
        )}
        {others.length > 0 && (
          <>
            <div className="ver-section">{t("ver.otherFiles")}</div>
            {others.map((item) => (
              <div
                key={item.path}
                className="hist-item"
                title={item.path}
                onClick={() => onOpenPath(item.path)}
              >
                <span className="hi-name">{item.name}</span>
                <span className="hi-path">{formatWhen(item.latestTs)}</span>
              </div>
            ))}
          </>
        )}
      </div>
      )}

      {view === "git" && (
        <div className={`side-view${view === "git" ? " active" : ""}`} ref={viewHost}>
          {props.gitPanel}
        </div>
      )}

      {menu && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ display: "block", left: menuAt.left, top: menuAt.top }}
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
                <span className="ctx-icon">
                  <IconOpenFolder size={14} />
                </span>
                {t("side.openFolder")}
              </div>
            ) : (
              <>
                <div
                  className="ctx-item"
                  onClick={() => {
                    onBrowseImages(rootDir);
                    setMenu(null);
                  }}
                >
                  <span className="ctx-icon">
                    <IconImage size={14} />
                  </span>
                  {t("side.menuBrowseImages")}
                </div>
                <div
                  className="ctx-item"
                  onClick={() => {
                    bumpFolder(rootDir);
                    setMenu(null);
                  }}
                >
                  <span className="ctx-icon">
                    <IconReload size={14} />
                  </span>
                  {t("side.menuRefresh")}
                </div>
                <div className="ws-sep" />
                <div
                  className="ctx-item"
                  onClick={() => {
                    setCreating({ dir: rootDir, kind: "file" });
                    setMenu(null);
                  }}
                >
                  <span className="ctx-icon">
                    <IconFilePlus size={14} />
                  </span>
                  {t("side.menuNewFile")}
                </div>
                <div
                  className="ctx-item"
                  onClick={() => {
                    setCreating({ dir: rootDir, kind: "encrypted" });
                    setMenu(null);
                  }}
                >
                  <span className="ctx-icon">
                    <IconFileLock size={14} />
                  </span>
                  {t("enc.menuNew")}
                </div>
                <div
                  className="ctx-item"
                  onClick={() => {
                    setCreating({ dir: rootDir, kind: "dir" });
                    setMenu(null);
                  }}
                >
                  <span className="ctx-icon">
                    <IconFolderPlus size={14} />
                  </span>
                  {t("side.menuNewFolder")}
                </div>
                <div className="ws-sep" />
                <div
                  className="ctx-item"
                  onClick={() => {
                    const dir = rootDir;
                    setMenu(null);
                    void batchFolder(dir);
                  }}
                >
                  <span className="ctx-icon">
                    <IconPencil size={14} />
                  </span>
                  {t("side.menuBatchFolder")}
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
                    <span className="ctx-icon">
                      <IconPaste size={14} />
                    </span>
                    {t("side.menuPaste")}
                  </div>
                )}
                {/* Always offered: whether the system clipboard holds files is only knowable
                    at paste time, and a row that appears and disappears with another program's
                    clipboard would be a menu that changes under the cursor. */}
                <div
                  className="ctx-item"
                  onClick={() => {
                    void runPasteFiles({ path: "", name: "", isDir: true });
                    setMenu(null);
                  }}
                >
                  <span className="ctx-icon">
                    <IconPaste size={14} />
                  </span>
                  {t("side.menuPasteFiles")}
                </div>
              </>
            )
          ) : (
            <>
              {/* Only a file is opened in the editor. A folder is not, so it has nothing
                  to open and no item here: "Show in Windows Explorer" below is the one
                  that acts on it. */}
              {!menu.isDir && (
                <>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      onOpenPath(menu.path);
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconFile size={14} />
                    </span>
                    {t("side.menuOpen")}
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      onCompare(menu.path);
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconCompare size={14} />
                    </span>
                    {t("cmp.menu")}
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      onOpenSystem(menu.path);
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconOpenFolder size={14} />
                    </span>
                    {t("side.menuOpenSystem")}
                  </div>
                </>
              )}
              <div
                className="ctx-item"
                onClick={() => {
                  onReveal(menu.path);
                  setMenu(null);
                }}
              >
                <span className="ctx-icon">
                  <IconOpenFolder size={14} />
                </span>
                {t("side.menuReveal")}
              </div>
              <div className="ws-sep" />
              {/* Both edits replace this menu, so the node they were aimed at is
                  remembered first. A new entry goes *into* a folder, never out of a
                  file, which is why these are offered on a folder only. */}
              {menu.isDir && (
                <>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      onBrowseImages(menu.path);
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconImage size={14} />
                    </span>
                    {t("side.menuBrowseImages")}
                  </div>
                  {/* Re-reads this folder and everything open inside it, and leaves every
                      other folder exactly as it is: the tree keeps its shape, which is what
                      the toolbar's own refresh cannot do. */}
                  <div
                    className="ctx-item"
                    onClick={() => {
                      bumpFolder(menu.path);
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconReload size={14} />
                    </span>
                    {t("side.menuRefresh")}
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      setCreating({ dir: menu.path, kind: "file" });
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconFilePlus size={14} />
                    </span>
                    {t("side.menuNewFile")}
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      setCreating({ dir: menu.path, kind: "encrypted" });
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconFileLock size={14} />
                    </span>
                    {t("enc.menuNew")}
                  </div>
                  <div
                    className="ctx-item"
                    onClick={() => {
                      setCreating({ dir: menu.path, kind: "dir" });
                      setMenu(null);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconFolderPlus size={14} />
                    </span>
                    {t("side.menuNewFolder")}
                  </div>
                  <div className="ws-sep" />
                  {/* The same command as the selection's, aimed at everything the folder
                      holds: a folder is a unit of work, and picking its rows one by one to
                      say "all of them" is busywork. */}
                  <div
                    className="ctx-item"
                    onClick={() => {
                      const dir = menu.path;
                      setMenu(null);
                      void batchFolder(dir);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconPencil size={14} />
                    </span>
                    {t("side.menuBatchFolder")}
                  </div>
                </>
              )}
              {/* Two or more rows are a different question from one: one pattern applied to
                  each, previewed first. Offered only while the row under the pointer is part
                  of the selection, so the count and the target cannot disagree. */}
              {selected.size >= 2 && selected.has(pathKey(menu.path)) && (
                <div
                  className="ctx-item"
                  onClick={() => {
                    setBatch([...selected.values()]);
                    setMenu(null);
                  }}
                >
                  <span className="ctx-icon">
                    <IconPencil size={14} />
                  </span>
                  {t("side.menuBatchRename", { count: selected.size })}
                </div>
              )}
              <div
                className="ctx-item"
                onClick={() => {
                  setRenaming(pathKey(menu.path));
                  setMenu(null);
                }}
              >
                <span className="ctx-icon">
                  <IconPencil size={14} />
                </span>
                {t("side.menuRename")}
              </div>
              {/* A file still belongs to a folder, and "all of them" is a question about that
                  folder: the same command its own row offers, aimed at the one holding this
                  file. A folder's menu already has it for the folder itself. */}
              {!menu.isDir && (
                <div
                  className="ctx-item"
                  onClick={() => {
                    const dir = parentOf(menu.path) || rootDir;
                    setMenu(null);
                    if (dir) void batchFolder(dir);
                  }}
                >
                  <span className="ctx-icon">
                    <IconPencil size={14} />
                  </span>
                  {t("side.menuBatchFolder")}
                </div>
              )}
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
                <span className="ctx-icon">
                  <IconCopy size={14} />
                </span>
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
                  <span className="ctx-icon">
                    <IconPaste size={14} />
                  </span>
                  {t("side.menuPaste")}
                </div>
              )}
              <div
                className="ctx-item"
                onClick={() => {
                  void runPasteFiles(menu);
                  setMenu(null);
                }}
              >
                <span className="ctx-icon">
                  <IconPaste size={14} />
                </span>
                {t("side.menuPasteFiles")}
              </div>
              <div className="ws-sep" />
              {/* All four put text on the clipboard, so all four carry the same shape:
                  what differs is the text, and that is what the label says. */}
              <div className="ctx-item" onClick={() => { void copy(menu.name); setMenu(null); }}>
                <span className="ctx-icon">
                  <IconCopy size={14} />
                </span>
                {t("side.menuCopyName")}
              </div>
              <div className="ctx-item" onClick={() => { void copy(menu.path); setMenu(null); }}>
                <span className="ctx-icon">
                  <IconCopy size={14} />
                </span>
                {t("side.menuCopyPath")}
              </div>
              <div
                className="ctx-item"
                onClick={() => { void copy(relativeToRoot(menu.path)); setMenu(null); }}
              >
                <span className="ctx-icon">
                  <IconCopy size={14} />
                </span>
                {t("side.menuCopyRelative")}
              </div>
              <div
                className="ctx-item"
                onClick={() => { void copy(parentOf(menu.path)); setMenu(null); }}
              >
                <span className="ctx-icon">
                  <IconCopy size={14} />
                </span>
                {t("side.menuCopyParent")}
              </div>
              {localGit && (
                <>
                  <div className="ws-sep" />
                  {localGitActions?.ignore && (
                    <div className="ctx-item" onClick={() => void runLocalGit("ignore")}>
                      <span className="ctx-icon">
                        <IconEyeOff size={14} />
                      </span>
                      {t("side.menuLocalIgnore")}
                    </div>
                  )}
                  {localGitActions?.gitignore && (
                    <div className="ctx-item" onClick={() => void runLocalGit("gitignore")}>
                      <span className="ctx-icon">
                        <IconFile size={14} />
                      </span>
                      {t("side.menuGitignore")}
                    </div>
                  )}
                  {localGitActions?.unignore && (
                    <div className="ctx-item" onClick={() => void runLocalGit("unignore")}>
                      <span className="ctx-icon">
                        <IconEye size={14} />
                      </span>
                      {t("side.menuUnignore")}
                    </div>
                  )}
                  {localGitActions?.assume && (
                    <div className="ctx-item" onClick={() => void runLocalGit("assume")}>
                      <span className="ctx-icon">
                        <IconEyeOff size={14} />
                      </span>
                      {t("side.menuAssume")}
                    </div>
                  )}
                  {localGitActions?.unassume && (
                    <div className="ctx-item" onClick={() => void runLocalGit("unassume")}>
                      <span className="ctx-icon">
                        <IconEye size={14} />
                      </span>
                      {t("side.menuUnassume")}
                    </div>
                  )}
                  <div
                    className="ctx-item"
                    onClick={() => {
                      setMenu(null);
                      onOpenLocalSettings(localGit.repoRoot);
                    }}
                  >
                    <span className="ctx-icon">
                      <IconSettings size={14} />
                    </span>
                    {t("side.menuLocalSettings")}
                  </div>
                </>
              )}
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
                    <span className="ctx-icon">
                      <IconTarget size={14} />
                    </span>
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
                <span className="ctx-icon">
                  <IconTrash size={14} />
                </span>
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

      {batch && (
        <BatchRenameDialog
          entries={batch}
          onApply={applyBatch}
          onCancel={() => setBatch(null)}
        />
      )}
    </div>
  );
}
