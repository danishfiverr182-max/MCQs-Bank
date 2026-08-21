// Shared pagination contract (Prompt 103) — the ONE pagination shape
// every list endpoint should return going forward.
//
// NOTE: this codebase already had an older `utils/paginator.js` (from
// Phase 3) with a slightly different shape (`{ total, hasNextPage: page <
// totalPages, ... }`, no `skip` returned). That file is left in place
// untouched — nothing currently importing it is being migrated off it in
// this prompt beyond the three call sites explicitly listed in the spec
// (MCQ list, Test list, Activity Log) — but new/future list endpoints
// should use THIS file, not paginator.js, so the codebase converges on
// one contract instead of accumulating a second one silently.

export const parsePagination = (query = {}, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(query.limit, 10) || defaultLimit));
  const skip = (page - 1) * limit;

  return { page, limit, skip };
};

export const buildPaginatedResponse = (data, totalCount, { page, limit }) => ({
  data,
  pagination: {
    page,
    limit,
    totalCount,
    totalPages: Math.ceil(totalCount / limit),
    hasNextPage: page * limit < totalCount,
    hasPrevPage: page > 1,
  },
});
