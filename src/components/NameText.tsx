import { useLayoutEffect, useRef } from "react";
import { cutMiddle, type NameEllipsis } from "../lib/nameEllipsis";

interface Props {
  name: string;
  mode: NameEllipsis;
  /** The class the label is drawn with, e.g. the tree's `tn` or a tab's `tab-name`. */
  className?: string;
  /**
   * Keep the width the whole name would take while showing a cut one.
   *
   * A row does not need this: its width comes from the column around it. A tab is sized by its
   * content, so replacing the text in place narrows the tab, and the next measurement cuts a
   * little more — measured in the repro, a long name lost a character per frame and ended on a
   * bare ellipsis. The hidden copy stays in flow to hold the width, and the cut text is drawn
   * over it.
   */
  pinned?: boolean;
}

/**
 * A name, shortened in the middle or at the end, measured against the space it is given.
 *
 * What to cut is never state: the text is written straight to the node, because a cut is not a
 * new value the app has to render — an observer callback that set state would repaint the whole
 * row a frame later, for a name that was already on screen.
 */
export default function NameText({ name, mode, className, pinned = false }: Props) {
  const boxRef = useRef<HTMLSpanElement>(null);
  const cutRef = useRef<HTMLSpanElement>(null);
  // Only a middle cut needs the pinned layout: `end` is what `text-overflow` already does.
  const ghost = pinned && mode === "middle";

  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    // A row writes into the node it measures; a pinned tab measures the wrapper — sized by the
    // hidden copy — and writes into the copy drawn over it.
    const target = ghost ? cutRef.current : box;
    if (!target) return;
    const fit = () => {
      // `end`, and any row whose width is not known yet, is the stylesheet's own
      // `text-overflow`: the name is written out whole and the browser draws the ellipsis.
      // A width of 0 means the row is outside the viewport and skipped (`content-visibility`),
      // and cutting every one of those down to the ellipsis would be worse than the full name.
      const width = mode === "middle" ? box.getBoundingClientRect().width : 0;
      // A row keeps a pixel so its own cut never touches the edge; a pinned tab is already
      // sized by the whole name, and taking one away there would cut a name that fits.
      const next = width > 1 ? cutMiddle(box, name, ghost ? width : width - 1) : name;
      if (target.textContent !== next) target.textContent = next;
    };
    fit();
    if (mode !== "middle") return;
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [name, mode, ghost]);

  return (
    <span
      ref={boxRef}
      className={className ? `${className}${ghost ? " pinned" : ""}` : undefined}
    >
      {ghost ? (
        <>
          {/* What the tab would be wide without any cutting, kept out of sight. */}
          <span className="name-ghost" aria-hidden="true">
            {name}
          </span>
          <span className="name-cut" ref={cutRef} />
        </>
      ) : (
        name
      )}
    </span>
  );
}
