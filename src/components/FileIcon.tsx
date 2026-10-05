import { fileIcon } from "../lib/path";

/**
 * The file-type glyph shown next to a file name, in the tab strip, the tab
 * dropdown and the Explorer tree. Shared so a file looks the same everywhere:
 * the type is learned once, in `fileIcon`, and colour lives in `app.css`.
 */
export default function FileIcon({ name }: { name: string }) {
  const { cls, sym } = fileIcon(name);
  return <span className={`file-glyph ${cls}`}>{sym}</span>;
}
