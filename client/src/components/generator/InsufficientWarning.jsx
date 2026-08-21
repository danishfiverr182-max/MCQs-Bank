// InsufficientWarning.jsx — Prompt 79. Updated alongside
// generator.service.js's checkOverrideFeasibility (the difficulty-
// redistribution change): a bucket being short no longer means
// generation will refuse to run — Generate now borrows a short
// bucket's shortfall from an adjacent difficulty within the same
// subject whenever that subject has spare supply elsewhere. Only a
// subject that's short in TOTAL (summed across all three difficulty
// buckets) can no longer be filled, and only that case still blocks.
//
// Renders the shape returned by checkOverrideFeasibility /
// POST /api/generator/check-feasibility:
//   {
//     feasible: boolean,   // now subject-level: true unless some subject's total supply is short
//     buckets: [{ subject, difficulty, required, available, sufficient, redistributable }],
//     subjects: [{ subject, required, available, sufficient }],
//   }
//
// Pure/presentational — no API calls of its own; the parent page owns
// calling check-feasibility and passing the result down.
//
// Props:
// - feasibilityReport: the object above, or null/undefined before any
//   check has run.
// - onRelaxFilters: optional callback for a "Relax Filters" quick-action.

function BlockingBucketLine({ bucket }) {
  const { subject, difficulty, required, available } = bucket;
  return (
    <li>
      Only {available} {difficulty} {subject} MCQ{available === 1 ? '' : 's'} available. Need{' '}
      {required}. Add more MCQs or relax filters.
    </li>
  );
}

function AdjustedBucketLine({ bucket }) {
  const { subject, difficulty, required, available } = bucket;
  const short = required - available;
  return (
    <li>
      {subject}: only {available} {difficulty} MCQ{available === 1 ? '' : 's'} available (need{' '}
      {required}) — {short} question{short === 1 ? '' : 's'} will be substituted from a nearby
      difficulty level automatically.
    </li>
  );
}

function TopicShortfallLine({ requirement }) {
  const { subject, topic, required, available } = requirement;
  return (
    <li>
      "{topic}" in {subject}: need {required}, only {available} available. Add more MCQs or remove this requirement.
    </li>
  );
}

export default function InsufficientWarning({ feasibilityReport, onRelaxFilters }) {
  if (!feasibilityReport) return null;

  const buckets = feasibilityReport.buckets || [];
  const topicShortfalls = (feasibilityReport.topicRequirementResults || []).filter((t) => !t.sufficient);
  const blockingBuckets = buckets.filter((b) => !b.sufficient && !b.redistributable);
  const adjustedBuckets = buckets.filter((b) => !b.sufficient && b.redistributable);

  if (feasibilityReport.feasible && adjustedBuckets.length === 0 && topicShortfalls.length === 0) {
    return (
      <div className="rounded-md bg-success-light px-4 py-3 text-sm font-medium text-success-dark">
        ✓ This configuration is fully supported by the current question bank
      </div>
    );
  }

  // Subject-level shortfall — no amount of borrowing across difficulty
  // buckets can fix a subject that doesn't have enough approved MCQs
  // at all. This still blocks Generate in practice.
  if (!feasibilityReport.feasible && blockingBuckets.length > 0) {
    return (
      <div className="rounded-md bg-danger-light px-4 py-3 text-sm text-danger-dark space-y-2">
        <p className="font-semibold">✗ This configuration can't currently be fulfilled:</p>
        <ul className="list-disc space-y-1 pl-5 font-medium">
          {blockingBuckets.map((b) => (
            <BlockingBucketLine key={`${b.subject}::${b.difficulty}`} bucket={b} />
          ))}
          {topicShortfalls.map((t) => (
            <TopicShortfallLine key={`${t.subject}::${t.topic}`} requirement={t} />
          ))}
        </ul>
        {onRelaxFilters && (
          <button
            type="button"
            onClick={onRelaxFilters}
            className="mt-1 rounded-md border border-danger-dark/30 bg-white px-3 py-1.5 text-xs font-semibold text-danger-dark hover:bg-danger-light/50"
          >
            Relax Filters
          </button>
        )}
      </div>
    );
  }

  // Feasible overall, but only because one or more buckets will be
  // covered by an automatic substitution — worth flagging so the paper
  // that comes out isn't a surprise, but this is informational, not a
  // blocker, so it renders as a heads-up rather than an error.
  if (adjustedBuckets.length > 0 || topicShortfalls.length > 0) {
    return (
      <div className="rounded-md bg-warning-light px-4 py-3 text-sm text-warning-dark space-y-2">
        <p className="font-semibold">
          ⚠ This configuration is supported, but with automatic adjustments:
        </p>
        <ul className="list-disc space-y-1 pl-5 font-medium">
          {adjustedBuckets.map((b) => (
            <AdjustedBucketLine key={`${b.subject}::${b.difficulty}`} bucket={b} />
          ))}
          {topicShortfalls.map((t) => (
            <TopicShortfallLine key={`${t.subject}::${t.topic}`} requirement={t} />
          ))}
        </ul>
      </div>
    );
  }

  return null;
}
