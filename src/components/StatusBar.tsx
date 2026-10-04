import type { Tab } from "../lib/types";

interface Props {
  tab: Tab | null;
  line: number;
  column: number;
}

export default function StatusBar({ tab, line, column }: Props) {
  return (
    <div className="statusbar">
      <span className="sb-path">{tab ? (tab.isSettings ? "Settings" : tab.path) : "No file open"}</span>
      <span className="sb-spacer" />
      <span className="sb-dirty">
        {tab && !tab.isSettings ? (tab.dirty ? "● Unsaved" : "Saved") : ""}
      </span>
      <span className="sb-cursor">
        {tab && !tab.isSettings ? `Ln ${line} · Col ${column}` : ""}
      </span>
      <span className="sb-lang">{tab && !tab.isSettings ? tab.language : ""}</span>
    </div>
  );
}
