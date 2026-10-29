interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
});

export function IconSidebar({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

export function IconChevron({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function IconOpenFolder({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)} strokeLinecap="butt">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
    </svg>
  );
}

export function IconSettings({ size = 18 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/**
 * Explorer tree toggle. Points right while a folder is collapsed and is turned a
 * quarter turn clockwise (see `.tree-row.folder:not(.collapsed) .chev`) once expanded.
 */
export function IconTreeChevron({ size = 12 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.4}>
      <polyline points="9 5 16 12 9 19" />
    </svg>
  );
}

/** A comparison tab: two documents, side by side. */
export function IconCompare({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <rect x="3" y="4" width="8" height="16" rx="1.6" />
      <rect x="13" y="4" width="8" height="16" rx="1.6" />
    </svg>
  );
}

/** A commit: a dot on a history line. */
export function IconCommit({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <line x1="12" y1="3" x2="12" y2="8" />
      <circle cx="12" cy="12" r="3" />
      <line x1="12" y1="16" x2="12" y2="21" />
    </svg>
  );
}

/**
 * A file's versions: the points one save left behind on a rail, newest at the top. Deliberately
 * not a clock — that shape already means "recently opened" in the sidebar next to it.
 */
export function IconVersions({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <line x1="6" y1="5" x2="6" y2="20" />
      <circle cx="6" cy="6" r="1.9" />
      <circle cx="6" cy="13" r="1.9" />
      <line x1="10" y1="6" x2="19" y2="6" />
      <line x1="10" y1="13" x2="17" y2="13" />
      <line x1="10" y1="19.5" x2="19" y2="19.5" />
    </svg>
  );
}

/**
 * Show only the changes: two runs collapsing towards the middle line, which is what the control
 * does to a diff — the untouched stretches between the changed ones fold away.
 */
export function IconFold({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <line x1="4" y1="12" x2="20" y2="12" />
      <polyline points="8 8 12 4 16 8" />
      <polyline points="8 16 12 20 16 16" />
    </svg>
  );
}

/**
 * A line that continues on the next one instead of running off the edge: the top line turns back
 * at the right and comes down, arrow and all, onto the line below.
 */
export function IconWordWrap({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <path d="M3 6h14a3 3 0 0 1 0 6H6" />
      <polyline points="9 9 6 12 9 15" />
      <line x1="3" y1="18" x2="13" y2="18" />
    </svg>
  );
}

/** Git's view of a path, for the local-only state that lives outside the repository's history. */
export function IconEye({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </svg>
  );
}

/** Hidden from git's view: the same eye, struck through. */
export function IconEyeOff({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.6" />
      <line x1="4" y1="20" x2="20" y2="4" />
    </svg>
  );
}

/** Swap the two sides of a comparison: one line each way, arrowheads at opposite ends. */
export function IconSwap({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <line x1="4" y1="8" x2="18" y2="8" />
      <polyline points="15 5 18 8 15 11" />
      <line x1="20" y1="16" x2="6" y2="16" />
      <polyline points="9 13 6 16 9 19" />
    </svg>
  );
}

/**
 * Put a version back: an arrow turning back towards where the text came from. Not `IconReload` —
 * that one means "read this file again from the disk", which is a different direction of travel
 * and already sits in the tab's menu.
 */
export function IconRevert({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <polyline points="8 6 3 11 8 16" />
      <path d="M3 11h11a5 5 0 0 1 0 10h-4" />
    </svg>
  );
}

/** Window controls, drawn at 16px inside a 46×40 button: anything smaller reads as a
    smudge next to the 13px labels elsewhere in the bar. The stroke is deliberately heavy
    — at this size a hairline reads as a rendering glitch rather than a shape. */
export function IconMinimize({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.4}>
      <line x1="4" y1="19" x2="20" y2="19" />
    </svg>
  );
}

export function IconMaximize({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.4}>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </svg>
  );
}

/** Restore: the maximized box behind, the restored one in front of it. */
export function IconRestore({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.4}>
      <path d="M5 15V5h10" />
      <rect x="9" y="9" width="10" height="10" rx="1.5" />
    </svg>
  );
}

export function IconClose({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.4}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  );
}

export function IconGoUp({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.8}>
      <line x1="12" y1="20" x2="12" y2="5" />
      <polyline points="6 11 12 5 18 11" />
    </svg>
  );
}

export function IconFolder({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.6}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4L10 6.75h9.5A1.5 1.5 0 0 1 21 8.25V17.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11z" />
    </svg>
  );
}

export function IconFile({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.6}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

/** Editor only: lines of text, no preview pane. */
export function IconModeText({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <path d="M4 6h16M4 11h16M4 16h10" />
    </svg>
  );
}

/** Editor and preview side by side. */
export function IconModeSplit({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

/** Preview only: a rendered page. */
export function IconModePreview({ size = 16 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="4" y="3" width="16" height="18" rx="2" />
      <path d="M8 8h8M8 12h8M8 16h5" />
    </svg>
  );
}

/** A picture: a frame with a sun and a horizon, the shape a gallery is recognised by. */
export function IconImage({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="8.5" cy="9.5" r="1.4" />
      <path d="M21 15.5 15.5 10 5 20" />
    </svg>
  );
}

/** A new file: the document, with a plus where its contents would go. */
export function IconFilePlus({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.6}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
      <path d="M12 11v6M9 14h6" />
    </svg>
  );
}

/** A new encrypted file: the document of a new file, with the padlock that says what is in it. */
export function IconFileLock({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.6}>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5z" />
      <path d="M14 3v5h5" />
      <path d="M10.6 15v-1.2a1.4 1.4 0 0 1 2.8 0V15" />
      <rect x="9.1" y="15" width="5.8" height="4.2" rx="1" />
    </svg>
  );
}

/** A new folder: the folder, with the plus that says it does not exist yet. */
export function IconFolderPlus({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.6}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4L10 6.75h9.5A1.5 1.5 0 0 1 21 8.25V17.5A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11z" />
      <path d="M12 10v6M9 13h6" />
    </svg>
  );
}

