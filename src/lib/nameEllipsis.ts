/**
 * Where a name wider than its row loses characters: the middle, or the end.
 *
 * `middle` keeps both ends — the beginning of a name, and its end, which is where the
 * extension sits and where two similar names usually differ. `end` is what a stylesheet
 * does on its own with `text-overflow: ellipsis`.
 */
export type NameEllipsis = "middle" | "end";

/** The one character that stands for what was cut, whatever script the name is written in. */
export const ELLIPSIS = "…";

/**
 * One canvas for every measurement in the app. A measurement is a few `measureText` calls,
 * but a canvas of its own per row is an allocation per row on a folder that can hold
 * thousands.
 */
let meter: HTMLCanvasElement | null = null;

/**
 * `text` cut in the middle until it fits `width` pixels in the font `el` is drawn in.
 *
 * The width is taken from the element rather than worked out from the sidebar's width: the
 * row's indentation, its icon, its git badge and the column's own size all move that number,
 * and the browser has already added them up.
 *
 * The last dot-segment is kept whole — that is the extension, and it is what says what the
 * file is — and what is left of the name is halved between its two ends. Measuring rather
 * than counting characters is what makes this work in a proportional font.
 */
export function cutMiddle(el: HTMLElement, text: string, width: number): string {
  if (!meter) meter = document.createElement("canvas");
  const ctx = meter.getContext("2d");
  if (!ctx) return text;
  const style = getComputedStyle(el);
  // Built from the longhands: a computed style does not always serialize `font` back out,
  // and an unset font is measured in the browser's default rather than the row's.
  ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  const fits = (candidate: string) => ctx.measureText(candidate).width <= width;
  if (fits(text)) return text;

  // Code points rather than UTF-16 units, so half an emoji never ends up on screen.
  const chars = Array.from(text);
  // A leading dot belongs to the name (`.gitignore`), not to an extension.
  let dot = -1;
  for (let i = chars.length - 1; i > 0; i -= 1) {
    if (chars[i] === ".") {
      dot = i;
      break;
    }
  }
  // Only the last segment counts, and only while it is short enough to be one: the dot in
  // `report.final-version-2026` is punctuation inside the name, not a file type.
  const tail = dot > 0 && chars.length - dot <= 12 ? chars.length - dot : 0;
  const stem = chars.length - tail;
  const ext = chars.slice(stem).join("");
  if (!fits(ELLIPSIS + ext)) return ELLIPSIS;

  // The longest head and tail that still fit, found by bisection: the width only grows with
  // the number of characters kept.
  let low = 0;
  let high = stem;
  let cut = ELLIPSIS + ext;
  while (low <= high) {
    const keep = (low + high) >> 1;
    const head = keep - (keep >> 1);
    const back = keep >> 1;
    const candidate =
      chars.slice(0, head).join("") +
      ELLIPSIS +
      chars.slice(stem - back, stem).join("") +
      ext;
    if (fits(candidate)) {
      cut = candidate;
      low = keep + 1;
    } else {
      high = keep - 1;
    }
  }
  return cut;
}
