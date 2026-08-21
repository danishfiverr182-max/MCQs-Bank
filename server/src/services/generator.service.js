import Exam from '../models/Exam.js';
import Blueprint from '../models/Blueprint.js';
import MCQ from '../models/MCQ.js';
import GeneratedTest from '../models/GeneratedTest.js';
import ApiError from '../utils/ApiError.js';
import { normalizeQuestion, hashQuestion } from '../utils/duplicateDetector.js';
import * as blueprintService from './blueprint.service.js';
// Phase 8 (Prompt 86): the "QA runs automatically after generation"
// hook. Imported here rather than merged into this file — qa.service.js
// owns all QA pipeline logic; generator.service.js only ever calls its
// one public entry point, same layering discipline as this file's own
// use of blueprint.service.js above.
import { runQAOnTest } from './qa.service.js';
import { logger } from '../utils/logger.js';
import { buildPaginatedResponse } from '../utils/pagination.js';

// generator.service.js — the Test Generation Engine (Phase 6).
//
// Pure service functions only: no req/res anywhere in this file, so
// every step is independently unit-testable and composable by the
// controller (Prompt 66) into the full generate-a-test pipeline.
//
// `params` (threaded through steps 3 onward) is the plain object built
// from the system spec's "Dynamic Test Generation Options":
//   {
//     qualityThreshold: number,        // default 50
//     difficultyOverride: { easy, medium, hard } | null,
//     subjectOverride: { [blueprintSubjectName]: actualMcqSubjectName } | null,
//     excludedRecentTests: number | null,   // was excludedRecentDays
//   }
// Every field is optional — an empty/omitted params object falls back
// to the blueprint's own values everywhere.

// ─── Step 1: loadExam ───────────────────────────────────────────────
export const loadExam = async (exam_id) => {
  const exam = await Exam.findOne({ exam_id });
  if (!exam) {
    throw new ApiError(404, 'Exam not found');
  }

  // Generating a test for a retired exam isn't something the spec
  // explicitly forbids, but it's an obvious guard rail — an inactive
  // exam shouldn't be producing new tests.
  if (exam.status !== 'active') {
    throw new ApiError(400, 'Exam is inactive — activate it before generating a test');
  }

  return exam;
};

// ─── Step 2: resolveBlueprint ───────────────────────────────────────
// Either use an explicit override blueprint_id (the "OR use override
// blueprint_id" branch from the spec), or fall back to the exam's sole
// active blueprint.
export const resolveBlueprint = async (exam_id, overrideBlueprintId) => {
  if (overrideBlueprintId) {
    const blueprint = await Blueprint.findOne({ blueprint_id: overrideBlueprintId });
    if (!blueprint) {
      throw new ApiError(404, `Blueprint not found: ${overrideBlueprintId}`);
    }

    // An admin overriding blueprint selection could otherwise
    // accidentally point a test at a completely unrelated exam's
    // blueprint — reject that explicitly rather than silently
    // generating a test that mismatches its own exam_id.
    if (blueprint.exam_id !== exam_id) {
      throw new ApiError(400, 'Blueprint does not belong to the specified exam');
    }

    return blueprint;
  }

  const activeBlueprint = await Blueprint.findOne({ exam_id, is_active: true });
  if (!activeBlueprint) {
    // The most common reason generation fails — a specific, actionable
    // message rather than a generic 404.
    throw new ApiError(404, 'No active blueprint found for this exam — activate one first');
  }

  return activeBlueprint;
};

// ─── Step 2.5: acceptOverrides (Phase 7, Prompt 72) ─────────────────
// Merges a blueprint with a partial, Zod-validated overrides object
// (server/src/validators/generation.validator.js's
// generationOverridesSchema — Prompt 71) into one plain-object "working
// config". From here on, Prompts 73–75's pipeline steps should read
// from this working config instead of the raw blueprint, so every
// downstream step (difficulty-bucket calculation, pool fetching,
// persistence) automatically respects whatever was overridden without
// needing its own override-handling logic.
//
// NEVER mutates `blueprint` — overrides are strictly per-generation.
// Phase 7's entire premise falls apart if an override could leak back
// into the stored blueprint definition, so this always builds a
// brand-new plain object via `{ ...blueprint.toObject(), ... }` rather
// than assigning onto the Mongoose document.
export const acceptOverrides = (blueprint, overrides = {}) => {
  // Accept both a real Mongoose document and a plain object (the
  // latter matters for unit tests that construct a blueprint fixture
  // by hand rather than round-tripping it through Mongoose).
  const base = typeof blueprint.toObject === 'function' ? blueprint.toObject() : { ...blueprint };

  // ── total_questions ──────────────────────────────────────────────
  const total_questions = overrides.question_count ?? base.total_questions;

  // ── subjects: narrow to overrides.subjects, if supplied ──────────
  // An override can only narrow the blueprint's own subject list,
  // never invent a subject the blueprint doesn't define.
  let workingSubjects;
  if (overrides.subjects) {
    workingSubjects = overrides.subjects.map((name) => {
      const found = base.subjects.find((s) => s.name === name);
      if (!found) {
        throw new ApiError(400, `Subject "${name}" is not part of this blueprint`);
      }
      return { ...found };
    });
  } else {
    workingSubjects = base.subjects.map((s) => ({ ...s }));
  }

  // ── rescale subject counts, if the working total or subject list
  // no longer matches the blueprint's own ──────────────────────────
  // A blueprint's subject counts are only meaningful relative to its
  // own total_questions. Either an explicit question_count override,
  // or narrowing the subject list (whose original counts alone no
  // longer sum to the working total), invalidates the raw counts —
  // both cases are fixed by the same proportional rescale, reusing
  // the exact largest-remainder helper Phase 6 already uses for
  // difficulty-count rounding (Prompt 63) rather than reimplementing
  // rounding logic here.
  const needsRescale = total_questions !== base.total_questions || Boolean(overrides.subjects);
  if (needsRescale) {
    const weights = {};
    workingSubjects.forEach((s) => {
      weights[s.name] = s.count;
    });
    const rescaled = distributeInteger(total_questions, weights);
    workingSubjects = workingSubjects.map((s) => ({ ...s, count: rescaled[s.name] }));
  }

  // ── topics: attach as a per-subject constraint, shape-only ───────
  // Actual DB-existence validation of topic names happens in Prompt
  // 73's query building, not here — this just carries the constraint
  // through on every subject currently in play.
  if (overrides.topics) {
    workingSubjects = workingSubjects.map((s) => ({ ...s, topics: [...overrides.topics] }));
  }

  // ── topic_requirements: "Topics to Include" per-subject guarantees ──
  // Unlike `topics` above (a blanket restrict-to-these-topics filter
  // applied identically to every working subject), this is a per-
  // subject map of exact MCQ counts per topic — see
  // fetchTopicGuaranteedQuestions for how these get satisfied FIRST,
  // before the rest of that subject's count is filled randomly.
  // Validated here, at merge time, so a bad request fails fast with a
  // clear 400 rather than surfacing confusingly deep in the pipeline.
  if (overrides.topic_requirements) {
    const workingSubjectNames = new Set(workingSubjects.map((s) => s.name));
    Object.keys(overrides.topic_requirements).forEach((name) => {
      if (!workingSubjectNames.has(name)) {
        throw new ApiError(
          400,
          `topic_requirements references subject "${name}", which isn't part of this generation`
        );
      }
    });

    workingSubjects = workingSubjects.map((s) => {
      const requirements = overrides.topic_requirements[s.name];
      if (!requirements) return s;

      const requestedTotal = requirements.reduce((sum, r) => sum + r.count, 0);
      if (requestedTotal > s.count) {
        throw new ApiError(
          400,
          `topic_requirements for subject "${s.name}" ask for ${requestedTotal} question(s) ` +
            `across its named topics, but this subject only has ${s.count} question(s) allocated ` +
            `in total — reduce the topic counts or increase the subject's question count.`
        );
      }

      return { ...s, topic_requirements: requirements };
    });
  }

  // ── difficulty_distribution ───────────────────────────────────────
  let difficulty_distribution;
  if (!overrides.difficulty || overrides.difficulty === 'mixed') {
    // Absent or 'mixed' — keep the blueprint's own split unchanged.
    difficulty_distribution = { ...base.difficulty_distribution };
  } else {
    // A single named difficulty is a fundamentally different shape
    // from the blueprint's normal ratio-based split: every question
    // drawn this run comes from that one bucket only. Made explicit
    // here rather than forced through the normal ratio calculation.
    difficulty_distribution = { easy: 0, medium: 0, hard: 0 };
    difficulty_distribution[overrides.difficulty] = total_questions;
  }

  // ── pass-through fields, with the same defaults Phase 6 already
  // uses where applicable ────────────────────────────────────────────
  return {
    ...base,
    total_questions,
    subjects: workingSubjects,
    difficulty_distribution,
    quality_threshold: overrides.quality_threshold ?? base.quality_threshold ?? 50,
    // Renamed from `exclude_recent_days` — see fetchRecentlyUsedMcqIds's
    // header comment for why "last N tests" replaced "last N days" as
    // the unit here.
    exclude_recent_tests: overrides.exclude_recent_tests ?? base.exclude_recent_tests ?? null,
    randomize: overrides.randomize ?? base.randomize ?? true,
    past_paper_priority: overrides.past_paper_priority ?? base.past_paper_priority ?? false,
    // Phase 7, Prompt 74: intentionally inert at this stage — carried
    // through to the working config, and from there all the way into
    // the persisted GeneratedTest.generation_params record (see
    // persistTest below), faithfully stored and returned but never
    // interpreted. A future phase can implement specific rule types
    // against this field without needing to first go add the plumbing.
    custom_rules: overrides.custom_rules ?? base.selection_rules ?? {},
  };
};

