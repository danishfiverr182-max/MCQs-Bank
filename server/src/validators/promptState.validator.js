import { z } from 'zod';

// ─── Update prompt settings (PUT /import/prompt-state/settings) ────
// Both fields optional (a caller may want to change just one), but
// each must be a positive integer WHEN present — promptState.service.js's
// updateSettings itself enforces the cross-field totalCap >= batchSize
// rule (it needs the CURRENT persisted value for whichever field is
// omitted here, which this schema has no way to see), so that check is
// deliberately left to the service layer, same division of labor
// mcq.validator.js's shape-only ObjectId schemas already draw against
// their own service-layer checks.
export const updatePromptSettingsSchema = z.object({
  body: z
    .object({
      batchSize: z.coerce.number().int().positive('batchSize must be a positive integer').optional(),
      totalCap: z.coerce.number().int().positive('totalCap must be a positive integer').optional(),
    })
    .refine((data) => data.batchSize !== undefined || data.totalCap !== undefined, {
      message: 'At least one of batchSize or totalCap must be provided',
    }),
});

// ─── Reset prompt range (POST /import/prompt-state/reset) ──────────
// rangeStart is optional — promptState.service.js's resetRange treats
// an omitted value as "restart at 1" (see that function's own
// `rangeStart ?? 1`), so this schema only needs to guard the shape of
// whatever IS provided, not require it.
export const resetPromptRangeSchema = z.object({
  body: z.object({
    rangeStart: z.coerce.number().int().positive('rangeStart must be a positive integer').optional(),
  }),
});
