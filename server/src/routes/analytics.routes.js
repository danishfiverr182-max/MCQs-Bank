import { Router } from 'express';
import {
  getOverview,
  getSubjectStats,
  getDifficultyStats,
  getMCQExposure,
  getGenerationHistory,
  getTrends,
  getActivityLogs,
} from '../controllers/analytics.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';
import validate from '../middleware/validate.middleware.js';
import {
  subjectStatsQuerySchema,
  exposureQuerySchema,
  generationHistoryQuerySchema,
  activityLogsQuerySchema,
} from '../validators/analytics.validator.js';

const router = Router();

// Prompt 95 calls for "requireAdmin" on every route, but this codebase
// has no middleware by that name — every existing admin-only router
// (mcq.routes.js, import.routes.js) composes verifyJWT +
// requireRole('admin') instead. Same pattern here, applied once for the
// whole router since every analytics endpoint is admin-only with no
// exceptions (unlike exam.routes.js/blueprint.routes.js, which open some
// GETs to any authenticated user).
router.use(verifyJWT, requireRole('admin'));

router.get('/overview', getOverview);
router.get('/subjects', validate(subjectStatsQuerySchema), getSubjectStats);
router.get('/difficulty', getDifficultyStats);
router.get('/exposure', validate(exposureQuerySchema), getMCQExposure);
router.get('/generation-history', validate(generationHistoryQuerySchema), getGenerationHistory);
router.get('/trends', getTrends);
router.get('/activity-logs', validate(activityLogsQuerySchema), getActivityLogs);

export default router;
