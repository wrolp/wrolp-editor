import { fileIcon } from "../lib/path";
import { IconCompare, IconSettings } from "./icons";
import type { Tab } from "../lib/types";

/**
 * The file-type glyph shown next to a file name, in the tab strip, the tab
 * dropdown and the Explorer tree. Shared so a file looks the same everywhere:
 * the type is learned once, in `fileIcon`, and colour lives in `app.css`.
 */
export function FileIcon({ name }: { name: string }) {
  const { cls, sym } = fileIcon(name);
  return <span className={`file-glyph ${cls}`}>{sym}</span>;
}

/**
 * What a tab shows instead of a file name: the two special tabs are not files, so
 * they get an icon of their own. This lives in one place because the tab strip and
 * the tab dropdown would otherwise each keep their own copy of the decision.
 */
export function TabIcon({ tab }: { tab: Tab }) {
  if (tab.compare) {
    return (
      <span className="file-glyph icon-compare" title={tab.compare.left.path}>
        <IconCompare size={12} />
      </span>
    );
  }
  if (tab.isSettings) {
    return (
      <span className="file-glyph icon-settings">
        <IconSettings size={12} />
      </span>
    );
  }
  return <FileIcon name={tab.name} />;
}

export default FileIcon;
