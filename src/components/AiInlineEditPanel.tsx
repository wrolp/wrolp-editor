import { useEffect, useRef } from "react";
import type { AiInlineEditController } from "../hooks/useInlineEdit";
import { t } from "../lib/i18n";

/**
 * The panel inside the editor's content widget: the instruction box first, then the streamed
 * replacement. It never renders the document itself; the editor's red mark does that.
 */
export default function AiInlineEditPanel({ edit }: { edit: AiInlineEditController }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (edit.phase === "input") {
      // Monaco takes the keyboard back when the key that opened the widget finishes, so the
      // field asks again for a few frames rather than losing to it once.
      let cancelled = false;
      let tries = 0;
      const focus = () => {
        if (cancelled) return;
        const field = inputRef.current;
        if (!field) return;
        field.focus();
        if (document.activeElement !== field && tries < 12) {
          tries += 1;
          window.setTimeout(focus, 25);
        }
      };
      const timer = window.setTimeout(focus, 0);
      return () => {
        cancelled = true;
        window.clearTimeout(timer);
      };
    }
    if (edit.phase !== "idle") rootRef.current?.focus();
  }, [edit.phase]);

  useEffect(() => {
    edit.layout();
  }, [edit.phase, edit.preview, edit.instruction, edit.layout]);

  const hint =
    edit.phase === "input"
      ? t("ai.editSubmitHint")
      : edit.phase === "generating"
        ? t("ai.editStopHint")
        : edit.phase === "preview"
          ? t("ai.editApplyHint")
          : "";

  return (
    <div className="ai-edit-widget" ref={rootRef} tabIndex={-1}>
      <div className="ai-edit-head">
        <span className="ai-edit-title">{t("ai.editTitle")}</span>
        {hint && <span className="ai-edit-hint">{hint}</span>}
      </div>

      {edit.phase === "input" && (
        <>
          <textarea
            ref={inputRef}
            className="ai-edit-input"
            rows={2}
            value={edit.instruction}
            placeholder={t("ai.editPlaceholder")}
            onChange={(event) => edit.setInstruction(event.target.value)}
            onKeyDown={(event) => {
              // Chinese input uses Enter to pick a candidate.
              if (event.nativeEvent.isComposing) return;
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                edit.submit();
              }
            }}
          />
          <div className="ai-edit-actions">
            <button className="btn small" onClick={edit.cancel}>
              {t("ai.editCancel")}
            </button>
            <button
              className="btn primary small"
              onClick={edit.submit}
              disabled={!edit.instruction.trim()}
            >
              {t("ai.editGenerate")}
            </button>
          </div>
        </>
      )}

      {(edit.phase === "generating" || edit.phase === "preview") && (
        <>
          <pre className={`ai-edit-preview${edit.preview ? "" : " is-empty"}`}>
            {edit.preview ||
              t(edit.phase === "generating" ? "ai.editGenerating" : "ai.editEmpty")}
          </pre>
          <div className="ai-edit-actions">
            {edit.phase === "preview" ? (
              <>
                <button className="btn small" onClick={edit.cancel}>
                  {t("ai.editDiscard")}
                </button>
                <button className="btn primary small" onClick={edit.apply}>
                  {t("ai.editApply")}
                </button>
              </>
            ) : (
              <button className="btn small" onClick={edit.cancel}>
                {t("ai.editCancel")}
              </button>
            )}
          </div>
        </>
      )}

      {edit.phase === "error" && (
        <>
          <div className="ai-edit-error">{edit.error}</div>
          <div className="ai-edit-actions">
            <button className="btn small" onClick={edit.cancel}>
              {t("ai.editClose")}
            </button>
            <button className="btn primary small" onClick={edit.retry}>
              {t("ai.editRetry")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
