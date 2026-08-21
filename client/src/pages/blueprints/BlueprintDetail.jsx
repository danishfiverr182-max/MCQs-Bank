import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { getBlueprintComplianceReport } from '@/api/reportApi';
import { Button } from '@/components/ui/button';
import FeasibilityReport from '@/components/blueprints/FeasibilityReport';
import CloneBlueprintDialog from '@/components/blueprints/CloneBlueprintDialog';
import SubjectBarChart from '@/components/analytics/SubjectBarChart';

// Same segment coloring as DifficultySlider.jsx / BlueprintList.jsx's
// DifficultyMiniBar — kept visually consistent across all three views,
// just with decreasing amounts of interactivity (editable slider →
// hover-title mini bar → this static labeled bar).
const DIFFICULTY_SEGMENTS = [
  { key: 'easy', label: 'Easy', barClass: 'bg-easy', textClass: 'text-easy-text' },
  { key: 'medium', label: 'Medium', barClass: 'bg-medium', textClass: 'text-medium-text' },
  { key: 'hard', label: 'Hard', barClass: 'bg-hard', textClass: 'text-hard-text' },
];

// Read-only, non-editable version of DifficultySlider's stacked bar —
// this page audits a saved blueprint's health, it never edits it.
function StaticDifficultyBar({ distribution, totalQuestions }) {
  const total = totalQuestions > 0 ? totalQuestions : 0;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap justify-between gap-2 text-xs font-medium">
        {DIFFICULTY_SEGMENTS.map((seg) => {
          const value = distribution?.[seg.key] ?? 0;
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <span key={seg.key} className={seg.textClass}>
              {seg.label}: {pct}% ({value} question{value === 1 ? '' : 's'})
            </span>
          );
        })}
      </div>
      <div className="flex h-6 w-full overflow-hidden rounded-md bg-gray-100">
        {DIFFICULTY_SEGMENTS.map((seg) => {
          const value = distribution?.[seg.key] ?? 0;
          const pct = total > 0 ? (value / total) * 100 : 0;
          return <div key={seg.key} className={`h-full ${seg.barClass}`} style={{ width: `${pct}%` }} />;
        })}
      </div>
    </div>
  );
}

function SufficiencyIcon({ sufficient }) {
  return (
    <span
      className={`inline-flex items-center justify-center h-5 w-5 rounded-full text-xs font-bold ${
        sufficient ? 'bg-success-light text-success-dark' : 'bg-danger-light text-danger-dark'
      }`}
      aria-label={sufficient ? 'Sufficient' : 'Insufficient'}
      title={sufficient ? 'Sufficient MCQs available' : 'Not enough MCQs available'}
    >
      {sufficient ? '✓' : '✗'}
    </span>
  );
}

