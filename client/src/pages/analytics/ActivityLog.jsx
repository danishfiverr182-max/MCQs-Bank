import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getActivityLogs } from '@/api/analyticsApi';
import SkeletonTable from '@/components/common/SkeletonTable';

// ActivityLog.jsx — Prompt 100.
//
// No shared `PageHeader`/pagination component exists anywhere in this
// codebase — this follows MCQList.jsx's real pagination pattern
// (page/limit state, Prev/Next, "Page X of Y") rather than importing
// something that isn't there.
//
// There's also no admin user-listing endpoint anywhere in the API
// (checked auth.routes.js — only /auth/me exists), so unlike the
// action/entityType dropdowns below (whose full value sets are known
// statically from ActivityLog.js's enum), an "actor" filter dropdown
// has no data source to populate it from. The backend's
// getPaginatedLogs still accepts an `actorId` param for when that
// endpoint exists in a future phase; this page just doesn't expose a
// control for it yet rather than shipping a filter that always
// silently does nothing.

const ACTION_OPTIONS = [
  { value: 'mcq_created', label: 'Created MCQ' },
  { value: 'mcq_updated', label: 'Updated MCQ' },
  { value: 'mcq_deleted', label: 'Deleted MCQ' },
  { value: 'mcq_bulk_imported', label: 'Bulk Imported MCQs' },
  { value: 'mcq_approved', label: 'Approved MCQ' },
  { value: 'mcq_rejected', label: 'Rejected MCQ' },
  { value: 'mcq_merged', label: 'Merged MCQ' },
  { value: 'blueprint_created', label: 'Created Blueprint' },
  { value: 'blueprint_updated', label: 'Updated Blueprint' },
  { value: 'blueprint_deleted', label: 'Deleted Blueprint' },
  { value: 'blueprint_cloned', label: 'Cloned Blueprint' },
  { value: 'exam_created', label: 'Created Exam' },
  { value: 'exam_updated', label: 'Updated Exam' },
  { value: 'exam_deleted', label: 'Deleted Exam' },
  { value: 'test_generated', label: 'Generated Test' },
  { value: 'test_finalized', label: 'Finalized Test' },
  { value: 'qa_run', label: 'Ran QA' },
  { value: 'qa_finalize_blocked', label: 'QA Blocked Finalize' },
  { value: 'admin_login', label: 'Admin Login' },
  { value: 'admin_logout', label: 'Admin Logout' },
];

const ACTION_LABELS = Object.fromEntries(ACTION_OPTIONS.map((o) => [o.value, o.label]));

const ENTITY_TYPE_OPTIONS = ['MCQ', 'Blueprint', 'Exam', 'Test', 'QAReport', 'Auth'];

// entity_id conventions per domain (Phase 3-8, restated in
// ActivityLog.js's own comment): MCQ keys off the Mongo _id,
// Blueprint/Exam/Test key off their own business id. QA-domain actions
// are logged with entityType 'Test' (see activityLogger.middleware.js's
// FALLBACK_ENTITY — QA events are attached to the Test they concern so
// its timeline stays in one place), so there's no live QAReport link
// target in practice; Auth rows have no entity at all.
const ENTITY_LINK_BUILDERS = {
  MCQ: (id) => `/admin/mcqs/${id}`,
  Blueprint: (id) => `/admin/blueprints/${id}`,
  Exam: (id) => `/admin/exams/${id}`,
  Test: (id) => `/admin/generator/tests/${id}`,
};

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

const EMPTY_FILTERS = { action: '', entityType: '', from: '', to: '' };

function formatRelative(dateStr) {
  const date = new Date(dateStr);
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return date.toLocaleDateString();
}

function InlineSpinner() {
  return (
    <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
  );
}

