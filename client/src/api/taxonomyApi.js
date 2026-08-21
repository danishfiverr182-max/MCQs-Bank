import apiClient from '@/lib/axios';

// taxonomyApi.js — Prompt 16.
//
// The rename/move modals (RenameNodeModal, MoveNodeModal) need two
// calls each, back to back: a preview (Prompt 10's single dry-run
// endpoint, POST /api/taxonomy/preview) to render the diff, then — only
// once the admin explicitly confirms — the real node-id-based mutation
// route from Prompts 4-7. Centralized here rather than inlined in each
// modal so both modals (and Prompts 17-18's merge/delete modals, later)
// hit the exact same endpoints/timeouts.
//
// 60s timeout mirrors the existing bulk-reassign-topic call this
// replaces (see TaxonomyManager.jsx's former RenameModal) — every one
// of these mutations runs an `MCQ.updateMany` across a match filter
// with no upper bound on affected rows, same "genuinely still working,
// just slow on a big bank" reasoning.
const MUTATION_TIMEOUT = 60000;
// CORRECTION (Taxonomy page speed pass): the comment this replaces
// claimed preview only ran "cheap match/count queries" and left it on
// the shared 10s axios default. That's wrong — every one of the 10
// preview branches (rename/3x move/merge/delete, plus bulk) calls the
// exact same unbounded `getTaxonomy()` full-collection aggregation the
// main tree GET does (see mcq.service.js), just to build the "current
// -> new" diff. On a real-sized bank that read alone measured 8-17s in
// practice — well past the shared 10s default — so the browser was
// silently ABORTING the request client-side before the server even
// finished, surfacing as a generic "Network error — check your
// connection" with nothing in the server log at all (the request was
// still running when the client gave up on it). Same 120s override the
// main taxonomy GET already uses (TaxonomyManager.jsx), for the same
// "genuinely still working, just slow" reason — preview reads the
// identical data.
const PREVIEW_TIMEOUT = 120000;

// POST /api/taxonomy/preview — one endpoint for all 6 taxonomy
// mutations, dispatched by `operation`. `payload` is the EXACT body
// shape the real mutation route for that operation expects (see
// taxonomy.validator.js's previewTaxonomySchema — it reuses those
// schemas directly), so whatever a modal sends here is guaranteed to
// be shape-compatible with the real commit call below.
export const previewTaxonomyOperation = (operation, payload) =>
  apiClient.post('/taxonomy/preview', { operation, payload }, { timeout: PREVIEW_TIMEOUT });

// PATCH /api/mcqs/taxonomy/rename-node (Taxonomy P4)
export const renameTaxonomyNode = (payload) =>
  apiClient.patch('/mcqs/taxonomy/rename-node', payload, { timeout: MUTATION_TIMEOUT });

// PATCH /api/mcqs/taxonomy/move-topic (Taxonomy P5)
export const moveTopicToSubject = (payload) =>
  apiClient.patch('/mcqs/taxonomy/move-topic', payload, { timeout: MUTATION_TIMEOUT });

// PATCH /api/mcqs/taxonomy/move-subject-into-subject (Taxonomy P6)
export const moveSubjectIntoSubject = (payload) =>
  apiClient.patch('/mcqs/taxonomy/move-subject-into-subject', payload, { timeout: MUTATION_TIMEOUT });

// PATCH /api/mcqs/taxonomy/move-subtopic (Taxonomy P7)
export const moveSubtopicToTopic = (payload) =>
  apiClient.patch('/mcqs/taxonomy/move-subtopic', payload, { timeout: MUTATION_TIMEOUT });

// PATCH /api/mcqs/taxonomy/merge-nodes (Taxonomy P8) — MergeNodesModal's
// "Confirm merge" step, same shape as `payload` sent to
// previewTaxonomyOperation('merge', payload) above: { node_ids, keep_name }.
export const mergeTaxonomyNodes = (payload) =>
  apiClient.patch('/mcqs/taxonomy/merge-nodes', payload, { timeout: MUTATION_TIMEOUT });

// GET /api/taxonomy/delete-preview/:nodeId (Taxonomy P9) —
// DeleteNodeModal's first step: topic/subtopic/MCQ counts, read BEFORE
// an on_orphan_mcqs choice exists to run the full dry-run preview
// below with. Read-only, and genuinely cheap (count queries against
// this one node's own subtree, not the full-collection getTaxonomy()
// previewTaxonomyOperation above has to run) — the shared 10s axios
// default is correct here, unlike the correction just above.
export const getTaxonomyDeletePreview = (nodeId) => apiClient.get(`/taxonomy/delete-preview/${nodeId}`);

// DELETE /api/mcqs/taxonomy/node (Taxonomy P9) — DeleteNodeModal's
// "Confirm delete" step. `payload`: { node_id, on_orphan_mcqs: {
// action: 'move', destination_node_id } | { action: 'delete' } } —
// same shape sent to previewTaxonomyOperation('delete', payload).
// DELETE with a JSON body needs `data`, not a positional arg, in axios.
export const deleteTaxonomyNode = (payload) =>
  apiClient.delete('/mcqs/taxonomy/node', { data: payload, timeout: MUTATION_TIMEOUT });

