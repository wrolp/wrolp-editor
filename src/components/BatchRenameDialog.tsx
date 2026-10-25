import { useCallback, useEffect, useMemo, useState } from "react";
import { t } from "../lib/i18n";
import { api } from "../lib/tauri";
import { useModalDrag } from "../hooks/useModalDrag";

/** One row of a batch, as the tree knows it. */
export interface BatchTarget {
  path: string;
  name: string;
  isDir: boolean;
}

interface Props {
  entries: BatchTarget[];
  /** Applies the names; resolves false when the disk refused the batch. */
  onApply: (items: { path: string; name: string }[]) => Promise<boolean>;
  onCancel: () => void;
}

/** Characters Windows refuses in one name segment, plus the control range it also refuses. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/;

/** Names Windows reserves at the top of a segment, extension or not. */
const RESERVED = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** The two halves a pattern works on: the extension keeps its dot, folders have none. */
function splitName(name: string, isDir: boolean): { stem: string; ext: string } {
  if (isDir) return { stem: name, ext: "" };
  const dot = name.lastIndexOf(".");
  // A leading dot belongs to the name: `.gitignore` has no extension to keep.
  return dot <= 0 ? { stem: name, ext: "" } : { stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** A folder arrives with its trailing separator; the name to work on is the bare one. */
function displayName(entry: BatchTarget): string {
  return entry.name.replace(/[\\/]+$/, "");
}

/** The name the backend will see: the same trim it applies to whatever is typed. */
function clean(name: string): string {
  return name.trim().replace(/^"+|"+$/g, "").trim();
}

/** The row's number, with the leading zeros the dialog asks for. */
function rowNumber(index: number, start: number, digits: number): string {
  return String(start + index).padStart(Math.min(8, Math.max(1, digits)), "0");
}

/**
 * `{name}`, `{ext}` and `{n}` filled in.
 *
 * `literalDollars` is for the regex mode, where the result becomes the replacement handed to
 * `String.replace`: a `$` that came from a file's own name would otherwise be read as
 * replacement syntax (`$&`, `$1`) and silently change the name.
 */
function fillTokens(
  template: string,
  name: string,
  isDir: boolean,
  number: string,
  literalDollars: boolean
): string {
  const { stem, ext } = splitName(name, isDir);
  const put = (value: string) => (literalDollars ? value.replace(/\$/g, "$$$$") : value);
  // The tokens are inserted through a function, not as a replacement string: a string would
  // have the `$` escapes consumed here and leave a raw `$&` behind for the regex's own
  // replacement pass to expand, which is exactly what this is guarding against.
  return template
    .replace(/\{name\}/g, () => put(stem))
    .replace(/\{ext\}/g, () => put(ext))
    .replace(/\{n\}/g, () => number);
}

/**
 * The name one row will get, trimmed the way the backend trims it — surrounding spaces and
 * quotes — so the preview is the name that will be used rather than the text as typed.
 */
function resolve(
  pattern: string,
  name: string,
  isDir: boolean,
  index: number,
  start: number,
  digits: number
): string {
  return clean(fillTokens(pattern, name, isDir, rowNumber(index, start, digits), false));
}

/** Why the name cannot be used, in the words this dialog has for it, or null. */
function nameProblem(name: string): string | null {
  if (!name) return t("batch.errEmpty");
  if (
    ILLEGAL.test(name) ||
    name.endsWith(".") ||
    name === "." ||
    name === ".." ||
    name.length > 255
  ) {
    return t("batch.errInvalid");
  }
  if (RESERVED.has(name.split(".")[0].toLowerCase())) return t("batch.errInvalid");
  return null;
}

/** How the preview list can be ordered. `given` is what the caller handed over. */
type SortKey = "given" | "name" | "ext" | "mtime" | "manual";

/** Names sort like a person reads them: `photo-10` after `photo-9`, not after `photo-1`. */
const compareNames = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

function extOfName(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/**
 * The same rows in one order, or the exact reverse of it.
 *
 * Always applied to the entries as they arrived, so flipping the direction reverses what is on
 * screen instead of re-sorting it — a re-sort would drift on ties, and "descending" has to mean
 * the same list read backwards.
 */
function sortEntries(
  list: BatchTarget[],
  key: Exclude<SortKey, "given" | "manual">,
  desc: boolean,
  times: Record<string, number>
): BatchTarget[] {
  const by = (a: BatchTarget, b: BatchTarget): number => {
    switch (key) {
      case "name":
        return compareNames(displayName(a), displayName(b));
      case "ext": {
        const ea = extOfName(displayName(a));
        const eb = extOfName(displayName(b));
        return ea === eb ? compareNames(displayName(a), displayName(b)) : compareNames(ea, eb);
      }
      case "mtime": {
        const ta = times[a.path] ?? 0;
        const tb = times[b.path] ?? 0;
        return ta === tb ? 0 : ta < tb ? -1 : 1;
      }
    }
  };
  const sorted = [...list].sort(by);
  return desc ? sorted.reverse() : sorted;
}

/** The two fields that decide what `{n}` is; both modes number their rows this way. */
function NumberFields({
  start,
  digits,
  onStart,
  onDigits,
}: {
  start: number;
  digits: number;
  onStart: (value: number) => void;
  onDigits: (value: number) => void;
}) {
  return (
    <>
      <label className="batch-field">
        <span>{t("batch.start")}</span>
        <input
          className="batch-input"
          type="number"
          min={0}
          value={start}
          onChange={(e) => onStart(Math.max(0, Number(e.target.value) || 0))}
        />
      </label>
      <label className="batch-field">
        <span>{t("batch.digits")}</span>
        <input
          className="batch-input"
          type="number"
          min={1}
          max={8}
          value={digits}
          onChange={(e) => onDigits(Math.min(8, Math.max(1, Number(e.target.value) || 1)))}
        />
      </label>
    </>
  );
}

/**
 * Rename a set of rows by one rule.
 *
 * Two rules are offered because two kinds of batch exist: a pattern over the parts of a name
 * (`{name}`, `{ext}`, `{n}`) for numbering and prefixes, and a regular expression with a
 * replacement for everything a pattern cannot say. Either way every row is resolved and checked
 * as it is typed, and the preview is the whole of the answer — the backend checks the same
 * names, so a preview that looks right is the one that will land.
 *
 * Two rows landing on one name is caught here because both are on screen; a name another entry
 * in the folder already carries cannot be seen from this dialog, and is refused by the backend
 * with a message instead.
 *
 * The order is part of the rule: `{n}` counts the rows as they are shown, so the list can be
 * sorted and then nudged by hand until the numbering reads the way the user wants it.
 */
export default function BatchRenameDialog({ entries, onApply, onCancel }: Props) {
  const drag = useModalDrag<HTMLDivElement>();
  const [mode, setMode] = useState<"pattern" | "regex">("pattern");
  const [pattern, setPattern] = useState("{name}{ext}");
  const [start, setStart] = useState(1);
  const [digits, setDigits] = useState(2);
  const [regex, setRegex] = useState("");
  const [replacement, setReplacement] = useState("");
  const [ignoreCase, setIgnoreCase] = useState(false);
  const [busy, setBusy] = useState(false);
  /**
   * The order of the preview, and how it was reached.
   *
   * `given` is what the caller handed over — the order the rows were listed or picked in. A
   * sort rewrites this list from the entries as they arrived; a drag or an arrow rewrites it
   * directly and says so, because from then on the order belongs to the user.
   */
  const [order, setOrder] = useState<BatchTarget[]>(entries);
  const [sort, setSort] = useState<SortKey>("given");
  const [descending, setDescending] = useState(false);
  /** Modification times, asked for only while that is the order on screen. */
  const [times, setTimes] = useState<Record<string, number>>({});
  /** The row being dragged, and the row it is over, while a reorder runs. */
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  // One stat per row, and only for the order that needs them: a dialog sorting by name should
  // not pay for a question nobody asked.
  useEffect(() => {
    if (sort !== "mtime") return;
    let alive = true;
    void Promise.all(
      entries.map((entry) =>
        api.statFile(entry.path).then(
          (stat) => [entry.path, stat?.mtime ?? 0] as const,
          () => [entry.path, 0] as const
        )
      )
    ).then((pairs) => {
      if (alive) setTimes(Object.fromEntries(pairs));
    });
    return () => {
      alive = false;
    };
  }, [sort, entries]);

  /**
   * Put the rows in one of the named orders. Hand adjustments made before this are dropped:
   * asking for "by name" again is asking for that order, not for a sort of whatever was last
   * dragged into place.
   */
  const applySort = useCallback(
    (key: SortKey, downwards: boolean) => {
      setSort(key);
      setDescending(downwards);
      if (key === "given") {
        setOrder(entries);
      } else if (key !== "manual") {
        setOrder(sortEntries(entries, key, downwards, times));
      }
    },
    [entries, times]
  );

  // Times land after the order was first put in from zeros, so it is put in again once they
  // are known — by then nothing has been dragged in any normal use of the dialog.
  useEffect(() => {
    if (sort === "mtime") setOrder(sortEntries(entries, "mtime", descending, times));
  }, [times, sort, descending, entries]);

  /** One row to another position; the order is the user's from here on. */
  const move = (from: number, to: number) => {
    if (from === to || to < 0 || to >= order.length) return;
    setOrder((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
    setSort("manual");
  };

  /**
   * The regular expression as it stands: null while nothing is typed (nothing changes yet),
   * "invalid" while it does not compile (every row says why), the expression otherwise.
   */
  const rule = useMemo<RegExp | "invalid" | null>(() => {
    if (mode !== "regex" || !regex.trim()) return null;
    try {
      return new RegExp(regex, ignoreCase ? "gi" : "g");
    } catch {
      return "invalid";
    }
  }, [mode, regex, ignoreCase]);

  const rows = useMemo(() => {
    const names = order.map((entry, index) => {
      const old = displayName(entry);
      if (mode === "pattern") return resolve(pattern, old, entry.isDir, index, start, digits);
      // The subject is the whole name, extension included: what a regex sees is the name. The
      // replacement may carry the same tokens a pattern does, `{n}` included.
      return rule instanceof RegExp
        ? clean(
            old.replace(
              rule,
              fillTokens(replacement, old, entry.isDir, rowNumber(index, start, digits), true)
            )
          )
        : old;
    });
    const counts = new Map<string, number>();
    for (const name of names) {
      const key = name.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return order.map((entry, index) => {
      const name = names[index];
      const problem =
        mode === "regex" && rule === "invalid"
          ? t("batch.regexInvalid")
          : (counts.get(name.toLowerCase()) ?? 0) > 1
            ? t("batch.errDuplicate")
            : nameProblem(name);
      return { entry, old: displayName(entry), name, problem };
    });
  }, [order, mode, pattern, start, digits, rule, replacement]);

  const invalid = rows.some((row) => row.problem !== null);
  // Windows folds case, so a name that only changes spelling is not a rename at all.
  const unchanged = rows.every(
    (row) => row.name.toLowerCase() === row.old.toLowerCase()
  );

  const apply = () => {
    if (invalid || unchanged || busy) return;
    setBusy(true);
    onApply(rows.map((row) => ({ path: row.entry.path, name: row.name }))).then(
      () => setBusy(false),
      (e) => {
        // `onApply` answers false for a refusal it has already reported in a toast; a rejection
        // is a bug, and the dialog stays up so the names are not lost along with it.
        console.error("batch rename failed", e);
        setBusy(false);
      }
    );
  };

  return (
    <div className="modal-overlay">
      <div
        className="modal batch-modal"
        ref={drag.ref}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
        }}
      >
        <h3 className="modal-title" {...drag.handleProps}>
          {t("batch.title", { count: entries.length })}
        </h3>
        <div className="batch-modes">
          <button
            className={`batch-mode${mode === "pattern" ? " on" : ""}`}
            onClick={() => setMode("pattern")}
          >
            {t("batch.modePattern")}
          </button>
          <button
            className={`batch-mode${mode === "regex" ? " on" : ""}`}
            onClick={() => setMode("regex")}
          >
            {t("batch.modeRegex")}
          </button>
        </div>
        {mode === "pattern" ? (
          <>
            <div className="batch-form">
              <label className="batch-field batch-pattern">
                <span>{t("batch.pattern")}</span>
                <input
                  className="batch-input"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  onFocus={(e) => e.currentTarget.select()}
                />
              </label>
              <NumberFields
                start={start}
                digits={digits}
                onStart={setStart}
                onDigits={setDigits}
              />
            </div>
            <p className="muted batch-hint">{t("batch.hint")}</p>
          </>
        ) : (
          <>
            <div className="batch-form">
              <label className="batch-field batch-pattern">
                <span>{t("batch.regex")}</span>
                <input
                  className="batch-input"
                  value={regex}
                  onChange={(e) => setRegex(e.target.value)}
                  autoFocus
                  spellCheck={false}
                  placeholder="^IMG_(\\d+)"
                />
              </label>
              <label className="batch-field batch-pattern">
                <span>{t("batch.replacement")}</span>
                <input
                  className="batch-input"
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  spellCheck={false}
                  placeholder="photo-$1"
                />
              </label>
            </div>
            {/* The replacement takes the same tokens a pattern does, `{n}` included, so the
                numbering fields belong here too. */}
            <div className="batch-form">
              <NumberFields
                start={start}
                digits={digits}
                onStart={setStart}
                onDigits={setDigits}
              />
            </div>
            <label className="batch-flag">
              <input
                type="checkbox"
                checked={ignoreCase}
                onChange={(e) => setIgnoreCase(e.target.checked)}
              />
              {t("batch.ignoreCase")}
            </label>
            <p className="muted batch-hint">{t("batch.regexHint")}</p>
          </>
        )}
        <div className="batch-order">
          <label className="batch-order-label">
            {t("batch.sort")}
            <select
              className="batch-input batch-sort"
              value={sort}
              onChange={(e) => applySort(e.target.value as SortKey, descending)}
            >
              <option value="given">{t("batch.sortGiven")}</option>
              <option value="name">{t("batch.sortName")}</option>
              <option value="ext">{t("batch.sortExt")}</option>
              <option value="mtime">{t("batch.sortMtime")}</option>
              <option value="manual">{t("batch.sortManual")}</option>
            </select>
          </label>
          <button
            className="batch-dir"
            onClick={() => applySort(sort, !descending)}
            disabled={sort === "given" || sort === "manual"}
            title={descending ? t("batch.sortAsc") : t("batch.sortDesc")}
          >
            {descending ? "↓" : "↑"}
          </button>
          <span className="muted batch-order-hint">{t("batch.orderHint")}</span>
        </div>
        <div className="batch-list">
          {rows.map(({ entry, old, name, problem }, index) => (
            <div
              key={entry.path}
              className={`batch-row${problem ? " bad" : ""}${
                dragIndex === index ? " dragging" : ""
              }${overIndex === index && dragIndex !== index ? " over" : ""}`}
              title={entry.path}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(index);
              }}
              onDragLeave={() => setOverIndex((current) => (current === index ? null : current))}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
            >
              {/* The handle is a hint, not the only way: the whole row drags, and the arrows
                  are there for the nudge that a drag is too coarse for. */}
              <span className="batch-grip" aria-hidden="true">
                ⋮⋮
              </span>
              <span className="batch-old" title={old}>
                {old}
              </span>
              <span className="batch-arrow">→</span>
              {/* The name is ellipsized when it does not fit, so it carries its own title:
                  the row's title is the path, and the full name is what the user is checking. */}
              <span className="batch-new" title={name || undefined}>
                {name || "—"}
              </span>
              {problem && <span className="batch-problem">{problem}</span>}
              <span className="batch-move">
                <button
                  type="button"
                  draggable={false}
                  disabled={index === 0}
                  title={t("batch.moveUp")}
                  onClick={() => move(index, index - 1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  draggable={false}
                  disabled={index === rows.length - 1}
                  title={t("batch.moveDown")}
                  onClick={() => move(index, index + 1)}
                >
                  ↓
                </button>
              </span>
            </div>
          ))}
        </div>
        {unchanged && !invalid && <p className="muted batch-hint">{t("batch.unchanged")}</p>}
        <div className="modal-actions">
          <button
            className="btn primary"
            onClick={apply}
            disabled={invalid || unchanged || busy}
          >
            {t("batch.apply", { count: entries.length })}
          </button>
          <button className="btn" onClick={onCancel}>
            {t("close.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