// ─── Step 3: validateBlueprintFeasibility ───────────────────────────
// Thin wrapper around Phase 5's blueprintService.checkMCQAvailability —
// deliberately not reimplemented here, so the generator and
// BlueprintDetail.jsx / FeasibilityReport.jsx can never disagree about
// what "feasible" means.
export const validateBlueprintFeasibility = async (blueprint) => {
  const report = await blueprintService.checkMCQAvailability(blueprint);

  if (!report.feasible) {
    // 422 — well-formed request, can't currently be fulfilled — rather
    // than 400. The full per-subject/per-difficulty report travels as
    // structured error detail so the controller (Prompt 66) can surface
    // exactly which subjects/difficulties are short, matching
    // FeasibilityReport.jsx's display shape from Phase 5.
    throw new ApiError(422, 'Blueprint is not currently feasible', { report });
  }

  return report;
};

// ─── Step 4a: distributeInteger (largest-remainder rounding) ────────
// Splits `total` whole units across the keys of `weights` in
// proportion to their weight, guaranteeing the buckets sum to exactly
// `total` — unlike rounding each bucket independently (Math.round per
// key), which can drift the sum off by one in either direction.
// Isolated as its own helper since the arithmetic is genuinely fiddly
// and worth testing on its own (see Prompt 63's DoD: 7, 13, etc.).
const distributeInteger = (total, weights) => {
  const keys = Object.keys(weights);
  const result = {};
  keys.forEach((k) => {
    result[k] = 0;
  });

  if (!Number.isFinite(total) || total <= 0) {
    return result;
  }

  const sumWeights = keys.reduce((sum, k) => sum + (Number(weights[k]) || 0), 0);
  if (sumWeights <= 0) {
    throw new ApiError(
      400,
      'Cannot distribute questions across difficulty levels: weights sum to zero'
    );
  }

  // Exact (fractional) share per key, then floor each — this is the
  // "largest remainder" method's first pass.
  const shares = keys.map((key) => {
    const exact = (Number(weights[key]) / sumWeights) * total;
    const base = Math.floor(exact);
    return { key, base, remainder: exact - base };
  });

  let assigned = shares.reduce((sum, s) => sum + s.base, 0);
  shares.forEach((s) => {
    result[s.key] = s.base;
  });

  // Distribute whatever's left (always a small non-negative integer,
  // at most keys.length - 1) to the keys with the largest fractional
  // remainder first — the step that guarantees the sum lands exactly
  // on `total` instead of one-off in either direction.
  const byRemainderDesc = [...shares].sort((a, b) => b.remainder - a.remainder);
  let i = 0;
  while (assigned < total && i < byRemainderDesc.length) {
    result[byRemainderDesc[i].key] += 1;
    assigned += 1;
    i += 1;
  }

  return result;
};

// ─── Step 4a: calculateSubjectDifficultyCounts ──────────────────────
// Splits one subject's total question count across easy/medium/hard
// using the SAME proportions as the working config's overall
// difficulty_distribution — the total per subject always comes from
// the working config's subject.count (already correctly rescaled by
// acceptOverrides, Prompt 72); an override changes the difficulty
// *mix*, never how many questions a subject gets.
//
// Phase 7 change (Prompt 73): the ratios now come from
// `workingConfig.difficulty_distribution` instead of reading
// `blueprint.difficulty_distribution` / `params.difficultyOverride`
// directly — acceptOverrides already shaped that field correctly for
// both the 'mixed' case (blueprint's own split, untouched) and the
// single-difficulty-override case ({ easy: 0, medium: 0, hard: total }
// or whichever bucket was named), so this function's actual math is
// completely unchanged from Phase 6, only its input source changed.
export const calculateSubjectDifficultyCounts = (subject, workingConfig) => {
  const weightsSource = workingConfig.difficulty_distribution ?? {};
  const weights = {
    easy: weightsSource.easy ?? 0,
    medium: weightsSource.medium ?? 0,
    hard: weightsSource.hard ?? 0,
  };

  return distributeInteger(subject.count, weights);
};

// ─── Step 4b/4c helpers: fetchAndSamplePool ──────────────────────────
const DIFFICULTIES = ['easy', 'medium', 'hard'];

// BUGFIX ("0 available" for a topic that clearly has MCQs): topic is a
// free-text field (MCQ.js: just `{ type: String, trim: true }`, no
// case normalization), and "Topics to Include" lets an admin type a
// topic name freely rather than only picking from an exact-cased
// suggestion list. An exact-match query like `{ topic: 'synonyms' }`
// silently returns nothing against MCQs stored as "Synonyms" — same
// topic, different case, zero results, no error to explain why. Every
// place that matches a REQUESTED topic string against MCQ.topic uses
// this instead of a raw equality filter, so "Synonyms" / "synonyms" /
// "SYNONYMS" all match the same underlying data.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const topicMatchFilter = (topicValue) => ({
  topic: { $regex: `^${escapeRegex(topicValue.trim())}$`, $options: 'i' },
});


// ─── Step 4a (joint): distributeSubjectDifficultyCounts ─────────────
// The bug: calculateSubjectDifficultyCounts (above) rounds each
// subject's split INDEPENDENTLY, via its own separate call to
// distributeInteger. That's correct in isolation — each subject's own
// three buckets always sum to exactly that subject's count — but
// summing those per-subject buckets back up across subjects does NOT
// reliably reproduce the blueprint's own top-level
// difficulty_distribution. Two separate largest-remainder roundings
// each resolve their own .5-ish fractional remainders independently,
// so the totals can silently drift a question or two off from the
// blueprint-level split (e.g. blueprint-level 100 questions at
// 30/35/35 vs. three subjects rounded independently summing to
// 30/36/34) — confirmed by direct repro against the real
// distributeInteger implementation. verifyFinalCounts (Step 6) checks
// the SUMMED per-subject actuals against the blueprint's own
// difficulty_distribution, so that drift surfaces there as
// "Generated test does not match blueprint difficulty distribution",
// even though each individual subject's own numbers looked fine.
//
// The fix is a genuine joint rounding pass (the classic "controlled
// rounding" / matrix-rounding problem) that guarantees BOTH margins
// exactly, in one shot: every subject's row still sums to
// subject.count, AND every difficulty's column sums to
// workingConfig.difficulty_distribution. Floor every (subject,
// difficulty) cell first — that undershoots each row and column by a
// small non-negative amount — then walk the resulting deficits down
// to zero one unit at a time, each time picking a cell that still
// owes both its row and its column (largest fractional remainder
// first, to match distributeInteger's own tie-breaking philosophy).
// This always converges: sum(rowDeficits) and sum(colDeficits) are
// each exactly `total_questions - sum of all floors`, so they're
// always equal, meaning a valid cell always exists until both are
// zero.
export const distributeSubjectDifficultyCounts = (subjects, workingConfig) => {
  const weightsSource = workingConfig.difficulty_distribution ?? {};
  const weights = {
    easy: weightsSource.easy ?? 0,
    medium: weightsSource.medium ?? 0,
    hard: weightsSource.hard ?? 0,
  };
  const sumWeights = DIFFICULTIES.reduce((sum, d) => sum + (Number(weights[d]) || 0), 0);

  const result = {};
  subjects.forEach((s) => {
    result[s.name] = { easy: 0, medium: 0, hard: 0 };
  });

  if (sumWeights <= 0 || subjects.length === 0) {
    return result;
  }

  // Exact fractional share per (subject, difficulty) cell, floored —
  // same first pass as distributeInteger, just over a 2-D grid instead
  // of a single row.
  const cells = [];
  subjects.forEach((subject) => {
    DIFFICULTIES.forEach((difficulty) => {
      const exact = (Number(weights[difficulty]) / sumWeights) * subject.count;
      const base = Math.floor(exact);
      cells.push({ subject: subject.name, difficulty, remainder: exact - base });
      result[subject.name][difficulty] = base;
    });
  });

  // Row deficits: how many more each subject needs to reach subject.count.
  const rowDeficit = {};
  subjects.forEach((s) => {
    const assigned = DIFFICULTIES.reduce((sum, d) => sum + result[s.name][d], 0);
    rowDeficit[s.name] = s.count - assigned;
  });

  // Column deficits: how many more each difficulty needs to reach the
  // blueprint's own bucket total.
  const colDeficit = {};
  DIFFICULTIES.forEach((d) => {
    const assigned = subjects.reduce((sum, s) => sum + result[s.name][d], 0);
    colDeficit[d] = (weights[d] ?? 0) - assigned;
  });

  // Largest-remainder-first order for the leftover-unit walk.
  cells.sort((a, b) => b.remainder - a.remainder);

  let remaining = Object.values(rowDeficit).reduce((a, b) => a + b, 0);
  let guard = 0;
  const guardLimit = (subjects.length + DIFFICULTIES.length) * remaining + subjects.length + 1;
  while (remaining > 0) {
    guard += 1;
    if (guard > guardLimit) {
      // Should be unreachable — rowDeficit and colDeficit always sum
      // to the same total, so a valid cell always exists. This guard
      // only exists so a future regression here fails loudly instead
      // of hanging.
      throw new ApiError(500, 'Failed to reconcile subject/difficulty rounding');
    }
    let progressed = false;
    for (const cell of cells) {
      if (rowDeficit[cell.subject] > 0 && colDeficit[cell.difficulty] > 0) {
        result[cell.subject][cell.difficulty] += 1;
        rowDeficit[cell.subject] -= 1;
        colDeficit[cell.difficulty] -= 1;
        remaining -= 1;
        progressed = true;
        break;
      }
    }
    if (!progressed) {
      // No single cell currently owes both its row and its column
      // simultaneously (can happen once remainder-ties are exhausted)
      // — pair up any subject that still needs a question with any
      // difficulty that still has one to give. Correctness (both
      // margins landing exactly on target) never depends on which
      // cell is chosen, only on always decrementing one row deficit
      // and one column deficit together.
      const subjectName = Object.keys(rowDeficit).find((name) => rowDeficit[name] > 0);
      const difficulty = DIFFICULTIES.find((d) => colDeficit[d] > 0);
      if (!subjectName || !difficulty) break;
      result[subjectName][difficulty] += 1;
      rowDeficit[subjectName] -= 1;
      colDeficit[difficulty] -= 1;
      remaining -= 1;
    }
  }

  return result;
};

