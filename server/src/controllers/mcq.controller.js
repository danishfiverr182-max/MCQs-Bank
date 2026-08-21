import asyncHandler from '../utils/asyncHandler.js';
import ApiResponse from '../utils/ApiResponse.js';
import ApiError from '../utils/ApiError.js';
import * as mcqService from '../services/mcq.service.js';
import { logger } from '../utils/logger.js';
import { parsePagination } from '../utils/pagination.js';

// ─── Create ──────────────────────────────────────────────────────
export const createMcq = asyncHandler(async (req, res) => {
  const isDuplicate = await mcqService.checkDuplicateQuestion(req.body.question);
  if (isDuplicate) {
    throw new ApiError(409, 'A question with this exact text already exists');
  }

  const mcq = await mcqService.createMcq(req.body);
  logger.info(`MCQ created: ${mcq.question_id}`);

  return res
    .status(201)
    .json(new ApiResponse(201, { mcq }, 'MCQ created successfully'));
});

// ─── List / search ───────────────────────────────────────────────
export const getAllMcqs = asyncHandler(async (req, res) => {
  const {
    sortBy,
    sortOrder,
    search,
    subject,
    difficulty,
    status,
    cognitive_level,
    exam_tag,
    ids,
    topic,
    subtopic,
  } = req.query;

  // mcqQuerySchema (zod, via `validate` middleware) already coerces and
  // clamps page/limit before this controller ever runs. parsePagination
  // is applied again here anyway (Prompt 103) purely so this endpoint
  // goes through the same shared helper every other list endpoint now
  // uses — belt-and-suspenders, not compensating for a real gap.
  //
  // `maxLimit: 500` override is required here, NOT optional: the shared
  // default (utils/pagination.js) is 100, deliberately left as-is for
  // every OTHER list endpoint that still uses it (Test History, Activity
  // Log — those haven't opted into a 500 option and shouldn't silently
  // get one). Without this override, a validated `limit=500` from the
  // Zod schema above would pass validation cleanly, then get silently
  // re-clamped back down to 100 right here — no error, the UI would just
  // show "500" selected while quietly serving 100 rows. That's a worse
  // bug than a clear validation error, since nothing would ever surface
  // it.
  const { page, limit } = parsePagination(req.query, { maxLimit: 500 });

  // Comma-separated string → array; parsed here (HTTP-layer concern)
  // rather than in the service, same as every other query-param
  // shaping this controller already does.
  const idsArray = ids
    ? ids
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean)
    : undefined;

  const result = await mcqService.findWithFilters(
    { search, subject, difficulty, status, cognitive_level, exam_tag, ids: idsArray, topic, subtopic },
    { page, limit, sortBy, sortOrder }
  );

  // Prompt 103: result is now the standard { data, pagination: { page,
  // limit, totalCount, totalPages, hasNextPage, hasPrevPage } } shape
  // (was { items, pagination: { total, ... } }). MCQList.jsx still reads
  // `data.items` / `data.pagination.total` and WILL break until it's
  // updated to match — deferred per Prompt 103's DoD ("frontend may need
  // a corresponding small update, called out in Prompt 104+").
  return res
    .status(200)
    .json(new ApiResponse(200, result, 'MCQs fetched successfully'));
});

// ─── Get by id ────────────────────────────────────────────────────
export const getMcqById = asyncHandler(async (req, res) => {
  const mcq = await mcqService.findById(req.params.id); // throws 404 upstream if not found

  return res
    .status(200)
    .json(new ApiResponse(200, { mcq }, 'MCQ fetched successfully'));
});

// ─── Update ──────────────────────────────────────────────────────
export const updateMcq = asyncHandler(async (req, res) => {
  if (req.body.question) {
    const isDuplicate = await mcqService.checkDuplicateQuestion(
      req.body.question,
      req.params.id
    );
    if (isDuplicate) {
      throw new ApiError(409, 'Another question with this exact text already exists');
    }
  }

  const mcq = await mcqService.updateMcq(req.params.id, req.body);
  logger.info(`MCQ updated: ${mcq.question_id}`);

  return res
    .status(200)
    .json(new ApiResponse(200, { mcq }, 'MCQ updated successfully'));
});

// ─── Delete ──────────────────────────────────────────────────────
export const deleteMcq = asyncHandler(async (req, res) => {
  const mcq = await mcqService.deleteMcq(req.params.id);
  logger.info(`MCQ deleted: ${mcq.question_id}`);

  return res
    .status(200)
    .json(new ApiResponse(200, null, 'MCQ deleted successfully'));
});

