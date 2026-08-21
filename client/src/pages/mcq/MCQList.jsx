import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FileQuestion } from 'lucide-react';
import apiClient, { handleApiError } from '@/lib/axios';
import MCQFilters from '@/components/mcq/MCQFilters';
import MCQRow, { MCQ_ROW_GRID_COLS } from '@/components/mcq/MCQRow';
import EmptyState from '@/components/common/EmptyState';
import SkeletonTable from '@/components/common/SkeletonTable';
import VirtualList from '@/components/common/VirtualList';

// 500 is included alongside the original 10/20/50/100 now that virtual
// scrolling (Prompt 107) makes a large in-view row count cheap to render —
// only the rows actually visible in the 600px viewport (plus overscan) are
// ever mounted in the DOM, regardless of this number.
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100, 500];

const EMPTY_FILTERS = {
  search: '',
  subject: '',
  difficulty: '',
  status: '',
  cognitive_level: '',
  // topic/subtopic have no input in MCQFilters.jsx (out of scope for that
  // component) — they only ever get set via the Taxonomy page's "View
  // MCQs" deep link (?subject=&topic=&subtopic=), read once below.
  // `undefined` means "no taxonomy filter applied"; once set, '' is a
  // real, meaningful value (the "(none)" topic/subtopic bucket), which
  // is why these use a different sentinel than the text filters above.
  topic: undefined,
  subtopic: undefined,
};

