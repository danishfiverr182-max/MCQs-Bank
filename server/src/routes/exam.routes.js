import { Router } from 'express';
import {
  createExam,
  getExam,
  updateExam,
  deleteExam,
  toggleStatus,
  listByOrg,
} from '../controllers/exam.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';
import validate from '../middleware/validate.middleware.js';
import {
  createExamSchema,
  updateExamSchema,
  examIdParamSchema,
  examQuerySchema,
} from '../validators/exam.validator.js';

const router = Router();

// Every route requires an authenticated user; only writes additionally
// require admin. Applied per-route (unlike mcq.routes.js's blanket
// router.use) since GET here is intentionally open to any authenticated
// user, not just admins.
router.use(verifyJWT);

router.get('/', validate(examQuerySchema), listByOrg);
router.post('/', requireRole('admin'), validate(createExamSchema), createExam);
router.get('/:examId', validate(examIdParamSchema), getExam);
router.put(
  '/:examId',
  requireRole('admin'),
  validate(examIdParamSchema),
  validate(updateExamSchema),
  updateExam
);
router.delete('/:examId', requireRole('admin'), validate(examIdParamSchema), deleteExam);
router.patch(
  '/:examId/status',
  requireRole('admin'),
  validate(examIdParamSchema),
  toggleStatus
);

export default router;