/** Copy: the sheet behind is what is taken, the one in front is what is made. */
export function IconCopy({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-9A1.5 1.5 0 0 0 3 5.5v9A1.5 1.5 0 0 0 4.5 16" />
    </svg>
  );
}

/** Paste: the clipboard the copy is waiting on. */
export function IconPaste({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <rect x="4" y="4" width="16" height="17" rx="2" />
      <path d="M9 4V3a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v1" />
      <path d="M8 10h8M8 14h5" />
    </svg>
  );
}

/** Rename: a pencil, because the name is what is being written over. */
export function IconPencil({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <path d="M4 20h4L19 9l-4-4L4 16v4z" />
      <path d="M14.5 5.5l4 4" />
    </svg>
  );
}

export function IconTrash({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <path d="M4 7h16" />
      <path d="M9 7V4h6v3" />
      <path d="M6.5 7l1 13a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1l1-13" />
      <path d="M10 11v6M14 11v6" />
    </svg>
  );
}

/** Make this folder the one the Explorer shows: the rings a scope draws. */
export function IconTarget({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <circle cx="12" cy="12" r="8" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

/** Reload from disk: the same turn the refresh button makes, with a head on it. */
export function IconReload({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.8}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <polyline points="20 4 20 9 15 9" />
    </svg>
  );
}

/** Hand a tab to another group: an arrow leaving one place for another. */
export function IconMoveTo({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.8}>
      <path d="M4 12h15" />
      <polyline points="13 6 19 12 13 18" />
    </svg>
  );
}

/** The minimap: a shrunken copy of the document down one side of the editor. */
export function IconMinimap({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      <rect x="3" y="4" width="11" height="16" rx="1.6" />
      <path d="M17 8h4M17 12h4M17 16h4" />
    </svg>
  );
}

/**
 * A file under encryption.
 *
 * `locked` closes the shackle: the same shape says "this document is encrypted" and "this
 * document is encrypted *and* nobody here can read it yet", which is one distinction worth
 * carrying in the one glyph that has room for it in a tab.
 */
export function IconBranch({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="6" cy="5" r="2.2" />
      <circle cx="6" cy="19" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 7.2v9.6" />
      <path d="M18 11.2c0 3.4-3.6 4.4-7 4.9" />
    </svg>
  );
}

export function IconMerge({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <circle cx="6" cy="5" r="2" />
      <circle cx="6" cy="19" r="2" />
      <circle cx="18" cy="12" r="2" />
      <path d="M6 7v10" />
      <path d="M8 5h2a4 4 0 0 1 4 4v1" />
      <path d="M8 19h2a4 4 0 0 0 4-4v-1" />
    </svg>
  );
}

export function IconStage({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconUnstage({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function IconCheck({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={2.2}>
      <polyline points="5 12.5 9.5 17 19 7" />
    </svg>
  );
}

/**
 * Fetch: ask the remote for its refs and bring them down into this repository.
 *
 * The cloud is the remote; the arrow under it is the direction of travel. Neither neighbour's
 * shape is borrowed — `IconReload` owns the circular arrow (two of those side by side read as
 * the same button) and `IconPull` already draws a downward arrow onto a line. Kept to two bumps
 * and a flat base so the cloud still reads at 13px, where a wider one turns into a smudge.
 */
export function IconFetch({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)} strokeWidth={1.7}>
      {/* Drawn with cubics rather than arcs so the silhouette stays inside 5..19 × 3.9..10.6
          instead of bulging up to y≈0.6 — an arc through the same endpoints is taller than it
          looks, and the icon then sat high in the row. */}
      <path d="M7.4 10.6C5.8 10.6 4.8 9.3 5.3 7.8C5.8 6.3 7.4 5.7 8.6 6.3C9 4.6 10.5 3.6 12.3 3.9C14.1 4.2 15.4 5.4 15.8 7C17.4 6.6 18.8 7.6 19 9.1C19.1 10.1 18.5 10.6 17.6 10.6Z" />
      {/* The arrow reaches 19.8 of 24, the same floor Pull and Push use: a short stub left the
          icon reading as a cloud with a smudge under it. */}
      <path d="M12 11.4v8.4" />
      <polyline points="9 16.8 12 19.8 15 16.8" />
    </svg>
  );
}

export function IconPull({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <line x1="12" y1="4" x2="12" y2="15" />
      <polyline points="7.5 10.5 12 15 16.5 10.5" />
      <line x1="5" y1="20" x2="19" y2="20" />
    </svg>
  );
}

export function IconPush({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <line x1="12" y1="20" x2="12" y2="9" />
      <polyline points="7.5 13.5 12 9 16.5 13.5" />
      <line x1="5" y1="4" x2="19" y2="4" />
    </svg>
  );
}

export function IconStop({ size = 14 }: IconProps) {
  return (
    <svg {...base(size)}>
      <rect x="6" y="6" width="12" height="12" rx="1.5" />
    </svg>
  );
}

export function IconLock({ size = 14, locked = true }: IconProps & { locked?: boolean }) {
  return (
    <svg {...base(size)} strokeWidth={1.8}>
      <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
      {locked ? (
        <path d="M8 10.5V7.5a4 4 0 0 1 8 0v3" />
      ) : (
        <path d="M8 10.5V7.5a4 4 0 0 1 7.5-1.9" />
      )}
    </svg>
  );
}