// Fisher–Yates shuffle — the standard unbiased in-place shuffle.
// Deliberately NOT `array.sort(() => Math.random() - 0.5)`, a
// well-known biased-shuffle anti-pattern (comparator-based sorts don't
// visit every permutation with equal probability).
const fisherYatesShuffle = (array) => {
  const shuffled = [...array];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
};

// Phase 7 (Prompt 73): sort spec builder, split out so
// fetchAndSamplePool's main body stays readable. Default sort is
// unchanged from Phase 6 — prefer never-used, then least-recently-used.
//
// `past_paper_priority` is meant to additionally sort past-paper-
// sourced questions ahead of the rest, but the MCQ model (Prompt 47's
// mcqSchema) doesn't currently have a `source` / `is_past_paper` field
// to sort on — there is nothing in this codebase yet distinguishing a
// past-paper question from an original one. Rather than block this
// override on a schema migration, the sort key is included
// unconditionally as the PRIMARY sort field: once such a field exists
// on the MCQ model, this starts working with no further changes here.
// Until then it degrades gracefully to a no-op — every document sorts
// equal on a field that doesn't exist, so Mongo just falls through to
// the next sort key (used_count/last_used_at) exactly as before, and
// nothing errors.
const buildSort = (workingConfig) => {
  if (workingConfig.past_paper_priority) {
    // TODO(schema): add `is_past_paper: Boolean` (or a `source` enum)
    // to server/src/models/MCQ.js for this to have any real effect.
    return { is_past_paper: -1, used_count: 1, last_used_at: 1 };
  }
  return { used_count: 1, last_used_at: 1 };
};

// For each difficulty bucket with count > 0: fetch a candidate pool
// (count * 3, not the exact count), sorted to prefer never-used /
// least-recently-used questions (plus past-paper priority, if
// configured — see buildSort above), then randomly sample exactly
// `count` from that pool.
//
// Returns { subjectName, questions, spares } rather than a bare flat
// array — `questions` is the flat, lean sampled list
// ({mcq_id, subject, difficulty}, no text/options at this stage), and
// `spares` is the *unpicked remainder* of each difficulty's
// already-fetched pool (same lean shape), keyed by difficulty. Kept
// around specifically so mergeAndDeduplicate (Prompt 64) can redraw a
// same-bucket replacement for a cross-subject duplicate without ever
// re-querying the DB — the pool for a bucket is fetched exactly once.
//
// Phase 7 change (Prompt 73): `subject` is now the working subject
// ENTRY from acceptOverrides's working config — `{ name, count,
// topics? }` — not a bare string, since it may carry a per-subject
// `topics` constraint. `params` is now the full `workingConfig`, so
// every filterable field (`quality_threshold`, `exclude_recent_tests`,
// `past_paper_priority`) is read from one single source of truth
// instead of loose scattered params.
//
// NOTE: Phase 6's `subjectOverride` (remapping which MCQ-collection
// subject value a blueprint subject queries against) is not part of
// Phase 7's overrides schema (Prompt 71) or working config (Prompt
// 72), so it's no longer threaded through here — `subject.name` is
// queried directly.
// ─── fetchRecentlyUsedMcqIds ("Exclude recently-used MCQs", by TEST count) ──
// Replaces the earlier `exclude_recent_days` filter. Subjects/MCQ pools
// are shared across exams in this deployment (confirmed — the same
// "Verbal"/"Academic"/etc. subject pool backs multiple exams), so
// "recently used" has to mean "used in the last N tests that drew from
// THIS subject, across ALL exams" — not just the exam currently being
// generated for — or the same MCQ could keep resurfacing back-to-back
// across two different exams that happen to share a subject. That's
// why this is scoped by subject name, not by exam_id.
//
// Days-based exclusion was a weak proxy for what admins actually mean
// by "recently used": it degrades badly under irregular generation
// cadences — a burst of same-day generations blows through the whole
// pool under a days-based filter, while a slow, occasional cadence
// barely excludes anything even a week later. Counting by TEST instead
// ties the exclusion to the thing that actually varies with reuse —
// how many tests ago an MCQ last appeared — regardless of how much
// wall-clock time that spanned.
//
// Only 'completed' tests count toward the window — a 'failed' persist
// attempt (see GeneratedTest.status) never actually put those MCQs in
// front of a test-taker, so it shouldn't consume a slot in the
// exclusion window the way a real test does.
//
// Deliberately one query PER SUBJECT rather than one global query over
// the last N tests overall: different subjects reach "their" last N
// tests at different points back through history (a subject that's
// rarely tested would otherwise get an incorrectly narrow — or
// incorrectly wide, depending on how you'd approximate it — window
// under any single shared cutoff). Each individual query is cheap
// (indexed, `.limit(testCount)`), and the subject count in a working
// config is always small, so this stays far short of the
// per-subject-per-difficulty query blowup earlier comments in this
// file specifically warn against.
export const fetchRecentlyUsedMcqIds = async (subjectName, testCount) => {
  if (!testCount || testCount <= 0) return [];

  const recentTests = await GeneratedTest.find({
    status: 'completed',
    'questions.subject': subjectName,
  })
    .sort({ generated_at: -1 })
    .limit(testCount)
    .select('questions.mcq_id questions.subject')
    .lean();

  const ids = new Set();
  for (const test of recentTests) {
    for (const q of test.questions) {
      if (q.subject === subjectName) ids.add(q.mcq_id);
    }
  }
  return [...ids];
};

// ─── fetchTopicGuaranteedQuestions ("Topics to Include") ─────────────
// Satisfies a subject's topic_requirements (see acceptOverrides) FIRST
// — e.g. "Synonyms: 3, Antonyms: 3" for an English subject — pulling
// exactly that many approved MCQs from each named topic, difficulty-
// agnostic (a guarantee is about the TOPIC, not which difficulty it
// lands at). Returns both the picked questions and their ids, so
// generateTest can (a) merge them straight into that subject's final
// question list and (b) tell fetchAndSamplePool's later random-fill
// pass to exclude them via its own excludeIds param — otherwise the
// same MCQ could be drawn twice.
//
// Runs BEFORE any difficulty-bucket math for this subject — so a
// subject with topic_requirements gets its difficulty split computed
// against the REMAINING count (subject.count minus however many
// guarantees consumed), not the full count. See generateTest's own
// comment on this for why that matters.
//
// Completely inert when subject.topic_requirements is absent/empty —
// returns immediately with nothing picked and nothing to exclude, so
// a subject with no topic requirements behaves exactly as generation
// already did before this feature existed.
export const fetchTopicGuaranteedQuestions = async (subject, workingConfig = {}) => {
  const requirements = subject.topic_requirements;
  if (!requirements || requirements.length === 0) {
    return { questions: [], excludeIds: [] };
  }

  const qualityThreshold = workingConfig.quality_threshold ?? 50;
  const recentlyUsedIds = await fetchRecentlyUsedMcqIds(subject.name, workingConfig.exclude_recent_tests);

  const questions = [];
  // Seeded with the recently-used-by-test exclusion (if any) so it's
  // folded into the exact same $nin mechanism the loop below already
  // uses to stop two requirements from claiming the same MCQ.
  const excludeIds = [...recentlyUsedIds];

  for (const requirement of requirements) {
    const query = {
      subject: subject.name,
      ...topicMatchFilter(requirement.topic),
      status: 'approved',
      quality_score: { $gte: qualityThreshold },
      // Covers both the recently-used-by-test exclusion seeded above
      // AND (once excludeIds grows past that) the same-MCQ-twice guard
      // between requirements — one $nin, same as before.
      ...(excludeIds.length > 0 ? { question_id: { $nin: excludeIds } } : {}),
    };

    // eslint-disable-next-line no-await-in-loop
    const pool = await MCQ.find(query)
      .select('question_id subject topic subtopic difficulty question')
      .lean();

    if (pool.length < requirement.count) {
      throw new ApiError(
        422,
        `Not enough approved MCQs in topic "${requirement.topic}" for subject "${subject.name}": ` +
          `need ${requirement.count}, found ${pool.length} matching the current quality threshold` +
          `${workingConfig.exclude_recent_tests ? ' and recent-use exclusion' : ''}.`
      );
    }

    const picked = fisherYatesShuffle(pool).slice(0, requirement.count);
    picked.forEach((doc) => {
      questions.push({
        mcq_id: doc.question_id,
        subject: subject.name,
        // Snapshot the MCQ's own topic/subtopic at generation time,
        // not `requirement.topic` — topicMatchFilter above matched
        // case-insensitively, so `doc.topic` is the exact stored
        // casing, which is what should be frozen onto the test.
        topic: doc.topic || '',
        subtopic: doc.subtopic || '',
        difficulty: doc.difficulty,
        question: doc.question,
      });
      excludeIds.push(doc.question_id);
    });
  }

  return { questions, excludeIds };
};

