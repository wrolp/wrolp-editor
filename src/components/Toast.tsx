interface Props {
  message: string;
  visible: boolean;
}

export default function Toast({ message, visible }: Props) {
  return (
    <div className={`toast${visible ? " show" : ""}`} role="status">
      {message}
    </div>
  );
}
