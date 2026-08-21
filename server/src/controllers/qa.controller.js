import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import GeneratedTest from '../models/GeneratedTest.js';
import QAReport from '../models/QAReport.js';
import * as qaService from '../services/qa.service.js';
import { findSimilarInDatabase } from '../services/similarity.service.js';
import { logger } from '../utils/logger.js';
import { createLog } from '../services/activityLog.service.js';

// qa.controller.js — Phase 8, Prompt 86. Thin HTTP layer over
// qa.service.js / similarity.service.js — no QA logic lives here, only
// request/response shaping and the one cross-model check
// (approveWithQA) that genuinely belongs at this layer since it
// coordinates two models (QAReport + GeneratedTest) around a single
// HTTP action rather than being a reusable piece of QA business logic.

// ─── Manual QA trigger ──────────────────────────────────────────────
// POST /:testId/run — the spec's "can also be triggered manually on
// any saved test" path. Identical underlying call to the auto-trigger
// wired into generator.service.js's generateTest orchestrator
// (Prompt 86); this route just exposes it directly over HTTP.
export const runQA = asyncHandler(async (req, res) => {
  const report = await qaService.runQAOnTest(req.params.testId);
  logger.info(`QA run (manual): ${report.report_id} for test ${report.test_id} — passed=${report.passed}`);

  // Prompt 92: "run" isn't a plain REST verb the fallback table can guess
  // — set it explicitly, and note pass/fail in the summary.
  req.logContext.action = 'qa_run';
  req.logContext.summary = `QA run on test ${report.test_id} — ${report.passed ? 'passed' : 'failed'} (report ${report.report_id})`;

  return res.status(200).json(new ApiResponse(200, { report }, 'QA run completed'));
});

// ─── Latest report ──────────────────────────────────────────────────
// GET /:testId/latest — the { test_id, generated_at: -1 } index
// (Prompt 81) makes this a cheap single-document lookup. 404 with a
// specific, distinguishable message when QA genuinely hasn't been run
// yet — QABadge.jsx (Prompt 87) needs to tell "not run" apart from
// "test itself doesn't exist" cleanly, so this deliberately does NOT
// reuse a generic "not found" string.
export const getReport = asyncHandler(async (req, res) => {
  const report = await QAReport.findOne({ test_id: req.params.testId }).sort({ generated_at: -1 });

  if (!report) {
    throw new ApiError(404, 'QA has not been run on this test yet');
  }

  return res.status(200).json(new ApiResponse(200, { report }, 'Latest QA report retrieved'));
});

// ─── Report history ─────────────────────────────────────────────────
// GET /:testId/history — every past report for a test, newest first,
// e.g. an original auto-triggered run followed by one or more manual
// re-runs after an admin fixes a flagged issue. An empty array (rather
// than a 404) is the correct response here — "no history yet" is a
// valid, non-error state for a list endpoint.
export const getReportHistory = asyncHandler(async (req, res) => {
  const reports = await QAReport.find({ test_id: req.params.testId }).sort({ generated_at: -1 });

  return res.status(200).json(new ApiResponse(200, { reports }, 'QA report history retrieved'));
});

// ─── Standalone similarity lookup ───────────────────────────────────
// GET /similar/:questionId?threshold=&limit= — thin wrapper, exposed
// independently of any specific test since the spec describes this as
// usable on-demand (e.g. from an MCQ management view), not only from
// within a test's QA flow. Query params are optional and left to
// similarity.service.js's own defaults (threshold 70, limit 20) when
// absent.
export const findSimilar = asyncHandler(async (req, res) => {
  const { threshold, limit } = req.query;

  const options = {};
  if (threshold !== undefined) options.threshold = Number(threshold);
  if (limit !== undefined) options.limit = Number(limit);

  const results = await findSimilarInDatabase(req.params.questionId, options);

  return res.status(200).json(new ApiResponse(200, { results }, 'Similar questions retrieved'));
});

// ─── Finalize (QA-gated) ────────────────────────────────────────────
// POST /:testId/finalize — the concrete mechanism behind the spec's
// "Failures block the test from being finalized" rule. Reads the
// LATEST report only (an old passing report doesn't count if a more
// recent re-run introduced a failure) and rejects with 409 plus the
// full report attached, so the frontend can show exactly what's
// blocking finalization without a second round-trip.
export const approveWithQA = asyncHandler(async (req, res) => {
  const { testId } = req.params;

  const report = await QAReport.findOne({ test_id: testId }).sort({ generated_at: -1 });

  if (!report || report.passed !== true) {
    // Prompt 92: this is a 409, so autoLogResponse's `statusCode < 400`
    // check would skip it — but "someone tried to finalize a test that
    // hasn't passed QA" is exactly the kind of thing an audit trail
    // should capture. Logged directly, then req.logContext.skip stops
    // the auto middleware from doing anything further once the response
    // (an error, via the thrown ApiError below) goes out.
    await createLog({
      actor: req.user,
      action: 'qa_finalize_blocked',
      entityType: 'Test',
      entityId: testId,
      summary: report
        ? `Finalize blocked for test ${testId} — latest QA report ${report.report_id} did not pass`
        : `Finalize blocked for test ${testId} — no QA report on record`,
      req,
    });
    req.logContext.skip = true;

    throw new ApiError(409, 'Cannot finalize a test that has not passed QA', { report: report || null });
  }

  const test = await GeneratedTest.findOneAndUpdate(
    { test_id: testId },
    { finalized: true, finalized_at: new Date() },
    { new: true }
  );

  if (!test) {
    throw new ApiError(404, `Test not found: ${testId}`);
  }

  logger.info(`Test finalized: ${test.test_id} (QA report: ${report.report_id})`);

  // Prompt 92: "finalize" isn't a plain REST verb the fallback table can
  // guess — set it explicitly rather than relying on the generic default.
  req.logContext.action = 'test_finalized';
  req.logContext.summary = `Finalized test ${test.test_id} (QA report: ${report.report_id})`;

  return res.status(200).json(new ApiResponse(200, { test }, 'Test finalized successfully'));
});

// ─── Dismiss a similar pair ("Keep Both") ───────────────────────────
// POST /pairs/dismiss — Prompt 90's SimilarityReview.jsx "Keep Both"
// action. Records that an admin has explicitly reviewed this exact
// pair of MCQs and judged them legitimately distinct, so
// qa.service.js's checkNearDuplicates stops re-flagging it as a
// warning on future QA runs of any test that draws both questions.
// Not scoped to a specific testId (a dismissal is a fact about the
// pair of questions, not about any one test), hence its own top-level
// route rather than living under /:testId.
export const dismissPair = asyncHandler(async (req, res) => {
  const { mcq_id_a: mcqIdA, mcq_id_b: mcqIdB } = req.body;

  if (!mcqIdA || !mcqIdB || mcqIdA === mcqIdB) {
    throw new ApiError(400, 'mcq_id_a and mcq_id_b are required and must be different');
  }

  const dismissal = await qaService.dismissPair(mcqIdA, mcqIdB, req.user?.userId);
  logger.info(`Similar pair dismissed: ${dismissal.pair_key} (by ${req.user?.userId})`);

  return res
    .status(200)
    .json(new ApiResponse(200, { dismissal }, 'Pair marked as reviewed and kept'));
});
