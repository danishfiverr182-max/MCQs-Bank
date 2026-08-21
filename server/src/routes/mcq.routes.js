import { Router } from 'express';
import {
  createMcq,
  getAllMcqs,
  getMcqById,
  updateMcq,
  deleteMcq,
  approveMcq,
  rejectMcq,
  bulkApproveMcqs,
  bulkRejectMcqs,
  bulkDeleteMcqs,
  getMcqStats,
  getTopicsBySubject,
  getTaxonomy,
  reconcileTaxonomy,
  bulkReassignTopic,
  renameTaxonomyNode,
  moveTopicToSubject,
  moveSubjectIntoSubject,
  moveSubtopicToTopic,
  mergeTaxonomyNodes,
  deleteTaxonomyNode,
  moveTopicsToSubjectBulk,
  moveSubjectsIntoSubjectBulk,
  moveSubtopicsToTopicBulk,
  deleteTaxonomyNodesBulk,
} from '../controllers/mcq.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';
import validate from '../middleware/validate.middleware.js';
import {
  createMcqSchema,
  updateMcqSchema,
  mcqQuerySchema,
  topicsQuerySchema,
  bulkApproveSchema,
  bulkRejectSchema,
  bulkDeleteSchema,
  bulkReassignTopicSchema,
  renameTaxonomyNodeSchema,
  moveTopicToSubjectSchema,
  moveSubjectIntoSubjectSchema,
  moveSubtopicToTopicSchema,
} from '../validators/mcq.validator.js';
// mergeTaxonomyNodesSchema/deleteTaxonomyNodeSchema live in
// taxonomy.validator.js (added there in Prompt 10 for the preview
// endpoint, since merge/delete never got their own HTTP-layer schema
// until something outside a dry-run preview actually needed one — see
// that file's own header comment). Reused here, rather than
// duplicated, so the preview endpoint's `payload` and each route's
// real body are validated by the literal same schema.
import { mergeTaxonomyNodesSchema, deleteTaxonomyNodeSchema } from '../validators/taxonomy.validator.js';
// Prompt 20 (Bulk Select, Feature 12) — same reuse-not-duplicate reason
// as the import above: these live in taxonomy.validator.js too, since
// that's where the array-carrying node_ids-style schemas already lived
// (merge/delete) before this prompt added move's own bulk siblings.
import {
  bulkMoveTopicsToSubjectSchema,
  bulkMoveSubjectsIntoSubjectSchema,
  bulkMoveSubtopicsToTopicSchema,
  bulkDeleteTaxonomyNodesSchema,
} from '../validators/taxonomy.validator.js';

const router = Router();

// Applied once — every route below inherits both guards.
router.use(verifyJWT, requireRole('admin'));

