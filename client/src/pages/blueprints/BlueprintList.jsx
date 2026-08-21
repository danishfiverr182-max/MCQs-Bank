import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import CloneBlueprintDialog from '@/components/blueprints/CloneBlueprintDialog';

const DIFFICULTY_SEGMENTS = [
  { key: 'easy', barClass: 'bg-easy' },
  { key: 'medium', barClass: 'bg-medium' },
  { key: 'hard', barClass: 'bg-hard' },
];

// Compact inline difficulty bar for a card — same segment coloring as
// DifficultySlider.jsx (Prompt 58) but with no interactivity, since a
// card is a summary, not an editor.
function DifficultyMiniBar({ distribution, totalQuestions }) {
  const total = totalQuestions || 0;
  const { easy = 0, medium = 0, hard = 0 } = distribution || {};

  return (
    <div
      className="flex h-1.5 w-full overflow-hidden rounded-full bg-gray-100"
      title={`Easy ${easy} · Medium ${medium} · Hard ${hard}`}
    >
      {DIFFICULTY_SEGMENTS.map((seg) => {
        const value = distribution?.[seg.key] ?? 0;
        const pct = total > 0 ? (value / total) * 100 : 0;
        return <div key={seg.key} className={seg.barClass} style={{ width: `${pct}%` }} />;
      })}
    </div>
  );
}

