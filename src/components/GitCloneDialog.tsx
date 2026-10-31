import { useEffect, useRef, useState } from "react";
import { t, translateError } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import { api, errorMessage, type GitProgress } from "../lib/tauri";
import type { GitAuthAsk } from "../hooks/useGit";
import GitAuthDialog from "./GitAuthDialog";
import { IconClose } from "./icons";

interface Props {
  /** The folder the clone is created in — the group's own directory. */
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
  const [name, setName] = useState("");
  /** Typing a name stops the URL from naming the folder; clearing it hands the job back. */
  const [namedByHand, setNamedByHand] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<GitProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<GitAuthAsk | null>(null);
  /** The operation in flight, so the Cancel button can reach the transfer callback. */
  const opIdRef = useRef<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  const suggested = cloneNameFromUrl(url);
  const folder = namedByHand ? name : suggested;
  const target = folder ? `${parent.replace(/[\\/]+$/, "")}/${folder}` : parent;

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
    const opId = crypto.randomUUID();
    opIdRef.current = opId;
    setBusy(true);
    setError(null);
    setProgress({ phase: "starting", received: 0, total: 0, bytes: 0, percent: 0, text: null });
    try {
      const path = await api.gitClone(url.trim(), parent, folder.trim(), opId, setProgress);
      onCloned(path);
    } catch (e) {
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
      opIdRef.current = null;
      setBusy(false);
      setProgress(null);
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
              onClick={onClose}
              disabled={busy}
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
        <p className="muted clone-target" title={target}>
          {t("git.cloneTarget", { path: target })}
        </p>

        {progress && (
          <div className="clone-progress" role="status">
            <div className="clone-progress-text">{progressLabel(progress)}</div>
            <div className="clone-progress-row">
              <div className="clone-progress-bar">
                <span style={{ width: `${progress.percent}%` }} />
              </div>
              <span className="clone-progress-percent">{progress.percent}%</span>
              <button
                className="btn small"
                onClick={() => {
                  if (opIdRef.current) void api.gitCancel(opIdRef.current);
                }}
              >
                {t("git.cancel")}
              </button>
            </div>
          </div>
        )}

        {error && <p className="modal-error">{translateError(error)}</p>}

        <div className="modal-actions">
          <button className="btn" onClick={onClose} disabled={busy}>
            {t("close.cancel")}
          </button>
          <button className="btn primary" onClick={() => void start()} disabled={busy || !url.trim()}>
            {busy ? t("git.loading") : t("git.cloneStart")}
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
          />
        )}
      </div>
    </div>
  );
}