// ─── Move-kind lookup tables ──────────────────────────────────────────
// MoveNodeModal is one component reused for all three reparenting
// moves (Prompt 16's own DoD). These two maps are what let it stay
// generic: given just `kind` ('subject' | 'topic' | 'subtopic'), look
// up which `operation` string the preview endpoint expects and which
// function above actually commits it, instead of a three-way
// if/else-if repeated at both call sites.
export const MOVE_OPERATION_BY_KIND = {
  subject: 'move_subject',
  topic: 'move_topic',
  subtopic: 'move_subtopic',
};

export const MOVE_MUTATION_BY_KIND = {
  subject: moveSubjectIntoSubject,
  topic: moveTopicToSubject,
  subtopic: moveSubtopicToTopic,
};

// Builds the exact body shape both the preview endpoint's `payload` and
// the real mutation route expect for a given move `kind` — one place
// so MoveNodeModal never has to remember which field name belongs to
// which kind (`topic_node_id` vs `subject_node_id` vs
// `subtopic_node_id`, all paired with a `destination_*_id`).
export const buildMovePayload = (kind, nodeId, destinationId) => {
  if (kind === 'subject') {
    return { subject_node_id: nodeId, destination_subject_id: destinationId };
  }
  if (kind === 'topic') {
    return { topic_node_id: nodeId, destination_subject_id: destinationId };
  }
  return { subtopic_node_id: nodeId, destination_topic_id: destinationId };
};

// ─── Bulk move / bulk delete (Prompt 20 — Bulk Select, Feature 12) ────
// TaxonomyManager's checkbox multi-select feeds these once an admin
// checks 2+ same-type nodes and picks "Move" or "Delete" — Merge
// already took `node_ids` arrays since Prompt 17 (mergeTaxonomyNodes
// above, unchanged, works for bulk merge as-is).

// PATCH /api/mcqs/taxonomy/move-topic-bulk
export const moveTopicsToSubjectBulk = (payload) =>
  apiClient.patch('/mcqs/taxonomy/move-topic-bulk', payload, { timeout: MUTATION_TIMEOUT });

// PATCH /api/mcqs/taxonomy/move-subject-into-subject-bulk
export const moveSubjectsIntoSubjectBulk = (payload) =>
  apiClient.patch('/mcqs/taxonomy/move-subject-into-subject-bulk', payload, { timeout: MUTATION_TIMEOUT });

// PATCH /api/mcqs/taxonomy/move-subtopic-bulk
export const moveSubtopicsToTopicBulk = (payload) =>
  apiClient.patch('/mcqs/taxonomy/move-subtopic-bulk', payload, { timeout: MUTATION_TIMEOUT });

// DELETE /api/mcqs/taxonomy/node-bulk — DeleteNodeModal's bulk "Confirm
// delete" step. `payload`: { node_ids, on_orphan_mcqs: { action: 'move',
// destination_node_id } | { action: 'delete' } } — the SAME
// on_orphan_mcqs choice applied to every node_id (see
// bulkDeleteTaxonomyNodes's own header comment in taxonomy.service.js).
export const deleteTaxonomyNodeBulk = (payload) =>
  apiClient.delete('/mcqs/taxonomy/node-bulk', { data: payload, timeout: MUTATION_TIMEOUT });

// GET /api/taxonomy/delete-preview-bulk?nodeIds=a,b,c — the bulk
// counterpart of getTaxonomyDeletePreview above, summed across every
// selected node.
export const getTaxonomyDeletePreviewBulk = (nodeIds) =>
  apiClient.get('/taxonomy/delete-preview-bulk', { params: { nodeIds: nodeIds.join(',') } });

// Bulk counterparts of MOVE_OPERATION_BY_KIND / MOVE_MUTATION_BY_KIND
// above — same generic-by-`kind` reasoning, just the preview
// `operation` string and commit function each bulk move uses instead.
export const MOVE_BULK_OPERATION_BY_KIND = {
  subject: 'move_subject_bulk',
  topic: 'move_topic_bulk',
  subtopic: 'move_subtopic_bulk',
};

export const MOVE_BULK_MUTATION_BY_KIND = {
  subject: moveSubjectsIntoSubjectBulk,
  topic: moveTopicsToSubjectBulk,
  subtopic: moveSubtopicsToTopicBulk,
};

// The bulk sibling of buildMovePayload above — same field-name mapping,
// just an array of source ids (`*_node_ids`, plural) instead of one.
export const buildBulkMovePayload = (kind, nodeIds, destinationId) => {
  if (kind === 'subject') {
    return { subject_node_ids: nodeIds, destination_subject_id: destinationId };
  }
  if (kind === 'topic') {
    return { topic_node_ids: nodeIds, destination_subject_id: destinationId };
  }
  return { subtopic_node_ids: nodeIds, destination_topic_id: destinationId };
};
