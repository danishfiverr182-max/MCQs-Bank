import ApiResponse from '../utils/ApiResponse.js';

// Generic, reusable validation middleware. Pass any Zod schema shaped as
// { body?, query?, params? } and it validates whichever of those keys
// the schema defines.
const validate = (schema) => (req, res, next) => {
  const result = schema.safeParse({
    body: req.body,
    query: req.query,
    params: req.params,
  });

  if (!result.success) {
    const errors = result.error.issues.map((issue) => ({
      field: issue.path.join('.'),
      message: issue.message,
    }));

    return res
      .status(400)
      .json(new ApiResponse(400, { errors }, 'Validation failed'));
  }

  // Only overwrite the keys the schema actually validated (e.g. a
  // query-only schema like mcqQuerySchema has no `body` in its shape —
  // overwriting req.body with undefined in that case would wipe it).
  if (result.data.body !== undefined) req.body = result.data.body;
  if (result.data.query !== undefined) req.query = result.data.query;
  if (result.data.params !== undefined) req.params = result.data.params;

  next();
};

export default validate;
