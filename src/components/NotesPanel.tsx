import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { useModalDrag } from "../hooks/useModalDrag";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import { t } from "../lib/i18n";
import {
  api,
  errorMessage,
  parentOf,
  type NoteMeta,
  type NoteMetaUpdate,
} from "../lib/tauri";
import { openStickyBoard } from "../lib/sticky";
import { splitNote } from "../lib/noteText";
import { pathKey } from "../lib/types";
import {
  IconBookmark,
  IconCheck,
  IconCopy,
  IconFilePlus,
  IconFolder,
  IconPencil,
  IconPlus,
  IconReveal,
  IconSearch,
  IconTable,
  IconTrash,
} from "./icons";

interface Props {
  /** Paths of tabs with unsaved edits, keyed like the Explorer. */
  dirtyPaths: Set<string>;
  /** Untitled tabs that carry text, for the "save as notes" shortcut. */
  scratchCount: number;
  onOpenPath: (path: string) => void;
  onReveal: (path: string) => void;
  onCopyPath: (path: string) => void;
  onSetFolder: (dir: string) => void;
  onOpenSettings: () => void;
  onSaveScratch: () => Promise<void>;
  /** A clean tab showing this note has to be reloaded after its header changed. */
  onMetaChanged: (path: string) => void;
  onNoteDeleted: (path: string) => void;
  onError: (message: string) => void;
}

const DAY_MS = 86_400_000;
const REFRESH_MS = 30_000;

type MetaDraft = { pinned: boolean; tags: string; due: string };

