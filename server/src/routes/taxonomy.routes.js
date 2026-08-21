import { Router } from 'express';
import {
  previewTaxonomyOperation,
  getTaxonomyDeletePreview,
  getTaxonomyDeletePreviewBulk,
} from '../controllers/taxonomy.controller.js';
import verifyJWT from '../middleware/auth.middleware.js';
import requireRole from '../middleware/role.middleware.js';
import validate from '../middleware/validate.middleware.js';
import {
  previewTaxonomySchema,
  deletePreviewParamsSchema,
  deletePreviewBulkQuerySchema,
} from '../validators/taxonomy.validator.js';

const router = Router();

// Same admin-only guard every taxonomy-mutating route already carries
// under /api/mcqs (see mcq.routes.js) — a preview reads real MCQ/
// TaxonomyNode data and, for merge/delete, runs the full match/count
// query against it, so it gets the same access level as the mutations
// it's previewing.
router.use(verifyJWT, requireRole('admin'));

// Feature 13 (Prompt 10): single dry-run endpoint for all 6 taxonomy
// mutations (rename / move_topic / move_subject / move_subtopic /
// merge / delete) — see taxonomy.controller.js's
// previewTaxonomyOperation for the dispatch.
router.post('/preview', validate(previewTaxonomySchema), previewTaxonomyOperation);

// Prompt 18: DeleteNodeModal's own first-step counts (topic/subtopic/
// MCQ), read BEFORE an on_orphan_mcqs choice exists to preview the
// full delete operation above with — see taxonomy.controller.js's
// getTaxonomyDeletePreview for why this can't just be the 'delete'
// branch of POST /preview.
router.get('/delete-preview/:nodeId', validate(deletePreviewParamsSchema), getTaxonomyDeletePreview);

// Prompt 20 (Bulk Select, Feature 12): the bulk counterpart, placed
// directly after its single-node sibling for the same reason. Must
// come before the '/:nodeId' route above would ever be a concern if
// this were path-based — it isn't (query string), but kept adjacent
// for readability.
router.get('/delete-preview-bulk', validate(deletePreviewBulkQuerySchema), getTaxonomyDeletePreviewBulk);

export default router;