// ─── Approve / Reject ────────────────────────────────────────────
export const approveMcq = asyncHandler(async (req, res) => {
  const mcq = await mcqService.setStatus(req.params.id, 'approved');
  logger.info(`MCQ approved: ${mcq.question_id}`);

  // Prompt 92: explicit, richer context — otherwise autoLogResponse's
  // fallback table would log this as the generic 'mcq_updated'.
  req.logContext.action = 'mcq_approved';
  req.logContext.summary = `Approved MCQ ${mcq.question_id}`;

  return res.status(200).json(new ApiResponse(200, { mcq }, 'MCQ approved'));
});

export const rejectMcq = asyncHandler(async (req, res) => {
  const mcq = await mcqService.setStatus(req.params.id, 'rejected');
  logger.info(`MCQ rejected: ${mcq.question_id}`);

  // Prompt 92: same reasoning as approveMcq above.
  req.logContext.action = 'mcq_rejected';
  req.logContext.summary = `Rejected MCQ ${mcq.question_id}`;

  return res.status(200).json(new ApiResponse(200, { mcq }, 'MCQ rejected'));
});

// ─── Bulk approve ────────────────────────────────────────────────
// Body: { ids: [<mongo _id>, ...] } — lets an admin move every MCQ
// from a bulk import (or any other selection) from 'pending' to
// 'approved' in one call, instead of one row at a time via
// PATCH /:id/approve. See mcq.service.js bulkSetStatus for why this
// exists.
export const bulkApproveMcqs = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const result = await mcqService.bulkSetStatus(ids, 'approved');
  logger.info(`Bulk-approved ${result.modifiedCount}/${result.matchedCount} MCQ(s)`);

  req.logContext.action = 'mcq_bulk_approved';
  req.logContext.summary = `Bulk-approved ${result.modifiedCount} MCQ(s)`;

  return res.status(200).json(new ApiResponse(200, result, 'MCQs approved'));
});

// ─── Bulk reject ─────────────────────────────────────────────────
// Body: { ids: [<mongo _id>, ...] } — mirrors bulkApproveMcqs, moving
// every selected MCQ to 'rejected' in one call instead of one row at
// a time via PATCH /:id/reject.
export const bulkRejectMcqs = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const result = await mcqService.bulkSetStatus(ids, 'rejected');
  logger.info(`Bulk-rejected ${result.modifiedCount}/${result.matchedCount} MCQ(s)`);

  req.logContext.action = 'mcq_bulk_rejected';
  req.logContext.summary = `Bulk-rejected ${result.modifiedCount} MCQ(s)`;

  return res.status(200).json(new ApiResponse(200, result, 'MCQs rejected'));
});

// ─── Bulk delete ─────────────────────────────────────────────────
// Body: { ids: [<mongo _id>, ...] } — permanently removes every
// selected MCQ in one call instead of one row at a time via
// DELETE /:id. Irreversible, unlike bulk approve/reject.
export const bulkDeleteMcqs = asyncHandler(async (req, res) => {
  const { ids } = req.body;
  const result = await mcqService.bulkDelete(ids);
  logger.info(`Bulk-deleted ${result.deletedCount} MCQ(s)`);

  req.logContext.action = 'mcq_bulk_deleted';
  req.logContext.summary = `Bulk-deleted ${result.deletedCount} MCQ(s)`;

  return res.status(200).json(new ApiResponse(200, result, 'MCQs deleted'));
});

// ─── Topics by subject (Prompt 77) ─────────────────────────────────
// GET /api/mcq/topics?subject=X — distinct, sorted topic values for
// one subject, scoped to approved MCQs only. Deliberately a thin
// pass-through: shape validation (subject required) lives in
// mcq.validator.js's topicsQuerySchema, the actual query lives in
// mcqService per this file's "controllers must go through the service
// layer" convention (mcq.service.js's own header comment).
export const getTopicsBySubject = asyncHandler(async (req, res) => {
  const topics = await mcqService.getTopicsBySubject(req.query.subject);

  return res.status(200).json(new ApiResponse(200, { topics }, 'Topics fetched successfully'));
});

// ─── Stats ───────────────────────────────────────────────────────
export const getMcqStats = asyncHandler(async (req, res) => {
  const stats = await mcqService.getStats();

  return res.status(200).json(new ApiResponse(200, stats, 'MCQ stats fetched'));
});

