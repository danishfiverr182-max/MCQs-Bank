import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import * as generatorService from '../services/generator.service.js';
import { logger } from '../utils/logger.js';
import { parsePagination } from '../utils/pagination.js';

// ─── Generate ────────────────────────────────────────────────────────
// Phase 7 (Prompt 76): the route now validates the request body
// against the full generateWithOverridesSchema (Prompt 71, in
// generation.validator.js) instead of Phase 6's minimal
// generateTestSchema, so every override field (question_count,
// subjects, topics, difficulty, quality_threshold,
// exclude_recent_tests, randomize, past_paper_priority, custom_rules)
// arrives validated on req.body alongside exam_id/blueprint_id.
//
// The whole validated body (minus exam_id/blueprint_id, which are
// destructured out) is passed straight through as `...overrides` —
// generator.service.generateTest's `params` object doubles as both
// the exam/blueprint locator and the raw overrides object fed into
// acceptOverrides (Prompt 72) inside the service. acceptOverrides only
// ever reads the specific override field names it knows about, so the
// extra non-override keys on `params` (exam_id, blueprint_id,
// adminId) are harmless.
//
// The 422 "infeasible blueprint" error from generator.service.js's
// validateBlueprintFeasibility already carries the full feasibility
// report as ApiError's `errors` argument — errorHandler.js forwards
// `err.errors` straight into the JSON error response body for every
// ApiError, so no special-casing is needed here: letting asyncHandler
// pass the thrown error to next() is enough for the frontend's
// GenerationProgress.jsx (Prompt 68) to read
// `response.data.errors.report` and show exactly which
// subjects/difficulties are short.
export const generateTest = asyncHandler(async (req, res) => {
  const { exam_id, blueprint_id, ...overrides } = req.body;

  const test = await generatorService.generateTest({
    exam_id,
    blueprint_id,
    ...overrides,
    adminId: req.user?.userId,
  });

  logger.info(`Test generated: ${test.test_id} (${test.question_count} questions)`);

  return res.status(201).json(new ApiResponse(201, { test }, 'Test generated successfully'));
});

// ─── Check feasibility (Phase 7, Prompt 76) ────────────────────────────
// Pre-flight sibling of generateTest — same body shape
// ({ exam_id, blueprint_id?, ...overrides }), same exam/blueprint
// resolution (loadExam / resolveBlueprint, reused as-is from Phase 6
// so an inactive exam or missing blueprint fails identically here as
// it would for real generation), but nothing is ever assembled,
// persisted, or exposure-counted — it only reports whether the working
// config implied by these overrides currently has enough approved
// MCQs, at subject+difficulty bucket granularity. Powers
// InsufficientWarning.jsx's pre-Generate check on the frontend.
//
// Always responds 200, even when `report.feasible` is false — an
// "insufficient MCQs" result IS the correct answer to what this
// endpoint was asked, not a failure of the endpoint itself. This is
// deliberately different from generateTest, where an infeasible
// blueprint means an actual generation attempt failed (422).
export const checkFeasibility = asyncHandler(async (req, res) => {
  const { exam_id, blueprint_id, ...overrides } = req.body;

  const exam = await generatorService.loadExam(exam_id);
  const blueprint = await generatorService.resolveBlueprint(exam.exam_id, blueprint_id);

  const report = await generatorService.checkOverrideFeasibility(blueprint, overrides);

  return res.status(200).json(new ApiResponse(200, { report }, 'Feasibility check complete'));
});

// ─── Get by id (full question content resolved live) ─────────────────
export const getTestById = asyncHandler(async (req, res) => {
  const test = await generatorService.getGeneratedTestWithQuestions(req.params.testId);

  return res.status(200).json(new ApiResponse(200, { test }, 'Test fetched successfully'));
});

// ─── List (summary only, paginated/filterable) ────────────────────────
export const listTests = asyncHandler(async (req, res) => {
  const { exam_id, status, search, qa_checked, sortBy } = req.query;

  // listTestsQuerySchema (zod) already clamps page/limit; parsePagination
  // (Prompt 103) is applied again here so every list endpoint goes
  // through the same shared helper, matching mcq.controller.js.
  const { page, limit } = parsePagination(req.query);

  const result = await generatorService.listGeneratedTests(
    { exam_id, status, search, qa_checked },
    { page, limit, sortBy }
  );

  // Prompt 103: result is now { data, pagination: { page, limit,
  // totalCount, totalPages, hasNextPage, hasPrevPage } } (was { items,
  // pagination: { total, ... } }). TestHistory.jsx still reads
  // `data.items` / `data.pagination.total` and WILL break until updated
  // — deferred per Prompt 103's DoD, same as the MCQ list endpoint.
  return res.status(200).json(new ApiResponse(200, result, 'Tests fetched successfully'));
});

// ─── Delete ─────────────────────────────────────────────────────────
export const deleteTest = asyncHandler(async (req, res) => {
  const test = await generatorService.deleteGeneratedTest(req.params.testId);
  logger.info(`Test deleted: ${test.test_id}`);

  return res.status(200).json(new ApiResponse(200, null, 'Test deleted successfully'));
});
