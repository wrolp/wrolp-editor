import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatWhen, t, translateError } from "../lib/i18n";
import { basename, langOf } from "../lib/path";
import { api, errorMessage, type GitCommitFile, type GitDiffText } from "../lib/tauri";
import { badgeTone } from "../lib/gitStatus";
import type { CommitTabData, ComparePair } from "../lib/types";
import DiffView from "./DiffView";
import { IconChevron } from "./icons";

interface Props {
  data: CommitTabData;
  fontSize: number;
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  scrollBeyondLastLine: boolean;
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
 * One commit's changed files, with the diff of the selected file beside the list.
 *
 * The commit is immutable, so the list and each file's diff are read once and cached for the
 * life of the tab. A repository's file count can be large, which is why only one diff editor is
 * ever mounted: the list carries "all files", the pane carries "this one".
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
  const [selected, setSelected] = useState<string | null>(null);
  const [diffs, setDiffs] = useState<Map<string, GitDiffText | string>>(new Map());
  const diffsRef = useRef(diffs);
  diffsRef.current = diffs;
  const [diffLoading, setDiffLoading] = useState(false);
  const diffSeq = useRef(0);
  const [messageOpen, setMessageOpen] = useState(false);

  useEffect(() => {
    let live = true;
    setFiles(null);
    setFilesError(null);
    setSelected(null);
    setDiffs(new Map());
    setDiffLoading(false);
    setMessageOpen(false);
    diffSeq.current += 1;
    api
      .gitCommitFiles(data.root, data.entry.oid)
      .then((list) => {
        if (!live) return;
        setFiles(list);
        setSelected(list[0]?.path ?? null);
      })
      .catch((e) => {
        if (live) setFilesError(errorMessage(e));
      });
    return () => {
      live = false;
    };
  }, [data.root, data.entry.oid, filesRev]);

  useEffect(() => {
    const seq = ++diffSeq.current;
    if (!selected) return;
    if (diffsRef.current.has(selected)) {
      setDiffLoading(false);
      return;
    }
    const file = files?.find((entry) => entry.path === selected);
    if (!file) return;
    setDiffLoading(true);
    api
      .gitDiff(data.root, file.abs, "commit", file.oldPath, data.entry.oid)
      .then((diff) => {
        if (seq !== diffSeq.current) return;
        setDiffs((prev) => new Map(prev).set(selected, diff));
      })
      .catch((e) => {
        if (seq !== diffSeq.current) return;
        setDiffs((prev) => new Map(prev).set(selected, errorMessage(e)));
      })
      .finally(() => {
        if (seq === diffSeq.current) setDiffLoading(false);
      });
  }, [selected, files, data.root, data.entry.oid]);

  const diff = selected ? diffs.get(selected) : undefined;
  const blocked = diff && typeof diff !== "string" ? blockedKey(diff) : null;

  const pair = useMemo<ComparePair | null>(() => {
    if (!selected || !diff || typeof diff === "string") return null;
    if (blockedKey(diff)) return null;
    const name = basename(selected);
    const language = langOf(selected);
    return {
      left: {
        path: diff.left.path,
        name: `${name} · ${t("git.sideParent")}`,
        content: diff.left.text,
        language,
        kind: "git",
        oid: `${data.entry.oid}:l:${diff.left.oid ?? "missing"}`,
      },
      right: {
        path: diff.right.path,
        name: `${name} · ${data.entry.short}`,
        content: diff.right.text,
        language,
        kind: "git",
        oid: `${data.entry.oid}:r:${diff.right.oid ?? "missing"}`,
      },
    };
  }, [diff, selected, data.entry.oid, data.entry.short]);

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

      <div className="commit-body">
        <div className="commit-files">
          <div className="commit-files-head">
            {t("git.commitTab.files", { n: files?.length ?? 0 })}
          </div>
          {files === null ? (
            filesError ? (
              <div className="commit-placeholder">
                <span>{translateError(filesError)}</span>
                <button className="btn small" onClick={reload}>
                  {t("git.local.retry")}
                </button>
              </div>
            ) : (
              <div className="commit-placeholder">{t("git.loading")}</div>
            )
          ) : files.length === 0 ? (
            <div className="commit-placeholder">{t("git.commitTab.empty")}</div>
          ) : (
            files.map((file) => (
              <div className="commit-file-block" key={file.path}>
                <button
                  className={`commit-file${selected === file.path ? " active" : ""}`}
                  title={file.path}
                  onClick={() => setSelected(file.path)}
                >
                  <span className={`git-badge ${badgeTone(file.status)}`}>{file.status}</span>
                  <span className="commit-file-name">{file.path}</span>
                </button>
                {file.oldPath && (
                  <div className="commit-file-old" title={file.oldPath}>
                    {file.oldPath} →
                  </div>
                )}
              </div>
            ))
          )}
          {files && files.length >= 5000 && (
            <div className="commit-note">{t("git.commitTab.truncated")}</div>
          )}
        </div>

        <div className="commit-diff">
          {!selected ? (
            <div className="commit-placeholder">{t("git.commitTab.pick")}</div>
          ) : diffLoading && !diff ? (
            <div className="commit-placeholder">{t("git.loading")}</div>
          ) : typeof diff === "string" ? (
            <div className="commit-placeholder">{translateError(diff)}</div>
          ) : blocked ? (
            <div className="commit-placeholder">{t(blocked)}</div>
          ) : pair ? (
            <DiffView
              key={selected}
              pair={pair}
              fontSize={fontSize}
              renderWhitespace={renderWhitespace}
              wordWrap={wordWrap}
              tabSize={tabSize}
              insertSpaces={insertSpaces}
              detectIndentation={detectIndentation}
              scrollBeyondLastLine={scrollBeyondLastLine}
              onStats={ignoreStats}
            />
          ) : (
            <div className="commit-placeholder">{t("git.loading")}</div>
          )}
        </div>
      </div>
    </div>
  );
}
