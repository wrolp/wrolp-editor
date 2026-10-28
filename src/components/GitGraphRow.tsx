import type { GraphRow } from "../lib/gitGraph";

/**
 * One row of the commit graph: a dot for the commit, lines for the lanes crossing the row, and a
 * curve for every extra parent of a merge.
 *
 * The height is a constant rather than derived from the row's text: consecutive rows butt against
 * each other, and a line that stops one pixel short reads as a broken branch. The stylesheet gives
 * `.git-log-row` the same height for that reason.
 */
export const GRAPH_ROW_HEIGHT = 22;
const LANE_WIDTH = 10;
const DOT_RADIUS = 2.5;

interface Props {
  row: GraphRow;
  /** HEAD points here, so the dot gets a ring: the one tip that moves when you commit. */
  head: boolean;
  /** Names on this commit, used as the cell's tooltip. */
  names: string;
}

export default function GraphCell({ row, head, names }: Props) {
  const width = Math.max(1, row.lanes) * LANE_WIDTH;
  const height = GRAPH_ROW_HEIGHT;
  const mid = (lane: number) => lane * LANE_WIDTH + LANE_WIDTH / 2;
  const middle = height / 2;
  const dotX = mid(row.lane);
  const laneClass = (lane: number) => `lane-${lane % 8}`;

  return (
    <span className="git-graph" style={{ width }} title={names || undefined}>
      <svg width={width} height={height} aria-hidden="true">
        {row.pass.map((lane) => (
          <path key={`pass-${lane}`} className={`g-line ${laneClass(lane)}`} d={`M${mid(lane)} 0V${height}`} />
        ))}
        {row.incoming && <path className={`g-line ${laneClass(row.lane)}`} d={`M${dotX} 0V${middle}`} />}
        {row.continues && (
          <path className={`g-line ${laneClass(row.lane)}`} d={`M${dotX} ${middle}V${height}`} />
        )}
        {row.merges.map((lane, index) => (
          <path
            key={`merge-${lane}-${index}`}
            className={`g-line ${laneClass(lane)}`}
            d={`M${dotX} ${middle} C ${dotX} ${height * 0.8}, ${mid(lane)} ${height * 0.8}, ${mid(lane)} ${height}`}
          />
        ))}
        {head && <circle className="g-ring" cx={dotX} cy={middle} r={DOT_RADIUS + 2} />}
        <circle className={`g-dot ${laneClass(row.lane)}`} cx={dotX} cy={middle} r={DOT_RADIUS} />
      </svg>
    </span>
  );
}
