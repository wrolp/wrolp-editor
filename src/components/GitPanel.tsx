import { useEffect, useMemo, useState } from "react";
import { formatClock, formatWhen, t, translateError } from "../lib/i18n";
import { pathKey } from "../lib/types";
import type { GitCommitFile, GitLogEntry, GitProgress, GitStatusEntry } from "../lib/tauri";
import { api, errorMessage } from "../lib/tauri";
import { LOG_PAGE_CHOICES, type GitController } from "../hooks/useGit";
import type { GitRepoRow } from "../hooks/useGitRepos";
import { buildGraph } from "../lib/gitGraph";
import GitAuthDialog from "./GitAuthDialog";
import GraphCell from "./GitGraphRow";
import {
  IconBranch,
  IconChevron,
  IconFetch,
  IconFile,
  IconPull,
  IconPush,
  IconReload,
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
  onRemoveRepo: (root: string) => void;
  onRescanRepos: () => void;
  onInitWorkspace: () => Promise<void>;
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
}

type Scope = "workdir" | "index";

/** One letter in front of a path, the way `git status --short` writes the two columns. */
function badgeLetter(file: GitStatusEntry, scope: Scope): string {
  if (file.kind === "conflicted") return "U";
  return (scope === "index" ? file.index : file.workdir) ?? "?";
}

function badgeTone(letter: string): string {
  switch (letter) {
    case "A":
    case "?":
      return "add";
    case "D":
      return "del";
    case "R":
    case "C":
      return "ren";
    case "U":
      return "conflict";
    case "T":
      return "type";
    default:
      return "mod";
  }
}

