// qa.service.js — Phase 8, Prompts 83–85: the full QA pipeline.
//
// Part 1 (Prompt 83): structural checks (question count, subject
// distribution, difficulty distribution) + the shared `buildCheckEntry`
// helper every check function in this file reuses for a uniform
// checks[] shape.
// Part 2 (Prompt 84): duplicate / near-duplicate checks, reusing
// similarity.service.js's computeSimilarity (Prompt 82) rather than a
// third reimplementation of comparison logic.
// Part 3 (Prompt 85): content-validity checks + the top-level
// `runQAOnTest` orchestrator that loads a test, runs every check
// exactly once, and persists the resulting QAReport.

import GeneratedTest from '../models/GeneratedTest.js';
import Blueprint from '../models/Blueprint.js';
import MCQ from '../models/MCQ.js';
import QAReport from '../models/QAReport.js';
import DismissedPair from '../models/DismissedPair.js';
import ApiError from '../utils/ApiError.js';
import { computeSimilarity } from './similarity.service.js';

// ─── buildPairKey ───────────────────────────────────────────────────
// The one place a pair of mcq_ids is turned into DismissedPair's
// pair_key (Prompt 90) — sorted so the pair is order-independent (a
// dismissal recorded as A/B must still match when the same pair is
// later encountered as B/A in a different test's question ordering).
// Exported so qa.controller.js's dismissPair action can compute the
// exact same key it stores.
export const buildPairKey = (mcqIdA, mcqIdB) => [mcqIdA, mcqIdB].sort().join('::');


// ─── buildCheckEntry ────────────────────────────────────────────────
// Tiny shared helper so every check across this file (and later
// prompts) produces the exact same shape QAReport.checks[] expects,
// without repeating the object literal everywhere.
export const buildCheckEntry = (name, label, status, detail = '') => ({
  name,
  label,
  status,
  detail,
});

// ─── buildEffectiveTarget ────────────────────────────────────────────
// A test generated with Phase 7 overrides (a narrowed `subjects` list,
// an overridden `question_count`, a single-difficulty override, etc.)
// must be QA-checked against what was actually REQUESTED for that run,
// not the blueprint's own original numbers — comparing directly
// against `blueprint.total_questions`/`blueprint.subjects` would
// incorrectly fail every overridden test.
//
// `GeneratedTest.generation_params` already holds exactly this
// effective target: it's set from `workingConfig` in
// generator.service.js's `persistTest` call, and `workingConfig` IS
// the fully-resolved output of Phase 7's `acceptOverrides` (blueprint
// merged with whatever overrides were requested, subject counts
// already rescaled, difficulty_distribution already resolved for a
// single-difficulty override, etc.) — not the raw overrides object
// itself. So rather than re-invoking `acceptOverrides` a second time
// here (which would be wrong: it expects a raw overrides object like
// `{ subjects: ['English'] }`, not an already-resolved
// `{ subjects: [{ name: 'English', count: 20 }] }` — feeding it its
// own output back in would misinterpret already-resolved data as a
// fresh override request), this just reads the resolved fields
// straight off `generation_params` when they're present in that
// resolved shape, and falls back to the blueprint's own original
// values only when they aren't (e.g. a legacy pre-Phase-7 test with no
// usable `generation_params`).
const hasResolvedShape = (params) =>
  Boolean(
    params &&
      typeof params.total_questions === 'number' &&
      Array.isArray(params.subjects) &&
      params.subjects.every((s) => s && typeof s.name === 'string' && typeof s.count === 'number') &&
      params.difficulty_distribution
  );

const buildEffectiveTarget = (test, blueprint) => {
  const params = test.generation_params;

  if (hasResolvedShape(params)) {
    return {
      total_questions: params.total_questions,
      subjects: params.subjects.map((s) => ({ name: s.name, count: s.count })),
      difficulty_distribution: {
        easy: params.difficulty_distribution.easy ?? 0,
        medium: params.difficulty_distribution.medium ?? 0,
        hard: params.difficulty_distribution.hard ?? 0,
      },
    };
  }

  return {
    total_questions: blueprint.total_questions,
    subjects: (blueprint.subjects || []).map((s) => ({ name: s.name, count: s.count })),
    difficulty_distribution: {
      easy: blueprint.difficulty_distribution?.easy ?? 0,
      medium: blueprint.difficulty_distribution?.medium ?? 0,
      hard: blueprint.difficulty_distribution?.hard ?? 0,
    },
  };
};

