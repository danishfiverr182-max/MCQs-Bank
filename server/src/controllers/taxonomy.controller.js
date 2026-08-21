import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import * as taxonomyService from '../services/taxonomy.service.js';

// ─── Preview / Diff Before Apply (Prompt 10 — Feature 13) ────────────
// POST /api/taxonomy/preview — one endpoint, any of the 6 taxonomy
// mutations from Prompts 4-9, dispatched by `operation`. Every handler
// below is called with `dryRun: true` (see each function's own
// `if (dryRun)` branch): the exact same validation the real mutation
// runs, but no transaction opened and nothing written, so the frontend
// (Prompt 14) can show one consistent "current -> new" diff screen
// regardless of which operation is being previewed.
//
// Keys mirror previewTaxonomySchema's discriminated union exactly —
// `validate` middleware guarantees `operation` is one of these six
// before this controller ever runs.
//
// Prompt 11 (Feature 14): imported directly from taxonomy.service.js
// now — that's the one file all 6 operations, and the
// `withTaxonomyTransaction` wrapper they share, actually live in — 
// rather than via mcq.service.js's backward-compatibility re-export
// (see that file's own bottom-of-file comment on why that re-export
// exists for OTHER, unmigrated callers).
const OPERATION_HANDLERS = {
  rename: taxonomyService.renameTaxonomyNode,
  move_topic: taxonomyService.moveTopicToSubject,
  move_subject: taxonomyService.moveSubjectIntoSubject,
  move_subtopic: taxonomyService.moveSubtopicToTopic,
  merge: taxonomyService.mergeTaxonomyNodes,
  delete: taxonomyService.deleteTaxonomyNode,
  // Prompt 20 (Bulk Select, Feature 12) — the bulk siblings of the four
  // above, dispatched the exact same way; see previewTaxonomySchema's
  // own discriminated union (taxonomy.validator.js) for their payload
  // shapes (array of source ids + one shared destination/on_orphan_mcqs).
  move_topic_bulk: taxonomyService.bulkMoveTopicsToSubject,
  move_subject_bulk: taxonomyService.bulkMoveSubjectsIntoSubject,
  move_subtopic_bulk: taxonomyService.bulkMoveSubtopicsToTopic,
  delete_bulk: taxonomyService.bulkDeleteTaxonomyNodes,
};

export const previewTaxonomyOperation = asyncHandler(async (req, res) => {
  const { operation, payload } = req.body;
  const handler = OPERATION_HANDLERS[operation];
  if (!handler) {
    // Unreachable once previewTaxonomySchema's discriminated union has
    // run (see taxonomy.validator.js) — kept as an explicit guard
    // rather than assumed, same defensive stance the taxonomy movers
    // themselves take on their own "should be unreachable" checks.
    throw ApiError.badRequest(`Unknown taxonomy operation: ${operation}`);
  }

  const result = await handler({ ...payload, dryRun: true });

  return res.status(200).json(new ApiResponse(200, result, 'Taxonomy preview generated'));
});

// ─── Delete preview counts (Prompt 18) ────────────────────────────────
// GET /api/taxonomy/delete-preview/:nodeId — DeleteNodeModal's very
// first step, showing topic/subtopic/MCQ counts BEFORE the admin has
// even picked a move-vs-delete-outright orphan-handling choice (the
// discriminated-union preview above can't be used for this: its
// `delete` branch runs deleteTaxonomyNode's own dryRun, which requires
// a fully-formed `on_orphan_mcqs` — including a validated destination
// when the action is "move" — that doesn't exist yet at this point in
// the flow). Read-only, same as previewTaxonomyDelete itself.
export const getTaxonomyDeletePreview = asyncHandler(async (req, res) => {
  const result = await taxonomyService.previewTaxonomyDelete(req.params.nodeId);
  return res.status(200).json(new ApiResponse(200, result, 'Delete preview counts generated'));
});

// ─── Delete preview counts, bulk (Prompt 20 — Bulk Select) ────────────
// GET /api/taxonomy/delete-preview-bulk?nodeIds=a,b,c — the bulk
// counterpart of getTaxonomyDeletePreview above, same "counts before an
// on_orphan_mcqs choice exists" reason, summed across every selected
// node. `nodeIds` arrives comma-separated (see deletePreviewBulkQuerySchema)
// since a GET query string is the natural fit here, same as it would be
// for any other multi-id GET filter in this codebase.
export const getTaxonomyDeletePreviewBulk = asyncHandler(async (req, res) => {
  const result = await taxonomyService.previewTaxonomyDeleteBulk(req.query.nodeIds);
  return res.status(200).json(new ApiResponse(200, result, 'Bulk delete preview counts generated'));
});
