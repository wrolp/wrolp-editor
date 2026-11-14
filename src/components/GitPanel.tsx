import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { formatClock, formatWhen, t, translateError } from "../lib/i18n";
import { pathKey } from "../lib/types";
import type {
  FolderHistoryEntry,
  GitCommitFile,
  GitLocalPathState,
  GitLogEntry,
  GitProgress,
  GitStatusEntry,
} from "../lib/tauri";
import { api, errorMessage, parentOf } from "../lib/tauri";
import { badgeTone } from "../lib/gitStatus";
import { basename } from "../lib/path";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import type { NameEllipsis } from "../lib/nameEllipsis";
import NameText from "./NameText";
import PathTip, { useHoverTip } from "./PathTip";
import { LOG_PAGE_CHOICES, type GitController } from "../hooks/useGit";
import type { GitRepoRow } from "../hooks/useGitRepos";
import { buildGraph } from "../lib/gitGraph";
import GitAuthDialog from "./GitAuthDialog";
import GitRemotesDialog from "./GitRemotesDialog";
import GitRowMenu from "./GitRowMenu";
import GraphCell from "./GitGraphRow";
import {
  IconBranch,
  IconChevron,
  IconCommit,
  IconEyeOff,
  IconFetch,
  IconFile,
  IconFolder,
  IconList,
  IconOutline,
  IconPull,
  IconPush,
  IconReload,
  IconRemote,
  IconRevert,
  IconStage,
  IconStop,
  IconUnstage,
} from "./icons";

interface Props {
  /** The group folder: what the scan started from and what "initialize repository" acts on. */
  workspaceRoot: string | null;
  /** The repository currently shown below the list. */
  repoRoot: string | null;
  repoRows: GitRepoRow[];
  repoScanning: boolean;
  repoTruncated: boolean;
  /** More repositories than the Explorer decoration limit. */
  decorateCapped: boolean;
  repoScanError: string | null;
  onSelectRepo: (root: string) => void;
  onAddRepo: () => void;
  /**
   * Move the Explorer to another folder. The panel follows it: the scan runs from that folder,
   * so what is shown afterwards is that folder's repository, not an extra entry in the list.
   */
  onSwitchWorkspace: () => void;
  /** Folders this group's Explorer has been pointed at, newest first. */
  folderHistory: FolderHistoryEntry[];
  /** Point the Explorer at one of those folders. */
  onOpenFolder: (dir: string) => void;
  onRemoveRepo: (root: string) => void;
  onRescanRepos: () => void;
  onInitWorkspace: () => Promise<void>;
  /** Clone a remote into the group's folder, for a folder that has no repository yet. */
  onCloneRepo: () => void;
  git: GitController;
  active: boolean;
  /** `pathKey` of open tabs holding unsaved edits: the disk text is not what the editor shows. */
  dirtyPaths: Set<string>;
  onOpenFile: (path: string) => void;
  /** `root` is the repository this panel is showing, not the group folder above it. */
  onDiff: (file: GitStatusEntry, scope: "workdir" | "index", root: string | null) => void;
  onCommitFileDiff: (commit: GitLogEntry, file: GitCommitFile, root: string | null) => void;
  /** Open the three-way merge editor for one conflicted path. */
  onMergeConflict: (file: GitStatusEntry) => void;
  onError: (message: string) => void;
  /** A short sentence about something that succeeded, shown like an error but not as one. */
  onNotice: (message: string) => void;
  /** Open the local Git settings dialog for one repository. */
  onOpenLocalSettings: (root: string) => void;
  /** Open one commit's changed files as a new tab. */
  onOpenCommitTab: (entry: GitLogEntry, root: string | null) => void;
  /** Whether the file lists group their rows by folder instead of listing whole paths. */
  treeView: boolean;
  /** Switch that grouping on or off. Remembered in the settings, like the other view switches. */
  onTreeViewChange: (next: boolean) => void;
  /**
   * Where a name too long for its row loses characters, the same value the tree and the tab
   * strip use. The defaults agree — the middle — so a path keeps both its head and its
   * extension without anybody choosing it.
   */
  nameEllipsis: NameEllipsis;
}

type Scope = "workdir" | "index";

/** One letter in front of a path, the way `git status --short` writes the two columns. */
function badgeLetter(file: GitStatusEntry, scope: Scope): string {
  if (file.kind === "conflicted") return "U";
  return (scope === "index" ? file.index : file.workdir) ?? "?";
}