function hasDoneTag(note: NoteMeta): boolean {
  return note.tags.some((tag) => tag.toLowerCase() === "done");
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function localDateKey(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

function dateValue(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function daysBetween(from: string, to: string): number {
  return Math.round((dateValue(to) - dateValue(from)) / DAY_MS);
}

function clockOf(date: Date): string {
  const two = (value: number) => String(value).padStart(2, "0");
  return `${two(date.getHours())}:${two(date.getMinutes())}`;
}

function updatedLabel(modifiedAt: number, now: number): string {
  const date = new Date(modifiedAt);
  const days = Math.round((startOfLocalDay(new Date(now)) - startOfLocalDay(date)) / DAY_MS);
  if (days <= 0) return t("note.updatedToday", { time: clockOf(date) });
  if (days === 1) return t("note.updatedYesterday", { time: clockOf(date) });
  if (days < 7) return t("note.updatedDays", { n: String(days) });
  return t("note.changed", { when: localDateKey(date) });
}

function dueBadge(note: NoteMeta, today: string): { text: string; tone: string } | null {
  if (!note.due) return null;
  if (note.due < today) {
    return {
      text: t("note.overdueSince", { days: String(daysBetween(note.due, today)) }),
      tone: "overdue",
    };
  }
  if (note.due === today) return { text: t("note.dueToday"), tone: "today" };
  return {
    text: t("note.dueIn", { n: String(daysBetween(today, note.due)) }),
    tone: "soon",
  };
}

function rankOf(note: NoteMeta, today: string): number {
  if (note.pinned) return 0;
  if (hasDoneTag(note)) return 3;
  if (note.due && note.due < today) return 2;
  return 1;
}

function compareNotes(a: NoteMeta, b: NoteMeta, today: string): number {
  const rankA = rankOf(a, today);
  const rankB = rankOf(b, today);
  if (rankA !== rankB) return rankA - rankB;
  if (rankA === 1 || rankA === 2) {
    if (a.due && b.due) {
      // The date order is the point of the due column; ties fall back to the newer edit.
      return a.due.localeCompare(b.due) || b.modifiedAt - a.modifiedAt;
    }
    if (a.due) return -1;
    if (b.due) return 1;
  }
  return b.modifiedAt - a.modifiedAt;
}

/**
 * The Notes view: ordinary markdown files in one folder, with a small header the sidebar
 * sorts and colours by. Opening one is opening a file; nothing here owns a second copy.
 */
export default function NotesPanel({
  dirtyPaths,
  scratchCount,
  onOpenPath,
  onReveal,
  onCopyPath,
  onSetFolder,
  onOpenSettings,
  onSaveScratch,
  onMetaChanged,
  onNoteDeleted,
  onError,
}: Props) {
  const [notes, setNotes] = useState<NoteMeta[] | null>(null);
  const [dir, setDir] = useState("");
  const [filter, setFilter] = useState("");
  const [showDone, setShowDone] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [menu, setMenu] = useState<{ note: NoteMeta; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAt = useMenuPlacement(menu, menuRef);
  /** The board picker: open, with the note the menu was opened on already ticked. */
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [metaFor, setMetaFor] = useState<NoteMeta | null>(null);
  const [metaDraft, setMetaDraft] = useState<MetaDraft | null>(null);
  /** The note's body without its header; null until it is read. */
  const [metaBody, setMetaBody] = useState<string | null>(null);
  const [metaBodyFailed, setMetaBodyFailed] = useState(false);
  /** The body as it was when the panel opened, for the did-someone-else-edit check. */
  const metaBodyAtOpen = useRef<string | null>(null);
  const metaLoad = useRef(0);
  const [deleteFor, setDeleteFor] = useState<NoteMeta | null>(null);
  const metaDrag = useModalDrag<HTMLDivElement>();
  const deleteDrag = useModalDrag<HTMLDivElement>();
  const pickDrag = useModalDrag<HTMLDivElement>();

  const refresh = useCallback(async () => {
    try {
      const [list, folder] = await Promise.all([api.listNotes(), api.notesDir()]);
      setNotes(list);
      setDir(folder);
    } catch (error) {
      onError(errorMessage(error));
      setNotes([]);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  useEffect(() => {
    // A sticky board edits the same files; the list has to follow without waiting for the
    // next poll.
    const un = listen<string>("sticky-saved", () => {
      void refresh();
    });
    return () => {
      void un.then((stop) => stop());
    };
  }, [refresh]);

  useEffect(() => {
    if (!picking) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  useEffect(() => {
    if (!metaFor) return;
    const close = () => {
      setMetaFor(null);
      setMetaDraft(null);
      setMetaBody(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    // The editor floats rather than blocking: a press anywhere outside it still reaches the
    // app underneath, and doubles as the way to dismiss it.
    const onDown = (event: MouseEvent) => {
      const el = metaDrag.ref.current;
      if (el && event.target instanceof Node && el.contains(event.target)) return;
      close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [metaFor, metaDrag.ref]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
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
  }, [menu]);

  const today = useMemo(() => localDateKey(new Date(now)), [now]);
  const overdue = useMemo(
    () =>
      (notes ?? []).filter(
        (note) => !hasDoneTag(note) && note.due && note.due < today
      ).length,
    [notes, today]
  );
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return (notes ?? [])
      .filter((note) => {
        if (!showDone && hasDoneTag(note)) return false;
        if (!needle) return true;
        return (
          note.title.toLowerCase().includes(needle) ||
          note.tags.some((tag) => tag.toLowerCase().includes(needle))
        );
      })
      .sort((a, b) => compareNotes(a, b, today));
  }, [notes, filter, showDone, today]);

  const create = async () => {
    const title = newTitle.trim();
    if (!title) {
      onError(t("err.note_unnamed"));
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const note = await api.createNote(title);
      setNewTitle("");
      await refresh();
      onOpenPath(note.path);
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const updateMeta = useCallback(
    async (note: NoteMeta, patch: Partial<NoteMetaUpdate>): Promise<boolean> => {
      if (dirtyPaths.has(pathKey(note.path))) {
        onError(t("err.note_dirty"));
        return false;
      }
      try {
        await api.setNoteMeta(note.path, {
          pinned: note.pinned,
          tags: note.tags,
          due: note.due,
          ...patch,
        });
        await refresh();
        // A clean tab still holds the old header in its model. Reloading it keeps the next
        // save from putting the old header back.
        onMetaChanged(note.path);
        return true;
      } catch (error) {
        onError(errorMessage(error));
        return false;
      }
    },
    [dirtyPaths, onError, onMetaChanged, refresh]
  );

  const openBoard = (notes: NoteMeta[]) => {
    openStickyBoard(notes, onError);
  };





  const openPicker = (note: NoteMeta) => {
    setPicked(new Set([note.path]));
    setPicking(true);
    setMenu(null);
  };

  const openMeta = (note: NoteMeta) => {
    setMetaFor(note);
    setMetaDraft({
      pinned: note.pinned,
      tags: note.tags.join(", "),
      due: note.due ?? "",
    });
    setMenu(null);
    setMetaBody(null);
    setMetaBodyFailed(false);
    metaBodyAtOpen.current = null;
    const token = ++metaLoad.current;
    void api
      .openFile(note.path, false)
      .then((file) => {
        if (metaLoad.current !== token) return;
        if (file.binary || file.locked) {
          setMetaBodyFailed(true);
          return;
        }
        const { body } = splitNote(file.content);
        metaBodyAtOpen.current = body;
        setMetaBody(body);
      })
      .catch((error) => {
        if (metaLoad.current !== token) return;
        setMetaBodyFailed(true);
        onError(errorMessage(error));
      });
  };

  const closeMeta = () => {
    metaLoad.current += 1;
    setMetaFor(null);
    setMetaDraft(null);
    setMetaBody(null);
  };

  const saveMeta = async () => {
    if (!metaFor || !metaDraft) return;
    const tags = metaDraft.tags
      .split(/[,，]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
    const saved = await updateMeta(metaFor, {
      pinned: metaDraft.pinned,
      tags,
      due: metaDraft.due || null,
    });
    if (!saved) return;
    // The header is written; the body is a second write because `set_note_meta` keeps the
    // file it found. Reading it back first carries the just-written header, unknown keys
    // included, instead of rebuilding it here.
    const body = metaBody;
    if (body !== null && body !== metaBodyAtOpen.current) {
      const path = metaFor.path;
      try {
        const file = await api.openFile(path, false);
        if (file.binary || file.locked) throw new Error("note_read:unreadable");
        const current = splitNote(file.content);
        if (current.body !== metaBodyAtOpen.current) {
          onError(t("err.note_changed"));
          closeMeta();
          return;
        }
        const eol = current.head.includes("\r\n") ? "\r\n" : "\n";
        const nextBody = eol === "\n" ? body : body.replace(/\r?\n/g, "\r\n");
        await api.saveFile(path, current.head + nextBody, "UTF-8", false);
        await refresh();
        onMetaChanged(path);
      } catch (error) {
        onError(errorMessage(error));
        return;
      }
    }
    closeMeta();
  };

  const toggleDone = (note: NoteMeta) => {
    const tags = hasDoneTag(note)
      ? note.tags.filter((tag) => tag.toLowerCase() !== "done")
      : [...note.tags, "done"];
    void updateMeta(note, { tags });
    setMenu(null);
  };

  const confirmDelete = async () => {
    if (!deleteFor) return;
    try {
      await api.deleteNote(deleteFor.path);
      const name = deleteFor.title || deleteFor.path;
      onNoteDeleted(deleteFor.path);
      setDeleteFor(null);
      await refresh();
      onError(t("note.deleted", { name }));
    } catch (error) {
      onError(errorMessage(error));
    }
  };

  const saveScratch = async () => {
    if (busy || scratchCount === 0) return;
    setBusy(true);
    try {
      await onSaveScratch();
      await refresh();
    } catch (error) {
      onError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="notes-panel">
      <div className="notes-head">
        <div className="notes-new">
          <input
            className="notes-input"
            value={newTitle}
            placeholder={t("note.newTitle")}
            disabled={busy}
            onChange={(event) => setNewTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
            }}
          />
          <button
            className="notes-add"
            title={t("note.new")}
            aria-label={t("note.new")}
            onClick={() => void create()}
            disabled={busy || !newTitle.trim()}
          >
            <IconPlus size={14} />
          </button>
        </div>
        <div className="notes-tools">
          <label className="notes-search">
            <IconSearch size={14} />
            <input
              value={filter}
              placeholder={t("note.filterPlaceholder")}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <button
            className={`notes-done${showDone ? " on" : ""}`}
            title={t("note.showDone")}
            aria-pressed={showDone}
            onClick={() => setShowDone(!showDone)}
          >
            <IconCheck size={11} />
            {t("note.showDoneShort")}
          </button>
        </div>
        {scratchCount > 0 && (
          <button
            className="notes-scratch"
            onClick={() => void saveScratch()}
            disabled={busy}
          >
            <IconFilePlus size={12} />
            {t("note.saveScratch", { n: String(scratchCount) })}
          </button>
        )}
        <div className="notes-foot">
          {overdue > 0 && (
            <span className="notes-overdue">{t("note.overdue", { n: String(overdue) })}</span>
          )}
          <button className="notes-folder" title={dir} onClick={onOpenSettings}>
            {t("note.folder", { path: dir || "…" })}
          </button>
        </div>
      </div>

      <div className="notes-list">
        {notes === null ? (
          <div className="empty">{t("side.loading")}</div>
        ) : notes.length === 0 ? (
          <div className="notes-empty">
            <div>{t("note.noNotes")}</div>
            <p className="muted">{t("note.emptyHint")}</p>
            <button className="side-btn" onClick={onOpenSettings}>
              {t("note.changeFolder")}
            </button>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">{t("note.noMatches")}</div>
        ) : (
          visible.map((note) => {
            const badge = dueBadge(note, today);
            const done = hasDoneTag(note);
            const dirty = dirtyPaths.has(pathKey(note.path));
            return (
              <div
                key={note.path}
                className={`note-row${note.pinned ? " pinned" : ""}${
                  badge?.tone === "overdue" ? " overdue" : ""
                }${done ? " done" : ""}`}
                onClick={() => onOpenPath(note.path)}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ note, x: event.clientX, y: event.clientY });
                }}
              >
                <div className="note-title-line">
                  {note.pinned && <IconBookmark size={12} />}
                  <span className="note-title" title={note.title}>
                    {note.title || t("note.untitled")}
                  </span>
                  {dirty && (
                    <span className="note-dirty" title={t("note.dirty")}>
                      ●
                    </span>
                  )}
                </div>
                <div className="note-sub">
                  {badge && <span className={`note-due ${badge.tone}`}>{badge.text}</span>}
                  {note.tags.slice(0, 3).map((tag) => (
                    <span className="note-tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                  {note.tags.length > 3 && (
                    <span className="note-tag">+{note.tags.length - 3}</span>
                  )}
                </div>
                <div className="note-updated">{updatedLabel(note.modifiedAt, now)}</div>
              </div>
            );
          })
        )}
      </div>

      {menu && (
        <div
          className="ctx-menu"
          ref={menuRef}
          style={{ left: menuAt.left, top: menuAt.top }}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div
            className="ctx-item"
            onClick={() => {
              void updateMeta(menu.note, { pinned: !menu.note.pinned });
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconBookmark size={14} />
            </span>
            {t(menu.note.pinned ? "note.unpin" : "note.pin")}
          </div>
          <div className="ctx-item" onClick={() => toggleDone(menu.note)}>
            <span className="ctx-icon">
              <IconCheck size={14} />
            </span>
            {t(hasDoneTag(menu.note) ? "note.markUndone" : "note.markDone")}
          </div>
          <div className="ctx-item" onClick={() => openMeta(menu.note)}>
            <span className="ctx-icon">
              <IconPencil size={14} />
            </span>
            {t("note.edit")}
          </div>
          <div className="ctx-item" onClick={() => openPicker(menu.note)}>
            <span className="ctx-icon">
              <IconTable size={14} />
            </span>
            {t("note.boardOpen")}
          </div>
          <div className="ws-sep" />
          <div
            className="ctx-item"
            onClick={() => {
              onReveal(menu.note.path);
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconReveal size={14} />
            </span>
            {t("side.menuReveal")}
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              onCopyPath(menu.note.path);
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconCopy size={14} />
            </span>
            {t("side.menuCopyPath")}
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              onSetFolder(parentOf(menu.note.path));
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconFolder size={14} />
            </span>
            {t("side.menuSetRoot")}
          </div>
          <div className="ws-sep" />
          <div
            className="ctx-item ctx-danger"
            onClick={() => {
              setDeleteFor(menu.note);
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconTrash size={14} />
            </span>
            {t("side.menuDelete")}
          </div>
        </div>
      )}

      {metaFor && metaDraft && (
        <div className="modal-float">
          <div className="modal note-edit-modal" ref={metaDrag.ref}>
            <h3 className="modal-title" {...metaDrag.handleProps}>
              {t("note.edit")}
            </h3>
            <p className="muted">{metaFor.title || t("note.untitled")}</p>
            <label className="note-field note-body-field">
              {t("note.content")}
              {metaBody === null ? (
                <div className="note-body-missing">
                  {metaBodyFailed ? t("note.contentUnavailable") : t("side.loading")}
                </div>
              ) : (
                <textarea
                  className="note-body-input"
                  value={metaBody}
                  spellCheck={false}
                  onChange={(event) => setMetaBody(event.target.value)}
                />
              )}
            </label>
            <label className="note-check">
              <input
                type="checkbox"
                checked={metaDraft.pinned}
                onChange={(event) =>
                  setMetaDraft({ ...metaDraft, pinned: event.target.checked })
                }
              />
              {t("note.pinned")}
            </label>
            <label className="note-field">
              {t("note.tags")}
              <input
                className="settings-text note-tags-input"
                value={metaDraft.tags}
                placeholder={t("note.tagsHint")}
                onChange={(event) =>
                  setMetaDraft({ ...metaDraft, tags: event.target.value })
                }
              />
            </label>
            <label className="note-field">
              {t("note.due")}
              <span className="note-due-row">
                <input
                  className="settings-text note-due-input"
                  type="text"
                  value={metaDraft.due}
                  placeholder={t("note.dueHint")}
                  spellCheck={false}
                  onChange={(event) =>
                    setMetaDraft({ ...metaDraft, due: event.target.value })
                  }
                />
                <button
                  className="btn small"
                  onClick={() => setMetaDraft({ ...metaDraft, due: "" })}
                >
                  {t("note.clearDue")}
                </button>
              </span>
            </label>
            <div className="modal-actions">
              <button className="btn primary" onClick={() => void saveMeta()}>
                {t("note.save")}
              </button>
              <button className="btn" onClick={closeMeta}>
                {t("note.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {picking && (
        <div className="modal-overlay">
          <div className="modal note-pick" ref={pickDrag.ref}>
            <h3 className="modal-title" {...pickDrag.handleProps}>
              {t("sticky.pickTitle")}
            </h3>
            <p className="muted">{t("sticky.pickHint")}</p>
            <div className="note-pick-list">
              {notes === null ? (
                <div className="empty">{t("side.loading")}</div>
              ) : (
                notes.map((note) => {
                  const checked = picked.has(note.path);
                  return (
                    <label
                      key={note.path}
                      className={`note-pick-row${checked ? " on" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setPicked((prev) => {
                            const next = new Set(prev);
                            if (next.has(note.path)) next.delete(note.path);
                            else next.add(note.path);
                            return next;
                          });
                        }}
                      />
                      <span className="note-pick-title">
                        {note.title || t("note.untitled")}
                      </span>
                      {note.tags.slice(0, 2).map((tag) => (
                        <span className="note-tag" key={tag}>
                          {tag}
                        </span>
                      ))}
                    </label>
                  );
                })
              )}
            </div>
            <div className="modal-actions">
              <button
                className="btn primary"
                disabled={picked.size === 0}
                onClick={() => {
                  const chosen = (notes ?? []).filter((note) => picked.has(note.path));
                  setPicking(false);
                  openBoard(chosen);
                }}
              >
                {t("sticky.open")}
                {picked.size > 0 ? ` (${picked.size})` : ""}
              </button>
              <button className="btn" onClick={() => setPicking(false)}>
                {t("note.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteFor && (
        <div className="modal-overlay">
          <div className="modal" ref={deleteDrag.ref}>
            <h3 className="modal-title" {...deleteDrag.handleProps}>
              {t("note.deleteTitle")}
            </h3>
            <p>{t("note.deleteBody", { name: deleteFor.title || deleteFor.path })}</p>
            <div className="modal-actions">
              <button className="btn primary" onClick={() => void confirmDelete()} autoFocus>
                {t("note.deleteConfirm")}
              </button>
              <button className="btn" onClick={() => setDeleteFor(null)}>
                {t("note.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
