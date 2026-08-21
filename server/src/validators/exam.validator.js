import { z } from 'zod';

// ─── Shared enums ────────────────────────────────────────────────
const statusEnum = z.enum(['active', 'inactive']);

// ─── Create ──────────────────────────────────────────────────────
// NOTE FOR PROMPT 52: `exam_id` and `status` are intentionally absent
// from this shape. If a client sends them anyway, the route MUST use
// `validate(createExamSchema)` with a schema that `.strip()`s unknown
// keys (Zod objects strip by default unless `.passthrough()` was used
// anywhere in the chain) so a client-supplied `exam_id`/`status` is
// silently dropped rather than trusted. `exam_id` is always derived
// server-side; `status` always defaults to `active` on creation.
export const createExamSchema = z.object({
  body: z.object({
    exam_name: z.string().trim().min(3, 'exam_name must be at least 3 characters'),
    // Normalized to uppercase in the service layer, not here — the
    // validator only checks shape, not casing.
    organization: z.string().trim().min(2, 'organization must be at least 2 characters'),
    description: z.string().trim().optional().default(''),
    tags: z.array(z.string().trim()).optional().default([]),
  }),
});

// ─── Update (partial) ─────────────────────────────────────────────
// Same shape as create but every field optional, plus `status` — unlike
// creation, editing an exam CAN flip status directly. `exam_id` is still
// never accepted here; the controller rejects any attempt to change it.
export const updateExamSchema = z.object({
  body: z
    .object({
      exam_name: z.string().trim().min(3, 'exam_name must be at least 3 characters'),
      organization: z.string().trim().min(2, 'organization must be at least 2 characters'),
      description: z.string().trim(),
      tags: z.array(z.string().trim()),
      status: statusEnum,
    })
    .partial()
    .refine((data) => Object.keys(data).length > 0, {
      message: 'At least one field must be provided for update',
    }),
});

// ─── Route param ───────────────────────────────────────────────────
export const examIdParamSchema = z.object({
  params: z.object({
    examId: z.string().min(1, 'examId param is required'),
  }),
});

// ─── List query (?status=active) ────────────────────────────────────
export const examQuerySchema = z.object({
  query: z.object({
    status: statusEnum.optional(),
  }),
});
