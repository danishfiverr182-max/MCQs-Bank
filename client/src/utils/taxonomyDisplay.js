// taxonomyDisplay.js — Prompt 16.
//
// Display label for the model's own '' default — a real, addressable
// TaxonomyNode (the "(none)" bucket, see TaxonomyNode.js's own
// comment on why '' is a legitimate topic/subtopic value), never
// filtered out anywhere, just relabeled here for readability. Was
// previously a local function inside TaxonomyManager.jsx (Prompt 109);
// pulled out so the rename/move modals and the shared diff preview
// (new in Prompt 16) render the exact same label for the exact same
// value instead of each re-deriving their own "empty string" fallback.
export const displayName = (name) => (name && name.trim().length > 0 ? name : '(none)');

// Joins a subject/topic/subtopic path into the "A → B → C" string used
// throughout the rename/move modals and the diff preview, skipping any
// falsy (undefined/null) segment — NOT skipping '' values, since '(none)'
// (via displayName above) is itself a meaningful path segment that must
// still show up between its own arrows.
export const joinTaxonomyPath = (segments) => segments.filter((s) => s !== undefined && s !== null).join(' → ');
