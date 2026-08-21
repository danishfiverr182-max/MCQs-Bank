import mongoSanitize from 'express-mongo-sanitize';
import { logger } from '../utils/logger.js';

// Strips Mongo operator injection attempts (`$gt`, `$where`, `$ne`, etc.)
// smuggled into `req.body` / `req.query` / `req.params` keys.
//
// `replaceWith: '_'` is used instead of the library's default (which just
// deletes the offending key outright). Trade-off worth documenting: a
// stripped key vanishes silently — a legitimate field that happens to
// collide with something sanitize flags would just disappear from the
// payload with no trace, which is a confusing failure mode to debug later.
// Replacing the leading `$`/`.` characters with `_` instead means the key
// still shows up (as a harmlessly-renamed field) and, combined with
// `onSanitize` below, every actual sanitize event is logged — so genuine
// injection attempts are visible in monitoring instead of failing silently
// in either direction.
export const sanitizeMiddleware = mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn(`Sanitized potentially malicious key "${key}" from ${req.ip} on ${req.originalUrl}`);
  },
});
