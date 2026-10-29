import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatWhen, t, translateError } from "../lib/i18n";
import { basename, langOf } from "../lib/path";
import { api, errorMessage, type GitCommitFile, type GitDiffText } from "../lib/tauri";
import { badgeTone } from "../lib/gitStatus";
import { foldPair, type FoldChange } from "../lib/diffFold";
import type { CommitTabData, ComparePair } from "../lib/types";
import DiffView from "./DiffView";
import { IconChevron, IconFold } from "./icons";

interface ViewProps {
  fontSize: number;
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  scrollBeyondLastLine: boolean;
}

interface Props extends ViewProps {
  data: CommitTabData;
}

/** The i18n key for a diff that cannot be shown as text, or null when it can. */
function blockedKey(diff: GitDiffText): string | null {
  if (diff.binary) return "git.diffBinary";
  if (diff.tooLarge) return "git.diffTooLarge";
  if (diff.submodule) return "git.diffSubmodule";
  if (diff.encrypted) return "git.diffEncrypted";
  return null;
}

/** `DiffView` reports totals for the status bar; this view has no status bar of its own. */
const ignoreStats = () => {};

/**
 * One commit's changed files, folded by file. A file's header is expanded on demand, and its diff
 * is read the first time that happens, then cached: the commit is immutable, and a commit that
 * changed hundreds of files never pays for the diffs nobody opened. Inside an open file the diff
 * can be folded down to its changed lines.
 */
