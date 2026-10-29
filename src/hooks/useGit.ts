import { useCallback, useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type GitAuthView,
  type GitBranchInfo,
  type GitCommitResult,
  type GitConflictSides,
  type GitLogEntry,
  type GitProgress,
  type GitPullOutcome,
  type GitRemote,
  type GitStatusEntry,
  type GitStatusView,
} from "../lib/tauri";

/** How often the panel re-reads status while it is on screen. No file watcher is involved:
 * external `git` runs, a save from another program and a terminal checkout all look the same from
 * here, and five seconds is short enough to notice without scanning a repository on every tick. */
const POLL_MS = 5000;
/** Rows per load before the reader picks another number from the select. */
const LOG_DEFAULT_PAGE = 100;
/** What the page select offers. The backend caps one call at 200, so a larger page would be a lie. */
export const LOG_PAGE_CHOICES = [50, 100, 200] as const;
/** One request while "load all" walks: the backend's ceiling for a single page. */
const LOG_ALL_PAGE = 200;
/**
 * How many rows the panel keeps. The graph is laid out over the whole array on every append and
 * every row is real DOM, so "show me everything" stops being free somewhere; past this the list
 * says so and a refresh starts over. The same number `git status` stops counting paths at.
 */
const LOG_MAX_ROWS = 5000;

interface Options {
  rootDir: string | null;
  /** False while another sidebar view is showing; the panel does no work then. */
  active: boolean;
  onError: (message: string) => void;
  /** Called after an operation that changes files on disk (discard, branch switch). */
  onFilesChanged?: () => void;
}

/** What the credential dialog is being opened for. */
export type GitAuthAsk =
  | { kind: "https" | "ssh"; host: string; failed: boolean }
  | { kind: "host"; host: string; fingerprint: string; changed: boolean };

export interface GitController {
  status: GitStatusView | null;
  branches: GitBranchInfo[];
  log: GitLogEntry[];
  logLoading: boolean;
  /** The last page was full, so asking for another one may return more commits. */
  logHasMore: boolean;
  /** The list stopped at its own ceiling rather than at the end of the history. */
  logCapped: boolean;
  /** How many commits one load asks for. Offered as a choice, not persisted. */
  logPage: number;
  setLogPage: (size: number) => void;
  /** Walks the rest of the history, up to the ceiling, in one go. */
  loadAllLog: () => Promise<void>;
  loading: boolean;
  error: string | null;
  /** The operation in flight, for disabling buttons; null when idle. */
  busy: string | null;
  remotes: GitRemote[];
  /** The last progress event while a network operation runs; null otherwise. */
  progress: GitProgress | null;
  auth: GitAuthView | null;
  authAsk: GitAuthAsk | null;
  /** The repository has no identity and a commit asked for one. */
  identityAsk: boolean;
  refresh: () => Promise<void>;
  loadBranches: () => Promise<void>;
  loadLog: (more?: boolean) => Promise<void>;
  stage: (files: GitStatusEntry[]) => Promise<boolean>;
  unstage: (files: GitStatusEntry[]) => Promise<boolean>;
  discard: (files: GitStatusEntry[]) => Promise<boolean>;
  /** Add one path to the repository's own ignore file (`info/exclude`). */
  ignoreLocal: (file: GitStatusEntry) => Promise<boolean>;
  /** Set or clear the index's assume-unchanged bit on tracked paths. */
  setAssume: (files: GitStatusEntry[], enabled: boolean) => Promise<boolean>;
  commit: (message: string, amend?: boolean) => Promise<GitCommitResult | null>;
  createBranch: (name: string, checkout: boolean) => Promise<boolean>;
  switchBranch: (name: string) => Promise<boolean>;
  deleteBranch: (name: string, force?: boolean) => Promise<{ ok: boolean; unmerged: boolean }>;
  init: () => Promise<void>;
  fetchRemote: (remote?: string | null) => Promise<void>;
  pullRemote: (remote?: string | null) => Promise<GitPullOutcome | null>;
  pushRemote: (remote?: string | null) => Promise<boolean>;
  cancelNetwork: () => void;
  closeAuthAsk: () => void;
  saveHttpsCredential: (host: string, username: string, secret: string) => Promise<boolean>;
  saveSshCredential: (
    host: string,
    keyPath: string,
    passphrase: string | null,
    remember: boolean
  ) => Promise<boolean>;
  trustHost: (host: string, fingerprint: string) => Promise<boolean>;
  loadAuth: () => Promise<void>;
  saveIdentity: (name: string, email: string) => Promise<boolean>;
  dismissIdentityAsk: () => void;
  conflictSides: (path: string) => Promise<GitConflictSides | null>;
  resolveConflict: (file: GitStatusEntry, choice: "ours" | "theirs" | "markers") => Promise<boolean>;
  abortMerge: () => Promise<boolean>;
}