// ─── Taxonomy (Prompt 109) ─────────────────────────────────────────
// GET /api/mcqs/taxonomy — full Subject -> Topic -> Subtopic tree with
// live per-status counts, powering the Taxonomy Manager page. Thin
// pass-through, same convention as getTopicsBySubject above.
export const getTaxonomy = asyncHandler(async (req, res) => {
  const taxonomy = await mcqService.getTaxonomy();

  return res.status(200).json(new ApiResponse(200, taxonomy, 'Taxonomy fetched successfully'));
});

// GET /api/mcqs/taxonomy/reconcile — admin-triggered drift check
// between TaxonomyNode and MCQ (Taxonomy P3). Read-only: flags orphan
// MCQ triples and empty TaxonomyNodes without changing either
// collection. See mcqService.reconcileTaxonomy for the matching rules.
export const reconcileTaxonomy = asyncHandler(async (req, res) => {
  const report = await mcqService.reconcileTaxonomy();

  req.logContext.action = 'taxonomy_reconciled';
  req.logContext.summary = report.is_clean
    ? 'Taxonomy reconciliation: no drift found'
    : `Taxonomy reconciliation: ${report.orphan_count} orphan MCQ triple(s), ${report.empty_count} empty node(s)`;

  return res.status(200).json(new ApiResponse(200, report, 'Taxonomy reconciliation complete'));
});

// ─── Bulk reassign topic/subtopic (Prompt 109) ──────────────────────
// PATCH /api/mcqs/bulk-reassign-topic — renames/reassigns a topic or
// subtopic across every MCQ currently tagged with it. See
// mcq.service.js's bulkReassignTopic for the matching/update rules.
export const bulkReassignTopic = asyncHandler(async (req, res) => {
  const result = await mcqService.bulkReassignTopic(req.body);
  logger.info(
    `Bulk-reassigned topic: ${req.body.subject} / ${req.body.from_topic} -> ${req.body.to_topic} (${result.modified_count}/${result.matched_count})`
  );

  req.logContext.action = 'mcq_bulk_reassigned';
  req.logContext.summary = `Retagged ${result.modified_count} MCQ(s) in ${req.body.subject} from "${req.body.from_topic}" to "${req.body.to_topic}"`;

  return res.status(200).json(new ApiResponse(200, result, 'MCQs reassigned'));
});

// ─── Rename a TaxonomyNode at any level (Taxonomy P4) ────────────────
// PATCH /api/mcqs/taxonomy/rename-node — extends the rename pattern
// above to subject-level renames too. See mcq.service.js's
// renameTaxonomyNode for the TaxonomyNode + MCQ + Blueprint
// transaction this wraps.
export const renameTaxonomyNode = asyncHandler(async (req, res) => {
  const result = await mcqService.renameTaxonomyNode({ ...req.body, actor: req.user });
  logger.info(
    `Renamed TaxonomyNode ${result.node_type}: "${result.old_name}" -> "${result.new_name}" ` +
      `(${result.modified_count}/${result.matched_count} MCQ(s), ${result.blueprints_updated} blueprint(s))`
  );

  // Prompt 11 (Feature 14): the ActivityLog row for this action is now
  // written INSIDE renameTaxonomyNode's own transaction — see
  // taxonomy.service.js's header comment on why the log write had to
  // move from this post-response auto-log into the same atomic
  // TaxonomyNode/MCQ/Blueprint commit. `skip = true` stops
  // activityLogger.middleware.js's res.on('finish') hook from writing
  // a second, redundant row for the same action.
  req.logContext.skip = true;

  return res.status(200).json(new ApiResponse(200, result, 'Taxonomy node renamed'));
});

// ─── Move a topic to a different subject (Taxonomy P5, Feature 1) ───
// PATCH /api/mcqs/taxonomy/move-topic — reparents a topic (and every
// subtopic under it) to a new subject, retagging every affected MCQ's
// `subject` field along the way. See mcq.service.js's
// moveTopicToSubject for the TaxonomyNode + MCQ transaction this wraps.
export const moveTopicToSubject = asyncHandler(async (req, res) => {
  const result = await mcqService.moveTopicToSubject({ ...req.body, actor: req.user });
  logger.info(
    `Moved topic "${result.topic_name}": "${result.source_subject.name}" -> ` +
      `"${result.destination_subject.name}" (${result.modified_count}/${result.matched_count} MCQ(s))`
  );

  // Prompt 11 (Feature 14) — see renameTaxonomyNode's own comment above
  // on why the ActivityLog write now happens inside the service's own
  // transaction, and why the post-response auto-log is skipped here.
  req.logContext.skip = true;

  return res.status(200).json(new ApiResponse(200, result, 'Topic moved'));
});