// Props: examId — fetches and renders every blueprint for that exam.
export default function BlueprintList({ examId }) {
  const [blueprints, setBlueprints] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);
  // Blueprint pending user confirmation before its "Set Active" PATCH fires.
  const [confirmTarget, setConfirmTarget] = useState(null);
  // blueprint_id currently mid-flight on activate/clone, to disable its own row actions.
  const [busyId, setBusyId] = useState(null);
  // Blueprint pending the clone dialog (Prompt 60) — same shared
  // dialog BlueprintDetail.jsx uses, so cloning behaves identically
  // whether started from the list or the detail page.
  const [cloneTarget, setCloneTarget] = useState(null);
  const [cloneError, setCloneError] = useState(null);

  const fetchBlueprints = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/blueprints/exam/${examId}`);
      setBlueprints(response.data.data.blueprints || []);
    } catch (err) {
      setError(handleApiError(err) || 'Failed to load blueprints');
    } finally {
      setIsLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    if (examId) fetchBlueprints();
  }, [examId, fetchBlueprints]);

  // Active blueprint first, then version descending — a display-order
  // concern specific to this view. The backend's own listByExam sort
  // (version asc, created_at asc) is left as-is for other callers, so
  // this re-sorts client-side rather than special-casing the endpoint.
  const sortedBlueprints = [...blueprints].sort((a, b) => {
    if (a.is_active !== b.is_active) return a.is_active ? -1 : 1;
    return b.version - a.version;
  });

  const handleSetActive = async (blueprint) => {
    setBusyId(blueprint.blueprint_id);
    try {
      await apiClient.patch(`/blueprints/${blueprint.blueprint_id}/activate`);
      toast.success(`${blueprint.blueprint_id} is now the active blueprint`);
      setConfirmTarget(null);
      await fetchBlueprints();
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to activate blueprint');
    } finally {
      setBusyId(null);
    }
  };

  const handleClone = async (overrides) => {
    if (!cloneTarget) return;
    setBusyId(cloneTarget.blueprint_id);
    setCloneError(null);
    try {
      const response = await apiClient.post(`/blueprints/${cloneTarget.blueprint_id}/clone`, {
        overrides,
      });
      const clone = response.data.data.blueprint;
      toast.success(`Cloned as ${clone.blueprint_id}`);
      setCloneTarget(null);
      await fetchBlueprints();
    } catch (err) {
      setCloneError(handleApiError(err) || 'Failed to clone blueprint');
    } finally {
      setBusyId(null);
    }
  };

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 2 }).map((_, i) => (
          <div key={`bp-skeleton-${i}`} className="h-20 bg-gray-100 rounded-lg animate-pulse" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="card border-danger bg-red-50 flex items-center justify-between">
        <p className="text-sm text-danger">{error}</p>
        <button
          type="button"
          onClick={fetchBlueprints}
          className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
        >
          Retry
        </button>
      </div>
    );
  }

  // Zero-blueprint state: an exam with no active blueprint can't
  // generate a test, which is worth surfacing as a prominent nudge
  // rather than a passive empty list.
  if (sortedBlueprints.length === 0) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="font-medium text-gray-800">No blueprints yet</p>
        <p className="text-sm text-gray-500 max-w-md mx-auto">
          This exam can't generate a test until it has an active blueprint. Create the first
          one to define its subjects, question counts, and difficulty mix.
        </p>
        {/* BlueprintBuilder.jsx arrives in Prompt 59 — this link is
            already correctly scoped to examId, matching the same
            forward-reference pattern AddExam.jsx used for ExamDetail. */}
        <Link to={`/admin/exams/${examId}/blueprints/new`}>
          <Button>+ Create first blueprint</Button>
        </Link>
      </div>
    );
  }

  return (
    <>
      <div className="space-y-3">
        {sortedBlueprints.map((bp) => (
          <div
            key={bp.blueprint_id}
            className={`card space-y-3 ${
              bp.is_active ? 'border-2 border-primary-500 bg-primary-50' : ''
            }`}
          >
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-mono text-sm font-semibold text-gray-900">
                    {bp.blueprint_id}
                  </p>
                  <span className="text-xs text-gray-400">v{bp.version}</span>
                  {bp.is_active && (
                    <span className="inline-flex items-center rounded-full bg-primary-600 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-white">
                      Active
                    </span>
                  )}
                </div>
                <p className="text-xs text-gray-500 mt-0.5">
                  {bp.total_questions} question{bp.total_questions === 1 ? '' : 's'} ·{' '}
                  {bp.subjects?.length ?? 0} subject{(bp.subjects?.length ?? 0) === 1 ? '' : 's'}
                </p>
              </div>

              <div className="flex items-center gap-3 shrink-0 text-sm">
                {/* BlueprintDetail.jsx arrived in Prompt 60 — this now
                    resolves instead of 404ing via NotFound. */}
                <Link
                  to={`/admin/blueprints/${bp.blueprint_id}`}
                  className="text-primary-600 hover:underline"
                >
                  View
                </Link>
                <Link
                  to={`/admin/blueprints/${bp.blueprint_id}/edit`}
                  className="text-primary-600 hover:underline"
                >
                  Edit
                </Link>
                <button
                  type="button"
                  onClick={() => {
                    setCloneError(null);
                    setCloneTarget(bp);
                  }}
                  disabled={busyId === bp.blueprint_id}
                  className="text-primary-600 hover:underline disabled:opacity-50"
                >
                  Clone
                </button>
                {!bp.is_active && (
                  <button
                    type="button"
                    onClick={() => setConfirmTarget(bp)}
                    disabled={busyId === bp.blueprint_id}
                    className="text-primary-600 hover:underline disabled:opacity-50"
                  >
                    Set Active
                  </button>
                )}
              </div>
            </div>

            <DifficultyMiniBar
              distribution={bp.difficulty_distribution}
              totalQuestions={bp.total_questions}
            />
          </div>
        ))}
      </div>

      {/* Set Active confirmation — this deactivates whatever was active
          before, a meaningful state change that deserves a confirm
          step rather than a silent one-click switch. Cancelling makes
          no request. */}
      {confirmTarget && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
        >
          <div className="card max-w-sm w-full space-y-4">
            <div className="space-y-1">
              <h2 className="text-base font-semibold text-gray-900">
                Set {confirmTarget.blueprint_id} as active?
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
                onClick={() => setConfirmTarget(null)}
                disabled={busyId === confirmTarget.blueprint_id}
              >
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => handleSetActive(confirmTarget)}
                disabled={busyId === confirmTarget.blueprint_id}
              >
                {busyId === confirmTarget.blueprint_id ? 'Activating…' : 'Set Active'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Clone dialog — Prompt 60's shared component, same one
          BlueprintDetail.jsx uses. */}
      {cloneTarget && (
        <CloneBlueprintDialog
          blueprint={cloneTarget}
          isSubmitting={busyId === cloneTarget.blueprint_id}
          error={cloneError}
          onCancel={() => {
            setCloneTarget(null);
            setCloneError(null);
          }}
          onConfirm={handleClone}
        />
      )}
    </>
  );
}
