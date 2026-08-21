import { Component } from 'react';
import { Button } from '@/components/ui/button';

// React error boundaries must be class components — there's no Hook
// equivalent (no "useErrorBoundary"). This catches render-phase errors
// thrown anywhere below it in the tree; it does NOT catch errors in event
// handlers, async code, or Suspense-loading failures — those still need
// their own try/catch or .catch().
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    // Always log to the console for local/dev debugging.
    // Integration point: wire a real error-tracking service (Sentry, etc.)
    // here in production — e.g. Sentry.captureException(error, { extra: errorInfo }).
    // Left as a plain console.error since that integration is out of scope
    // for this build.
    console.error('ErrorBoundary caught:', error, errorInfo);
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    const { hasError } = this.state;
    const { fallback: Fallback, children } = this.props;

    if (hasError) {
      // Allows a smaller inline fallback when wrapped around a single risky
      // widget (e.g. a chart) instead of the full-page default below.
      if (Fallback) {
        return <Fallback onReset={this.handleReset} />;
      }

      return (
        <div className="min-h-screen flex items-center justify-center p-6">
          <div className="card max-w-md w-full text-center space-y-4">
            <p className="text-5xl">⚠️</p>
            <h1 className="text-xl font-semibold text-gray-900">
              Something went wrong
            </h1>
            <p className="text-sm text-gray-500">
              An unexpected error occurred while rendering this page. You can
              try again, or head back to the dashboard.
            </p>
            {/* Raw error.stack is intentionally never rendered here — that
                detail belongs in the console / an error-tracking service,
                not in front of the end user. */}
            <div className="flex items-center justify-center gap-3 pt-2">
              <Button onClick={this.handleReset}>Try Again</Button>
              <a
                href="/admin"
                className="text-sm text-primary-600 hover:underline"
              >
                Go to Dashboard
              </a>
            </div>
          </div>
        </div>
      );
    }

    return children;
  }
}