// Borrow order when a difficulty bucket for a subject is short — used
// by both fetchAndSamplePool (actually draws the substitute questions)
// and checkOverrideFeasibility below (reports whether a shortfall is
// "redistributable" before generation even runs). Nearest difficulty
// tried first: hard borrows from medium then easy, medium from hard
// then easy, easy from medium then hard.
const BORROW_ORDER = {
  hard: ['medium', 'easy'],
  medium: ['hard', 'easy'],
  easy: ['medium', 'hard'],
};

// FEATURE COMPLETION: InsufficientWarning.jsx and checkOverrideFeasibility
// below were already written expecting a bucket-level "redistributable"
// flag and an actual substitution happening on Generate — but this
// function, until now, only ever hard-failed (422) the moment any
// single subject+difficulty bucket came up short, with no borrowing
// actually implemented. That mismatch is exactly what could make the
// live feasibility panel look fine (or blocking-but-not-adjustable)
// while the real "Generated test does not match blueprint difficulty
// distribution" style failures happened at Generate time. This
// implements the other half: if a bucket is short, borrow the
// shortfall from the nearest other difficulty in the SAME subject
// (BORROW_ORDER above) — a test still generates whenever the subject
// has enough approved MCQs in total, even if not enough at one exact
// difficulty. Only a subject that's short even across ALL THREE
// difficulties combined still throws (see the final ApiError below) —
// that's a genuine, unrecoverable shortage.
export const fetchAndSamplePool = async (subject, difficultyCounts, workingConfig = {}, excludeIds = []) => {
  const qualityThreshold = workingConfig.quality_threshold ?? 50;
  const sortSpec = buildSort(workingConfig);

  // Dynamic option: "Recently Used Exclusion" — skip MCQs that appeared
  // in the last N tests drawn from this subject (see
  // fetchRecentlyUsedMcqIds's header comment for why "N tests" replaced
  // the earlier "N days" version). Called unconditionally here (not
  // just when this subject has topic requirements) since this is the
  // one function EVERY subject's random-fill pass goes through —
  // fetchTopicGuaranteedQuestions only applies its own copy of this
  // exclusion to the minority of subjects that have topic_requirements
  // at all, and early-returns before ever calling it otherwise.
  const recentlyUsedIds = await fetchRecentlyUsedMcqIds(subject.name, workingConfig.exclude_recent_tests);
  // Merge into the SAME excludeIds list topic-guarantee picks already
  // populate, so one $nin below covers both reasons an MCQ might be
  // off-limits this run — deduped since a guaranteed pick and a
  // recently-used MCQ could theoretically be the same id.
  const combinedExcludeIds = [...new Set([...excludeIds, ...recentlyUsedIds])];

  // Phase 7: topics override — fail fast with a specific, actionable
  // error if NONE of the requested topics actually exist for this
  // subject, rather than silently running every difficulty query
  // against a starved/empty pool and only surfacing a confusing
  // "insufficient MCQs" error later in the loop below.
  let topicFilter;
  if (subject.topics?.length) {
    const existingTopics = await MCQ.distinct('topic', { subject: subject.name });
    const existingTopicSet = new Set(existingTopics);
    const anyTopicExists = subject.topics.some((t) => existingTopicSet.has(t));
    if (!anyTopicExists) {
      throw new ApiError(
        400,
        `No questions exist for subject "${subject.name}" with the requested topics`
      );
    }
    topicFilter = { topic: { $in: subject.topics } };
  }

  // ── Step 1: fetch EVERY difficulty's full available pool up front ──
  // No `.limit(count * 3)` cap here — a shortfall decision needs the
  // TRUE available count in every bucket, including a bucket whose own
  // difficultyCounts[difficulty] is 0, since that can still be a
  // legitimate borrow SOURCE for a shortfall elsewhere in this subject.
  const poolsByDifficulty = {};
  for (const difficulty of DIFFICULTIES) {
    const query = {
      subject: subject.name,
      difficulty,
      status: 'approved',
      quality_score: { $gte: qualityThreshold },
      ...(topicFilter ?? {}),
      // Covers both topic-guaranteed picks (fetchTopicGuaranteedQuestions,
      // run before this, so a random-fill pass never re-selects the same
      // MCQ a guarantee already claimed) AND the recently-used-by-test
      // exclusion computed above. A no-op (empty array → $nin: []
      // matches everything) when neither applies.
      ...(combinedExcludeIds.length > 0 ? { question_id: { $nin: combinedExcludeIds } } : {}),
    };

    // eslint-disable-next-line no-await-in-loop
    const pool = await MCQ.find(query)
      // `question` added purely so mergeAndDeduplicate (below) can also
      // dedupe by normalized question TEXT, not just mcq_id — see that
      // function's comment for why mcq_id alone isn't enough.
      .select('question_id subject topic subtopic difficulty used_count last_used_at question')
      // Nulls sort before dates in ascending BSON order, so
      // never-used questions (last_used_at: null) come first
      // automatically — exactly "prefer never-used, then
      // least-recently-used", with no special-casing needed.
      .sort(sortSpec)
      .lean();

    poolsByDifficulty[difficulty] = fisherYatesShuffle(pool);
  }

  // ── Step 2: resolve shortfalls by borrowing from adjacent buckets ──
  // `targetCounts` starts as the requested split and is mutated in
  // place as borrowing happens — by the end it holds the ACTUAL
  // per-difficulty counts this subject will use.
  const targetCounts = { easy: 0, medium: 0, hard: 0, ...difficultyCounts };

  for (const difficulty of DIFFICULTIES) {
    const requested = difficultyCounts?.[difficulty] ?? 0;
    const available = poolsByDifficulty[difficulty].length;
    const shortfall = requested - available;
    if (shortfall <= 0) {
      // eslint-disable-next-line no-continue
      continue;
    }

    targetCounts[difficulty] = available; // can only take what actually exists
    let remainingShortfall = shortfall;

    for (const borrowFrom of BORROW_ORDER[difficulty]) {
      if (remainingShortfall <= 0) break;
      const alreadyAllocated = targetCounts[borrowFrom] ?? 0;
      const surplus = poolsByDifficulty[borrowFrom].length - alreadyAllocated;
      if (surplus <= 0) {
        // eslint-disable-next-line no-continue
        continue;
      }
      const borrowed = Math.min(surplus, remainingShortfall);
      targetCounts[borrowFrom] += borrowed;
      remainingShortfall -= borrowed;
    }

    if (remainingShortfall > 0) {
      // Borrowed everywhere possible and STILL can't reach this
      // subject's required total — a real, unrecoverable shortage
      // across every difficulty combined, not just one bucket.
      const totalAvailable = DIFFICULTIES.reduce((sum, d) => sum + poolsByDifficulty[d].length, 0);
      const totalRequested = DIFFICULTIES.reduce((sum, d) => sum + (difficultyCounts?.[d] ?? 0), 0);
      throw new ApiError(
        422,
        `Not enough approved MCQs for subject "${subject.name}" even after borrowing across ` +
          `difficulties: need ${totalRequested} total, only ${totalAvailable} approved question(s) ` +
          `exist for this subject matching the current quality threshold` +
          `${topicFilter ? ' and topic filter' : ''}${workingConfig.exclude_recent_tests ? ' and recent-use exclusion' : ''}.`
      );
    }
  }

  // ── Step 3: pick from each pool according to the (possibly
  // borrow-adjusted) targetCounts ──
  const questions = [];
  const spares = { easy: [], medium: [], hard: [] };

  for (const difficulty of DIFFICULTIES) {
    const count = targetCounts[difficulty] ?? 0;
    if (count <= 0) {
      // eslint-disable-next-line no-continue
      continue;
    }

    const pool = poolsByDifficulty[difficulty]; // already shuffled in Step 1
    const picked = pool.slice(0, count);
    const leftover = pool.slice(count);

    picked.forEach((doc) => {
      questions.push({
        mcq_id: doc.question_id,
        subject: subject.name,
        topic: doc.topic || '',
        subtopic: doc.subtopic || '',
        difficulty: doc.difficulty,
        question: doc.question,
      });
    });
    spares[difficulty] = leftover.map((doc) => ({
      mcq_id: doc.question_id,
      subject: subject.name,
      topic: doc.topic || '',
      subtopic: doc.subtopic || '',
      difficulty: doc.difficulty,
      question: doc.question,
    }));
  }

  return { subjectName: subject.name, questions, spares };
};

