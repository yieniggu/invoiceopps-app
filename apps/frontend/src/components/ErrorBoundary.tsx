import { Component, type ErrorInfo, type ReactNode } from "react";

function reloadPage() {
  window.location.reload();
}

/**
 * Catches a render error (or a lazy chunk that failed to load, typically after
 * a redeploy replaced the hashed files) and offers the only useful recovery: a
 * reload. The rest of the app stays mounted around a route-level boundary.
 * One signal: a short alert and one button; nothing is retried automatically.
 */
export class ErrorBoundary extends Component<
  {
    children: ReactNode;
    /** What went wrong, in one short sentence. */
    message: string;
    /** Test seam; production reloads the page. */
    onReload?: () => void;
  },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // Class and component stack only: never the message, it may carry data.
    console.error("ui.render_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="screen-stack">
        <p role="alert">{this.props.message}</p>
        <button type="button" onClick={this.props.onReload ?? reloadPage}>
          Recargar
        </button>
      </div>
    );
  }
}
