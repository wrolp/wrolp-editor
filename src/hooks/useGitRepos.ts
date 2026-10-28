import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type GitRepoEntry,
  type GitRepoSummary,
  type GitScanView,
  type GitStatusView,
} from "../lib/tauri";
import { basename, isUnder } from "../lib/path";
import { pathKey } from "../lib/types";

/** How often the Source view re-reads the counts of every repository listed. */
const SUMMARY_POLL_MS = 5000;
/** How long a scan result is trusted before becoming stale. */
const SCAN_TTL_MS = 30000;
/** How many repositories get per-repository status reads for Explorer decorations. */
const DECORATE_LIMIT = 12;

interface Options {
  /** The group's folder: what the scan starts from. */
  rootDir: string | null;
  /** Repositories added by hand for this group (may point outside rootDir). */
  manualRoots: string[];
  /** The repository this group was last showing, empty when none was chosen. */
  savedSelected: string;
  /** Settings → Git → subdirectory depth. */
  depth: number;
  /** Either the Source or the Explorer view is on screen; the list is worth reading. */
  active: boolean;
  /** The Explorer is on screen, so per-repository statuses are needed for its decorations. */
  decorating: boolean;
  onError: (message: string) => void;
  /** Persist a selection the user made; fallbacks are not persisted. */
  onSelect: (root: string) => void;
}

export interface GitRepoRow extends GitRepoEntry {
  manual: boolean;
  /** The repository could not be read: deleted, moved, or no longer a repository. */
  unavailable: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  /** Non-ignored changed paths, as the summary reports them. */
  changed: number;
  /** clean | merge | rebase | … */
  state: string;
}

export interface GitReposController {
  rows: GitRepoRow[];
  selectedRoot: string | null;
  scanning: boolean;
  scanError: string | null;
  truncated: boolean;
  /** More repositories than the decoration limit: only the selected one and root/parent get
   * Explorer marks. */
  decorationsCapped: boolean;
  summaries: Map<string, GitRepoSummary>;
  /** Errors by repository key; a missing entry means the last read succeeded. */
  summaryErrors: Map<string, string>;
  /** Full statuses fetched for the Explorer's decorations, by repository key. */
  statusByRepo: Map<string, GitStatusView>;
  select(root: string): void;
  rescan(): Promise<void>;
  refreshSummaries(): Promise<void>;
}

