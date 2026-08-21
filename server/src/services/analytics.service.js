// analytics.service.js
//
// Part 1 (Prompt 93): distribution/coverage aggregations over the MCQ
// collection — mcqsBySubject, mcqsByDifficulty, subjectCoveragePercent,
// overallStats.
// Part 2 (Prompt 94): generation trends + per-MCQ exposure, reading the
// GeneratedTest collection (and, for exposure, the used_count/
// last_used_at counters GeneratedTest generation already maintains on
// MCQ — see the "Exposure" section below for why this deliberately does
// NOT re-derive usage via $unwind over GeneratedTest.questions).
//
// Every exported function logs its own execution time via logger.debug
// so slow aggregations are visible in dev without needing a profiler.

import MCQ from '../models/MCQ.js';
import Exam from '../models/Exam.js';
import Blueprint from '../models/Blueprint.js';
import GeneratedTest from '../models/GeneratedTest.js';
import * as blueprintService from './blueprint.service.js';
import { logger } from '../utils/logger.js';

// ─────────────────────────────────────────────────────────────────────
// Part 1 — MCQ distribution & coverage (Prompt 93)
// ─────────────────────────────────────────────────────────────────────

// ─── mcqsBySubject ──────────────────────────────────────────────────
// Approved-only counts per subject, highest first. Matching on `status`
// before grouping lets Mongo use the `{status:1, subject:1}` compound
// index added to MCQ.js in this same prompt, rather than a collection
// scan — same discipline as blueprint.service.js's checkMCQAvailability,
// which this file's subjectCoveragePercent below reuses directly.
export const mcqsBySubject = async () => {
  const start = Date.now();

  const rows = await MCQ.aggregate([
    { $match: { status: 'approved' } },
    { $group: { _id: '$subject', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
    { $project: { _id: 0, subject: '$_id', count: 1 } },
  ]);

  logger.debug(`analytics.mcqsBySubject took ${Date.now() - start}ms`);
  return rows;
};

// ─── mcqsByDifficulty ───────────────────────────────────────────────
// Always returns exactly 3 entries (easy/medium/hard), even if one has
// zero approved questions — a left-join against a static array so the
// frontend pie chart never has to special-case a missing slice.
export const mcqsByDifficulty = async () => {
  const start = Date.now();

  const rows = await MCQ.aggregate([
    { $match: { status: 'approved' } },
    { $group: { _id: '$difficulty', count: { $sum: 1 } } },
  ]);

  const countByDifficulty = new Map(rows.map((r) => [r._id, r.count]));

  const result = ['easy', 'medium', 'hard'].map((difficulty) => ({
    difficulty,
    count: countByDifficulty.get(difficulty) ?? 0,
  }));

  logger.debug(`analytics.mcqsByDifficulty took ${Date.now() - start}ms`);
  return result;
};

// ─── subjectCoveragePercent ─────────────────────────────────────────
// "If I generate this blueprint right now, do I actually have enough
// approved questions per subject?" — deliberately built as a thin
// wrapper around blueprint.service.js's checkMCQAvailability rather
// than a second copy of the same per-subject aggregation.
// generator.service.js's own validateBlueprintFeasibility already
// makes this same call ("Thin wrapper... deliberately not
// reimplemented here, so the generator and FeasibilityReport.jsx can
// never disagree about what 'feasible' means") — this function extends
// that same guarantee to the analytics dashboard: the coverage number
// shown here can never drift from what generation itself would see.
//
// Note this intentionally does NOT further scope by the blueprint's
// exam via MCQ.exam_tags. checkMCQAvailability itself only matches on
// {subject, status}, not exam_tags — mirroring that exactly here (rather
// than adding a stricter filter of our own) keeps this number consistent
// with the actual feasibility check a real generation run performs.
export const subjectCoveragePercent = async (blueprintId) => {
  const start = Date.now();

  const blueprint = await blueprintService.findByBlueprintId(blueprintId); // throws 404 upstream if not found
  const { subjects } = await blueprintService.checkMCQAvailability(blueprint);

  const result = subjects.map(({ name, required, available }) => ({
    subject: name,
    required,
    available,
    coveragePercent:
      required > 0 ? Math.min(100, Math.round((available / required) * 100)) : 100,
  }));

  logger.debug(`analytics.subjectCoveragePercent(${blueprintId}) took ${Date.now() - start}ms`);
  return result;
};

// ─── overallStats ───────────────────────────────────────────────────
// Promise.all of independent cheap counts rather than one giant
// aggregation — each count/distinct hits its own index and they run
// concurrently, so total latency is roughly the slowest single count,
// not the sum of all of them.
export const overallStats = async () => {
  const start = Date.now();

  const [
    totalMCQs,
    approvedMCQs,
    pendingMCQs,
    rejectedMCQs,
    subjects,
    totalExams,
    totalBlueprints,
    totalTestsGenerated,
  ] = await Promise.all([
    MCQ.countDocuments({}),
    MCQ.countDocuments({ status: 'approved' }),
    MCQ.countDocuments({ status: 'pending' }),
    MCQ.countDocuments({ status: 'rejected' }),
    MCQ.distinct('subject'),
    Exam.countDocuments({}),
    Blueprint.countDocuments({}),
    // 'completed' only — a 'failed' GeneratedTest record documents a
    // failed generation attempt (Phase 6 convention, see
    // generator.service.js), not an actual test, so it shouldn't count
    // toward "tests generated" here.
    GeneratedTest.countDocuments({ status: 'completed' }),
  ]);

  logger.debug(`analytics.overallStats took ${Date.now() - start}ms`);

  return {
    totalMCQs,
    approvedMCQs,
    pendingMCQs,
    rejectedMCQs,
    totalSubjects: subjects.length,
    totalExams,
    totalBlueprints,
    totalTestsGenerated,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Part 2 — Generation trends & MCQ exposure (Prompt 94)
// ─────────────────────────────────────────────────────────────────────

// ─── monthKey / month window helpers ────────────────────────────────
// UTC-based so the trailing window and bucketing agree with $year/$month
// (which operate in UTC by default) regardless of server timezone.
const monthKey = (year, month) => `${year}-${String(month).padStart(2, '0')}`;

const trailingMonthKeys = (months, now = new Date()) => {
  const keys = [];
  for (let i = 0; i < months; i += 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1) + i, 1));
    keys.push(monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  return keys;
};

// ─── testsPerExamPerMonth ───────────────────────────────────────────
// Generation activity over the trailing `months` (default 12), both as
// a per-exam breakdown (for a future stacked/multi-line view) and a
// totalsByMonth rollup (for the simple single-line trend chart).
// totalsByMonth is zero-filled for every month in the window so the
// line chart never shows a gap that could be misread as "no data" rather
// than "zero tests generated" — the per-exam breakdown is left sparse
// (only months/exams that actually have rows), which is normal for a
// stacked chart's per-series data.
//
// exam_id is matched as a plain string, NOT cast via
// mongoose.Types.ObjectId — GeneratedTest.exam_id is a string business
// id (same "string ref, not ObjectId ref" convention as
// blueprint_id/exam_id everywhere else in this system; see
// GeneratedTest.js), so an ObjectId cast here would simply never match.
export const testsPerExamPerMonth = async ({ months = 12, examId = null } = {}) => {
  const start = Date.now();
  const now = new Date();

  const windowStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)
  );

  const match = {
    status: 'completed', // same reasoning as overallStats — a 'failed' attempt isn't a generated test
    generated_at: { $gte: windowStart },
  };
  if (examId) match.exam_id = examId;

  const rows = await GeneratedTest.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          year: { $year: '$generated_at' },
          month: { $month: '$generated_at' },
          exam_id: '$exam_id',
        },
        count: { $sum: 1 },
      },
    },
    { $sort: { '_id.year': 1, '_id.month': 1 } },
  ]);

  // Resolve exam_id -> exam_name in a single query rather than per row.
  const examIds = [...new Set(rows.map((r) => r._id.exam_id))];
  const exams = await Exam.find({ exam_id: { $in: examIds } })
    .select('exam_id exam_name')
    .lean();
  const examNameById = new Map(exams.map((e) => [e.exam_id, e.exam_name]));

  const windowKeys = trailingMonthKeys(months, now);
  const totalsMap = new Map(windowKeys.map((key) => [key, 0]));

  const byExam = rows.map((row) => {
    const key = monthKey(row._id.year, row._id.month);
    totalsMap.set(key, (totalsMap.get(key) ?? 0) + row.count);

    return {
      month: key,
      examId: row._id.exam_id,
      exam: examNameById.get(row._id.exam_id) ?? row._id.exam_id,
      count: row.count,
    };
  });

  const totalsByMonth = windowKeys.map((month) => ({ month, count: totalsMap.get(month) ?? 0 }));

  logger.debug(`analytics.testsPerExamPerMonth took ${Date.now() - start}ms`);
  return { byExam, totalsByMonth };
};