// ─── checkOverrideFeasibility (Phase 7, Prompt 75) ───────────────────
// Override-aware sibling of validateBlueprintFeasibility /
// blueprintService.checkMCQAvailability above: those two check the
// BLUEPRINT's own raw requirements, which is the wrong question once
// overrides are in play — an admin who has narrowed `subjects`, added
// a `topics` filter, or set `exclude_recent_tests` needs to know
// whether THAT working config is feasible, not the blueprint's
// original one. Powers InsufficientWarning.jsx's pre-flight check on
// the frontend so a bad combination of overrides surfaces before
// Generate is clicked, not as a 422 from fetchAndSamplePool after.
//
// Deliberately reuses acceptOverrides (Prompt 72) and
// calculateSubjectDifficultyCounts (Prompt 63/73) rather than
// recomputing required counts its own way — this function must check
// feasibility against the exact SAME working config and exact same
// per-subject/per-difficulty counts that generateTest would actually
// draw against, or the warning could disagree with what actually
// happens on Generate.
//
// Cost discipline: this runs on every keystroke-adjacent override
// change on the frontend, so it must stay cheap — count-only
// aggregation, never a full fetch+sample (fetchAndSamplePool's job),
// and a single aggregation query regardless of how many subjects are
// in play (never one query per subject+difficulty bucket).
export const checkOverrideFeasibility = async (blueprint, overrides = {}) => {
  const workingConfig = acceptOverrides(blueprint, overrides);

  const qualityThreshold = workingConfig.quality_threshold ?? 50;

  // Required count per subject+difficulty bucket, derived exactly the
  // way generation itself would derive it — zero-count buckets are
  // dropped up front since there's nothing to check feasibility for.
  const requiredBuckets = [];
  const jointCounts = distributeSubjectDifficultyCounts(workingConfig.subjects, workingConfig);
  workingConfig.subjects.forEach((subject) => {
    const counts = jointCounts[subject.name];
    DIFFICULTIES.forEach((difficulty) => {
      const required = counts[difficulty] ?? 0;
      if (required > 0) {
        requiredBuckets.push({ subject: subject.name, difficulty, required });
      }
    });
  });

  if (requiredBuckets.length === 0) {
    return { feasible: true, buckets: [] };
  }

  // acceptOverrides applies a `topics` override identically to EVERY
  // working subject (see its own comment: "attach as a per-subject
  // constraint, shape-only" — the same overrides.topics array, copied
  // onto each subject) — so the filter is uniform across the whole
  // working config, never subject-specific here. That's what makes a
  // single $in-scoped $match + $group possible instead of needing a
  // per-subject $facet: every subject in play shares the same topic
  // filter (or lack of one).
  const subjectNames = [...new Set(requiredBuckets.map((b) => b.subject))];
  const topics = workingConfig.subjects[0]?.topics;

  // Recently-used-by-test exclusion (see fetchRecentlyUsedMcqIds's
  // header comment). One query per subject in play, run in parallel —
  // subject count here is always small, so this doesn't reintroduce
  // the per-subject-per-DIFFICULTY blowup the comment above warns
  // against; it's a flat, bounded addition regardless of how many
  // difficulty buckets each subject has. All subjects' excluded ids
  // are safely flattened into ONE $nin below (an id excluded for
  // subject A can never collide with subject B's rows, since
  // fetchRecentlyUsedMcqIds only ever returns ids it confirmed belong
  // to the subject it was asked about) — so the "single aggregation
  // query" cost discipline for the actual MCQ count still holds.
  const recentlyExcludedIds = workingConfig.exclude_recent_tests
    ? (
        await Promise.all(
          subjectNames.map((name) => fetchRecentlyUsedMcqIds(name, workingConfig.exclude_recent_tests))
        )
      ).flat()
    : [];

  const match = {
    subject: { $in: subjectNames },
    status: 'approved',
    quality_score: { $gte: qualityThreshold },
    ...(topics?.length ? { topic: { $in: topics } } : {}),
    ...(recentlyExcludedIds.length > 0 ? { question_id: { $nin: recentlyExcludedIds } } : {}),
  };

  // ONE aggregation query for every subject+difficulty bucket in the
  // working config, however many subjects are in play — the scaling
  // discipline every prior phase's DB-heavy check has held to.
  const rows = await MCQ.aggregate([
    { $match: match },
    { $group: { _id: { subject: '$subject', difficulty: '$difficulty' }, count: { $sum: 1 } } },
  ]);

  const availableMap = new Map(
    rows.map((r) => [`${r._id.subject}::${r._id.difficulty}`, r.count])
  );

  const buckets = requiredBuckets.map((b) => {
    const available = availableMap.get(`${b.subject}::${b.difficulty}`) ?? 0;
    const sufficient = available >= b.required;

    // redistributable: true iff this bucket is short BUT can borrow the
    // shortfall from an adjacent difficulty in the SAME subject.
    // Computed by applying the same BORROW_ORDER logic fetchAndSamplePool
    // uses, so the "feasible but will adjust" info matches reality.
    let redistributable = false;
    if (!sufficient) {
      const shortfall = b.required - available;
      let remainingShortfall = shortfall;
      for (const borrowFrom of BORROW_ORDER[b.difficulty]) {
        const borrowBucket = requiredBuckets.find((rb) => rb.subject === b.subject && rb.difficulty === borrowFrom);
        if (!borrowBucket) continue; // no required allocation from this difficulty anyway
        const borrowAvailable = availableMap.get(`${b.subject}::${borrowFrom}`) ?? 0;
        const borrowRequired = borrowBucket.required;
        const borrowSurplus = borrowAvailable - borrowRequired;
        if (borrowSurplus > 0) {
          const canBorrow = Math.min(borrowSurplus, remainingShortfall);
          remainingShortfall -= canBorrow;
        }
      }
      redistributable = remainingShortfall === 0;
    }

    return {
      subject: b.subject,
      difficulty: b.difficulty,
      required: b.required,
      available,
      sufficient,
      redistributable,
    };
  });

  const feasible = buckets.every((b) => b.sufficient || b.redistributable);

  // ── Topic-level requirements validation ───────────────────────────
  // Same as checkMCQAvailability above: topic_requirements only ever
  // exist on a generation-time workingConfig (acceptOverrides attaches
  // them per subject), never on a plain Blueprint, so this is either
  // validating real requirements or a no-op.
  const topicRequirementsList = [];
  workingConfig.subjects.forEach((entry) => {
    (entry.topic_requirements ?? []).forEach((req) => {
      topicRequirementsList.push({ subject: entry.name, topic: req.topic, required: req.count });
    });
  });

  let topicRequirementResults = [];
  if (topicRequirementsList.length > 0 && feasible) {
    // Only run topic check if we're already feasible overall — no point
    // reporting both a subject-level shortfall AND a topic-level one
    // simultaneously, which would confuse the admin more than help.
    const topicCounts = await MCQ.aggregate([
      {
        $match: {
          status: 'approved',
          quality_score: { $gte: qualityThreshold },
          // BUGFIX: same case-insensitivity issue as
          // fetchTopicGuaranteedQuestions/topicMatchFilter — an admin
          // typing "synonyms" must still match MCQs stored as
          // "Synonyms". Each requirement gets its own case-insensitive
          // regex clause rather than one exact-match $or.
          $or: topicRequirementsList.map((r) => ({
            subject: r.subject,
            ...topicMatchFilter(r.topic),
          })),
          ...(recentlyExcludedIds.length > 0 ? { question_id: { $nin: recentlyExcludedIds } } : {}),
        },
      },
      {
        $group: {
          // Normalized to lowercase so "Synonyms" and "synonyms" collapse
          // into the same bucket regardless of how either the MCQ or the
          // admin's typed requirement happened to be cased.
          _id: { subject: '$subject', topic: { $toLower: '$topic' } },
          count: { $sum: 1 },
        },
      },
    ]);
    const topicCountMap = new Map(
      topicCounts.map((r) => [`${r._id.subject}::${r._id.topic}`, r.count])
    );
    topicRequirementResults = topicRequirementsList.map((r) => {
      const available = topicCountMap.get(`${r.subject}::${r.topic.trim().toLowerCase()}`) ?? 0;
      return { ...r, available, sufficient: available >= r.required };
    });
  }

  const allFeasible = feasible && topicRequirementResults.every((t) => t.sufficient);

  return { feasible: allFeasible, buckets, topicRequirementResults };
};

