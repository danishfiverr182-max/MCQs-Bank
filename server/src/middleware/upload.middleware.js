import multer from 'multer';
import ApiError from '../utils/ApiError.js';

// ─── Storage ─────────────────────────────────────────────────────
// memoryStorage keeps the file entirely in-process as a Buffer —
// nothing ever touches disk. This is deliberate: the import pipeline
// needs to scale to 1M+ MCQs later, and streaming/parsing from a
// buffer avoids filesystem cleanup concerns for a stateless API server.
const storage = multer.memoryStorage();

// ─── File filter ────────────────────────────────────────────────
// Some browsers/OSes send `application/octet-stream` for .json files
// instead of `application/json`, so the extension is checked as a
// fallback rather than trusting mimetype alone.
const fileFilter = (req, file, cb) => {
  const hasJsonMimetype = file.mimetype === 'application/json';
  const hasJsonExtension = file.originalname?.toLowerCase().endsWith('.json');

  if (hasJsonMimetype || hasJsonExtension) {
    return cb(null, true);
  }

  return cb(new ApiError(400, 'Only .json files are allowed'));
};

// ─── Limits ──────────────────────────────────────────────────────
const limits = {
  fileSize: 10 * 1024 * 1024, // 10MB
};

// ─── Configured middleware ──────────────────────────────────────
// Single-file upload under the form-data key `file`. Used directly
// as route middleware: router.post('/', uploadJSON, handleUploadErrors, controller)
export const uploadJSON = multer({ storage, fileFilter, limits }).single('file');

// ─── Error wrapper ───────────────────────────────────────────────
// Multer reports its own failures (file too large, unexpected field,
// etc.) as a MulterError passed to next(err) — this converts that into
// the same ApiError shape the rest of the app uses, so the client
// always gets a JSON 400 instead of an unhandled error falling through
// to a generic/HTML response. Registered as a 4-arg error-handling
// middleware immediately after uploadJSON in the route chain; Express
// skips it on the success path and only invokes it when uploadJSON
// calls next(err).
export const handleUploadErrors = (err, req, res, next) => {
  if (!err) return next();

  if (err instanceof multer.MulterError) {
    let message = 'File upload error';

    switch (err.code) {
      case 'LIMIT_FILE_SIZE':
        message = 'File too large. Maximum size is 10MB';
        break;
      case 'LIMIT_UNEXPECTED_FILE':
        message = `Unexpected file field: "${err.field}". Use the "file" field.`;
        break;
      default:
        message = err.message || message;
    }

    return next(new ApiError(400, message));
  }

  // Not a Multer error (e.g. our own fileFilter ApiError, or something
  // else entirely) — pass it through to the global error handler as-is.
  return next(err);
};
