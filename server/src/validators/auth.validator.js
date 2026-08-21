import { z } from 'zod';

// Nested under `body` so validate.middleware.js can validate
// req.body, req.query, and req.params with one consistent shape,
// without changing the middleware signature per-schema.
export const loginSchema = z.object({
  body: z.object({
    email: z.string().trim().toLowerCase().email('Invalid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
  }),
});
