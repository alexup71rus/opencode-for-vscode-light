import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, message: "" };
  }

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    const message = err instanceof Error ? err.message : String(err);
    return { hasError: true, message };
  }

  componentDidCatch(error: unknown, info: React.ErrorInfo): void {
    console.error("[opencode] render error:", error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ hasError: false, message: "" });
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div className="app-root">
          <div className="error-boundary">
            <div className="error-boundary-icon">⚠</div>
            <div className="error-boundary-title">Something went wrong</div>
            <div className="error-boundary-message">{this.state.message}</div>
            <button className="btn btn-primary" onClick={this.handleReset}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
