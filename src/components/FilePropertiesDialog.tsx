import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorMessage, type FileProperties } from "../lib/tauri";
import { formatWhen, t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";

interface Props {
  /** The file or folder to describe. The dialog reads everything else from the disk. */
  path: string;
  onClose: () => void;
}

/** Bytes the way the rest of the app writes them: 1024-based, at most one decimal. */
function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The few facts about a file a reader actually asks for.
 *
 * Drawn here rather than handing the path to the shell: the Windows sheet carries a security
 * tab and a details tab that describe the volume more than the file, and it is one more window
 * to find and close. Size, both timestamps and the two attributes that change how the row
 * behaves are what the Explorer's own menu was asked for.
 *
 * Everything is read once, on open. A file can be renamed or replaced between two reads, and a
 * dialog that says "5 KB" beside a modified time from a different second is worse than one
 * that says nothing.
 */
export default function FilePropertiesDialog({ path, onClose }: Props) {
  const [props, setProps] = useState<FileProperties | null>(null);
  const [error, setError] = useState<string | null>(null);
  const drag = useModalDrag<HTMLDivElement>();
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let alive = true;
    void api
      .fileProperties(path)
      .then((value) => {
        if (alive) setProps(value);
      })
      .catch((e) => {
        if (alive) setError(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeRef.current();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const row = (label: string, value: ReactNode, className?: string) => (
    <div className="props-row">
      <span className="props-label">{label}</span>
      <span className={`props-value${className ? ` ${className}` : ""}`}>{value}</span>
    </div>
  );

  /** The attributes that are set, or a word saying there are none worth mentioning. */
  const attributes = props
    ? [props.readonly ? t("props.readonly") : null, props.hidden ? t("props.hidden") : null].filter(
        (value): value is string => value !== null
      )
    : [];

  return (
    <div className="modal-overlay">
      <div className="modal props-modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("props.title")}
        </h3>

        {error && <p className="muted">{error}</p>}
        {!error && !props && <p className="muted">{t("props.loading")}</p>}

        {props && (
          <div className="props-list">
            {row(t("props.name"), props.name, "props-name")}
            {row(t("props.path"), props.path, "props-path")}
            {row(t("props.kind"), props.isDir ? t("props.folder") : t("props.file"))}
            {row(
              t("props.size"),
              props.isDir
                ? props.entries === null
                  ? t("props.unknown")
                  : t("props.items", { n: props.entries })
                : sizeLabel(props.bytes)
            )}
            {row(t("props.created"), props.created ? formatWhen(props.created) : t("props.unknown"))}
            {row(
              t("props.modified"),
              props.modified ? formatWhen(props.modified) : t("props.unknown")
            )}
            {row(
              t("props.attributes"),
              attributes.length > 0 ? attributes.join(" · ") : t("props.normal")
            )}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            {t("props.close")}
          </button>
        </div>
      </div>
    </div>
  );
}