// ─── Check 1: Question Count ─────────────────────────────────────────
const checkQuestionCount = (test, target) => {
  const actual = test.questions.length;
  const expected = target.total_questions;

  if (actual === expected) {
    return buildCheckEntry('question_count', 'Question Count', 'pass');
  }

  return buildCheckEntry(
    'question_count',
    'Question Count',
    'fail',
    `Expected ${expected} questions, got ${actual}`
  );
};

// ─── Check 2: Subject Distribution ───────────────────────────────────
// Every mismatched subject is enumerated in one `detail` string, not
// just the first found — an admin fixing a bank shortfall deserves the
// complete picture in one read, same principle InsufficientWarning.jsx
// (Phase 7) already follows for feasibility buckets.
const checkSubjectDistribution = (test, target) => {
  const actualCounts = new Map();
  test.questions.forEach((q) => {
    actualCounts.set(q.subject, (actualCounts.get(q.subject) ?? 0) + 1);
  });

  const expectedCounts = new Map(target.subjects.map((s) => [s.name, s.count]));

  const mismatches = [];

  // Expected subjects first, in the target's own order.
  expectedCounts.forEach((expected, subject) => {
    const actual = actualCounts.get(subject) ?? 0;
    if (actual !== expected) {
      mismatches.push(`Subject ${subject}: expected ${expected}, got ${actual}`);
    }
  });

  // Any subject present in the actual test but not expected at all
  // (e.g. a stray/mis-tagged question) — expected 0, whatever showed
  // up is the shortfall-in-reverse.
  actualCounts.forEach((actual, subject) => {
    if (!expectedCounts.has(subject)) {
      mismatches.push(`Subject ${subject}: expected 0, got ${actual}`);
    }
  });

  if (mismatches.length === 0) {
    return buildCheckEntry('subject_distribution', 'Subject Distribution', 'pass');
  }

  return buildCheckEntry(
    'subject_distribution',
    'Subject Distribution',
    'fail',
    mismatches.join('; ')
  );
};

// ─── Check 3: Difficulty Distribution ────────────────────────────────
// Identical pattern to Check 2, grouping by difficulty instead of
// subject, fixed easy/medium/hard order (rather than derived from
// whatever's present) since that's the paper's own defined shape.
const DIFFICULTIES = ['easy', 'medium', 'hard'];

const checkDifficultyDistribution = (test, target) => {
  const actualCounts = new Map();
  test.questions.forEach((q) => {
    actualCounts.set(q.difficulty, (actualCounts.get(q.difficulty) ?? 0) + 1);
  });

  const mismatches = [];
  DIFFICULTIES.forEach((level) => {
    const expected = target.difficulty_distribution[level] ?? 0;
    const actual = actualCounts.get(level) ?? 0;
    if (actual !== expected) {
      mismatches.push(`Difficulty ${level}: expected ${expected}, got ${actual}`);
    }
  });

  if (mismatches.length === 0) {
    return buildCheckEntry('difficulty_distribution', 'Difficulty Distribution', 'pass');
  }

  return buildCheckEntry(
    'difficulty_distribution',
    'Difficulty Distribution',
    'fail',
    mismatches.join('; ')
  );
};

// ─── runStructuralChecks ─────────────────────────────────────────────
// Props:
// - test: a GeneratedTest document (or plain object with the same
//   shape) — needs `.questions` ({subject, difficulty}[]) and
//   `.generation_params`.
// - blueprint: the Blueprint document this test was generated against
//   — needs `.total_questions`, `.subjects`, `.difficulty_distribution`.
//
// Returns the three checks[] entries, in order: question_count,
// subject_distribution, difficulty_distribution.
export const runStructuralChecks = (test, blueprint) => {
  const target = buildEffectiveTarget(test, blueprint);

  return [
    checkQuestionCount(test, target),
    checkSubjectDistribution(test, target),
    checkDifficultyDistribution(test, target),
  ];
};

// ─── buildQuestionsById ───────────────────────────────────────────
// Small shared helper: turns the batched full-question fetch
// (runQAOnTest fetches this ONCE and passes it to every check
// function that needs it — see that function's own comment) into a
// question_id-keyed lookup, used by both runDuplicateChecks' near-
// duplicate check and runContentValidityChecks below.
const buildQuestionsById = (fullQuestions) => new Map(fullQuestions.map((q) => [q.question_id, q]));