export default function MCQList() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Read once on mount — this page owns filter state itself rather than
  // staying in sync with the URL on every change (same as every other
  // filter here), so a taxonomy deep link only seeds the initial filters.
  const [filters, setFilters] = useState(() => {
    const next = { ...EMPTY_FILTERS };
    if (searchParams.has('subject')) next.subject = searchParams.get('subject') || '';
    if (searchParams.has('topic')) next.topic = searchParams.get('topic') ?? '';
    if (searchParams.has('subtopic')) next.subtopic = searchParams.get('subtopic') ?? '';
    return next;
  });
  const [pagination, setPagination] = useState({ page: 1, limit: 20 });
  const [data, setData] = useState({ data: [], pagination: { totalCount: 0, totalPages: 1 } });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [isBulkApproving, setIsBulkApproving] = useState(false);
  const [isBulkRejecting, setIsBulkRejecting] = useState(false);
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);

  const hasActiveFilters = useMemo(() => {
    const basicActive = ['search', 'subject', 'difficulty', 'status', 'cognitive_level'].some(
      (key) => filters[key]
    );
    // topic/subtopic count as active even when set to '' (the "(none)"
    // bucket) — unlike the text filters above, undefined vs '' actually
    // means something different for these two.
    const taxonomyActive = filters.topic !== undefined || filters.subtopic !== undefined;
    return basicActive || taxonomyActive;
  }, [filters]);

  const fetchMcqs = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    // Omit empty-string filter values rather than sending them literally
    // — except topic/subtopic, where '' is itself a real, meaningful
    // filter value (see EMPTY_FILTERS' comment above).
    const params = { page: pagination.page, limit: pagination.limit };
    Object.entries(filters).forEach(([key, value]) => {
      if (key === 'topic' || key === 'subtopic') {
        if (value !== undefined) params[key] = value;
      } else if (value) {
        params[key] = value;
      }
    });

    try {
      const response = await apiClient.get('/mcqs', { params });
      // Server (Prompt 103) returns { data: [...], pagination: { totalCount, totalPages, ... } }
      setData(response.data.data ?? { data: [], pagination: { totalCount: 0, totalPages: 1 } });
    } catch (err) {
      setError(handleApiError(err) || 'Failed to load MCQs');
    } finally {
      setIsLoading(false);
    }
  }, [filters, pagination.page, pagination.limit]);

  useEffect(() => {
    fetchMcqs();
  }, [fetchMcqs]);

  useEffect(() => {
    if (location.state?.toast) {
      toast.success(location.state.toast);
      // Clear it from history state so back/refresh doesn't re-show it.
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Changing filters resets to page 1, so we don't land out-of-range
  // after narrowing results.
  const handleFiltersChange = (nextFilters) => {
    setFilters(nextFilters);
    setPagination((prev) => ({ ...prev, page: 1 }));
    setSelectedIds(new Set());
  };

  const handleClearFilters = () => {
    handleFiltersChange({ ...EMPTY_FILTERS });
    navigate(location.pathname, { replace: true });
  };

  // Clears just the Taxonomy deep-link filters (subject/topic/subtopic),
  // leaving anything the admin has since typed into the other filters
  // alone, and drops the query string so a refresh doesn't re-apply it.
  const handleClearTaxonomyFilter = () => {
    handleFiltersChange({ ...filters, subject: '', topic: undefined, subtopic: undefined });
    navigate(location.pathname, { replace: true });
  };

  const handlePageSizeChange = (e) => {
    setPagination({ page: 1, limit: Number(e.target.value) });
    setSelectedIds(new Set());
  };

  const goToPage = (page) => {
    setPagination((prev) => ({ ...prev, page }));
    setSelectedIds(new Set());
  };

  const toggleRowSelection = (id) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const currentPageIds = (data.data ?? []).map((item) => item._id);
  const allCurrentPageSelected =
    currentPageIds.length > 0 && currentPageIds.every((id) => selectedIds.has(id));

  const toggleSelectAllOnPage = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allCurrentPageSelected) {
        currentPageIds.forEach((id) => next.delete(id));
      } else {
        currentPageIds.forEach((id) => next.add(id));
      }
      return next;
    });
  };

  // PATCH /mcqs/bulk-approve — moves every selected MCQ from 'pending'
  // to 'approved' in one call (already built server-side; this just
  // wires the "Bulk Approve" button in the toolbar below up to it).
  // This is the main way imported batches (e.g. a 100-question JSON
  // import) become eligible for blueprint feasibility / test
  // generation, since generation only ever draws from approved MCQs.
  const handleBulkApprove = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setIsBulkApproving(true);
    try {
      const response = await apiClient.patch('/mcqs/bulk-approve', { ids });
      const { modifiedCount = 0, matchedCount = 0 } = response.data.data ?? {};
      toast.success(`Approved ${modifiedCount} of ${matchedCount} selected MCQ${matchedCount === 1 ? '' : 's'}`);
      setSelectedIds(new Set());
      await fetchMcqs();
    } catch (err) {
      toast.error(handleApiError(err) || 'Bulk approve failed');
    } finally {
      setIsBulkApproving(false);
    }
  };

  // PATCH /mcqs/bulk-reject — mirrors handleBulkApprove above, moving
  // every selected MCQ to 'rejected' in one call instead of one row
  // at a time via the per-row Reject action.
  const handleBulkReject = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    setIsBulkRejecting(true);
    try {
      const response = await apiClient.patch('/mcqs/bulk-reject', { ids });
      const { modifiedCount = 0, matchedCount = 0 } = response.data.data ?? {};
      toast.success(`Rejected ${modifiedCount} of ${matchedCount} selected MCQ${matchedCount === 1 ? '' : 's'}`);
      setSelectedIds(new Set());
      await fetchMcqs();
    } catch (err) {
      toast.error(handleApiError(err) || 'Bulk reject failed');
    } finally {
      setIsBulkRejecting(false);
    }
  };

  // DELETE /mcqs/bulk-delete — permanently removes every selected MCQ.
  // Unlike approve/reject this can't be undone, so it's gated behind a
  // confirm() prompt naming exactly how many rows are about to go.
  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;

    const confirmed = window.confirm(
      `Permanently delete ${ids.length} selected MCQ${ids.length === 1 ? '' : 's'}? This cannot be undone.`
    );
    if (!confirmed) return;

    setIsBulkDeleting(true);
    try {
      const response = await apiClient.delete('/mcqs/bulk-delete', { data: { ids } });
      const { deletedCount = 0 } = response.data.data ?? {};
      toast.success(`Deleted ${deletedCount} MCQ${deletedCount === 1 ? '' : 's'}`);
      setSelectedIds(new Set());
      await fetchMcqs();
    } catch (err) {
      toast.error(handleApiError(err) || 'Bulk delete failed');
    } finally {
      setIsBulkDeleting(false);
    }
  };

  const { totalCount: total = 0, totalPages = 1 } = data.pagination || {};

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">MCQ Bank</h1>
          <p className="text-sm text-gray-500">{total} question{total === 1 ? '' : 's'} total</p>
        </div>
        <Link
          to="/admin/mcqs/new"
          className="px-3 py-2 rounded-md text-sm bg-primary text-primary-foreground hover:bg-primary-hover"
        >
          + Add MCQ
        </Link>
      </div>

      {(filters.topic !== undefined || filters.subtopic !== undefined) && (
        <div className="card flex items-center justify-between bg-primary-50 border-primary-100">
          <span className="text-sm text-gray-700">
            Filtered from Taxonomy: <strong>{filters.subject || '—'}</strong>
            {filters.topic !== undefined && (
              <>
                {' → '}
                <strong>{filters.topic || '(none)'}</strong>
              </>
            )}
            {filters.subtopic !== undefined && (
              <>
                {' → '}
                <strong>{filters.subtopic || '(none)'}</strong>
              </>
            )}
          </span>
          <button
            type="button"
            onClick={handleClearTaxonomyFilter}
            className="text-sm text-primary-600 hover:underline"
          >
            Clear
          </button>
        </div>
      )}

      <MCQFilters filters={filters} onChange={handleFiltersChange} />

      {/* Bulk action toolbar */}
      {selectedIds.size > 0 && (
        <div className="card flex items-center justify-between bg-primary-50 border-primary-100">
          <span className="text-sm font-medium text-gray-700">
            {selectedIds.size} selected
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBulkApprove}
              disabled={isBulkApproving}
              className="px-3 py-1.5 rounded-md text-sm border border-success text-success hover:bg-green-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBulkApproving ? 'Approving…' : 'Bulk Approve'}
            </button>
            <button
              type="button"
              onClick={handleBulkReject}
              disabled={isBulkRejecting}
              className="px-3 py-1.5 rounded-md text-sm border border-warning text-warning hover:bg-yellow-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBulkRejecting ? 'Rejecting…' : 'Bulk Reject'}
            </button>
            <button
              type="button"
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
              className="px-3 py-1.5 rounded-md text-sm border border-danger text-danger hover:bg-red-50 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isBulkDeleting ? 'Deleting…' : 'Bulk Delete'}
            </button>
          </div>
        </div>
      )}

      {/* Error state */}
      {error && !isLoading && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={fetchMcqs}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {/* Table */}
      {!error && (
        <div className="card p-0 overflow-hidden">
          {isLoading ? (
            <div className="overflow-x-auto">
              <SkeletonTable rows={8} columns={7} />
            </div>
          ) : (data.data ?? []).length === 0 ? (
            hasActiveFilters ? (
              <EmptyState
                icon={FileQuestion}
                title="No MCQs match your filters"
                message="Try adjusting or clearing your filters to see more results."
                actionLabel="Clear filters"
                onAction={handleClearFilters}
              />
            ) : (
              <EmptyState
                icon={FileQuestion}
                title="No MCQs yet"
                message="Start building your question bank."
                actionLabel="Add MCQ"
                onAction={() => navigate('/admin/mcqs/new')}
              />
            )
          ) : (
            <div className="overflow-x-auto">
              <div className="min-w-[820px]">
                {/* Header row — fixed/non-scrolling, sits outside the
                    virtualized (vertically scrolling) body below so it
                    never gets unmounted or re-measured during scroll. */}
                <div
                  className={`grid ${MCQ_ROW_GRID_COLS} items-center px-4 py-3 text-xs font-semibold uppercase tracking-wider text-gray-500 bg-gray-50 border-b border-gray-200`}
                >
                  <div>
                    <input
                      type="checkbox"
                      checked={allCurrentPageSelected}
                      onChange={toggleSelectAllOnPage}
                      disabled={currentPageIds.length === 0}
                    />
                  </div>
                  <div>Question ID</div>
                  <div>Question</div>
                  <div>Subject</div>
                  <div>Difficulty</div>
                  <div>Status</div>
                  <div>Actions</div>
                </div>

                {/* Only visible rows (+ overscan) are mounted here, so
                    bumping "Rows per page" up to 500 stays smooth. */}
                <VirtualList
                  items={data.data ?? []}
                  estimateRowHeight={56}
                  overscan={8}
                  containerHeight={600}
                  renderRow={(mcq) => (
                    <MCQRow
                      key={mcq._id}
                      mcq={mcq}
                      isSelected={selectedIds.has(mcq._id)}
                      onToggleSelect={toggleRowSelection}
                      navigate={navigate}
                    />
                  )}
                />
              </div>
            </div>
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
