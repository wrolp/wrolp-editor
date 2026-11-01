/**
 * The arithmetic the two zoom boxes share: the reader's page and the picture's pane ask the same
 * question of the same pair of buttons, and answering it twice would let the two answers drift.
 */

/** The number a size box shows: the pinned percentage, or what fitting comes to instead. */
export function zoomText(zoom: number | null, fitPercent: number): string {
  if (zoom !== null) return String(zoom);
  return fitPercent > 0 ? String(fitPercent) : "";
}

/**
 * The next rung of `steps` in `direction`, for a percentage that may not be on the ladder.
 *
 * A typed size sits between two rungs; stepping from it lands on the neighbouring one rather
 * than snapping back to 100. A size already past the end of the ladder stays where it is, which
 * is what the matching end of the ladder means for a number the buttons did not choose.
 */
export function stepFrom(steps: number[], current: number, direction: 1 | -1): number {
  const at = steps.indexOf(current);
  if (at >= 0) return steps[Math.min(steps.length - 1, Math.max(0, at + direction))];
  if (direction === 1) return steps.find((step) => step > current) ?? current;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i] < current) return steps[i];
  }
  return current;
}