function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return { name: path, dir: "" };
  return { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

/** A folder in the grouped view. `path` is the repo-relative folder, and also its key. */
interface GitTreeDir {
  name: string;
  path: string;
  dirs: GitTreeDir[];
  files: GitStatusEntry[];
}

/**
 * Fold a flat status list into the folders its paths name.
 *
 * The status comes back sorted by path, so folders and files are created in that order and the
 * tree needs no sort of its own. A file directly in the repository root sits at the top level,
 * beside the folders rather than in a row of its own.
 */
function buildGitTree(files: GitStatusEntry[]): GitTreeDir {
  const root: GitTreeDir = { name: "", path: "", dirs: [], files: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i];
      let next = node.dirs.find((dir) => dir.name === name);
      if (!next) {
        next = { name, path: parts.slice(0, i + 1).join("/"), dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(file);
  }
  return root;
}

/** Everything under a folder, which is the number its row shows. */
function countGitTree(dir: GitTreeDir): number {
  return dir.dirs.reduce((n, child) => n + countGitTree(child), dir.files.length);
}

/** How many actions fit in the header row; the rest move into the overflow menu. */
const HEAD_ACTIONS = 8;

/** One log row's height. `.git-log-row` in the stylesheet is 22px, and a window needs the number. */
const LOG_ROW_HEIGHT = 22;
/** Rows drawn above and below the visible band so a fast wheel does not show blank space. */
const LOG_OVERSCAN = 5;

/**
 * The nearest ancestor that scrolls vertically.
 *
 * The history is not a scroll container of its own: the sidebar view holding the panel is the
 * one that scrolls, so the window is worked out inside that element rather than the panel.
 */
function scrollHost(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const overflow = getComputedStyle(node).overflowY;
    if (overflow === "auto" || overflow === "scroll") return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * One button in the panel header. `anchor` is whatever was clicked, so an action that opens a
 * menu can put it under the control the user actually pressed — the row's button or the "…".
 */
interface HeadAction {
  key: string;
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  run: (anchor: HTMLElement) => void;
}

function progressText(progress: GitProgress): string {
  switch (progress.phase) {
    case "starting":
      return t("git.progressStarting");
    case "receiving":
      return progress.total > 0
        ? t("git.progressReceiving", { received: progress.received, total: progress.total })
        : t("git.progressReceivingUnknown", { bytes: progress.bytes });
    case "sending":
      return t("git.progressSending", { sent: progress.received, total: progress.total });
    case "message":
      return progress.text ?? "";
    case "merging":
      return t("git.progressMerging");
    case "writing":
      return t("git.progressWriting");
    case "canceling":
      return t("git.progressCanceling");
    default:
      return t("git.progressDone");
  }
}

export default function GitPanel({
  workspaceRoot,
  repoRoot,
  repoRows,
  repoScanning,
  repoTruncated,
  decorateCapped,
  repoScanError,
  onSelectRepo,
  onAddRepo,
  onSwitchWorkspace,
  folderHistory,
  onOpenFolder,
  onRemoveRepo,
  onRescanRepos,
  onInitWorkspace,
  onCloneRepo,
  git,
  active,
  dirtyPaths,
  onOpenFile,
  onDiff,
  onCommitFileDiff,
  onMergeConflict,
  onError,
  onNotice,
  onOpenLocalSettings,
  onOpenCommitTab,
  treeView,
  onTreeViewChange,
  nameEllipsis,
}: Props) {
  const [message, setMessage] = useState("");
  /**
   * Folders the grouped view has closed. Keyed by repository-relative folder, and kept here
   * rather than in the settings: which folders somebody happens to have collapsed is a state of
   * this reading, not a preference of theirs.
   */
  const [collapsedDirs, setCollapsedDirs] = useState<Record<string, boolean>>({});
  /**
   * One hover bubble for every file row in the panel, keyed by the file's absolute path — the
   * two-line shape the Explorer draws, because a native `title` cannot put the path on a line
   * of its own or dim it.
   */
  const { tip: fileTip, show: showFileTip, hide: hideFileTip } = useHoverTip<string>("pointer");
  const [amend, setAmend] = useState(false);
  /** The message HEAD had when amend was turned on, so switching it off can drop just that text. */
  const [amendBase, setAmendBase] = useState("");
  const amendSeq = useRef(0);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [remote, setRemote] = useState<string | null>(null);
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [discardAsk, setDiscardAsk] = useState<GitStatusEntry[] | null>(null);
  const [abortAsk, setAbortAsk] = useState(false);
  const [identityName, setIdentityName] = useState("");
  const [identityEmail, setIdentityEmail] = useState("");
  // Open by default: on a repository, the history is the thing the panel is opened to read, and
  // the section only reads it once the view is actually on screen (`active` below), so a closed
  // view still costs nothing.
  const [logOpen, setLogOpen] = useState(true);
  const [logAsked, setLogAsked] = useState(false);
  /** The slice of the history drawn while no commit is expanded, and the element it starts at. */
  const [logWindow, setLogWindow] = useState({ start: 0, end: 0 });
  const logRowsRef = useRef<HTMLDivElement>(null);
  /** The scrolling sidebar found once, rather than looked up on every scroll event. */
  const logHostRef = useRef<HTMLElement | null>(null);
  /** The repository whose remote addresses are being edited. */
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null);
  const [forceDeleteAsk, setForceDeleteAsk] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([]);
  const [commitFilesLoading, setCommitFilesLoading] = useState(false);
  /** The row whose local-only menu is open, and the probe's answer for it. */
  const [rowMenu, setRowMenu] = useState<{
    file: GitStatusEntry;
    x: number;
    y: number;
  } | null>(null);
  const [rowLocal, setRowLocal] = useState<GitLocalPathState | null>(null);
  const rowMenuFor = useRef<string | null>(null);
  /** The commit row whose own menu is open. */
  const [commitMenu, setCommitMenu] = useState<{
    entry: GitLogEntry;
    x: number;
    y: number;
  } | null>(null);
  const commitMenuRef = useRef<HTMLDivElement>(null);
  const commitMenuAt = useMenuPlacement(commitMenu, commitMenuRef);
  /** The recent-folders menu under the switch button, plus "pick another folder" behind it. */
  const [folderMenu, setFolderMenu] = useState<{ x: number; y: number } | null>(null);
  const folderMenuRef = useRef<HTMLDivElement>(null);
  const folderBtnRef = useRef<HTMLButtonElement>(null);
  const folderMenuAt = useMenuPlacement(folderMenu, folderMenuRef);
  /** The header row and what it measures itself against when deciding what still fits. */
  const headRowRef = useRef<HTMLDivElement>(null);
  const headBranchRef = useRef<HTMLButtonElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const [fitted, setFitted] = useState(HEAD_ACTIONS);
  const [headMenu, setHeadMenu] = useState<{ x: number; y: number } | null>(null);
  const headMenuRef = useRef<HTMLDivElement>(null);
  const headMenuAt = useMenuPlacement(headMenu, headMenuRef);
  /** The "+" menu: an existing folder to add, or a remote to clone into this one. */
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const addMenuAt = useMenuPlacement(addMenu, addMenuRef);
  /** The list as it is this render, for the measurement effect, which must not re-run per render. */
  const headActionsRef = useRef<HeadAction[]>([]);

  useEffect(() => {
    if (!folderMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (folderMenuRef.current?.contains(target) || folderBtnRef.current?.contains(target)) return;
      setFolderMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [folderMenu]);

  useEffect(() => {
    if (!headMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (headMenuRef.current?.contains(target) || moreBtnRef.current?.contains(target)) return;
      setHeadMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [headMenu]);

  useEffect(() => {
    if (!addMenu) return;
    const close = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (addMenuRef.current?.contains(target)) return;
      setAddMenu(null);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [addMenu]);

  // A different folder is a different repository; a half-typed message and a pending discard
  // question from the old one must not carry over.
  useEffect(() => {
    setMessage("");
    setCommitMenu(null);
    setAmend(false);
    setAmendBase("");
    amendSeq.current += 1;
    setBranchesOpen(false);
    setDiscardAsk(null);
    // Back to the default for the new repository rather than to what the last one was left at.
    setLogOpen(true);
    setLogAsked(false);
    setDeleteAsk(null);
    setForceDeleteAsk(null);
    setCommitOpen(null);
    setCommitFiles([]);
    setAbortAsk(false);
    setIdentityName("");
    setIdentityEmail("");
    setRemote(null);
    setRemotesOpen(false);
  }, [repoRoot]);

  useEffect(() => {
    // A list already in hand is left as it is: the panel is remounted whenever its view is
    // shown again, and re-reading the first page would throw away the pages already loaded.
    if (logOpen && active && git.status && !logAsked && git.log.length === 0) {
      setLogAsked(true);
      void git.loadLog();
    }
  }, [logOpen, active, git.status, logAsked, git.log.length, git.loadLog]);

  const status = git.status;
  const stagedFiles = useMemo(
    () => status?.files.filter((f) => f.kind !== "conflicted" && f.index !== null) ?? [],
    [status]
  );
  // A path can be in both lists at once (`M` in the index and `M` in the working tree), and it
  // must be: the two halves are different changes, and one button cannot stage the other.
  const changedFiles = useMemo(
    () => status?.files.filter((f) => f.kind !== "conflicted" && f.workdir !== null) ?? [],
    [status]
  );
  const conflictedFiles = useMemo(
    () => status?.files.filter((f) => f.kind === "conflicted") ?? [],
    [status]
  );

  /**
   * The graph for every commit the panel holds.
   *
   * Laid out over the whole array rather than page by page: the list is append-only and capped at
   * a few hundred rows, so re-laying it out on each append is cheap, and it cannot drift from the
   * array after a refresh the way a carried lane state could.
   */
  const graphRows = useMemo(
    () =>
      logOpen
        ? buildGraph(git.log.map((entry) => ({ oid: entry.oid, parents: entry.parents }))).rows
        : [],
    [logOpen, git.log]
  );

  /**
   * Whether the history can be scrolled as a fixed-height window.
   *
   * An expanded commit carries file rows of their own, so its section no longer answers to one
   * row height. That case, and the moment before those rows are known, is drawn whole: the expansion
   * is the part that has to be exact, and it is a single row rather than the length of the log.
   */
  const windowedLog = logOpen && commitOpen === null && !commitFilesLoading && git.log.length > 0;

  /** Work out which rows the scrolling sidebar is showing, from the list's place inside it. */
  const updateLogWindow = useCallback(() => {
    const rows = logRowsRef.current;
    if (!rows) return;
    const host = logHostRef.current ?? scrollHost(rows);
    if (!host) return;
    logHostRef.current = host;
    const listTop =
      rows.getBoundingClientRect().top - host.getBoundingClientRect().top + host.scrollTop;
    const top = Math.max(0, host.scrollTop - listTop);
    const bottom = Math.max(0, host.scrollTop + host.clientHeight - listTop);
    const total = git.log.length;
    const start = Math.max(0, Math.floor(top / LOG_ROW_HEIGHT) - LOG_OVERSCAN);
    const end = Math.min(total, Math.ceil(bottom / LOG_ROW_HEIGHT) + LOG_OVERSCAN);
    setLogWindow((current) =>
      current.start === start && current.end === end ? current : { start, end }
    );
  }, [git.log.length]);

  useLayoutEffect(() => {
    if (!windowedLog || !active) return;
    const rows = logRowsRef.current;
    if (!rows) return;
    const host = scrollHost(rows);
    if (!host) return;
    logHostRef.current = host;
    updateLogWindow();
    host.addEventListener("scroll", updateLogWindow, { passive: true });
    window.addEventListener("resize", updateLogWindow);
    const observer = new ResizeObserver(updateLogWindow);
    observer.observe(host);
    return () => {
      host.removeEventListener("scroll", updateLogWindow);
      window.removeEventListener("resize", updateLogWindow);
      observer.disconnect();
      if (logHostRef.current === host) logHostRef.current = null;
    };
  }, [windowedLog, active, updateLogWindow, folded, repoRows.length, repoTruncated, decorateCapped]);

  const logTotal = git.log.length;
  const logStart = Math.min(logWindow.start, logTotal);
  const logEnd = Math.min(Math.max(logWindow.end, logStart), logTotal);

  const head = status?.repo.head;
  const busy = git.busy !== null;
  const merging = status?.repo.state === "merge";
  // A merge commit records that the branches met even when the resolution equals HEAD, so it
  // needs no staged text — only the absence of unresolved conflicts.
  const canAmend = amend && !!head && !head.unborn && !merging;
  const canCommit =
    !!message.trim() &&
    !busy &&
    // Staged text does not make a merge committable while any conflict stage remains.
    !(merging && conflictedFiles.length > 0) &&
    // A message-only amend is a real amend: it needs no staged text.
    (stagedFiles.length > 0 || merging || canAmend);

  // The remote to talk to: the one picked, else the branch's, else `origin`, else the first.
  const activeRemote = useMemo(() => {
    if (remote && git.remotes.some((item) => item.name === remote)) return remote;
    const upstream = head?.upstream?.split("/")[0];
    return (
      git.remotes.find((item) => item.name === upstream)?.name ??
      git.remotes.find((item) => item.name === "origin")?.name ??
      git.remotes[0]?.name ??
      null
    );
  }, [remote, git.remotes, head?.upstream]);

  const doPull = async () => {
    const result = await git.pullRemote(activeRemote);
    if (!result) return;
    const key =
      result.result === "up_to_date"
        ? "git.pullUpToDate"
        : result.result === "fast_forward"
          ? "git.pullFastForward"
          : result.result === "merged"
            ? "git.pullMerged"
            : "git.pullConflicted";
    onNotice(t(key, { n: result.conflicted.length }));
  };

  const doPush = async () => {
    if (await git.pushRemote(activeRemote)) onNotice(t("git.pushDone"));
  };

  const suggestedUser = git.auth?.credentials.find(
    (credential) => credential.host === git.authAsk?.host
  )?.username;

  const openRowMenu = (event: ReactMouseEvent<HTMLDivElement>, file: GitStatusEntry) => {
    event.preventDefault();
    event.stopPropagation();
    const wanted = pathKey(file.abs);
    rowMenuFor.current = wanted;
    setRowLocal(null);
    setRowMenu({ file, x: event.clientX, y: event.clientY });
    void api
      .gitLocalState(file.abs)
      .then((state) => {
        if (rowMenuFor.current === wanted) setRowLocal(state);
      })
      .catch(() => {
        if (rowMenuFor.current === wanted) setRowLocal(null);
      });
  };

  const closeRowMenu = useCallback(() => {
    rowMenuFor.current = null;
    setRowMenu(null);
    setRowLocal(null);
  }, []);

  /** Run one local-only action and say what happened; `run` already reports failures. */
  const runRowAction = async (action: () => Promise<boolean>, done: string) => {
    if (await action()) onNotice(done);
  };

  useEffect(() => {
    if (!commitMenu) return;
    const close = () => setCommitMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
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
  }, [commitMenu]);

  const openCommit = async (entry: GitLogEntry) => {
    if (commitOpen === entry.oid) {
      setCommitOpen(null);
      return;
    }
    setCommitOpen(entry.oid);
    setCommitFiles([]);
    setCommitFilesLoading(true);
    try {
      if (!repoRoot) return;
      const files = await api.gitCommitFiles(repoRoot, entry.oid);
      setCommitFiles(files);
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setCommitFilesLoading(false);
    }
  };

  /**
   * Turning amend on loads the last commit's message into the box: an amend edits that message,
   * and starting from a blank box would silently replace it. Turning it off removes the text only
   * if it is still untouched, so a draft typed after the toggle survives.
   */
  const toggleAmend = async (on: boolean) => {
    const mine = ++amendSeq.current;
    setAmend(on);
    if (!on) {
      setMessage((current) => (current === amendBase ? "" : current));
      setAmendBase("");
      return;
    }
    if (!repoRoot) return;
    try {
      const last = await api.gitHeadCommit(repoRoot);
      if (mine !== amendSeq.current) return;
      if (!last) {
        setAmend(false);
        return;
      }
      const text = last.message.replace(/\s+$/, "");
      setAmendBase(text);
      setMessage(text);
    } catch (e) {
      if (mine === amendSeq.current) {
        setAmend(false);
        onError(errorMessage(e));
      }
    }
  };

  const submit = async () => {
    if (!canCommit) return;
    // A merge left over from before the toggle must not be amended: the backend refuses it, and
    // the button reads "Finish merge" for the same reason.
    const result = await git.commit(message, amend && canAmend);
    if (result) {
      setMessage("");
      setAmend(false);
      setAmendBase("");
    }
  };

  const runDiscard = async () => {
    if (!discardAsk) return;
    const files = discardAsk;
    setDiscardAsk(null);
    await git.discard(files);
  };

  const branchLabel = (() => {
    if (!head) return "";
    if (head.unborn) return head.branch ?? t("git.unborn");
    if (head.detached) return `${t("git.detached")} ${head.short ?? ""}`.trim();
    return head.branch ?? "HEAD";
  })();

  /** The recent-folders menu, opened under whichever control asked for it. */
  const openFolderMenu = (anchor: HTMLElement) => {
    if (folderMenu) {
      setFolderMenu(null);
      return;
    }
    // With no history there is nothing to choose between, so the picker is the whole gesture;
    // once there is, the list opens and the picker is its last entry.
    if (folderHistory.length === 0) {
      onSwitchWorkspace();
      return;
    }
    const rect = anchor.getBoundingClientRect();
    setFolderMenu({ x: rect.left, y: rect.bottom + 2 });
  };

  /**
   * The header's actions, in the order they appear. The row shows as many as fit and moves the
   * rest into the "…" menu one at a time, right to left — a fixed row is what turns a narrow
   * panel into a wall of squeezed icons.
   */
  const headActions: HeadAction[] = [
    {
      key: "fetch",
      label: t("git.fetch"),
      icon: <IconFetch size={13} />,
      disabled: busy || !activeRemote,
      run: () => void git.fetchRemote(activeRemote),
    },
    {
      key: "pull",
      label: t("git.pull"),
      icon: <IconPull size={13} />,
      disabled: busy || !activeRemote,
      run: () => void doPull(),
    },
    {
      key: "push",
      label: t("git.push"),
      icon: <IconPush size={13} />,
      disabled: busy || !activeRemote,
      run: () => void doPush(),
    },
    {
      key: "refresh",
      label: t("git.refresh"),
      icon: <IconReload size={13} />,
      run: () => void git.refresh(),
    },
    {
      key: "local",
      label: t("git.local.settings"),
      icon: <IconEyeOff size={13} />,
      run: () => {
        if (repoRoot) onOpenLocalSettings(repoRoot);
      },
    },
    {
      key: "remotes",
      label: t("git.remotes.manage"),
      icon: <IconRemote size={13} />,
      disabled: !repoRoot,
      run: () => setRemotesOpen(true),
    },
    {
      key: "folder",
      label: t("git.switchFolder"),
      icon: <IconFolder size={13} />,
      run: (anchor) => openFolderMenu(anchor),
    },
    {
      key: "add",
      // Two ways to end up with a repository in this folder: one that already exists somewhere,
      // or one that still lives on a server. The "+" asks which instead of assuming.
      label: t("git.repos.add"),
      icon: <span className="git-plus">＋</span>,
      run: (anchor) => {
        if (addMenu) {
          setAddMenu(null);
          return;
        }
        const rect = anchor.getBoundingClientRect();
        setAddMenu({ x: rect.left, y: rect.bottom + 2 });
      },
    },
  ];
  headActionsRef.current = headActions;

  // How many of them fit. The branch button keeps its own width (capped in CSS), so the space is
  // simply what the row has left; 22px per button plus its 1px gap, and one slot for "…" once
  // something is hidden. A resize of the sidebar or the window re-runs this.
  useLayoutEffect(() => {
    const row = headRowRef.current;
    if (!row) return;
    const measure = () => {
      const branch = headBranchRef.current?.offsetWidth ?? 0;
      const counter = row.querySelector<HTMLElement>(".git-counter")?.offsetWidth ?? 0;
      const space = Math.max(0, row.clientWidth - branch - counter - (counter > 0 ? 12 : 8));
      const total = headActionsRef.current.length;
      let fit = Math.floor(space / 23);
      if (fit < total) fit = Math.floor(Math.max(0, space - 24) / 23);
      setFitted(Math.min(total, Math.max(0, fit)));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    return () => observer.disconnect();
  }, [repoRoot, branchLabel, head?.ahead, head?.behind]);

  const errorCode = git.error ? git.error.split(":")[0] : "";

  /** One history row, with its file rows underneath when it is the expanded commit. */
  const renderLogRow = (entry: GitLogEntry, index: number) => {
    const open = commitOpen === entry.oid;
    const row = graphRows[index];
    return (
      <div key={entry.oid}>
        <div
          className={`git-log-row${open ? " open" : ""}`}
          title={`${entry.oid}\n${entry.author} · ${formatWhen(entry.time)}${
            entry.message.trimEnd() ? `\n\n${entry.message.trimEnd()}` : ""
          }`}
          onClick={() => void openCommit(entry)}
          onContextMenu={(event) => {
            // Taking the event before the row's click handler is what keeps a
            // right-click from expanding or collapsing the commit as well.
            event.preventDefault();
            event.stopPropagation();
            setCommitMenu({ entry, x: event.clientX, y: event.clientY });
          }}
        >
          {row && (
            <GraphCell
              row={row}
              head={entry.refs.some((ref) => ref.kind === "head")}
              names={entry.refs.map((ref) => ref.name).join(", ")}
            />
          )}
          <span className="git-log-short">{entry.short}</span>
          <span className="git-log-summary">
            {entry.summary || t("git.noMessage")}
          </span>
          {entry.refs.length > 0 && (
            <span className="git-refs">
              {entry.refs.slice(0, 2).map((ref) => (
                <span
                  key={`${ref.kind}:${ref.name}`}
                  className={`git-ref ${ref.kind}`}
                  title={ref.name}
                >
                  {ref.name}
                </span>
              ))}
              {entry.refs.length > 2 && (
                <span
                  className="git-ref more"
                  title={entry.refs.map((ref) => ref.name).join(", ")}
                >
                  +{entry.refs.length - 2}
                </span>
              )}
            </span>
          )}
          <span className="git-log-time">{formatWhen(entry.time)}</span>
          {/* The same instant without the date, for a row whose tip carries names in a narrow
              sidebar. The full one above is hidden by a container query there; the row's title has
              it in any case. */}
          <span className="git-log-clock">{formatClock(entry.time)}</span>
        </div>
        {open &&
          (commitFilesLoading ? (
            <div className="git-log-file muted">{t("git.loading")}</div>
          ) : (
            commitFiles.map((file) => {
              const { name, dir } = splitPath(file.path);
              return (
                <div
                  key={`${entry.oid}:${file.path}`}
                  className="git-log-file"
                  onMouseEnter={(event) => showFileTip(event, file.abs)}
                  onMouseLeave={hideFileTip}
                  onClick={() => onCommitFileDiff(entry, file, repoRoot)}
                >
                  <span className={`git-badge ${badgeTone(file.status)}`}>
                    {file.status}
                  </span>
                  <NameText name={name} mode={nameEllipsis} className="git-name" pinned />
                  <NameText name={dir} mode={nameEllipsis} className="git-dir" pinned />
                </div>
              );
            })
          ))}
      </div>
    );
  };

  /**
   * One file row. The two lists differ only in which half of the status the letter reads and
   * which buttons the row offers, so both shapes live here rather than being written twice.
   *
   * `depth` is the folder level in the grouped view. There the folder is already a row above,
   * so the row drops the dimmed path it carries in the flat view.
   */
  const fileRow = (file: GitStatusEntry, scope: Scope, depth: number) => {
    const { name, dir } = splitPath(file.path);
    const letter = badgeLetter(file, scope);
    return (
      <div
        key={`${scope}:${file.path}`}
        className="git-row"
        style={depth > 0 ? { paddingLeft: 12 + depth * 12 } : undefined}
        onMouseEnter={(event) => showFileTip(event, file.abs)}
        onMouseLeave={hideFileTip}
        onClick={() => onDiff(file, scope, repoRoot)}
        onContextMenu={(event) => openRowMenu(event, file)}
      >
        <span className={`git-badge ${badgeTone(letter)}`}>{letter}</span>
        <NameText name={name} mode={nameEllipsis} className="git-name" pinned />
        {!treeView && <NameText name={dir} mode={nameEllipsis} className="git-dir" pinned />}
        {dirtyPaths.has(pathKey(file.abs)) && (
          <span className="git-dirty" title={t("git.unsaved")}>
            ●
          </span>
        )}
        <span className="git-actions">
          {scope === "index" ? (
            <button
              className="git-action"
              title={t("git.unstage")}
              onClick={(e) => {
                e.stopPropagation();
                void git.unstage([file]);
              }}
            >
              <IconUnstage size={13} />
            </button>
          ) : (
            <>
              <button
                className="git-action"
                title={t("git.stage")}
                onClick={(e) => {
                  e.stopPropagation();
                  void git.stage([file]);
                }}
              >
                <IconStage size={13} />
              </button>
              <button
                className="git-action"
                title={t("git.discardFile")}
                onClick={(e) => {
                  e.stopPropagation();
                  setDiscardAsk([file]);
                }}
              >
                <IconRevert size={13} />
              </button>
            </>
          )}
          <button
            className="git-action"
            title={t("git.open")}
            onClick={(e) => {
              e.stopPropagation();
              onOpenFile(file.abs);
            }}
          >
            <IconFile size={13} />
          </button>
        </span>
      </div>
    );
  };

  /** A folder row of the grouped view: a fold toggle, the folder and how much is under it. */
  const dirRow = (node: GitTreeDir, depth: number, scope: Scope) => {
    const collapsed = !!collapsedDirs[node.path];
    return (
      <div
        key={`${scope}:dir:${node.path}`}
        className="git-row git-dir-row"
        style={{ paddingLeft: 12 + depth * 12 }}
        title={node.path}
        onClick={() => setCollapsedDirs((folded) => ({ ...folded, [node.path]: !collapsed }))}
      >
        <span className={`git-chev${collapsed ? " rot" : ""}`}>
          <IconChevron size={11} />
        </span>
        <span className="git-folder">
          <IconFolder size={13} />
        </span>
        <NameText name={node.name} mode={nameEllipsis} className="git-name" pinned />
        <span className="git-count">{countGitTree(node)}</span>
      </div>
    );
  };

  /** The rows of one list: folders first, then the files that sit beside them at this level. */
  const treeRows = (node: GitTreeDir, depth: number, scope: Scope): ReactNode[] => {
    const rows: ReactNode[] = [];
    for (const dir of node.dirs) {
      rows.push(dirRow(dir, depth, scope));
      if (!collapsedDirs[dir.path]) rows.push(...treeRows(dir, depth + 1, scope));
    }
    for (const file of node.files) rows.push(fileRow(file, scope, depth));
    return rows;
  };

  if (!workspaceRoot && repoRows.length === 0) {
    return <div className="empty">{t("git.noFolder")}</div>;
  }

  return (
    <div className="git-panel">
      {repoRows.length > 1 && (
        <div className="git-repos">
          <div className="git-repos-head">
            <span className="git-repos-title">{t("git.repos.heading")}</span>
            <button
              className="git-icon-btn"
              title={t("git.repos.rescan")}
              aria-label={t("git.repos.rescan")}
              disabled={repoScanning}
              onClick={onRescanRepos}
            >
              <IconReload size={12} />
            </button>
          </div>
          {repoRows.map((row) => (
            <div
              key={row.root}
              className={`git-repo-row${row.root === repoRoot ? " current" : ""}${row.unavailable ? " unavailable" : ""}`}
              title={row.manual ? t("git.repos.manualTitle", { path: row.root }) : row.root}
              onClick={() => onSelectRepo(row.root)}
            >
              <span className="git-repo-name">{row.name}</span>
              {row.relative && row.relative !== "." && (
                <span className="git-repo-rel">{row.relative}</span>
              )}
              {row.unavailable ? (
                <span className="git-repo-badge">{t("git.repos.unavailable")}</span>
              ) : (
                <>
                  {row.state !== "clean" && (
                    <span
                      className="git-repo-state"
                      title={t(`git.state.${row.state}`)}
                    >
                      ●
                    </span>
                  )}
                  {row.branch && <span className="git-repo-branch">{row.branch}</span>}
                  {row.ahead > 0 && <span className="git-repo-sync">↑{row.ahead}</span>}
                  {row.behind > 0 && <span className="git-repo-sync">↓{row.behind}</span>}
                  {row.changed > 0 && <span className="git-repo-count">{row.changed}</span>}
                </>
              )}
              {row.manual && (
                <button
                  className="git-repo-remove"
                  title={t("git.repos.remove")}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRemoveRepo(row.root);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          ))}
          {repoTruncated && (
            <div className="git-repos-note">{t("git.repos.truncated")}</div>
          )}
          {decorateCapped && (
            <div className="git-repos-note">{t("git.repos.decorateLimited")}</div>
          )}
        </div>
      )}

      {!repoRoot ? (
        repoScanning || repoRows.length > 0 ? (
          <div className="empty">{t("git.loading")}</div>
        ) : (
          <div className="git-empty">
            {repoScanError && (
              <div className="git-empty-title">{translateError(repoScanError)}</div>
            )}
            {!repoScanError && (
              <div className="git-empty-title">{t("git.repos.empty")}</div>
            )}
            <div className="git-bulk">
              <button className="git-small-btn" onClick={onAddRepo}>
                {t("git.repos.add")}
              </button>
              {workspaceRoot && (
                <button className="git-small-btn" onClick={onCloneRepo}>
                  {t("git.clone")}
                </button>
              )}
              {workspaceRoot && (
                <button className="git-small-btn" onClick={() => void onInitWorkspace()}>
                  {t("git.init")}
                </button>
              )}
            </div>
          </div>
        )
      ) : (
        <>
      <div className="git-head">
        <div className="git-head-row" ref={headRowRef}>
          <button
            ref={headBranchRef}
            className={`git-branch-btn${branchesOpen ? " active" : ""}`}
            title={head?.upstream ? t("git.upstream", { name: head.upstream }) : branchLabel}
            onClick={() => {
              setBranchesOpen((open) => !open);
              setDeleteAsk(null);
              setForceDeleteAsk(null);
            }}
            disabled={!status}
          >
            <IconBranch size={13} />
            <span className="git-branch-name">{branchLabel || t("git.loading")}</span>
            <IconChevron size={11} />
          </button>
          {head && (head.ahead > 0 || head.behind > 0) && (
            <span
              className="git-counter"
              title={t("git.aheadBehind", { ahead: head.ahead, behind: head.behind })}
            >
              {head.ahead > 0 && (
                <span className="ahead">
                  <span className="git-arrow">↑</span>
                  {head.ahead}
                </span>
              )}
              {head.behind > 0 && (
                <span className="behind">
                  <span className="git-arrow">↓</span>
                  {head.behind}
                </span>
              )}
            </span>
          )}
          <div className="git-head-actions">
            {headActions.slice(0, fitted).map((action) => (
              <button
                key={action.key}
                // Only the folder control keeps a ref: its menu is closed by a press on it, and
                // that press can land either here or on the "…" button that replaced it.
                ref={action.key === "folder" ? folderBtnRef : undefined}
                className={`git-icon-btn${action.key === "add" ? " git-add-repo" : ""}`}
                title={action.label}
                aria-label={action.label}
                disabled={action.disabled}
                onClick={(event) => action.run(event.currentTarget)}
              >
                {action.icon}
              </button>
            ))}
            {fitted < headActions.length && (
              <button
                ref={moreBtnRef}
                className="git-icon-btn"
                title={t("git.moreActions")}
                aria-label={t("git.moreActions")}
                aria-haspopup="menu"
                aria-expanded={!!headMenu}
                onClick={(event) => {
                  if (headMenu) {
                    setHeadMenu(null);
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  setHeadMenu({ x: rect.left, y: rect.bottom + 2 });
                }}
              >
                <span className="git-plus">…</span>
              </button>
            )}
          </div>
        </div>
        {status && (
          <div className="git-root" title={status.repo.root}>
            {status.repo.root}
          </div>
        )}
        {git.remotes.length > 1 && (
          <select
            className="git-remote"
            value={activeRemote ?? ""}
            title={t("git.remote")}
            onChange={(e) => setRemote(e.target.value)}
          >
            {git.remotes.map((item) => (
              <option key={item.name} value={item.name}>
                {item.name}
              </option>
            ))}
          </select>
        )}
        {status && status.repo.state !== "clean" && status.repo.state !== "merge" && (
          <div className="git-state">{t(`git.state.${status.repo.state}`)}</div>
        )}
      </div>

      {git.progress && (
        <div className="git-progress">
          <div className="git-progress-text" title={progressText(git.progress)}>
            {progressText(git.progress)}
          </div>
          <div className="git-progress-row">
            <div className="git-progress-bar">
              <span style={{ width: `${git.progress.percent}%` }} />
            </div>
            <span className="git-progress-percent">{git.progress.percent}%</span>
            <button
              className="git-icon-btn"
              title={t("git.cancel")}
              aria-label={t("git.cancel")}
              onClick={git.cancelNetwork}
            >
              <IconStop size={12} />
            </button>
          </div>
        </div>
      )}

      {branchesOpen && status && (
        <div className="git-branches">
          {git.branches.filter((b) => !b.remote).map((b) => (
            <div key={b.name} className={`git-branch-row${b.current ? " current" : ""}`}>
              <button
                className="git-branch-pick"
                disabled={b.current || busy}
                title={b.upstream ?? b.name}
                onClick={() => {
                  void git.switchBranch(b.name).then(() => setBranchesOpen(false));
                }}
              >
                {b.current ? "●" : ""} {b.name}
              </button>
              {!b.current &&
                (deleteAsk === b.name ? (
                  <button
                    className="git-small-btn danger"
                    disabled={busy}
                    onClick={() => {
                      setDeleteAsk(null);
                      void git.deleteBranch(b.name).then((result) => {
                        if (result.unmerged) setForceDeleteAsk(b.name);
                      });
                    }}
                  >
                    {t("git.confirmDelete")}
                  </button>
                ) : (
                  <button
                    className="git-icon-btn git-branch-del"
                    title={t("git.deleteBranch", { name: b.name })}
                    disabled={busy}
                    onClick={() => setDeleteAsk(b.name)}
                  >
                    ×
                  </button>
                ))}
            </div>
          ))}
          {git.branches.some((b) => b.remote) && (
            <div className="git-branch-note">{t("git.remoteBranches")}</div>
          )}
          {git.branches.filter((b) => b.remote).map((b) => (
            <div
              key={b.name}
              className="git-branch-row remote"
              title={t("git.checkoutRemoteHint", { name: b.name })}
            >
              <button
                className="git-branch-pick"
                disabled={busy}
                onClick={() => {
                  void git.switchBranch(b.name).then((ok) => {
                    if (ok) setBranchesOpen(false);
                  });
                }}
              >
                {b.name}
              </button>
            </div>
          ))}
          {forceDeleteAsk && (
            <div className="git-confirm">
              <span className="git-confirm-text">
                {t("git.branchUnmergedAsk", { name: forceDeleteAsk })}
              </span>
              <button
                className="git-small-btn danger"
                disabled={busy}
                onClick={() => {
                  const name = forceDeleteAsk;
                  setForceDeleteAsk(null);
                  void git.deleteBranch(name, true);
                }}
              >
                {t("git.forceDelete")}
              </button>
              <button
                className="git-small-btn"
                onClick={() => setForceDeleteAsk(null)}
              >
                {t("git.cancel")}
              </button>
            </div>
          )}
          <div className="git-new-branch">
            <input
              value={newBranch}
              placeholder={t("git.newBranch")}
              onChange={(e) => setNewBranch(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                const name = newBranch.trim();
                if (!name || busy) return;
                void git.createBranch(name, true).then((ok) => {
                  if (ok) {
                    setNewBranch("");
                    setBranchesOpen(false);
                  }
                });
              }}
            />
            <button
              className="git-small-btn"
              disabled={!newBranch.trim() || busy}
              onClick={() => {
                const name = newBranch.trim();
                if (!name) return;
                void git.createBranch(name, true).then((ok) => {
                  if (ok) {
                    setNewBranch("");
                    setBranchesOpen(false);
                  }
                });
              }}
            >
              {t("git.createBranch")}
            </button>
          </div>
        </div>
      )}

      {git.error && errorCode === "git_not_repo" && (
        <div className="git-empty">
          <div className="git-empty-title">{t("git.notRepo")}</div>
          <div className="git-empty-path" title={repoRoot ?? undefined}>
            {repoRoot}
          </div>
          <button
            className="side-btn"
            disabled={busy}
            onClick={() => void onInitWorkspace()}
          >
            {t("git.init")}
          </button>
        </div>
      )}

      {git.error && errorCode === "git_bare" && (
        <div className="git-empty">{t("git.bare")}</div>
      )}

      {git.error && errorCode !== "git_not_repo" && errorCode !== "git_bare" && (
        <div className="git-empty">
          <div className="git-empty-title">{translateError(git.error)}</div>
          <button className="side-btn" onClick={() => void git.refresh()}>
            {t("git.retry")}
          </button>
        </div>
      )}

      {!git.error && !status && git.loading && <div className="empty">{t("git.loading")}</div>}

      {status && (
        <>
          {status.repo.state === "merge" && (
            <div className="git-merge">
              <span>{t("git.mergeInProgress", { n: conflictedFiles.length })}</span>
              <button className="git-small-btn danger" onClick={() => setAbortAsk(true)}>
                {t("git.abortMerge")}
              </button>
            </div>
          )}

          {abortAsk && (
            <div className="git-confirm">
              <span className="git-confirm-text">{t("git.abortMergeAsk")}</span>
              <button
                className="git-small-btn danger"
                onClick={() => {
                  setAbortAsk(false);
                  void git.abortMerge();
                }}
              >
                {t("git.abortMerge")}
              </button>
              <button className="git-small-btn" onClick={() => setAbortAsk(false)}>
                {t("git.cancel")}
              </button>
            </div>
          )}

          {status.truncated && (
            <div className="git-note">{t("git.truncated", { n: status.files.length })}</div>
          )}

          {discardAsk && (
            <div className="git-confirm">
              <span className="git-confirm-text">
                {t("git.discardAsk", { n: discardAsk.length })}
              </span>
              <button className="git-small-btn danger" onClick={() => void runDiscard()}>
                {t("git.discard")}
              </button>
              <button className="git-small-btn" onClick={() => setDiscardAsk(null)}>
                {t("git.cancel")}
              </button>
            </div>
          )}

          {conflictedFiles.length > 0 && (
            <section className="git-section-block">
              <div className="git-section">
                <span>{t("git.conflicted")}</span>
                <span className="git-count">{conflictedFiles.length}</span>
              </div>
              {conflictedFiles.map((file) => {
                const { name, dir } = splitPath(file.path);
                return (
                  <div
                    key={`u:${file.path}`}
                    className="git-row conflict"
                    onMouseEnter={(event) => showFileTip(event, file.abs)}
                    onMouseLeave={hideFileTip}
                    onClick={() => onMergeConflict(file)}
                  >
                    <span className="git-badge conflict">U</span>
                    <NameText name={name} mode={nameEllipsis} className="git-name" pinned />
                    <NameText name={dir} mode={nameEllipsis} className="git-dir" pinned />
                    <span className="git-actions">
                      <button
                        className="git-action-text"
                        title={t("git.oursHint")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void git.resolveConflict(file, "ours");
                        }}
                      >
                        {t("git.ours")}
                      </button>
                      <button
                        className="git-action-text"
                        title={t("git.theirsHint")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void git.resolveConflict(file, "theirs");
                        }}
                      >
                        {t("git.theirs")}
                      </button>
                      <button
                        className="git-action-text"
                        title={t("git.markersHint")}
                        onClick={(e) => {
                          e.stopPropagation();
                          void git.resolveConflict(file, "markers");
                        }}
                      >
                        {t("git.markers")}
                      </button>
                      <button
                        className="git-action"
                        title={t("git.open")}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenFile(file.abs);
                        }}
                      >
                        <IconFile size={13} />
                      </button>
                    </span>
                  </div>
                );
              })}
            </section>
          )}

          {stagedFiles.length > 0 && (
            <section className="git-section-block">
              <div className="git-section-row">
                <button
                  className="git-section"
                  onClick={() => setFolded((f) => ({ ...f, staged: !f.staged }))}
                >
                  <span className={`git-chev${folded.staged ? " rot" : ""}`}>
                    <IconChevron size={11} />
                  </span>
                  <span>{t("git.staged")}</span>
                  <span className="git-count">{stagedFiles.length}</span>
                </button>
                <button
                  className="git-section-action"
                  title={t("git.unstageAll")}
                  aria-label={t("git.unstageAll")}
                  disabled={busy}
                  onClick={() => void git.unstage(stagedFiles)}
                >
                  <IconUnstage size={13} />
                </button>
              </div>
              {!folded.staged &&
                (treeView
                  ? treeRows(buildGitTree(stagedFiles), 0, "index")
                  : stagedFiles.map((file) => fileRow(file, "index", 0)))}
            </section>
          )}

          <section className="git-section-block">
            <div className="git-section-row">
              <button
                className="git-section"
                onClick={() => setFolded((f) => ({ ...f, changed: !f.changed }))}
              >
                <span className={`git-chev${folded.changed ? " rot" : ""}`}>
                  <IconChevron size={11} />
                </span>
                <span>{t("git.changes")}</span>
                <span className="git-count">{changedFiles.length}</span>
              </button>
              {/* Both lists follow this one switch, so it lives where the longer of them is
                  named rather than beside each heading. The icon is the view it switches to. */}
              <button
                className="git-section-action"
                title={treeView ? t("git.flatList") : t("git.groupByDir")}
                aria-label={treeView ? t("git.flatList") : t("git.groupByDir")}
                aria-pressed={treeView}
                onClick={() => onTreeViewChange(!treeView)}
              >
                {treeView ? <IconList size={13} /> : <IconOutline size={13} />}
              </button>
              {changedFiles.length > 0 && (
                <button
                  className="git-section-action"
                  title={t("git.stageAll")}
                  aria-label={t("git.stageAll")}
                  disabled={busy}
                  onClick={() => void git.stage(changedFiles)}
                >
                  <IconStage size={13} />
                </button>
              )}
            </div>
            {!folded.changed && changedFiles.length === 0 && (
              <div className="git-clean">{t("git.clean")}</div>
            )}
            {!folded.changed &&
              (treeView
                ? treeRows(buildGitTree(changedFiles), 0, "workdir")
                : changedFiles.map((file) => fileRow(file, "workdir", 0)))}
            {!folded.changed && changedFiles.length > 1 && (
              <div className="git-bulk">
                <button
                  className="git-small-btn"
                  disabled={busy}
                  onClick={() => void git.stage(changedFiles)}
                >
                  {t("git.stageAll")}
                </button>
                <button
                  className="git-small-btn"
                  disabled={busy}
                  onClick={() => setDiscardAsk(changedFiles)}
                >
                  {t("git.discardAll")}
                </button>
              </div>
            )}
          </section>

          <div className="git-commit">
            <textarea
              rows={3}
              value={message}
              placeholder={t("git.commitPlaceholder")}
              disabled={busy}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
            />
            <div className="git-commit-row">
              <span className="git-commit-count">
                {merging
                  ? t("git.mergeReady", { n: conflictedFiles.length })
                  : t("git.stagedCount", { n: stagedFiles.length })}
              </span>
              <label className="git-amend" title={t("git.amendHint")}>
                <input
                  type="checkbox"
                  checked={amend}
                  disabled={busy || !head || !!head.unborn || merging}
                  onChange={(e) => void toggleAmend(e.target.checked)}
                />
                {t("git.amend")}
              </label>
              <button
                className="git-commit-btn"
                disabled={!canCommit}
                onClick={() => void submit()}
              >
                {git.busy === "commit"
                  ? t("git.committing")
                  : merging
                    ? t("git.finishMerge")
                    : amend && canAmend
                      ? t("git.amendCommit")
                      : t("git.commit")}
              </button>
            </div>
          </div>

          {git.identityAsk && (
            <div className="git-identity">
              <div className="git-identity-title">{t("git.identityNeeded")}</div>
              <input
                className="grp-input"
                placeholder={t("git.identityName")}
                value={identityName}
                onChange={(e) => setIdentityName(e.target.value)}
              />
              <input
                className="grp-input"
                placeholder={t("git.identityEmail")}
                value={identityEmail}
                onChange={(e) => setIdentityEmail(e.target.value)}
              />
              <div className="git-bulk">
                <button
                  className="git-small-btn"
                  disabled={!identityName.trim() || !identityEmail.trim()}
                  onClick={() => void git.saveIdentity(identityName.trim(), identityEmail.trim())}
                >
                  {t("git.identitySave")}
                </button>
                <button className="git-small-btn" onClick={git.dismissIdentityAsk}>
                  {t("git.cancel")}
                </button>
              </div>
            </div>
          )}

          <section className="git-section-block git-log">
            <button
              className="git-section"
              onClick={() => setLogOpen((open) => !open)}
            >
              <span className={`git-chev${logOpen ? "" : " rot"}`}>
                <IconChevron size={11} />
              </span>
              <span>{t("git.history")}</span>
              {git.log.length > 0 && <span className="git-count">{git.log.length}</span>}
            </button>
            {logOpen && (
              <>
                {logTotal > 0 && (
                  <div ref={logRowsRef}>
                    {windowedLog ? (
                      <>
                        {/* Padding stands in for the rows above and below the window, so the
                            scrollbar keeps the height the whole list would have. */}
                        <div style={{ height: logStart * LOG_ROW_HEIGHT }} />
                        {git.log
                          .slice(logStart, logEnd)
                          .map((entry, offset) => renderLogRow(entry, logStart + offset))}
                        <div style={{ height: (logTotal - logEnd) * LOG_ROW_HEIGHT }} />
                      </>
                    ) : (
                      git.log.map(renderLogRow)
                    )}
                  </div>
                )}
                {git.logHasMore && (
                  <div className="git-bulk">
                    <select
                      className="git-page-select"
                      value={git.logPage}
                      disabled={git.logLoading}
                      title={t("git.pageSize")}
                      aria-label={t("git.pageSize")}
                      onChange={(e) => git.setLogPage(Number(e.target.value))}
                    >
                      {LOG_PAGE_CHOICES.map((size) => (
                        <option key={size} value={size}>
                          {size}
                        </option>
                      ))}
                    </select>
                    <button
                      className="git-small-btn"
                      disabled={git.logLoading}
                      onClick={() => void git.loadLog(true)}
                    >
                      {git.logLoading ? t("git.loading") : t("git.loadMore")}
                    </button>
                    <button
                      className="git-small-btn"
                      disabled={git.logLoading}
                      onClick={() => void git.loadAllLog()}
                    >
                      {git.logLoading ? t("git.loading") : t("git.loadAll")}
                    </button>
                  </div>
                )}
                {git.logCapped && <div className="git-clean">{t("git.logCapped")}</div>}
                {git.log.length === 0 && !git.logLoading && (
                  <div className="git-clean">{t("git.noCommits")}</div>
                )}
              </>
            )}
          </section>
        </>
      )}
        </>
      )}

      {folderMenu && (
        <div
          className="ctx-menu git-folder-menu"
          ref={folderMenuRef}
          style={{ display: "block", left: folderMenuAt.left, top: folderMenuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {folderHistory.map((entry) => (
            <div
              key={entry.path}
              className={`ctx-item${
                pathKey(entry.path) === pathKey(workspaceRoot ?? "") ? " current" : ""
              }`}
              title={entry.path}
              onClick={() => {
                setFolderMenu(null);
                onOpenFolder(entry.path);
              }}
            >
              <span className="git-folder-name">{entry.name}</span>
              {!entry.exists && <span className="git-folder-missing">×</span>}
            </div>
          ))}
          <div className="ws-sep" />
          <div
            className="ctx-item"
            onClick={() => {
              setFolderMenu(null);
              onSwitchWorkspace();
            }}
          >
            {t("git.switchFolder")}
          </div>
        </div>
      )}

      {addMenu && (
        <div
          className="ctx-menu"
          ref={addMenuRef}
          style={{ display: "block", left: addMenuAt.left, top: addMenuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div
            className="ctx-item"
            onClick={() => {
              setAddMenu(null);
              onAddRepo();
            }}
          >
            <span className="ctx-icon">
              <IconFolder size={14} />
            </span>
            {t("git.repos.add")}
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              setAddMenu(null);
              onCloneRepo();
            }}
          >
            <span className="ctx-icon">
              <IconRemote size={14} />
            </span>
            {t("git.clone")}
          </div>
        </div>
      )}

      {headMenu && (
        <div
          className="ctx-menu git-more-menu"
          ref={headMenuRef}
          style={{ display: "block", left: headMenuAt.left, top: headMenuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {headActions.slice(fitted).map((action) => (
            <div
              key={action.key}
              className={`ctx-item${action.disabled ? " disabled" : ""}`}
              onClick={() => {
                if (action.disabled) return;
                setHeadMenu(null);
                // The "…" is the control this row was opened from, so a submenu lands under it.
                action.run(moreBtnRef.current ?? document.body);
              }}
            >
              <span className="ctx-icon">{action.icon}</span>
              {action.label}
            </div>
          ))}
        </div>
      )}

      {remotesOpen && repoRoot && (
        <GitRemotesDialog
          name={splitPath(repoRoot).name}
          remotes={git.remotes}
          onSave={(name, url) => git.saveRemote(name, url)}
          onRemove={(name) => git.removeRemote(name)}
          onClose={() => setRemotesOpen(false)}
          onError={onError}
        />
      )}

      {commitMenu && (
        <div
          className="ctx-menu"
          ref={commitMenuRef}
          style={{ display: "block", left: commitMenuAt.left, top: commitMenuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div
            className="ctx-item"
            onClick={() => {
              const entry = commitMenu.entry;
              setCommitMenu(null);
              onOpenCommitTab(entry, repoRoot);
            }}
          >
            <span className="ctx-icon">
              <IconCommit size={14} />
            </span>
            {t("git.log.openCommitTab")}
          </div>
        </div>
      )}

      {rowMenu && (
        <GitRowMenu
          state={rowLocal}
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={closeRowMenu}
          onOpen={() => {
            const file = rowMenu.file;
            closeRowMenu();
            onOpenFile(file.abs);
          }}
          onIgnore={() => {
            const file = rowMenu.file;
            closeRowMenu();
            void runRowAction(
              () => git.ignoreLocal(file),
              t("side.localIgnoreDone", { name: splitPath(file.path).name })
            );
          }}
          onIgnoreRepo={() => {
            const file = rowMenu.file;
            closeRowMenu();
            void runRowAction(
              () => git.ignoreInGitignore(file),
              t("side.gitignoreDone", { name: splitPath(file.path).name })
            );
          }}
          onAssume={(enabled) => {
            const file = rowMenu.file;
            closeRowMenu();
            void runRowAction(
              () => git.setAssume([file], enabled),
              t(enabled ? "side.assumeDone" : "side.unassumeDone", {
                name: splitPath(file.path).name,
              })
            );
          }}
          onOpenSettings={() => {
            closeRowMenu();
            if (repoRoot) onOpenLocalSettings(repoRoot);
          }}
        />
      )}

      {git.authAsk && (
        <GitAuthDialog
          ask={git.authAsk}
          username={suggestedUser ?? undefined}
          onClose={git.closeAuthAsk}
          onSaveHttps={git.saveHttpsCredential}
          onSaveSsh={git.saveSshCredential}
          onTrustHost={git.trustHost}
          onTrustCert={git.trustCert}
        />
      )}

      {/* Name over the folder holding it. The path here is the answer to "where is this",
          and the name is already the line above — repeating it in the second line only makes
          the bubble longer than the row it describes. */}
      {fileTip && (
        <PathTip
          spot={fileTip.spot}
          name={basename(fileTip.key)}
          detail={parentOf(fileTip.key)}
        />
      )}
    </div>
  );
}

