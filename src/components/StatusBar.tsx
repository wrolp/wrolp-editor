import { t } from "../lib/i18n";
import { isBitmapImage } from "../lib/path";
import { IconBranch, IconLock } from "./icons";
import { isFileTab, type DiffStats, type EditStats, type Tab } from "../lib/types";

/** The Source Control summary, shown whatever file is on screen. */
export interface GitSummary {
  branch: string;
  ahead: number;
  behind: number;
  changed: number;
}

interface Props {
  tab: Tab | null;
  line: number;
  column: number;
  stats: EditStats;
  /**
   * `LF`, `CRLF` or `CR` — what a save of this tab would write as its line ending, or empty
   * when the tab has no text to end. Language-neutral, like the size next to it.
   */
  eol: string;
  /** Added/removed lines of a comparison tab; null while any other tab is showing. */
  diff: DiffStats | null;
  /** Branch, divergence and changed-file count; null when there is no repository. */
  git: GitSummary | null;
  /** Opens the Source Control view when the git summary is clicked. */
  onGitClick?: () => void;
}

/**
 * Bytes as Explorer shows them: 1024-based, at most one decimal. Units are
 * language-neutral, so this needs no translation.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export default function StatusBar({
  tab,
  line,
  column,
  stats,
  eol,
  diff,
  git,
  onGitClick,
}: Props) {
  // A comparison tab shows two files, so the file counters (selection, size, dirty) and
  // the single caret readout do not apply to it; it gets the diff totals instead.
  const file = tab && isFileTab(tab);
  const comparing = tab?.compare ?? null;
  // A picture is not text: its "character count" is the byte decoder's opinion, and the
  // caret belongs to an editor that is not on screen. Only the size on disk is real.
  const picture = !!tab && !tab.isSettings && isBitmapImage(tab.path);
  const counters = file && !picture;
  return (
    <div className="statusbar">
      <span className="sb-path">
        {tab
          ? tab.isSettings
            ? t("tab.settings")
            : comparing
              ? t("cmp.label", { left: comparing.left.name, right: comparing.right.name })
              : tab.path
          : t("status.noFile")}
      </span>
      <span className="sb-spacer" />
      {git && (
        <button
          type="button"
          className="sb-git"
          onClick={onGitClick}
          title={t("git.statusTitle", {
            branch: git.branch,
            ahead: git.ahead,
            behind: git.behind,
            changed: git.changed,
          })}
        >
          <IconBranch size={11} />
          <span className="sb-git-branch">{git.branch}</span>
          {git.ahead > 0 && <span>↑{git.ahead}</span>}
          {git.behind > 0 && <span>↓{git.behind}</span>}
          {git.changed > 0 && <span className="sb-git-changes">{git.changed}</span>}
        </button>
      )}
      {counters && stats.selectionChars > 0 && (
        <span className="sb-selection">
          {stats.selectionLines > 1
            ? t("status.selectionLines", {
                n: stats.selectionChars.toLocaleString(),
                lines: stats.selectionLines,
              })
            : t("status.selection", { n: stats.selectionChars.toLocaleString() })}
        </span>
      )}
      {counters && (
        <span className="sb-total">{t("status.totalChars", { n: stats.totalChars.toLocaleString() })}</span>
      )}
      {file && tab.bytes !== null && (
        <span className="sb-size">{formatBytes(tab.bytes)}</span>
      )}
      {file && tab.encrypted && (
        <span className={`sb-lock${tab.locked ? " is-locked" : ""}`}>
          <IconLock size={11} locked={!!tab.locked} />
          {t(tab.locked ? "enc.statusLocked" : "enc.statusEncrypted")}
        </span>
      )}
      {counters && tab.dirty && <span className="sb-dirty is-dirty">{t("status.dirty")}</span>}
      {counters && !tab.dirty && <span className="sb-dirty">{t("status.saved")}</span>}
      {comparing && (
        <span className="sb-diff">
          {diff && (diff.added > 0 || diff.removed > 0) ? (
            <>
              {diff.added > 0 && <span className="add">+{diff.added}</span>}
              {diff.removed > 0 && <span className="del">−{diff.removed}</span>}
            </>
          ) : (
            t("cmp.identical")
          )}
        </span>
      )}
      <span className="sb-cursor">
        {counters ? t("status.cursor", { line, column }) : ""}
      </span>
      {/* Only the ending itself, in the three letters every editor uses; a tab that is not a
          text file has none to show. */}
      {eol && <span className="sb-eol">{eol}</span>}
      <span className="sb-lang">{counters ? tab.language : ""}</span>
    </div>
  );
}
