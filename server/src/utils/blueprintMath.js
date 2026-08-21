// Pure, dependency-free helpers shared between blueprint.validator.js
// (Zod .superRefine on fresh request bodies) and blueprint.service.js
// (re-validating already-persisted Mongoose documents). Keeping the
// arithmetic here — instead of duplicated in both places — is what
// guarantees the two layers can never silently drift apart on what
// counts as a "valid" blueprint.

// ─── sumSubjectCounts ────────────────────────────────────────────
export const sumSubjectCounts = (subjects = []) =>
  subjects.reduce((total, entry) => total + (entry?.count ?? 0), 0);

// ─── sumDifficultyCounts ──────────────────────────────────────────
export const sumDifficultyCounts = (difficultyDistribution = {}) => {
  const { easy = 0, medium = 0, hard = 0 } = difficultyDistribution;
  return easy + medium + hard;
};

// ─── findDuplicateSubjectNames ──────────────────────────────────────
// Case-insensitive. Returns the (originally-cased) names that appear
// more than once, e.g. ["English"] for ["English", "english"].
export const findDuplicateSubjectNames = (subjects = []) => {
  const seenLower = new Set();
  const duplicates = new Set();

  for (const entry of subjects) {
    const lower = String(entry?.name ?? '').trim().toLowerCase();
    if (seenLower.has(lower)) {
      duplicates.add(entry.name);
    } else {
      seenLower.add(lower);
    }
  }

  return [...duplicates];
};

// ─── sumsMatch ───────────────────────────────────────────────────
// The core invariant check: both subject counts and difficulty counts
// must each sum exactly to total_questions. Returns raw computed sums
// alongside pass/fail booleans so callers can build whatever error
// shape suits them (Zod issues vs a plain {valid, errors} report).
export const sumsMatch = (subjects, difficultyDistribution, totalQuestions) => {
  const subjectSum = sumSubjectCounts(subjects);
  const difficultySum = sumDifficultyCounts(difficultyDistribution);

  return {
    subjectSum,
    difficultySum,
    subjectsMatch: subjectSum === totalQuestions,
    difficultyMatch: difficultySum === totalQuestions,
  };
};
