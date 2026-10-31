import { useEffect, useRef } from "react";
import { t } from "../lib/i18n";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import type { GitLocalPathState } from "../lib/tauri";
import { IconEye, IconEyeOff, IconFile, IconSettings } from "./icons";

interface Props {
  /** The path's local state, or null while the probe is still in flight. */
  state: GitLocalPathState | null;
  x: number;
  y: number;
  onClose: () => void;
  onIgnore: () => void;
  /** Write the pattern to the tracked `.gitignore` rather than this machine's exclude file. */
  onIgnoreRepo: () => void;
  onAssume: (enabled: boolean) => void;
  onOpenSettings: () => void;
}

/**
 * The local-only half of a changed row's menu.
 *
 * Staging and discarding already have buttons on the row; what cannot live there is the state
 * that has no visible row at all once it takes effect. The probe may still be running when the
 * menu opens, which is why the list can grow a moment later rather than delaying the menu.
 */
export default function GitRowMenu({
  state,
  x,
  y,
  onClose,
  onIgnore,
  onIgnoreRepo,
  onAssume,
  onOpenSettings,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const at = useMenuPlacement({ x, y }, ref);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("blur", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const action = state
    ? state.tracked
      ? state.assumed
        ? "unassume"
        : "assume"
      : state.ignored
        ? null
        : "ignore"
    : null;

  return (
    <div
      className="ctx-menu"
      ref={ref}
      style={{ display: "block", left: at.left, top: at.top }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {action === "ignore" && (
        <>
          <div className="ctx-item" onClick={onIgnore}>
            <span className="ctx-icon">
              <IconEyeOff size={14} />
            </span>
            {t("side.menuLocalIgnore")}
          </div>
          {/* The same pattern, written to the file the repository commits instead of this
              machine's own exclude — the difference is who the rule reaches. */}
          <div className="ctx-item" onClick={onIgnoreRepo}>
            <span className="ctx-icon">
              <IconFile size={14} />
            </span>
            {t("side.menuGitignore")}
          </div>
        </>
      )}
      {action === "assume" && (
        <div className="ctx-item" onClick={() => onAssume(true)}>
          <span className="ctx-icon">
            <IconEyeOff size={14} />
          </span>
          {t("side.menuAssume")}
        </div>
      )}
      {action === "unassume" && (
        <div className="ctx-item" onClick={() => onAssume(false)}>
          <span className="ctx-icon">
            <IconEye size={14} />
          </span>
          {t("side.menuUnassume")}
        </div>
      )}
      {action && <div className="ws-sep" />}
      <div className="ctx-item" onClick={onOpenSettings}>
        <span className="ctx-icon">
          <IconSettings size={14} />
        </span>
        {t("side.menuLocalSettings")}
      </div>
    </div>
  );
}
