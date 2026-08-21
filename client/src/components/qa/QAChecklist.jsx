// Animated, ordered rendering of a QAReport's checks[] array — the
// exact shape qa.service.js's buildCheckEntry produces and QAReport.js
// (Prompt 81) persists: { name, label, status, detail }.
//
// The stagger is a real functional signal (QA actually ran through
// each check in order), not just decoration — each item's entrance is
// offset by a small per-index delay so the list visibly "runs down"
// rather than appearing all at once. It's pure CSS (animation-delay),
// so it never blocks or delays interactivity: every item is present
// and interactive in the DOM immediately, only its opacity/transform
// animates in.

const ICONS = {
  pass: { symbol: '✓', classes: 'bg-success-light text-success-dark' },
  fail: { symbol: '✗', classes: 'bg-danger-light text-danger-dark' },
  warning: { symbol: '⚠', classes: 'bg-warning-light text-warning-dark' },
};

const STAGGER_STEP_MS = 60;

export default function QAChecklist({ checks = [] }) {
  if (!checks.length) {
    return (
      <p className="text-small text-gray-500 py-4 text-center">
        No QA checks have been run yet.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      <style>{`
        @keyframes qaCheckItemIn {
          from { opacity: 0; transform: scale(0.9) translateY(-4px); }
          to { opacity: 1; transform: scale(1) translateY(0); }
        }
        .qa-checklist-item {
          animation: qaCheckItemIn 0.25s ease-out both;
        }
      `}</style>

      {checks.map((check, index) => {
        const icon = ICONS[check.status] || ICONS.pass;
        const showDetail = check.status !== 'pass' && Boolean(check.detail);

        return (
          <li
            key={check.name || index}
            className="qa-checklist-item flex items-start gap-3 rounded-md border border-surface-border bg-white px-3 py-2"
            style={{ animationDelay: `${index * STAGGER_STEP_MS}ms` }}
          >
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs font-bold ${icon.classes}`}
            >
              {icon.symbol}
            </span>
            <div className="flex flex-col">
              <span className="text-body font-medium text-gray-800">{check.label}</span>
              {showDetail && (
                <span className="text-small text-gray-500 mt-0.5">{check.detail}</span>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
