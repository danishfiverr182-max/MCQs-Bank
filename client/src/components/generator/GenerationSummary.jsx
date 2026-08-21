// GenerationSummary.jsx — Prompt 79.
//
// Pure, presentational, derived-from-props component: no API calls,
// recomputes instantly on every override change. Renders a compact
// plain-English description of exactly what OverridePanel.jsx's
// current overrides object (plus the active blueprint) will actually
// generate, e.g.:
//   "50 questions | English×20, GK×30 | Medium only | Quality ≥ 70 | Unused in last 3 tests"
//
// Props:
// - blueprint: the active blueprint (for defaults/subject list).
// - overrides: the current overrides object from OverridePanel.jsx.

const DEFAULT_QUALITY_THRESHOLD = 50;

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

export default function GenerationSummary({ blueprint, overrides = {} }) {
  if (!blueprint) return null;

  const clauses = [];

  // ── Question count ──────────────────────────────────────────────
  const questionCount = overrides.question_count ?? blueprint.total_questions;
  clauses.push(`${questionCount} question${questionCount === 1 ? '' : 's'}`);

  // ── Subject breakdown ──────────────────────────────────────────
  // A narrowed subject list gets proportionally rescaled server-side
  // (generator.service.js's acceptOverrides). Rather than silently
  // replicate that exact largest-remainder rounding here — and risk a
  // preview that quietly disagrees with what the backend actually
  // generates — this shows the blueprint's own per-subject counts for
  // just the selected subjects, with a plain note that the real counts
  // will be adjusted to fit. Simpler and honest beats a guess that
  // might not match.
  const allSubjects = blueprint.subjects || [];
  if (overrides.subjects) {
    const picked = allSubjects.filter((s) => overrides.subjects.includes(s.name));
    const breakdown = picked.map((s) => `${s.name}×${s.count}`).join(', ');
    clauses.push(`${breakdown} (counts adjusted proportionally)`);
  } else {
    const breakdown = allSubjects.map((s) => `${s.name}×${s.count}`).join(', ');
    if (breakdown) clauses.push(breakdown);
  }

  // ── Difficulty ──────────────────────────────────────────────────
  if (!overrides.difficulty || overrides.difficulty === 'mixed') {
    clauses.push('Mixed');
  } else {
    clauses.push(`${capitalize(overrides.difficulty)} only`);
  }

  // ── Quality threshold ──────────────────────────────────────────
  if (
    overrides.quality_threshold != null &&
    overrides.quality_threshold !== DEFAULT_QUALITY_THRESHOLD
  ) {
    clauses.push(`Quality ≥ ${overrides.quality_threshold}`);
  }

  // ── Recency exclusion ───────────────────────────────────────────
  if (overrides.exclude_recent_tests) {
    clauses.push(`Unused in last ${overrides.exclude_recent_tests} test${overrides.exclude_recent_tests === 1 ? '' : 's'}`);
  }

  return (
    <p className="text-sm text-gray-700">
      {clauses.map((clause, i) => (
        <span key={i}>
          {i > 0 && <span className="mx-2 text-gray-300">|</span>}
          {clause}
        </span>
      ))}
    </p>
  );
}
