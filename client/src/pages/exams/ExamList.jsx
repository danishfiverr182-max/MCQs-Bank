import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import ExamStatusBadge from '@/components/exams/ExamStatusBadge';

// Root of the Phase 5 navigation loop:
//   ExamList → ExamDetail → BlueprintList (embedded) → BlueprintDetail
//   → BlueprintBuilder → back to ExamDetail
// ExamList itself has no "parent" to link back to — it IS the parent —
// so no back-link is added here; every other page in that chain links
// back to its logical parent (confirmed/fixed as part of Prompt 60).
export default function ExamList() {
  const location = useLocation();
  const navigate = useNavigate();

  // { ORG: [exam, exam, ...] } — already grouped + sorted by the backend
  // (GET /api/exams from Prompt 52); rendered directly, no client-side regrouping.
  const [groupedExams, setGroupedExams] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showInactive, setShowInactive] = useState(false); // off by default
  const [togglingIds, setTogglingIds] = useState(new Set());

  const fetchExams = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get('/exams');
      setGroupedExams(response.data.data || {});
    } catch (err) {
      setError(handleApiError(err) || 'Failed to load exams');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchExams();
  }, [fetchExams]);

  useEffect(() => {
    if (location.state?.toast) {
      toast.success(location.state.toast);
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Quick status toggle from the list — optimistic, reverts on failure.
  // "Show inactive exams" filters purely client-side (data already
  // includes status), so this doesn't need a re-fetch either way.
  const handleToggleStatus = async (exam) => {
    const nextStatus = exam.status === 'active' ? 'inactive' : 'active';

    setTogglingIds((prev) => new Set(prev).add(exam.exam_id));
    setGroupedExams((prev) => ({
      ...prev,
      [exam.organization]: prev[exam.organization].map((e) =>
        e.exam_id === exam.exam_id ? { ...e, status: nextStatus } : e
      ),
    }));

    try {
      await apiClient.patch(`/exams/${exam.exam_id}/status`);
    } catch (err) {
      // Revert on failure.
      setGroupedExams((prev) => ({
        ...prev,
        [exam.organization]: prev[exam.organization].map((e) =>
          e.exam_id === exam.exam_id ? { ...e, status: exam.status } : e
        ),
      }));
      toast.error(handleApiError(err) || 'Failed to update status');
    } finally {
      setTogglingIds((prev) => {
        const next = new Set(prev);
        next.delete(exam.exam_id);
        return next;
      });
    }
  };

  const organizations = Object.keys(groupedExams); // already alphabetical from the backend
  const totalExamCount = organizations.reduce((sum, org) => sum + groupedExams[org].length, 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">Exams</h1>
          <p className="text-sm text-gray-500">
            {totalExamCount} exam{totalExamCount === 1 ? '' : 's'} across {organizations.length}{' '}
            organization{organizations.length === 1 ? '' : 's'}
          </p>
        </div>
        <Link to="/admin/exams/new">
          <Button>+ Add Exam</Button>
        </Link>
      </div>

      <label className="flex items-center gap-2 text-sm text-gray-600 select-none">
        <input
          type="checkbox"
          checked={showInactive}
          onChange={(e) => setShowInactive(e.target.checked)}
        />
        Show inactive exams
      </label>

      {error && !isLoading && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={fetchExams}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={`skeleton-${i}`} className="h-24 bg-gray-100 rounded-lg animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && !error && organizations.length === 0 && (
        <div className="card text-center py-10">
          <p className="text-gray-500">No exams yet — create the first one to get started.</p>
        </div>
      )}

      {!isLoading &&
        !error &&
        organizations.map((org) => {
          const examsInOrg = groupedExams[org] || [];
          const visibleExams = showInactive
            ? examsInOrg
            : examsInOrg.filter((e) => e.status === 'active');

          return (
            <details key={org} className="card p-0 overflow-hidden" open>
              <summary className="cursor-pointer select-none px-5 py-3 bg-gray-50 border-b border-surface-border font-semibold text-gray-800 flex items-center justify-between">
                <span>{org}</span>
                <span className="text-xs font-normal text-gray-400">
                  {visibleExams.length} exam{visibleExams.length === 1 ? '' : 's'}
                </span>
              </summary>

              {visibleExams.length === 0 ? (
                <p className="px-5 py-6 text-sm text-gray-400">
                  No {showInactive ? '' : 'active '}exams in this organization.
                </p>
              ) : (
                <ul className="divide-y divide-surface-border">
                  {visibleExams.map((exam) => (
                    <li
                      key={exam.exam_id}
                      className="px-5 py-3 flex items-center justify-between gap-4"
                    >
                      <div className="min-w-0">
                        <p className="font-medium text-gray-900 truncate">{exam.exam_name}</p>
                        <p className="text-xs font-mono text-gray-400">{exam.exam_id}</p>
                      </div>

                      <div className="flex items-center gap-4 shrink-0">
                        <ExamStatusBadge status={exam.status} />
                        {typeof exam.blueprintCount === 'number' && (
                          <span className="text-xs text-gray-400">
                            Blueprints: {exam.blueprintCount}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => handleToggleStatus(exam)}
                          disabled={togglingIds.has(exam.exam_id)}
                          className="text-sm text-primary-600 hover:underline disabled:opacity-50"
                        >
                          {exam.status === 'active' ? 'Deactivate' : 'Activate'}
                        </button>
                        <Link
                          to={`/admin/exams/${exam.exam_id}/edit`}
                          className="text-sm text-primary-600 hover:underline"
                        >
                          Edit
                        </Link>
                        <Link
                          to={`/admin/exams/${exam.exam_id}`}
                          className="text-sm text-primary-600 hover:underline"
                        >
                          View
                        </Link>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </details>
          );
        })}
    </div>
  );
}