export default function ActivityLog() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [pagination, setPagination] = useState({ page: 1, limit: 25 });
  const [data, setData] = useState({ logs: [], total: 0, totalPages: 1 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const hasActiveFilters = Object.values(filters).some((v) => v);

  const fetchLogs = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const params = { page: pagination.page, limit: pagination.limit };
      Object.entries(filters).forEach(([key, value]) => {
        if (value) params[key] = value;
      });
      const result = await getActivityLogs(params);
      setData(result);
    } catch (err) {
      setError(err.message || 'Failed to load activity log');
    } finally {
      setIsLoading(false);
    }
  }, [filters, pagination.page, pagination.limit]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleFilterChange = (key, value) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handleClearFilters = () => {
    setFilters(EMPTY_FILTERS);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handlePageSizeChange = (e) => {
    setPagination({ page: 1, limit: Number(e.target.value) });
  };

  const goToPage = (page) => {
    setPagination((prev) => ({ ...prev, page }));
  };

  const { logs = [], total = 0, totalPages = 1 } = data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="section-title">Activity Log</h1>
          <p className="text-sm text-gray-500">Full audit trail of admin actions</p>
        </div>
        <Link to="/admin/analytics" className="text-sm text-primary-600 hover:underline">
          ← Back to Analytics
        </Link>
      </div>

      {/* Filter bar */}
      <div className="card flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500" htmlFor="filter-action">
            Action
          </label>
          <select
            id="filter-action"
            value={filters.action}
            onChange={(e) => handleFilterChange('action', e.target.value)}
            className="rounded-md border border-surface-border px-2 py-1.5 text-sm bg-white min-w-[180px]"
          >
            <option value="">All actions</option>
            {ACTION_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500" htmlFor="filter-entity">
            Entity Type
          </label>
          <select
            id="filter-entity"
            value={filters.entityType}
            onChange={(e) => handleFilterChange('entityType', e.target.value)}
            className="rounded-md border border-surface-border px-2 py-1.5 text-sm bg-white min-w-[140px]"
          >
            <option value="">All entities</option>
            {ENTITY_TYPE_OPTIONS.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500" htmlFor="filter-from">
            From
          </label>
          <input
            id="filter-from"
            type="date"
            value={filters.from}
            onChange={(e) => handleFilterChange('from', e.target.value)}
            className="rounded-md border border-surface-border px-2 py-1.5 text-sm bg-white"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-gray-500" htmlFor="filter-to">
            To
          </label>
          <input
            id="filter-to"
            type="date"
            value={filters.to}
            onChange={(e) => handleFilterChange('to', e.target.value)}
            className="rounded-md border border-surface-border px-2 py-1.5 text-sm bg-white"
          />
        </div>

        {hasActiveFilters && (
          <button
            type="button"
            onClick={handleClearFilters}
            className="text-sm text-primary-600 hover:underline pb-1.5"
          >
            Clear filters
          </button>
        )}

        <span className="ml-auto text-sm text-gray-500 self-end pb-1.5">
          {total} entr{total === 1 ? 'y' : 'ies'}
        </span>
      </div>

      {/* Error state */}
      {error && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={fetchLogs}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      {!error && (
        <div className="card p-0 overflow-x-auto">
          {isLoading ? (
            <SkeletonTable rows={8} columns={5} />
          ) : (
            <table className="data-table">
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Entity</th>
                  <th>Summary</th>
                </tr>
              </thead>
              <tbody>
                {logs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="text-center py-10 text-gray-500">
                      {hasActiveFilters
                        ? 'No activity matches these filters'
                        : 'No activity recorded yet'}
                    </td>
                  </tr>
                )}

                {logs.map((log) => {
                  const linkBuilder = ENTITY_LINK_BUILDERS[log.entity_type];
                  const entityLink = linkBuilder && log.entity_id ? linkBuilder(log.entity_id) : null;

                  return (
                    <tr key={log._id}>
                      <td className="whitespace-nowrap text-sm text-gray-600" title={new Date(log.timestamp).toLocaleString()}>
                        {formatRelative(log.timestamp)}
                      </td>
                      <td className="text-sm text-gray-700">{log.actor_name}</td>
                      <td className="text-sm text-gray-700">
                        {ACTION_LABELS[log.action] || log.action}
                      </td>
                      <td className="text-sm">
                        {entityLink ? (
                          <Link to={entityLink} className="text-primary-600 hover:underline">
                            {log.entity_type} · {log.entity_id}
                          </Link>
                        ) : (
                          <span className="text-gray-500">
                            {log.entity_type}
                            {log.entity_id ? ` · ${log.entity_id}` : ''}
                          </span>
                        )}
                      </td>
                      <td className="text-sm text-gray-500 max-w-sm truncate" title={log.details?.summary || ''}>
                        {log.details?.summary || '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Pagination controls */}
      {!error && (
        <div className="flex items-center justify-between text-sm text-gray-600">
          <div className="flex items-center gap-2">
            <span>Rows per page</span>
            <select
              value={pagination.limit}
              onChange={handlePageSizeChange}
              className="rounded-md border border-surface-border px-2 py-1 text-sm"
            >
              {PAGE_SIZE_OPTIONS.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => goToPage(pagination.page - 1)}
              disabled={pagination.page <= 1 || isLoading}
              className="px-3 py-1.5 rounded-md border border-surface-border disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Prev
            </button>
            <span>
              Page {pagination.page} of {totalPages}
            </span>
            <button
              type="button"
              onClick={() => goToPage(pagination.page + 1)}
              disabled={pagination.page >= totalPages || isLoading}
              className="px-3 py-1.5 rounded-md border border-surface-border disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
