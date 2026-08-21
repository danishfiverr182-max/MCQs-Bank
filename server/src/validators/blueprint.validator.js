import { z } from 'zod';
import { sumsMatch, findDuplicateSubjectNames } from '../utils/blueprintMath.js';

// ─── Shape (no cross-field checks yet — those are the .superRefine
// below) ────────────────────────────────────────────────────────
const blueprintShape = z.object({
  exam_id: z.string().trim().min(1, 'exam_id is required'),
  total_questions: z
    .number()
    .int('total_questions must be an integer')
    .positive('total_questions must be a positive integer'),
  subjects: z
    .array(
      z.object({
        name: z.string().trim().min(1, 'Subject name is required'),
        count: z
          .number()
          .int('Subject count must be an integer')
          .nonnegative('Subject count cannot be negative'),
      })
    )
    .min(1, 'At least one subject is required'),
  difficulty_distribution: z.object({
    easy: z.number().int().nonnegative(),
    medium: z.number().int().nonnegative(),
    hard: z.number().int().nonnegative(),
  }),
  selection_rules: z.object({}).passthrough().optional().default({}),
});

// ─── Cross-field validation, shared arithmetic ─────────────────────
// The actual sum/duplicate logic lives in utils/blueprintMath.js so
// blueprint.service.js's validateDistribution (Prompt 54) can re-run
// the exact same checks against a persisted document without going
// back through Zod — one source of truth for what "valid" means.
const applyBlueprintChecks = (data, ctx) => {
  const { subjectSum, difficultySum, subjectsMatch, difficultyMatch } = sumsMatch(
    data.subjects,
    data.difficulty_distribution,
    data.total_questions
  );

  if (!subjectsMatch) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjects'],
      message: `Subject counts sum to ${subjectSum}, expected ${data.total_questions}`,
    });
  }

  if (!difficultyMatch) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['difficulty_distribution'],
      message: `Difficulty distribution sums to ${difficultySum}, expected ${data.total_questions}`,
    });
  }

  const duplicates = findDuplicateSubjectNames(data.subjects);
  if (duplicates.length > 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['subjects'],
      message: `Duplicate subject name(s) found (case-insensitive): ${duplicates.join(', ')}`,
    });
  }
};

// ─── Used by both create and update ─────────────────────────────────
export const blueprintInputSchema = z.object({
  body: blueprintShape.superRefine(applyBlueprintChecks),
});

// ─── Clone overrides ─────────────────────────────────────────────
// All fields optional — cloning (Prompt 54/55) lets an admin tweak only
// some fields on the copy. NOTE: because every field is optional here,
// this schema intentionally does NOT re-run applyBlueprintChecks (a
// partial payload like { total_questions: 50 } alone can't be sum-
// checked in isolation). blueprint.service.js's cloneBlueprint merges
// overrides onto the source first, then calls validateDistribution on
// the merged, complete result — that's where the sum invariant is
// actually enforced for clones.
export const cloneOverridesSchema = z.object({
  body: blueprintShape.partial(),
});