// ─── Check 4: Exact Duplicates (by mcq_id) ───────────────────────────
// test.questions is the lightweight {mcq_id, subject, difficulty}
// snapshot (Phase 6, Prompt 61) — an "exact duplicate" here means the
// same mcq_id appearing more than once within THIS test.
// generator.service.js's mergeAndDeduplicate (Prompt 64) should
// already prevent this at generation time, so this check is a hard
// regression guard, not an expected-to-fail case — hence 'fail', not
// 'warning', if it's ever actually triggered.
const checkExactDuplicates = (test) => {
  const counts = new Map();
  test.questions.forEach((q) => {
    counts.set(q.mcq_id, (counts.get(q.mcq_id) ?? 0) + 1);
  });

  const repeated = [...counts.entries()].filter(([, count]) => count > 1).map(([mcqId]) => mcqId);

  if (repeated.length === 0) {
    return buildCheckEntry('exact_duplicates', 'Exact Duplicates', 'pass');
  }

  return buildCheckEntry(
    'exact_duplicates',
    'Exact Duplicates',
    'fail',
    `Duplicate mcq_id(s) found in test: ${repeated.join(', ')}`
  );
};

// Reuses Phase 4's import-time threshold (85), deliberately STRICTER
// than similarity.service.js's on-demand findSimilarInDatabase default
// (70, Prompt 82) — a within-test near-duplicate is a duplicate-content
// concern closer in spirit to import-time strictness than to that
// looser exploratory "show me anything moderately similar" tool.
const NEAR_DUPLICATE_THRESHOLD = 85;

// ─── Check 5: Near-Duplicate Pairs ───────────────────────────────────
// Groups the test's questions by subject (near-duplicates are only a
// meaningful same-subject concept, consistent with how Phase 4 scoped
// its own near-duplicate detection), then runs every pairwise
// comparison within each subject group.
//
// Deliberately O(n²) per subject group — NOT a bug, and not meant to
// scale past this specific use: n here is "questions of one subject
// within one already-generated test", which per the spec is always
// small (typically well under 30 even for a large exam), so a full
// pairwise scan finishes essentially instantly. This must never be
// reused as-is against a much larger n (e.g. a whole question bank) —
// findSimilarInDatabase's subject-scoped, pool-capped approach
// (Prompt 82) is the right tool for that instead.
const checkNearDuplicates = (test, fullQuestions, dismissedKeys = new Set()) => {
  const questionsById = buildQuestionsById(fullQuestions);

  const bySubject = new Map();
  test.questions.forEach((stub) => {
    const full = questionsById.get(stub.mcq_id);
    // A missing full record here (deleted since generation) is a
    // content-validity concern, surfaced by runContentValidityChecks
    // below — silently skip it for similarity comparison rather than
    // duplicating that failure here too.
    if (!full) return;
    if (!bySubject.has(stub.subject)) bySubject.set(stub.subject, []);
    bySubject.get(stub.subject).push(full);
  });

  const warnings = [];
  // Prompt 90: pairs an admin has already explicitly reviewed and kept
  // (via SimilarityReview.jsx's "Keep Both" action) are still SCORED
  // here — dismissal doesn't change whether two questions are
  // similar — but are excluded from both the warnings[] array and this
  // check's own status, so a legitimately-reviewed pair stops
  // re-flagging on every subsequent QA run of the same test.
  let dismissedCount = 0;

  bySubject.forEach((subjectQuestions) => {
    for (let i = 0; i < subjectQuestions.length; i += 1) {
      for (let j = i + 1; j < subjectQuestions.length; j += 1) {
        const a = subjectQuestions[i];
        const b = subjectQuestions[j];
        const score = computeSimilarity(a.question, b.question);

        if (score >= NEAR_DUPLICATE_THRESHOLD) {
          const pairKey = buildPairKey(a.question_id, b.question_id);
          if (dismissedKeys.has(pairKey)) {
            dismissedCount += 1;
            continue;
          }
          warnings.push({
            check: 'near_duplicates',
            message: `Questions ${a.question_id} and ${b.question_id} are ${score}% similar`,
            mcq_ids: [a.question_id, b.question_id],
            score,
          });
        }
      }
    }
  });

  // Near-duplicates NEVER fail this check — per the spec they're
  // "non-blocking but highlighted": 'pass' with zero (undismissed)
  // pairs found, 'warning' (never 'fail') the moment any undismissed
  // pair clears the threshold, however high the score.
  const status = warnings.length === 0 ? 'pass' : 'warning';
  let detail = warnings.length === 0 ? '' : warnings.map((w) => w.message).join('; ');
  if (dismissedCount > 0) {
    const note = `${dismissedCount} previously-reviewed pair${dismissedCount === 1 ? '' : 's'} excluded`;
    detail = detail ? `${detail} (${note})` : note;
  }

  return {
    check: buildCheckEntry('near_duplicates', 'Near-Duplicate Pairs', status, detail),
    warnings,
  };
};

