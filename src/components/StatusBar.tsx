import { t } from "../lib/i18n";
import type { EditStats, Tab } from "../lib/types";

interface Props {
  tab: Tab | null;
  line: number;
  column: number;
  stats: EditStats;
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

export default function StatusBar({ tab, line, column, stats }: Props) {
  const file = tab && !tab.isSettings;
  return (
    <div className="statusbar">
      <span className="sb-path">
        {tab ? (tab.isSettings ? t("tab.settings") : tab.path) : t("status.noFile")}
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
      <span className="sb-cursor">
        {file ? t("status.cursor", { line, column }) : ""}
      </span>
      <span className="sb-lang">{file ? tab.language : ""}</span>
    </div>
  );
}
