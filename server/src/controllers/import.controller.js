import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import { runImportPipeline, resolveDuplicateInserts, deleteImportBatch } from '../services/import.service.js';
import {
  getPromptState as getPromptStateService,
  updateSettings as updatePromptSettingsService,
  resetRange as resetPromptRangeService,
} from '../services/promptState.service.js';
import MCQ from '../models/MCQ.js';
import ImportBatch from '../models/importBatch.model.js';
import { logger } from '../utils/logger.js';

const VALID_MODES = ['insert', 'validate_only'];

// ─── Bulk import ────────────────────────────────────────────────
export const uploadBulk = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'No file uploaded');
  }

  const mode = req.body.mode || 'insert';
  if (!VALID_MODES.includes(mode)) {
    throw new ApiError(400, `mode must be one of: ${VALID_MODES.join(', ')}`);
  }

  const report = await runImportPipeline(
    req.file.buffer,
    { mode, filename: req.file.originalname, adminId: req.user.userId },
    MCQ,
    ImportBatch
  );

  logger.info(
    `Import ${report.batch_id}: total=${report.total} inserted=${report.inserted} ` +
      `failed=${report.failed.length} exact=${report.duplicates.exact.length} ` +
      `near=${report.duplicates.near.length} newSubtopics=${report.newSubtopics.length}`
  );

  return res.status(200).json(new ApiResponse(200, report, 'Import processed'));
});

// ─── Validate-only (dry run) ────────────────────────────────────
// Thin wrapper around the same pipeline as uploadBulk — forces
// mode: 'validate_only' regardless of what's in the body, so the
// frontend has a dedicated "dry run" endpoint without needing to
// remember to set a mode field.
export const validateOnly = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new ApiError(400, 'No file uploaded');
  }

  const report = await runImportPipeline(
    req.file.buffer,
    { mode: 'validate_only', filename: req.file.originalname, adminId: req.user.userId },
    MCQ,
    ImportBatch
  );

  logger.info(
    `Validate-only ${report.batch_id}: total=${report.total} failed=${report.failed.length} ` +
      `exact=${report.duplicates.exact.length} near=${report.duplicates.near.length}`
  );

  return res.status(200).json(new ApiResponse(200, report, 'Validation processed'));
});

// ─── Resolve duplicates ──────────────────────────────────────────
// Second-pass insert for whichever exact/near duplicate rows the admin
// marked "keep" while reviewing the report in DuplicateReview.jsx.
// Body: { batchId, keepDecisions: [{ row, action: 'keep', data }] }
export const resolveDuplicates = asyncHandler(async (req, res) => {
  const { batchId, keepDecisions } = req.body;

  if (!batchId || typeof batchId !== 'string') {
    throw new ApiError(400, 'batchId is required');
  }
  if (!Array.isArray(keepDecisions)) {
    throw new ApiError(400, 'keepDecisions must be an array');
  }

  const result = await resolveDuplicateInserts({ batchId, keepDecisions }, MCQ, ImportBatch);

  logger.info(
    `Resolved duplicates for ${result.batch_id}: inserted=${result.insertedCount} ` +
      `(batch total now ${result.totalInsertedCount})`
  );

  return res.status(200).json(new ApiResponse(200, result, 'Duplicates resolved'));
});

// ─── Delete a batch ─────────────────────────────────────────────
// Cascades to every MCQ that batch inserted (see deleteImportBatch's
// comment in import.service.js) — this is the cleanup tool for a
// failed, unwanted, or accidental import: it doesn't just hide the
// history row, it actually removes the MCQs so a corrected re-upload
// of the same file won't get spuriously flagged as all-duplicates.
export const deleteBatch = asyncHandler(async (req, res) => {
  const { batchId } = req.params;
  const result = await deleteImportBatch(batchId, MCQ, ImportBatch);

  logger.info(`Deleted import batch ${result.batch_id}: removed ${result.deletedMcqCount} MCQ(s)`);

  return res.status(200).json(new ApiResponse(200, result, 'Import batch deleted'));
});

// ─── MCQ Conversion Prompt state ──────────────────────────────────
// formatPromptState — shared shaping helper so all three handlers
// below return the identical camelCase envelope, regardless of
// whether the underlying service call already returns promptText
// (getPromptState) or just the raw updated doc (updateSettings/
// resetRange, which don't build promptText themselves).
const formatPromptState = (state) => ({
  subtopicBank: state.subtopic_bank,
  subtopicCount: state.subtopic_bank.length,
  rangeStart: state.range_start,
  rangeEnd: state.range_end,
  batchSize: state.batch_size,
  totalCap: state.total_cap,
  promptText: state.promptText,
});

export const getPromptState = asyncHandler(async (req, res) => {
  const state = await getPromptStateService();

  return res
    .status(200)
    .json(new ApiResponse(200, formatPromptState(state), 'Prompt state fetched successfully'));
});

export const updatePromptSettings = asyncHandler(async (req, res) => {
  const { batchSize, totalCap } = req.body;

  await updatePromptSettingsService({ batchSize, totalCap });
  // updateSettings returns the raw updated doc without a built
  // promptText — re-fetch via getPromptState so the response always
  // carries a fresh, consistent promptText reflecting the new
  // batchSize/totalCap.
  const state = await getPromptStateService();

  logger.info(`Prompt settings updated: batchSize=${state.batch_size} totalCap=${state.total_cap}`);

  return res
    .status(200)
    .json(new ApiResponse(200, formatPromptState(state), 'Prompt settings updated'));
});

export const resetPromptRange = asyncHandler(async (req, res) => {
  const { rangeStart } = req.body;

  await resetPromptRangeService({ rangeStart });
  // Same reasoning as updatePromptSettings above — re-fetch for a
  // fresh, consistent promptText.
  const state = await getPromptStateService();

  logger.info(`Prompt range reset: rangeStart=${state.range_start} rangeEnd=${state.range_end}`);

  return res
    .status(200)
    .json(new ApiResponse(200, formatPromptState(state), 'Prompt range reset'));
});

// ─── Import history ─────────────────────────────────────────────
export const getImportHistory = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.max(parseInt(req.query.limit, 10) || 20, 1);
  const skip = (page - 1) * limit;

  const [batches, total] = await Promise.all([
    ImportBatch.find().sort({ created_at: -1 }).skip(skip).limit(limit),
    ImportBatch.countDocuments(),
  ]);

  const pages = Math.max(Math.ceil(total / limit), 1);

  return res.status(200).json(
    new ApiResponse(200, { batches, total, page, pages }, 'Import history fetched successfully')
  );
});