// ─── runDuplicateChecks ───────────────────────────────────────────────
// Signature accepts pre-fetched `fullQuestions` (Prompt 85's
// orchestrator fetches full question content exactly ONCE up front and
// shares it across every check function that needs it) rather than
// this function re-querying the DB itself.
//
// Returns { checks: [...], warnings: [...] } — Check 4 and Check 5 each
// contribute one checks[] entry; only Check 5 additionally contributes
// to the separate warnings[] array (Check 4 can only ever be
// pass/fail, never produce a warning).
export const runDuplicateChecks = (test, fullQuestions, dismissedKeys = new Set()) => {
  const exactDuplicatesCheck = checkExactDuplicates(test);
  const { check: nearDuplicatesCheck, warnings } = checkNearDuplicates(
    test,
    fullQuestions,
    dismissedKeys
  );

  return {
    checks: [exactDuplicatesCheck, nearDuplicatesCheck],
    warnings,
  };
};

// ─── Check 6: Approved Status ────────────────────────────────────────
// Verifies every question still has status === 'approved' in its
// CURRENT MCQ record — catches a question that was approved at
// generation time but has since been demoted/rejected by an admin. A
// record that's gone missing entirely (deleted since generation) is
// reported here too, rather than silently ignored, since "can't verify
// it's still approved" is itself a validity failure worth surfacing.
const checkApprovedStatus = (test, questionsById) => {
  const violations = [];

  test.questions.forEach((stub) => {
    const full = questionsById.get(stub.mcq_id);
    if (!full) {
      violations.push(`${stub.mcq_id}: not found in question bank`);
      return;
    }
    if (full.status !== 'approved') {
      violations.push(`${stub.mcq_id}: ${full.status}`);
    }
  });

  if (violations.length === 0) {
    return buildCheckEntry('approved_status', 'Approved Status', 'pass');
  }

  return buildCheckEntry('approved_status', 'Approved Status', 'fail', violations.join('; '));
};

const VALID_ANSWER_LETTERS = ['A', 'B', 'C', 'D'];

// ─── Check 7: Valid Correct Answer ───────────────────────────────────
// Same cross-field logic as Phase 4's import-time validation
// (import.service.js's validateEachMCQ, Prompt 42) — correct_answer
// must be one of A–D AND options[correct_answer] must be a non-empty
// string. Reapplied here rather than trusted-once-at-import, since MCQ
// content could have been edited after import in a way that broke this
// invariant later (the model's `options.*` fields are only
// `required: true`, which Mongoose treats as "not null/undefined", NOT
// "non-empty" — an edit can leave an option as an empty string without
// tripping schema validation).
const checkValidCorrectAnswer = (test, questionsById) => {
  const violations = [];

  test.questions.forEach((stub) => {
    const full = questionsById.get(stub.mcq_id);
    // Already reported by checkApprovedStatus above — don't double-
    // report the same missing record under a different check.
    if (!full) return;

    const { correct_answer: correctAnswer, options } = full;

    if (!VALID_ANSWER_LETTERS.includes(correctAnswer)) {
      violations.push(`${stub.mcq_id}: correct_answer "${correctAnswer}" is not one of A/B/C/D`);
      return;
    }

    const optionText = options?.[correctAnswer];
    if (!optionText || String(optionText).trim().length === 0) {
      violations.push(
        `${stub.mcq_id}: correct_answer "${correctAnswer}" has no matching non-empty option text`
      );
    }
  });

  if (violations.length === 0) {
    return buildCheckEntry('valid_correct_answer', 'Valid Correct Answer', 'pass');
  }

  return buildCheckEntry(
    'valid_correct_answer',
    'Valid Correct Answer',
    'fail',
    violations.join('; ')
  );
};

// ─── runContentValidityChecks ────────────────────────────────────────
// Accepts pre-fetched `fullQuestions`, same reasoning as
// runDuplicateChecks above — runQAOnTest fetches full question content
// exactly once and shares it across every check function.
export const runContentValidityChecks = (test, fullQuestions) => {
  const questionsById = buildQuestionsById(fullQuestions);

  return [checkApprovedStatus(test, questionsById), checkValidCorrectAnswer(test, questionsById)];
};