// ─── Step 5: mergeAndDeduplicate ─────────────────────────────────────
// Flattens every subject's sampled questions into one list, with a
// defensive final safety net against cross-subject mcq_id duplicates.
// This shouldn't happen in the common case — each per-subject query in
// fetchAndSamplePool is scoped to its own `subject` field, and one MCQ
// document normally has exactly one subject value — but it becomes a
// real (if rare) possibility once params.subjectOverride is in play:
// two different blueprint subjects can be mapped to the SAME
// underlying MCQ-collection subject value, in which case their two
// independent pool fetches are drawing from the same underlying MCQs
// and can genuinely collide.
// ─── Step 5: mergeAndDeduplicate ─────────────────────────────────────
// Flattens every subject's sampled questions into one list, with a
// defensive final safety net against BOTH kinds of duplicate:
//   1. Same mcq_id drawn twice — the original (rare) cross-subject
//      collision case, e.g. via subjectOverride mapping two blueprint
//      subjects onto the same underlying MCQ-collection subject.
//   2. Same question TEXT under two DIFFERENT mcq_ids — this happens
//      whenever the same content was imported more than once (e.g. a
//      retried import created two MCQ documents for every question),
//      which mcq_id-only dedup can never catch since the ids genuinely
//      differ. Caught here by comparing each candidate's normalized-
//      question hash (the same normalizeQuestion/hashQuestion used at
//      import time) against every hash already placed in this test.
export const mergeAndDeduplicate = (perSubjectResults) => {
  const finalQuestions = [];
  const seenMcqIds = new Set();
  const seenQuestionHashes = new Set();

  const hashOf = (question) => hashQuestion(normalizeQuestion(question));

  perSubjectResults.forEach((subjectResult) => {
    subjectResult.questions.forEach((question) => {
      const questionHash = hashOf(question.question);
      const isDuplicate = seenMcqIds.has(question.mcq_id) || seenQuestionHashes.has(questionHash);

      if (!isDuplicate) {
        seenMcqIds.add(question.mcq_id);
        seenQuestionHashes.add(questionHash);
        finalQuestions.push(question);
        return;
      }

      // Duplicate (by id OR by text) — drop it and redraw a same-bucket
      // replacement from the pool already fetched in Prompt 63's step
      // (never a fresh query), so the test still lands on the
      // blueprint's exact required count for this subject+difficulty.
      const spares = subjectResult.spares?.[question.difficulty] ?? [];
      let replacement = null;
      while (spares.length > 0) {
        const candidate = spares.shift();
        const candidateHash = hashOf(candidate.question);
        if (!seenMcqIds.has(candidate.mcq_id) && !seenQuestionHashes.has(candidateHash)) {
          replacement = candidate;
          break;
        }
      }

      if (!replacement) {
        throw new ApiError(
          422,
          `Duplicate MCQ detected for subject "${subjectResult.subjectName}" at difficulty ` +
            `"${question.difficulty}", and no replacement remains in the already-fetched pool.`
        );
      }

      seenMcqIds.add(replacement.mcq_id);
      seenQuestionHashes.add(hashOf(replacement.question));
      finalQuestions.push(replacement);
    });
  });

  return finalQuestions;
};

// ─── Step 5.5: applyResultOrdering (Phase 7, Prompt 74) ─────────────
// Decides the FINAL on-page order of the assembled test — a distinct
// concern from fetchAndSamplePool's shuffle (Phase 6, Prompt 63),
// which only decides WHICH questions get picked within each
// subject/difficulty bucket. Without this step, questions always come
// out grouped in the order mergeAndDeduplicate assembled them in
// (i.e. subject-by-subject, in workingConfig.subjects order) — that
// grouped order is itself a legitimate, sometimes-desired result (a
// paper with clean subject sections), which is exactly why
// `randomize: false` is meaningful rather than redundant.
//
// Runs purely on the in-memory array — no DB calls — and purely
// reorders; it never adds, drops, or otherwise changes questions, so
// it can never affect verifyFinalCounts's correctness, only the order
// verifyFinalCounts sees them in (order doesn't matter to count/sum
// checks).
export const applyResultOrdering = (finalQuestions, workingConfig) => {
  const randomize = workingConfig.randomize ?? true;

  if (!randomize) {
    // Explicit `false` is the meaningful override — preserve the
    // subject-grouped order exactly as mergeAndDeduplicate produced
    // it. If past_paper_priority (Prompt 73) already influenced WHICH
    // questions were picked and in what preference order within each
    // bucket, that ordering is already baked into `finalQuestions` by
    // this point — this function's only job is shuffle-vs-preserve,
    // not re-deriving priority order from scratch.
    return finalQuestions;
  }

  return fisherYatesShuffle(finalQuestions);
};

// ─── Step 6: verifyFinalCounts ───────────────────────────────────────
// Final, non-optional assertion before anything is persisted. Should
// be functionally unreachable if every earlier step did its job — but
// the spec explicitly calls for this as a last checkpoint, so a real
// bug earlier in the pipeline fails loudly here (500) rather than
// silently producing a malformed test. This function only verifies; it
// never transforms `finalQuestions`.
// ─── Step 6: verifyFinalCounts ───────────────────────────────────────
// Final, non-optional assertion before anything is persisted. Total
// question count and per-subject counts should be functionally
// unreachable to violate if every earlier step did its job — those two
// still hard-fail loudly (500) rather than silently producing a
// malformed test.
//
// The difficulty-MIX check below used to hard-fail the same way on any
// deviation from the blueprint's exact easy/medium/hard split. That's
// no longer a valid bug signal on its own, for two reasons now baked
// into how a subject's questions get assembled:
//   1. "Topics to Include" guarantees (topic_requirements) are pulled
//      difficulty-agnostic — a guaranteed Synonyms/Antonyms pick lands
//      at whatever difficulty it happens to be, not whichever bucket
//      the blueprint's ratio would prefer. The remaining random fill
//      only rebalances the REMAINING count, so the combined total can
//      end up a few questions off the blueprint's ideal split even
//      though every subject/topic requirement was satisfied exactly.
//   2. A subject that's short of approved MCQs at one specific
//      difficulty can end up drawing extra from an adjacent one rather
//      than failing generation outright (see fetchAndSamplePool).
// Both are intentional, disclosed trade-offs in service of "a test
// should still be generated" — so this function now just returns the
// comparison for the caller to log/surface rather than throwing on it.
export const verifyFinalCounts = (finalQuestions, blueprint) => {
  if (finalQuestions.length !== blueprint.total_questions) {
    throw new ApiError(500, 'Generated test does not match blueprint total question count', {
      expected: blueprint.total_questions,
      actual: finalQuestions.length,
    });
  }

  const expectedBySubject = {};
  blueprint.subjects.forEach((s) => {
    expectedBySubject[s.name] = s.count;
  });
  const actualBySubject = {};
  finalQuestions.forEach((q) => {
    actualBySubject[q.subject] = (actualBySubject[q.subject] ?? 0) + 1;
  });

  const subjectNamesMatch =
    Object.keys(expectedBySubject).every(
      (name) => (actualBySubject[name] ?? 0) === expectedBySubject[name]
    ) && Object.keys(actualBySubject).every((name) => name in expectedBySubject);

  if (!subjectNamesMatch) {
    throw new ApiError(500, 'Generated test does not match blueprint subject counts', {
      expected: expectedBySubject,
      actual: actualBySubject,
    });
  }

  const expectedByDifficulty = {
    easy: blueprint.difficulty_distribution?.easy ?? 0,
    medium: blueprint.difficulty_distribution?.medium ?? 0,
    hard: blueprint.difficulty_distribution?.hard ?? 0,
  };
  const actualByDifficulty = { easy: 0, medium: 0, hard: 0 };
  finalQuestions.forEach((q) => {
    actualByDifficulty[q.difficulty] = (actualByDifficulty[q.difficulty] ?? 0) + 1;
  });

  const difficultyMatches = DIFFICULTIES.every(
    (level) => actualByDifficulty[level] === expectedByDifficulty[level]
  );

  if (!difficultyMatches) {
    // Logged, not thrown — see this function's header comment for why
    // a deviation here is now an expected, disclosed trade-off rather
    // than a bug. Callers that want to surface this to an admin (e.g.
    // generateTest attaching it to generation_params) read the
    // returned object below instead of relying on a caught exception.
    logger.warn(
      `Generated test's difficulty mix deviates from blueprint target ` +
        `(expected ${JSON.stringify(expectedByDifficulty)}, got ${JSON.stringify(actualByDifficulty)}) — ` +
        `likely due to topic guarantees and/or a same-subject difficulty shortfall.`
    );
  }

  return { expectedByDifficulty, actualByDifficulty, difficultyMatches };
};

// ─── Step 9: generateTestId ──────────────────────────────────────────
// TEST_{year}_{sequence}, matching the spec's own example exactly
// (e.g. "TEST_2026_001"). Count-based sequencing per year as the
// common case, with a retry-on-conflict loop as the backstop under a
// race between two simultaneous generations — the same
// collision-avoidance shape as Blueprint's generateBlueprintId
// (Phase 5, blueprint.service.js).
export const generateTestId = async () => {
  const year = new Date().getFullYear();
  const prefix = `TEST_${year}_`;

  const existingCount = await GeneratedTest.countDocuments({
    test_id: { $regex: `^${prefix}` },
  });

  let seq = existingCount + 1;
  let candidate = `${prefix}${String(seq).padStart(3, '0')}`;

  // eslint-disable-next-line no-await-in-loop
  while (await GeneratedTest.exists({ test_id: candidate })) {
    seq += 1;
    candidate = `${prefix}${String(seq).padStart(3, '0')}`;
  }

  return candidate;
};