// ─── Move a subject into another subject as a topic (Taxonomy P6,
// Feature 2) ───────────────────────────────────────────────────────
// PATCH /api/mcqs/taxonomy/move-subject-into-subject — the highest-risk
// taxonomy op: converts an entire subject into a topic nested under a
// different subject, demoting every topic that was directly under it
// into a subtopic. See mcq.service.js's moveSubjectIntoSubject for the
// nesting guard, the TaxonomyNode type-flip, and the MCQ + Blueprint
// transaction this wraps.
export const moveSubjectIntoSubject = asyncHandler(async (req, res) => {
  const result = await mcqService.moveSubjectIntoSubject({ ...req.body, actor: req.user });
  logger.info(
    `Moved subject "${result.node_name}" into "${result.destination_subject.name}" as a topic ` +
      `(${result.subtopics_created} subtopic(s), ${result.modified_count}/${result.matched_count} MCQ(s))`
  );

  // Prompt 11 (Feature 14) — see renameTaxonomyNode's own comment above
  // on why the ActivityLog write now happens inside the service's own
  // transaction, and why the post-response auto-log is skipped here.
  req.logContext.skip = true;

  return res.status(200).json(new ApiResponse(200, result, 'Subject moved into subject as topic'));
});

// ─── Move a subtopic to a different topic (Taxonomy P7, Feature 3) ──
// PATCH /api/mcqs/taxonomy/move-subtopic — reparents a single subtopic
// to a new topic (possibly under a different subject entirely),
// retagging every affected MCQ's `subject`/`topic` fields along the
// way. See mcq.service.js's moveSubtopicToTopic for the TaxonomyNode +
// MCQ transaction this wraps.
export const moveSubtopicToTopic = asyncHandler(async (req, res) => {
  const result = await mcqService.moveSubtopicToTopic({ ...req.body, actor: req.user });
  logger.info(
    `Moved subtopic "${result.subtopic_name}": "${result.source_topic.name}" -> ` +
      `"${result.destination_topic.name}" (${result.modified_count}/${result.matched_count} MCQ(s))`
  );

  // Prompt 11 (Feature 14) — see renameTaxonomyNode's own comment above
  // on why the ActivityLog write now happens inside the service's own
  // transaction, and why the post-response auto-log is skipped here.
  req.logContext.skip = true;

  return res.status(200).json(new ApiResponse(200, result, 'Subtopic moved'));
});

// ─── Merge 2+ same-type, same-parent TaxonomyNodes (Taxonomy P8) ────
// PATCH /api/mcqs/taxonomy/merge-nodes — collapses N siblings (all
// subject, all topic, or all subtopic — same parent for topic/
// subtopic) into one of themselves (`keep_name`), retagging every MCQ
// still pointing at a merged-away node's old name along the way. Was
// previously only reachable via POST /api/taxonomy/preview's
// `dryRun: true` branch (see taxonomy.controller.js) — Prompt 17 adds
// this as the actual commit route the merge modal's "Confirm merge"
// step calls once an admin has reviewed that preview. See
// mcq.service.js's mergeTaxonomyNodes for the recursive
// TaxonomyNode + MCQ transaction this wraps, including the
// double-counted-MCQ (shared question_hash across merge candidates)
// edge case it logs but deliberately does not auto-resolve.
export const mergeTaxonomyNodes = asyncHandler(async (req, res) => {
  const result = await mcqService.mergeTaxonomyNodes({ ...req.body, actor: req.user });
  logger.info(
    `Merged TaxonomyNode ${result.node_type}(s) [${result.merged_away_names.join(', ')}] -> ` +
      `"${result.kept_name}" (${result.modified_count}/${result.matched_count} MCQ(s)` +
      `${result.duplicate_mcq_count > 0 ? `, ${result.duplicate_mcq_count} duplicate-content MCQ(s) kept as separate rows` : ''})`
  );

  // Prompt 11 (Feature 14) — see renameTaxonomyNode's own comment above
  // on why the ActivityLog write now happens inside the service's own
  // transaction, and why the post-response auto-log is skipped here.
  req.logContext.skip = true;

  return res.status(200).json(new ApiResponse(200, result, 'Taxonomy nodes merged'));
});

