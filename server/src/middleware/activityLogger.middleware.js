import { createLog } from '../services/activityLog.service.js';
import { logger } from '../utils/logger.js';

// activityLogger.middleware.js — Prompt 92. Wires activityLog.service.js
// into the request lifecycle so mutating admin actions get an ActivityLog
// row without every controller having to remember to call createLog
// itself. Two pieces, both mounted globally in server.js:
//
//   app.use(attachLogContext)   — early, before routes
//   ...routes...
//   app.use(autoLogResponse)    — after routes, before the error handler
//
// A controller that wants a richer log than the generic fallback (a
// specific summary, an explicit action that isn't guessable from the
// route, an actor override) sets fields on `req.logContext` before
// responding; autoLogResponse reads whatever is there once the response
// has gone out. A controller that wants NO log at all sets
// `req.logContext.skip = true`.

// ─── 1. attachLogContext ────────────────────────────────────────────
// Prepares the slot. Does not log anything itself.
export const attachLogContext = (req, res, next) => {
  req.logContext = {};
  next();
};

// ─── Fallback action table ──────────────────────────────────────────
// Best-effort default when a controller hasn't set req.logContext.action
// explicitly. Keyed by `${method} ${baseUrl}${route.path}` — the exact
// mounted route pattern Express matched (e.g. 'PATCH /api/mcqs/:id'),
// not the raw URL, so '/api/mcqs/64f2.../approve' and
// '/api/mcqs/64f2.../reject' never collide with plain
// '/api/mcqs/:id'. This is a fallback, not a replacement for explicit
// context — routes whose correct action can't be guessed from a REST
// verb (finalize, run, approve/reject) set req.logContext.action
// themselves; see mcq.controller.js / qa.controller.js.
//
// Only routes that map to a real entry in ActivityLog's `action` enum
// are listed here. A route with no entry (e.g. blueprint activation,
// exam status toggle, QA pair-dismissal) simply produces no log row —
// intentional, not a bug, until a future phase decides those actions are
// worth auditing too.
const FALLBACK_ACTIONS = {
  'POST /api/mcqs': 'mcq_created',
  'PATCH /api/mcqs/:id': 'mcq_updated',
  'DELETE /api/mcqs/:id': 'mcq_deleted',
  'PATCH /api/mcqs/:id/approve': 'mcq_approved',
  'PATCH /api/mcqs/:id/reject': 'mcq_rejected',

  'POST /api/import/bulk': 'mcq_bulk_imported',

  'POST /api/blueprints': 'blueprint_created',
  'PUT /api/blueprints/:blueprintId': 'blueprint_updated',
  'DELETE /api/blueprints/:blueprintId': 'blueprint_deleted',
  'POST /api/blueprints/:blueprintId/clone': 'blueprint_cloned',

  'POST /api/exams': 'exam_created',
  'PUT /api/exams/:examId': 'exam_updated',
  'DELETE /api/exams/:examId': 'exam_deleted',

  'POST /api/generator/generate': 'test_generated',

  'POST /api/qa/:testId/run': 'qa_run',
  'POST /api/qa/:testId/finalize': 'test_finalized',

  'POST /api/auth/login': 'admin_login',
  'POST /api/auth/logout': 'admin_logout',
};

// ─── Fallback entity table ──────────────────────────────────────────
// baseUrl -> { entityType, paramNames } — paramNames tried in order,
// first match wins. Covers every mounted router; entries with no
// matching param (e.g. bulk import, auth) leave entity_id null.
const FALLBACK_ENTITY = {
  '/api/mcqs': { entityType: 'MCQ', paramNames: ['id'] },
  '/api/blueprints': { entityType: 'Blueprint', paramNames: ['blueprintId'] },
  '/api/exams': { entityType: 'Exam', paramNames: ['examId'] },
  '/api/generator': { entityType: 'Test', paramNames: ['testId'] },
  // QA actions are logged against the Test they concern (qa_run,
  // test_finalized) so a Test's "history" tab shows the full timeline —
  // generated -> QA run -> finalized — in one indexed query, rather than
  // splitting QA events off under a separate QAReport entity_id that
  // nothing links back to the test with.
  '/api/qa': { entityType: 'Test', paramNames: ['testId'] },
  '/api/import': { entityType: 'MCQ', paramNames: [] },
  '/api/auth': { entityType: 'Auth', paramNames: [] },
};

const resolveEntity = (req) => {
  const fallback = FALLBACK_ENTITY[req.baseUrl];
  if (!fallback) return { entityType: undefined, entityId: null };

  const entityId = fallback.paramNames
    .map((name) => req.params?.[name])
    .find((value) => value !== undefined) ?? null;

  return { entityType: fallback.entityType, entityId };
};

// ─── 2. autoLogResponse ──────────────────────────────────────────────
// Mounted after all routes. Hooks res.on('finish') so the log write
// happens after the response has already been sent to the client —
// logging can never add latency to the actual request.
export const autoLogResponse = (req, res, next) => {
  res.on('finish', () => {
    // Wrapped: res.on('finish') fires after headers are already out, so
    // nothing in here can surface to the client either way — but a
    // thrown error inside an event listener would still crash the
    // process, hence the explicit try/catch rather than relying on
    // asyncHandler (there is no `next` to hand an error to at this point).
    try {
      const logContext = req.logContext ?? {};

      if (logContext.skip === true) return;
      if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return;
      if (res.statusCode >= 400) return;

      const routeKey = req.route ? `${req.method} ${req.baseUrl}${req.route.path}` : null;

      const action = logContext.action ?? (routeKey ? FALLBACK_ACTIONS[routeKey] : undefined);

      // No explicit action and no fallback mapping for this route =
      // nothing worth auditing (or the route predates a mapping being
      // added) — skip silently rather than writing a log with an invalid
      // enum value.
      if (!action) return;

      const fallbackEntity = resolveEntity(req);
      const entityType = logContext.entityType ?? fallbackEntity.entityType;
      const entityId = logContext.entityId ?? fallbackEntity.entityId;

      // req.user is absent on login (the request that's about to
      // *create* the authenticated session) — controllers on that path
      // set req.logContext.actor explicitly. Everywhere else req.user is
      // already populated by verifyJWT before the controller runs.
      const actor = logContext.actor ?? req.user;

      createLog({
        actor,
        action,
        entityType,
        entityId,
        summary: logContext.summary ?? '',
        req,
      }).catch(() => {
        /* createLog already never rejects — belt and suspenders. */
      });
    } catch (err) {
      logger.error(`autoLogResponse failed: ${err.message}`);
    }
  });

  next();
};