// ─── Step 9: persistTest ─────────────────────────────────────────────
export const persistTest = async (exam_id, blueprint_id, finalQuestions, params, adminId) => {
  const test_id = await generateTestId();

  const test = await GeneratedTest.create({
    test_id,
    exam_id,
    blueprint_id,
    question_count: finalQuestions.length,
    questions: finalQuestions.map((q) => ({
      mcq_id: q.mcq_id,
      subject: q.subject,
      // Snapshotted at generation time, same as `subject` — see
      // GeneratedTest.js's schema comment on why these must never be
      // re-derived from the (possibly later renamed/moved) MCQ.
      topic: q.topic || '',
      subtopic: q.subtopic || '',
      difficulty: q.difficulty,
    })),
    generation_params: params ?? {},
    status: 'completed',
    generated_by: adminId,
    generated_at: new Date(),
  });

  return test;
};

// ─── Step 10: updateExposureCounts ───────────────────────────────────
// Single bulk operation, not N individual updateOne calls — the same
// scaling discipline held throughout this system (Phase 4's duplicate
// detector, Phase 5's feasibility aggregation), even at a 100+
// question test.
export const updateExposureCounts = async (finalQuestions) => {
  if (!finalQuestions.length) {
    return null;
  }

  return MCQ.bulkWrite(
    finalQuestions.map((q) => ({
      updateOne: {
        filter: { question_id: q.mcq_id },
        update: { $inc: { used_count: 1 }, $set: { last_used_at: new Date() } },
      },
    }))
  );
};

// ─── generateTest — the full orchestrator (steps 1–10) ───────────────
// params shape: everything from the "Dynamic Test Generation Options"
// comment at the top of this file, PLUS:
//   exam_id: string (required)
//   blueprint_id: string | undefined (optional override, step 2)
//   adminId: string | undefined (who triggered generation)
export const generateTest = async (params) => {
  const exam = await loadExam(params.exam_id);
  const blueprint = await resolveBlueprint(params.exam_id, params.blueprint_id);

  // Phase 7 (Prompt 72/73, wiring fixed in Prompt 76): merge the
  // blueprint with whatever partial overrides came in on `params`
  // (already Zod-validated against generateWithOverridesSchema by the
  // controller, Prompt 76) into one working config IMMEDIATELY after
  // resolveBlueprint — every step from here on, including feasibility
  // validation below, reads from this working config, never the raw
  // blueprint. This is the one place the override system actually
  // plugs into the Phase 6 pipeline. `blueprint` itself is never
  // mutated (acceptOverrides's own contract) and is still passed
  // separately below wherever the raw blueprint_id is needed (e.g.
  // persistTest) — only the requirement-shaped fields (subjects,
  // difficulty_distribution, etc.) come from workingConfig now.
  const workingConfig = acceptOverrides(blueprint, params);

  // Feasibility is checked against the WORKING config, not the raw
  // blueprint — a blueprint that looks feasible on its own numbers can
  // still be infeasible once overrides narrow subjects, add a topics
  // filter, or bump question_count, and the reverse is just as true
  // (an override can also narrow a blueprint into something that IS
  // feasible even if the full blueprint wouldn't be). Checking the raw
  // blueprint here would validate a scenario generation isn't actually
  // about to run.
  await validateBlueprintFeasibility(workingConfig);

  // Steps 4–6: assemble the test in memory. Nothing is persisted yet,
  // and crucially no MCQ's used_count has been touched — a failure
  // anywhere in this block is a clean no-op from the DB's perspective,
  // so it's simply re-thrown. There's no test_id yet either (that's
  // only minted inside persistTest), so there is nothing meaningful to
  // record to GeneratedTest history for a failure at this stage — per
  // Prompt 61's model, a 'failed' record documents a failed attempt at
  // *persisting* a test, which is the try/catch below, not this one.
  let finalQuestions;
  const perSubjectResults = [];

  // ── "Topics to Include" guarantees, satisfied FIRST ────────────────
  // For any subject with topic_requirements, pull those exact per-topic
  // counts before touching difficulty math at all — a guarantee is
  // about the TOPIC, not which difficulty it lands at. Every other
  // subject (no topic_requirements — the normal case) passes through
  // with guaranteed = { questions: [], excludeIds: [] } and an
  // unchanged count, so nothing about existing behavior changes when
  // this feature isn't used.
  // PERF FIX: both per-subject loops below used to be sequential
  // (`for...of` + `await` inside the loop, one subject's DB round-trip
  // strictly after the previous one's). Each subject's guarantee-fetch
  // and pool-fetch is fully independent of every other subject's — the
  // only cross-subject step is `distributeSubjectDifficultyCounts`
  // between them, which is pure in-memory math, not a query — so there
  // was never a correctness reason for the sequencing. On a blueprint
  // with several subjects against a remote (e.g. Atlas) cluster, that
  // meant total wall-clock time was roughly (subject count) × (per-
  // subject query latency) instead of just one round-trip's worth done
  // in parallel — a likely contributor to /generator/generate running
  // long enough to trip the client's request timeout on larger tests.
  // Promise.all here keeps each subject's own DB calls sequential
  // relative to EACH OTHER (fetchTopicGuaranteedQuestions still runs
  // before fetchAndSamplePool for a given subject, same as before —
  // that dependency is untouched), it just runs different SUBJECTS
  // concurrently instead of queued one after another.
  const genPerfStart = Date.now();
  const guaranteedResults = await Promise.all(
    workingConfig.subjects.map((subject) => fetchTopicGuaranteedQuestions(subject, workingConfig))
  );
  logger.debug(`generateTest: topic-guarantee fetch took ${Date.now() - genPerfStart}ms`);

  const topicGuaranteedBySubject = new Map();
  // The joint difficulty split (below) must divide up only what's LEFT
  // after guarantees — passing a subject's full original count through
  // unchanged would ask fetchAndSamplePool's random fill for more
  // questions than actually remain to pick, overshooting that
  // subject's total.
  const subjectsForDifficultySplit = workingConfig.subjects.map((subject, i) => {
    const guaranteed = guaranteedResults[i];
    topicGuaranteedBySubject.set(subject.name, guaranteed);
    return { ...subject, count: subject.count - guaranteed.questions.length };
  });

  const jointDifficultyCounts = distributeSubjectDifficultyCounts(
    subjectsForDifficultySplit,
    workingConfig
  );

  const poolFetchStart = Date.now();
  const perSubjectResultsArr = await Promise.all(
    subjectsForDifficultySplit.map(async (subject) => {
      const counts = jointDifficultyCounts[subject.name];
      const guaranteed = topicGuaranteedBySubject.get(subject.name);
      const sampled = await fetchAndSamplePool(subject, counts, workingConfig, guaranteed.excludeIds);
      return {
        subjectName: subject.name,
        // Guaranteed picks first, random fill after — order here doesn't
        // matter for correctness (applyResultOrdering shuffles the WHOLE
        // test later when randomize is on), just keeps this subject's
        // own contribution readable if inspected mid-pipeline.
        questions: [...guaranteed.questions, ...sampled.questions],
        spares: sampled.spares,
      };
    })
  );
  logger.debug(`generateTest: pool fetch+sample took ${Date.now() - poolFetchStart}ms`);
  perSubjectResults.push(...perSubjectResultsArr);

  finalQuestions = mergeAndDeduplicate(perSubjectResults);
  finalQuestions = applyResultOrdering(finalQuestions, workingConfig);
  const difficultyCheck = verifyFinalCounts(finalQuestions, workingConfig);

  // Surfaced on the saved test (generation_params is Schema.Types.Mixed
  // — see GeneratedTest.js) so a deviation from the blueprint's exact
  // difficulty split is visible/auditable afterward rather than only
  // ever appearing in server logs. Only attached when something
  // actually happened — an ordinary generation with no topic
  // requirements and no shortfall keeps generation_params exactly as
  // it was before this feature existed.
  if (!difficultyCheck.difficultyMatches) {
    workingConfig.difficulty_deviation = {
      expected: difficultyCheck.expectedByDifficulty,
      actual: difficultyCheck.actualByDifficulty,
    };
  }
  const topicGuaranteeSummary = [...topicGuaranteedBySubject.entries()]
    .filter(([, g]) => g.questions.length > 0)
    .map(([subjectName, g]) => ({ subject: subjectName, guaranteed_count: g.questions.length }));
  if (topicGuaranteeSummary.length > 0) {
    workingConfig.topic_requirements_applied = topicGuaranteeSummary;
  }

  // TRANSACTION FOLLOW-UP: ideally persistTest + updateExposureCounts
  // below run inside a single Mongo transaction, so a crash between
  // them can never leave a saved, real test whose questions' exposure
  // counts weren't actually incremented. Transactions aren't already
  // configured in this project (standalone MongoDB, no replica set —
  // the same constraint blueprint.service.js's setActive, Prompt 55,
  // documented for its own deactivate-then-activate pair), so this is
  // the sequential best-effort version. Hardening into a proper
  // session-based transaction is a follow-up once the deployment
  // target supports it.
  let savedTest;
  const persistStart = Date.now();
  try {
    savedTest = await persistTest(
      exam.exam_id,
      blueprint.blueprint_id,
      finalQuestions,
      workingConfig,
      params.adminId
    );
    logger.debug(`generateTest: persistTest took ${Date.now() - persistStart}ms`);
  } catch (persistError) {
    // The assembled questions never made it into a real, saved test —
    // still write a 'failed' record (Prompt 61's model explicitly
    // supports a partial/non-completed record) so the attempt is
    // visible in GeneratedTest history rather than silently vanishing.
    try {
      await GeneratedTest.create({
        test_id: await generateTestId(),
        exam_id: exam.exam_id,
        blueprint_id: blueprint.blueprint_id,
        question_count: finalQuestions.length,
        questions: finalQuestions,
        generation_params: workingConfig ?? {},
        status: 'failed',
        generated_by: params.adminId,
        generated_at: new Date(),
      });
    } catch (failedRecordError) {
      // Writing the failure record itself failed too — swallow this
      // one deliberately so the ORIGINAL persistError (below) is what
      // propagates to the controller, not a confusing error-about-the-
      // error. Logged directly here (unlike the rest of this
      // service-layer file, which stays req/res-and-logger-free) since
      // this is the one path where an error would otherwise vanish
      // with no trace at all.
      // eslint-disable-next-line no-console
      console.error('generator.service: failed to write failed-generation record', failedRecordError);
    }
    throw persistError;
  }

  // Exposure counts are only ever incremented AFTER a real,
  // successfully-saved test exists — incrementing on a failed
  // generation would corrupt "least-used" sorting for future runs.
  const exposureStart = Date.now();
  await updateExposureCounts(finalQuestions);
  logger.debug(`generateTest: updateExposureCounts took ${Date.now() - exposureStart}ms`);
  logger.debug(`generateTest: TOTAL time before response ${Date.now() - genPerfStart}ms`);

  // ─── Phase 8 (Prompt 86): auto-trigger QA ────────────────────────
  // Per the spec, QA runs automatically at the end of a successful
  // generation. Deliberately NOT awaited — the test itself has already
  // been successfully saved and exposure-counted by this point, so
  // nothing about the caller's response depends on QA having finished.
  //
  // BUGFIX: this used to be `await`ed here, which meant the HTTP
  // response for POST /generator/generate didn't return until the full
  // QA pass (near-duplicate similarity scoring over every question
  // pair, per subject) had also finished. For a small test that's
  // invisible; for a large one (e.g. 200 questions) it can push total
  // request time past the client's request timeout (GeneratorForm.jsx
  // overrides Axios's default, but any fixed number is still just a
  // bigger version of the same problem as test size grows). The
  // client then aborts and reports a misleading "Network error — check
  // your connection", while this function keeps running server-side
  // and completes successfully a moment later — generation and QA
  // being tied together made a fully-successful save look like a
  // network failure. QA has no bearing on whether generation itself
  // succeeded, so it doesn't belong in the response's critical path.
  //
  // Still its own try/catch, same reasoning as before: a failure
  // inside the QA pipeline (e.g. a transient DB error while scoring
  // similarity) must never be mistaken for a failed generation. If
  // this fails, the test is simply left with GeneratedTest's default
  // `latest_qa_status: 'not_run'` (or whatever it already was), logged
  // clearly here since there's no caller left to see it thrown.
  runQAOnTest(savedTest.test_id).catch((qaError) => {
    logger.error(
      `Auto-QA failed to run for test ${savedTest.test_id} (generation itself succeeded):`,
      qaError
    );
  });

  return savedTest;
};