export function useGit({ rootDir, active, onError, onFilesChanged }: Options): GitController {
  const [status, setStatus] = useState<GitStatusView | null>(null);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [log, setLog] = useState<GitLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [logHasMore, setLogHasMore] = useState(false);
  const [logCapped, setLogCapped] = useState(false);
  const [logPage, setLogPage] = useState<number>(LOG_DEFAULT_PAGE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [progress, setProgress] = useState<GitProgress | null>(null);
  const [auth, setAuth] = useState<GitAuthView | null>(null);
  const [authAsk, setAuthAsk] = useState<GitAuthAsk | null>(null);
  const [identityAsk, setIdentityAsk] = useState(false);
  const opIdRef = useRef<string | null>(null);
  const retryRef = useRef<(() => void) | null>(null);
  /** The host of the remote this network operation talks to, for the failed-credential dialog. */
  const networkHostRef = useRef<string | null>(null);

  const rootRef = useRef(rootDir);
  rootRef.current = rootDir;
  const statusRef = useRef<GitStatusView | null>(null);
  const logRef = useRef<GitLogEntry[]>([]);
  logRef.current = log;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onFilesChangedRef = useRef(onFilesChanged);
  onFilesChangedRef.current = onFilesChanged;
  const remotesRef = useRef(remotes);
  remotesRef.current = remotes;
  /** Answers from an older root or an older refresh must not overwrite a newer one. */
  const seq = useRef(0);
  /** The same for the log: a page asked for before a commit must not land after its reload. */
  const logSeq = useRef(0);
  /**
   * The HEAD the log was last read against. `undefined` means "no status has arrived yet";
   * `null` means "unborn branch", which is a real state and must not be confused with it.
   */
  const seenHead = useRef<string | null | undefined>(undefined);

  const applyStatus = useCallback((next: GitStatusView | null) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const refresh = useCallback(async () => {
    const root = rootRef.current;
    const mine = ++seq.current;
    if (!root) {
      applyStatus(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(statusRef.current === null);
    try {
      const next = await api.gitStatus(root);
      if (mine !== seq.current) return;
      applyStatus(next);
      setError(null);
    } catch (e) {
      if (mine !== seq.current) return;
      applyStatus(null);
      setError(typeof e === "string" ? e : errorMessage(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }, [applyStatus]);

  const loadBranches = useCallback(async () => {
    const root = rootRef.current;
    if (!root) {
      setBranches([]);
      return;
    }
    try {
      const list = await api.gitBranches(root);
      setBranches(list);
    } catch {
      // A repository with no branches yet (unborn HEAD) has nothing to list; the panel still
      // works, and a real failure will surface on the next status refresh.
      setBranches([]);
    }
  }, []);

  const loadRemotes = useCallback(async () => {
    const root = rootRef.current;
    if (!root) {
      setRemotes([]);
      return;
    }
    try {
      setRemotes(await api.gitRemotes(root));
    } catch {
      setRemotes([]);
    }
  }, []);

  const loadAuth = useCallback(async () => {
    try {
      setAuth(await api.gitAuthView());
    } catch {
      // The credential store is optional; an unreadable one must not stop the panel working.
      setAuth(null);
    }
  }, []);

  const logPageRef = useRef(logPage);
  logPageRef.current = logPage;

  const loadLog = useCallback(async (more = false) => {
    const root = rootRef.current;
    if (!root) return;
    if (more && logRef.current.length >= LOG_MAX_ROWS) return;
    const mine = ++logSeq.current;
    setLogLoading(true);
    try {
      // Every ref, not just HEAD: a merge whose other side was never walked has a parent with
      // no row to connect to, and the graph would draw a line into nothing.
      const size = logPageRef.current;
      const page = await api.gitLog(root, size, more ? logRef.current.length : 0, true);
      if (mine !== logSeq.current) return;
      const next = more ? [...logRef.current, ...page] : page;
      setLog(next);
      setLogHasMore(page.length >= size && next.length < LOG_MAX_ROWS);
      setLogCapped(next.length >= LOG_MAX_ROWS);
    } catch (e) {
      if (mine === logSeq.current) onErrorRef.current(errorMessage(e));
    } finally {
      if (mine === logSeq.current) setLogLoading(false);
    }
  }, []);

  /**
   * Walk the rest of the history in one go.
   *
   * Pages are collected locally and written to state once: every append lays out the whole graph
   * again, and a hundred of those in a row is what would make a large repository feel broken.
   * The loop stops at `LOG_MAX_ROWS`, which is a rendering ceiling rather than a git one.
   */
  const loadAllLog = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;
    const mine = ++logSeq.current;
    setLogLoading(true);
    try {
      let rows = logRef.current;
      let done = false;
      while (rows.length < LOG_MAX_ROWS) {
        const page = await api.gitLog(root, LOG_ALL_PAGE, rows.length, true);
        if (mine !== logSeq.current) return;
        rows = [...rows, ...page];
        if (page.length < LOG_ALL_PAGE) {
          done = true;
          break;
        }
      }
      setLog(rows);
      setLogHasMore(!done && rows.length < LOG_MAX_ROWS);
      setLogCapped(rows.length >= LOG_MAX_ROWS);
    } catch (e) {
      if (mine === logSeq.current) onErrorRef.current(errorMessage(e));
    } finally {
      if (mine === logSeq.current) setLogLoading(false);
    }
  }, []);

  // A different folder is a different repository. Everything read from the old one goes.
  useEffect(() => {
    seq.current += 1;
    logSeq.current += 1;
    seenHead.current = undefined;
    applyStatus(null);
    setError(null);
    setBranches([]);
    setLog([]);
    setLogHasMore(false);
    setLogCapped(false);
    setRemotes([]);
    setProgress(null);
    setAuthAsk(null);
    setIdentityAsk(false);
    setLoading(false);
  }, [rootDir, applyStatus]);

  /**
   * Another program can commit, amend, checkout or rebase under this one. The status poll is
   * what notices: when the commit HEAD points at changes, the log and the branch rows are stale.
   * `undefined` means the status has not arrived yet; `null` is an unborn branch, which is a
   * real state and must not be mistaken for "nothing has been read".
   */
  const headOid = status ? status.repo.head.oid : undefined;
  useEffect(() => {
    if (headOid === undefined) return;
    if (seenHead.current === undefined) {
      seenHead.current = headOid;
      return;
    }
    if (seenHead.current === headOid) return;
    seenHead.current = headOid;
    void loadLog();
    void loadBranches();
  }, [headOid, loadLog, loadBranches]);

  // Poll only while the panel is actually on screen and the window is visible.
  useEffect(() => {
    if (!active || !rootDir) return;
    void refresh();
    void loadBranches();
    void loadRemotes();
    void loadAuth();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, POLL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [active, rootDir, refresh, loadBranches, loadRemotes, loadAuth]);

  // Explorer operations (create, rename, delete, paste) already announce themselves.
  useEffect(() => {
    if (!active) return;
    const onChange = () => void refresh();
    window.addEventListener("wrolp:folder-changed", onChange);
    return () => window.removeEventListener("wrolp:folder-changed", onChange);
  }, [active, refresh]);

  const run = useCallback(
    async (
      label: string,
      action: () => Promise<unknown>,
      options?: { filesChanged?: boolean }
    ): Promise<boolean> => {
      if (!rootRef.current) return false;
      setBusy(label);
      try {
        await action();
        await refresh();
        if (options?.filesChanged) onFilesChangedRef.current?.();
        return true;
      } catch (e) {
        onErrorRef.current(errorMessage(e));
        // A switch that failed partway still needs the panel to show what is really on disk.
        void refresh();
        return false;
      } finally {
        setBusy(null);
      }
    },
    [refresh]
  );

  const stage = useCallback(
    (files: GitStatusEntry[]) => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run("stage", () => api.gitStage(root, files.map((f) => f.abs)));
    },
    [run]
  );

  const unstage = useCallback(
    (files: GitStatusEntry[]) => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run("unstage", () => api.gitUnstage(root, files.map((f) => f.abs)));
    },
    [run]
  );

  const discard = useCallback(
    (files: GitStatusEntry[]) => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run("discard", () => api.gitDiscard(root, files.map((f) => f.abs)), {
        filesChanged: true,
      });
    },
    [run]
  );

  const ignoreLocal = useCallback(
    (file: GitStatusEntry) => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run("ignore", () => api.gitLocalIgnore(file.abs));
    },
    [run]
  );

  const setAssume = useCallback(
    (files: GitStatusEntry[], enabled: boolean) => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run("assume", () =>
        api.gitAssumeUnchanged(root, files.map((file) => file.abs), enabled)
      );
    },
    [run]
  );

  const commit = useCallback(
    async (message: string, amend = false): Promise<GitCommitResult | null> => {
      const root = rootRef.current;
      if (!root) return null;
      setBusy("commit");
      try {
        const result = await api.gitCommit(root, message, amend);
        await refresh();
        void loadBranches();
        // The log the panel holds is missing a row at the top. A repository whose first commit
        // just landed has an empty log, so this cannot wait for a non-empty list: that is
        // exactly the case where the history would stay empty until the view is reopened.
        void loadLog();
        return result;
      } catch (e) {
        onErrorRef.current(errorMessage(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [refresh, loadBranches, loadLog]
  );

  const createBranch = useCallback(
    (name: string, checkout: boolean) => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run(
        "branch",
        async () => {
          await api.gitCreateBranch(root, name, checkout);
          await loadBranches();
        },
        { filesChanged: checkout }
      );
    },
    [run, loadBranches]
  );

  const switchBranch = useCallback(
    (name: string) => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run(
        "switch",
        async () => {
          await api.gitSwitchBranch(root, name);
          await loadBranches();
          setLog([]);
        },
        { filesChanged: true }
      );
    },
    [run, loadBranches]
  );

  const deleteBranch = useCallback(
    async (name: string, force = false): Promise<{ ok: boolean; unmerged: boolean }> => {
      const root = rootRef.current;
      if (!root) return { ok: false, unmerged: false };
      setBusy("delete-branch");
      try {
        await api.gitDeleteBranch(root, name, force);
        await loadBranches();
        await refresh();
        return { ok: true, unmerged: false };
      } catch (e) {
        const raw = typeof e === "string" ? e : errorMessage(e);
        // Not a failure to report as a toast: the branch is simply not merged, and the panel
        // asks a second, explicit question.
        if (raw.startsWith("git_branch_unmerged")) {
          return { ok: false, unmerged: true };
        }
        onErrorRef.current(errorMessage(e));
        return { ok: false, unmerged: false };
      } finally {
        setBusy(null);
      }
    },
    [refresh, loadBranches]
  );

  const init = useCallback(async () => {
    const root = rootRef.current;
    if (!root) return;
    setBusy("init");
    try {
      await api.gitInit(root);
      await refresh();
      await loadBranches();
    } catch (e) {
      onErrorRef.current(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }, [refresh, loadBranches]);

  const hostForRemote = (name: string | null): string | null => {
    const list = remotesRef.current;
    const chosen =
      (name ? list.find((remote) => remote.name === name) : undefined) ??
      list.find((remote) => remote.name === "origin") ??
      list[0];
    return chosen?.host ?? null;
  };

  const handleAuthError = useCallback((raw: string): boolean => {
    if (raw.startsWith("git_auth_required:")) {
      const host = raw.slice("git_auth_required:".length).trim();
      setAuthAsk({ kind: hostKind(host, remotesRef.current), host, failed: false });
      return true;
    }
    if (raw.startsWith("git_auth_failed")) {
      const host =
        networkHostRef.current ??
        remotesRef.current.find((remote) => remote.host)?.host ??
        "";
      setAuthAsk({ kind: hostKind(host, remotesRef.current), host, failed: true });
      return true;
    }
    if (raw.startsWith("git_host_untrusted:") || raw.startsWith("git_host_changed:")) {
      const payload = raw.slice(raw.indexOf(":") + 1);
      const [host, fingerprint] = payload.split("|");
      if (host && fingerprint) {
        setAuthAsk({
          kind: "host",
          host,
          fingerprint,
          changed: raw.startsWith("git_host_changed:"),
        });
        return true;
      }
    }
    if (raw.startsWith("git_no_identity")) {
      setIdentityAsk(true);
      return true;
    }
    return false;
  }, []);

  const runNetwork = useCallback(
    async <T,>(
      kind: "fetch" | "pull" | "push",
      action: (opId: string) => Promise<T>,
      retry: () => void
    ): Promise<T | null> => {
      if (!rootRef.current || opIdRef.current) return null;
      const opId = crypto.randomUUID();
      opIdRef.current = opId;
      retryRef.current = retry;
      setBusy(kind);
      setProgress({ phase: "starting", received: 0, total: 0, bytes: 0, percent: 0, text: null });
      try {
        const result = await action(opId);
        await refresh();
        await loadBranches();
        void loadRemotes();
        // A fetch or push moves a remote-tracking ref, and the log rows carry those labels.
        void loadLog();
        return result;
      } catch (e) {
        const raw = typeof e === "string" ? e : errorMessage(e);
        if (!handleAuthError(raw)) onErrorRef.current(errorMessage(e));
        return null;
      } finally {
        opIdRef.current = null;
        setBusy(null);
        setProgress(null);
      }
    },
    [refresh, loadBranches, loadRemotes, loadLog, handleAuthError]
  );

  const fetchRemote = useCallback(
    async (remote: string | null = null) => {
      const root = rootRef.current;
      if (!root) return;
      networkHostRef.current = hostForRemote(remote);
      await runNetwork(
        "fetch",
        (opId) => api.gitFetch(root, remote, opId, setProgress),
        () => void fetchRemote(remote)
      );
    },
    [runNetwork]
  );

  const pullRemote = useCallback(
    async (remote: string | null = null) => {
      const root = rootRef.current;
      if (!root) return null;
      networkHostRef.current = hostForRemote(remote);
      return runNetwork(
        "pull",
        (opId) => api.gitPull(root, remote, opId, setProgress),
        () => void pullRemote(remote)
      );
    },
    [runNetwork]
  );

  const pushRemote = useCallback(
    async (remote: string | null = null) => {
      const root = rootRef.current;
      if (!root) return false;
      networkHostRef.current = hostForRemote(remote);
      const result = await runNetwork(
        "push",
        (opId) => api.gitPush(root, remote, opId, setProgress),
        () => void pushRemote(remote)
      );
      return result !== null;
    },
    [runNetwork]
  );

  const cancelNetwork = useCallback(() => {
    if (!opIdRef.current) return;
    void api.gitCancel(opIdRef.current);
    // Cancellation is cooperative: say so, rather than leaving the same "Connecting…" line
    // looking as if the click did nothing.
    setProgress((current) =>
      current ? { ...current, phase: "canceling", text: null } : current
    );
  }, []);

  const closeAuthAsk = useCallback(() => setAuthAsk(null), []);

  const saveHttpsCredential = useCallback(
    async (host: string, username: string, secret: string) => {
      try {
        await api.gitSaveHttps(host, username, secret);
        await loadAuth();
        setAuthAsk(null);
        retryRef.current?.();
        return true;
      } catch (e) {
        onErrorRef.current(errorMessage(e));
        return false;
      }
    },
    [loadAuth]
  );

  const saveSshCredential = useCallback(
    async (host: string, keyPath: string, passphrase: string | null, remember: boolean) => {
      try {
        await api.gitSaveSsh(host, keyPath, passphrase, remember);
        await loadAuth();
        setAuthAsk(null);
        retryRef.current?.();
        return true;
      } catch (e) {
        onErrorRef.current(errorMessage(e));
        return false;
      }
    },
    [loadAuth]
  );

  const trustHost = useCallback(
    async (host: string, fingerprint: string) => {
      try {
        await api.gitTrustHost(host, fingerprint);
        await loadAuth();
        setAuthAsk(null);
        retryRef.current?.();
        return true;
      } catch (e) {
        onErrorRef.current(errorMessage(e));
        return false;
      }
    },
    [loadAuth]
  );

  const saveIdentity = useCallback(
    async (name: string, email: string) => {
      try {
        await api.gitSaveIdentity(name, email);
        setIdentityAsk(false);
        await loadAuth();
        return true;
      } catch (e) {
        onErrorRef.current(errorMessage(e));
        return false;
      }
    },
    [loadAuth]
  );

  const dismissIdentityAsk = useCallback(() => setIdentityAsk(false), []);

  const conflictSides = useCallback(async (path: string) => {
    const root = rootRef.current;
    if (!root) return null;
    try {
      return await api.gitConflictSides(root, path);
    } catch (e) {
      onErrorRef.current(errorMessage(e));
      return null;
    }
  }, []);

  const resolveConflict = useCallback(
    (file: GitStatusEntry, choice: "ours" | "theirs" | "markers") => {
      const root = rootRef.current;
      if (!root) return Promise.resolve(false);
      return run("resolve", () => api.gitResolveConflict(root, file.abs, choice), {
        filesChanged: true,
      });
    },
    [run]
  );

  const abortMerge = useCallback(() => {
    const root = rootRef.current;
    if (!root) return Promise.resolve(false);
    return run("abort-merge", () => api.gitMergeAbort(root), { filesChanged: true });
  }, [run]);

  return {
    status,
    branches,
    log,
    logLoading,
    logHasMore,
    logCapped,
    logPage,
    setLogPage,
    loadAllLog,
    loading,
    error,
    busy,
    refresh,
    loadBranches,
    loadLog,
    stage,
    unstage,
    discard,
    ignoreLocal,
    setAssume,
    commit,
    createBranch,
    switchBranch,
    deleteBranch,
    init,
    remotes,
    progress,
    auth,
    authAsk,
    identityAsk,
    fetchRemote,
    pullRemote,
    pushRemote,
    cancelNetwork,
    closeAuthAsk,
    saveHttpsCredential,
    saveSshCredential,
    trustHost,
    loadAuth,
    saveIdentity,
    dismissIdentityAsk,
    conflictSides,
    resolveConflict,
    abortMerge,
  };
}

function hostKind(host: string, remotes: GitRemote[]): "https" | "ssh" {
  const wanted = host.toLowerCase();
  const bare = (value: string | null | undefined) =>
    (value ?? "").toLowerCase().split(":")[0];
  const remote = remotes.find(
    (item) => item.host?.toLowerCase() === wanted || bare(item.host) === bare(wanted)
  );
  const url = remote?.url ?? "";
  return url.startsWith("http://") || url.startsWith("https://") || !url
    ? "https"
    : "ssh";
}
