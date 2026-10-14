import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import SettingCheck from "./SettingCheck";

interface Props {
  /** File name shown in the title, so a queue of several asks says which one is being answered. */
  name: string;
  /** Asks waiting including this one; more than one reads as a queue rather than a surprise. */
  count: number;
  /** Why the last attempt failed, already localized. The ask stays open so it can be retried. */
  error: string | null;
  /** True while the password is being checked, which is long enough to notice at debug cost. */
  busy: boolean;
  onSubmit: (password: string, remember: boolean) => void;
  onCancel: () => void;
}

/**
 * Ask for the password of an encrypted file.
 *
 * The password never leaves this dialog except as an argument to the unlock call: it is not
 * lifted into app state, not written to a draft, and not kept after the attempt. An empty
 * password is refused here rather than sent, because the backend rejects it too and a round
 * trip through Argon2 to be told the field is blank wastes a second of the user's time.
 */
export default function PasswordDialog({ name, count, error, busy, onSubmit, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  const [remember, setRemember] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useModalDrag<HTMLDivElement>();

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    if (busy || value === "") return;
    onSubmit(value, remember);
  };

  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("enc.unlockTitle", { name })}
        </h3>
        <p className="muted">{t("enc.unlockHint")}</p>
        <div className="pwd-field">
          <input
            ref={inputRef}
            className="grp-input"
            type={shown ? "text" : "password"}
            value={value}
            disabled={busy}
            aria-label={t("enc.password")}
            // A browser that offers to fill this would be saving the password of an
            // encrypted document into a store the user did not ask for.
            autoComplete="off"
            placeholder={t("enc.password")}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") submit();
              if (e.key === "Escape" && !busy) onCancel();
            }}
          />
          <button className="btn" disabled={busy} onClick={() => setShown((v) => !v)}>
            {t(shown ? "enc.hide" : "enc.show")}
          </button>
        </div>
        {error && <p className="modal-error">{error}</p>}
        <SettingCheck
          label={t("enc.remember")}
          checked={remember}
          disabled={busy}
          hint={t("enc.rememberHint")}
          onChange={setRemember}
        />
        {count > 1 && <p className="muted">{t("enc.remaining", { n: String(count - 1) })}</p>}
        <div className="modal-actions">
          <button className="btn primary" disabled={busy || value === ""} onClick={submit}>
            {t("enc.unlock")}
          </button>
          <button className="btn" disabled={busy} onClick={onCancel}>
            {t("enc.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
