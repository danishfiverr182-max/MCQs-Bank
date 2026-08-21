import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import apiClient, { handleApiError } from '@/lib/axios';

// Same segment coloring as DifficultySlider.jsx / BlueprintDetail.jsx's
// StaticDifficultyBar — kept visually identical on purpose (Prompt 67's
// DoD: this preview should be immediately recognizable as "the same
// kind of information" as BlueprintDetail.jsx, just one step earlier
// in the flow), rather than introducing a new color scheme here.
const DIFFICULTY_SEGMENTS = [
  { key: 'easy', label: 'Easy', barClass: 'bg-easy', textClass: 'text-easy-text' },
  { key: 'medium', label: 'Medium', barClass: 'bg-medium', textClass: 'text-medium-text' },
  { key: 'hard', label: 'Hard', barClass: 'bg-hard', textClass: 'text-hard-text' },
];

// Read-only stacked bar — mirrors BlueprintDetail.jsx's StaticDifficultyBar
// verbatim in structure/classes so the two never visually drift apart.
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

// Static stand-in for SubjectRow.jsx — same row footprint (name left,
// count right) but no inputs; this page only ever previews a saved
// blueprint, it never edits one.
function StaticSubjectRow({ name, count }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-surface-border px-3 py-2 text-sm">
      <span className="truncate text-gray-800">{name}</span>
      <span className="shrink-0 text-gray-500">
        {count} question{count === 1 ? '' : 's'}
      </span>
    </div>
  );
}

// Props:
// - examId: the exam to preview the active blueprint for.
// - onBlueprintResolved(blueprint | null): optional callback fired once
//   the lookup settles, so a parent (GeneratorForm.jsx) can gate its
//   "Generate Test" button on whether a usable active blueprint exists
//   without re-fetching the same list itself.
export default function BlueprintPreview({ examId, onBlueprintResolved }) {
  const [blueprints, setBlueprints] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchBlueprints = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/blueprints/exam/${examId}`);
      setBlueprints(response.data.data.blueprints || []);
    } catch (err) {
      setError(handleApiError(err) || 'Failed to load blueprints for this exam');
      setBlueprints([]);
    } finally {
      setIsLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    if (!examId) return;
    fetchBlueprints();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examId]);

  const activeBlueprint = (blueprints || []).find((b) => b.is_active) || null;

  // Report the resolved active blueprint (or its absence) up to the
  // parent form as soon as we know it — this is the single source of
  // truth GeneratorForm.jsx uses to enable/disable "Generate Test".
  useEffect(() => {
    if (!isLoading) onBlueprintResolved?.(activeBlueprint);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, activeBlueprint?.blueprint_id]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        <div className="h-5 w-1/3 rounded bg-gray-100 animate-pulse" />
        <div className="h-16 w-full rounded bg-gray-100 animate-pulse" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md bg-danger-light px-4 py-3 text-sm text-danger-dark flex items-center justify-between gap-3">
        <span>{error}</span>
        <button type="button" onClick={fetchBlueprints} className="font-medium hover:underline shrink-0">
          Retry
        </button>
      </div>
    );
  }

  if (!activeBlueprint) {
    return (
      <div className="rounded-md bg-danger-light px-4 py-3 text-sm text-danger-dark space-y-1">
        <p className="font-medium">
          No active blueprint for this exam — generation will fail until one is activated.
        </p>
        <Link to={`/admin/exams/${examId}`} className="underline hover:no-underline">
          Go activate one on the exam page →
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-gray-600">
        <span className="font-medium text-gray-800">{activeBlueprint.blueprint_id}</span> ·{' '}
        {activeBlueprint.total_questions} question
        {activeBlueprint.total_questions === 1 ? '' : 's'} ·{' '}
        {(activeBlueprint.subjects || []).length} subject
        {(activeBlueprint.subjects || []).length === 1 ? '' : 's'}
      </p>

      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Subject breakdown
        </h3>
        <div className="space-y-1.5">
          {(activeBlueprint.subjects || []).map((s) => (
            <StaticSubjectRow key={s.name} name={s.name} count={s.count} />
          ))}
        </div>
      </div>

      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          Difficulty distribution
        </h3>
        <StaticDifficultyBar
          distribution={activeBlueprint.difficulty_distribution}
          totalQuestions={activeBlueprint.total_questions}
        />
      </div>
    </div>
  );
}
