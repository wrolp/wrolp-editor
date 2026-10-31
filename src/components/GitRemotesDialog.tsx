import { useEffect, useState } from "react";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import type { GitRemote } from "../lib/tauri";
import { IconClose } from "./icons";

interface Props {
  /** The folder name, for the title. */
  name: string;
  remotes: GitRemote[];
  /** Add a remote, or move an existing one to a new URL; resolves false when it was refused. */
  onSave: (name: string, url: string) => Promise<boolean>;
  onRemove: (name: string) => Promise<boolean>;
  onClose: () => void;
  onError: (message: string) => void;
}

/**
 * The remotes a repository fetches from and pushes to.
 *
 * A remote is a name for an address, and the address is the part people actually change — a
 * repository moved, a fork replaced, a typo in the first clone. Editing it here writes the git
 * config; nothing is fetched or pushed from this dialog.
 */
export default function GitRemotesDialog({
  name,
  remotes,
  onSave,
  onRemove,
  onClose,
  onError,
}: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  /** The remote whose URL is in the box, or null. */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  /** The remote a second click would remove. */
  const [confirming, setConfirming] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [busy, setBusy] = useState(false);

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

  // A remote removed elsewhere (another window, `git remote remove`) must not leave its edit box
  // pointing at a name that no longer exists.
  useEffect(() => {
    if (editing && !remotes.some((item) => item.name === editing)) {
      setEditing(null);
      setDraft("");
    }
    if (confirming && !remotes.some((item) => item.name === confirming)) setConfirming(null);
  }, [remotes, editing, confirming]);

  const save = async (remoteName: string, url: string) => {
    if (busy) return;
    if (!url.trim()) {
      onError(t("git.remotes.urlRequired"));
      return;
    }
    setBusy(true);
    try {
      if (await onSave(remoteName, url)) {
        setEditing(null);
        setDraft("");
        if (remoteName === newName.trim()) {
          setNewName("");
          setNewUrl("");
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (remoteName: string) => {
    if (busy) return;
    setBusy(true);
    try {
      if (await onRemove(remoteName)) setConfirming(null);
    } finally {
      setBusy(false);
    }
  };

  const add = async () => {
    const name = newName.trim();
    if (!name || !newUrl.trim()) {
      onError(t("git.remotes.bothRequired"));
      return;
    }
    await save(name, newUrl);
  };

  const existing = remotes.some((item) => item.name === newName.trim());

  return (
    <div className="modal-overlay">
      <div className="modal remotes" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          <span className="modal-title-text">
            {t("git.remotes.title")} — {name}
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
        <p className="muted local-git-intro">{t("git.remotes.intro")}</p>

        {remotes.length === 0 ? (
          <p className="muted">{t("git.remotes.empty")}</p>
        ) : (
          <ul className="remote-list">
            {remotes.map((item) => (
              <li className="remote-item" key={item.name}>
                <div className="remote-row">
                  <span className="remote-name">{item.name}</span>
                  <span className="remote-url" title={item.url}>
                    {item.url}
                  </span>
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() => {
                      if (editing === item.name) {
                        setEditing(null);
                        return;
                      }
                      setEditing(item.name);
                      setDraft(item.url);
                      setConfirming(null);
                    }}
                  >
                    {editing === item.name ? t("close.cancel") : t("git.remotes.edit")}
                  </button>
                  <button
                    className="btn small"
                    disabled={busy}
                    onClick={() => {
                      if (confirming === item.name) void remove(item.name);
                      else {
                        setConfirming(item.name);
                        setEditing(null);
                      }
                    }}
                  >
                    {confirming === item.name
                      ? t("git.remotes.confirm")
                      : t("git.remotes.remove")}
                  </button>
                </div>
                {editing === item.name && (
                  <div className="remote-edit">
                    <input
                      className="settings-text"
                      type="text"
                      spellCheck={false}
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void save(item.name, draft);
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          setEditing(null);
                        }
                      }}
                    />
                    <button
                      className="btn small primary"
                      disabled={busy}
                      onClick={() => void save(item.name, draft)}
                    >
                      {t("git.remotes.save")}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}

        <section className="remote-add">
          <h4>{t("git.remotes.addTitle")}</h4>
          <div className="remote-add-row">
            <input
              className="settings-text remote-add-name"
              type="text"
              spellCheck={false}
              placeholder={t("git.remotes.namePlaceholder")}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
            />
            <input
              className="settings-text"
              type="text"
              spellCheck={false}
              placeholder={t("git.remotes.urlPlaceholder")}
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void add();
              }}
            />
            <button
              className="btn small primary"
              disabled={busy || !newName.trim() || !newUrl.trim()}
              onClick={() => void add()}
            >
              {existing ? t("git.remotes.update") : t("git.remotes.add")}
            </button>
          </div>
          <p className="muted local-git-note">{t("git.remotes.urlNote")}</p>
        </section>
      </div>
    </div>
  );
}
