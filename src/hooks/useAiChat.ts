import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type AiChatEvent,
  type AiChatRequest,
  type AiChatTurn,
  type AiFilesTurn,
  type AiSession,
  type AiSessionStore,
  type AiStoredMessage,
  type AiToolCall,
  type AiWireMessage,
} from "../lib/tauri";
import { t } from "../lib/i18n";

const MAX_SESSIONS = 20;
const MAX_MESSAGES = 100;
/** Deltas are batched rather than rendered one by one; a fast stream would otherwise
 *  re-render the whole panel for every token. */
const FLUSH_MS = 50;
/** The backend answers a cancel with a Done event. If the channel dies without one, the
 *  panel still has to leave its busy state. */
const CANCEL_FALLBACK_MS = 4_000;
const TITLE_CHARS = 48;
/** Model calls in one file-access turn; a loop that keeps asking is stopped. */
const MAX_FILE_STEPS = 8;
/** A single exact replacement larger than this is refused before it reaches the editor. */
const MAX_FILE_EDIT_CHARS = 16_384;

export interface AiChatError {
  code: string;
  detail: string;
  retryable: boolean;
}

/** The file or selection attached to one message. */
export interface AiContextSnippet {
  label: string;
  text: string;
}

/** The file a file-access turn was started on. */
export interface CurrentFileRef {
  id: number;
  path: string;
  name: string;
}

/** One question the model is waiting for the reader to answer. */
export interface AiToolCard {
  id: string;
  callId: string;
  kind: "read" | "edit";
  fileName: string;
  oldText?: string;
  newText?: string;
}

export interface AiChatController {
  store: AiSessionStore | null;
  activeId: string;
  active: AiSession | null;
  ready: boolean;
  busy: boolean;
  error: AiChatError | null;
  /** True while a current-file tool turn is running (a streaming ask is not one). */
  fileTurn: boolean;
  /** The assistant prose of a file-access turn, shown until the turn is saved. */
  turnText: string;
  /** A read or edit waiting for approval. */
  toolCard: AiToolCard | null;
  send: (text: string) => void;
  /** Ask about a snippet picked outside the panel, using it instead of the current context. */
  ask: (text: string, context: AiContextSnippet) => void;
  stop: () => void;
  retry: () => void;
  approveTool: () => void;
  denyTool: () => void;
  newSession: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
}

interface Options {
  enabled: boolean;
  /** Read at the moment the send button is pressed, so the request carries what was on screen. */
  collectContext: () => AiContextSnippet | null;
  onError: (message: string) => void;
  /** Whether sends should use the current-file tools instead of the streaming chat. */
  filesEnabled: boolean;
  /** The file a file-access turn would target. */
  currentFile: () => CurrentFileRef | null;
  /** Read the captured tab's live text, after the reader approved. */
  readFile: (
    id: number,
    path: string
  ) => { text: string; truncated: boolean } | { error: string };
  /** Apply an exact replacement to the captured file, after the reader approved. */
  applyFileEdit: (
    id: number,
    path: string,
    oldText: string,
    newText: string
  ) => { ok: true } | { error: string };
}

interface FileTurn {
  sessionId: string;
  target: CurrentFileRef;
  messages: AiWireMessage[];
  opId: string | null;
  text: string;
  steps: number;
  queue: AiToolCall[];
  pending: AiToolCall | null;
  canceled: boolean;
  edits: number;
}

