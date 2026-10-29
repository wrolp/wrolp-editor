/**
 * The colour a one-letter git status badge carries.
 *
 * Shared by the Source Control panel and the commit tab so a path does not change appearance
 * between the list it was picked from and the commit it belongs to.
 */
export function badgeTone(letter: string): string {
  switch (letter) {
    case "A":
    case "?":
      return "add";
    case "D":
      return "del";
    case "R":
    case "C":
      return "ren";
    case "U":
      return "conflict";
    case "T":
      return "type";
    default:
      return "mod";
  }
}