export function useGitRepos({
  rootDir,
  manualRoots,
  savedSelected,
  depth,
  active,
  decorating,
  onError,
  onSelect,
}: Options): GitReposController {
  const [scanView, setScanView] = useState<GitScanView | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [selected, setSelected] = useState("");
  const [summaries, setSummaries] = useState<Map<string, GitRepoSummary>>(new Map());
  const [summaryErrors, setSummaryErrors] = useState<Map<string, string>>(new Map());
  const [statusByRepo, setStatusByRepo] = useState<Map<string, GitStatusView>>(new Map());

  const rootRef = useRef(rootDir);
  rootRef.current = rootDir;
  const depthRef = useRef(depth);
  depthRef.current = depth;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const entriesRef = useRef<GitRepoEntry[]>([]);
  const scanningRef = useRef(false);
  const lastScanRef = useRef(0);
  const summaryGen = useRef(0);
  /** A manual repository selected before its group write landed in this render. */
  const pendingSelectRef = useRef<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const entries = useMemo(() => {
    const list: GitRepoEntry[] = [...(scanView?.repos ?? [])];
    const seen = new Set(list.map((entry) => pathKey(entry.root)));
    for (const root of manualRoots) {
      const key = pathKey(root);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({
        root,
        gitDir: "",
        name: basename(root) || root,
        relative: relativeLabel(root, rootDir),
        source: "manual",
      });
    }
    return list;
  }, [scanView, manualRoots, rootDir]);
  entriesRef.current = entries;

  const scanNow = useCallback(async () => {
    const root = rootRef.current;
    if (!root) {
      setScanView(null);
      setScanError(null);
      return;
    }
    if (scanningRef.current) return;
    scanningRef.current = true;
    setScanning(true);
    try {
      const view = await api.gitScanRepos(root, depthRef.current);
      if (rootRef.current === root) {
        setScanView(view);
        setScanError(null);
        lastScanRef.current = Date.now();
      }
    } catch (e) {
      if (rootRef.current === root) {
        setScanError(typeof e === "string" ? e : errorMessage(e));
      }
    } finally {
      scanningRef.current = false;
      setScanning(false);
    }
  }, []);

  const rescan = useCallback(() => {
    lastScanRef.current = 0;
    return scanNow();
  }, [scanNow]);

  const refreshSummaries = useCallback(async () => {
    const list = entriesRef.current;
    if (!list.length) return;
    const generation = ++summaryGen.current;
    const results = await Promise.allSettled(
      list.map((entry) => api.gitRepoSummary(entry.root))
    );
    if (generation !== summaryGen.current) return;
    const next = new Map<string, GitRepoSummary>();
    const errors = new Map<string, string>();
    results.forEach((result, index) => {
      const entry = list[index];
      const key = pathKey(entry.root);
      if (result.status === "fulfilled") next.set(key, result.value);
      else errors.set(key, typeof result.reason === "string" ? result.reason : errorMessage(result.reason));
    });
    setSummaries(next);
    setSummaryErrors(errors);
  }, []);

  // A different folder is a different list. Keep the group's manual entries, but drop every
  // reading tied to the old tree until the new scan answers.
  useEffect(() => {
    setSelected("");
    pendingSelectRef.current = null;
    setScanView(null);
    setScanError(null);
    setSummaries(new Map());
    setSummaryErrors(new Map());
    setStatusByRepo(new Map());
    lastScanRef.current = 0;
  }, [rootDir]);

  // Scanning reads the disk; do it when a view that shows the list is opened, when the depth
  // changes, and when the cached answer has gone stale.
  useEffect(() => {
    if (!active || !rootDir) return;
    const stale = !scanView || Date.now() - lastScanRef.current > SCAN_TTL_MS;
    if (stale) void scanNow();
  }, [active, rootDir, depth, scanView, scanNow]);

  // Pick a repository: the one the user saved, else the folder's own, the parent, or the first.
  useEffect(() => {
    const keys = new Set(entries.map((entry) => pathKey(entry.root)));
    const pending = pendingSelectRef.current;
    if (pending) {
      const match = entries.find((entry) => pathKey(entry.root) === pathKey(pending));
      if (match) {
        pendingSelectRef.current = null;
        setSelected(match.root);
      }
      return;
    }
    const current = selectedRef.current;
    const currentKey = current ? pathKey(current) : "";
    const savedKey = savedSelected ? pathKey(savedSelected) : "";
    // A saved choice that differs from what is showing wins: this is how a group restores the
    // repository it was left on after the list was rebuilt.
    if (savedKey && keys.has(savedKey)) {
      if (savedKey !== currentKey) setSelected(savedSelected);
      return;
    }
    if (current && keys.has(currentKey)) return;
    const fallback =
      entries.find((entry) => entry.source === "root") ??
      entries.find((entry) => entry.source === "parent") ??
      entries[0];
    setSelected(fallback?.root ?? "");
  }, [entries, savedSelected]);

  // Counts for the list and the status bar. Only while a view that shows them is open.
  useEffect(() => {
    if (!active || !entries.length) return;
    let alive = true;
    const tick = () => {
      if (!alive) return;
      void refreshSummaries();
    };
    tick();
    const timer = window.setInterval(tick, SUMMARY_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
      summaryGen.current += 1;
    };
  }, [active, entries, refreshSummaries]);

  // Explorer operations already announce themselves; refresh the counts they may have changed.
  // A full rescan is left to the explicit button and the 30s cache: creating a file is not a
  // reason to walk the whole tree again.
  useEffect(() => {
    if (!active) return;
    let timer: number | undefined;
    const onChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void refreshSummaries(), 300);
    };
    window.addEventListener("wrolp:folder-changed", onChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("wrolp:folder-changed", onChange);
    };
  }, [active, refreshSummaries]);

  // Per-repository statuses for Explorer decorations, one repository per tick so a workspace
  // with many repositories does not launch them all at the same moment.
  useEffect(() => {
    if (!decorating || !entries.length) return;
    let alive = true;
    let index = 0;
    const tick = async () => {
      const all = entriesRef.current;
      // A workspace with dozens of repositories should not launch a status read for every one;
      // beyond the limit the Explorer keeps the selected repository (live, from the panel
      // controller) and the folder's own / parent repository.
      const list =
        all.length > DECORATE_LIMIT
          ? all.filter((entry) => entry.source === "root" || entry.source === "parent")
          : all;
      if (!alive || !list.length) return;
      const entry = list[index % list.length];
      index += 1;
      try {
        const status = await api.gitStatus(entry.root);
        if (!alive) return;
        setStatusByRepo((previous) => {
          const next = new Map(previous);
          next.set(pathKey(entry.root), status);
          return next;
        });
      } catch {
        // The list already carries an unavailable marker from its summary; a failed
        // decoration read keeps the last marks rather than clearing them.
      }
    };
    void tick();
    const timer = window.setInterval(() => void tick(), SUMMARY_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [decorating, entries]);

  // Drop readings for repositories that are no longer listed.
  useEffect(() => {
    const keys = new Set(entries.map((entry) => pathKey(entry.root)));
    setStatusByRepo((previous) => {
      if (!previous.size) return previous;
      const next = new Map<string, GitStatusView>();
      for (const [key, status] of previous) {
        if (keys.has(key)) next.set(key, status);
      }
      return next.size === previous.size ? previous : next;
    });
  }, [entries]);

  const select = useCallback(
    (root: string) => {
      const key = pathKey(root);
      const known = entriesRef.current.find((entry) => pathKey(entry.root) === key);
      pendingSelectRef.current = known ? null : root;
      setSelected(root);
      // Persist only what the user chose; a fallback is recomputed from the list next time.
      onSelectRef.current(root);
    },
    []
  );

  const rows = useMemo(
    () =>
      entries.map((entry): GitRepoRow => {
        const key = pathKey(entry.root);
        const summary = summaries.get(key);
        const error = summaryErrors.get(key);
        const head = summary?.repo.head;
        return {
          ...entry,
          manual: entry.source === "manual",
          unavailable: !!error,
          branch: head?.branch ?? head?.short ?? null,
          ahead: head?.ahead ?? 0,
          behind: head?.behind ?? 0,
          changed: summary?.files ?? 0,
          state: summary?.repo.state ?? "clean",
        };
      }),
    [entries, summaries, summaryErrors]
  );

  const selectedRoot =
    selected && entries.some((entry) => pathKey(entry.root) === pathKey(selected))
      ? selected
      : null;
  // Before the first answer arrives there is no list to be empty about; the panel should say
  // it is scanning rather than "no repositories found".
  const waitingForScan =
    active && !!rootDir && !scanView && !scanError && !scanning;

  return {
    rows,
    selectedRoot,
    scanning: scanning || waitingForScan,
    scanError,
    truncated: scanView?.truncated ?? false,
    decorationsCapped: entries.length > DECORATE_LIMIT,
    summaries,
    summaryErrors,
    statusByRepo,
    select,
    rescan,
    refreshSummaries,
  };
}

function relativeLabel(root: string, rootDir: string | null): string {
  if (!rootDir) return root;
  if (pathKey(root) === pathKey(rootDir)) return ".";
  if (isUnder(root, rootDir)) {
    const prefix = rootDir.replace(/\\/g, "/").replace(/\/$/, "");
    const text = root.replace(/\\/g, "/");
    return text.slice(prefix.length + 1);
  }
  // A repository outside the folder has no useful relative label; the name and the row's
  // tooltip carry the full path.
  return "";
}
