/**
 * Turns a page of commits into rows of a graph: which column each commit's dot sits in, which
 * columns have a line crossing the row, and where a merge's extra parents connect.
 *
 * The input must be in topological order (child before parent), which is what `git_log` asks
 * libgit2 for: a row only ever draws edges downwards, and a lane is booked by the commit that
 * first asked for it.
 *
 * Pagination is the reason this is a pure function with a carry: a page ends in the middle of a
 * lane that is still waiting for a parent, and the next page has to continue from exactly that
 * state rather than restart the layout. Pass the returned `carry` back in on the next page;
 * discard it when the list is refreshed.
 */

/** The lane state between two pages: what each column is still waiting for, `null` when free. */
export interface LaneState {
  lanes: (string | null)[];
}

export interface GraphRow {
  /** Column the commit's dot is drawn in. */
  lane: number;
  /** Columns needed at this row, `1` when there is a single line. */
  lanes: number;
  /** A line comes into the dot from the row above. False for a branch's first commit. */
  incoming: boolean;
  /** Columns with a line crossing the whole row, from the top edge to the bottom edge. */
  pass: number[];
  /** Columns a non-first parent connects to, drawn as a diagonal from the dot to the bottom. */
  merges: number[];
  /** A line leaves the dot straight down: the first parent continues in the same column. */
  continues: boolean;
}

export interface GraphLayout {
  rows: GraphRow[];
  carry: LaneState;
}

/** The least this needs from a log entry, so a test can hand in plain objects. */
export interface GraphCommit {
  oid: string;
  parents: string[];
}

/**
 * Lay out `entries`, continuing from `carry` when it is the next page of the same list.
 *
 * A lane is booked by the commit that first needs it: the first time an oid is seen it takes the
 * leftmost free column, and each of its parents either inherits that column (the first parent) or
 * takes one of its own (a merge). A parent that is already booked elsewhere — the two sides of a
 * criss-cross merge, or a branch that another row introduced first — is joined where it already
 * is instead of opening a second column for the same line.
 */
export function buildGraph(entries: GraphCommit[], carry?: LaneState): GraphLayout {
  const lanes: (string | null)[] = [...(carry?.lanes ?? [])];
  const rows: GraphRow[] = [];

  for (const entry of entries) {
    let lane = lanes.indexOf(entry.oid);
    const incoming = lane >= 0;
    if (!incoming) {
      lane = firstFree(lanes);
      lanes[lane] = null;
    }

    // Every column that is busy above this row and still busy below it carries a line straight
    // through. Taken before the commit consumes its own lane, so the dot's column is not counted.
    const busy = lanes
      .map((waiting, index) => (waiting !== null && index !== lane ? index : -1))
      .filter((index) => index >= 0);

    // The commit answers whatever this column was waiting for.
    lanes[lane] = null;

    const [first, ...rest] = entry.parents;
    let continues = false;
    const merges: number[] = [];
    if (first !== undefined) {
      const existing = lanes.indexOf(first);
      if (existing >= 0) {
        // The parent is already booked by another row — the two sides of a criss-cross merge
        // both reach it. Joining it there is the only honest answer; booking it twice would
        // draw the same line in two columns.
        merges.push(existing);
      } else {
        lanes[lane] = first;
        continues = true;
      }
    }
    for (const parent of rest) {
      const existing = lanes.indexOf(parent);
      if (existing >= 0) {
        merges.push(existing);
        continue;
      }
      const target = firstFree(lanes);
      lanes[target] = parent;
      merges.push(target);
    }

    const pass = busy.filter((index) => lanes[index] !== null);
    const width = Math.max(
      lane + 1,
      ...pass.map((index) => index + 1),
      ...merges.map((index) => index + 1)
    );

    rows.push({
      lane,
      lanes: width,
      incoming,
      pass,
      merges,
      continues,
    });

    // Trailing empty columns are not lanes: dropping them keeps the row narrow without moving
    // any column that is still in use.
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }
  }

  return { rows, carry: { lanes } };
}

/** The leftmost free column, or a new one on the right. */
function firstFree(lanes: (string | null)[]): number {
  const free = lanes.indexOf(null);
  if (free >= 0) return free;
  lanes.push(null);
  return lanes.length - 1;
}