export default function BlueprintDetail() {
  const { blueprintId } = useParams();
  const navigate = useNavigate();

  const [blueprint, setBlueprint] = useState(null);
  const [feasibility, setFeasibility] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Best-effort parent exam name — resolved via a second call since
  // Blueprint only stores exam_id (a string reference, per Phase 5's
  // convention), not an embedded exam document. Falls back to the raw
  // exam_id if this fails, same graceful-degradation pattern
  // BlueprintBuilder.jsx uses for its subject-name suggestions.
  const [examName, setExamName] = useState(null);

  const [confirmActive, setConfirmActive] = useState(false);
  const [isActivating, setIsActivating] = useState(false);

  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [isCloning, setIsCloning] = useState(false);
  const [cloneError, setCloneError] = useState(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Prompt 100: the compliance report (GET /reports/blueprint/:id) is a
  // different read than the `feasibility` object already embedded in
  // GET /blueprints/:id above — that one is Phase 5's own
  // checkMCQAvailability output; this one is Phase 9's
  // subjectCoveragePercent-backed report plus an explicit
  // `overallGeneratable` flag. Fetched independently so a slow/failed
  // report call never blocks the rest of an already-working page.
  const [complianceReport, setComplianceReport] = useState(null);
  const [complianceLoading, setComplianceLoading] = useState(true);
  const [complianceError, setComplianceError] = useState(null);

  const fetchComplianceReport = useCallback(async () => {
    setComplianceLoading(true);
    setComplianceError(null);
    try {
      const data = await getBlueprintComplianceReport(blueprintId);
      setComplianceReport(data);
    } catch (err) {
      setComplianceError(err.message || 'Failed to load compliance report');
    } finally {
      setComplianceLoading(false);
    }
  }, [blueprintId]);

  useEffect(() => {
    fetchComplianceReport();
  }, [fetchComplianceReport]);

  const fetchBlueprint = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/blueprints/${blueprintId}`);
      setBlueprint(response.data.data.blueprint);
      setFeasibility(response.data.data.feasibility);
    } catch (err) {
      setError(handleApiError(err) || 'Blueprint not found');
    } finally {
      setIsLoading(false);
    }
  }, [blueprintId]);

  useEffect(() => {
    fetchBlueprint();
  }, [fetchBlueprint]);

  useEffect(() => {
    if (!blueprint?.exam_id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiClient.get(`/exams/${blueprint.exam_id}`);
        if (!cancelled) setExamName(response.data.data.exam?.exam_name || null);
      } catch {
        if (!cancelled) setExamName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blueprint?.exam_id]);

  const handleSetActive = async () => {
    setIsActivating(true);
    try {
      await apiClient.patch(`/blueprints/${blueprintId}/activate`);
      toast.success(`${blueprintId} is now the active blueprint`);
      setConfirmActive(false);
      await fetchBlueprint();
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to activate blueprint');
    } finally {
      setIsActivating(false);
    }
  };

  const handleClone = async (overrides) => {
    setIsCloning(true);
    setCloneError(null);
    try {
      const response = await apiClient.post(`/blueprints/${blueprintId}/clone`, { overrides });
      const clone = response.data.data.blueprint;
      toast.success(`Cloned as ${clone.blueprint_id}`);
      navigate(`/admin/blueprints/${clone.blueprint_id}`);
    } catch (err) {
      setCloneError(handleApiError(err) || 'Failed to clone blueprint');
    } finally {
      setIsCloning(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await apiClient.delete(`/blueprints/${blueprintId}`);
      navigate(`/admin/exams/${blueprint.exam_id}`, {
        state: { toast: `${blueprintId} deleted successfully` },
      });
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to delete blueprint');
      setConfirmDelete(false);
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  if (!blueprint) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{error || 'Blueprint not found'}</p>
        <Link to="/admin/exams" className="text-sm text-primary-600 hover:underline">
          Back to exam list
        </Link>
      </div>
    );
  }

  const subjectAvailability = new Map(
    (feasibility?.subjects || []).map((s) => [s.name, s])
  );

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div className="card space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="section-title font-mono">{blueprint.blueprint_id}</h1>
              <span className="text-xs text-gray-400">v{blueprint.version}</span>
              {blueprint.is_active && (
                <span className="inline-flex items-center rounded-full bg-primary-600 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                  Active
                </span>
              )}
            </div>
            <p className="text-sm text-gray-500">
              Exam:{' '}
              <Link
                to={`/admin/exams/${blueprint.exam_id}`}
                className="text-primary-600 hover:underline"
              >
                {examName || blueprint.exam_id}
              </Link>
            </p>
            <p className="text-xs text-gray-400">
              Created {blueprint.created_at ? new Date(blueprint.created_at).toLocaleString() : '—'}
              {blueprint.created_by ? ` by ${blueprint.created_by}` : ''}
            </p>
          </div>

          <Link to={`/admin/exams/${blueprint.exam_id}`} className="text-sm text-primary-600 hover:underline">
            Back to exam
          </Link>
        </div>

        <p className="text-sm text-gray-600">
          {blueprint.total_questions} question{blueprint.total_questions === 1 ? '' : 's'} ·{' '}
          {blueprint.subjects?.length ?? 0} subject{(blueprint.subjects?.length ?? 0) === 1 ? '' : 's'}
        </p>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-3 pt-1">
          <Link to={`/admin/blueprints/${blueprint.blueprint_id}/edit`}>
            <Button type="button" variant="outline" size="sm">
              Edit
            </Button>
          </Link>
          <Button type="button" variant="outline" size="sm" onClick={() => setShowCloneDialog(true)}>
            Clone
          </Button>
          {!blueprint.is_active && (
            <Button type="button" size="sm" onClick={() => setConfirmActive(true)}>
              Set Active
            </Button>
          )}
          <span
            title={
              blueprint.is_active
                ? 'The active blueprint can\u2019t be deleted \u2014 activate another one first'
                : undefined
            }
          >
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={blueprint.is_active}
              onClick={() => setConfirmDelete(true)}
            >
              Delete
            </Button>
          </span>
        </div>
      </div>

      {/* Subject breakdown */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-800">Subject breakdown</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-surface-border">
                <th className="py-2 pr-4 font-medium">Subject</th>
                <th className="py-2 pr-4 font-medium">Required</th>
                <th className="py-2 pr-4 font-medium">Available</th>
                <th className="py-2 pr-4 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-surface-border">
              {(blueprint.subjects || []).map((s) => {
                const avail = subjectAvailability.get(s.name);
                return (
                  <tr key={s.name}>
                    <td className="py-2 pr-4 text-gray-800">{s.name}</td>
                    <td className="py-2 pr-4 text-gray-600">{s.count}</td>
                    <td className="py-2 pr-4 text-gray-600">
                      {avail ? avail.available : '—'}
                    </td>
                    <td className="py-2 pr-4">
                      {avail ? <SufficiencyIcon sufficient={avail.sufficient} /> : '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Difficulty distribution */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-800">Difficulty distribution</h2>
        <StaticDifficultyBar
          distribution={blueprint.difficulty_distribution}
          totalQuestions={blueprint.total_questions}
        />
      </div>

      {/* Feasibility */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-800">Feasibility against question bank</h2>
        <FeasibilityReport report={feasibility} loading={false} />
      </div>

      {/* Compliance Report — Prompt 100 */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-800">Compliance Report</h2>

        {complianceLoading && (
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
          </div>
        )}

        {!complianceLoading && complianceError && (
          <div className="flex items-center justify-between">
            <p className="text-sm text-danger">{complianceError}</p>
            <button
              type="button"
              onClick={fetchComplianceReport}
              className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
            >
              Retry
            </button>
          </div>
        )}

        {!complianceLoading && !complianceError && complianceReport && (
          <div className="space-y-4">
            {complianceReport.overallGeneratable ? (
              <div className="rounded-md border border-success bg-success-light px-4 py-3 text-sm font-medium text-success-dark">
                ✓ Ready to generate — every subject has enough approved MCQs to satisfy this
                blueprint.
              </div>
            ) : (
              <div className="rounded-md border border-danger bg-red-50 px-4 py-3 text-sm font-medium text-danger">
                ✗ Insufficient questions in{' '}
                {(complianceReport.coverage || []).filter((c) => c.available < c.required).length}{' '}
                subject
                {(complianceReport.coverage || []).filter((c) => c.available < c.required).length === 1
                  ? ''
                  : 's'}
                :{' '}
                {(complianceReport.coverage || [])
                  .filter((c) => c.available < c.required)
                  .map((c) => `${c.subject} (${c.available}/${c.required})`)
                  .join(', ')}
              </div>
            )}

            <div className="h-72">
              <SubjectBarChart data={complianceReport.coverage || []} mode="coverage" />
            </div>
          </div>
        )}
      </div>

      {/* Set Active confirmation — same pattern as BlueprintList.jsx */}
      {confirmActive && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="card max-w-sm w-full space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-gray-900">
                Set {blueprint.blueprint_id} as active?
              </h2>
              <p className="text-sm text-gray-500">
                This deactivates the exam's current active blueprint. Test generation will use
                this version instead.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmActive(false)}
                disabled={isActivating}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handleSetActive} disabled={isActivating}>
                {isActivating ? 'Activating…' : 'Set Active'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Clone dialog */}
      {showCloneDialog && (
        <CloneBlueprintDialog
          blueprint={blueprint}
          isSubmitting={isCloning}
          error={cloneError}
          onCancel={() => {
            setShowCloneDialog(false);
            setCloneError(null);
          }}
          onConfirm={handleClone}
        />
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="card max-w-sm w-full space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-gray-900">
                Delete {blueprint.blueprint_id}?
              </h2>
              <p className="text-sm text-gray-500">
                This permanently removes this blueprint version. This cannot be undone.
              </p>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setConfirmDelete(false)}
                disabled={isDeleting}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onClick={handleDelete}
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
