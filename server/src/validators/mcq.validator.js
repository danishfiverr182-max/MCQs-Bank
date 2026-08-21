import { z } from 'zod';

// ─── Shared enums ────────────────────────────────────────────────
const answerEnum = z.enum(['A', 'B', 'C', 'D']);
const difficultyEnum = z.enum(['easy', 'medium', 'hard']);
const cognitiveEnum = z.enum([
  'recall',
  'understanding',
  'application',
  'analysis',
]);
const statusEnum = z.enum(['pending', 'approved', 'rejected']);
// Query-only variant: adds the 'latest' pseudo-status (see
// mcq.service.js's findWithFilters) which is a valid *filter* value in
// GET /mcqs but must never be settable as an actual MCQ.status via
// create/update — those two keep using the strict statusEnum above.
const statusFilterEnum = z.enum(['pending', 'approved', 'rejected', 'latest']);

// ─── Create ──────────────────────────────────────────────────────
export const createMcqSchema = z.object({
  body: z.object({
    question: z.string().trim().min(5, 'Question must be at least 5 characters'),
    options: z.object({
      A: z.string().trim().min(1, 'Option A is required'),
      B: z.string().trim().min(1, 'Option B is required'),
      C: z.string().trim().min(1, 'Option C is required'),
      D: z.string().trim().min(1, 'Option D is required'),
    }),
    correct_answer: answerEnum,
    subject: z.string().trim().min(1, 'Subject is required'),
    topic: z.string().trim().optional().default(''),
    subtopic: z.string().trim().optional().default(''),
    difficulty: difficultyEnum,
    exam_tags: z.array(z.string().trim()).optional().default([]),
    cognitive_level: cognitiveEnum.optional().default('recall'),
    quality_score: z.number().min(0).max(100).optional().default(50),
    status: statusEnum.optional().default('pending'),
    explanation: z.string().trim().optional().default(''),
  }),
});

// ─── Update (partial) ────────────────────────────────────────────
export const updateMcqSchema = z.object({
  body: createMcqSchema.shape.body
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one field must be provided for update',
    }),
});

// ─── List / search query params ──────────────────────────────────
export const mcqQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    // Ceiling matches the highest option in the client's "Rows per
    // page" selector (MCQList.jsx's PAGE_SIZE_OPTIONS, which added 500
    // once virtual scrolling made a large in-view row count cheap to
    // render — see that file's comment). Keep these two in sync: a
    // client-side option above this max fails here with a generic
    // "Validation failed" the UI can't explain, and a max here above
    // the client's highest option is just dead slack.
    limit: z.coerce.number().int().min(1).max(500).optional().default(20),
    search: z.string().trim().optional(),
    subject: z.string().trim().optional(),
    difficulty: difficultyEnum.optional(),
    status: statusFilterEnum.optional(),
    cognitive_level: cognitiveEnum.optional(),
    exam_tag: z.string().trim().optional(),
    // Taxonomy page's "View MCQs" deep link (Prompt 109). Deliberately
    // NOT reusing subject's truthy-only handling in mcq.service.js —
    // '' is a real, meaningful value here (the "(none)" topic/subtopic
    // bucket), so the service checks `!== undefined` for these two
    // instead of truthiness.
    topic: z.string().trim().optional(),
    subtopic: z.string().trim().optional(),
    // Phase 8 (Prompt 89) addition: comma-separated question_id list —
    // powers QAReport.jsx's "Similar Pairs Found" section, which needs
    // to resolve every MCQ referenced across all of a report's
    // near-duplicate warnings in ONE batched request rather than one
    // per pair. Purely additive/optional; every existing caller of
    // this endpoint is unaffected.
    ids: z.string().trim().optional(),
    sortBy: z
      .enum(['createdAt', 'quality_score', 'used_count'])
      .optional()
      .default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
});

// ─── Topics by subject query params (Prompt 77) ───────────────────
export const topicsQuerySchema = z.object({
  query: z.object({
    subject: z.string().trim().min(1, 'subject is required'),
  }),
});

// ─── Bulk ids body ──────────────────────────────────────────────
// Shared shape for every bulk-action endpoint — { ids: [<mongo _id>, ...] }.
// Mongo ObjectId is a 24-char hex string; validating the shape here
// keeps a malformed id list from reaching the service layer's $in
// queries at all. bulk-approve, bulk-reject, and bulk-delete all use
// this identical body, so one schema backs all three routes.
const bulkIdsSchema = z.object({
  body: z.object({
    ids: z
      .array(z.string().regex(/^[a-f0-9]{24}$/i, 'Each id must be a valid Mongo ObjectId'))
      .min(1, 'ids must be a non-empty array'),
  }),
});

export const bulkApproveSchema = bulkIdsSchema;
export const bulkRejectSchema = bulkIdsSchema;
export const bulkDeleteSchema = bulkIdsSchema;

