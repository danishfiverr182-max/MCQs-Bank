import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import Exam from '../models/Exam.js';
import * as blueprintService from '../services/blueprint.service.js';
import { logger } from '../utils/logger.js';

// ─── Create ──────────────────────────────────────────────────────
export const createBlueprint = asyncHandler(async (req, res) => {
  // A blueprint must never point at a nonexistent exam — checked here
  // (controller) rather than the service, since this is an HTTP-layer
  // concern about a client-supplied foreign key, not blueprint business logic.
  const exam = await Exam.findOne({ exam_id: req.body.exam_id });
  if (!exam) {
    throw new ApiError(404, 'Exam not found');
  }

  const blueprint = await blueprintService.createBlueprint({
    ...req.body,
    created_by: req.user?.userId,
  });
  logger.info(`Blueprint created: ${blueprint.blueprint_id} (exam: ${blueprint.exam_id})`);

  return res
    .status(201)
    .json(new ApiResponse(201, { blueprint }, 'Blueprint created successfully'));
});

// ─── Update ──────────────────────────────────────────────────────
export const updateBlueprint = asyncHandler(async (req, res) => {
  const blueprint = await blueprintService.updateBlueprint(req.params.blueprintId, req.body);
  logger.info(`Blueprint updated: ${blueprint.blueprint_id}`);

  return res
    .status(200)
    .json(new ApiResponse(200, { blueprint }, 'Blueprint updated successfully'));
});

// ─── Delete ──────────────────────────────────────────────────────
export const deleteBlueprint = asyncHandler(async (req, res) => {
  const blueprint = await blueprintService.deleteBlueprint(req.params.blueprintId);
  logger.info(`Blueprint deleted: ${blueprint.blueprint_id}`);

  return res
    .status(200)
    .json(new ApiResponse(200, null, 'Blueprint deleted successfully'));
});

// ─── Clone ───────────────────────────────────────────────────────
export const cloneBlueprintHandler = asyncHandler(async (req, res) => {
  const clone = await blueprintService.cloneBlueprint(req.params.blueprintId, req.body.overrides);
  logger.info(`Blueprint cloned: ${req.params.blueprintId} -> ${clone.blueprint_id}`);

  return res
    .status(201)
    .json(new ApiResponse(201, { blueprint: clone }, 'Blueprint cloned successfully'));
});

// ─── Set active ────────────────────────────────────────────────────
export const setActive = asyncHandler(async (req, res) => {
  const blueprint = await blueprintService.setActive(req.params.blueprintId);
  logger.info(`Blueprint activated: ${blueprint.blueprint_id} (exam: ${blueprint.exam_id})`);

  return res
    .status(200)
    .json(new ApiResponse(200, { blueprint }, 'Blueprint activated successfully'));
});

// ─── Standalone validate (no persistence) ───────────────────────────
// Accepts a full OR partial blueprint payload — this is what
// BlueprintBuilder.jsx's live feasibility check calls as the admin
// edits, before ever hitting "Save". Never writes to the database.
export const validateBlueprint = asyncHandler(async (req, res) => {
  const payload = req.body || {};

  const distribution = blueprintService.validateDistribution({
    subjects: payload.subjects,
    difficulty_distribution: payload.difficulty_distribution,
    total_questions: payload.total_questions,
  });

  // Feasibility needs at least a subject list and a difficulty
  // distribution to mean anything — with a genuinely partial payload
  // (e.g. only total_questions typed so far), skip it rather than
  // reporting a misleading all-zero feasibility result.
  const canCheckFeasibility =
    Array.isArray(payload.subjects) &&
    payload.subjects.length > 0 &&
    payload.difficulty_distribution &&
    typeof payload.difficulty_distribution === 'object';

  const feasibility = canCheckFeasibility
    ? await blueprintService.checkMCQAvailability({
        subjects: payload.subjects,
        difficulty_distribution: payload.difficulty_distribution,
      })
    : null;

  return res
    .status(200)
    .json(new ApiResponse(200, { distribution, feasibility }, 'Blueprint validation complete'));
});

// ─── List by exam ────────────────────────────────────────────────
export const getBlueprintsByExam = asyncHandler(async (req, res) => {
  const blueprints = await blueprintService.listByExam(req.params.examId);

  return res
    .status(200)
    .json(new ApiResponse(200, { blueprints }, 'Blueprints fetched successfully'));
});

// ─── Get single (with embedded live feasibility) ────────────────────
export const getBlueprint = asyncHandler(async (req, res) => {
  const blueprint = await blueprintService.findByBlueprintId(req.params.blueprintId); // throws 404 upstream if not found
  const feasibility = await blueprintService.checkMCQAvailability(blueprint);

  return res
    .status(200)
    .json(new ApiResponse(200, { blueprint, feasibility }, 'Blueprint fetched successfully'));
});
