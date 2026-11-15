import { useEffect, useRef, useState } from "react";
import { t, translateError } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import { api, errorMessage, pickFolder, type GitProgress } from "../lib/tauri";
import type { GitAuthAsk } from "../hooks/useGit";
import GitAuthDialog from "./GitAuthDialog";
import { IconClose } from "./icons";

interface Props {
  /** The folder the dialog starts in — the group's own directory. The reader can change it. */
  parent: string;
  onClose: () => void;
  /** The new work tree, once the transfer finished. */
  onCloned: (path: string) => void;
  onError: (message: string) => void;
}

/** The folder name a URL suggests: its last path segment, without the `.git` suffix. */
export function cloneNameFromUrl(url: string): string {
  const cleaned = url.trim().replace(/\/+$/, "");
  const last = cleaned.split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/** The host a remote URL talks to, for the credential dialog. */
function hostOf(url: string): string {
  const value = url.trim();
  const scheme = value.indexOf("://");
  if (scheme >= 0) {
    const authority = value.slice(scheme + 3).split("/")[0];
    return authority.split("@").pop() ?? "";
  }
  const at = value.lastIndexOf("@");
  const rest = at >= 0 ? value.slice(at + 1) : value;
  return rest.split(":")[0];
}

function isSshUrl(url: string): boolean {
  const value = url.trim().toLowerCase();
  return value.startsWith("ssh://") || (!value.includes("://") && value.includes("@"));
}

/**
 * The credential prompt a failed clone is asking for, if any. The same codes fetch and push
 * raise, turned into the one dialog that knows how to answer them.
 */
function authPrompt(raw: string, url: string): GitAuthAsk | null {
  const kind = isSshUrl(url) ? "ssh" : "https";
  if (raw.startsWith("git_auth_required:")) {
    return { kind, host: raw.slice("git_auth_required:".length), failed: false };
  }
  if (raw === "git_auth_failed") {
    return { kind, host: hostOf(url), failed: true };
  }
  if (raw.startsWith("git_host_untrusted:") || raw.startsWith("git_host_changed:")) {
    const [host, fingerprint] = raw.slice(raw.indexOf(":") + 1).split("|");
    if (host && fingerprint) {
      return {
        kind: "host",
        host,
        fingerprint,
        changed: raw.startsWith("git_host_changed:"),
      };
    }
  }
  if (raw.startsWith("git_cert_untrusted:") || raw.startsWith("git_cert_changed:")) {
    const [host, fingerprint] = raw.slice(raw.indexOf(":") + 1).split("|");
    if (host && fingerprint) {
      return {
        kind: "cert",
        host,
        fingerprint,
        changed: raw.startsWith("git_cert_changed:"),
      };
    }
  }
  return null;
}

function progressLabel(progress: GitProgress): string {
  switch (progress.phase) {
    case "starting":
      return t("git.progressStarting");
    case "receiving":
      return progress.total > 0
        ? t("git.progressReceiving", { received: progress.received, total: progress.total })
        : t("git.progressReceivingUnknown", { bytes: progress.bytes });
    case "message":
      return progress.text ?? "";
    case "done":
      return t("git.progressDone");
    default:
      return "";
  }
}

/**
 * Clone into the folder a group points at.
 *
 * A folder with no repository of its own can be made one in two ways — `git init` for something
 * new, this for something that already exists on a server. The dialog owns the whole flow so the
 * panel does not have to: a URL, the folder to put it in, progress with a cancel, and the same
 * credential prompt a fetch raises when the server asks who is calling.
 */
export default function GitCloneDialog({ parent, onClose, onCloned, onError }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  const [url, setUrl] = useState("");
  /** The folder the clone is created in; starts at the group's own and may be changed. */
  const [parentDir, setParentDir] = useState(parent);
  const [name, setName] = useState("");
  /** Typing a name stops the URL from naming the folder; clearing it hands the job back. */
  const [namedByHand, setNamedByHand] = useState(false);
  const [busy, setBusy] = useState(false);
  /** The transfer has been asked to stop and the backend has not answered yet. */
  const [canceling, setCanceling] = useState(false);
  const [progress, setProgress] = useState<GitProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<GitAuthAsk | null>(null);
  /** The operation in flight, so the Cancel button can reach the transfer callback. */
  const opIdRef = useRef<string | null>(null);
  /** False once the dialog is gone, so a transfer that lands later opens nothing. */
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    []
  );

  /**
   * Close the dialog, asking a clone in flight to stop first.
   *
   * The window must not be held hostage by a transfer that has stopped reporting: a cancel is
   * only noticed when libgit2 next calls back, and a socket read can leave that call waiting.
   * Closing is the reader's answer even when the transfer is still on its way out.
   */
  const closeDialog = () => {
    if (busy && opIdRef.current) void api.gitCancel(opIdRef.current);
    onClose();
  };

  /** Ask the transfer to stop, and say so until the backend answers. */
  const requestCancel = () => {
    if (!opIdRef.current || canceling) return;
    setCanceling(true);
    void api.gitCancel(opIdRef.current);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (busy && opIdRef.current) void api.gitCancel(opIdRef.current);
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const suggested = cloneNameFromUrl(url);
  const folder = namedByHand ? name : suggested;
  const base = parentDir.trim();
  const target = !base ? "" : folder ? `${base.replace(/[\\/]+$/, "")}/${folder}` : base;

  /** Pick the folder by hand; the URL still names the folder created inside it. */
  const chooseParent = () => {
    pickFolder(base || parent)
      .then((picked) => {
        if (picked) setParentDir(picked);
      })
      .catch((e) => onError(errorMessage(e)));
  };

  const start = async () => {
    if (busy) return;
    if (!url.trim()) {
      setError(t("git.cloneUrlRequired"));
      return;
    }
    if (!folder.trim()) {
      setError(t("git.cloneNameRequired"));
      return;
    }
    if (!base) {
      setError(t("git.cloneDirRequired"));
      return;
    }
    const opId = crypto.randomUUID();
    opIdRef.current = opId;
    setBusy(true);
    setCanceling(false);
    setError(null);
    setProgress({ phase: "starting", received: 0, total: 0, bytes: 0, percent: 0, text: null });
    try {
      const path = await api.gitClone(url.trim(), base, folder.trim(), opId, setProgress);
      // The dialog may have been closed while the transfer was still running: it is not a
      // tab that should open by itself afterwards.
      if (!alive.current) return;
      onCloned(path);
    } catch (e) {
      if (!alive.current) return;
      const raw = typeof e === "string" ? e : errorMessage(e);
      // Cancelling is the user's own answer; an error line for it would only be noise.
      if (raw === "git_canceled") return;
      const prompt = authPrompt(raw, url);
      if (prompt) {
        setAsk(prompt);
        return;
      }
      setError(errorMessage(e));
    } finally {
      if (alive.current) {
        opIdRef.current = null;
        setBusy(false);
        setCanceling(false);
        setProgress(null);
      }
    }
  };

  return (
    <div className="modal-overlay">
      <div className="modal clone" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          <span className="modal-title-text">{t("git.clone")}</span>
          <span className="modal-title-actions">
            <button
              className="btn small icon-btn"
              onClick={closeDialog}
              title={t("tab.close")}
              aria-label={t("tab.close")}
            >
              <IconClose size={14} />
            </button>
          </span>
        </h3>
        <p className="muted clone-intro">{t("git.cloneIntro")}</p>

        <label className="clone-field">
          <span>{t("git.cloneUrl")}</span>
          <input
            className="settings-text"
            type="text"
            spellCheck={false}
            autoFocus
            placeholder={t("git.cloneUrlPlaceholder")}
            value={url}
            disabled={busy}
            onChange={(e) => {
              setUrl(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void start();
            }}
          />
        </label>
        <label className="clone-field">
          <span>{t("git.cloneDir")}</span>
          <div className="clone-dir-row">
            <input
              className="settings-text"
              type="text"
              spellCheck={false}
              value={parentDir}
              disabled={busy}
              onChange={(e) => {
                setParentDir(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") void start();
              }}
            />
            <button className="btn small" onClick={chooseParent} disabled={busy}>
              {t("git.cloneDirBrowse")}
            </button>
          </div>
        </label>
        <label className="clone-field">
          <span>{t("git.cloneName")}</span>
          <input
            className="settings-text"
            type="text"
            spellCheck={false}
            value={folder}
            disabled={busy}
            onChange={(e) => {
              setNamedByHand(true);
              setName(e.target.value);
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void start();
            }}
          />
        </label>
        {target && (
          <p className="muted clone-target" title={target}>
            {t("git.cloneTarget", { path: target })}
          </p>
        )}

        {progress && (
          <div className="clone-progress" role="status">
            <div className="clone-progress-text">{progressLabel(progress)}</div>
            <div className="clone-progress-row">
              <div className="clone-progress-bar">
                <span style={{ width: `${progress.percent}%` }} />
              </div>
              <span className="clone-progress-percent">{progress.percent}%</span>
              <button className="btn small" onClick={requestCancel} disabled={canceling}>
                {canceling ? t("git.canceling") : t("git.cancel")}
              </button>
            </div>
          </div>
        )}

        {error && <p className="modal-error">{translateError(error)}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={closeDialog}>
            {t("close.cancel")}
          </button>
          <button className="btn primary" onClick={() => void start()} disabled={busy || !url.trim()}>
            {busy ? t("git.cloning") : t("git.cloneStart")}
          </button>
        </div>

        {ask && (
          <GitAuthDialog
            ask={ask}
            onClose={() => setAsk(null)}
            onSaveHttps={async (host, username, secret) => {
              try {
                await api.gitSaveHttps(host, username, secret);
                setAsk(null);
                void start();
                return true;
              } catch (e) {
                onError(errorMessage(e));
                return false;
              }
            }}
            onSaveSsh={async (host, keyPath, passphrase, remember) => {
              try {
                await api.gitSaveSsh(host, keyPath, passphrase, remember);
                setAsk(null);
                void start();
                return true;
              } catch (e) {
                onError(errorMessage(e));
                return false;
              }
            }}
            onTrustHost={async (host, fingerprint) => {
              try {
                await api.gitTrustHost(host, fingerprint);
                setAsk(null);
                void start();
                return true;
              } catch (e) {
                onError(errorMessage(e));
                return false;
              }
            }}
            onTrustCert={async (host, fingerprint) => {
              try {
                await api.gitTrustCert(host, fingerprint);
                setAsk(null);
                void start();
                return true;
              } catch (e) {
                onError(errorMessage(e));
                return false;
              }
            }}
          />
        )}
      </div>
    </div>
  );
}
