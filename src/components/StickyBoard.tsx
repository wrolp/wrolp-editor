import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { emit } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { currentMonitor, getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
import DOMPurify from "dompurify";
import { marked } from "marked";
import { api, copyText, errorMessage, openUrl, revealItemInDir } from "../lib/tauri";
import { splitNote } from "../lib/noteText";
import { SANITIZE } from "../lib/markdownHtml";
import { noteInk, rgbOf, type BackdropSample, type Rgb } from "../lib/stickyInk";
import { stickyColorOf, stickyPalette } from "../lib/stickyColors";
import { t } from "../lib/i18n";
import { useMenuPlacement } from "../hooks/useMenuPlacement";
import {
  IconCapsule,
  IconClose,
  IconCopy,
  IconMaximize,
  IconPencil,
  IconPushpin,
  IconReveal,
} from "./icons";
import type { StickyPayload } from "../lib/sticky";

const GAP = 8;
const PAD = 4;

/** CSS pixels sampled just outside the frame, where the board paints nothing of its own. */
const BACKDROP_BAND = 6;
/** The paper fade runs for 1s; the ink crosses over once most of the sheet is gone. */
const INK_DELAY = 700;
/** The desktop behind an idle board can change; the ink is re-weighed now and then. */
const BACKDROP_REFRESH = 5000;

/** Hover preview of a collapsed board: paper width, the breath around it, and height caps. */
const TIP_WIDTH = 340;
const TIP_GAP = 8;
const TIP_PAD = 10;
const TIP_MAX = 420;
const TIP_MIN = 64;
/** The preview's vertical padding (11 top + 10 bottom), which the height cap must leave room for. */
const TIP_CHROME = 21;
/** Long enough that moving the pointer across the pill does not flash a preview. */
const TIP_DELAY = 350;

const RESIZE_HANDLES = [
  ["n", "North"],
  ["s", "South"],
  ["e", "East"],
  ["w", "West"],
  ["ne", "NorthEast"],
  ["nw", "NorthWest"],
  ["se", "SouthEast"],
  ["sw", "SouthWest"],
] as const;

interface CardData extends StickyPayload {
  body: string | null;
  failed: boolean;
}

/** A rough width for the paper: a CJK glyph is twice a Latin one, and lines wrap past the cap. */
function estimateWidth(body: string): number {
  let widest = 0;
  for (const line of body.split(/\r?\n/)) {
    let width = 0;
    for (const ch of line) width += ch.charCodeAt(0) > 0x2e80 ? 13.5 : 7;
    widest = Math.max(widest, width);
  }
  return Math.min(520, Math.max(240, widest + 36));
}

function htmlOf(body: string): string {
  const raw = marked.parse(body, { async: false, gfm: true, breaks: true }) as string;
  return DOMPurify.sanitize(raw, SANITIZE);
}

function titleOf(body: string): string {
  for (const line of body.split(/\r?\n/)) {
    const text = line.trimStart();
    if (text.startsWith("# ")) return text.slice(2).trim();
  }
  return "";
}

/** The paper tones, averaged over the cards on the board. */
function paperOf(board: HTMLElement): Rgb | null {
  const colors: Rgb[] = [];
  for (const paper of board.querySelectorAll<HTMLElement>(
    ".sticky-note, .sticky-capsule"
  )) {
    const color = rgbOf(getComputedStyle(paper, "::before").backgroundColor);
    if (color) colors.push(color);
  }
  if (colors.length === 0) return null;
  const mean = (index: number) =>
    colors.reduce((sum, color) => sum + color[index], 0) / colors.length;
  return [mean(0), mean(1), mean(2)];
}

/**
 * One note, shown as paper. Clicking the text turns the card into its own editor; leaving it
 * (or Escape) writes the markdown back, so the board no longer needs another window to edit.
 */
function StickyCard({
  note,
  paper,
  onMenu,
  requestEdit,
  onEditHandled,
  onSaved,
}: {
  note: CardData;
  /** The note's background, picked from the group in Settings → Notes. */
  paper: string;
  onMenu: (x: number, y: number) => void;
  requestEdit: boolean;
  onEditHandled: () => void;
  onSaved: (path: string, body: string) => void;
}) {
  const [body, setBody] = useState(note.body);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(note.body ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const editStart = useRef<string | null>(null);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    setBody(note.body);
  }, [note.body]);

  const html = useMemo(() => (body === null ? "" : htmlOf(body)), [body]);

  const startEdit = () => {
    if (body === null || saving) return;
    editStart.current = body;
    setDraft(body);
    setError("");
    setEditing(true);
  };

  useEffect(() => {
    if (!requestEdit) return;
    startEdit();
    onEditHandled();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestEdit]);

  useEffect(() => {
    if (!editing) return;
    const area = areaRef.current;
    if (!area) return;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }, [editing]);

  const finish = async (save: boolean) => {
    if (!editing) return;
    setEditing(false);
    if (!save || draft === editStart.current) return;
    setSaving(true);
    setError("");
    try {
      await api.setNoteMeta(note.path, {
        pinned: note.pinned,
        tags: note.tags,
        due: note.due,
      });
      // Read the header back rather than rebuilding it: it can carry keys this window does
      // not know about.
      const file = await api.openFile(note.path, false);
      if (file.binary || file.locked) throw new Error("note_read:unreadable");
      const current = splitNote(file.content);
      if (current.body !== editStart.current) {
        setError(t("err.note_changed"));
        return;
      }
      const eol = current.head.includes("\r\n") ? "\r\n" : "\n";
      const next = eol === "\n" ? draft : draft.replace(/\r?\n/g, "\r\n");
      await api.saveFile(note.path, current.head + next, "UTF-8", false);
      editStart.current = draft;
      setBody(draft);
      onSaved(note.path, draft);
      void emit("sticky-saved", note.path).catch(() => {});
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setSaving(false);
    }
  };

  const onClick = (event: ReactMouseEvent) => {
    if (editing) return;
    const anchor = (event.target as HTMLElement).closest("a");
    if (anchor) {
      event.preventDefault();
      const href = anchor.getAttribute("href");
      if (href && /^(?:https?|mailto):/i.test(href)) void openUrl(href);
      return;
    }
    startEdit();
  };

  return (
    <article
      className="sticky-note"
      style={{ "--paper": paper } as CSSProperties}
      onClick={onClick}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest("textarea")) return;
        event.preventDefault();
        onMenu(event.clientX, event.clientY);
      }}
    >
      {body === null ? (
        <div className="sticky-note-missing">
          {note.failed ? t("note.contentUnavailable") : t("side.loading")}
        </div>
      ) : editing ? (
        <textarea
          ref={areaRef}
          className="sticky-note-editor"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void finish(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              void finish(true);
            }
          }}
        />
      ) : (
        <div
          className="sticky-note-text"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
      {error && <div className="sticky-note-error">{error}</div>}
      {(note.tags.length > 0 || note.due) && (
        <footer className="sticky-note-foot">
          {note.tags.slice(0, 3).map((tag) => (
            <span className="sticky-tag" key={tag}>
              {tag}
            </span>
          ))}
          {note.due && <span className="sticky-due">{note.due}</span>}
        </footer>
      )}
    </article>
  );
}

