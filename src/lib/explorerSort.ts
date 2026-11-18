// The Explorer's row orders: the keys the sort menu offers, and the comparison the tree
// draws with. The name comparison mirrors `name_order::natural_cmp` on the backend, so a
// folder reads in the same order whatever ties the listing was read in.

import type { FsEntry } from "./tauri";

export type ExplorerSortKey = "name" | "date" | "type" | "size";
export type ExplorerSortDir = "asc" | "desc";
export type ExplorerSort = `${ExplorerSortKey}-${ExplorerSortDir}`;

export const DEFAULT_EXPLORER_SORT: ExplorerSort = "name-asc";

/** Every order the menu offers, in the order it lists them. */
export const EXPLORER_SORTS: readonly ExplorerSort[] = [
  "name-asc",
  "name-desc",
  "date-desc",
  "date-asc",
  "type-asc",
  "type-desc",
  "size-desc",
  "size-asc",
];

/** A stored order, or the default for a value this build does not know. */
export function parseExplorerSort(value: string): ExplorerSort {
  return (EXPLORER_SORTS as readonly string[]).includes(value)
    ? (value as ExplorerSort)
    : DEFAULT_EXPLORER_SORT;
}

export function sortKeyOf(sort: ExplorerSort): ExplorerSortKey {
  return (sort.endsWith("-desc") ? sort.slice(0, -5) : sort.slice(0, -4)) as ExplorerSortKey;
}

export function sortDirOf(sort: ExplorerSort): ExplorerSortDir {
  return sort.endsWith("-desc") ? "desc" : "asc";
}

/**
 * The rows of one folder in `sort` order. Folders always come first: the tree mixes both,
 * and a file between two folders reads as a folder somebody forgot to expand. The direction
 * applies inside each group, and to the name breaks ties in every order.
 */
export function sortEntries(entries: readonly FsEntry[], sort: ExplorerSort): FsEntry[] {
  const key = sortKeyOf(sort);
  const sign = sortDirOf(sort) === "desc" ? -1 : 1;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return sign * compareWithin(a, b, key);
  });
}

function compareWithin(a: FsEntry, b: FsEntry, key: ExplorerSortKey): number {
  switch (key) {
    case "date":
      return a.mtime - b.mtime || naturalCompare(a.name, b.name);
    case "size":
      return a.bytes - b.bytes || naturalCompare(a.name, b.name);
    case "type":
      return compareText(extOf(a.name), extOf(b.name)) || naturalCompare(a.name, b.name);
    default:
      return naturalCompare(a.name, b.name);
  }
}

/**
 * Compare two names the way the backend listing reads them: stems first, extensions only as
 * a tie-break, digit runs by value — `IMG_2` before `IMG_10` — and everything else
 * case-insensitively by character.
 */
export function naturalCompare(left: string, right: string): number {
  const [leftStem, leftExt] = splitName(left);
  const [rightStem, rightExt] = splitName(right);
  return compareText(leftStem, rightStem) || compareText(leftExt, rightExt);
}

/** The name without a folder's trailing separator and without its extension. */
function splitName(name: string): [string, string] {
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const dot = trimmed.lastIndexOf(".");
  return dot <= 0 ? [trimmed, ""] : [trimmed.slice(0, dot), trimmed.slice(dot + 1)];
}

/** A folder's type order: the extension without the dot, so `.png` groups together. */
function extOf(name: string): string {
  return splitName(name)[1];
}

function compareText(left: string, right: string): number {
  const a = Array.from(left.toLowerCase());
  const b = Array.from(right.toLowerCase());
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a[i];
    const cb = b[j];
    if (isDigit(ca) && isDigit(cb)) {
      const aStart = i;
      const bStart = j;
      while (i < a.length && isDigit(a[i])) i++;
      while (j < b.length && isDigit(b[j])) j++;
      const aRun = a.slice(aStart, i).join("");
      const bRun = b.slice(bStart, j).join("");
      const aNum = aRun.replace(/^0+/, "") || "0";
      const bNum = bRun.replace(/^0+/, "") || "0";
      // Value first without parsing — a run of thirty digits still orders — then the
      // spelling, so `02` and `2` have a stable order of their own.
      const byValue =
        aNum.length - bNum.length || (aNum < bNum ? -1 : aNum > bNum ? 1 : 0);
      if (byValue) return byValue;
      if (aRun.length !== bRun.length) return aRun.length - bRun.length;
    } else {
      const order = ca.codePointAt(0)! - cb.codePointAt(0)!;
      if (order) return order;
      i++;
      j++;
    }
  }
  return a.length - b.length;
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
