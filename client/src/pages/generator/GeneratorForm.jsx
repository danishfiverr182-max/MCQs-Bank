import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import ExamSelector from '@/components/generator/ExamSelector';
import BlueprintPreview from '@/components/generator/BlueprintPreview';
import GenerationProgress from '@/components/generator/GenerationProgress';
import DifficultySlider from '@/components/blueprints/DifficultySlider';
import SumValidator from '@/components/blueprints/SumValidator';

// Client-driven timing for GenerationProgress.jsx's "Filtering" and
// "Assembling" steps — see that component's header comment for why
// these exist at all. Tuned to feel like real work without dragging
// out a normally-fast request; both are cleared the instant the real
// response lands, whichever comes first.
const FILTERING_DELAY_MS = 600;
const ASSEMBLING_DELAY_MS = 1400;
// How long the "Done" step stays visible before navigating away, so
// the animation's payoff is actually seen rather than an instant
// redirect that undercuts the point of animating at all.
const DONE_PAUSE_MS = 900;

const DEFAULT_QUALITY_THRESHOLD = 50;

export default function GeneratorForm() {
  const navigate = useNavigate();
  const location = useLocation();

  // ExamDetail.jsx's "Generate Test" button passes the exam it was
  // already showing via route state (same shape ExamSelector.jsx
  // hands back through onSelect), so an admin starting from an exam's
  // own page doesn't have to re-pick it here.
  const [selectedExam, setSelectedExam] = useState(location.state?.preselectedExam ?? null);
  const [activeBlueprint, setActiveBlueprint] = useState(null);

  // Advanced Options — starts collapsed; most generations use blueprint
  // defaults untouched, per the spec's stated rationale for keeping the
  // primary pick-exam → generate flow fast for the common case.
  const [qualityThreshold, setQualityThreshold] = useState(DEFAULT_QUALITY_THRESHOLD);
  const [difficultyOverrideEnabled, setDifficultyOverrideEnabled] = useState(false);
  const [difficultyOverride, setDifficultyOverride] = useState(null);
  const [excludedRecentTests, setExcludedRecentTests] = useState('');

  const [stage, setStage] = useState('idle');
  const [errorDetail, setErrorDetail] = useState(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const timersRef = useRef([]);
  const clearTimers = () => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  };
  useEffect(() => clearTimers, []);

  useEffect(() => {
    if (location.state?.preselectedExam) {
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Selecting a new exam invalidates everything downstream — the
  // previously-resolved blueprint, any in-progress generation state,
  // and any overrides seeded from the old blueprint's shape.
  const handleSelectExam = (exam) => {
    setSelectedExam(exam);
    setActiveBlueprint(null);
    setDifficultyOverrideEnabled(false);
    setDifficultyOverride(null);
    setQualityThreshold(DEFAULT_QUALITY_THRESHOLD);
    setExcludedRecentDays('');
    setStage('idle');
    setErrorDetail(null);
  };

  const handleBlueprintResolved = (blueprint) => {
    setActiveBlueprint(blueprint);
    if (blueprint) {
      setDifficultyOverride({ ...blueprint.difficulty_distribution });
    }
  };

  const overrideSumValid =
    !difficultyOverrideEnabled ||
    !activeBlueprint ||
    !difficultyOverride ||
    (difficultyOverride.easy || 0) + (difficultyOverride.medium || 0) + (difficultyOverride.hard || 0) ===
      activeBlueprint.total_questions;

  const canGenerate =
    Boolean(selectedExam && activeBlueprint) && !isSubmitting && overrideSumValid;

  const handleGenerate = async () => {
    // Guards against a rapid double-click firing two overlapping
    // requests — the button is also `disabled` while this is true, but
    // that disable only takes effect after the next render, so the
    // flag itself is the real guard.
    if (!canGenerate || isSubmitting) return;

    setIsSubmitting(true);
    setErrorDetail(null);
    setStage('loading');
    clearTimers();

    timersRef.current.push(
      setTimeout(() => setStage('filtering'), FILTERING_DELAY_MS),
      setTimeout(() => setStage('assembling'), FILTERING_DELAY_MS + ASSEMBLING_DELAY_MS)
    );

    const payload = {
      exam_id: selectedExam.exam_id,
      quality_threshold: qualityThreshold,
    };
    if (difficultyOverrideEnabled && difficultyOverride) {
      payload.difficulty_override = difficultyOverride;
    }
    if (excludedRecentTests !== '' && Number(excludedRecentTests) > 0) {
      // BUGFIX: this used to send `excluded_recent_days`, which doesn't
      // match generateWithOverridesSchema's `exclude_recent_days` field
      // name — the mismatched key was silently stripped by Zod (no
      // `.strict()` on that schema), so this option never actually
      // reached the backend from this page. Renamed to tests-based and
      // fixed to the correct key name in the same change.
      payload.exclude_recent_tests = Number(excludedRecentTests);
    }

    try {
      // Overrides the shared 10s default (see lib/axios.js). generateTest
      // (server/src/services/generator.service.js) runs feasibility
      // validation, per-subject pool fetch/sampling, persistTest,
      // updateExposureCounts, and then an auto-triggered full QA pass on
      // the assembled test — all sequentially, inside this one request.
      // On a blueprint with several subjects and a non-trivial bank size
      // that can genuinely take longer than 10s. Without this override,
      // a slow-but-successful generation was being aborted client-side
      // right as the UI sat on the "assembling" stage, and misreported
      // as "Network error — check your connection" even though nothing
      // was actually wrong with the connection (same class of bug as
      // TaxonomyManager.jsx's fetchTaxonomy override).
      const response = await apiClient.post('/generator/generate', payload, { timeout: 120000 });
      clearTimers();
      const test = response.data.data.test;
      setStage('done');
      toast.success(`${test.test_id} generated successfully`);
      setTimeout(() => {
        // GeneratedTest.jsx lands in a later prompt — this is the
        // agreed destination route for it once it does.
        navigate(`/admin/generator/tests/${test.test_id}`);
      }, DONE_PAUSE_MS);
    } catch (err) {
      clearTimers();
      setStage('error');
      if (err?.statusCode === 422 && err?.errors?.report) {
        // Infeasible blueprint — keep the admin on this page and show
        // exactly what's short via the reused feasibility report,
        // rather than navigating away from a fixable problem.
        setErrorDetail({ report: err.errors.report });
      } else {
        const message = handleApiError(err) || 'Failed to generate test';
        setErrorDetail(message);
        toast.error(message);
      }
      setIsSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="section-title">Generate Test</h1>
        <p className="text-sm text-gray-500">
          Pick an exam, review what will be generated, then run it against the current question
          bank.
        </p>
        <Link
          to="/admin/generator/advanced"
          className="inline-block mt-1 text-sm text-primary-600 hover:underline"
        >
          Need more control? Try Advanced Generation →
        </Link>
      </div>

      <div className="card space-y-4">
        <ExamSelector value={selectedExam} onSelect={handleSelectExam} />

        {selectedExam && (
          <BlueprintPreview examId={selectedExam.exam_id} onBlueprintResolved={handleBlueprintResolved} />
        )}
      </div>

      {selectedExam && (
        <details className="card p-0 overflow-hidden">
          <summary className="cursor-pointer select-none px-5 py-3 bg-gray-50 border-b border-surface-border font-semibold text-gray-800">
            Advanced Options
          </summary>

          <div className="px-5 py-4 space-y-5">
            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-gray-700">Quality threshold</span>
              <input
                type="number"
                min={0}
                max={100}
                value={qualityThreshold}
                onChange={(e) => {
                  const raw = Number(e.target.value);
                  setQualityThreshold(Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 0);
                }}
                className="w-32 rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              <span className="block text-xs text-gray-400">
                Minimum MCQ quality score to draw from (0–100). Defaults to {DEFAULT_QUALITY_THRESHOLD}.
              </span>
            </label>

            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 select-none">
                <input
                  type="checkbox"
                  checked={difficultyOverrideEnabled}
                  onChange={(e) => setDifficultyOverrideEnabled(e.target.checked)}
                />
                Override difficulty distribution
              </label>
              {difficultyOverrideEnabled && activeBlueprint && difficultyOverride && (
                <div className="space-y-2">
                  <DifficultySlider
                    distribution={difficultyOverride}
                    totalQuestions={activeBlueprint.total_questions}
                    onChange={setDifficultyOverride}
                  />
                  {/* The slider's drag/keyboard handles keep the sum exact by
                      construction, but the manual number inputs beside them
                      don't — same caveat DifficultySlider.jsx documents for
                      BlueprintBuilder.jsx. Surfacing it here the same way. */}
                  <SumValidator
                    label="Difficulty"
                    currentSum={
                      (difficultyOverride.easy || 0) +
                      (difficultyOverride.medium || 0) +
                      (difficultyOverride.hard || 0)
                    }
                    expectedTotal={activeBlueprint.total_questions}
                  />
                </div>
              )}
              {!difficultyOverrideEnabled && (
                <p className="text-xs text-gray-400">
                  Off by default — generation uses the blueprint's own distribution shown above.
                </p>
              )}
            </div>

            <label className="block space-y-1.5">
              <span className="text-sm font-medium text-gray-700">
                Exclude recently-used MCQs (tests)
              </span>
              <input
                type="number"
                min={1}
                value={excludedRecentTests}
                onChange={(e) => setExcludedRecentTests(e.target.value)}
                placeholder="Optional"
                className="w-32 rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
          </div>
        </details>
      )}

      <div className="card space-y-4">
        <Button type="button" onClick={handleGenerate} disabled={!canGenerate} className="w-full">
          {isSubmitting ? 'Generating…' : 'Generate Test'}
        </Button>

        <GenerationProgress stage={stage} errorDetail={errorDetail} />
      </div>
    </div>
  );
}