export default function CommitTabView({
  data,
  fontSize,
  renderWhitespace,
  wordWrap,
  tabSize,
  insertSpaces,
  detectIndentation,
  scrollBeyondLastLine,
}: Props) {
  const [files, setFiles] = useState<GitCommitFile[] | null>(null);
  const [filesError, setFilesError] = useState<string | null>(null);
  const [filesRev, setFilesRev] = useState(0);
  const [diffs, setDiffs] = useState<Map<string, GitDiffText | string>>(new Map());
  const diffsRef = useRef(diffs);
  diffsRef.current = diffs;
  const filesRef = useRef<GitCommitFile[] | null>(null);
  filesRef.current = files;
  const loadingRef = useRef(new Set<string>());
  /** The file sections that are open; a commit starts folded so the list stays a list. */
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [messageOpen, setMessageOpen] = useState(false);
  /** The visible height of the file list, so a diff never grows taller than the editor area. */
  const [listHeight, setListHeight] = useState(0);
  const listObserver = useRef<ResizeObserver | null>(null);
  const attachList = useCallback((el: HTMLDivElement | null) => {
    listObserver.current?.disconnect();
    if (el) {
      const measure = () => setListHeight(el.clientHeight);
      measure();
      listObserver.current = new ResizeObserver(measure);
      listObserver.current.observe(el);
    }
  }, []);

  useEffect(() => {
    let live = true;
    setFiles(null);
    setFilesError(null);
    setDiffs(new Map());
    setOpen(new Set());
    setMessageOpen(false);
    loadingRef.current.clear();
    api
      .gitCommitFiles(data.root, data.entry.oid)
      .then((list) => {
        if (live) setFiles(list);
      })
      .catch((e) => {
        if (live) setFilesError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [data.root, data.entry.oid, filesRev]);

  const loadDiff = useCallback(
    (path: string) => {
      const file = filesRef.current?.find((entry) => entry.path === path);
      if (!file) return;
      if (diffsRef.current.has(path) || loadingRef.current.has(path)) return;
      loadingRef.current.add(path);
      api
        .gitDiff(data.root, file.abs, "commit", file.oldPath, data.entry.oid)
        .then((diff) => setDiffs((prev) => new Map(prev).set(path, diff)))
        .catch((e) => setDiffs((prev) => new Map(prev).set(path, errorMessage(e))))
        .finally(() => {
          loadingRef.current.delete(path);
        });
    },
    [data.root, data.entry.oid]
  );

  const toggle = (path: string) => {
    const willOpen = !open.has(path);
    setOpen((prev) => {
      const next = new Set(prev);
      if (willOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    if (willOpen) loadDiff(path);
  };

  const reload = useCallback(() => setFilesRev((value) => value + 1), []);

  return (
    <div className="commit-view">
      <div className="commit-head">
        <div className="commit-head-row">
          <span className="commit-short">{data.entry.short}</span>
          <span className="commit-summary">{data.entry.summary || t("git.noMessage")}</span>
        </div>
        <div className="commit-meta">
          <span>{data.entry.author}</span>
          <span>·</span>
          <span>{formatWhen(data.entry.time)}</span>
          {data.entry.parents.length > 0 && (
            <>
              <span>·</span>
              <span>{t("git.commitTab.parents", { n: data.entry.parents.length })}</span>
            </>
          )}
        </div>
      </div>

      <button
        className="commit-message-toggle"
        onClick={() => setMessageOpen((open) => !open)}
        aria-expanded={messageOpen}
      >
        <span className={`commit-chev${messageOpen ? "" : " rot"}`}>
          <IconChevron size={11} />
        </span>
        {t("git.commitTab.message")}
      </button>
      {messageOpen && <pre className="commit-message">{data.entry.message.trimEnd()}</pre>}

      {filesError ? (
        <div className="commit-placeholder">
          <span>{translateError(filesError)}</span>
          <button className="btn small" onClick={reload}>
            {t("git.local.retry")}
          </button>
        </div>
      ) : files === null ? (
        <div className="commit-placeholder">{t("git.loading")}</div>
      ) : files.length === 0 ? (
        <div className="commit-placeholder">{t("git.commitTab.empty")}</div>
      ) : (
        <>
          <div className="commit-toolbar">
            <span>{t("git.commitTab.files", { n: files.length })}</span>
          </div>
          <div className="commit-list" ref={attachList}>
            {files.map((file) => {
              const isOpen = open.has(file.path);
              const diff = diffs.get(file.path);
              return (
                <div className="commit-file-section" key={file.path}>
                  <button
                    className="commit-file-head"
                    onClick={() => toggle(file.path)}
                    aria-expanded={isOpen}
                    title={file.path}
                  >
                    <span className={`commit-chev${isOpen ? "" : " rot"}`}>
                      <IconChevron size={11} />
                    </span>
                    <span className={`git-badge ${badgeTone(file.status)}`}>{file.status}</span>
                    <span className="commit-file-name">{file.path}</span>
                    {file.oldPath && <span className="commit-file-old">{file.oldPath} →</span>}
                  </button>
                  {isOpen &&
                    (diff === undefined ? (
                      <div className="commit-file-diff">
                        <div className="commit-placeholder">{t("git.loading")}</div>
                      </div>
                    ) : (
                      <CommitFileDiff
                        file={file}
                        diff={diff}
                        oid={data.entry.oid}
                        short={data.entry.short}
                        maxHeight={listHeight}
                        fontSize={fontSize}
                        renderWhitespace={renderWhitespace}
                        wordWrap={wordWrap}
                        tabSize={tabSize}
                        insertSpaces={insertSpaces}
                        detectIndentation={detectIndentation}
                        scrollBeyondLastLine={scrollBeyondLastLine}
                      />
                    ))}
                </div>
              );
            })}
            {files.length >= 5000 && (
              <div className="commit-note">{t("git.commitTab.truncated")}</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface FileDiffProps extends ViewProps {
  file: GitCommitFile;
  /** `GitDiffText` for a normal file, or an error string when the read failed. */
  diff: GitDiffText | string;
  oid: string;
  short: string;
  /** The editor area's visible height; a diff must not grow past it. */
  maxHeight: number;
}

/**
 * One file's diff, with a fold that keeps only the changed lines. The fold cuts the whole texts by
 * the ranges Monaco computed for those same whole texts, which is why `changes` is collected only
 * while the fold is off.
 */
function CommitFileDiff({
  file,
  diff,
  oid,
  short,
  maxHeight,
  fontSize,
  renderWhitespace,
  wordWrap,
  tabSize,
  insertSpaces,
  detectIndentation,
  scrollBeyondLastLine,
}: FileDiffProps) {
  // Folded by default: "show only changes" is the view people open this tab for. Until the
  // diff's changed ranges arrive the whole text is shown and the ranges are collected, then the
  // fold applies on its own.
  const [fold, setFold] = useState(true);
  const [changes, setChanges] = useState<readonly FoldChange[] | null>(null);

  const full = useMemo(
    () =>
      typeof diff === "string"
        ? { left: "", right: "" }
        : { left: diff.left.text, right: diff.right.text },
    [diff]
  );
  // The editor reports an empty change list on mount, before the diff is computed; that empty
  // list must not count as "nothing to fold", or the first real update would be discarded and
  // the default fold would never apply.
  const ready = !!changes && changes.length > 0;
  const folded = useMemo(
    () => (fold && ready && changes ? foldPair(full.left, full.right, changes) : null),
    [fold, ready, changes, full]
  );
  const source = useMemo(() => folded ?? full, [folded, full]);
  // The pane is sized to what is actually on screen, so a one-line change is not shown in a
  // fixed box and a long file scrolls on its own.
  const hostHeight = useMemo(() => {
    const count = (text: string) => (text.length === 0 ? 0 : text.split("\n").length);
    const lines = Math.max(count(source.left), count(source.right), 1);
    const linePx = Math.max(1, Math.round(fontSize * 1.5));
    // Leave a little of the list visible below the diff, so the next file's header peeks out
    // instead of the pane filling the whole editor area.
    const cap = maxHeight > 0 ? Math.max(160, maxHeight - 96) : 900;
    return Math.min(cap, Math.max(160, lines * linePx + 30));
  }, [source, fontSize, maxHeight]);
  const pair = useMemo<ComparePair | null>(() => {
    if (typeof diff === "string") return null;
    const name = basename(file.path);
    const language = langOf(file.path);
    return {
      left: {
        path: diff.left.path,
        name: `${name} · ${t("git.sideParent")}`,
        content: source.left,
        language,
        kind: "git",
        oid: `${oid}:l:${diff.left.oid ?? "missing"}`,
      },
      right: {
        path: diff.right.path,
        name: `${name} · ${short}`,
        content: source.right,
        language,
        kind: "git",
        oid: `${oid}:r:${diff.right.oid ?? "missing"}`,
      },
    };
  }, [diff, source, file.path, oid, short]);

  if (typeof diff === "string") {
    return <div className="commit-placeholder">{translateError(diff)}</div>;
  }
  const blocked = blockedKey(diff);
  if (blocked) {
    return <div className="commit-placeholder">{t(blocked)}</div>;
  }
  if (!pair) {
    return <div className="commit-placeholder">{t("git.loading")}</div>;
  }

  return (
    <div className="commit-file-diff">
      <div className="commit-file-diff-tools">
        <button
          className={`btn small icon-btn${fold ? " on" : ""}`}
          onClick={() => setFold(!fold)}
          disabled={!ready}
          title={t("ver.fold")}
          aria-label={t("ver.fold")}
          aria-pressed={fold}
        >
          <IconFold size={14} />
        </button>
        {folded?.folded && (
          <span className="ver-hidden">
            {t("ver.hiddenLines", { left: folded.hiddenLeft, right: folded.hiddenRight })}
          </span>
        )}
        {fold && ready && !folded?.folded && (
          <span className="ver-hidden">{t("ver.nothingHidden")}</span>
        )}
      </div>
      <div className="commit-file-diff-host" style={{ height: hostHeight }}>
        <DiffView
          key={file.path}
          pair={pair}
          fontSize={fontSize}
          renderWhitespace={renderWhitespace}
          wordWrap={wordWrap}
          tabSize={tabSize}
          insertSpaces={insertSpaces}
          detectIndentation={detectIndentation}
          scrollBeyondLastLine={scrollBeyondLastLine}
          onStats={ignoreStats}
          onChanges={fold && ready ? undefined : setChanges}
        />
      </div>
    </div>
  );
}