// ─── listGeneratedTests ──────────────────────────────────────────────
// Paginated/filterable history list — summary fields only, no MCQ
// resolution here (that's getGeneratedTestWithQuestions's job below),
// so the history page stays light even with 1000+ question tests on
// record. Sort/filter shape mirrors mcqService.findWithFilters for
// consistency with the rest of the codebase, and the exam_id +
// generated_at desc sort matches Prompt 61's compound index exactly.
//
// Prompt 88 additions (all optional, fully backward compatible with
// every existing caller):
// - filters.search: case-insensitive partial match against test_id —
//   powers QADashboard.jsx's searchable test picker. Deliberately just
//   test_id (not exam name, which lives on a separate Exam document
//   this service never joins against) — callers wanting exam-name
//   search filter client-side on top of this, same pattern
//   TestHistory.jsx already uses for its own exam_id → exam_name
//   lookup.
// - filters.qa_checked: 'true' restricts to tests whose
//   latest_qa_status (Prompt 85) is anything other than 'not_run' —
//   powers QADashboard.jsx's "Recent QA Activity" feed, which should
//   only ever show tests QA has actually touched.
// - pagination.sortBy: 'generated_at' (default, unchanged) or
//   'updated_at' — the latter lets that same activity feed surface the
//   most RECENTLY QA'd tests first, since a manual re-run bumps
//   updated_at (Mongoose's automatic timestamp) without changing
//   generated_at.
export const listGeneratedTests = async (filters = {}, pagination = {}) => {
  const query = {};
  if (filters.exam_id) query.exam_id = filters.exam_id;
  if (filters.status) query.status = filters.status;
  if (filters.search) {
    // Escape regex metacharacters so a literal search string (e.g.
    // "TEST_2026_(1)") can never be misinterpreted as a pattern.
    const escaped = filters.search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    query.test_id = { $regex: escaped, $options: 'i' };
  }
  if (filters.qa_checked === 'true') {
    query.latest_qa_status = { $ne: 'not_run' };
  } else if (filters.qa_checked === 'false') {
    query.latest_qa_status = 'not_run';
  }

  const { page = 1, limit = 20, sortBy = 'generated_at' } = pagination;
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: -1 };

  const [items, totalCount] = await Promise.all([
    GeneratedTest.find(query)
      .select('-questions') // summary only — question stubs excluded from the list view
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .lean(),
    GeneratedTest.countDocuments(query),
  ]);

  // Prompt 103: standardized { data, pagination } shape (was { items,
  // pagination: { total, ... } }) — see generator.controller.js's
  // listTests for the note on the resulting TestHistory.jsx break.
  return buildPaginatedResponse(items, totalCount, { page, limit });
};

// ─── getGeneratedTestWithQuestions ───────────────────────────────────
// Resolves a saved test's lightweight {mcq_id, subject, topic,
// subtopic, difficulty} stubs (Prompt 61's deliberate snapshot design,
// extended in the Prompt 21 regression fix to also freeze topic/
// subtopic) into full, ready-to-render question content — one batched
// $in query against MCQ, never N+1. A stub whose mcq_id no longer
// exists (e.g. the MCQ was deleted since generation) is still included
// in the response, flagged `question_unavailable: true`, rather than
// silently dropped — a past test's question count should stay visibly
// accountable even after content is later removed.
//
// `subject`/`topic`/`subtopic` always come from the STUB, never from
// the live MCQ document — a taxonomy rename/move/merge after this test
// was generated must not retroactively change what this test displays
// (see GeneratedTest.js's schema comment and taxonomy.service.js's own
// "GeneratedTest is deliberately NOT touched" comments). Only true
// question CONTENT (question text/options/correct_answer) is resolved
// live, since corrections to those SHOULD be reflected immediately.
export const getGeneratedTestWithQuestions = async (testId) => {
  const test = await GeneratedTest.findOne({ test_id: testId }).lean();
  if (!test) {
    throw new ApiError(404, `Test not found: ${testId}`);
  }

  const mcqIds = test.questions.map((q) => q.mcq_id);
  const fullMcqs = await MCQ.find({ question_id: { $in: mcqIds } })
    .select('question_id question options correct_answer')
    .lean();
  const mcqById = new Map(fullMcqs.map((m) => [m.question_id, m]));

  const questions = test.questions.map((stub) => {
    const full = mcqById.get(stub.mcq_id);
    if (!full) {
      return {
        mcq_id: stub.mcq_id,
        subject: stub.subject,
        topic: stub.topic || '',
        subtopic: stub.subtopic || '',
        difficulty: stub.difficulty,
        question_unavailable: true,
      };
    }
    return {
      mcq_id: stub.mcq_id,
      subject: stub.subject,
      topic: stub.topic || '',
      subtopic: stub.subtopic || '',
      difficulty: stub.difficulty,
      question: full.question,
      options: full.options,
      correct_answer: full.correct_answer,
    };
  });

  return { ...test, questions };
};

// ─── deleteGeneratedTest ──────────────────────────────────────────────
// Removes the GeneratedTest record only. Deliberately does NOT
// decrement used_count or clear last_used_at on the referenced MCQs —
// once a question has been exposed in a generated test, that exposure
// is a real historical fact regardless of whether the test record
// itself is later deleted. Reversing it here would let an admin
// "launder" a question back to the top of the least-used sort simply
// by deleting old tests, which would defeat the whole point of
// exposure tracking.
export const deleteGeneratedTest = async (testId) => {
  const test = await GeneratedTest.findOneAndDelete({ test_id: testId });
  if (!test) {
    throw new ApiError(404, `Test not found: ${testId}`);
  }
  return test;
};
