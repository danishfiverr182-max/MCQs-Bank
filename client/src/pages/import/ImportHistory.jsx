// Import history page (Prompt 50) — lists past bulk-import batches from
// GET /api/import/history (Prompt 46), which returns
// { batches, total, page, pages }.

import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';

const MODE_LABEL = {
  insert: 'Insert',
  validate_only: 'Validate Only',
};

const formatDate = (value) => {
  if (!value) return '—';
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
};

function ModeBadge({ mode }) {
  const isInsert = mode === 'insert';
  return (
    <span
      className={`badge ${isInsert ? 'bg-primary-100 text-primary-700' : 'bg-gray-100 text-gray-600'}`}
    >
      {MODE_LABEL[mode] || mode}
    </span>
  );
}

function StatusBadge({ status }) {
  if (status === 'processing') {
    return <span className="badge bg-amber-100 text-amber-700">Processing</span>;
  }
  const isCompleted = status === 'completed';
  return (
    <span className={`badge ${isCompleted ? 'badge-approved' : 'badge-rejected'}`}>
      {isCompleted ? 'Completed' : 'Failed'}
    </span>
  );
}

// Lightweight detail view — batches aren't fetchable by ID yet, so this
// modal just re-displays the counts already available from the list
// response rather than making another round trip. A real "re-open the
// full report" experience (with the actual failed rows / duplicate
// entries, which aren't persisted anywhere right now) is a natural
// Phase 5+ enhancement once GET /api/import/history/:batchId exists.
function BatchDetailModal({ batch, onClose }) {
  if (!batch) return null;

  const rows = [
    ['Batch ID', batch.batch_id],
    ['Filename', batch.filename],
    ['Uploaded', formatDate(batch.created_at)],
    ['Mode', MODE_LABEL[batch.mode] || batch.mode],
    ['Status', batch.status],
    ['Total Rows', batch.total_rows],
    ['Inserted', batch.inserted_count],
    ['Failed', batch.failed_count],
    ['Exact Duplicates', batch.exact_duplicate_count],
    ['Near Duplicates', batch.near_duplicate_count],
    ['New Subtopics', batch.new_subtopics?.length ?? 0],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="card w-full max-w-md space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h2 className="section-title">Batch Details</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="h-6 w-6 flex items-center justify-center rounded-full text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            ×
          </button>
        </div>

        <dl className="space-y-2 text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between">
              <dt className="text-gray-500">{label}</dt>
              <dd className="font-medium text-gray-800">{value ?? '—'}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

export default function ImportHistory() {
  const [batches, setBatches] = useState([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [deletingBatchId, setDeletingBatchId] = useState(null);

  const fetchHistory = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.get('/import/history', { params: { page, limit: 20 } });
      const data = response.data?.data || {};
      setBatches(data.batches || []);
      setPages(data.pages || 1);
      setTotal(data.total || 0);
    } catch (err) {
      setError(handleApiError(err) || 'Failed to load import history');
    } finally {
      setIsLoading(false);
    }
  }, [page]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  // Cascades to every MCQ that batch inserted (server-side, see
  // deleteImportBatch in import.service.js) — this is the cleanup path
  // for a failed/bad import: it removes the batch AND the MCQs it left
  // behind, so a corrected re-upload of the same file won't come back
  // as "all duplicates" against rows nobody could otherwise find.
  const handleDeleteBatch = async (batch, event) => {
    event.stopPropagation(); // don't also open the detail modal
    const confirmed = window.confirm(
      `Delete import batch ${batch.batch_id} (${batch.filename})?\n\n` +
        `This will permanently remove ${batch.inserted_count} MCQ${
          batch.inserted_count === 1 ? '' : 's'
        } it inserted, along with this history entry. This cannot be undone.`
    );
    if (!confirmed) return;

    setDeletingBatchId(batch.batch_id);
    try {
      const response = await api.delete(`/import/${batch.batch_id}`);
      const result = response.data?.data;
      toast.success(
        `Deleted batch ${batch.batch_id} and ${result?.deletedMcqCount ?? 0} MCQ(s)`
      );
      if (selectedBatch?.batch_id === batch.batch_id) setSelectedBatch(null);
      await fetchHistory();
    } catch (err) {
      toast.error(handleApiError(err));
    } finally {
      setDeletingBatchId(null);
    }
  };

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">Import History</h1>
          <p className="text-sm text-gray-500">Past bulk import batches, most recent first.</p>
        </div>
        <Link to="/admin/import">
          <Button type="button">New Import</Button>
        </Link>
      </div>

      <div className="card p-0 overflow-hidden">
        {isLoading ? (
          <p className="p-6 text-sm text-gray-500">Loading…</p>
        ) : error ? (
          <p className="p-6 text-sm text-danger">{error}</p>
        ) : batches.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-gray-500">No imports yet — start your first bulk import</p>
            <Link to="/admin/import">
              <Button type="button">Start Import</Button>
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Batch ID</th>
                  <th>Filename</th>
                  <th>Date</th>
                  <th>Mode</th>
                  <th>Total</th>
                  <th>Inserted</th>
                  <th>Failed</th>
                  <th>Duplicates</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {batches.map((batch) => (
                  <tr
                    key={batch.batch_id}
                    onClick={() => setSelectedBatch(batch)}
                    className="cursor-pointer"
                  >
                    <td className="font-mono text-xs">{batch.batch_id}</td>
                    <td className="truncate max-w-[180px]">{batch.filename}</td>
                    <td className="whitespace-nowrap text-xs text-gray-500">
                      {formatDate(batch.created_at)}
                    </td>
                    <td>
                      <ModeBadge mode={batch.mode} />
                    </td>
                    <td>{batch.total_rows}</td>
                    <td className="text-success font-medium">{batch.inserted_count}</td>
                    <td className="text-danger font-medium">{batch.failed_count}</td>
                    <td>{batch.exact_duplicate_count + batch.near_duplicate_count}</td>
                    <td>
                      <StatusBadge status={batch.status} />
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={(e) => handleDeleteBatch(batch, e)}
                        disabled={deletingBatchId === batch.batch_id}
                        title="Delete this batch and every MCQ it inserted"
                        className="text-xs font-medium text-danger hover:underline disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {deletingBatchId === batch.batch_id ? 'Deleting…' : 'Delete'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {!isLoading && !error && batches.length > 0 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>{total} batch{total === 1 ? '' : 'es'} total</span>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md border border-surface-border px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
            >
              Prev
            </button>
            <span>
              Page {page} of {pages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="rounded-md border border-surface-border px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
            >
              Next
            </button>
          </div>
        </div>
      )}

      <BatchDetailModal batch={selectedBatch} onClose={() => setSelectedBatch(null)} />
    </div>
  );
}
