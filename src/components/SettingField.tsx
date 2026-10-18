import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";

interface Props {
  label: string;
  /**
   * The control or controls, each a `<select>` or an `<input>`. Cloned to add their
   * accessible name. The prop type is what `cloneElement` will accept, so it has to be
   * spelled out rather than left as the default `unknown`.
   */
  children: ReactNode;
}

/**
 * A settings row for a dropdown or a numeric input, where only the control is clickable.
 *
 * Deliberately a `<div>` and not a `<label>`, for the reason `SettingCheck` gives: a label
 * forwards its click to the control, so the title and the empty space beside it would open
 * the dropdown or focus the box — a hotspot several times wider than the control the
 * pointer was aimed at, with nothing on screen showing that. The accessible name is wired
 * with `aria-labelledby` instead, so the control keeps its name for screen readers without
 * the text becoming a target. An `htmlFor` label would bring the click back, which is the
 * one thing this component exists to avoid.
 */
export default function SettingField({ label, children }: Props) {
  const id = useId();
  const labelId = `${id}-label`;
  return (
    <div className="setting-row">
      <span className="setting-title" id={labelId}>
        {label}
      </span>
      {Children.map(children, (child) =>
        isValidElement(child)
          ? cloneElement(child as ReactElement<{ "aria-labelledby"?: string }>, {
              "aria-labelledby": labelId,
            })
          : child
      )}
    </div>
  );
}
