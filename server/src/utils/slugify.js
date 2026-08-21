// Pure, dependency-free slug helper. Shared by TaxonomyNode.js's own
// slug-sync pre-validate hook and scripts/seedTaxonomyFromMcqs.js's node
// upserts — both MUST derive the exact same slug for the exact same
// name, or the seeder's idempotency check (matching on TaxonomyNode's
// own {type, parent_id, slug} unique index) would silently drift from
// what the model itself would compute for that name, defeating the
// whole point of scoping uniqueness by slug rather than raw name.
//
// Deliberately permissive: an empty string slugifies to '' rather than
// throwing or falling back to a placeholder like 'none' or 'untitled'.
// '' is MCQ.topic/subtopic's own real, meaningful "(none)" value (see
// MCQ.js's own `default: ''` comment) — TaxonomyNode needs to be able
// to represent that exact same bucket as a real, addressable node, not
// paper over it with an invented label.
export const slugify = (value) => {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
};

export default slugify;
