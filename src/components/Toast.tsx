interface Props {
  message: string;
  visible: boolean;
  /**
   * A pointer resting on the toast holds it up — a message worth reading is a message worth
   * keeping on screen — and leaving it is what lets it go.
   */
  onHold: () => void;
  onRelease: () => void;
}

export default function Toast({ message, visible, onHold, onRelease }: Props) {
  return (
    <div
      className={`toast${visible ? " show" : ""}`}
      role="status"
      onMouseEnter={onHold}
      onMouseLeave={onRelease}
    >
      {message}
    </div>
  );
}
