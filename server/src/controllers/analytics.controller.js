import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import * as analyticsService from '../services/analytics.service.js';
import * as activityLogService from '../services/activityLog.service.js';

// analytics.controller.js — Prompt 95. Thin HTTP layer over
// analytics.service.js (Prompts 93/94) — no aggregation logic lives
// here, only request/response shaping, same "controllers must go
// through the service layer" convention every other controller in this
// system already follows.

// ─── Overview ────────────────────────────────────────────────────────
// GET /api/analytics/overview
export const getOverview = asyncHandler(async (req, res) => {
  const stats = await analyticsService.overallStats();

  return res.status(200).json(new ApiResponse(200, stats, 'Overview stats fetched'));
});

// ─── Subject distribution (+ optional coverage) ───────────────────────
// GET /api/analytics/subjects?blueprintId=
// Without blueprintId: raw approved-MCQ counts per subject.
// With blueprintId: the same counts, with required/available/
// coveragePercent merged in wherever a subject is part of that
// blueprint. Merged on the UNION of both subject sets rather than just
// bySubject's — a blueprint can require a subject that currently has
// ZERO approved MCQs, and that's exactly the case this endpoint most
// needs to surface, not one to silently drop because mcqsBySubject's
// $group never produced a row for it.
export const getSubjectStats = asyncHandler(async (req, res) => {
  const { blueprintId } = req.query;

  const bySubject = await analyticsService.mcqsBySubject();

  if (!blueprintId) {
    return res
      .status(200)
      .json(new ApiResponse(200, { subjects: bySubject }, 'Subject distribution fetched'));
  }

  const coverage = await analyticsService.subjectCoveragePercent(blueprintId); // throws 404 upstream if blueprint doesn't exist
  const coverageByName = new Map(coverage.map((c) => [c.subject, c]));

  const subjectNames = new Set([...bySubject.map((s) => s.subject), ...coverageByName.keys()]);

  const subjects = [...subjectNames]
    .map((subject) => {
      const base = bySubject.find((s) => s.subject === subject);
      const cov = coverageByName.get(subject);

      return {
        subject,
        count: base?.count ?? cov?.available ?? 0,
        ...(cov && {
          required: cov.required,
          available: cov.available,
          coveragePercent: cov.coveragePercent,
        }),
      };
    })
    .sort((a, b) => b.count - a.count);

  return res
    .status(200)
    .json(new ApiResponse(200, { subjects }, 'Subject distribution with coverage fetched'));
});

// ─── Difficulty distribution ────────────────────────────────────────
// GET /api/analytics/difficulty
export const getDifficultyStats = asyncHandler(async (req, res) => {
  const difficulty = await analyticsService.mcqsByDifficulty();

  return res
    .status(200)
    .json(new ApiResponse(200, { difficulty }, 'Difficulty distribution fetched'));
});

// ─── MCQ exposure ────────────────────────────────────────────────────
// GET /api/analytics/exposure?type=top|least|never&limit=20
// `type` omitted -> all three lists in one payload (one round trip for
// the dashboard's exposure table), each using the same `limit`.
const EXPOSURE_FETCHERS = {
  top: analyticsService.topUsedMCQs,
  least: analyticsService.leastUsedMCQs,
  never: analyticsService.neverUsedMCQs,
};
const EXPOSURE_KEYS = { top: 'topUsed', least: 'leastUsed', never: 'neverUsed' };

export const getMCQExposure = asyncHandler(async (req, res) => {
  const { type, limit } = req.query; // already coerced/defaulted to 20 by validate.middleware.js

  if (!type) {
    const [topUsed, leastUsed, neverUsed] = await Promise.all([
      analyticsService.topUsedMCQs(limit),
      analyticsService.leastUsedMCQs(limit),
      analyticsService.neverUsedMCQs(limit),
    ]);

    return res
      .status(200)
      .json(new ApiResponse(200, { topUsed, leastUsed, neverUsed }, 'MCQ exposure fetched'));
  }

  const results = await EXPOSURE_FETCHERS[type](limit);

  return res
    .status(200)
    .json(new ApiResponse(200, { [EXPOSURE_KEYS[type]]: results }, 'MCQ exposure fetched'));
});

// ─── Generation history ──────────────────────────────────────────────
// GET /api/analytics/generation-history?months=12&examId=
export const getGenerationHistory = asyncHandler(async (req, res) => {
  const { months, examId } = req.query;

  const result = await analyticsService.testsPerExamPerMonth({
    months,
    examId: examId || null,
  });

  return res.status(200).json(new ApiResponse(200, result, 'Generation history fetched'));
});

// ─── Quick trends (overview + short generation window) ──────────────
// GET /api/analytics/trends
// Deliberately its own endpoint rather than asking callers to compose
// /overview + /generation-history themselves — a lightweight
// "quick trends" widget (e.g. a future home dashboard) gets both in one
// round trip, distinct from the full AnalyticsDashboard page which
// calls the dedicated endpoints separately at their own granularity.
export const getTrends = asyncHandler(async (req, res) => {
  const [overview, generationTrend] = await Promise.all([
    analyticsService.overallStats(),
    analyticsService.testsPerExamPerMonth({ months: 6 }),
  ]);

  return res
    .status(200)
    .json(new ApiResponse(200, { overview, generationTrend }, 'Quick trends fetched'));
});

// ─── Activity logs (global, paginated, filterable) ────────────────────
// GET /api/analytics/activity-logs?page=&limit=&action=&entityType=&actorId=&from=&to=
// Prompt 100. Phase 9's backend prompts (91-96) only ever built
// getRecentLogsForEntity (one entity's history tab) — this is the
// general "list all logs" read the standalone Activity Log page needs,
// added here alongside the rest of analytics.controller.js since it's
// the same "admin-facing read over cross-cutting system data" shape as
// every other endpoint in this file.
export const getActivityLogs = asyncHandler(async (req, res) => {
  const { page, limit, action, entityType, actorId, from, to } = req.query;

  const result = await activityLogService.getPaginatedLogs({
    page,
    limit,
    action,
    entityType,
    actorId,
    from,
    to,
  });

  return res.status(200).json(new ApiResponse(200, result, 'Activity logs fetched'));
});
