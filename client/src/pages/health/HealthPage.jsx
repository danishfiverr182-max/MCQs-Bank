import { useCallback, useEffect, useRef, useState } from 'react';
import api, { handleApiError } from '@/lib/axios';

const AUTO_REFRESH_INTERVAL_MS = 30000;
const TICK_INTERVAL_MS = 1000;

function StatusDot({ ok }) {
  return (
    <span
      className={`inline-block h-2.5 w-2.5 rounded-full ${
        ok ? 'bg-success' : 'bg-danger'
      }`}
    />
  );
}

function ResponseTimeBadge({ ms }) {
  if (ms == null) return null;
  const color =
    ms < 200 ? 'text-success' : ms <= 500 ? 'text-warning' : 'text-danger';
  return (
    <span className={`text-sm font-medium ${color}`}>
      Response time: {ms}ms
    </span>
  );
}

function SkeletonCard() {
  return (
    <div className="card animate-pulse">
      <div className="h-4 w-24 bg-gray-200 rounded mb-3" />
      <div className="h-6 w-32 bg-gray-200 rounded" />
    </div>
  );
}

export default function HealthPage() {
  const [healthData, setHealthData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshCounter, setRefreshCounter] = useState(0);
  const [responseTime, setResponseTime] = useState(null);
  const [lastCheckedAt, setLastCheckedAt] = useState(null);
  const [secondsAgo, setSecondsAgo] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const pollRef = useRef(null);
  const tickRef = useRef(null);

  const fetchHealth = useCallback(async () => {
    setIsRefreshing(true);
    const startedAt = Date.now();

    try {
      const response = await api.get('/health');
      const elapsed = Date.now() - startedAt;

      setHealthData(response.data.data);
      setError(null);
      setResponseTime(elapsed);
      setLastCheckedAt(new Date());
      setSecondsAgo(0);
    } catch (err) {
      setError(handleApiError(err) || 'Cannot reach server');
      setResponseTime(null);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // Fetch on mount and whenever manual refresh is triggered
  useEffect(() => {
    fetchHealth();
  }, [fetchHealth, refreshCounter]);

  // Auto-poll every 30 seconds
  useEffect(() => {
    pollRef.current = setInterval(() => {
      fetchHealth();
    }, AUTO_REFRESH_INTERVAL_MS);

    return () => clearInterval(pollRef.current);
  }, [fetchHealth]);

  // "Last checked: X seconds ago" ticker
  useEffect(() => {
    tickRef.current = setInterval(() => {
      setSecondsAgo((prev) => prev + 1);
    }, TICK_INTERVAL_MS);

    return () => clearInterval(tickRef.current);
  }, [lastCheckedAt]);

  const handleRefresh = () => setRefreshCounter((c) => c + 1);

  return (
    <div className="page-wrapper flex justify-center">
      <div className="w-full max-w-2xl space-y-6">
        {/* Header */}
        <div className="text-center space-y-1">
          <h1 className="text-2xl font-bold text-gray-900">
            🔧 ExamEngine
          </h1>
          <p className="text-sm text-gray-500">System Health Monitor</p>
        </div>

        {/* Loading state */}
        {loading && (
          <div className="grid grid-cols-2 gap-4">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
          </div>
        )}

        {/* Error state */}
        {!loading && error && (
          <div className="card border-danger bg-red-50">
            <p className="font-semibold text-danger">Unable to reach server</p>
            <p className="text-sm text-red-700 mt-1">{error}</p>
          </div>
        )}

        {/* Success state */}
        {!loading && !error && healthData && (
          <>
            <div className="grid grid-cols-2 gap-4">
              <div className="card">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  API Status
                </p>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <StatusDot ok={healthData.status === 'ok'} />
                  {healthData.status === 'ok' ? '✅ Online' : '❌ Offline'}
                </div>
              </div>

              <div className="card">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Database
                </p>
                <div className="flex items-center gap-2 text-sm font-medium">
                  <StatusDot ok={healthData.database?.connected} />
                  {healthData.database?.connected
                    ? '✅ Connected'
                    : '❌ Disconnected'}
                </div>
              </div>

              <div className="card">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Environment
                </p>
                <p className="text-sm font-medium">{healthData.environment}</p>
              </div>

              <div className="card">
                <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                  Uptime
                </p>
                <p className="text-sm font-medium">
                  {healthData.server?.uptimeFormatted}
                </p>
              </div>
            </div>

            <div className="card">
              <p className="text-xs uppercase tracking-wide text-gray-500 mb-2">
                Server Info
              </p>
              <p className="text-sm text-gray-700">
                Node: {healthData.server?.nodeVersion} | Memory:{' '}
                {healthData.server?.memoryUsageMB} MB
              </p>
              <p className="text-sm text-gray-700">
                Platform: {healthData.server?.platform}
              </p>
            </div>
          </>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between text-sm text-gray-500">
          <div className="flex items-center gap-2">
            {isRefreshing && (
              <span className="h-3 w-3 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
            )}
            <span>
              {lastCheckedAt
                ? `Last checked: ${secondsAgo}s ago`
                : 'Checking…'}
            </span>
          </div>
          <ResponseTimeBadge ms={responseTime} />
        </div>

        <div className="flex justify-center">
          <button
            onClick={handleRefresh}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-primary-600 text-white text-sm font-medium hover:opacity-90 transition"
          >
            🔄 Refresh
          </button>
        </div>
      </div>
    </div>
  );
}