// Placed BEFORE /:id so "stats"/"topics"/"taxonomy" are never matched as
// an :id param.
router.get('/stats', getMcqStats);
router.get('/topics', validate(topicsQuerySchema), getTopicsBySubject);
// Prompt 109: Taxonomy Manager's tree read + bulk rename, placed here
// alongside /stats and /topics for the same "before /:id" reason.
// '/taxonomy/reconcile' must come before '/taxonomy' would ever matter
// as a prefix collision — it doesn't here since Express matches full
// segments, but kept directly beneath it for readability (Taxonomy P3).
router.get('/taxonomy', getTaxonomy);
router.get('/taxonomy/reconcile', reconcileTaxonomy);
router.patch('/bulk-approve', validate(bulkApproveSchema), bulkApproveMcqs);
router.patch('/bulk-reject', validate(bulkRejectSchema), bulkRejectMcqs);
router.patch(
  '/bulk-reassign-topic',
  validate(bulkReassignTopicSchema),
  bulkReassignTopic
);
// Taxonomy P4: rename-at-any-level, including subject — the one rename
// shape bulk-reassign-topic above can't do. Placed alongside it for the
// same "before /:id" reason as everything else in this block.
router.patch(
  '/taxonomy/rename-node',
  validate(renameTaxonomyNodeSchema),
  renameTaxonomyNode
);
// Taxonomy P5 (Feature 1): move a topic (+ its subtopics) to a
// different subject. Placed alongside the other taxonomy mutations for
// the same "before /:id" reason.
router.patch(
  '/taxonomy/move-topic',
  validate(moveTopicToSubjectSchema),
  moveTopicToSubject
);
// Taxonomy P6 (Feature 2): fold a whole subject into another subject
// as one of its topics, demoting its former topics to subtopics.
// Placed alongside the other taxonomy mutations for the same "before
// /:id" reason.
router.patch(
  '/taxonomy/move-subject-into-subject',
  validate(moveSubjectIntoSubjectSchema),
  moveSubjectIntoSubject
);
// Taxonomy P7 (Feature 3): move a single subtopic to a different
// topic. Placed alongside the other taxonomy mutations for the same
// "before /:id" reason.
router.patch(
  '/taxonomy/move-subtopic',
  validate(moveSubtopicToTopicSchema),
  moveSubtopicToTopic
);
// Taxonomy P8 (Prompt 17): collapse 2+ same-type, same-parent
// TaxonomyNodes into one of themselves. Placed alongside the other
// taxonomy mutations for the same "before /:id" reason.
router.patch(
  '/taxonomy/merge-nodes',
  validate(mergeTaxonomyNodesSchema),
  mergeTaxonomyNodes
);
// Taxonomy P9 (Prompt 18): permanently remove a TaxonomyNode (and its
// topic/subtopic subtree) plus decide what happens to every MCQ that
// was tagged under it. DELETE with a JSON body, same intentional
// pattern '/bulk-delete' below already uses — see that route's own
// comment. Placed alongside the other taxonomy mutations for the same
// "before /:id" reason.
router.delete(
  '/taxonomy/node',
  validate(deleteTaxonomyNodeSchema),
  deleteTaxonomyNode
);
// Prompt 20 (Bulk Select, Feature 12): bulk counterparts of the three
// movers + delete above — same routes/handlers shape, just an array of
// source ids and one shared destination (move) or one shared
// on_orphan_mcqs choice (delete). Placed directly after each one's
// single-node sibling for the same "before /:id" reason as everything
// else in this block.
router.patch(
  '/taxonomy/move-topic-bulk',
  validate(bulkMoveTopicsToSubjectSchema),
  moveTopicsToSubjectBulk
);
router.patch(
  '/taxonomy/move-subject-into-subject-bulk',
  validate(bulkMoveSubjectsIntoSubjectSchema),
  moveSubjectsIntoSubjectBulk
);
router.patch(
  '/taxonomy/move-subtopic-bulk',
  validate(bulkMoveSubtopicsToTopicSchema),
  moveSubtopicsToTopicBulk
);
router.delete(
  '/taxonomy/node-bulk',
  validate(bulkDeleteTaxonomyNodesSchema),
  deleteTaxonomyNodesBulk
);
// DELETE with a JSON body is unusual but intentional here — it mirrors
// the existing DELETE /:id single-row route (delete is DELETE, not
// PATCH) while still taking a body, same as bulk-approve/bulk-reject
// do for their id lists. Placed above '/:id' for the same reason
// '/stats' and '/topics' are: so Express never matches "bulk-delete"
// against the :id param route instead.
router.delete('/bulk-delete', validate(bulkDeleteSchema), bulkDeleteMcqs);

router.get('/', validate(mcqQuerySchema), getAllMcqs);
router.post('/', validate(createMcqSchema), createMcq);
router.get('/:id', getMcqById);
router.patch('/:id', validate(updateMcqSchema), updateMcq);
router.delete('/:id', deleteMcq);
router.patch('/:id/approve', approveMcq);
router.patch('/:id/reject', rejectMcq);

export default router;
