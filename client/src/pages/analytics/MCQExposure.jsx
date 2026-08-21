import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getMCQExposure } from '@/api/analyticsApi';
import ExposureTable from '@/components/analytics/ExposureTable';

// MCQExposure.jsx — Prompt 99.
//
// No shared `PageHeader`/`Tabs` component exists anywhere in this
// codebase (same gap AnalyticsDashboard.jsx's Prompt 97/98 header notes
// already called out) — this page builds its own header block and tab
// strip out of the same utility classes every other admin page already
// uses, rather than importing components that don't exist.

const LIMIT_OPTIONS = [10, 20, 50];

const TABS = [
  { key: 'topUsed', label: 'Most Used', variant: 'overused' },
  { key: 'leastUsed', label: 'Least Used', variant: 'default' },
  { key: 'neverUsed', label: 'Never Used', variant: 'fresh' },
];

function InlineSpinner() {
  return (
    <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
  );
}

export default function MCQExposure() {
  const [activeTab, setActiveTab] = useState('topUsed');
  const [limit, setLimit] = useState(20);

  const [data, setData] = useState({ topUsed: [], leastUsed: [], neverUsed: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchExposure = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      // No `type` param -> all three lists in one round trip, per
      // analyticsApi.js's getMCQExposure / the backend's Prompt 95
      // contract (`type` omitted returns { topUsed, leastUsed, neverUsed }).
      const result = await getMCQExposure({ limit });
      setData({
        topUsed: result.topUsed || [],
        leastUsed: result.leastUsed || [],
        neverUsed: result.neverUsed || [],
      });
    } catch (err) {
      setError(err.message || 'Failed to load MCQ exposure data');
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    fetchExposure();
  }, [fetchExposure]);

  const activeMeta = TABS.find((t) => t.key === activeTab);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="section-title">MCQ Exposure</h1>
          <p className="text-sm text-gray-500">
            Track which questions are overused, underused, or never used
          </p>
        </div>
        <Link to="/admin/analytics" className="text-sm text-primary-600 hover:underline">
          ← Back to Analytics
        </Link>
      </div>

      {/* Limit selector */}
      <div className="flex items-center gap-2 text-sm text-gray-600">
        <span>Rows per table</span>
        <select
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
          className="rounded-md border border-surface-border px-2 py-1 text-sm bg-white"
        >
          {LIMIT_OPTIONS.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-1 border-b border-surface-border">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setActiveTab(tab.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
              activeTab === tab.key
                ? 'border-primary-600 text-primary-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            {tab.label}
            <span className="ml-1.5 text-xs text-gray-400">
              ({isLoading ? '…' : (data[tab.key] || []).length})
            </span>
          </button>
        ))}
      </div>

      {error && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={fetchExposure}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {!error && isLoading && (
        <div className="flex items-center justify-center py-16">
          <InlineSpinner />
        </div>
      )}

      {!error && !isLoading && (
        <div className="space-y-3">
          {activeTab === 'topUsed' && (
            <p className="text-sm text-gray-500">
              These questions appear frequently across generated tests — consider adding variants
              to reduce repetition risk.
            </p>
          )}
          {activeTab === 'neverUsed' && (
            <p className="text-sm text-gray-500">
              These approved questions have never appeared in a generated test — fully fresh for
              upcoming exams.
            </p>
          )}

          <ExposureTable rows={data[activeTab]} variant={activeMeta?.variant} />
        </div>
      )}
    </div>
  );
}
