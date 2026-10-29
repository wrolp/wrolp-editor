import { useEffect, useMemo, useState } from "react";
import { foldPair, type FoldChange } from "../lib/diffFold";
import { sideKey, type ComparePair, type DiffStats } from "../lib/types";
import DiffView from "./DiffView";

interface Props {
  /** The comparison's whole texts, as the tab holds them. The fold never writes into this. */
  pair: ComparePair;
  /**
   * The tab's synthetic identity (`compare://left|right`). A new pair resets the fold; a refresh
   * of the same pair keeps it, because this value does not change when only the text is re-read.
   */
  identity: string;
  fontSize: number;
  renderWhitespace: "none" | "boundary" | "selection" | "all" | "trailing";
  wordWrap: boolean;
  tabSize: number;
  insertSpaces: boolean;
  detectIndentation: boolean;
  scrollBeyondLastLine: boolean;
  onStats: (stats: DiffStats) => void;
}

/**
 * A comparison tab's diff, with a fold that keeps only the changed lines.
 *
 * The fold cuts the whole texts by the ranges Monaco computed for those same whole texts, which is
 * why `changes` is collected only while the fold is off: once the models hold the truncated pair,
 * the ranges Monaco reports describe the truncation, and folding with them would cut a second time
 * from an already-cut text.
 */
export default function ComparePane({
  pair,
  identity,
  fontSize,
  renderWhitespace,
  wordWrap,
  tabSize,
  insertSpaces,
  detectIndentation,
  scrollBeyondLastLine,
  onStats,
}: Props) {
  const [fold, setFold] = useState(false);
  const [changes, setChanges] = useState<readonly FoldChange[] | null>(null);
  /**
   * Word wrap starts from the global setting and follows it when that setting changes, while a
   * click on the switch stays a per-view choice until then: wrapping is a question about what is
   * on screen, not about the file.
   */
  const [wrap, setWrap] = useState(wordWrap);
  useEffect(() => {
    setWrap(wordWrap);
  }, [wordWrap]);

  // A different pair is a different question: start unfolded and drop the ranges.
  useEffect(() => {
    setFold(false);
    setChanges(null);
  }, [identity]);
  // The same pair re-read: the ranges belonged to the text that was replaced.
  useEffect(() => {
    setChanges(null);
  }, [pair]);

  // The editor reports an empty change list on mount, before the diff is computed; that empty
  // list must not count as "nothing to fold", or the first real update would be discarded.
  const ready = !!changes && changes.length > 0;
  const folded = useMemo(
    () =>
      fold && ready && changes
        ? foldPair(pair.left.content, pair.right.content, changes)
        : null,
    [fold, ready, changes, pair]
  );
  const shown = useMemo<ComparePair>(
    () =>
      folded
        ? {
            left: { ...pair.left, content: folded.left },
            right: { ...pair.right, content: folded.right },
          }
        : pair,
    [folded, pair]
  );

  return (
    <DiffView
      // Keyed by the two sides' identities, so a different pair remounts and releases the models
      // it attached. Folding does not change either identity: the truncated text is written into
      // the same two models, which is what keeps the toggle from flashing.
      key={`${sideKey(pair.left.kind, pair.left.path, pair.left.oid)}|${sideKey(
        pair.right.kind,
        pair.right.path,
        pair.right.oid
      )}`}
      pair={shown}
      fontSize={fontSize}
      renderWhitespace={renderWhitespace}
      wordWrap={wrap}
      tabSize={tabSize}
      insertSpaces={insertSpaces}
      detectIndentation={detectIndentation}
      scrollBeyondLastLine={scrollBeyondLastLine}
      onStats={onStats}
      onChanges={fold && ready ? undefined : setChanges}
      fold={{
        on: fold,
        canFold: ready,
        hidden: folded?.folded
          ? { left: folded.hiddenLeft, right: folded.hiddenRight }
          : null,
        nothingHidden: fold && ready && !folded?.folded,
        onToggle: () => setFold((value) => !value),
      }}
      wrap={{ on: wrap, onToggle: () => setWrap((value) => !value) }}
    />
  );
}
