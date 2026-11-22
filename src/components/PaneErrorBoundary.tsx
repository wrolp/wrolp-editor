import { Component, type ErrorInfo, type ReactNode } from "react";
import { t, translateError } from "../lib/i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: string | null;
  /** Where the throw came from, as the browser recorded it; null when it had no stack. */
  stack: string | null;
}

/** `String(error)` on a value with no primitive conversion throws again; that is not a message. */
function describe(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error);
  } catch {
    return "unprintable error";
  }
}

function stackOf(error: unknown): string | null {
  const stack = error instanceof Error ? error.stack : null;
  return stack && stack.trim() ? stack : null;
}

/**
 * A crash inside a lazily-loaded pane must not take the whole window white. There is no
 * boundary anywhere else around the preview panes, so one bad chunk — or a render that throws
 * on a document the renderer does not expect — would otherwise unmount the entire tree.
 *
 * The pane is drawn by a renderer this app does not own, so the throw is kept, stack and all,
 * behind a folded "details": a screenshot of one sentence says nothing about which document,
 * which viewer, or which of the two threw it. The sentence itself is the pane's, not the PDF
 * reader's — a spreadsheet that cannot be drawn is not a PDF that could not be opened.
 */
export default class PaneErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error: describe(error), stack: stackOf(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // The console keeps what the folded details cannot: the component stack.
    console.error("[pane]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="pdf-error">
          {t("pane.error", { detail: translateError(this.state.error) })}
          {this.state.stack && (
            <details className="pane-error-more">
              <summary>{t("pane.errorDetails")}</summary>
              <pre>{this.state.stack}</pre>
            </details>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}
