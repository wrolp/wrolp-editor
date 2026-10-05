import { useId, type ReactNode } from "react";

interface Props {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  description?: ReactNode;
  indeterminate?: boolean;
  hint?: ReactNode;
}

/**
 * A checkbox row where only the box itself toggles.
 *
 * Deliberately a <div> and not a <label>: a label forwards its click to the control, so
 * the text would become a second, invisible toggle. The accessible name is wired with
 * aria-labelledby instead, which keeps the screen-reader behaviour without the click.
 * Clicking a label to toggle is right for a form; in a settings list it reads as a
 * mis-click, because the text is not styled like a button.
 */
export default function SettingCheck({
  label,
  checked,
  disabled,
  onChange,
  description,
  indeterminate,
  hint,
}: Props) {
  const id = useId();
  return (
    <div className="setting-row setting-check">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-labelledby={`${id}-label`}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate && !disabled;
        }}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span id={`${id}-label`}>{label}</span>
      {hint && <span className="muted">{hint}</span>}
      {description && <div className="setting-desc">{description}</div>}
    </div>
  );
}
