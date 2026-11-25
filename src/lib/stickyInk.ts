/** One sRGB color, the way `getComputedStyle` reports it. */
export type Rgb = [number, number, number];

/** Paper ink, matching `.sticky-board` in the stylesheet. */
export const NOTE_INK_DARK: Rgb = [58, 56, 46];
/** What the writing turns to when the desktop behind the faded paper is dark. */
export const NOTE_INK_LIGHT: Rgb = [243, 237, 222];

/** Averaged pixels from the band of desktop around a board window. */
export interface BackdropSample {
  r: number;
  g: number;
  b: number;
}

function linear(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(color: Rgb): number {
  return 0.2126 * linear(color[0]) + 0.7152 * linear(color[1]) + 0.0722 * linear(color[2]);
}

/** WCAG contrast ratio: how many times darker the darker color is, in perceivable terms. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

/** Parses `rgb(...)` / `rgba(...)`; null when the value is anything else. */
export function rgbOf(value: string): Rgb | null {
  const parts = value.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

/**
 * Which ink reads best while the paper idles: the writing sits on the paper left at `alpha`,
 * composited onto the desktop behind the board, so both inks are weighed against that mix.
 */
export function noteInk(paper: Rgb, backdrop: Rgb, alpha: number): "light" | "dark" {
  const base: Rgb = [
    paper[0] * alpha + backdrop[0] * (1 - alpha),
    paper[1] * alpha + backdrop[1] * (1 - alpha),
    paper[2] * alpha + backdrop[2] * (1 - alpha),
  ];
  return contrastRatio(base, NOTE_INK_LIGHT) > contrastRatio(base, NOTE_INK_DARK)
    ? "light"
    : "dark";
}
