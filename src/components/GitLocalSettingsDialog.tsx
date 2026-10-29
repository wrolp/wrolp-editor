import { useCallback, useEffect, useState } from "react";
import { translateError, t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import { api, errorMessage, type GitLocalView } from "../lib/tauri";
import { IconClose } from "./icons";

interface Props {
  /** Repository work tree whose local state this dialog edits. */
  root: string;
  /** The folder name, for the title. */
  name: string;
  onClose: () => void;
  /** A local ignore or assume bit changed; the caller refreshes the panels and counts. */
  onChanged: () => void;
  /** Open a path in the editor. The exclude file is created first by the backend. */
  onOpenPath: (path: string) => void;
  onError: (message: string) => void;
}

/**
 * The one place where the machine-local git state can be undone.
 *
 * Both settings are invisible to the repository's history and to other clones, so there is no
 * `git log` row or file to find them in later. A local ignore can also be an ancestor directory
 * entry, and an assumed file disappears from the changed list entirely; without a list of both,
 * each would be a one-way door.
 */
export default function GitLocalSettingsDialog({
  root,
  name,
  onClose,
  onChanged,
  onOpenPath,
  onError,
}: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  const [view, setView] = useState<GitLocalView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setView(await api.gitLocalView(root));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void load();
  }, [load]);

  // Escape leaves; a click on the overlay does not, the same as the other question-sized dialogs.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const act = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      await load();
      onChanged();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const openExclude = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const path = await api.gitExcludeOpen(root);
      onOpenPath(path);
      onClose();
    } catch (e) {
      onError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal local-git" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          <span className="modal-title-text">
            {t("git.local.settings")} — {name}
          </span>
          <span className="modal-title-actions">
            <button
              className="btn small icon-btn"
              onClick={onClose}
              title={t("tab.close")}
              aria-label={t("tab.close")}
            >
              <IconClose size={14} />
            </button>
          </span>
        </h3>
        <p className="muted local-git-intro">{t("git.local.intro")}</p>

        {loading ? (
          <p className="muted">{t("git.loading")}</p>
        ) : error ? (
          <div className="local-git-error">
            <p className="modal-error">{translateError(error)}</p>
            <button className="btn small" onClick={() => void load()}>
              {t("git.local.retry")}
            </button>
          </div>
        ) : view ? (
          <>
            <section className="local-git-section">
              <div className="local-git-head">
                <h4>{t("git.local.ignoresTitle")}</h4>
                <button className="btn small" disabled={busy} onClick={() => void openExclude()}>
                  {t("git.local.openExclude")}
                </button>
              </div>
              {view.ignores.length === 0 ? (
                <p className="muted">{t("git.local.ignoresEmpty")}</p>
              ) : (
                <ul className="local-git-list">
                  {view.ignores.map((pattern) => (
                    <li className="local-git-row" key={pattern}>
                      <span className="local-git-path" title={pattern}>
                        {pattern}
                      </span>
                      <button
                        className="btn small"
                        disabled={busy}
                        onClick={() => void act(() => api.gitLocalUnignore(root, pattern))}
                      >
                        {t("git.local.remove")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {!view.excludeExists && (
                <p className="muted local-git-note">{t("git.local.excludeMissing")}</p>
              )}
            </section>

            <section className="local-git-section">
              <div className="local-git-head">
                <h4>{t("git.local.assumedTitle")}</h4>
                {view.assumed.length > 0 && (
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() => void act(() => api.gitAssumeUnchanged(root, [], false))}
                  >
                    {t("git.local.unassumeAll")}
                  </button>
                )}
              </div>
              {view.assumed.length === 0 ? (
                <p className="muted">{t("git.local.assumedEmpty")}</p>
              ) : (
                <ul className="local-git-list">
                  {view.assumed.map((file) => (
                    <li className="local-git-row" key={file.path}>
                      <span className="local-git-path" title={file.abs}>
                        {file.path}
                      </span>
                      <button
                        className="btn small"
                        disabled={busy}
                        onClick={() =>
                          void act(() => api.gitAssumeUnchanged(root, [file.abs], false))
                        }
                      >
                        {t("git.local.unassume")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="local-git-warning">{t("git.local.assumeWarning")}</p>
            </section>

            {view.truncated && (
              <p className="muted local-git-note">{t("git.local.truncated")}</p>
            )}
            <p className="muted local-git-note">{t("git.local.commentsNote")}</p>
          </>
        ) : null}
      </div>
    </div>
  );
}
