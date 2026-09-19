import { Component, type ErrorInfo, type ReactNode } from "react";
import { Link, useLocation } from "react-router-dom";

// React still has no hook equivalent of componentDidCatch, so the boundary
// itself is a class. It catches render/lifecycle errors below it and shows a
// recoverable fallback instead of a blank page. Errors inside event handlers
// and async code are not caught here — those paths already report via state.
interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("Unhandled render error", error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="mc">
        <p className="list-msg is-error" role="alert">
          Something went wrong: {error.message || String(error)}
        </p>
        <p className="list-msg">
          <button
            type="button"
            className="btn-secondary"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>{" "}
          <Link className="detail-back" to="/">
            ← Back to candidates
          </Link>
        </p>
      </main>
    );
  }
}

/**
 * App-level error boundary that resets whenever the route changes, so
 * navigating away from a broken page (e.g. via the Back link above) recovers
 * without a full reload. Must render inside the router.
 */
export default function RouteErrorBoundary({ children }: Props) {
  const location = useLocation();
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>;
}
