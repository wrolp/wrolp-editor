import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { GitAuthAsk } from "../hooks/useGit";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";

interface Props {
  ask: GitAuthAsk;
  /** A username already stored for this host, when there is one. */
  username?: string;
  onClose: () => void;
  onSaveHttps: (host: string, username: string, secret: string) => Promise<boolean>;
  onSaveSsh: (
    host: string,
    keyPath: string,
    passphrase: string | null,
    remember: boolean
  ) => Promise<boolean>;
  onTrustHost: (host: string, fingerprint: string) => Promise<boolean>;
}

/**
 * One dialog for the three things a remote can ask for: an HTTPS password, an SSH key, or
 * permission to trust a host key. The secret field is masked by default and has its own reveal
 * button — a token pasted into the wrong place is a token on screen.
 */
export default function GitAuthDialog({
  ask,
  username,
  onClose,
  onSaveHttps,
  onSaveSsh,
  onTrustHost,
}: Props) {
  const [name, setName] = useState(username ?? "");
  const [secret, setSecret] = useState("");
  const [reveal, setReveal] = useState(false);
  const [keyPath, setKeyPath] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const drag = useModalDrag<HTMLDivElement>();

  const pickKey = async () => {
    const picked = await open({ multiple: false, directory: false });
    if (typeof picked === "string") setKeyPath(picked);
  };

  const submit = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (ask.kind === "host") {
        await onTrustHost(ask.host, ask.fingerprint);
      } else if (ask.kind === "ssh") {
        await onSaveSsh(ask.host, keyPath.trim(), passphrase || null, remember);
      } else {
        await onSaveHttps(ask.host, name.trim(), secret);
      }
    } finally {
      setBusy(false);
    }
  };

  const title =
    ask.kind === "host"
      ? t("git.authHostTitle")
      : ask.kind === "ssh"
        ? t("git.authSshTitle", { host: ask.host })
        : t("git.authHttpsTitle", { host: ask.host });

  const canSubmit =
    ask.kind === "host"
      ? true
      : ask.kind === "ssh"
        ? keyPath.trim().length > 0
        : name.trim().length > 0 && secret.length > 0;

  return (
    <div className="modal-overlay">
      <div className="modal git-auth-modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {title}
        </h3>

        {ask.kind === "https" && (
          <>
            <p className="git-auth-hint">
              {ask.failed ? t("git.authFailed") : t("git.authHttpsHint")}
            </p>
            <label className="git-auth-field">
              <span>{t("git.authUsername")}</span>
              <input
                className="grp-input"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="git-auth-field">
              <span>{t("git.authToken")}</span>
              <span className="git-auth-secret">
                <input
                  className="grp-input"
                  type={reveal ? "text" : "password"}
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) void submit();
                    if (e.key === "Escape") onClose();
                  }}
                />
                <button className="git-small-btn" onClick={() => setReveal((on) => !on)}>
                  {reveal ? t("git.authHide") : t("git.authReveal")}
                </button>
              </span>
            </label>
            <p className="git-auth-hint">{t("git.authStored")}</p>
          </>
        )}

        {ask.kind === "ssh" && (
          <>
            <p className="git-auth-hint">
              {ask.failed ? t("git.authFailed") : t("git.authSshHint")}
            </p>
            <label className="git-auth-field">
              <span>{t("git.authKeyPath")}</span>
              <span className="git-auth-secret">
                <input
                  className="grp-input"
                  value={keyPath}
                  placeholder={t("git.authKeyPlaceholder")}
                  autoFocus
                  onChange={(e) => setKeyPath(e.target.value)}
                />
                <button className="git-small-btn" onClick={() => void pickKey()}>
                  {t("git.authBrowse")}
                </button>
              </span>
            </label>
            <label className="git-auth-field">
              <span>{t("git.authPassphrase")}</span>
              <span className="git-auth-secret">
                <input
                  className="grp-input"
                  type={reveal ? "text" : "password"}
                  value={passphrase}
                  onChange={(e) => setPassphrase(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmit) void submit();
                    if (e.key === "Escape") onClose();
                  }}
                />
                <button className="git-small-btn" onClick={() => setReveal((on) => !on)}>
                  {reveal ? t("git.authHide") : t("git.authReveal")}
                </button>
              </span>
            </label>
            <label className="git-auth-check">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              <span>{t("git.authRemember")}</span>
            </label>
          </>
        )}

        {ask.kind === "host" && (
          <>
            <p className="git-auth-hint">
              {ask.changed ? t("git.authHostChanged") : t("git.authHostUnknown")}
            </p>
            <div className="git-auth-field">
              <span>{t("git.authHost")}</span>
              <code className="git-fingerprint">{ask.host}</code>
            </div>
            <div className="git-auth-field">
              <span>{t("git.authFingerprint")}</span>
              <code className="git-fingerprint">{ask.fingerprint}</code>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button className="btn primary" disabled={!canSubmit || busy} onClick={() => void submit()}>
            {ask.kind === "host" ? t("git.authTrust") : t("git.authSave")}
          </button>
          <button className="btn" onClick={onClose} disabled={busy}>
            {t("git.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
