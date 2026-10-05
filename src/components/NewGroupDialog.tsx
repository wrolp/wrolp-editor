import { useEffect, useRef, useState } from "react";
import { t } from "../lib/i18n";
import { useModalDrag } from "../hooks/useModalDrag";
import type { NameProblem } from "../hooks/useGroups";

interface Props {
  validate: (name: string) => NameProblem;
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

/**
 * A group is identified by the name the user gives it, so creating one asks for that name
 * instead of deriving it from a folder. Duplicate names are refused rather than suffixed:
 * two rows reading the same thing cannot be told apart in the switcher.
 */
export default function NewGroupDialog({ validate, onConfirm, onCancel }: Props) {
  const [value, setValue] = useState("");
  const [problem, setProblem] = useState<NameProblem>("ok");
  const inputRef = useRef<HTMLInputElement>(null);
  const drag = useModalDrag<HTMLDivElement>();

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
      <div className="modal" ref={drag.ref}>
        <h3 className="modal-title" {...drag.handleProps}>
          {t("grp.newTitle")}
        </h3>
        <input
          ref={inputRef}
          className="grp-input"
          value={value}
          placeholder={t("grp.renameHint")}
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
            {t(problem === "duplicate" ? "grp.nameDuplicate" : "grp.nameEmpty")}
          </p>
        )}
        <div className="modal-actions">
          <button className="btn primary" onClick={submit}>
            {t("grp.create")}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("grp.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
