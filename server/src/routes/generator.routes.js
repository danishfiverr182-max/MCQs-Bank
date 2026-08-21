import { Router } from 'express';
import {
  generateTest,
  checkFeasibility,
  getTestById,
  listTests,
  deleteTest,
} from '../controllers/generator.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';
import validate from '../middleware/validate.middleware.js';
import { generateLimiter, feasibilityLimiter } from '../middleware/rateLimiter.middleware.js';
import {
  listTestsQuerySchema,
  testIdParamSchema,
} from '../validators/generator.validator.js';
import { generateWithOverridesSchema } from '../validators/generation.validator.js';

const router = Router();

// Every route requires an authenticated user; only writes (generate,
// check-feasibility, delete) additionally require admin — same split
// as blueprint.routes.js / exam.routes.js.
router.use(verifyJWT);

// Phase 7 (Prompt 76): both /generate and /check-feasibility validate
// against the full override schema (Prompt 71) — generateWithOverridesSchema
// replaces Phase 6's minimal generateTestSchema here. check-feasibility
// deliberately shares the exact same body schema as generate: it's a
// pure pre-flight version of the same request (same exam_id /
// blueprint_id / overrides), just without any side effects.
router.post(
  '/generate',
  generateLimiter,
  requireRole('admin'),
  validate(generateWithOverridesSchema),
  generateTest
);
router.post(
  '/check-feasibility',
  feasibilityLimiter,
  requireRole('admin'),
  validate(generateWithOverridesSchema),
  checkFeasibility
);
router.get('/', validate(listTestsQuerySchema), listTests);
router.get('/:testId', validate(testIdParamSchema), getTestById);
router.delete('/:testId', requireRole('admin'), validate(testIdParamSchema), deleteTest);

export default router;