// ─── MCQ exposure (topUsedMCQs / leastUsedMCQs / neverUsedMCQs) ─────
//
// The spec for this prompt describes deriving usage by $unwind +
// $group over GeneratedTest.questions, with a note that at Test-volume
// scale this should eventually move to "a maintained usageCount counter
// field on the MCQ document, updated incrementally at generation time"
// as a future optimization.
//
// That counter already exists: MCQ.used_count (and MCQ.last_used_at),
// added in Phase 6 (Prompt 63) specifically to drive fair question
// selection, and incremented via a single MCQ.bulkWrite by
// generator.service.js's updateExposureCounts immediately after every
// successful generation (never on a 'failed' attempt, and deliberately
// never decremented on test deletion — see that file's comment on
// deleteGeneratedTest: exposure is a historical fact, not something an
// admin can "launder" away by deleting old tests). That is exactly the
// already-built version of the optimization this prompt anticipates, so
// exposure here reads used_count directly instead of re-deriving it via
// $unwind/$group over GeneratedTest — simpler, and O(sorted-index scan)
// rather than O(total questions referenced across all tests) regardless
// of how large the Test collection grows.
const toExposureEntry = (doc) => ({
  usageCount: doc.used_count,
  mcq: {
    // Prompt 99: MCQExposure.jsx's "Edit MCQ" action links to the
    // existing /admin/mcqs/:id/edit route, which resolves by Mongo _id
    // (see mcq.controller.js's getMcqById -> mcqService.findById), not
    // question_id. `.lean()` already returns _id on every doc regardless
    // of the inclusion-mode `.select()` list below, so this just carries
    // it through into the mapped entry rather than requiring a second
    // query.
    id: doc._id?.toString(),
    question_id: doc.question_id,
    question: doc.question,
    subject: doc.subject,
    difficulty: doc.difficulty,
  },
});

