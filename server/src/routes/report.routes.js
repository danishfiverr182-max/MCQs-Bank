import { Router } from 'express';
import {
  exportTestJSON,
  exportTestWebsiteImport,
  exportTestCSV,
  exportTestPDF,
  generateBlueprintReport,
} from '../controllers/report.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';

const router = Router();

// Prompt 96 calls for "requireAdmin" on every route — same naming gap
// already noted in analytics.routes.js (Prompt 95). This codebase has no
// middleware by that name; every admin-only router composes verifyJWT +
// requireRole('admin') instead. Applied once for the whole router since
// every report endpoint here is admin-only with no exceptions.
router.use(verifyJWT, requireRole('admin'));

router.get('/test/:testId/json', exportTestJSON);
router.get('/test/:testId/website-import', exportTestWebsiteImport);
router.get('/test/:testId/csv', exportTestCSV);
router.get('/test/:testId/pdf', exportTestPDF);
router.get('/blueprint/:blueprintId', generateBlueprintReport);

export default router;
