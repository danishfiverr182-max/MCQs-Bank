import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient from '@/lib/axios';
import { Button } from '@/components/ui/button';
import MCQCard from '@/components/mcq/MCQCard';
import StatusBadge from '@/components/mcq/StatusBadge';

export default function MCQDetail() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [mcq, setMcq] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // type: null | 'approve' | 'reject' | 'delete'
  const [actionState, setActionState] = useState({ type: null, isLoading: false });
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const fetchMcq = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const { data } = await apiClient.get(`/mcqs/${id}`);
      setMcq(data.data.mcq);
    } catch (err) {
      setError(err?.statusCode === 404 || err?.response?.status === 404
        ? 'MCQ not found'
        : 'Failed to load MCQ');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchMcq();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleApprove = async () => {
    setActionState({ type: 'approve', isLoading: true });
    try {
      const { data } = await apiClient.patch(`/mcqs/${id}/approve`);
      setMcq(data.data.mcq);
      toast.success('MCQ approved');
    } catch (err) {
      toast.error(err?.message || 'Failed to approve MCQ');
    } finally {
      setActionState({ type: null, isLoading: false });
    }
  };

  const handleReject = async () => {
    setActionState({ type: 'reject', isLoading: true });
    try {
      const { data } = await apiClient.patch(`/mcqs/${id}/reject`);
      setMcq(data.data.mcq);
      toast.success('MCQ rejected');
    } catch (err) {
      toast.error(err?.message || 'Failed to reject MCQ');
    } finally {
      setActionState({ type: null, isLoading: false });
    }
  };

  const handleDeleteConfirmed = async () => {
    setActionState({ type: 'delete', isLoading: true });
    try {
      await apiClient.delete(`/mcqs/${id}`);
      navigate('/admin/mcqs', { state: { toast: 'MCQ deleted successfully' } });
      // No finally-reset here — we're navigating away on success.
    } catch (err) {
      toast.error(err?.message || 'Failed to delete MCQ');
      setActionState({ type: null, isLoading: false });
      setShowDeleteConfirm(false);
    }
  };

  // ─── Loading state ────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  // ─── Error state ──────────────────────────────────────────────
  if (error || !mcq) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{error || 'MCQ not found'}</p>
        <Link to="/admin/mcqs" className="text-sm text-primary-600 hover:underline">
          Back to MCQ list
        </Link>
      </div>
    );
  }

  const isBusy = actionState.isLoading;
  const disableApproveReject = showDeleteConfirm; // delete confirmation locks approve/reject

  const ActionButtons = (
    <>
      <Link to={`/admin/mcqs/${id}/edit`}>
        <Button type="button" variant="outline" size="sm" disabled={isBusy}>
          Edit
        </Button>
      </Link>

      {mcq.status !== 'approved' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleApprove}
          disabled={disableApproveReject || (actionState.type === 'approve' && actionState.isLoading)}
        >
          {actionState.type === 'approve' && actionState.isLoading ? (
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
              Approving…
            </span>
          ) : (
            'Approve'
          )}
        </Button>
      )}

      {mcq.status !== 'rejected' && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={handleReject}
          disabled={disableApproveReject || (actionState.type === 'reject' && actionState.isLoading)}
        >
          {actionState.type === 'reject' && actionState.isLoading ? (
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
              Rejecting…
            </span>
          ) : (
            'Reject'
          )}
        </Button>
      )}

      <Button
        type="button"
        variant="destructive"
        size="sm"
        className="ml-auto"
        onClick={() => setShowDeleteConfirm(true)}
        disabled={actionState.type === 'delete' && actionState.isLoading}
      >
        Delete
      </Button>
    </>
  );

  return (
    <div className="space-y-4">
      {/* Breadcrumb */}
      <Link to="/admin/mcqs" className="text-sm text-primary-600 hover:underline">
        ← Back to MCQ Bank
      </Link>

      {/* Header */}
      <div className="flex items-center gap-3">
        <h1 className="section-title">{mcq.question_id}</h1>
        <StatusBadge status={mcq.status} />
      </div>

      {/* Full card with actions */}
      <MCQCard mcq={mcq} actions={ActionButtons} />

      {/* Delete confirmation dialog */}
      {showDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="card max-w-sm w-full space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-gray-900">Delete this MCQ?</h2>
              <p className="text-sm text-gray-500">
                Delete this MCQ permanently? This cannot be undone.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={actionState.type === 'delete' && actionState.isLoading}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleDeleteConfirmed}
                disabled={actionState.type === 'delete' && actionState.isLoading}
              >
                {actionState.type === 'delete' && actionState.isLoading
                  ? 'Deleting…'
                  : 'Delete permanently'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
