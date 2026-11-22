/**
 * How a date cell is printed, wherever a sheet is read.
 *
 * A workbook keeps its dates as serial day counts under a number format the author chose, so
 * the same day arrives as `9/8/26`, `2026-09-08` or `08-Sep-26` depending on the file. The
 * viewer prints one shape instead: `yyyy-mm-dd`, and `hh:mm:ss` after it only when the value
 * carries a time of day. Two dates are then comparable at a glance, which is the whole point
 * of showing a date rather than the cell's style.
 */

/** A day on its own. */
export const DATE_FORMAT = "yyyy-mm-dd";
/** A day with the time it was written with. */
export const DATE_TIME_FORMAT = "yyyy-mm-dd hh:mm:ss";

/** Whether a serial (days since the workbook's epoch) carries a time of day. */
export function hasTimeOfDay(serial: number): boolean {
  // A serial's fraction is the time; the epsilon covers the binary error of a whole second.
  return Math.abs(serial % 1) > 1e-9;
}

/** The format code to print a date serial with. */
export function dateFormatFor(serial: number): string {
  return hasTimeOfDay(serial) ? DATE_TIME_FORMAT : DATE_FORMAT;
}

/**
 * Whether a number format is a date.
 *
 * `SSF.is_date` is what SheetJS itself uses, and it is not in the published typings: the two
 * readers here reach it through this one place rather than each casting the module.
 */
export function looksLikeDate(ssf: unknown, code: string | number | undefined): boolean {
  if (code === undefined) return false;
  const isDate = (ssf as { is_date?: (format: string | number) => boolean }).is_date;
  return typeof isDate === "function" && isDate(code);
}
