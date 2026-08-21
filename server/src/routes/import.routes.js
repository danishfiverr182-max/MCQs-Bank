import { Router } from 'express';
import {
  uploadBulk,
  validateOnly,
  resolveDuplicates,
  getImportHistory,
  deleteBatch,
  getPromptState,
  updatePromptSettings,
  resetPromptRange,
} from '../controllers/import.controller.js';
import { uploadJSON, handleUploadErrors } from '../middleware/upload.middleware.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';
import validate from '../middleware/validate.middleware.js';
import {
  updatePromptSettingsSchema,
  resetPromptRangeSchema,
} from '../validators/promptState.validator.js';

const router = Router();

// Applied once — every route below inherits both guards, same pattern
// as mcq.routes.js.
router.use(verifyJWT, requireRole('admin'));

router.post('/bulk', uploadJSON, handleUploadErrors, uploadBulk);
router.post('/validate', uploadJSON, handleUploadErrors, validateOnly);
router.post('/resolve', resolveDuplicates);
router.get('/history', getImportHistory);
// MCQ Conversion Prompt state (purely additive — see
// promptState.service.js). Placed before '/:batchId' for the same
// "before the param route" reason mcq.routes.js's '/stats'/'/topics'
// block already follows, since '/:batchId' would otherwise swallow
// '/prompt-state' as a batchId value.
router.get('/prompt-state', getPromptState);
router.put('/prompt-state/settings', validate(updatePromptSettingsSchema), updatePromptSettings);
router.post('/prompt-state/reset', validate(resetPromptRangeSchema), resetPromptRange);
router.delete('/:batchId', deleteBatch);

export default router;