export default function StickyBoard({ label }: { label: string }) {
  const [notes, setNotes] = useState<StickyPayload[] | null>(null);
  const [cards, setCards] = useState<CardData[] | null>(null);
  const [onTop, setOnTop] = useState(true);
  /** Percent kept while the pointer is away; 100 means the paper never fades. */
  const [idleOpacity, setIdleOpacity] = useState(100);
  /* Opaque text is the default: until settings answer, only the paper may fade. */
  const [fadeText, setFadeText] = useState(false);
  const [idle, setIdle] = useState(false);
  /** The background group from Settings → Notes, starting on the defaults. */
  const [colors, setColors] = useState<string[] | null>(null);
  const palette = useMemo(() => stickyPalette(colors ?? undefined), [colors]);
  /** Light ink while the paper under the writing is dark. */
  const [lightInk, setLightInk] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  /** The capsule's hover preview; null while it is closed. */
  const [tip, setTip] = useState<{ width: number; max: number } | null>(null);
  /** The panel fades in only after the window has grown to hold it. */
  const [tipReady, setTipReady] = useState(false);
  /** The pill's own width, so a window grown for the preview does not stretch it. */
  const [capsuleWidth, setCapsuleWidth] = useState<number | null>(null);
  const [editPath, setEditPath] = useState<string | null>(null);
  const savedSize = useRef<{ width: number; height: number } | null>(null);
  /** The capsule both moves the window and expands it, told apart by a few pixels of travel. */
  const capsuleFrom = useRef<{ x: number; y: number } | null>(null);
  const capsuleDragged = useRef(false);
  const shown = useRef(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const idleTimer = useRef<number | null>(null);
  const fadeDelay = useRef(2);
  const tipRef = useRef<HTMLDivElement>(null);
  const tipTimer = useRef<number | null>(null);
  const tipGen = useRef(0);
  /** The window's size before the preview grew it, in CSS pixels. */
  const tipSize = useRef<{ width: number; height: number } | null>(null);

  const scheduleIdle = () => {
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(
      () => setIdle(true),
      Math.max(0, fadeDelay.current) * 1000
    );
  };

  const wake = () => {
    if (idleTimer.current) {
      window.clearTimeout(idleTimer.current);
      idleTimer.current = null;
    }
    setIdle(false);
  };

  const cancelTip = () => {
    if (tipTimer.current) {
      window.clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
  };

  /** Close the preview and put the window back around the pill. */
  const closeTip = async (restore: boolean) => {
    cancelTip();
    tipGen.current += 1;
    const size = tipSize.current;
    tipSize.current = null;
    setTip(null);
    setTipReady(false);
    if (restore && size) {
      await getCurrentWindow()
        .setSize(new LogicalSize(size.width, size.height))
        .catch(() => {});
    }
  };

  /**
   * Grow the collapsed window far enough for the preview. It only ever grows down and to the
   * right: reaching the other sides would mean moving the window, and the pill—anchored to a
   * moving corner—reads as jumping for the frames before the webview catches up. The panel
   * gives up width or height instead when the desktop has no room on those two sides.
   */
  const openTip = () => {
    if (!collapsed || !cards || cards.length === 0) return;
    const gen = ++tipGen.current;
    void (async () => {
      const win = getCurrentWindow();
      const [scale, pos, size, monitor] = await Promise.all([
        win.scaleFactor(),
        win.outerPosition(),
        win.outerSize(),
        currentMonitor().catch(() => null),
      ]);
      if (gen !== tipGen.current) return;
      const area = monitor?.workArea;
      const right = area
        ? (area.position.x + area.size.width) / scale
        : pos.x / scale + screen.availWidth;
      const bottom = area
        ? (area.position.y + area.size.height) / scale
        : pos.y / scale + screen.availHeight;
      const x = pos.x / scale;
      const y = pos.y / scale;
      // The panel starts at the window's left edge, so its width is measured from there —
      // the part of the pill row it sits under is still usable.
      const rightRoom = right - x;
      const belowRoom = bottom - (y + size.height / scale);
      tipSize.current = { width: size.width / scale, height: size.height / scale };
      setTip({
        width: Math.max(
          160,
          Math.min(TIP_WIDTH, Math.floor(rightRoom) - TIP_PAD * 2 - 4)
        ),
        max: Math.max(
          TIP_MIN,
          Math.min(TIP_MAX, Math.floor(belowRoom) - TIP_GAP - TIP_PAD - TIP_CHROME - 4)
        ),
      });
    })();
  };

  const scheduleTip = () => {
    cancelTip();
    if (!collapsed) return;
    tipTimer.current = window.setTimeout(() => {
      tipTimer.current = null;
      openTip();
    }, TIP_DELAY);
  };

  useEffect(() => {
    // The fade is a timer, not a :hover rule: the note stays readable for a few seconds
    // after the pointer leaves, then dims. Starting over the note counts as awake.
    if (!boardRef.current?.matches(":hover")) scheduleIdle();
    return () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [menu, setMenu] = useState<{ note: CardData; x: number; y: number } | null>(
    null
  );
  const menuRef = useRef<HTMLDivElement>(null);
  const menuAt = useMenuPlacement(menu, menuRef);
  /** Set once the fit has run: from then on a resize distributes space to the papers. */
  const [settled, setSettled] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const fitted = useRef(false);

  useEffect(() => {
    // Read when the window opens and whenever it is brought back to the front: the setting is
    // edited in the main window, and a board that is already open should follow.
    let live = true;
    const load = () => {
      void api
        .getSettings()
        .then((settings) => {
          if (!live) return;
          const value = Number(settings.stickyIdleOpacity);
          setIdleOpacity(
            Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : 100
          );
          setFadeText(settings.stickyTextOpaque === false);
          setColors(Array.isArray(settings.stickyColors) ? settings.stickyColors : null);
          const delay = Number(settings.stickyFadeDelay);
          fadeDelay.current = Number.isFinite(delay)
            ? Math.min(60, Math.max(0, delay))
            : 2;
          if (!boardRef.current?.matches(":hover")) scheduleIdle();
        })
        .catch(() => {});
    };
    load();
    window.addEventListener("focus", load);
    return () => {
      live = false;
      window.removeEventListener("focus", load);
    };
  }, []);

  useEffect(() => {
    // A custom paper can be dark, so the writing follows the sheet itself while the sheet is
    // opaque. The faded case belongs to the sampled effect below, which knows what shows
    // through it; leaving this one out of it keeps the two from fighting over the ink.
    if (!fadeText && idle && idleOpacity < 100) return;
    const paper = boardRef.current ? paperOf(boardRef.current) : null;
    if (!paper) return;
    setLightInk(noteInk(paper, paper, 1) === "light");
  }, [cards, palette, fadeText, idle, idleOpacity]);

  useEffect(() => {
    // The ink only has to follow the desktop while the writing outlives the paper. With
    // text fading alongside the sheet there is nothing left to keep readable.
    if (fadeText || !idle || idleOpacity >= 100 || (cards?.length ?? 0) === 0) return;
    let live = true;
    const decide = () => {
      void invoke<BackdropSample | null>("sticky_backdrop", { band: BACKDROP_BAND })
        .then((backdrop) => {
          if (!live || !backdrop || !boardRef.current) return;
          const paper = paperOf(boardRef.current);
          if (!paper) return;
          const behind: Rgb = [backdrop.r, backdrop.g, backdrop.b];
          setLightInk(noteInk(paper, behind, idleOpacity / 100) === "light");
        })
        .catch(() => {});
    };
    // Dark ink stays right until the sheet is mostly gone: flipping before the fade would
    // put light writing on light paper for the second the fade takes.
    const first = window.setTimeout(decide, INK_DELAY);
    const refresh = window.setInterval(decide, BACKDROP_REFRESH);
    return () => {
      live = false;
      window.clearTimeout(first);
      window.clearInterval(refresh);
    };
  }, [cards, fadeText, idle, idleOpacity, palette]);

  useLayoutEffect(() => {
    if (!tip) return;
    const panel = tipRef.current;
    const before = tipSize.current;
    if (!panel || !before) return;
    const gen = tipGen.current;
    void (async () => {
      // Size is the whole change: the window's corner stays put, so the pill does too.
      const width = Math.max(before.width, panel.offsetWidth + TIP_PAD * 2);
      const height = before.height + TIP_GAP + panel.offsetHeight + TIP_PAD;
      await getCurrentWindow()
        .setSize(new LogicalSize(Math.round(width), Math.round(height)))
        .catch(() => {});
      if (gen !== tipGen.current) {
        // The pointer left while the frame was being sized: put the window back unless a
        // newer preview has already claimed it.
        if (!tipSize.current) {
          await getCurrentWindow()
            .setSize(new LogicalSize(before.width, before.height))
            .catch(() => {});
        }
        return;
      }
      setTipReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tip]);

  /** Created hidden: the window has no business showing its pre-fit size for a frame. */
  const reveal = () => {
    if (shown.current) return;
    shown.current = true;
    void getCurrentWindow().show().catch(() => {});
  };

  useEffect(() => {
    // Windows 11 draws a hairline border around even an undecorated window; the note has no
    // frame of its own, so DWM is asked to drop it.
    void invoke("remove_window_border").catch(() => {});
  }, []);

  useEffect(() => {
    // If the cards never arrive, a hidden window would be unreachable; show it anyway.
    const timer = window.setTimeout(reveal, 2000);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Kept after reading rather than removed: a reload of this window has to bring the same
    // notes back, and one small key per board window is cheaper than losing the board.
    const id = label.startsWith("sticky-") ? label.slice("sticky-".length) : label;
    const raw = localStorage.getItem(`wrolp.sticky.${id}`);
    if (!raw) {
      setNotes([]);
      reveal();
      return;
    }
    try {
      const parsed = JSON.parse(raw) as StickyPayload[];
      setNotes(parsed);
      if (parsed.length === 0) reveal();
    } catch {
      setNotes([]);
      reveal();
    }
  }, [label]);

  useEffect(() => {
    if (!notes || notes.length === 0) return;
    let live = true;
    void Promise.all(
      notes.map(async (note): Promise<CardData> => {
        try {
          const file = await api.openFile(note.path, false);
          if (file.binary || file.locked) {
            return { ...note, body: null, failed: true };
          }
          return { ...note, body: splitNote(file.content).body, failed: false };
        } catch {
          return { ...note, body: null, failed: true };
        }
      })
    ).then((loaded) => {
      if (live) setCards(loaded);
    });
    return () => {
      live = false;
    };
  }, [notes]);

  // Fit the window to the paper once everything it measures is on screen; a later manual
  // resize is the user's, so it is never undone.
  useLayoutEffect(() => {
    if (!cards || cards.length === 0 || fitted.current) return;
    fitted.current = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        const win = getCurrentWindow();
        const cols = cards.length === 1 ? 1 : cards.length <= 4 ? 2 : 3;
        const cardWidth = Math.max(
          ...cards.map((card) => estimateWidth(card.body ?? ""))
        );
        const width = Math.min(
          screen.availWidth - 24,
          Math.max(260, cols * cardWidth + GAP * (cols - 1) + PAD * 2)
        );
        await win.setSize(new LogicalSize(width, window.innerHeight));
        // One frame for the new column width to be laid out before heights are read.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        );
        const grid = gridRef.current;
        if (!grid) return;
        // Measure the paper's natural height, not the window it currently fills.
        grid.classList.add("measuring");
        void grid.offsetHeight;
        const papers = [...grid.querySelectorAll<HTMLElement>(".sticky-note")];
        if (papers.length === 0) {
          grid.classList.remove("measuring");
          return;
        }
        const contentHeight =
          papers.length === 1
            ? papers[0].offsetHeight
            : Math.max(...papers.map((el) => el.getBoundingClientRect().bottom)) -
              grid.getBoundingClientRect().top;
        grid.classList.remove("measuring");
        const height = Math.min(
          screen.availHeight - 24,
          Math.max(140, contentHeight + PAD * 2 + 2)
        );
        await win.setSize(new LogicalSize(width, height));
        setSettled(true);
        reveal();
      })();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cards]);

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

  const removeCard = (path: string) => {
    setCards((prev) => {
      const next = (prev ?? []).filter((card) => card.path !== path);
      const id = label.startsWith("sticky-") ? label.slice("sticky-".length) : label;
      const key = `wrolp.sticky.${id}`;
      if (next.length === 0) {
        localStorage.removeItem(key);
        void getCurrentWindow().close();
      } else {
        // The payload outlives the window so a reload restores what is still on the board,
        // not the cards that were taken off it.
        localStorage.setItem(
          key,
          JSON.stringify(
            next.map(({ path: kept, title, pinned, tags, due }) => ({
              path: kept,
              title,
              pinned,
              tags,
              due,
            }))
          )
        );
      }
      return next;
    });
  };

  const collapse = async () => {
    const first = cards?.[0];
    const title =
      (first && (titleOf(first.body ?? "") || first.title)) ||
      t("sticky.windowTitle");
    let textWidth = 0;
    for (const ch of title) textWidth += ch.charCodeAt(0) > 0x2e80 ? 13.5 : 7;
    // Padding, the dot, the gaps and the expand button take a fixed share of the pill.
    const width = Math.min(280, Math.max(110, textWidth + 72));
    savedSize.current = { width: window.innerWidth, height: window.innerHeight };
    setCapsuleWidth(Math.round(width));
    setCollapsed(true);
    wake();
    await getCurrentWindow()
      .setSize(new LogicalSize(width, 34))
      .catch(() => {});
  };

  const capsuleDown = (event: ReactPointerEvent) => {
    if (event.button !== 0) return;
    capsuleDragged.current = false;
    capsuleFrom.current = { x: event.clientX, y: event.clientY };
  };

  const capsuleMove = (event: ReactPointerEvent) => {
    const from = capsuleFrom.current;
    if (!from || capsuleDragged.current) return;
    if (Math.abs(event.clientX - from.x) + Math.abs(event.clientY - from.y) < 4) return;
    capsuleDragged.current = true;
    capsuleFrom.current = null;
    void getCurrentWindow().startDragging().catch(() => {});
  };

  const capsuleClick = () => {
    if (capsuleDragged.current) {
      capsuleDragged.current = false;
      return;
    }
    void expand();
  };

  const expand = async () => {
    await closeTip(true);
    setCollapsed(false);
    wake();
    // The paper needs a frame at the full size before its old measurements mean anything.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const size = savedSize.current;
    if (size) {
      await getCurrentWindow()
        .setSize(new LogicalSize(size.width, size.height))
        .catch(() => {});
    }
  };

  const toggleOnTop = async () => {
    const next = !onTop;
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
      setOnTop(next);
    } catch {
      // Without the window permission the board still works; only this toggle is inert.
    }
  };

  /** Preview bodies: parsed once per load rather than once per hover. */
  const tipHtml = useMemo(
    () =>
      (cards ?? []).map((card) => ({
        path: card.path,
        failed: card.failed,
        html: card.body === null ? null : htmlOf(card.body),
      })),
    [cards]
  );
  /** Where the caret points, under (or over) the middle of the pill. */
  const tipPoint = tip
    ? Math.round(
        Math.max(16, Math.min((capsuleWidth ?? 120) / 2 - TIP_PAD, tip.width - 16))
      )
    : 0;
  /** The collapsed pill and its preview wear the first note's paper. */
  const boardPaper = stickyColorOf(palette, cards?.[0]?.path ?? "");
  const tipPanel = tip && (
    <div
      ref={tipRef}
      className={`sticky-tip${tipReady ? " ready" : ""}`}
      style={
        {
          width: tip.width,
          "--paper": boardPaper,
          "--tip-point": `${tipPoint}px`,
        } as CSSProperties
      }
      role="tooltip"
      onClick={(event) => {
        // The preview is read-only, but its links are live: open them in the browser rather
        // than let the webview navigate away from the board.
        const anchor = (event.target as HTMLElement).closest("a");
        if (!anchor) return;
        event.preventDefault();
        const href = anchor.getAttribute("href");
        if (href && /^(?:https?|mailto):/i.test(href)) void openUrl(href);
      }}
    >
      <div className="sticky-tip-scroll" style={{ maxHeight: tip.max }}>
        {tipHtml.map((card) =>
          card.html === null ? (
            <div className="sticky-tip-missing" key={card.path}>
              {card.failed ? t("note.contentUnavailable") : t("side.loading")}
            </div>
          ) : (
            <div
              className="sticky-note-text"
              key={card.path}
              dangerouslySetInnerHTML={{ __html: card.html }}
            />
          )
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={boardRef}
      className={`sticky-board ${fadeText ? "fade-text" : "fade-paper"}${
        idle ? " idle" : ""
      }${lightInk ? " ink-light" : ""}`}
      data-tauri-drag-region
      onPointerEnter={wake}
      onPointerMove={wake}
      onPointerLeave={() => {
        void closeTip(true);
        scheduleIdle();
      }}
      style={{ "--sticky-idle-opacity": String(idleOpacity / 100) } as CSSProperties}
    >
      {collapsed ? (
        <>
          <div
            className="sticky-capsule"
            style={
              {
                ...(capsuleWidth ? { width: capsuleWidth } : {}),
                "--paper": boardPaper,
              } as CSSProperties
            }
            onPointerEnter={scheduleTip}
            onPointerDown={(event) => {
              if (event.button === 0) void closeTip(true);
              capsuleDown(event);
            }}
            onPointerMove={capsuleMove}
            onPointerUp={() => {
              capsuleFrom.current = null;
            }}
            onPointerLeave={() => {
              capsuleFrom.current = null;
              cancelTip();
            }}
            onClick={capsuleClick}
          >
            <span className="sticky-capsule-dot" />
            <span className="sticky-capsule-title">
              {(cards?.[0] &&
                (titleOf(cards[0].body ?? "") ||
                  cards[0].title ||
                  t("note.untitled"))) ||
                t("sticky.windowTitle")}
            </span>
            {cards && cards.length > 1 && (
              <span className="sticky-capsule-more">+{cards.length - 1}</span>
            )}
            <button
              className="sticky-capsule-expand"
              aria-label={t("sticky.expand")}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                void expand();
              }}
            >
              <IconMaximize size={12} />
            </button>
          </div>
          {tipPanel}
        </>
      ) : (
        <>
      <div className="sticky-drag-top" data-tauri-drag-region aria-hidden="true">
        <span className="sticky-grip" />
      </div>
      <div className="sticky-actions">
        <button
          className={`sticky-top${onTop ? " on" : ""}`}
          aria-pressed={onTop}
          title={t("sticky.pinOnTop")}
          aria-label={t("sticky.pinOnTop")}
          onClick={() => void toggleOnTop()}
        >
          <IconPushpin size={14} />
        </button>
        <button
          className="sticky-collapse"
          title={t("sticky.collapse")}
          aria-label={t("sticky.collapse")}
          onClick={() => void collapse()}
        >
          <IconCapsule size={13} />
        </button>
        <button
          className="sticky-close"
          title={t("sticky.close")}
          aria-label={t("sticky.close")}
          onClick={() => void getCurrentWindow().close()}
        >
          <IconClose size={13} />
        </button>
      </div>
      <div
        className={`sticky-grid${cards && cards.length === 1 ? " single" : ""}${
          settled ? " settled" : ""
        }`}
        ref={gridRef}
        data-tauri-drag-region
      >
        {cards === null ? (
          <div className="sticky-empty">{t("side.loading")}</div>
        ) : cards.length === 0 ? (
          <div className="sticky-empty">{t("sticky.empty")}</div>
        ) : (
          cards.map((note) => (
            <StickyCard
              key={note.path}
              note={note}
              paper={stickyColorOf(palette, note.path)}
              onMenu={(x, y) => setMenu({ note, x, y })}
              requestEdit={editPath === note.path}
              onEditHandled={() => setEditPath(null)}
              onSaved={(path, body) =>
                setCards((prev) =>
                  prev
                    ? prev.map((card) =>
                        card.path === path ? { ...card, body } : card
                      )
                    : prev
                )
              }
            />
          ))
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
              setEditPath(menu.note.path);
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconPencil size={14} />
            </span>
            {t("note.edit")}
          </div>
          <div
            className="ctx-item"
            onClick={() => {
              revealItemInDir(menu.note.path).catch(() => {});
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
              void copyText(menu.note.path);
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconCopy size={14} />
            </span>
            {t("side.menuCopyPath")}
          </div>
          <div className="ws-sep" />
          <div
            className="ctx-item"
            onClick={() => {
              removeCard(menu.note.path);
              setMenu(null);
            }}
          >
            <span className="ctx-icon">
              <IconClose size={14} />
            </span>
            {t("sticky.remove")}
          </div>
        </div>
      )}
      {RESIZE_HANDLES.map(([cls, direction]) => (
        <div
          key={cls}
          className={`sticky-resize ${cls}`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            void getCurrentWindow().startResizeDragging(direction);
          }}
        />
      ))}
        </>
      )}
    </div>
  );
}