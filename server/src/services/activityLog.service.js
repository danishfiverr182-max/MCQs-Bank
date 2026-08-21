import ActivityLog from '../models/ActivityLog.js';
import ApiError from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { buildPaginatedResponse } from '../utils/pagination.js';

// activityLog.service.js — Prompt 91. The one place that writes
// ActivityLog rows. Called either directly from a controller that wants
// full control over the summary/diff (e.g. auth.controller.js on
// login/logout), or automatically by activityLogger.middleware.js
// (Prompt 92) as a safety net for plain CRUD routes.

// Shallow diff: only keys that changed, keyed by field name, each holding
// { from, to }. Deliberately one level deep — see ActivityLog.js's
// details.before/after comment for why full nested snapshots are not
// worth the storage cost here. `before`/`after` are plain objects the
// caller has already trimmed to "the fields that matter" (e.g. a
// controller passes the pre-update and post-update MCQ.toObject(), not
// the whole document by reference).
const shallowDiff = (before, after) => {
  if (!before || !after) return { before: before ?? null, after: after ?? null };

  const changedBefore = {};
  const changedAfter = {};

  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);

  for (const key of keys) {
    const beforeValue = before[key];
    const afterValue = after[key];

    // JSON.stringify comparison is enough here: these are plain,
    // already-trimmed objects (strings/numbers/booleans/small nested
    // objects), not documents with methods or circular refs.
    if (JSON.stringify(beforeValue) !== JSON.stringify(afterValue)) {
      changedBefore[key] = beforeValue;
      changedAfter[key] = afterValue;
    }
  }

  return { before: changedBefore, after: changedAfter };
};

// createLog — never throws, UNLESS a `session` is supplied. Logging is
// normally a side effect: a broken log write must never break the admin
// action it is trying to record, so every code path is wrapped in
// try/catch and any failure goes to logger.error and resolves to null
// rather than rejecting.
//
// The one exception (Prompt 11 — Feature 14): when `session` is passed,
// the caller is taxonomy.service.js's `withTaxonomyTransaction`, and
// this write is one of SEVERAL atomic operations (TaxonomyNode + MCQ +
// Blueprint + this log row) that must all commit or all roll back
// together — see that file's own header comment. A swallowed failure
// there would silently commit the TaxonomyNode/MCQ/Blueprint writes
// with no audit row at all, which is exactly the "half-applied" outcome
// Prompt 11 exists to rule out. So: `session` present -> failures are
// re-thrown (propagating up through `session.withTransaction`, aborting
// everything else in that transaction too) instead of swallowed. Every
// other call site (auth.controller.js, activityLogger.middleware.js's
// post-response safety net, etc.) never passes `session` and keeps the
// original never-throws contract unchanged.
//
//   await createLog({
//     actor: req.user,                 // { userId, role, email } from auth.middleware.js
//     action: 'mcq_approved',
//     entityType: 'MCQ',
//     entityId: mcq._id,
//     before: { status: 'pending' },   // optional — omit for create/delete/auth events
//     after: { status: 'approved' },   // optional
//     summary: `Approved ${mcq.question_id}`,
//     req,                              // optional — only used for req.ip
//     session,                          // optional — see comment above; only taxonomy.service.js passes this
//     oldLocation,                      // optional — Prompt 14, taxonomy rename/move only, see ActivityLog.js
//     newLocation,                      // optional — ditto
//     mcqsUpdated,                      // optional — ditto
//     success,                          // optional — ditto; defaults true, see ActivityLog.js's own comment
//   });
export const createLog = async ({
  actor,
  action,
  entityType,
  entityId = null,
  before = null,
  after = null,
  summary = '',
  req = null,
  session = null,
  oldLocation = null,
  newLocation = null,
  mcqsUpdated = null,
  success = true,
}) => {
  const inTransaction = Boolean(session);

  try {
    if (!actor || !actor.userId) {
      logger.error('activityLog.createLog: missing actor, skipping write', { action });
      if (inTransaction) {
        // Inside a transaction a missing actor is a caller bug (every
        // taxonomy.service.js call site only reaches here after already
        // checking `if (actor)`), not something to log around and
        // continue past — abort the transaction the same way any other
        // failed step in it would.
        throw ApiError.internal('activityLog.createLog: missing actor for a session-scoped log write');
      }
      return null;
    }

    const { before: diffBefore, after: diffAfter } = shallowDiff(before, after);

    // Array form (`create([doc], opts)`) always returns an array,
    // regardless of whether `opts.session` is set — used unconditionally
    // here so the transactional and non-transactional paths share one
    // code shape rather than branching between `create(doc)` and
    // `create([doc], { session })`.
    const [log] = await ActivityLog.create(
      [
        {
          actor_id: actor.userId,
          actor_name: actor.email ?? 'unknown',
          action,
          entity_type: entityType,
          entity_id: entityId,
          details: {
            before: diffBefore,
            after: diffAfter,
            summary,
          },
          ip_address: req?.ip ?? '',
          old_location: oldLocation,
          new_location: newLocation,
          mcqs_updated: mcqsUpdated,
          success,
        },
      ],
      inTransaction ? { session } : {}
    );

    return log;
  } catch (err) {
    if (inTransaction) {
      // Re-thrown — see this function's own header comment on why a
      // session-scoped log failure must abort the whole taxonomy
      // transaction rather than being swallowed like every other
      // createLog call site.
      logger.error(`activityLog.createLog failed inside transaction: ${err.message}`, {
        action,
        entityType,
        entityId,
      });
      throw err;
    }

    // Covers everything: bad enum value, missing required field, DB
    // connection blip. The caller (a controller mid-response, or the
    // auto-log middleware after the response has already gone out) never
    // sees this — it is purely observability.
    logger.error(`activityLog.createLog failed: ${err.message}`, { action, entityType, entityId });
    return null;
  }
};

