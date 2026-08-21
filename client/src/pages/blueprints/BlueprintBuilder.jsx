import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import SubjectRow from '@/components/blueprints/SubjectRow';
import DifficultySlider from '@/components/blueprints/DifficultySlider';
import SumValidator from '@/components/blueprints/SumValidator';
import FeasibilityReport from '@/components/blueprints/FeasibilityReport';

// Stable per-row React keys, independent of subject name/count so a row
// can be edited (even to a blank name mid-typing) without React losing
// track of which DOM node — and which SubjectRow's internal debounce
// timer — it corresponds to.
let rowKeySeq = 0;
const emptyRow = () => ({ key: `row-${(rowKeySeq += 1)}`, name: '', count: 0 });

// A single component for both create and edit, mode inferred from
// route params, so the form itself never has to be maintained twice:
// - /admin/exams/:examId/blueprints/new  → create, params.examId set
// - /admin/blueprints/:blueprintId/edit  → edit, params.blueprintId set
export default function BlueprintBuilder() {
  const params = useParams();
  const navigate = useNavigate();
  const isEditMode = Boolean(params.blueprintId);

  const [examId, setExamId] = useState(params.examId ?? null);
  // Not editable in this form (no UI spec'd for it), but round-tripped
  // unchanged on save — PUT's Zod schema defaults a missing
  // selection_rules to {}, and the service layer treats "present in the
  // body" as "the admin means to (re)set it", so omitting it here would
  // silently wipe out any custom rules already saved on the blueprint.
  const [selectionRules, setSelectionRules] = useState({});

  const [totalQuestions, setTotalQuestions] = useState(100);
  const [subjectRows, setSubjectRows] = useState([emptyRow()]);
  const [difficulty, setDifficulty] = useState({ easy: 0, medium: 0, hard: 0 });
  const [existingSubjectNames, setExistingSubjectNames] = useState([]);

  const [isLoading, setIsLoading] = useState(isEditMode);
  const [loadError, setLoadError] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const [feasibility, setFeasibility] = useState(null);
  const [isCheckingFeasibility, setIsCheckingFeasibility] = useState(false);
  const [feasibilityError, setFeasibilityError] = useState(null);

  // Baseline to detect "the admin changed total_questions after the
  // form already had a value" (edit's loaded value, or create's initial
  // default) as opposed to just the first render setting it.
  const initialTotalRef = useRef(null);

  // Subject name suggestions for SubjectRow's autocomplete — best
  // effort only. Reuses the MCQ stats endpoint's bySubject breakdown
  // (Phase 4) rather than a dedicated "distinct subjects" endpoint,
  // since none exists yet; falls back to an empty list on any failure
  // (wrong role, endpoint missing, network) without blocking the form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await apiClient.get('/mcqs/stats');
        if (!cancelled) {
          setExistingSubjectNames(Object.keys(response.data.data?.bySubject || {}));
        }
      } catch {
        if (!cancelled) setExistingSubjectNames([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Load the existing blueprint in edit mode.
  useEffect(() => {
    if (!isEditMode) {
      initialTotalRef.current = totalQuestions;
      return undefined;
    }

    let cancelled = false;
    (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        const response = await apiClient.get(`/blueprints/${params.blueprintId}`);
        const bp = response.data.data.blueprint;
        if (cancelled) return;

        setExamId(bp.exam_id);
        setSelectionRules(bp.selection_rules ?? {});
        setTotalQuestions(bp.total_questions);
        initialTotalRef.current = bp.total_questions;
        setSubjectRows(
          (bp.subjects || []).map((s) => ({
            key: `row-${(rowKeySeq += 1)}`,
            name: s.name,
            count: s.count,
          }))
        );
        setDifficulty({
          easy: bp.difficulty_distribution?.easy ?? 0,
          medium: bp.difficulty_distribution?.medium ?? 0,
          hard: bp.difficulty_distribution?.hard ?? 0,
        });

        // GET /:blueprintId already computes feasibility for the saved
        // version server-side — show it immediately instead of making
        // the admin click "Check Feasibility" just to see the state
        // their own blueprint is already in.
        if (response.data.data.feasibility) {
          setFeasibility(response.data.data.feasibility);
        }
      } catch (err) {
        if (!cancelled) setLoadError(handleApiError(err) || 'Blueprint not found');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditMode, params.blueprintId]);

  const subjectSum = subjectRows.reduce((sum, r) => sum + (Number(r.count) || 0), 0);
  const difficultySum = difficulty.easy + difficulty.medium + difficulty.hard;

  const subjectsMatch = subjectSum === totalQuestions;
  const difficultyMatch = difficultySum === totalQuestions;
  const canSave = subjectsMatch && difficultyMatch && subjectRows.length > 0 && !isLoading;

  const totalQuestionsChanged =
    initialTotalRef.current !== null && totalQuestions !== initialTotalRef.current;

  const handleTotalQuestionsChange = (e) => {
    const raw = Number(e.target.value);
    setTotalQuestions(Number.isFinite(raw) && raw >= 0 ? raw : 0);
  };

  const updateSubjectRow = (key, updated) => {
    setSubjectRows((prev) => prev.map((r) => (r.key === key ? { key, ...updated } : r)));
  };

  const removeSubjectRow = (key) => {
    setSubjectRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.key !== key)));
  };

  const addSubjectRow = () => {
    setSubjectRows((prev) => [...prev, emptyRow()]);
  };

  const buildPayload = () => ({
    exam_id: examId,
    total_questions: totalQuestions,
    subjects: subjectRows.map((r) => ({
      name: (r.name ?? '').trim(),
      count: Number(r.count) || 0,
    })),
    difficulty_distribution: difficulty,
    selection_rules: selectionRules,
  });

  const handleCheckFeasibility = async () => {
    setIsCheckingFeasibility(true);
    setFeasibilityError(null);
    try {
      const response = await apiClient.post('/blueprints/validate', buildPayload());
      setFeasibility(response.data.data.feasibility);
    } catch (err) {
      setFeasibilityError(handleApiError(err) || 'Feasibility check failed');
    } finally {
      setIsCheckingFeasibility(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      const payload = buildPayload();
      if (isEditMode) {
        await apiClient.put(`/blueprints/${params.blueprintId}`, payload);
      } else {
        await apiClient.post('/blueprints', payload);
      }
      navigate(`/admin/exams/${examId}`, {
        state: {
          toast: isEditMode ? 'Blueprint updated successfully' : 'Blueprint created successfully',
        },
      });
    } catch (err) {
      setSaveError(handleApiError(err) || 'Failed to save blueprint');
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{loadError}</p>
        <Link to="/admin/exams" className="text-sm text-primary-600 hover:underline">
          Back to exam list
        </Link>
      </div>
    );
  }

  const fieldClass =
    'w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
  const labelClass = 'text-sm font-medium text-gray-700';

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">
            {isEditMode ? `Edit Blueprint — ${params.blueprintId}` : 'New Blueprint'}
          </h1>
          {examId && <p className="text-xs font-mono text-gray-400">Exam: {examId}</p>}
        </div>
        {examId && (
          <Link to={`/admin/exams/${examId}`} className="text-sm text-primary-600 hover:underline">
            Back to exam
          </Link>
        )}
      </div>

      {saveError && (
        <div className="rounded-md border border-danger bg-red-50 px-3 py-2 text-sm text-danger">
          {saveError}
        </div>
      )}

      {/* Total questions — the pivot point every sum below must retarget to. */}
      <div className="card space-y-2">
        <label htmlFor="total_questions" className={labelClass}>
          Total questions
        </label>
        <input
          id="total_questions"
          type="number"
          min={0}
          value={totalQuestions}
          onChange={handleTotalQuestionsChange}
          className={`${fieldClass} max-w-xs`}
        />
        {totalQuestionsChanged && (
          <p className="text-xs text-warning-dark bg-warning-light rounded-md px-3 py-2">
            You changed the total to {totalQuestions} — the subject and difficulty counts below
            may no longer add up. Adjust them before saving.
          </p>
        )}
      </div>

      {/* Subjects */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Subjects</h2>
          <SumValidator label="Subjects" currentSum={subjectSum} expectedTotal={totalQuestions} />
        </div>

        <div className="space-y-2">
          {subjectRows.map((row) => (
            <SubjectRow
              key={row.key}
              subject={{ name: row.name, count: row.count }}
              onChange={(updated) => updateSubjectRow(row.key, updated)}
              onRemove={() => removeSubjectRow(row.key)}
              disableRemove={subjectRows.length <= 1}
              existingSubjectNames={existingSubjectNames}
            />
          ))}
        </div>

        <button
          type="button"
          onClick={addSubjectRow}
          className="text-sm text-primary-600 hover:underline"
        >
          + Add Subject
        </button>
      </div>

      {/* Difficulty distribution */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Difficulty distribution</h2>
          <SumValidator
            label="Difficulty"
            currentSum={difficultySum}
            expectedTotal={totalQuestions}
          />
        </div>
        <DifficultySlider
          distribution={difficulty}
          totalQuestions={totalQuestions}
          onChange={setDifficulty}
        />
      </div>

      {/* Feasibility */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-gray-800">Feasibility against question bank</h2>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleCheckFeasibility}
            disabled={isCheckingFeasibility}
          >
            {isCheckingFeasibility ? 'Checking…' : 'Check Feasibility'}
          </Button>
        </div>
        {feasibilityError && <p className="text-sm text-danger">{feasibilityError}</p>}
        <FeasibilityReport report={feasibility} loading={isCheckingFeasibility} />
      </div>

      {/* Save — disabled until subjects and difficulty each sum exactly
          to total_questions, catching the invariant client-side before
          the backend's Zod superRefine would reject it anyway. */}
      <div className="flex items-center justify-end gap-3">
        {examId && (
          <Link to={`/admin/exams/${examId}`}>
            <Button type="button" variant="outline" disabled={isSaving}>
              Cancel
            </Button>
          </Link>
        )}
        <Button type="button" onClick={handleSave} disabled={!canSave || isSaving}>
          {isSaving ? 'Saving…' : isEditMode ? 'Save changes' : 'Create blueprint'}
        </Button>
      </div>
    </div>
  );
}
