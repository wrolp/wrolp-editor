import { Component, type ReactNode } from "react";
import { t, translateError } from "../lib/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: string | null;
}

/**
 * A crash inside a lazily-loaded pane must not take the whole window white. There is no
 * boundary anywhere else around the preview panes, so one bad chunk — or a render that throws
 * on a PDF the reader does not expect — would otherwise unmount the entire tree.
 */
export default class PaneErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="pdf-error">{t("pdf.error", { detail: translateError(this.state.error) })}</div>
      );
    }
    return this.props.children;
  }
}
