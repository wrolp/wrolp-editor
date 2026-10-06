import { t } from "../lib/i18n";
import { isFileTab, type DiffStats, type EditStats, type Tab } from "../lib/types";

interface Props {
  tab: Tab | null;
  line: number;
  column: number;
  stats: EditStats;
  /** Added/removed lines of a comparison tab; null while any other tab is showing. */
  diff: DiffStats | null;
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

export default function StatusBar({ tab, line, column, stats, diff }: Props) {
  // A comparison tab shows two files, so the file counters (selection, size, dirty) and
  // the single caret readout do not apply to it; it gets the diff totals instead.
  const file = tab && isFileTab(tab);
  const comparing = tab?.compare ?? null;
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
      {file && stats.selectionChars > 0 && (
        <span className="sb-selection">
          {stats.selectionLines > 1
            ? t("status.selectionLines", {
                n: stats.selectionChars.toLocaleString(),
                lines: stats.selectionLines,
              })
            : t("status.selection", { n: stats.selectionChars.toLocaleString() })}
        </span>
      )}
      {file && (
        <span className="sb-total">{t("status.totalChars", { n: stats.totalChars.toLocaleString() })}</span>
      )}
      {file && tab.bytes !== null && (
        <span className="sb-size">{formatBytes(tab.bytes)}</span>
      )}
      {file && tab.dirty && <span className="sb-dirty is-dirty">{t("status.dirty")}</span>}
      {file && !tab.dirty && <span className="sb-dirty">{t("status.saved")}</span>}
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
        {file ? t("status.cursor", { line, column }) : ""}
      </span>
      <span className="sb-lang">{file ? tab.language : ""}</span>
    </div>
  );
}
