import { useEffect, useRef, useState } from "react";
import HoverTip, { type TipSpot } from "./HoverTip";

/** How long the pointer has to rest before the bubble appears. */
const TIP_DELAY_MS = 500;

/**
 * How far the bubble starts from the pointer when it is anchored to the cursor.
 *
 * Wide enough that the pointer's own glyph — drawn from its hotspot to the right and down —
 * cannot sit on top of the bubble. The bubble also starts below the row, so the name it is
 * describing stays readable while it is being described.
 */
const POINTER_GAP = 18;

/** Roughly the tallest a two-line bubble gets; used only to decide whether it goes above. */
const TIP_HEIGHT = 60;

/** The CSS max-width plus a little breathing room, for deciding the bubble's side. */
const WIDEST_TIP = 444;

interface Shown {
  spot: TipSpot;
  name: string;
  detail: string;
}

/**
 * Every hover hint in the app, drawn in the app's own bubble.
 *
 * A native `title` renders one unstyled string in an OS-drawn bubble: light in a dark theme,
 * no second line for a path, no styling at all. This layer takes the attribute away as soon
 * as it enters the DOM — removing it when the hover begins is too late, because the OS bubble
 * is already scheduled with the text it read — and remembers the words as `data-tip` on the
 * same element. Rows that want the two-line shape carry `data-tip` / `data-tip-detail`
 * directly, and `data-tip-anchor="below"` hangs their bubble under the element rather than
 * beside the cursor, which is what a strip of tabs wants.
 *
 * Because there is one owner of every bubble, the two used to appear at once: resting on a
 * close button inside a row armed the row's own bubble too. Now the closest hint — the
 * button's — is the only one drawn. A control inside a hinting row can still opt out with
 * `data-tip-skip`, and a container can silence the hints under it with `data-tip-off`.
 */
export default function GlobalTip() {
  const [tip, setTip] = useState<Shown | null>(null);
  /** The element whose hint is armed or drawn, so a pointer leaving it is noticed. */
  const host = useRef<HTMLElement | null>(null);
  const pending = useRef<number | undefined>(undefined);

  useEffect(() => {
    /** Moves every `title` under `root` (itself included) into `data-tip`. */
    const adopt = (root: Element) => {
      const nodes: Element[] = [root, ...Array.from(root.querySelectorAll("[title]"))];
      for (const el of nodes) {
        // A frame's title is accessibility metadata, not a hover hint: an OS bubble never
        // draws one either, so it stays where it is.
        if (el instanceof HTMLIFrameElement) continue;
        const title = el.getAttribute("title");
        if (title === null) continue;
        el.removeAttribute("title");
        // Taken as the later word when a re-render hands over a new one: the `title` an
        // element is given is the hint its owner means, however often that changes.
        el.setAttribute("data-tip", title);
      }
    };
    adopt(document.documentElement);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === "attributes") {
          if (record.target instanceof Element) adopt(record.target);
          continue;
        }
        for (const node of Array.from(record.addedNodes)) {
          if (node instanceof Element) adopt(node);
        }
      }
    });
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["title"],
    });

    const drop = () => {
      window.clearTimeout(pending.current);
      pending.current = undefined;
      host.current = null;
      setTip(null);
    };

    /** The hint a hovered node asks for: the closest `data-tip`, and its text. */
    const hintAt = (target: Element) => {
      if (target.closest("[data-tip-skip]")) return null;
      const el = target.closest<HTMLElement>("[data-tip]");
      if (!el || el.closest("[data-tip-off]")) return null;
      return {
        el,
        name: el.dataset.tip ?? "",
        detail: el.dataset.tipDetail ?? "",
        below: el.dataset.tipAnchor === "below",
      };
    };

    const arm = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return drop();
      const hint = hintAt(target);
      if (!hint || (!hint.name && !hint.detail)) return drop();
      // The same element (or the same row, under a different child) is already armed; its
      // timer keeps running rather than restarting on every element crossed inside it.
      if (hint.el === host.current) return;

      drop();
      host.current = hint.el;

      const rect = hint.el.getBoundingClientRect();
      const alignEnd = event.clientX > window.innerWidth - WIDEST_TIP;
      const spot: TipSpot = hint.below
        ? { x: event.clientX, y: rect.bottom, alignEnd }
        : {
            // Beside the cursor, never under it. Near the right edge the bubble is mirrored
            // to its other side rather than pushed off the window.
            x: alignEnd ? event.clientX - 8 : event.clientX + POINTER_GAP,
            // Under the element rather than at the cursor's height: a bubble starting inside
            // the row would sit on the rest of the name. Above it only when the bottom of
            // the window is too close for a full bubble.
            y:
              rect.bottom + TIP_HEIGHT > window.innerHeight
                ? Math.max(8, rect.top - TIP_HEIGHT)
                : rect.bottom,
            alignEnd,
          };
      pending.current = window.setTimeout(
        () => setTip({ spot, name: hint.name, detail: hint.detail }),
        TIP_DELAY_MS
      );
    };

    const leave = (event: PointerEvent) => {
      const el = host.current;
      if (el && event.relatedTarget instanceof Node && el.contains(event.relatedTarget)) return;
      drop();
    };

    document.addEventListener("pointerover", arm);
    document.addEventListener("pointerout", leave);
    document.addEventListener("pointerdown", drop, true);
    // Any of these moves or changes what is under a fixed bubble, so it goes rather than
    // hanging over content it was never about.
    document.addEventListener("keydown", drop, true);
    document.addEventListener("dragstart", drop, true);
    window.addEventListener("wheel", drop, true);
    window.addEventListener("scroll", drop, true);
    window.addEventListener("blur", drop);
    return () => {
      observer.disconnect();
      drop();
      document.removeEventListener("pointerover", arm);
      document.removeEventListener("pointerout", leave);
      document.removeEventListener("pointerdown", drop, true);
      document.removeEventListener("keydown", drop, true);
      document.removeEventListener("dragstart", drop, true);
      window.removeEventListener("wheel", drop, true);
      window.removeEventListener("scroll", drop, true);
      window.removeEventListener("blur", drop);
    };
  }, []);

  return <HoverTip spot={tip?.spot ?? null} name={tip?.name ?? ""} detail={tip?.detail ?? ""} />;
}
