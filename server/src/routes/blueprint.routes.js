import { Router } from 'express';
import {
  createBlueprint,
  updateBlueprint,
  deleteBlueprint,
  cloneBlueprintHandler,
  setActive,
  validateBlueprint,
  getBlueprintsByExam,
  getBlueprint,
} from '../controllers/blueprint.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';
import validate from '../middleware/validate.middleware.js';
import { blueprintInputSchema } from '../validators/blueprint.validator.js';

const router = Router();

// Every route requires an authenticated user; only writes additionally
// require admin — same split as exam.routes.js.
router.use(verifyJWT);

// Placed BEFORE /:blueprintId so "validate" is never matched as a
// :blueprintId param (mirrors mcq.routes.js's /stats-before-/:id trick).
router.post(
  '/validate',
  requireRole('admin'),
  // Deliberately NOT validate(blueprintInputSchema) here — this route
  // must accept a genuinely partial payload while the admin is still
  // typing in the builder; the controller runs its own defensive checks.
  validateBlueprint
);

router.post('/', requireRole('admin'), validate(blueprintInputSchema), createBlueprint);
router.get('/exam/:examId', getBlueprintsByExam);
router.get('/:blueprintId', getBlueprint);
router.put(
  '/:blueprintId',
  requireRole('admin'),
  validate(blueprintInputSchema),
  updateBlueprint
);
router.delete('/:blueprintId', requireRole('admin'), deleteBlueprint);
router.post('/:blueprintId/clone', requireRole('admin'), cloneBlueprintHandler);
router.patch('/:blueprintId/activate', requireRole('admin'), setActive);

export default router;
