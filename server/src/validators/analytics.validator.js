import { z } from 'zod';

// analytics.validator.js — not explicitly listed in Prompt 95's file
// list, but added anyway to match how every other query-param-accepting
// route in this system validates (mcq.validator.js's mcqQuerySchema,
// generator.validator.js's listTestsQuerySchema, etc.). Doing the
// "malformed query params shouldn't crash the server" requirement by
// hand in the controller would just be a worse reimplementation of what
// validate.middleware.js + zod already give every other route for free.

// ─── GET /subjects ───────────────────────────────────────────────────
export const subjectStatsQuerySchema = z.object({
  query: z.object({
    blueprintId: z.string().trim().min(1).optional(),
  }),
});

// ─── GET /exposure ────────────────────────────────────────────────────
export const exposureQuerySchema = z.object({
  query: z.object({
    type: z.enum(['top', 'least', 'never']).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional().default(20),
  }),
});

// ─── GET /generation-history ─────────────────────────────────────────
export const generationHistoryQuerySchema = z.object({
  query: z.object({
    // z.coerce.number() on something genuinely unusable (e.g.
    // 'months=abc') fails validation -> validate.middleware.js's 400,
    // rather than reaching the service as NaN.
    months: z.coerce.number().int().min(1).max(36).optional().default(12),
    examId: z.string().trim().optional(),
  }),
});

// ─── GET /activity-logs ───────────────────────────────────────────────
// Prompt 100. Every field optional — an admin browsing the log with no
// filters set at all is the default, most common case.
export const activityLogsQuerySchema = z.object({
  query: z.object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(200).optional().default(25),
    action: z
      .enum([
        'mcq_created',
        'mcq_updated',
        'mcq_deleted',
        'mcq_bulk_imported',
        'mcq_approved',
        'mcq_rejected',
        'mcq_merged',
        'blueprint_created',
        'blueprint_updated',
        'blueprint_deleted',
        'blueprint_cloned',
        'exam_created',
        'exam_updated',
        'exam_deleted',
        'test_generated',
        'test_finalized',
        'qa_run',
        'qa_finalize_blocked',
        'admin_login',
        'admin_logout',
      ])
      .optional(),
    entityType: z.enum(['MCQ', 'Blueprint', 'Exam', 'Test', 'QAReport', 'Auth']).optional(),
    actorId: z.string().trim().min(1).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
  }),
});
