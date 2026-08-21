import { useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="card max-w-md w-full text-center space-y-4">
        <p className="text-7xl font-bold text-primary-600">404</p>
        <h1 className="text-xl font-semibold text-gray-900">
          Page not found
        </h1>
        <p className="text-sm text-gray-500">
          The page you&apos;re looking for doesn&apos;t exist or has been
          moved.
        </p>
        <button
          onClick={() => navigate('/health')}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary-600 text-white text-sm font-medium hover:opacity-90 transition"
        >
          ← Go to Health Check
        </button>
      </div>
    </div>
  );
}