// ─── generateReportId ────────────────────────────────────────────────
// QA_{year}_{sequence}, mirroring generator.service.js's
// generateTestId (Phase 6) — same count-based-sequence-per-year
// convention, same retry-on-conflict backstop under a race between two
// simultaneous QA runs. 4-digit zero-padding (vs. TEST_'s 3-digit) to
// match the QAReport model's own documented example (Prompt 81:
// "QA_2026_0001").
const generateReportId = async () => {
  const year = new Date().getFullYear();
  const prefix = `QA_${year}_`;

  const existingCount = await QAReport.countDocuments({
    report_id: { $regex: `^${prefix}` },
  });

  let seq = existingCount + 1;
  let candidate = `${prefix}${String(seq).padStart(4, '0')}`;

  // eslint-disable-next-line no-await-in-loop
  while (await QAReport.exists({ report_id: candidate })) {
    seq += 1;
    candidate = `${prefix}${String(seq).padStart(4, '0')}`;
  }

  return candidate;
};

// ─── runQAOnTest ──────────────────────────────────────────────────────
// The top-level orchestrator: loads a test + its blueprint, fetches
// full question content exactly ONCE (shared across every check
// function below rather than each re-querying independently), runs
// every check, and persists the result as a new QAReport — win or
// lose. A QA run's outcome is itself a record worth keeping, not a
// transient response, so this always saves a report regardless of
// pass/fail.
export const runQAOnTest = async (test_id) => {
  const test = await GeneratedTest.findOne({ test_id });
  if (!test) {
    throw new ApiError(404, `Test not found: ${test_id}`);
  }

  const blueprint = await Blueprint.findOne({ blueprint_id: test.blueprint_id });
  if (!blueprint) {
    throw new ApiError(404, `Blueprint not found: ${test.blueprint_id}`);
  }

  // ONE batched query for full question content — shared by
  // runDuplicateChecks' near-duplicate check and every
  // runContentValidityChecks check, never re-fetched per check.
  const fullQuestions = await MCQ.find({
    question_id: { $in: test.questions.map((q) => q.mcq_id) },
  }).lean();

  // Prompt 90: batched, once-per-run lookup of any pairs among THIS
  // test's own questions that have already been explicitly reviewed
  // and kept via SimilarityReview.jsx — same "fetch once, share across
  // checks" discipline as fullQuestions above, never refetched per
  // pair comparison inside checkNearDuplicates.
  const mcqIds = test.questions.map((q) => q.mcq_id);
  const dismissedDocs = await DismissedPair.find({
    mcq_id_a: { $in: mcqIds },
    mcq_id_b: { $in: mcqIds },
  }).lean();
  const dismissedKeys = new Set(dismissedDocs.map((d) => d.pair_key));

  const structuralChecks = runStructuralChecks(test, blueprint);
  const { checks: dupChecks, warnings } = runDuplicateChecks(test, fullQuestions, dismissedKeys);
  const validityChecks = runContentValidityChecks(test, fullQuestions);

  const allChecks = [...structuralChecks, ...dupChecks, ...validityChecks];

  const failures = allChecks
    .filter((c) => c.status === 'fail')
    .map((c) => ({ check: c.name, message: c.detail }));

  const passed = failures.length === 0;

  const report_id = await generateReportId();
  const report = await QAReport.create({
    report_id,
    test_id: test.test_id,
    passed,
    checks: allChecks,
    failures,
    warnings,
    generated_at: new Date(),
  });

  // Phase 8 patch (Prompt 85, flagged in GeneratedTest.js's own
  // comment too): denormalized "latest QA result" pointer so
  // TestHistory.jsx / QADashboard.jsx can show QA status in a list
  // view without a join/second query per row. Updated here,
  // immediately after the report itself is saved.
  test.latest_qa_status = passed ? 'passed' : 'failed';
  test.latest_qa_report_id = report.report_id;
  await test.save();

  return report;
};

// ─── dismissPair ──────────────────────────────────────────────────────
// Phase 8, Prompt 90 — the backing action for SimilarityReview.jsx's
// "Keep Both". Upserted on pair_key so re-dismissing an
// already-dismissed pair (e.g. the admin clicks it twice, or it's
// re-encountered from a different test) is a harmless no-op rather
// than a duplicate-key error.
export const dismissPair = async (mcqIdA, mcqIdB, reviewedBy) => {
  const pair_key = buildPairKey(mcqIdA, mcqIdB);

  const dismissal = await DismissedPair.findOneAndUpdate(
    { pair_key },
    {
      pair_key,
      mcq_id_a: mcqIdA,
      mcq_id_b: mcqIdB,
      reviewed_by: reviewedBy,
      reviewed_at: new Date(),
    },
    { new: true, upsert: true }
  );

  return dismissal;
};

