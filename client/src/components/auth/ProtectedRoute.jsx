import { Outlet } from 'react-router-dom';
import useAuth from '@/hooks/useAuth';
import PageLoadingFallback from '@/components/common/PageLoadingFallback';

// There's no /login route to redirect to anymore — AuthContext signs
// the app in automatically on mount. This just gates rendering until
// that resolves, and shows a plain error (rather than a redirect loop)
// on the rare case that silent auto-login itself fails.
export default function ProtectedRoute() {
  const { isAuthenticated, isLoading, authError } = useAuth();

  if (isLoading) return <PageLoadingFallback />;

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center p-6">
        <div className="card w-full max-w-sm space-y-2 text-center">
          <h1 className="text-lg font-semibold text-gray-900">Couldn't sign in</h1>
          <p className="text-sm text-gray-500">
            {authError || 'Unable to establish an admin session automatically.'}
          </p>
        </div>
      </div>
    );
  }

  return <Outlet />;
}
