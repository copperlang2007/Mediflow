import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { AlertTriangle, RefreshCw } from "lucide-react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[ErrorBoundary]", error, info.componentStack);
    // A stale index.html (cached before a redeploy) references hashed bundles
    // that no longer exist, so lazy route imports reject. Reload once to fetch
    // the fresh index.html with current asset hashes.
    if (ErrorBoundary.isChunkLoadError(error) && !ErrorBoundary.hasReloadedForChunkError()) {
      try {
        sessionStorage.setItem(ErrorBoundary.RELOAD_FLAG, String(Date.now()));
      } catch {
        // sessionStorage unavailable — skip reload to avoid a loop.
        return;
      }
      window.location.reload();
    }
  }

  static RELOAD_FLAG = "mediflow:staleAssetReload";

  static isChunkLoadError(error: Error | null): boolean {
    if (!error) return false;
    const message = error.message || "";
    const name = error.name || "";
    return (
      name === "ChunkLoadError" ||
      /Failed to fetch dynamically imported module/i.test(message) ||
      /error loading dynamically imported module/i.test(message) ||
      /Loading chunk \S+ failed/i.test(message) ||
      /Importing a module script failed/i.test(message)
    );
  }

  static hasReloadedForChunkError(): boolean {
    try {
      return Boolean(sessionStorage.getItem(ErrorBoundary.RELOAD_FLAG));
    } catch {
      return true;
    }
  }

  handleReset = (): void => {
    if (ErrorBoundary.isChunkLoadError(this.state.error)) {
      try { sessionStorage.removeItem(ErrorBoundary.RELOAD_FLAG); } catch { /* ignore */ }
      window.location.reload();
      return;
    }
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) return this.props.fallback;

      return (
        <div className="flex flex-col items-center justify-center min-h-[40vh] p-8 text-center">
          <div className="h-14 w-14 rounded-full bg-destructive/10 flex items-center justify-center mb-4">
            <AlertTriangle className="h-7 w-7 text-destructive" />
          </div>
          <h2 className="text-lg font-semibold text-foreground mb-2">Something went wrong</h2>
          <p className="text-sm text-muted-foreground mb-1 max-w-sm">
            An unexpected error occurred loading this section.
          </p>
          {this.state.error?.message && (
            <code className="text-xs bg-muted px-2 py-1 rounded mt-1 text-muted-foreground max-w-sm truncate block">
              {this.state.error.message}
            </code>
          )}
          <Button
            variant="outline"
            size="sm"
            className="mt-5"
            onClick={this.handleReset}
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
