import FeasibilityReport from '@/components/blueprints/FeasibilityReport';

// The four named steps from the spec. `POST /api/generator/generate`
// is a single request/response — it never emits intermediate progress
// events — so "Filtering" and "Assembling" aren't real server-reported
// phases here. This is a deliberate UX choice, not a broken
// integration: GeneratorForm.jsx (Prompt 68) owns a small timer that
// advances `stage` through loading → filtering → assembling on a
// fixed schedule *while the request is in flight*, purely so the
// animation reads as progress instead of one long spinner; `done` and
// `error` are the only two stages actually driven by the real response.
const STEPS = [
  { key: 'loading', label: 'Loading' },
  { key: 'filtering', label: 'Filtering' },
  { key: 'assembling', label: 'Assembling' },
  { key: 'done', label: 'Done' },
];

// If the response comes back as an error, we don't get to know which
// of the four client-driven stages was "current" at that instant in
// any meaningful server-verified sense — so the step that visually
// takes the error marker is always 'assembling' (the last step that
// waits on the network call), regardless of exactly when the error
// arrived. Every step at or after that stays pending.
const ERROR_AT_STEP = 'assembling';

function StepIndicator({ step, status }) {
  const circleClass =
    status === 'complete'
      ? 'bg-success text-white'
      : status === 'active'
        ? 'bg-primary-600 text-white animate-pulse'
        : status === 'error'
          ? 'bg-danger text-white'
          : 'bg-gray-100 text-gray-400';

  const labelClass =
    status === 'pending' ? 'text-gray-400' : status === 'error' ? 'text-danger-dark' : 'text-gray-800';

  return (
    <div className="flex flex-col items-center gap-1.5 flex-1">
      <div
        className={`flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors ${circleClass}`}
      >
        {status === 'complete' ? '✓' : status === 'error' ? '✗' : ''}
      </div>
      <span className={`text-xs font-medium ${labelClass}`}>{step.label}</span>
    </div>
  );
}

// Props:
// - stage: 'idle' | 'loading' | 'filtering' | 'assembling' | 'done' | 'error'
// - errorDetail: optional. Either { report: <feasibility shape> } for a
//   422 infeasibility response (see generator.controller.js — the
//   report travels as err.errors.report), or a plain string for any
//   other failure.
export default function GenerationProgress({ stage, errorDetail }) {
  if (stage === 'idle') return null;

  const stageIndex = stage === 'error' ? STEPS.findIndex((s) => s.key === ERROR_AT_STEP) : STEPS.findIndex((s) => s.key === stage);

  const statusFor = (index) => {
    if (stage === 'error') {
      if (STEPS[index].key === ERROR_AT_STEP) return 'error';
      return index < stageIndex ? 'complete' : 'pending';
    }
    if (index < stageIndex) return 'complete';
    if (index === stageIndex) return stage === 'done' ? 'complete' : 'active';
    return 'pending';
  };

  const reportFromError =
    errorDetail && typeof errorDetail === 'object' && errorDetail.report ? errorDetail.report : null;
  const messageFromError = typeof errorDetail === 'string' ? errorDetail : null;

  return (
    <div className="space-y-4" aria-live="polite">
      <div className="flex items-start">
        {STEPS.map((step, index) => (
          <div key={step.key} className="flex items-center flex-1 last:flex-none">
            <StepIndicator step={step} status={statusFor(index)} />
            {index < STEPS.length - 1 && (
              <div
                className={`h-0.5 flex-1 -mt-5 ${
                  statusFor(index) === 'complete' ? 'bg-success' : 'bg-gray-100'
                }`}
              />
            )}
          </div>
        ))}
      </div>

      {stage === 'error' && (
        <div className="space-y-3">
          {messageFromError && (
            <div className="rounded-md bg-danger-light px-4 py-3 text-sm font-medium text-danger-dark">
              ✗ {messageFromError}
            </div>
          )}
          {reportFromError && (
            <div className="card space-y-3">
              <h3 className="text-sm font-semibold text-gray-800">
                Generation blocked — question bank shortfall
              </h3>
              <FeasibilityReport report={reportFromError} loading={false} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
