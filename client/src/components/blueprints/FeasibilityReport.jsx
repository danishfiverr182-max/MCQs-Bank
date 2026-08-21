// Renders the shape returned by blueprintService.checkMCQAvailability
// (both GET /api/blueprints/:blueprintId's embedded `feasibility` and
// POST /api/blueprints/validate's `feasibility`):
//   { feasible, subjects: [{ name, required, available, sufficient }],
//     overallDifficulty: { easy: {...}, medium: {...}, hard: {...} } }
//
// Props:
// - report: the object above, or null before any check has run
// - loading: true while a validate/detail request is in flight

const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

function AvailabilityLine({ label, required, available, sufficient }) {
  const shortfall = Math.max(required - available, 0);
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-gray-700 truncate">{label}</span>
      <span
        className={`shrink-0 font-medium ${
          sufficient ? 'text-success-dark' : 'text-danger-dark'
        }`}
      >
        need {required}, available {available} {sufficient ? '✓' : '✗'}
        {!sufficient && ` (${shortfall} short)`}
      </span>
    </div>
  );
}

function FeasibilityBanner({ report }) {
  if (report.feasible) {
    return (
      <div className="rounded-md bg-success-light px-4 py-3 text-sm font-medium text-success-dark">
        ✓ This blueprint is fully supported by the current question bank
      </div>
    );
  }

  const insufficientSubjects = report.subjects.filter((s) => !s.sufficient);
  const insufficientDifficulties = Object.entries(report.overallDifficulty).filter(
    ([, d]) => !d.sufficient
  );

  const parts = [];
  if (insufficientSubjects.length > 0) {
    parts.push(
      `${insufficientSubjects.length} subject${insufficientSubjects.length === 1 ? '' : 's'}`
    );
  }
  if (insufficientDifficulties.length > 0) {
    parts.push(
      `${insufficientDifficulties.length} difficulty level${
        insufficientDifficulties.length === 1 ? '' : 's'
      }`
    );
  }

  const totalInsufficient = insufficientSubjects.length + insufficientDifficulties.length;
  const verb = totalInsufficient === 1 ? "doesn't" : "don't";

  return (
    <div className="rounded-md bg-danger-light px-4 py-3 text-sm font-medium text-danger-dark">
      ✗ {parts.join(' and ')} {verb} have enough approved questions yet
    </div>
  );
}

export default function FeasibilityReport({ report, loading }) {
  // Feasibility checks hit the DB (two aggregations against the MCQ
  // collection) — a skeleton keeps that honest rather than looking instant.
  if (loading) {
    return (
      <div className="space-y-2" aria-busy="true" aria-live="polite">
        <div className="h-10 w-full rounded-md bg-gray-100 animate-pulse" />
        <div className="h-5 w-full rounded bg-gray-100 animate-pulse" />
        <div className="h-5 w-full rounded bg-gray-100 animate-pulse" />
        <div className="h-5 w-2/3 rounded bg-gray-100 animate-pulse" />
      </div>
    );
  }

  if (!report) {
    return (
      <p className="text-sm text-gray-400">
        Run a feasibility check to see whether the current question bank can support this
        blueprint.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      <FeasibilityBanner report={report} />

      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          By subject
        </h3>
        {report.subjects.map((s) => (
          <AvailabilityLine
            key={s.name}
            label={s.name}
            required={s.required}
            available={s.available}
            sufficient={s.sufficient}
          />
        ))}
      </div>

      <div className="space-y-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-400">
          By difficulty (overall)
        </h3>
        {Object.entries(report.overallDifficulty).map(([level, d]) => (
          <AvailabilityLine
            key={level}
            label={DIFFICULTY_LABELS[level] ?? level}
            required={d.required}
            available={d.available}
            sufficient={d.sufficient}
          />
        ))}
      </div>
    </div>
  );
}
