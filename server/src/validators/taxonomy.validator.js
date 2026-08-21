import { z } from 'zod';
import {
  renameTaxonomyNodeSchema,
  moveTopicToSubjectSchema,
  moveSubjectIntoSubjectSchema,
  moveSubtopicToTopicSchema,
} from './mcq.validator.js';

// ─── Preview / Diff Before Apply (Prompt 10 — Feature 13) ────────────
// POST /api/taxonomy/preview needs one schema that can validate any of
// the 6 taxonomy mutations' payloads (Prompts 4-9), dispatched by an
// `operation` discriminator. `merge` and `delete` never got their own
// HTTP-layer schemas (mergeTaxonomyNodes/deleteTaxonomyNode in
// mcq.service.js were only ever called directly, per those prompts'
// own "no live MongoDB to wire a route against yet" scripts) — added
// here since this endpoint is the first thing that actually needs them.
const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'must be a valid Mongo ObjectId');

export const mergeTaxonomyNodesSchema = z.object({
  body: z.object({
    node_ids: z.array(objectId).min(2, 'node_ids must contain at least two TaxonomyNode ids'),
    // Trimmed only, not required non-empty — '' is a legitimate topic/
    // subtopic value (the "(none)" bucket), same reasoning
    // renameTaxonomyNodeSchema's own new_name field gives.
    keep_name: z.string().transform((v) => v.trim()),
  }),
});

export const deleteTaxonomyNodeSchema = z.object({
  body: z.object({
    node_id: objectId,
    on_orphan_mcqs: z.object({
      action: z.enum(['move', 'delete']),
      destination_node_id: objectId.optional(),
    }),
  }),
});

// ─── Bulk move / bulk delete (Prompt 20 — Bulk Select, Feature 12) ────
// One extra schema per mover, plus one for bulk delete, mirroring their
// single-node siblings above/in mcq.validator.js exactly except the one
// source-id field becomes a `min(2)` array — TaxonomyManager's own
// selection UI only ever offers "Move"/"Delete" once 1+ same-type nodes
// are checked, but the schema itself still requires 2+ so a would-be
// single-node call is forced through the (identical, already-audited)
// single-node route instead of a second code path for the same thing.
export const bulkMoveTopicsToSubjectSchema = z.object({
  body: z.object({
    topic_node_ids: z.array(objectId).min(2, 'topic_node_ids must contain at least two ids'),
    destination_subject_id: objectId,
  }),
});

export const bulkMoveSubjectsIntoSubjectSchema = z.object({
  body: z.object({
    subject_node_ids: z.array(objectId).min(2, 'subject_node_ids must contain at least two ids'),
    destination_subject_id: objectId,
  }),
});

export const bulkMoveSubtopicsToTopicSchema = z.object({
  body: z.object({
    subtopic_node_ids: z.array(objectId).min(2, 'subtopic_node_ids must contain at least two ids'),
    destination_topic_id: objectId,
  }),
});

export const bulkDeleteTaxonomyNodesSchema = z.object({
  body: z.object({
    node_ids: z.array(objectId).min(2, 'node_ids must contain at least two ids'),
    on_orphan_mcqs: z.object({
      action: z.enum(['move', 'delete']),
      destination_node_id: objectId.optional(),
    }),
  }),
});

// GET /api/taxonomy/delete-preview-bulk?nodeIds=a,b,c (Prompt 20) — the
// bulk counterpart of deletePreviewParamsSchema above, same "counts
// BEFORE an on_orphan_mcqs choice exists" reason.
export const deletePreviewBulkQuerySchema = z.object({
  query: z.object({
    nodeIds: z
      .string()
      .min(1)
      .transform((v) => v.split(',').map((s) => s.trim()))
      .refine((arr) => arr.length >= 2, 'nodeIds must contain at least two ids')
      .refine((arr) => arr.every((id) => /^[a-f0-9]{24}$/i.test(id)), 'every id must be a valid Mongo ObjectId'),
  }),
});

// GET /api/taxonomy/delete-preview/:nodeId (Prompt 18) — the very
// first thing DeleteNodeModal shows, BEFORE the admin has picked a
// move-vs-delete-outright orphan-handling choice (so, unlike the
// discriminated-union preview below, there's no `on_orphan_mcqs` yet
// to validate — just the node id being inspected).
export const deletePreviewParamsSchema = z.object({
  params: z.object({ nodeId: objectId }),
});

// One request shape per operation — each `payload` re-uses the EXACT
// same body schema the real mutation route already validates against,
// so a preview can never accept something the real operation would
// then reject on shape grounds alone. Semantic checks (do the ids
// resolve? are they the right node type? etc.) still live in
// mcqService, same division of labor every other taxonomy schema in
// this codebase already draws.
export const previewTaxonomySchema = z.object({
  body: z.discriminatedUnion('operation', [
    z.object({ operation: z.literal('rename'), payload: renameTaxonomyNodeSchema.shape.body }),
    z.object({ operation: z.literal('move_topic'), payload: moveTopicToSubjectSchema.shape.body }),
    z.object({
      operation: z.literal('move_subject'),
      payload: moveSubjectIntoSubjectSchema.shape.body,
    }),
    z.object({
      operation: z.literal('move_subtopic'),
      payload: moveSubtopicToTopicSchema.shape.body,
    }),
    z.object({ operation: z.literal('merge'), payload: mergeTaxonomyNodesSchema.shape.body }),
    z.object({ operation: z.literal('delete'), payload: deleteTaxonomyNodeSchema.shape.body }),
    // Prompt 20 (Bulk Select, Feature 12) — bulk siblings of the four
    // move/delete branches above, same reuse-the-mutation's-own-schema
    // pattern.
    z.object({
      operation: z.literal('move_topic_bulk'),
      payload: bulkMoveTopicsToSubjectSchema.shape.body,
    }),
    z.object({
      operation: z.literal('move_subject_bulk'),
      payload: bulkMoveSubjectsIntoSubjectSchema.shape.body,
    }),
    z.object({
      operation: z.literal('move_subtopic_bulk'),
      payload: bulkMoveSubtopicsToTopicSchema.shape.body,
    }),
    z.object({ operation: z.literal('delete_bulk'), payload: bulkDeleteTaxonomyNodesSchema.shape.body }),
  ]),
});
