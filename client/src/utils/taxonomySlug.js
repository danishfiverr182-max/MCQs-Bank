// taxonomySlug.js — Prompt 16.
//
// Deliberate, line-for-line mirror of server/src/utils/slugify.js.
// validateNoDuplicateHierarchy (server/src/utils/taxonomyValidator.js,
// Prompt 12) rejects a move the instant the destination already has a
// child whose *slug* — not raw name — matches the node being moved.
// The move-destination pickers (MoveNodeModal, Prompt 16) need to
// exclude exactly those same destinations up front, per this prompt's
// own DoD ("the picker itself should not even offer a destination
// that validateTaxonomyMove would reject") — which means this function
// must slugify identically to the server, or the picker could either
// still offer a destination the server would then 409 on, or hide one
// that was actually fine. If server/src/utils/slugify.js ever changes,
// this must change with it.
export const slugify = (value) => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

export default slugify;
