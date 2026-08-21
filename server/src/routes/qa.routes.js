import { Router } from 'express';
import {
  runQA,
  getReport,
  getReportHistory,
  findSimilar,
  approveWithQA,
  dismissPair,
} from '../controllers/qa.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';

const router = Router();

// Every route requires an authenticated user; only the actions that
// mutate state (manual run, finalize, dismiss) additionally require
// admin — same split blueprint.routes.js / exam.routes.js already
// follow.
router.use(verifyJWT);

// Placed BEFORE /:testId/* routes so neither "similar" nor "pairs" is
// ever matched as a :testId param (same ordering trick
// blueprint.routes.js uses for /validate).
router.get('/similar/:questionId', findSimilar);
router.post('/pairs/dismiss', requireRole('admin'), dismissPair);

router.post('/:testId/run', requireRole('admin'), runQA);
router.get('/:testId/latest', getReport);
router.get('/:testId/history', getReportHistory);
router.post('/:testId/finalize', requireRole('admin'), approveWithQA);

export default router;
