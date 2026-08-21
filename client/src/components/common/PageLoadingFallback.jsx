// Tiny, eager (non-lazy) fallback shown by every <Suspense> boundary in the
// app — ProtectedRoute's auth-resolution spinner and AppRoutes' per-route
// lazy-chunk spinner both render this instead of each hand-rolling their
// own markup. Keep this dependency-free and cheap: it may flash briefly on
// every navigation while a route's chunk downloads.
export default function PageLoadingFallback() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-3">
      <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      <p className="text-sm text-gray-400">Loading...</p>
    </div>
  );
}
