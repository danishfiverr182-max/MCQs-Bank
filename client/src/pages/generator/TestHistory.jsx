import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ClipboardList } from 'lucide-react';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import ExamSelector from '@/components/generator/ExamSelector';
import QABadge from '@/components/qa/QABadge';
import EmptyState from '@/components/common/EmptyState';
import SkeletonTable from '@/components/common/SkeletonTable';

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100];

function StatusBadge({ status }) {
  const isCompleted = status === 'completed';
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
        isCompleted ? 'bg-success-light text-success-dark' : 'bg-danger-light text-danger-dark'
      }`}
    >
      {isCompleted ? 'Completed' : 'Failed'}
    </span>
  );
}

export default function TestHistory() {
  const location = useLocation();
  const navigate = useNavigate();

  // Optional pre-filter: ExamDetail.jsx's "View Test History" link
  // passes the full exam object via route state (the same shape
  // ExamSelector.jsx's `value` prop expects) so this page opens already
  // scoped to that exam rather than making the admin re-pick it.
  const [examFilter, setExamFilter] = useState(location.state?.examFilter ?? null);
  const [statusFilter, setStatusFilter] = useState('');
  const [pagination, setPagination] = useState({ page: 1, limit: 20 });

  // Prompt 103: GET /api/generator returns { data: [...], pagination:
  // { page, limit, totalCount, totalPages, hasNextPage, hasPrevPage } } —
  // this used to be { items, pagination: { total, ... } } and this state
  // (and every read below) was never updated to match, which crashed the
  // page as soon as a real response landed (`data.items` was `undefined`).
  // Mirrors the fix already applied to MCQList.jsx for the same endpoint
  // shape change.
  const [data, setData] = useState({ data: [], pagination: { totalCount: 0, totalPages: 1 } });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // examId → exam_name lookup — GET /api/generator's list is
  // summary-only (no embedded exam doc, just exam_id, same reasoning
  // as Blueprint), so exam names are resolved via one batched fetch of
  // every exam (no status filter → both active and inactive, since a
  // past test's exam may have since been deactivated) rather than one
  // request per row.
  const [examNames, setExamNames] = useState(new Map());

  useEffect(() => {
    (async () => {
      try {
        const response = await apiClient.get('/exams');
        const grouped = response.data.data || {};
        const map = new Map();
        Object.values(grouped).forEach((exams) => {
          exams.forEach((exam) => map.set(exam.exam_id, exam.exam_name));
        });
        setExamNames(map);
      } catch {
        // Non-fatal — rows just fall back to showing the raw exam_id.
      }
    })();
  }, []);

  // Consume the route-state pre-filter once, then clear it so a later
  // back/refresh on this page doesn't keep re-forcing the filter closed
  // over whatever the admin has since changed — same pattern
  // ExamDetail.jsx / MCQList.jsx use for their own one-shot route state.
  useEffect(() => {
    if (location.state?.examFilter) {
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const fetchTests = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    const params = { page: pagination.page, limit: pagination.limit };
    if (examFilter?.exam_id) params.exam_id = examFilter.exam_id;
    if (statusFilter) params.status = statusFilter;

    try {
      const response = await apiClient.get('/generator', { params });
      setData(response.data.data ?? { data: [], pagination: { totalCount: 0, totalPages: 1 } });
    } catch (err) {
      setError(handleApiError(err) || 'Failed to load test history');
    } finally {
      setIsLoading(false);
    }
  }, [examFilter?.exam_id, statusFilter, pagination.page, pagination.limit]);

  useEffect(() => {
    fetchTests();
  }, [fetchTests]);

  // Changing either filter resets to page 1, so we don't land
  // out-of-range after narrowing the result set.
  const handleExamFilterChange = (exam) => {
    setExamFilter(exam);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handleStatusFilterChange = (e) => {
    setStatusFilter(e.target.value);
    setPagination((prev) => ({ ...prev, page: 1 }));
  };

  const handlePageSizeChange = (e) => {
    setPagination({ page: 1, limit: Number(e.target.value) });
  };

  const goToPage = (page) => {
    setPagination((prev) => ({ ...prev, page }));
  };

  const handleDelete = async (testId) => {
    setIsDeleting(true);
    try {
      await apiClient.delete(`/generator/${testId}`);
      toast.success(`${testId} deleted`);
      setConfirmDeleteId(null);
      // If that was the last row on a page beyond the first, step back
      // a page rather than refetching into an empty page.
      const isLastRowOnPage = (data.data ?? []).length === 1 && pagination.page > 1;
      if (isLastRowOnPage) {
        setPagination((prev) => ({ ...prev, page: prev.page - 1 }));
      } else {
        await fetchTests();
      }
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to delete test');
    } finally {
      setIsDeleting(false);
    }
  };

  const { totalCount: total = 0, totalPages = 1 } = data.pagination || {};
  const hasFilters = Boolean(examFilter || statusFilter);
  const items = data.data ?? [];

  const testPendingDelete = useMemo(
    () => items.find((t) => t.test_id === confirmDeleteId) || null,
    [items, confirmDeleteId]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="section-title">Test History</h1>
          <p className="text-sm text-gray-500">
            {total} test{total === 1 ? '' : 's'} generated
          </p>
        </div>
        <Link to="/admin/generator">
          <Button>+ Generate Test</Button>
        </Link>
      </div>

      {/* Filters */}
      <div className="card flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <ExamSelector value={examFilter} onSelect={handleExamFilterChange} />
        </div>
        {examFilter && (
          <button
            type="button"
            onClick={() => handleExamFilterChange(null)}
            className="text-sm text-primary-600 hover:underline pb-2"
          >
            Clear exam filter
          </button>
        )}

        <label className="space-y-1.5">
          <span className="block text-sm font-medium text-gray-700">Status</span>
          <select
            value={statusFilter}
            onChange={handleStatusFilterChange}
            className="rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          >
            <option value="">All Statuses</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </select>
        </label>
      </div>

      {error && !isLoading && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={fetchTests}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading && (
        <div className="card p-0 overflow-hidden">
          <SkeletonTable rows={8} columns={7} />
        </div>
      )}

      {!isLoading && !error && items.length === 0 && (
        <div className="card p-0">
          {hasFilters ? (
            <EmptyState
              icon={ClipboardList}
              title="No tests match the current filters"
              message="Try adjusting the filters above to see more results."
            />
          ) : (
            <EmptyState
              icon={ClipboardList}
              title="No tests generated yet"
              message="Generate a test from an exam's blueprint to see it here."
              actionLabel="Generate a test"
              onAction={() => navigate('/admin/generator')}
            />
          )}
        </div>
      )}

      {!isLoading && !error && items.length > 0 && (
        <div className="card p-0 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-surface-border bg-gray-50">
                  <th className="py-2.5 px-4 font-medium">Test ID</th>
                  <th className="py-2.5 px-4 font-medium">Exam</th>
                  <th className="py-2.5 px-4 font-medium">Generated</th>
                  <th className="py-2.5 px-4 font-medium">Questions</th>
                  <th className="py-2.5 px-4 font-medium">Status</th>
                  <th className="py-2.5 px-4 font-medium">QA Status</th>
                  <th className="py-2.5 px-4 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {items.map((test) => (
                  <tr key={test.test_id}>
                    <td className="py-2.5 px-4 font-mono text-xs text-gray-800">{test.test_id}</td>
                    <td className="py-2.5 px-4 text-gray-700">
                      {examNames.get(test.exam_id) || test.exam_id}
                    </td>
                    <td className="py-2.5 px-4 text-gray-500">
                      {test.generated_at ? new Date(test.generated_at).toLocaleString() : '—'}
                    </td>
                    <td className="py-2.5 px-4 text-gray-700">{test.question_count}</td>
                    <td className="py-2.5 px-4">
                      <StatusBadge status={test.status} />
                    </td>
                    <td className="py-2.5 px-4">
                      {/* Denormalized on GeneratedTest since Prompt 85 — no
                          extra per-row fetch needed beyond this existing list call. */}
                      <QABadge status={test.latest_qa_status} size="sm" />
                    </td>
                    <td className="py-2.5 px-4">
                      <div className="flex items-center gap-3">
                        {test.status === 'completed' ? (
                          <Link
                            to={`/admin/generator/tests/${test.test_id}`}
                            className="text-primary-600 hover:underline"
                          >
                            View
                          </Link>
                        ) : (
                          <span
                            className="text-gray-300 cursor-not-allowed"
                            title="No complete question set to view for a failed generation"
                          >
                            View
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(test.test_id)}
                          className="text-danger hover:underline"
                        >
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Pagination controls — same layout/behavior as MCQList.jsx's */}
      {!isLoading && !error && items.length > 0 && (
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

      {/* Delete confirmation */}
      {confirmDeleteId && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="card max-w-sm w-full space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-gray-900">
                Delete {confirmDeleteId}?
              </h2>
              <p className="text-sm text-gray-500">
                This removes the test record permanently. It does <strong>not</strong> un-expose
                the questions it used — their usage counts and last-used dates stay exactly as
                they are, the same as if the test still existed.
              </p>
              {testPendingDelete && (
                <p className="text-xs text-gray-400">
                  {testPendingDelete.question_count} question
                  {testPendingDelete.question_count === 1 ? '' : 's'} in this test.
                </p>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmDeleteId(null)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={isDeleting}
              >
                {isDeleting ? 'Deleting…' : 'Delete'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
