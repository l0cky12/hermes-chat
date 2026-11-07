import { Component, type ErrorInfo, type ReactNode } from "react";

type State = { error?: Error; where?: string };

/**
 * Catches an error thrown while React draws anything below it, so the window shows what went wrong and a way back
 * instead of going blank: without a boundary React unmounts the whole tree (ADR 0092). React reports the error to the
 * console as well, so Logs → This app keeps it. Try again draws the children anew with the app's state as it is;
 * `reload` (the page reload by default) starts the app over.
 */
export class ErrorBoundary extends Component<{ children: ReactNode; reload?: () => void }, State> {
  state: State = {};

  static getDerivedStateFromError(thrown: unknown): State {
    return { error: thrown instanceof Error ? thrown : new Error(String(thrown)) };
  }

  componentDidCatch(_: unknown, info: ErrorInfo) {
    this.setState({ where: info.componentStack ?? undefined });
  }

  render() {
    const { error, where } = this.state;
    if (!error) return this.props.children;
    const detail = `${error.stack && error.stack.includes(error.message) ? error.stack : `${error.name}: ${error.message}\n${error.stack ?? ""}`}${where ? `\n\nIn:${where}` : ""}`;
    return (
      <div className="restarting-overlay" role="alert">
        <div className="recovery-failed">
          <p>
            <strong>Hermes Chat ran into an error and couldn't draw the window.</strong>
          </p>
          <p className="crash-message">{error.message || error.name}</p>
          <details className="crash-details">
            <summary>Details</summary>
            <pre>{detail}</pre>
          </details>
          <p className="muted small">Try again draws the window once more, keeping your chats and drafts as they are. Reload starts the app over.</p>
          <div className="crash-actions">
            <button className="btn primary" onClick={() => this.setState({ error: undefined, where: undefined })}>
              Try again
            </button>
            <button className="btn" onClick={() => (this.props.reload ?? (() => location.reload()))()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
