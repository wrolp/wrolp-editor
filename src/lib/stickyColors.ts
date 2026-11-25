/** As many swatches as a group holds; the backend clamps to the same number. */
export const STICKY_COLORS_MAX = 8;

/** Paper colors a fresh install starts with; the backend's default list matches. */
export const DEFAULT_STICKY_COLORS = [
  "#f6f0c7",
  "#f2ded2",
  "#e3edd9",
  "#dbe6f1",
  "#e9ddef",
];

/** The palette a board actually draws from; an empty setting falls back to the defaults. */
export function stickyPalette(colors: string[] | undefined): string[] {
  return colors && colors.length > 0 ? colors : DEFAULT_STICKY_COLORS;
}

/**
 * One note's paper: a stable pick from the group, by the note's path. Hashing keeps a note on
 * the same color across reloads, while different paths spread over the group on one board.
 */
export function stickyColorOf(palette: string[], path: string): string {
  let sum = 0;
  for (let i = 0; i < path.length; i += 1) sum = (sum + path.charCodeAt(i)) % 997;
  return palette[sum % palette.length];
}