// ─── Rename a TaxonomyNode at any level (Taxonomy P4) ───────────────
// Powers the Taxonomy Manager's rename-at-any-level action —
// generalizes bulkReassignTopicSchema above (topic/subtopic only,
// fixed subject) to also cover subject-level renames. `new_name` is
// nullable-empty on purpose: '' is a real, valid topic/subtopic value
// (the "(none)" bucket — see TaxonomyNode.js), so only whitespace-only
// input is rejected outright; whether an empty new_name is actually
// legal for THIS node's type (a subject may never be '') is a
// service-layer concern (mcqService.renameTaxonomyNode), since that
// depends on which node_id was passed, not something this schema can
// see.
export const renameTaxonomyNodeSchema = z.object({
  body: z.object({
    node_id: z.string().regex(/^[a-f0-9]{24}$/i, 'node_id must be a valid Mongo ObjectId'),
    // Only trimmed here, not required non-empty — '' is a legitimate
    // topic/subtopic value (the "(none)" bucket). Whether '' is legal
    // for a GIVEN node depends on that node's type (a subject may
    // never be ''), which this schema has no way to know — enforced in
    // mcqService.renameTaxonomyNode instead.
    new_name: z.string().transform((v) => v.trim()),
  }),
});

// ─── Move a topic to a different subject (Taxonomy P5) ──────────────
// Powers the Taxonomy Manager's "move to another subject" action.
// Both ids are just Mongo ObjectId shape checks — whether they resolve
// to real nodes, and to nodes of the right type (topic_node_id must be
// a 'topic', destination_subject_id must be a 'subject'), is a
// service-layer concern (mcqService.moveTopicToSubject), same division
// of labor renameTaxonomyNodeSchema above already draws.
export const moveTopicToSubjectSchema = z.object({
  body: z.object({
    topic_node_id: z.string().regex(/^[a-f0-9]{24}$/i, 'topic_node_id must be a valid Mongo ObjectId'),
    destination_subject_id: z
      .string()
      .regex(/^[a-f0-9]{24}$/i, 'destination_subject_id must be a valid Mongo ObjectId'),
  }),
});

// ─── Move a subject into another subject as a topic (Taxonomy P6) ───
// Powers the Taxonomy Manager's highest-risk action: collapsing a
// whole subject down into a topic under a different subject. Same
// division of labor as moveTopicToSubjectSchema above — shape only;
// whether the ids resolve, and to nodes of the right type
// (subject_node_id must be a 'subject', destination_subject_id must
// be a DIFFERENT 'subject'), plus the nesting-depth guard, are all
// service-layer concerns (mcqService.moveSubjectIntoSubject).
export const moveSubjectIntoSubjectSchema = z.object({
  body: z.object({
    subject_node_id: z.string().regex(/^[a-f0-9]{24}$/i, 'subject_node_id must be a valid Mongo ObjectId'),
    destination_subject_id: z
      .string()
      .regex(/^[a-f0-9]{24}$/i, 'destination_subject_id must be a valid Mongo ObjectId'),
  }),
});

// ─── Move a subtopic to a different topic (Taxonomy P7) ─────────────
// Powers the Taxonomy Manager's "move to another topic" action for a
// single subtopic — the mirror of moveTopicToSubjectSchema, one level
// down. Same division of labor: shape only; whether the ids resolve,
// and to nodes of the right type (subtopic_node_id must be a
// 'subtopic', destination_topic_id must be a 'topic'), is a
// service-layer concern (mcqService.moveSubtopicToTopic).
export const moveSubtopicToTopicSchema = z.object({
  body: z.object({
    subtopic_node_id: z
      .string()
      .regex(/^[a-f0-9]{24}$/i, 'subtopic_node_id must be a valid Mongo ObjectId'),
    destination_topic_id: z
      .string()
      .regex(/^[a-f0-9]{24}$/i, 'destination_topic_id must be a valid Mongo ObjectId'),
  }),
});

// ─── Bulk topic/subtopic reassign (Prompt 109) ─────────────────────
// Powers the Taxonomy Manager's rename modal — retags every MCQ under
// subject + from_topic (optionally narrowed to one from_subtopic) with
// a new topic and/or subtopic value in one call. `from_subtopic` /
// `to_subtopic` are nullable (not just optional) because the frontend
// always sends the key — `null` means "not applicable" (topic-level
// rename / leave subtopic untouched), while `''` is itself a valid,
// meaningful value (the "(none)" subtopic bucket). See mcq.service.js's
// bulkReassignTopic for how the two are told apart.
export const bulkReassignTopicSchema = z.object({
  body: z
    .object({
      subject: z.string().trim().min(1, 'subject is required'),
      from_topic: z.string().trim().min(1, 'from_topic is required'),
      to_topic: z.string().trim().min(1, 'to_topic is required'),
      from_subtopic: z.string().trim().nullable().optional(),
      to_subtopic: z.string().trim().nullable().optional(),
    })
    .refine(
      (data) =>
        data.to_topic.toLowerCase() !== data.from_topic.toLowerCase() ||
        (data.to_subtopic ?? null) !== null,
      {
        // from_subtopic alone only narrows WHICH rows match — it never
        // changes what gets written, so it can't rescue an otherwise
        // no-op rename on its own.
        message:
          'Nothing to rename: to_topic matches from_topic and no to_subtopic change was given',
        path: ['to_topic'],
      }
    ),
});
