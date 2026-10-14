import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import SettingCheck from "./SettingCheck";

/**
 * What the dialog is asking for.
 *
 * `unlock` and `remove` take one password and check it against a file. `create` and `change`
 * invent a password, which is the difference that shapes the rest: a wrong unlock fails and can
 * be retried, while a weak or mistyped new one is written into the file and stays there.
 */
export type PasswordMode = "unlock" | "create" | "change" | "remove";

interface Props {
  mode: PasswordMode;
  /** File name shown in the title, so a queue of several asks says which one is being answered. */
  name: string;
  /** Asks waiting including this one; more than one reads as a queue rather than a surprise. */
  count: number;
  /** Why the last attempt failed, already localized. The ask stays open so it can be retried. */
  error: string | null;
  /** True while the password is being checked, which is long enough to notice at debug cost. */
  busy: boolean;
  /** `previous` is the current password, and only `change` mode has one to send. */
  onSubmit: (password: string, remember: boolean, previous?: string) => void;
  onCancel: () => void;
}

/** Shortest password a new container will accept. */
const MIN_PASSWORD = 8;
/** Below this the dialog says so, but does not stop the user: a memorable password that is a
 * little short beats an unmemorable one that gets written down next to the keyboard. */
const WARN_PASSWORD = 12;

interface FieldProps {
  label: string;
  value: string;
  shown: boolean;
  busy: boolean;
  autoFocus?: boolean;
  onValue: (value: string) => void;
  onShown: (shown: boolean) => void;
  onEnter: () => void;
  onEscape: () => void;
}

/**
 * One masked field with its own reveal toggle.
 *
 * Local to this dialog rather than shared: the point of a second field is that it holds a
 * different password, so the two toggles have to be independent, and nothing else in the app
 * asks for one.
 */
function PasswordField({
  label,
  value,
  shown,
  busy,
  autoFocus,
  onValue,
  onShown,
  onEnter,
  onEscape,
}: FieldProps) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) ref.current?.focus();
  }, [autoFocus]);
  return (
    <div className="pwd-field">
      <input
        ref={ref}
        className="grp-input"
        type={shown ? "text" : "password"}
        value={value}
        disabled={busy}
        aria-label={label}
        // A browser that offers to fill this would be saving the password of an encrypted
        // document into a store the user did not ask for.
        autoComplete="off"
        placeholder={label}
        onChange={(e) => onValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onEnter();
          if (e.key === "Escape" && !busy) onEscape();
        }}
      />
      <button className="btn" disabled={busy} onClick={() => onShown(!shown)}>
        {t(shown ? "enc.hide" : "enc.show")}
      </button>
    </div>
  );
}

/**
 * Ask for the password of an encrypted file, or for the one a file is about to get.
 *
 * The password never leaves this dialog except as an argument to the call that uses it: it is
 * not lifted into app state, not written to a draft, and not kept after the attempt. An empty
 * password is refused here rather than sent, because the backend rejects it too and a round trip
 * through Argon2 to be told the field is blank wastes a second of the user's time.
 */
export default function PasswordDialog({
  mode,
  name,
  count,
  error,
  busy,
  onSubmit,
  onCancel,
}: Props) {
  const [value, setValue] = useState("");
  const [shown, setShown] = useState(false);
  /** The repeat of a new password, in create mode. */
  const [confirm, setConfirm] = useState("");
  const [confirmShown, setConfirmShown] = useState(false);
  /** The password the file has now, in change mode. */
  const [previous, setPrevious] = useState("");
  const [previousShown, setPreviousShown] = useState(false);
  const [remember, setRemember] = useState(false);
  const drag = useModalDrag<HTMLDivElement>();

  const inventing = mode === "create" || mode === "change";
  const tooShort = inventing && value.length < MIN_PASSWORD;
  const worthWarning = inventing && !tooShort && value.length < WARN_PASSWORD;
  // Only once something has been typed in the second field: an empty repeat is the dialog
  // waiting, not the user getting it wrong, and saying "these differ" at that point is noise.
  const mismatched = mode === "create" && confirm !== "" && confirm !== value;

  const ready =
    value !== "" &&
    !tooShort &&
    (mode !== "create" || confirm === value) &&
    (mode !== "change" || previous !== "");

  const submit = () => {
    if (busy || !ready) return;
    onSubmit(value, remember, mode === "change" ? previous : undefined);
  };

  const title =
    mode === "create"
      ? t("enc.createTitle", { name })
      : mode === "change"
        ? t("enc.changeTitle", { name })
        : mode === "remove"
          ? t("enc.removeTitle", { name })
          : t("enc.unlockTitle", { name });
  const action =
    mode === "create"
      ? t("enc.create")
      : mode === "change"
        ? t("enc.change")
        : mode === "remove"
          ? t("enc.remove")
          : t("enc.unlock");

  return (
    <div className="modal-overlay">
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {title}
        </h3>
        <p className="muted">
          {mode === "create"
            ? t("enc.createHint")
            : mode === "change"
              ? t("enc.changeHint")
              : mode === "remove"
                ? t("enc.removeHint")
                : t("enc.unlockHint")}
        </p>
        {mode === "change" && (
          <PasswordField
            label={t("enc.oldPassword")}
            value={previous}
            shown={previousShown}
            busy={busy}
            autoFocus
            onValue={setPrevious}
            onShown={setPreviousShown}
            onEnter={submit}
            onEscape={onCancel}
          />
        )}
        <PasswordField
          label={t("enc.password")}
          value={value}
          shown={shown}
          busy={busy}
          autoFocus={mode !== "change"}
          onValue={setValue}
          onShown={setShown}
          onEnter={submit}
          onEscape={onCancel}
        />
        {mode === "create" && (
          <PasswordField
            label={t("enc.confirm")}
            value={confirm}
            shown={confirmShown}
            busy={busy}
            onValue={setConfirm}
            onShown={setConfirmShown}
            onEnter={submit}
            onEscape={onCancel}
          />
        )}
        {/* A new password is the one thing here with a lasting consequence, so the reasons it
            might be refused are said out loud rather than left to a disabled button. */}
        {tooShort && (
          <p className="pwd-strength is-block">
            {t("enc.strengthShort", { n: String(MIN_PASSWORD) })}
          </p>
        )}
        {worthWarning && <p className="pwd-strength is-warn">{t("enc.strengthWeak", { n: String(WARN_PASSWORD) })}</p>}
        {mismatched && <p className="pwd-strength is-block">{t("enc.mismatch")}</p>}
        {error && <p className="modal-error">{error}</p>}
        {(mode === "unlock" || mode === "create") && (
          <SettingCheck
            label={t("enc.remember")}
            checked={remember}
            disabled={busy}
            hint={t("enc.rememberHint")}
            onChange={setRemember}
          />
        )}
        {mode === "unlock" && count > 1 && (
          <p className="muted">{t("enc.remaining", { n: String(count - 1) })}</p>
        )}
        <div className="modal-actions">
          <button className="btn primary" disabled={busy || !ready} onClick={submit}>
            {action}
          </button>
          <button className="btn" disabled={busy} onClick={onCancel}>
            {t("enc.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