const EXPOSURE_SELECT = 'question_id question subject difficulty used_count';

// ─── topUsedMCQs ─────────────────────────────────────────────────────
export const topUsedMCQs = async (limit = 20) => {
  const start = Date.now();

  const docs = await MCQ.find({ status: 'approved', used_count: { $gt: 0 } })
    .sort({ used_count: -1, last_used_at: -1 })
    .limit(limit)
    .select(EXPOSURE_SELECT)
    .lean();

  logger.debug(`analytics.topUsedMCQs took ${Date.now() - start}ms`);
  return docs.map(toExposureEntry);
};

// ─── leastUsedMCQs ───────────────────────────────────────────────────
// "Lowest nonzero usage" per the DoD — questions that have been used at
// least once but rarely, as distinct from never-used (that's
// neverUsedMCQs below, which is a different signal: "not yet in
// rotation at all" vs "in rotation but rarely drawn").
export const leastUsedMCQs = async (limit = 20) => {
  const start = Date.now();

  const docs = await MCQ.find({ status: 'approved', used_count: { $gt: 0 } })
    .sort({ used_count: 1, last_used_at: 1 })
    .limit(limit)
    .select(EXPOSURE_SELECT)
    .lean();

  logger.debug(`analytics.leastUsedMCQs took ${Date.now() - start}ms`);
  return docs.map(toExposureEntry);
};

// ─── neverUsedMCQs ───────────────────────────────────────────────────
// Approved questions with used_count === 0 — i.e. never included in any
// successfully generated test. A single indexed equality query against
// MCQ.used_count's own index (added in Phase 6), oldest-created first so
// the questions that have been sitting unused longest surface first.
export const neverUsedMCQs = async (limit = 50) => {
  const start = Date.now();

  const docs = await MCQ.find({ status: 'approved', used_count: 0 })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select(EXPOSURE_SELECT)
    .lean();

  logger.debug(`analytics.neverUsedMCQs took ${Date.now() - start}ms`);
  return docs.map(toExposureEntry);
};
