import { z } from 'zod';

// generation.validator.js — Phase 7, Prompt 71.
//
// Pure schema only. Nothing here imports generator.service.js or talks
// to the DB — every cross-check that needs the blueprint's own data
// (does `subjects` name a real blueprint subject? do `topics` exist in
// the DB? does `question_count` require rescaling subject counts?) is
// explicitly deferred to Prompt 72's merge logic in the service layer.
// This file only validates *shape*.
//
// This replaces the ad-hoc inline schema in generator.validator.js's
// `generateTestSchema` (Prompt 66) — Prompt 76's controller will point
// at `generateWithOverridesSchema` instead.

// ─── Overrides shape ───────────────────────────────────────────────
// Every field is `.optional()` by design: overrides are partial, an
// admin may set only one and let everything else fall back to the
// blueprint's own values.
export const generationOverridesSchema = z
  .object({
    // Overrides the blueprint's `total_questions`. Conceptually there
    // is no default — omitted means "use the blueprint's total".
    // NOTE for Prompt 72: when this is present, the merge logic must
    // proportionally rescale the blueprint's subject counts too, since
    // those counts are only meaningful relative to the blueprint's own
    // total_questions — a raw copy-through would no longer sum right.
    question_count: z
      .number()
      .int('question_count must be an integer')
      .positive('question_count must be a positive integer')
      .optional(),

    // 'mixed' (the conceptual default when omitted) means "use the
    // blueprint's own easy/medium/hard distribution unchanged". A
    // single value like 'hard' is a genuinely different shape — it
    // means "every selected question this run should be hard" — not a
    // shorthand for a distribution. Prompt 73's per-bucket calculation
    // branches on which of these two shapes it received.
    difficulty: z
      .union([z.enum(['easy', 'medium', 'hard']), z.literal('mixed')])
      .optional(),

    // When supplied, generation is restricted to this subset of the
    // blueprint's subject list. Must name at least one subject if
    // present at all — an empty array is meaningless as a restriction
    // and is rejected here. Whether each name actually exists on the
    // blueprint is a service-layer check (Prompt 72), not this one.
    subjects: z
      .array(z.string().trim().min(1))
      .min(1, 'subjects must contain at least one subject if provided')
      .optional(),

    // Further narrows within whichever subjects are in play. Shape-only
    // here; cross-checking against real DB topic values happens in the
    // service layer (Prompt 72), same as `subjects`.
    topics: z.array(z.string().trim().min(1)).optional(),

    // "Topics to Include" — guarantees AT LEAST this many MCQs from
    // each named topic within a subject, before the rest of that
    // subject's count is filled randomly. Keyed by subject name; each
    // subject's array must name topics only once (duplicate topic
    // entries for the same subject are a shape error, not silently
    // summed) — the actual "does this exceed the subject's total
    // count" cross-check happens in acceptOverrides, same deferral
    // pattern as `subjects`/`topics` above. Completely optional — a
    // request with no topic_requirements key behaves exactly as
    // generation already does today.
    topic_requirements: z
      .record(
        z
          .array(
            z.object({
              topic: z.string().trim().min(1, 'topic is required'),
              count: z.number().int().positive('count must be a positive integer'),
            })
          )
          .min(1)
          .superRefine((requirements, ctx) => {
            const seen = new Set();
            requirements.forEach((r, i) => {
              if (seen.has(r.topic)) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: `Duplicate topic "${r.topic}" — combine into a single entry instead`,
                  path: [i, 'topic'],
                });
              }
              seen.add(r.topic);
            });
          })
      )
      .optional(),

    quality_threshold: z
      .number()
      .min(0, 'quality_threshold must be between 0 and 100')
      .max(100, 'quality_threshold must be between 0 and 100')
      .optional(),

    // Renamed from exclude_recent_days — now counts TESTS, not days
    // (see fetchRecentlyUsedMcqIds in generator.service.js for why).
    exclude_recent_tests: z
      .number()
      .int('exclude_recent_tests must be an integer')
      .nonnegative('exclude_recent_tests cannot be negative')
      .optional(),

    // Order randomization is normally desired; the conceptual default
    // when omitted is `true`. Explicit `false` is the meaningful
    // override — e.g. a past-paper-priority-sorted order where random
    // shuffling would undo the intended ordering.
    randomize: z.boolean().optional(),

    // Conceptual default `false` when omitted.
    past_paper_priority: z.boolean().optional(),

    // Intentionally open-ended per the system spec's "Custom Rules"
    // option. This is a deliberate pass-through, not a TODO left
    // incomplete — interpretation is out of scope until a concrete
    // custom-rule type is defined. Only checked here for being a
    // plain object.
    custom_rules: z.record(z.any()).optional().default({}),
  });

// ─── generateWithOverridesSchema ───────────────────────────────────
// Wraps generationOverridesSchema together with the existing required
// `exam_id` and optional `blueprint_id` fields from Phase 6, so Prompt
// 76's controller has a single schema to validate the full request
// body against.
export const generateWithOverridesSchema = z.object({
  body: z
    .object({
      exam_id: z.string().trim().min(1, 'exam_id is required'),
      blueprint_id: z.string().trim().min(1).optional(),
    })
    .merge(generationOverridesSchema),
});
