import { t } from "../lib/i18n";
import type { Tab } from "../lib/types";

interface Props {
  tab: Tab | null;
  line: number;
  column: number;
}

export default function StatusBar({ tab, line, column }: Props) {
  const file = tab && !tab.isSettings;
  return (
    <div className="statusbar">
      <span className="sb-path">
        {tab ? (tab.isSettings ? t("tab.settings") : tab.path) : t("status.noFile")}
      </span>
      <span className="sb-spacer" />
      <span className={`sb-dirty${file && tab.dirty ? " is-dirty" : ""}`}>
        {file ? (tab.dirty ? t("status.dirty") : t("status.saved")) : ""}
      </span>
      <span className="sb-cursor">
        {file ? t("status.cursor", { line, column }) : ""}
      </span>
      <span className="sb-lang">{file ? tab.language : ""}</span>
    </div>
  );
}
