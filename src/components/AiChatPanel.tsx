import { useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "dompurify";
import { marked } from "marked";
import type { AiChatController, AiToolCard } from "../hooks/useAiChat";
import { t, translateError } from "../lib/i18n";
import {
  copyText,
  openUrl,
  type AiContextScope,
  type AiSession,
  type AiStoredMessage,
} from "../lib/tauri";
import { SANITIZE } from "../lib/markdownHtml";
import { IconPencil, IconStop, IconTrash } from "./icons";

/**
 * The document policy minus everything that fetches a second resource. An answer is untrusted
 * text: a remote `<img>` is a tracking pixel, a frame is a page, and a broken one is a broken
 * icon under every answer. Links stay, and are intercepted by the panel.
 */
const AI_BLOCKED_TAGS = new Set([
  "img",
  "picture",
  "video",
  "audio",
  "source",
  "iframe",
  "input",
]);
const AI_SANITIZE = {
  ...SANITIZE,
  ALLOWED_TAGS: SANITIZE.ALLOWED_TAGS.filter((tag) => !AI_BLOCKED_TAGS.has(tag)),
};
const EXTERNAL_SCHEME = /^(?:https?|mailto|tel):/i;

interface Props {
  chat: AiChatController;
  /** What would be attached right now, for the bar above the composer. */
  contextLabel: string | null;
  contextScope: AiContextScope;
  onContextScope: (scope: AiContextScope) => void;
  /** Put a code block at the caret in the editor behind the panel. */
  onInsert: (text: string) => void;
  onOpenSettings: () => void;
  /** Whether the chat may ask to read and change the file on screen. */
  filesEnabled: boolean;
  onToggleFiles: () => void;
}

/** One read or edit waiting for the reader's answer. */
function ToolCard({
  card,
  onAllow,
  onDeny,
}: {
  card: AiToolCard;
  onAllow: () => void;
  onDeny: () => void;
}) {
  const editing = card.kind === "edit";
  return (
    <div className="ai-tool-card">
      <div className="ai-tool-head">
        <span className="ai-tool-title">
          {t(editing ? "ai.filesEditTitle" : "ai.filesReadTitle")}
        </span>
        <span className="ai-tool-file" title={card.fileName}>
          {card.fileName}
        </span>
      </div>
      {editing && (
        <div className="ai-tool-diff">
          <pre className="ai-tool-old">{card.oldText}</pre>
          <pre className="ai-tool-new">
            {card.newText || t("ai.filesEmptyReplacement")}
          </pre>
        </div>
      )}
      <p className="ai-tool-note">
        {t(editing ? "ai.filesEditNote" : "ai.filesReadNote")}
      </p>
      <div className="ai-tool-actions">
        <button className="btn small" onClick={onDeny}>
          {t("ai.filesDeny")}
        </button>
        <button className="btn primary small" onClick={onAllow}>
          {t(editing ? "ai.filesApply" : "ai.filesAllow")}
        </button>
      </div>
    </div>
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sessionTitle(session: AiSession): string {
  return session.title.trim() || t("ai.newChat");
}

/**
 * One assistant answer as Markdown.
 *
 * The HTML is sanitized with the preview's own policy: a model answer is untrusted input just
 * like a document, and a `<script>` in it must not become one in the app. Code blocks get the
 * copy/insert buttons after sanitisation, from their own `textContent` — the code never rides
 * through an attribute.
 */
function MarkdownAnswer({ text, onInsert }: { text: string; onInsert: (text: string) => void }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const html = useMemo(() => {
    const renderer = new marked.Renderer();
    renderer.code = ({ text: source, lang }) => {
      const info = (lang ?? "").trim().split(/\s+/, 1)[0] ?? "";
      const cls = info ? ` class="language-${escapeHtml(info)}"` : "";
      return `<pre><code${cls}>${escapeHtml(source)}</code></pre>\n`;
    };
    const raw = marked.parse(text, {
      async: false,
      gfm: true,
      breaks: true,
      renderer,
    }) as string;
    return DOMPurify.sanitize(raw, AI_SANITIZE);
  }, [text]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const cleanups: (() => void)[] = [];
    for (const pre of host.querySelectorAll("pre")) {
      if (pre.querySelector(":scope > .ai-code-tools")) continue;
      const code = pre.querySelector("code");
      if (!code) continue;
      const tools = document.createElement("div");
      tools.className = "ai-code-tools";
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "ai-code-btn";
      copy.textContent = t("ai.copy");
      const insert = document.createElement("button");
      insert.type = "button";
      insert.className = "ai-code-btn";
      insert.textContent = t("ai.insert");
      const onCopy = () => {
        void copyText(code.textContent ?? "").then((ok) => {
          copy.textContent = ok ? t("ai.copied") : t("ai.copyFailed");
          window.setTimeout(() => {
            copy.textContent = t("ai.copy");
          }, 1_200);
        });
      };
      const onPut = () => onInsert(code.textContent ?? "");
      copy.addEventListener("click", onCopy);
      insert.addEventListener("click", onPut);
      tools.append(copy, insert);
      pre.prepend(tools);
      cleanups.push(() => {
        copy.removeEventListener("click", onCopy);
        insert.removeEventListener("click", onPut);
        tools.remove();
      });
    }
    return () => {
      for (const cleanup of cleanups) cleanup();
    };
  }, [html, onInsert]);

  return (
    <div
      ref={hostRef}
      className="md-body ai-md"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

function Bubble({
  message,
  streaming,
  onInsert,
}: {
  message: AiStoredMessage;
  streaming: boolean;
  onInsert: (text: string) => void;
}) {
  if (message.role === "user") {
    return (
      <div className="ai-msg user">
        <div className="ai-bubble">{message.content}</div>
      </div>
    );
  }
  return (
    <div className="ai-msg assistant">
      <div className="ai-bubble ai-answer">
        {message.content ? (
          <MarkdownAnswer text={message.content} onInsert={onInsert} />
        ) : (
          <span className="ai-thinking">{t("ai.thinking")}</span>
        )}
        {streaming ? (
          <span className="ai-answer-note">{t("ai.thinking")}</span>
        ) : message.partial ? (
          <span className="ai-answer-note">{t("ai.partial")}</span>
        ) : null}
      </div>
    </div>
  );
}

export default function AiChatPanel({
  chat,
  contextLabel,
  contextScope,
  onContextScope,
  onInsert,
  onOpenSettings,
  filesEnabled,
  onToggleFiles,
}: Props) {
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  /** Enter and Escape close the rename box themselves; the blur that follows must not save again. */
  const skipRenameBlur = useRef(false);

  const session = chat.active;
  const messages = session?.messages ?? [];

  useEffect(() => {
    setConfirmDelete(false);
    setRenaming(null);
  }, [chat.activeId]);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.activeId, chat.ready]);

  // Follow a stream only while the reader is already at the bottom; scrolling away is a
  // request to stay there.
  const contentLength = useMemo(
    () =>
      messages.reduce((total, message) => total + message.content.length, 0) +
      chat.turnText.length +
      (chat.toolCard ? 1 : 0),
    [messages, chat.turnText, chat.toolCard]
  );
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [contentLength, chat.busy, chat.error]);

  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [draft]);

  // A link in an answer must not move the app window: a hash would rewrite its URL, a relative
  // path would try to navigate the webview away, and an external one belongs in the OS browser.
  useEffect(() => {
    const host = listRef.current;
    if (!host) return;
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const link = (e.target as Element).closest?.("a");
      const href = link?.getAttribute("href");
      if (!href) return;
      e.preventDefault();
      if (EXTERNAL_SCHEME.test(href)) {
        void openUrl(href).catch(() => undefined);
      }
    };
    host.addEventListener("click", onClick);
    return () => host.removeEventListener("click", onClick);
  }, []);

  const submit = () => {
    const text = draft.trim();
    if (!text || chat.busy) return;
    chat.send(text);
    setDraft("");
  };

  const errorText = chat.error
    ? translateError(
        `${chat.error.code}${chat.error.detail ? `:${chat.error.detail}` : ""}`
      )
    : "";
  const canRetry = messages.some((message) => message.role === "user");

  return (
    <div className="ai-panel">
      <div className="ai-head">
        {renaming && renaming.id === chat.activeId ? (
          <input
            className="settings-text ai-rename"
            autoFocus
            value={renaming.value}
            onChange={(e) => setRenaming({ id: renaming.id, value: e.target.value })}
            onBlur={() => {
              if (skipRenameBlur.current) {
                skipRenameBlur.current = false;
                return;
              }
              if (renaming.value.trim()) chat.renameSession(renaming.id, renaming.value);
              setRenaming(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                skipRenameBlur.current = true;
                if (renaming.value.trim()) chat.renameSession(renaming.id, renaming.value);
                setRenaming(null);
              }
              if (e.key === "Escape") {
                skipRenameBlur.current = true;
                setRenaming(null);
              }
            }}
          />
        ) : (
          <select
            className="select ai-session-select"
            value={chat.activeId}
            title={t("ai.switch")}
            disabled={!chat.ready}
            onChange={(e) => chat.switchSession(e.target.value)}
          >
            {(chat.store?.items ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {sessionTitle(item)}
              </option>
            ))}
          </select>
        )}
        <button
          className="ai-icon-btn"
          title={t("ai.rename")}
          onClick={() => {
            skipRenameBlur.current = false;
            setRenaming({ id: chat.activeId, value: session?.title.trim() ?? "" });
          }}
          disabled={!session}
        >
          <IconPencil size={13} />
        </button>
        <button
          className="ai-icon-btn"
          title={t("ai.new")}
          onClick={chat.newSession}
          disabled={!chat.ready}
        >
          +
        </button>
        {confirmDelete ? (
          <>
            <button
              className="ai-icon-btn ai-danger"
              title={t("ai.delete")}
              onClick={() => {
                chat.deleteSession(chat.activeId);
                setConfirmDelete(false);
              }}
            >
              ✓
            </button>
            <button
              className="ai-icon-btn"
              title={t("ai.cancel")}
              onClick={() => setConfirmDelete(false)}
            >
              ×
            </button>
          </>
        ) : (
          <button
            className="ai-icon-btn"
            title={t("ai.delete")}
            onClick={() => setConfirmDelete(true)}
            disabled={!session}
          >
            <IconTrash size={13} />
          </button>
        )}
      </div>

      <div className="ai-messages" ref={listRef}>
        {messages.length === 0 && !chat.turnText ? (
          <div className="ai-empty">
            <div className="ai-empty-title">{t("ai.emptyTitle")}</div>
            <p>{t("ai.emptyBody")}</p>
            <button className="btn small" onClick={onOpenSettings}>
              {t("ai.openSettings")}
            </button>
          </div>
        ) : (
          messages.map((message, index) => (
            <Bubble
              key={`${message.at}-${index}`}
              message={message}
              streaming={
                !chat.fileTurn &&
                chat.busy &&
                index === messages.length - 1 &&
                message.role === "assistant"
              }
              onInsert={onInsert}
            />
          ))
        )}
        {chat.turnText && (
          <Bubble
            message={{ role: "assistant", content: chat.turnText, at: "turn" }}
            streaming={false}
            onInsert={onInsert}
          />
        )}
        {chat.fileTurn && chat.busy && !chat.turnText && !chat.toolCard && (
          <div className="ai-msg assistant">
            <div className="ai-bubble">
              <span className="ai-thinking">{t("ai.filesThinking")}</span>
            </div>
          </div>
        )}
        {chat.toolCard && (
          <ToolCard
            card={chat.toolCard}
            onAllow={chat.approveTool}
            onDeny={chat.denyTool}
          />
        )}
        {chat.error && (
          <div className="ai-error">
            <div className="ai-error-text">{errorText}</div>
            <div className="ai-error-actions">
              {canRetry && !filesEnabled && (
                <button className="btn small" onClick={chat.retry}>
                  {t("ai.retry")}
                </button>
              )}
              <button className="btn small" onClick={onOpenSettings}>
                {t("ai.settings")}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="ai-context">
        {filesEnabled ? (
          <span className="ai-context-label" title={t("ai.filesScope")}>
            {t("ai.filesScope")}
          </span>
        ) : (
          <>
            <select
              className="select ai-scope-select"
              value={contextScope}
              title={t("ai.contextScope")}
              onChange={(e) => onContextScope(e.target.value as AiContextScope)}
            >
              <option value="selection">{t("ai.scopeSelection")}</option>
              <option value="file">{t("ai.scopeFile")}</option>
              <option value="none">{t("ai.scopeNone")}</option>
            </select>
            <span className="ai-context-label" title={contextLabel ?? undefined}>
              {contextLabel ?? t("ai.contextNone")}
            </span>
          </>
        )}
        <button
          className={`ai-files-toggle${filesEnabled ? " active" : ""}`}
          title={t("ai.filesToggle")}
          aria-pressed={filesEnabled}
          onClick={onToggleFiles}
        >
          {t("ai.filesLabel")}
        </button>
      </div>

      <div className="ai-compose">
        <textarea
          ref={composerRef}
          className="ai-input"
          value={draft}
          rows={2}
          placeholder={filesEnabled ? t("ai.filesPlaceholder") : t("ai.placeholder")}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.shiftKey) return;
            // Chinese input uses Enter to pick a candidate; that key never sends.
            if (e.nativeEvent.isComposing) return;
            e.preventDefault();
            submit();
          }}
        />
        {chat.busy ? (
          <button className="btn small ai-stop" onClick={chat.stop}>
            <IconStop size={13} />
            {t("ai.stop")}
          </button>
        ) : (
          <button
            className="btn primary small ai-send"
            onClick={submit}
            disabled={!draft.trim() || !chat.ready}
          >
            {t("ai.send")}
          </button>
        )}
      </div>
    </div>
  );
}