// ─── Delete a TaxonomyNode (and its subtree) (Taxonomy P9) ──────────
// DELETE /api/mcqs/taxonomy/node — the actual commit route for
// DeleteNodeModal's "Confirm delete" step, once the admin has both
// reviewed previewTaxonomyDelete's counts and made the required
// move-vs-delete-outright choice for orphaned MCQs (`on_orphan_mcqs`).
// Was previously only reachable via POST /api/taxonomy/preview's
// `dryRun: true` branch (see taxonomy.controller.js) — same gap
// merge-nodes had before Prompt 17. This is the only irreversible
// mutation of the six (a "delete" on_orphan_mcqs choice permanently
// removes MCQ rows, not just retags them), hence the typed-confirmation
// step DeleteNodeModal itself adds client-side before ever calling
// this. See mcq.service.js's deleteTaxonomyNode for the subtree
// removal + MCQ move-or-delete transaction this wraps.
export const deleteTaxonomyNode = asyncHandler(async (req, res) => {
  const result = await mcqService.deleteTaxonomyNode({ ...req.body, actor: req.user });
  logger.info(
    `Deleted TaxonomyNode ${result.node_type} "${result.name}" (${result.deleted_node_count} node(s)) — ` +
      (result.on_orphan_mcqs === 'move'
        ? `${result.modified_count}/${result.matched_count} MCQ(s) moved to "${result.destination_name}"`
        : `${result.deleted_mcq_count} MCQ(s) permanently deleted`)
  );

  // Prompt 11 (Feature 14) — see renameTaxonomyNode's own comment above
  // on why the ActivityLog write now happens inside the service's own
  // transaction, and why the post-response auto-log is skipped here.
  req.logContext.skip = true;

  return res.status(200).json(new ApiResponse(200, result, 'Taxonomy node deleted'));
});

// ─── Bulk move / bulk delete (Prompt 20 — Bulk Select, Feature 12) ───
// TaxonomyManager's checkbox multi-select feeds these once an admin
// checks 2+ same-type nodes and picks "Move" or "Delete" (Merge already
// took `node_ids` arrays since Prompt 17 — see mergeTaxonomyNodes above,
// unchanged). Each wraps the matching bulk* service function — see
// taxonomy.service.js's own header comment on those for why one shared
// transaction (not one call per node) is what makes "one preview, one
// transaction, one ActivityLog row per node" true.
export const moveTopicsToSubjectBulk = asyncHandler(async (req, res) => {
  const result = await mcqService.bulkMoveTopicsToSubject({ ...req.body, actor: req.user });
  logger.info(
    `Bulk-moved ${result.moved_count} topic(s) -> "${result.destination_subject.name}"`
  );
  req.logContext.skip = true;
  return res.status(200).json(new ApiResponse(200, result, 'Topics moved'));
});

export const moveSubjectsIntoSubjectBulk = asyncHandler(async (req, res) => {
  const result = await mcqService.bulkMoveSubjectsIntoSubject({ ...req.body, actor: req.user });
  logger.info(
    `Bulk-moved ${result.moved_count} subject(s) into "${result.destination_subject.name}" as topics`
  );
  req.logContext.skip = true;
  return res.status(200).json(new ApiResponse(200, result, 'Subjects moved into subject'));
});

export const moveSubtopicsToTopicBulk = asyncHandler(async (req, res) => {
  const result = await mcqService.bulkMoveSubtopicsToTopic({ ...req.body, actor: req.user });
  logger.info(
    `Bulk-moved ${result.moved_count} subtopic(s) -> "${result.destination_topic.name}"`
  );
  req.logContext.skip = true;
  return res.status(200).json(new ApiResponse(200, result, 'Subtopics moved'));
});

export const deleteTaxonomyNodesBulk = asyncHandler(async (req, res) => {
  const result = await mcqService.bulkDeleteTaxonomyNodes({ ...req.body, actor: req.user });
  logger.info(
    `Bulk-deleted ${result.deleted_count} TaxonomyNode(s) (on_orphan_mcqs: ${result.on_orphan_mcqs})`
  );
  req.logContext.skip = true;
  return res.status(200).json(new ApiResponse(200, result, 'Taxonomy nodes deleted'));
});