// getRecentLogsForEntity — thin, indexed read used by entity detail pages
// ("history" tab on a Test or MCQ). Newest first, backed by the
// { entity_type: 1, entity_id: 1, timestamp: -1 } compound index.
export const getRecentLogsForEntity = async (entityType, entityId, limit = 20) => {
  return ActivityLog.find({ entity_type: entityType, entity_id: entityId })
    .sort({ timestamp: -1 })
    .limit(limit)
    .lean();
};

// ─── getPaginatedLogs ───────────────────────────────────────────────
// Prompt 100. The general "list all logs" read that Phase 9's backend
// prompts (91-96) never actually built — getRecentLogsForEntity above
// is scoped to one entity, and nothing else queries ActivityLog for a
// global, filterable, paginated feed. Backs the Activity Log page's
// `{ logs, total, page, totalPages }` response shape.
//
// Builds a plain Mongoose filter from whichever params are present
// (all optional) rather than always querying `{}`, so a narrow filter
// (e.g. one action + a date range) can still use the relevant index
// instead of forcing a full collection scan + in-memory sort every
// time. `from`/`to` are inclusive on the `timestamp` field.
export const getPaginatedLogs = async ({
  page = 1,
  limit = 25,
  action,
  entityType,
  actorId,
  from,
  to,
} = {}) => {
  const filter = {};

  if (action) filter.action = action;
  if (entityType) filter.entity_type = entityType;
  if (actorId) filter.actor_id = actorId;

  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = new Date(from);
    if (to) filter.timestamp.$lte = new Date(to);
  }

  const safePage = Math.max(1, page);
  const safeLimit = Math.max(1, limit);
  const skip = (safePage - 1) * safeLimit;

  const [logs, totalCount] = await Promise.all([
    ActivityLog.find(filter)
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(safeLimit)
      .lean(),
    ActivityLog.countDocuments(filter),
  ]);

  // Prompt 103: standardized { data, pagination } shape (was the older,
  // flat { logs, total, page, totalPages } shape this function's own
  // doc comment above described — kept as history, now inaccurate).
  // ActivityLog.jsx still reads `data.logs` / `data.total` and WILL
  // break until updated — deferred per Prompt 103's DoD, same as the
  // MCQ and Test list endpoints.
  return buildPaginatedResponse(logs, totalCount, { page: safePage, limit: safeLimit });
};
