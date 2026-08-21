import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import * as examService from '../services/exam.service.js';
import { logger } from '../utils/logger.js';

// ─── Create ──────────────────────────────────────────────────────
export const createExam = asyncHandler(async (req, res) => {
  const exam = await examService.createExam(req.body);
  logger.info(`Exam created: ${exam.exam_id}`);

  return res
    .status(201)
    .json(new ApiResponse(201, { exam }, 'Exam created successfully'));
});

// ─── Get single ──────────────────────────────────────────────────
export const getExam = asyncHandler(async (req, res) => {
  const exam = await examService.findByExamId(req.params.examId); // throws 404 upstream if not found

  return res
    .status(200)
    .json(new ApiResponse(200, { exam }, 'Exam fetched successfully'));
});

// ─── Update ──────────────────────────────────────────────────────
export const updateExam = asyncHandler(async (req, res) => {
  const exam = await examService.updateExam(req.params.examId, req.body);
  logger.info(`Exam updated: ${exam.exam_id}`);

  return res
    .status(200)
    .json(new ApiResponse(200, { exam }, 'Exam updated successfully'));
});

// ─── Delete ──────────────────────────────────────────────────────
export const deleteExam = asyncHandler(async (req, res) => {
  const exam = await examService.deleteExam(req.params.examId);
  logger.info(`Exam deleted: ${exam.exam_id}`);

  return res
    .status(200)
    .json(new ApiResponse(200, null, 'Exam deleted successfully'));
});

// ─── Toggle status ─────────────────────────────────────────────────
export const toggleStatus = asyncHandler(async (req, res) => {
  const exam = await examService.toggleStatus(req.params.examId);
  logger.info(`Exam ${exam.exam_id} status toggled to ${exam.status}`);

  return res
    .status(200)
    .json(new ApiResponse(200, { exam }, `Exam status set to ${exam.status}`));
});

// ─── List, grouped by organization ─────────────────────────────────
export const listByOrg = asyncHandler(async (req, res) => {
  const grouped = await examService.listGroupedByOrg(req.query.status);

  return res
    .status(200)
    .json(new ApiResponse(200, grouped, 'Exams fetched successfully'));
});