function splitPath(path: string): { name: string; dir: string } {
  const cut = path.lastIndexOf("/");
  if (cut < 0) return { name: path, dir: "" };
  return { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

function progressText(progress: GitProgress): string {
  switch (progress.phase) {
    case "starting":
      return t("git.progressStarting");
    case "receiving":
      return progress.total > 0
        ? t("git.progressReceiving", { received: progress.received, total: progress.total })
        : t("git.progressReceivingUnknown", { bytes: progress.bytes });
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
  onRemoveRepo,
  onRescanRepos,
  onInitWorkspace,
  git,
  active,
  dirtyPaths,
  onOpenFile,
  onDiff,
  onCommitFileDiff,
  onMergeConflict,
  onError,
  onNotice,
}: Props) {
  const [message, setMessage] = useState("");
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
  const [deleteAsk, setDeleteAsk] = useState<string | null>(null);
  const [forceDeleteAsk, setForceDeleteAsk] = useState<string | null>(null);
  const [commitOpen, setCommitOpen] = useState<string | null>(null);
  const [commitFiles, setCommitFiles] = useState<GitCommitFile[]>([]);
  const [commitFilesLoading, setCommitFilesLoading] = useState(false);

  // A different folder is a different repository; a half-typed message and a pending discard
  // question from the old one must not carry over.
  useEffect(() => {
    setMessage("");
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
  }, [repoRoot]);

  useEffect(() => {
    if (logOpen && active && git.status && !logAsked) {
      setLogAsked(true);
      void git.loadLog();
    }
  }, [logOpen, active, git.status, logAsked, git.loadLog]);

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

  const head = status?.repo.head;
  const busy = git.busy !== null;
  const merging = status?.repo.state === "merge";
  // A merge commit records that the branches met even when the resolution equals HEAD, so it
  // needs no staged text — only the absence of unresolved conflicts.
  const canCommit =
    !!message.trim() &&
    !busy &&
    // Staged text does not make a merge committable while any conflict stage remains.
    !(merging && conflictedFiles.length > 0) &&
    (stagedFiles.length > 0 || merging);

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

  const submit = async () => {
    if (!canCommit) return;
    const result = await git.commit(message);
    if (result) setMessage("");
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

  const errorCode = git.error ? git.error.split(":")[0] : "";

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
        <div className="git-head-row">
          <button
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
          <span className="git-sync">
            <button
              className="git-icon-btn"
              title={t("git.fetch")}
              aria-label={t("git.fetch")}
              disabled={busy || !activeRemote}
              onClick={() => void git.fetchRemote(activeRemote)}
            >
              <IconFetch size={13} />
            </button>
            <button
              className="git-icon-btn"
              title={t("git.pull")}
              aria-label={t("git.pull")}
              disabled={busy || !activeRemote}
              onClick={() => void doPull()}
            >
              <IconPull size={13} />
            </button>
            <button
              className="git-icon-btn"
              title={t("git.push")}
              aria-label={t("git.push")}
              disabled={busy || !activeRemote}
              onClick={() => void doPush()}
            >
              <IconPush size={13} />
            </button>
          </span>
          <button
            className="git-icon-btn"
            title={t("git.refresh")}
            aria-label={t("git.refresh")}
            onClick={() => void git.refresh()}
          >
            <IconReload size={13} />
          </button>
          <button
            className="git-icon-btn git-add-repo"
            title={t("git.repos.add")}
            aria-label={t("git.repos.add")}
            onClick={onAddRepo}
          >
            ＋
          </button>
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
                    title={file.path}
                    onClick={() => onMergeConflict(file)}
                  >
                    <span className="git-badge conflict">U</span>
                    <span className="git-name">{name}</span>
                    <span className="git-dir">{dir}</span>
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
              {!folded.staged &&
                stagedFiles.map((file) => {
                  const { name, dir } = splitPath(file.path);
                  const letter = badgeLetter(file, "index");
                  return (
                    <div
                      key={`s:${file.path}`}
                      className="git-row"
                      title={file.path}
                      onClick={() => onDiff(file, "index", repoRoot)}
                    >
                      <span className={`git-badge ${badgeTone(letter)}`}>{letter}</span>
                      <span className="git-name">{name}</span>
                      <span className="git-dir">{dir}</span>
                      {dirtyPaths.has(pathKey(file.abs)) && (
                        <span className="git-dirty" title={t("git.unsaved")}>
                          ●
                        </span>
                      )}
                      <span className="git-actions">
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

          <section className="git-section-block">
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
            {!folded.changed && changedFiles.length === 0 && (
              <div className="git-clean">{t("git.clean")}</div>
            )}
            {!folded.changed &&
              changedFiles.map((file) => {
                const { name, dir } = splitPath(file.path);
                const letter = badgeLetter(file, "workdir");
                return (
                  <div
                    key={`w:${file.path}`}
                    className="git-row"
                    title={file.path}
                    onClick={() => onDiff(file, "workdir", repoRoot)}
                  >
                    <span className={`git-badge ${badgeTone(letter)}`}>{letter}</span>
                    <span className="git-name">{name}</span>
                    <span className="git-dir">{dir}</span>
                    {dirtyPaths.has(pathKey(file.abs)) && (
                      <span className="git-dirty" title={t("git.unsaved")}>
                        ●
                      </span>
                    )}
                    <span className="git-actions">
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
              <button
                className="git-commit-btn"
                disabled={!canCommit}
                onClick={() => void submit()}
              >
                {git.busy === "commit"
                  ? t("git.committing")
                  : merging
                    ? t("git.finishMerge")
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
                {git.log.map((entry, index) => {
                  const open = commitOpen === entry.oid;
                  const row = graphRows[index];
                  return (
                    <div key={entry.oid}>
                      <div
                        className={`git-log-row${open ? " open" : ""}`}
                        title={`${entry.oid}\n${entry.author} · ${formatWhen(entry.time)}`}
                        onClick={() => void openCommit(entry)}
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
                        {/* The same instant without the date, for a row whose tip carries names
                            in a narrow sidebar. The full one above is hidden by a container
                            query there; the row's title has it in any case. */}
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
                                title={file.path}
                                onClick={() => onCommitFileDiff(entry, file, repoRoot)}
                              >
                                <span className={`git-badge ${badgeTone(file.status)}`}>
                                  {file.status}
                                </span>
                                <span className="git-name">{name}</span>
                                <span className="git-dir">{dir}</span>
                              </div>
                            );
                          })
                        ))}
                    </div>
                  );
                })}
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

      {git.authAsk && (
        <GitAuthDialog
          ask={git.authAsk}
          username={suggestedUser ?? undefined}
          onClose={git.closeAuthAsk}
          onSaveHttps={git.saveHttpsCredential}
          onSaveSsh={git.saveSshCredential}
          onTrustHost={git.trustHost}
        />
      )}
    </div>
  );
}

