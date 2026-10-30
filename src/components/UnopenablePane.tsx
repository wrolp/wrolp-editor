import { t, translateError } from "../lib/i18n";
import { api, errorMessage, revealItemInDir } from "../lib/tauri";

interface Props {
  name: string;
  path: string;
  /** The raw backend error, so the reason follows the interface language. */
  error: string;
  onNotice: (message: string) => void;
}

/**
 * The pane a file that could not be read as text gets instead of an editor.
 *
 * The editor behind it is hidden, not removed, so Monaco keeps whatever it holds; this pane
 * is the whole story — what failed, and two ways out. "Open with the default app" hands it to
 * the OS (the reason this tab exists at all), "Show in Explorer" just locates it.
 */
export default function UnopenablePane({ name, path, error, onNotice }: Props) {
  const open = () => {
    api.openInSystem(path).catch((e) => onNotice(errorMessage(e)));
  };
  return (
    <div className="unopenable">
      <div className="unopenable-name">{name}</div>
      <div className="unopenable-reason">{translateError(error)}</div>
      <div className="unopenable-actions">
        <button className="btn" onClick={open}>
          {t("unopenable.open")}
        </button>
        <button
          className="btn"
          onClick={() => {
            revealItemInDir(path).catch((e) => onNotice(errorMessage(e)));
          }}
        >
          {t("unopenable.reveal")}
        </button>
      </div>
      <div className="unopenable-hint">{t("unopenable.closeHint")}</div>
    </div>
  );
}
