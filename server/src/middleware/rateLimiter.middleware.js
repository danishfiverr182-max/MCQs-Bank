import rateLimit from 'express-rate-limit';
import ApiError from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';

// ─── Shared response shape ─────────────────────────────────────────
// NOTE (deviation from generic prompt text): ApiError has no `.toJSON()`
// method in this codebase — the actual response shape is built inline by
// `errorHandler.js` (`{ success, statusCode, message, errors, timestamp }`).
// This helper mirrors that exact shape so a 429 body looks identical to
// every other error response the API already returns.
const buildRateLimitBody = (apiError) => ({
  success: false,
  statusCode: apiError.statusCode,
  message: apiError.message,
  errors: apiError.errors || [],
  timestamp: apiError.timestamp,
});

// Factory so each limiter's handler logs with its own message/status
// while sharing the exact same logging + response-shaping logic.
const makeHandler = (message) => (req, res) => {
  logger.warn(`Rate limit hit: ${req.ip} on ${req.originalUrl}`);
  const apiError = new ApiError(429, message);
  res.status(429).json(buildRateLimitBody(apiError));
};

// ─── authLimiter ────────────────────────────────────────────────────
// Protects login/auth routes from brute-force credential guessing.
// keyGenerator is left as the express-rate-limit default (client IP).
// TODO (future, not required now): if login is keyed by email, consider
// a compound key (IP + email) instead of IP alone, so one abusive IP on
// a shared/office network can't lock out every legitimate user behind
// that same IP. Not implemented here to keep this prompt's scope tight.
export const authLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true, // adds RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset headers
  legacyHeaders: false,
  handler: makeHandler('Too many login attempts. Please try again in 1 minute.'),
});

// ─── generateLimiter ───────────────────────────────────────────────
// Protects the test-generation engine from abusive/scripted generation
// spam (each generation is comparatively expensive: multiple DB
// queries per subject/difficulty, a transaction, a persisted document).
// Scoped to ONLY the actual /generate route (see generator.routes.js) —
// NOT the whole /api/generator path.
export const generateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('Generation limit reached (20/hour). Please try again later.'),
});

// ─── feasibilityLimiter ──────────────────────────────────────────────
// BUGFIX: check-feasibility used to share generateLimiter's 20/hour
// budget (both routes sat under one `app.use('/api/generator',
// generatorLimiter)` in server.js). That's wrong — check-feasibility is
// a cheap, read-only pre-flight check the frontend calls AUTOMATICALLY
// on every override change (debounced, but still fires repeatedly
// during normal use — e.g. adding a few topic requirements while
// setting up "Topics to Include" easily fires it 10-15+ times in one
// sitting). Sharing one budget meant routine UI interaction could
// exhaust the quota meant for actual, deliberate /generate calls,
// before the admin ever clicked Generate. Given its own, much more
// generous limit instead — still a safety net against scripted abuse,
// just sized for how often a human legitimately triggers it while
// adjusting overrides.
export const feasibilityLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: makeHandler('Too many feasibility checks — please slow down and try again shortly.'),
});

// ─── generalLimiter ─────────────────────────────────────────────────
// Broad, cheap safety net applied to the whole /api surface. Skips
// /api/health explicitly (via `skip`) rather than relying on router
// mount order, so uptime monitors / load balancers polling health
// frequently are never blocked, regardless of how other routers are
// wired up in server.js.
//
// NOTE (raised from 200/15min): this limiter is mounted at `/api`
// BEFORE any per-router verifyJWT runs, so it's keyed on IP alone and
// can't distinguish an authenticated admin from an anonymous caller.
// For a single-operator admin panel, 200/15min (~13/min) was too easy
// to exhaust through completely normal use — debounced filter
// re-fetches in MCQList.jsx, pagination, blueprint feasibility checks,
// and analytics widgets each fire their own request, and several land
// within the same few seconds. Bumped to a number that still catches
// a genuinely runaway script/loop but doesn't throttle real usage.
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.path === '/health',
  handler: makeHandler('Too many requests. Please slow down.'),
});
