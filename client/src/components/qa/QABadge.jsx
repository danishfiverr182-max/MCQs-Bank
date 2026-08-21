// Small colored pill reflecting a GeneratedTest's latest QA outcome.
// Purely presentational — takes `status` as a prop rather than
// fetching anything itself, so it drops straight into TestHistory.jsx's
// existing list rows (which already have `latest_qa_status`
// denormalized onto each GeneratedTest, Prompt 85 — no new per-row
// fetch needed) as well as GeneratedTest.jsx and the later QA pages.
//
// Uses the same success/warning/danger semantic tokens already defined
// in tailwind.config.js (Prompt 1) — 'not_run' deliberately reuses the
// neutral gray fallback pattern DifficultyBadge.jsx / StatusBadge.jsx
// already use for an unknown/empty state, since "not run" is itself a
// neutral, non-alarming state rather than a failure.

const STYLES = {
  passed: 'bg-success-light text-success-dark',
  failed: 'bg-danger-light text-danger-dark',
  not_run: 'bg-gray-100 text-gray-500',
};

const LABELS = {
  passed: 'QA Passed',
  failed: 'QA Failed',
  not_run: 'Not Run',
};

const SIZE_STYLES = {
  sm: 'px-2.5 py-0.5 text-xs',
  md: 'px-3 py-1 text-sm',
};

export default function QABadge({ status, size = 'sm' }) {
  const key = STYLES[status] ? status : 'not_run';
  const sizeClasses = SIZE_STYLES[size] || SIZE_STYLES.sm;

  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${STYLES[key]} ${sizeClasses}`}
    >
      {LABELS[key]}
    </span>
  );
}
