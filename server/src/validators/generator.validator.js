import { z } from 'zod';

// Small enough surface to live alongside the two schemas it serves —
// same "implementer's choice" call the prompt allows, kept as its own
// file (rather than inline in the controller) purely to match every
// other route's validate(schema) middleware pattern in this codebase.

// ─── POST /generate ─────────────────────────────────────────────────
export const generateTestSchema = z.object({
  body: z.object({
    exam_id: z.string().trim().min(1, 'exam_id is required'),
    // Optional override blueprint_id — Prompt 62's resolveBlueprint
    // "OR use override blueprint_id" branch.
    blueprint_id: z.string().trim().min(1).optional(),
    quality_threshold: z.number().min(0).max(100).optional(),
    difficulty_override: z
      .object({
        easy: z.number().int().nonnegative(),
        medium: z.number().int().nonnegative(),
        hard: z.number().int().nonnegative(),
      })
      .optional(),
    excluded_recent_days: z.number().int().positive().optional(),
  }),
});

// ─── GET / (list) ────────────────────────────────────────────────────
// Prompt 88 addition: `search` (partial, case-insensitive test_id
// match — powers QADashboard.jsx's test picker), `qa_checked` (when
// 'true', restricts to tests whose latest_qa_status is anything OTHER
// than 'not_run' — powers the "Recent QA Activity" feed), and
// `sortBy` (defaults to the original generated_at; 'updated_at' lets
// that same activity feed surface the most RECENTLY QA'd tests first,
// since a manual re-run bumps updated_at without changing
// generated_at).
export const listTestsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    exam_id: z.string().trim().optional(),
    status: z.enum(['completed', 'failed']).optional(),
    search: z.string().trim().optional(),
    qa_checked: z.enum(['true', 'false']).optional(),
    sortBy: z.enum(['generated_at', 'updated_at']).optional().default('generated_at'),
  }),
});

// ─── GET /:testId, DELETE /:testId ──────────────────────────────────
export const testIdParamSchema = z.object({
  params: z.object({
    testId: z.string().trim().min(1, 'testId is required'),
  }),
});
