import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";

export type NameProblem = "ok" | "empty" | "duplicate";

interface Props {
  validate: (name: string) => NameProblem;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/**
 * A workspace is identified by the name the user gives it, so creating one asks for that
 * name instead of deriving it from a folder. Duplicate names are refused rather than
 * suffixed: two rows reading the same thing cannot be told apart in the switcher.
 */
export default function NewWorkspaceDialog({ validate, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<NameProblem>("ok");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const submit = () => {
    const check = validate(value);
    setProblem(check);
    if (check === "ok") onConfirm(value.trim());
  };

  return (
    <div className="modal-overlay">
      <div className="modal">
        <h3>{t("ws.newTitle")}</h3>
        <input
          ref={inputRef}
          className="ws-input"
          value={value}
          placeholder={t("ws.renameHint")}
          onChange={(e) => {
            setValue(e.target.value);
            if (problem !== "ok") setProblem("ok");
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        {problem !== "ok" && (
          <p className="modal-error">
            {t(problem === "duplicate" ? "ws.nameDuplicate" : "ws.nameEmpty")}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn primary" onClick={submit}>
            {t("ws.create")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("ws.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