function blankSession(): AiSession {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    title: "",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** The first line of a question, short enough for the session dropdown. */
function titleOf(text: string): string {
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > TITLE_CHARS ? `${line.slice(0, TITLE_CHARS)}…` : line;
}

function capped(store: AiSessionStore): AiSessionStore {
  return {
    ...store,
    items: store.items.slice(0, MAX_SESSIONS).map((session) => ({
      ...session,
      messages: session.messages.slice(-MAX_MESSAGES),
    })),
  };
}

/** Last assistant message in one session, which is the bubble a stream writes into. */
function applyToLastAnswer(messages: AiStoredMessage[], content: string): AiStoredMessage[] {
  const next = messages.slice();
  for (let index = next.length - 1; index >= 0; index -= 1) {
    if (next[index].role === "assistant") {
      next[index] = { ...next[index], content };
      break;
    }
  }
  return next;
}

export function useAiChat({
  enabled,
  collectContext,
  onError,
  filesEnabled,
  currentFile,
  readFile,
  applyFileEdit,
}: Options): AiChatController {
  const [store, setStore] = useState<AiSessionStore | null>(null);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AiChatError | null>(null);
  const [fileTurnActive, setFileTurnActive] = useState(false);
  const [turnText, setTurnText] = useState("");
  const [toolCard, setToolCard] = useState<AiToolCard | null>(null);

  const storeRef = useRef<AiSessionStore | null>(null);
  const streamRef = useRef<{ opId: string; sessionId: string } | null>(null);
  /** The answer as it has arrived so far; the assistant bubble is updated in batches. */
  const textRef = useRef("");
  const flushTimer = useRef<number | null>(null);
  const cancelTimer = useRef<number | null>(null);
  const dirtyRef = useRef(false);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const fileTurnRef = useRef<FileTurn | null>(null);
  const toolCardRef = useRef<AiToolCard | null>(null);

  // The callbacks belong to the render that passed them; the stream may live longer than it.
  const collectRef = useRef(collectContext);
  collectRef.current = collectContext;
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const filesEnabledRef = useRef(filesEnabled);
  filesEnabledRef.current = filesEnabled;
  const currentFileRef = useRef(currentFile);
  currentFileRef.current = currentFile;
  const readFileRef = useRef(readFile);
  readFileRef.current = readFile;
  const applyFileEditRef = useRef(applyFileEdit);
  applyFileEditRef.current = applyFileEdit;

  const commit = useCallback((next: AiSessionStore, markDirty = true) => {
    storeRef.current = next;
    setStore(next);
    if (markDirty) dirtyRef.current = true;
  }, []);

  const clearFlush = useCallback(() => {
    if (flushTimer.current !== null) {
      window.clearTimeout(flushTimer.current);
      flushTimer.current = null;
    }
  }, []);

  /**
   * Write the whole store. Saves are chained rather than run side by side: an older snapshot
   * landing after a newer one would silently undo a message.
   */
  const saveNow = useCallback(() => {
    if (!dirtyRef.current || !storeRef.current) return Promise.resolve();
    const snapshot = storeRef.current;
    dirtyRef.current = false;
    saveChain.current = saveChain.current
      .catch(() => undefined)
      .then(() => api.aiSaveSessions(snapshot))
      .catch((e) => {
        dirtyRef.current = true;
        onErrorRef.current(errorMessage(e));
      });
    return saveChain.current;
  }, []);

  const updateSession = useCallback(
    (sessionId: string, change: (session: AiSession) => AiSession, markDirty = true) => {
      const current = storeRef.current;
      if (!current) return;
      commit(
        {
          ...current,
          items: current.items.map((session) =>
            session.id === sessionId ? change(session) : session
          ),
        },
        markDirty
      );
    },
    [commit]
  );

  const applyText = useCallback(
    (sessionId: string, text: string, markDirty: boolean) => {
      updateSession(
        sessionId,
        (session) => ({
          ...session,
          messages: applyToLastAnswer(session.messages, text),
        }),
        markDirty
      );
    },
    [updateSession]
  );

  /** Leave the streaming state and put the final text (or nothing) into the bubble. */
  /** End a file-access turn and keep whatever prose it produced as one assistant message. */
  const finishFileTurn = useCallback(
    (note?: string) => {
      const turn = fileTurnRef.current;
      if (!turn) return;
      fileTurnRef.current = null;
      toolCardRef.current = null;
      setToolCard(null);
      setTurnText("");
      setFileTurnActive(false);
      setBusy(false);
      const text = turn.text.trim();
      const applied =
        text || turn.edits === 0
          ? ""
          : t("ai.filesApplied", { n: String(turn.edits) });
      const body = [text, applied, note?.trim()].filter(Boolean).join("\n\n");
      if (body) {
        const now = new Date().toISOString();
        updateSession(turn.sessionId, (session) => ({
          ...session,
          updatedAt: now,
          messages: [
            ...session.messages,
            { role: "assistant" as const, content: body, at: now },
          ].slice(-MAX_MESSAGES),
        }));
      }
      void saveNow();
    },
    [saveNow, updateSession]
  );

  /** Show one call's approval card; returns false when the call was invalid and was answered
   *  with a tool result instead. */
  const prepareFileTool = useCallback((call: AiToolCall): boolean => {
    const turn = fileTurnRef.current;
    if (!turn) return false;
    let card: AiToolCard;
    if (call.name === "read_current_file") {
      card = {
        id: crypto.randomUUID(),
        callId: call.id,
        kind: "read",
        fileName: turn.target.name,
      };
    } else if (call.name === "replace_in_current_file") {
      let args: { old_text?: unknown; new_text?: unknown } = {};
      try {
        args = JSON.parse(call.arguments || "{}") as typeof args;
      } catch {
        args = {};
      }
      const oldText = typeof args.old_text === "string" ? args.old_text : "";
      const newText = typeof args.new_text === "string" ? args.new_text : "";
      if (!oldText) {
        turn.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "The replacement was not proposed: old_text was empty.",
        });
        return false;
      }
      if (
        oldText.length > MAX_FILE_EDIT_CHARS ||
        newText.length > MAX_FILE_EDIT_CHARS
      ) {
        turn.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: "The replacement was not proposed: it is too large.",
        });
        return false;
      }
      card = {
        id: crypto.randomUUID(),
        callId: call.id,
        kind: "edit",
        fileName: turn.target.name,
        oldText,
        newText,
      };
    } else {
      turn.messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: `The tool ${call.name} is not available.`,
      });
      return false;
    }
    turn.pending = call;
    toolCardRef.current = card;
    setToolCard(card);
    return true;
  }, []);

  /**
   * Walk one file-access turn: ask the model, then either show the next approval card or run
   * the next model call. It stops at a card so the reader's answer can arrive between calls.
   */
  const driveFileTurn = useCallback(async () => {
    while (true) {
      const turn = fileTurnRef.current;
      if (!turn || turn.canceled) return;
      if (turn.queue.length > 0) {
        const call = turn.queue.shift();
        if (call && prepareFileTool(call)) {
          setBusy(true);
          return;
        }
        continue;
      }
      if (turn.steps >= MAX_FILE_STEPS) {
        finishFileTurn(t("ai.filesStepLimit"));
        return;
      }
      turn.steps += 1;
      const opId = crypto.randomUUID();
      turn.opId = opId;
      setBusy(true);
      let result: AiFilesTurn;
      try {
        result = await api.aiFilesTurn(opId, turn.messages);
      } catch (e) {
        if (fileTurnRef.current !== turn || turn.canceled) return;
        turn.opId = null;
        const raw =
          typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
        const at = raw.indexOf(":");
        setError({
          code: at < 0 ? raw : raw.slice(0, at),
          detail: at < 0 ? "" : raw.slice(at + 1),
          retryable: true,
        });
        finishFileTurn();
        return;
      }
      if (fileTurnRef.current !== turn || turn.canceled) return;
      turn.opId = null;
      if (result.text.trim()) {
        turn.text = turn.text
          ? `${turn.text}\n\n${result.text.trim()}`
          : result.text.trim();
        setTurnText(turn.text);
      }
      if (result.toolCalls.length === 0) {
        finishFileTurn();
        return;
      }
      turn.messages.push({
        role: "assistant",
        content: result.text,
        tool_calls: result.toolCalls.map((call) => ({
          id: call.id,
          type: "function" as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });
      turn.queue = [...result.toolCalls];
    }
  }, [finishFileTurn, prepareFileTool]);

  const approveTool = useCallback(() => {
    const turn = fileTurnRef.current;
    const card = toolCardRef.current;
    const call = turn?.pending;
    if (!turn || !card || !call) return;
    turn.pending = null;
    toolCardRef.current = null;
    setToolCard(null);
    let content: string;
    if (card.kind === "read") {
      const result = readFileRef.current(turn.target.id, turn.target.path);
      if ("error" in result) {
        content = `The file could not be read: ${result.error}`;
        onErrorRef.current(result.error);
      } else {
        content = result.text + (result.truncated ? "\n[truncated]" : "");
      }
    } else {
      const result = applyFileEditRef.current(
        turn.target.id,
        turn.target.path,
        card.oldText ?? "",
        card.newText ?? ""
      );
      if ("error" in result) {
        content = `The edit was not applied: ${result.error}`;
        onErrorRef.current(result.error);
      } else {
        content = "Applied.";
        turn.edits += 1;
      }
    }
    turn.messages.push({ role: "tool", tool_call_id: call.id, content });
    void driveFileTurn();
  }, [driveFileTurn]);

  const denyTool = useCallback(() => {
    const turn = fileTurnRef.current;
    const call = turn?.pending;
    if (!turn || !call) return;
    turn.pending = null;
    toolCardRef.current = null;
    setToolCard(null);
    turn.messages.push({
      role: "tool",
      tool_call_id: call.id,
      content: "The reader declined this action.",
    });
    void driveFileTurn();
  }, [driveFileTurn]);

  const finishStream = useCallback(
    (opId: string, finalText: string, reason: string, problem: AiChatError | null) => {
      const target = streamRef.current;
      if (!target || target.opId !== opId) return;
      clearFlush();
      if (cancelTimer.current !== null) {
        window.clearTimeout(cancelTimer.current);
        cancelTimer.current = null;
      }
      updateSession(target.sessionId, (session) => {
        const messages = session.messages.slice();
        let index = -1;
        for (let at = messages.length - 1; at >= 0; at -= 1) {
          if (messages[at].role === "assistant") {
            index = at;
            break;
          }
        }
        if (index >= 0) {
          if (finalText.trim()) {
            messages[index] = {
              ...messages[index],
              content: finalText,
              // `stop` is the only clean ending; a cut-off, stopped or failed answer says so.
              partial: reason !== "stop",
            };
          } else {
            messages.splice(index, 1);
          }
        }
        return { ...session, updatedAt: new Date().toISOString(), messages };
      });
      textRef.current = "";
      streamRef.current = null;
      setBusy(false);
      setError(problem);
      // Once per answer, not once per token: the finished text must be on disk before the
      // window can be closed on it.
      void saveNow();
    },
    [clearFlush, saveNow, updateSession]
  );

  const stop = useCallback(() => {
    const turn = fileTurnRef.current;
    if (turn) {
      turn.canceled = true;
      if (turn.opId) void api.aiCancel(turn.opId).catch(() => undefined);
      finishFileTurn();
      return;
    }
    const target = streamRef.current;
    if (!target) return;
    void api.aiCancel(target.opId).catch(() => undefined);
    if (cancelTimer.current !== null) window.clearTimeout(cancelTimer.current);
    cancelTimer.current = window.setTimeout(() => {
      cancelTimer.current = null;
      finishStream(target.opId, textRef.current, "canceled", null);
    }, CANCEL_FALLBACK_MS);
  }, [finishFileTurn, finishStream]);

  /** Leave a request behind when the reader moves to another session or starts a new one. */
  const abandon = useCallback(() => {
    const turn = fileTurnRef.current;
    if (turn) {
      turn.canceled = true;
      if (turn.opId) void api.aiCancel(turn.opId).catch(() => undefined);
      finishFileTurn();
      return;
    }
    const target = streamRef.current;
    if (!target) return;
    void api.aiCancel(target.opId).catch(() => undefined);
    finishStream(target.opId, textRef.current, "canceled", null);
  }, [finishFileTurn, finishStream]);

  const startStream = useCallback(
    (
      sessionId: string,
      turns: AiChatTurn[],
      userText: string,
      appendUser: boolean,
      contextOverride?: AiContextSnippet | null
    ) => {
      if (streamRef.current || fileTurnRef.current) return;
      // `undefined` means "read the panel's context setting"; null means "attach nothing".
      const context =
        contextOverride === undefined ? collectRef.current() : contextOverride;
      const opId = crypto.randomUUID();
      const now = new Date().toISOString();
      const answer: AiStoredMessage = {
        role: "assistant",
        content: "",
        at: now,
        partial: true,
      };
      updateSession(sessionId, (session) => {
        const messages = appendUser
          ? [...session.messages, { role: "user" as const, content: userText, at: now }, answer]
          : [...session.messages, answer];
        return {
          ...session,
          // The stored title is the first question's first line; the UI says "New chat"
          // rather than storing a localized placeholder.
          title: session.title.trim() || titleOf(userText),
          updatedAt: now,
          messages: messages.slice(-MAX_MESSAGES),
        };
      });
      textRef.current = "";
      streamRef.current = { opId, sessionId };
      setBusy(true);
      setError(null);
      // Persist the question now: a crash during a long answer must not lose it.
      void saveNow();

      const request: AiChatRequest = {
        opId,
        messages: turns,
        context: context?.text ?? null,
        contextLabel: context?.label ?? null,
      };
      const handle = (event: AiChatEvent) => {
        if (streamRef.current?.opId !== opId) return;
        if (event.type === "delta") {
          textRef.current += event.text;
          if (flushTimer.current === null) {
            flushTimer.current = window.setTimeout(() => {
              flushTimer.current = null;
              const target = streamRef.current;
              if (!target) return;
              applyText(target.sessionId, textRef.current, false);
            }, FLUSH_MS);
          }
          return;
        }
        if (event.type === "done") {
          finishStream(opId, event.text, event.reason, null);
          return;
        }
        finishStream(opId, textRef.current, "error", {
          code: event.code,
          detail: event.detail,
          retryable: event.retryable,
        });
      };

      void api.aiChat(request, handle).catch((e) => {
        if (streamRef.current?.opId !== opId) return;
        const raw = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
        const at = raw.indexOf(":");
        finishStream(opId, textRef.current, "error", {
          code: at < 0 ? raw : raw.slice(0, at),
          detail: at < 0 ? "" : raw.slice(at + 1),
          retryable: true,
        });
      });
    },
    [applyText, finishStream, saveNow, updateSession]
  );

  const submit = useCallback(
    (text: string, contextOverride?: AiContextSnippet | null) => {
      const current = storeRef.current;
      if (!enabled || !current || streamRef.current || fileTurnRef.current) return;
      const question = text.trim();
      if (!question) return;
      const session = current.items.find((item) => item.id === current.active);
      if (!session) return;
      const turns: AiChatTurn[] = session.messages
        .map((message) => ({ role: message.role, content: message.content }))
        .concat({ role: "user", content: question });
      startStream(session.id, turns, question, true, contextOverride);
    },
    [enabled, startStream]
  );

  /** Start the current-file tool loop for one question. */
  const startFileTurn = useCallback(
    (text: string) => {
      const current = storeRef.current;
      if (!enabled || !current || streamRef.current || fileTurnRef.current) return;
      const question = text.trim();
      if (!question) return;
      const target = currentFileRef.current();
      if (!target) {
        setError({ code: "ai_files_no_file", detail: "", retryable: false });
        return;
      }
      const session = current.items.find((item) => item.id === current.active);
      if (!session) return;
      const now = new Date().toISOString();
      updateSession(session.id, (item) => ({
        ...item,
        title: item.title.trim() || titleOf(question),
        updatedAt: now,
        messages: [
          ...item.messages,
          { role: "user" as const, content: question, at: now },
        ].slice(-MAX_MESSAGES),
      }));
      void saveNow();

      const history: AiWireMessage[] = session.messages
        .filter((message) => message.content.trim())
        .map((message) => ({ role: message.role, content: message.content }));
      history.push({ role: "user", content: question });
      fileTurnRef.current = {
        sessionId: session.id,
        target,
        messages: history,
        opId: null,
        text: "",
        steps: 0,
        queue: [],
        pending: null,
        canceled: false,
        edits: 0,
      };
      toolCardRef.current = null;
      setToolCard(null);
      setTurnText("");
      setFileTurnActive(true);
      setError(null);
      setBusy(true);
      void driveFileTurn();
    },
    [driveFileTurn, enabled, saveNow, updateSession]
  );

  const send = useCallback(
    (text: string) => {
      if (filesEnabledRef.current) startFileTurn(text);
      else submit(text);
    },
    [startFileTurn, submit]
  );
  const ask = useCallback(
    (text: string, context: AiContextSnippet) => submit(text, context),
    [submit]
  );

  const retry = useCallback(() => {
    const current = storeRef.current;
    if (!enabled || !current || streamRef.current || fileTurnRef.current) return;
    const session = current.items.find((item) => item.id === current.active);
    if (!session) return;
    let end = session.messages.length;
    while (end > 0 && session.messages[end - 1].role === "assistant") end -= 1;
    if (end === 0) return;
    const last = session.messages[end - 1];
    if (last.role !== "user") return;
    const kept = session.messages.slice(0, end);
    updateSession(session.id, (item) => ({ ...item, messages: kept }));
    const turns = kept.map((message) => ({
      role: message.role,
      content: message.content,
    })) as AiChatTurn[];
    startStream(session.id, turns, last.content, false);
    setError(null);
  }, [enabled, startStream, updateSession]);

  const createSession = useCallback(() => {
    if (!enabled) return;
    abandon();
    const current = storeRef.current ?? { active: "", items: [] };
    const session = blankSession();
    commit({
      active: session.id,
      items: [session, ...current.items].slice(0, MAX_SESSIONS),
    });
    setError(null);
    void saveNow();
  }, [abandon, commit, enabled, saveNow]);

  const switchSession = useCallback(
    (id: string) => {
      const current = storeRef.current;
      if (!current || current.active === id) return;
      if (!current.items.some((item) => item.id === id)) return;
      if (streamRef.current && streamRef.current.sessionId !== id) abandon();
      commit({ ...current, active: id });
      setError(null);
      void saveNow();
    },
    [abandon, commit, saveNow]
  );

  const deleteSession = useCallback(
    (id: string) => {
      const current = storeRef.current;
      if (!current) return;
      if (streamRef.current?.sessionId === id) abandon();
      let items = current.items.filter((item) => item.id !== id);
      if (items.length === 0) items = [blankSession()];
      const active = current.active === id ? items[0].id : current.active;
      commit({ active, items });
      setError(null);
      void saveNow();
    },
    [abandon, commit, saveNow]
  );

  const renameSession = useCallback(
    (id: string, title: string) => {
      const cleaned = title.trim().slice(0, TITLE_CHARS + 1);
      updateSession(id, (session) => ({
        ...session,
        title: cleaned,
        updatedAt: new Date().toISOString(),
      }));
      void saveNow();
    },
    [saveNow, updateSession]
  );

  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    setReady(false);
    api
      .aiSessions()
      .then((value) => {
        if (!alive) return;
        const loaded = capped(value);
        if (loaded.items.length === 0) {
          const session = blankSession();
          commit({ active: session.id, items: [session] }, false);
        } else {
          const active = loaded.items.some((item) => item.id === loaded.active)
            ? loaded.active
            : loaded.items[0].id;
          commit({ ...loaded, active }, false);
        }
        dirtyRef.current = false;
        setReady(true);
      })
      .catch((e) => {
        if (!alive) return;
        const session = blankSession();
        commit({ active: session.id, items: [session] }, false);
        dirtyRef.current = false;
        setReady(true);
        onErrorRef.current(errorMessage(e));
      });
    return () => {
      alive = false;
    };
  }, [enabled, commit]);

  useEffect(() => {
    if (enabled) return;
    abandon();
    clearFlush();
    storeRef.current = null;
    setStore(null);
    setReady(false);
    setBusy(false);
    setError(null);
  }, [abandon, clearFlush, enabled]);

  useEffect(() => {
    if (!enabled) return;
    const flush = () => {
      void saveNow();
    };
    window.addEventListener("blur", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("blur", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", flush);
      flush();
    };
  }, [enabled, saveNow]);

  useEffect(() => {
    if (filesEnabled) return;
    if (fileTurnRef.current) abandon();
  }, [abandon, filesEnabled]);

  useEffect(
    () => () => {
      if (flushTimer.current !== null) window.clearTimeout(flushTimer.current);
      if (cancelTimer.current !== null) window.clearTimeout(cancelTimer.current);
    },
    []
  );

  const active = useMemo(
    () => store?.items.find((item) => item.id === store.active) ?? null,
    [store]
  );

  return useMemo(
    () => ({
      store,
      activeId: store?.active ?? "",
      active,
      ready,
      busy,
      error,
      fileTurn: fileTurnActive,
      turnText,
      toolCard,
      send,
      ask,
      stop,
      retry,
      approveTool,
      denyTool,
      newSession: createSession,
      switchSession,
      deleteSession,
      renameSession,
    }),
    [
      store,
      active,
      ready,
      busy,
      error,
      fileTurnActive,
      turnText,
      toolCard,
      send,
      ask,
      stop,
      retry,
      approveTool,
      denyTool,
      createSession,
      switchSession,
      deleteSession,
      renameSession,
    ]
  );
}
