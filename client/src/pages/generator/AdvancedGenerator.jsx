import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import ExamSelector from '@/components/generator/ExamSelector';
import BlueprintPreview from '@/components/generator/BlueprintPreview';
import GenerationProgress from '@/components/generator/GenerationProgress';
import OverridePanel from '@/components/generator/OverridePanel';
import GenerationSummary from '@/components/generator/GenerationSummary';
import InsufficientWarning from '@/components/generator/InsufficientWarning';

// AdvancedGenerator.jsx — Prompt 80. Phase 7's full override flow:
// exam → blueprint → OverridePanel → live feasibility → generate,
// wired end to end. GeneratorForm.jsx (Phase 6) is the "just use the
// blueprint" fast path; this page is the "I need to tune this" path —
// the two link to each other rather than being disconnected.

// Same client-driven timing as GeneratorForm.jsx's GenerationProgress
// staging — see that file's header comment for why these exist at all.
const FILTERING_DELAY_MS = 600;
const ASSEMBLING_DELAY_MS = 1400;
const DONE_PAUSE_MS = 900;

// How long to wait after the last override change before firing a
// feasibility check — long enough that a burst of clicks/keystrokes
// while tuning the panel collapses into a single request, short enough
// to still feel like "live" feedback.
const FEASIBILITY_DEBOUNCE_MS = 500;

export default function AdvancedGenerator() {
  const navigate = useNavigate();
  const location = useLocation();

  const [selectedExam, setSelectedExam] = useState(location.state?.preselectedExam ?? null);
  const [activeBlueprint, setActiveBlueprint] = useState(null);
  const [overrides, setOverrides] = useState({});

  // Remounting OverridePanel (via a changing `key`) is how
  // "Relax Filters" resets every control back to its default in one
  // shot — OverridePanel owns its own internal state and doesn't
  // expose per-field setters, so a clean remount is the simplest way
  // to give this page a "start over" affordance without threading
  // eight setters up through props.
  const [overridePanelResetKey, setOverridePanelResetKey] = useState(0);

  const [feasibilityReport, setFeasibilityReport] = useState(null);
  const [isCheckingFeasibility, setIsCheckingFeasibility] = useState(false);

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

  const handleSelectExam = (exam) => {
    setSelectedExam(exam);
    setActiveBlueprint(null);
    setOverrides({});
    setOverridePanelResetKey((k) => k + 1);
    setFeasibilityReport(null);
    setStage('idle');
    setErrorDetail(null);
  };

  const handleBlueprintResolved = (blueprint) => {
    setActiveBlueprint(blueprint);
  };

  const handleRelaxFilters = () => {
    setOverrides({});
    setOverridePanelResetKey((k) => k + 1);
  };

  // ── Live feasibility checking ────────────────────────────────────
  // Debounced: fires FEASIBILITY_DEBOUNCE_MS after the last change to
  // exam/blueprint/overrides, not on every intermediate keystroke.
  // Keeps the PREVIOUS feasibilityReport visible while a new check is
  // in flight (only isCheckingFeasibility flips), so the summary/
  // warning never flash empty on a routine debounce cycle. A request
  // sequence number guards against a slow earlier response clobbering
  // a faster later one if two checks ever race.
  const feasibilityRequestId = useRef(0);

  useEffect(() => {
    if (!selectedExam || !activeBlueprint) {
      setFeasibilityReport(null);
      setIsCheckingFeasibility(false);
      return undefined;
    }

    const thisRequestId = feasibilityRequestId.current + 1;
    feasibilityRequestId.current = thisRequestId;

    setIsCheckingFeasibility(true);
    const timer = setTimeout(async () => {
      try {
        const response = await apiClient.post('/generator/check-feasibility', {
          exam_id: selectedExam.exam_id,
          ...overrides,
        });
        if (feasibilityRequestId.current !== thisRequestId) return; // superseded
        setFeasibilityReport(response.data.data.report);
      } catch (err) {
        if (feasibilityRequestId.current !== thisRequestId) return;
        toast.error(handleApiError(err) || 'Failed to check feasibility');
      } finally {
        if (feasibilityRequestId.current === thisRequestId) {
          setIsCheckingFeasibility(false);
        }
      }
    }, FEASIBILITY_DEBOUNCE_MS);

    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedExam?.exam_id, activeBlueprint?.blueprint_id, overrides]);

  const canGenerate =
    Boolean(selectedExam && activeBlueprint) &&
    !isSubmitting &&
    feasibilityReport?.feasible !== false;

  const handleGenerate = async () => {
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
      ...overrides,
    };

    try {
      // See GeneratorForm.jsx's handleGenerate for the full reasoning —
      // same endpoint, same multi-step pipeline (feasibility validation,
      // per-subject sampling, persist, exposure update, auto-QA), same
      // need for headroom past the shared 10s default.
      const response = await apiClient.post('/generator/generate', payload, { timeout: 120000 });
      clearTimers();
      const test = response.data.data.test;
      setStage('done');
      toast.success(`${test.test_id} generated successfully`);
      setTimeout(() => {
        navigate(`/admin/generator/tests/${test.test_id}`);
      }, DONE_PAUSE_MS);
    } catch (err) {
      clearTimers();
      setStage('error');
      if (err?.statusCode === 422 && err?.errors?.report) {
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
        <h1 className="section-title">Advanced Generation</h1>
        <p className="text-sm text-gray-500">
          Pick an exam, tune any override, and see live feasibility feedback before generating.
        </p>
        <Link
          to="/admin/generator"
          className="inline-block mt-1 text-sm text-primary-600 hover:underline"
        >
          Just want the defaults? Use Simple Generation →
        </Link>
      </div>

      <div className="card space-y-4">
        <ExamSelector value={selectedExam} onSelect={handleSelectExam} />

        {selectedExam && (
          <BlueprintPreview
            examId={selectedExam.exam_id}
            onBlueprintResolved={handleBlueprintResolved}
          />
        )}
      </div>

      {selectedExam && activeBlueprint && (
        <>
          <OverridePanel
            key={overridePanelResetKey}
            blueprint={activeBlueprint}
            onChange={setOverrides}
          />

          <div className="card space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-sm font-semibold text-gray-800">Summary</h2>
              {isCheckingFeasibility && (
                <span className="text-xs text-gray-400 flex items-center gap-1.5">
                  <span className="h-3 w-3 rounded-full border-2 border-gray-300 border-t-primary-500 animate-spin" />
                  Checking…
                </span>
              )}
            </div>
            <GenerationSummary blueprint={activeBlueprint} overrides={overrides} />
          </div>

          <InsufficientWarning
            feasibilityReport={feasibilityReport}
            onRelaxFilters={handleRelaxFilters}
          />
        </>
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
