import { useCallback, useMemo, useRef } from "react";
import { t } from "../lib/i18n";
import {
  api,
  errorMessage,
  type VersionBaseline,
  type VersionEntry,
  type VersionState,
  type VersionSummary,
} from "../lib/tauri";

interface Options {
  toast: (message: string) => void;
}

/** The text a file held before this save, and when it last changed on disk. */
export interface BaselineInput {
  content: string;
  /** Milliseconds, as the stat the tab was built from reports them. */
  mtimeMs: number | null | undefined;
}

/**
 * What the save path needs of versioning, and nothing else: a recorder that cannot fail a save.
 */
export interface VersionRecorder {
  recordSave(
    path: string,
    content: string,
    baseline: BaselineInput | null
  ): Promise<void>;
}

/**
 * Versions of the open files, recorded in the shadow repository the backend keeps.
 *
 * Every rule — whether this file is tracked, whether it is too big, whether the content changed
 * since the last row — is decided by the backend. This hook asks, records, and reports; it does not
 * reason about which of the global default and the per-file override wins, because a rule spelled
 * out in two places is a rule that drifts.
 */
export function useVersions({ toast }: Options) {
  /**
   * Paths this session is known to carry history. An optimisation only: the backend decides whether
   * a baseline is worth writing, and this keeps a file's twentieth save from shipping the text it
   * had before its first.
   */
  const versioned = useRef(new Set<string>());
  /**
   * Files reported as too big, once each. A save that will never be versioned would otherwise
   * nag on every `Ctrl+S`, and a repeated notice is a notice nobody reads the third time.
   */
  const warned = useRef(new Set<string>());

  /**
   * Versioning is an addition to a save, never part of it: the file is already written by the time
   * this runs, so nothing here may reach the caller as a failure.
   */
  const reportFailure = useCallback(
    (e: unknown, path: string) => {
      const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
      if (raw.startsWith("version_too_large")) {
        // No size in the message: the backend counts bytes and the status bar counts characters,
        // and a number that means the wrong one of those is worse than no number.
        if (!warned.current.has(path)) {
          warned.current.add(path);
          toast(t("ver.tooLarge"));
        }
        return;
      }
      toast(errorMessage(e));
    },
    [toast]
  );

  const recordSave = useCallback(
    async (path: string, content: string, baseline: BaselineInput | null) => {
      const first: VersionBaseline | null =
        baseline && !versioned.current.has(path)
          ? {
              content: baseline.content,
              message: t("ver.baseline"),
              at:
                baseline.mtimeMs !== null && baseline.mtimeMs !== undefined
                  ? Math.floor(baseline.mtimeMs / 1000)
                  : null,
            }
          : null;
      try {
        const outcome = await api.addVersion(path, content, null, first);
        if (outcome.status === "created") versioned.current.add(path);
      } catch (e) {
        reportFailure(e, path);
      }
    },
    [reportFailure]
  );

  const recorder = useMemo<VersionRecorder>(() => ({ recordSave }), [recordSave]);

  /**
   * Record a version on purpose. Works whatever the settings say, and takes the file into
   * tracking to do it: a user who asks for a version of a file has said they want its history.
   */
  const createVersion = useCallback(
    async (path: string, content: string): Promise<boolean> => {
      try {
        await api.setVersionOverride(path, "on");
        const outcome = await api.addVersion(path, content, null, null);
        if (outcome.status === "skipped") {
          // The file already ends at exactly this text, so there is nothing new to keep. Said out
          // loud rather than letting the menu look like it did nothing.
          toast(t("ver.unchanged"));
          return false;
        }
        versioned.current.add(path);
        toast(t("ver.created"));
        return true;
      } catch (e) {
        reportFailure(e, path);
        return false;
      }
    },
    [reportFailure, toast]
  );

  const versionsOf = useCallback(
    (path: string): Promise<VersionEntry[]> => api.getVersions(path),
    []
  );
  const listAll = useCallback(
    (): Promise<VersionSummary[]> => api.listVersions(),
    []
  );
  const contentOf = useCallback(
    (path: string, oid: string): Promise<string> => api.getVersionContent(path, oid),
    []
  );
  const stateOf = useCallback(
    (path: string): Promise<VersionState> => api.versioningState(path),
    []
  );
  const setOverride = useCallback(
    (path: string, mode: string | null): Promise<VersionState> =>
      api.setVersionOverride(path, mode),
    []
  );
  const clearAll = useCallback(async (): Promise<void> => {
    // Everything remembered about which files carry history goes with the history itself.
    versioned.current.clear();
    warned.current.clear();
    await api.clearVersions();
    toast(t("ver.cleared"));
  }, [toast]);

  /**
   * Memoized, and this one matters more than it looks.
   *
   * The caller passes this object into effects as a dependency. A fresh object literal each
   * render is a new dependency each render, so every effect that lists versions or reads one
   * file's timeline re-ran, called the backend, set state from the answer, and rendered the
   * caller again — an idle window looping on IPC and re-renders, which feels like the whole
   * program has turned to mud.
   */
  return useMemo(
    () => ({
      recorder,
      createVersion,
      versionsOf,
      listAll,
      contentOf,
      stateOf,
      setOverride,
      clearAll,
    }),
    [
      recorder,
      createVersion,
      versionsOf,
      listAll,
      contentOf,
      stateOf,
      setOverride,
      clearAll,
    ]
  );
}
