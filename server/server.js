import env from './src/config/env.js';
import { connectDB } from './src/config/db.js';
import { seedAdmin } from './src/seeders/adminSeeder.js';
import errorHandler from './src/middleware/errorHandler.js';
import { attachLogContext, autoLogResponse } from './src/middleware/activityLogger.middleware.js';
import healthRouter from './src/routes/health.routes.js';
import authRouter from './src/routes/auth.routes.js';
import mcqRouter from './src/routes/mcq.routes.js';
import taxonomyRouter from './src/routes/taxonomy.routes.js';
import importRouter from './src/routes/import.routes.js';
import examRouter from './src/routes/exam.routes.js';
import blueprintRouter from './src/routes/blueprint.routes.js';
import generatorRouter from './src/routes/generator.routes.js';
import qaRouter from './src/routes/qa.routes.js';
import analyticsRouter from './src/routes/analytics.routes.js';
import reportRouter from './src/routes/report.routes.js';
import { authLimiter, generalLimiter } from './src/middleware/rateLimiter.middleware.js';
import { helmetConfig } from './src/config/helmet.config.js';
import { sanitizeMiddleware } from './src/middleware/mongoSanitize.middleware.js';
import { compressionMiddleware } from './src/middleware/compression.middleware.js';
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import cookieParser from 'cookie-parser';

const app = express();

// ─── Security (Prompt 102: hardened Helmet config) ────────────────
app.use(helmetConfig);

// ─── Compression (Prompt 103) ──────────────────────────────────────
// Gzips outgoing responses over 1KB; skips PDF downloads (see
// compression.middleware.js). Mounted early since it only touches
// outgoing responses, not incoming parsing — order relative to
// body-parsing/sanitize below doesn't matter.
app.use(compressionMiddleware);

// ─── CORS ───────────────────────────────────────────────────────
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  })
);

// ─── Body parsing ───────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(cookieParser());

// ─── Input sanitization (Prompt 102) ───────────────────────────────
// Must run AFTER express.json()/express.urlencoded() above — it needs
// req.body/req.query already parsed into real objects before it can walk
// and clean them for injected Mongo operator keys ($gt, $where, etc.).
app.use(sanitizeMiddleware);

// ─── Logging ────────────────────────────────────────────────────
if (env.IS_DEVELOPMENT) {
  app.use(morgan('dev'));
}

// ─── Activity log context (Prompt 92) ────────────────────────────
// Mounted early, alongside the other request-scoped middleware, so
// req.logContext exists for every controller to write into.
app.use(attachLogContext);

// ─── Rate limiting (Prompt 101) ───────────────────────────────────
// Apply the general limiter globally first (cheap, broad safety net).
// `/api/health` is exempt via the limiter's own `skip` option (see
// rateLimiter.middleware.js) rather than depending on mount order, so
// uptime monitors/load balancers can poll it as often as they like.
app.use('/api', generalLimiter);

// Stricter limiters stack on top of the general one for their routes.
app.use('/api/auth', authLimiter);
// NOTE: generator-specific limiters (generateLimiter, feasibilityLimiter)
// are NOT mounted here. They used to be applied blanket across the
// whole /api/generator path via one `generatorLimiter`, which wrongly
// put the cheap, frequently-auto-fired check-feasibility route under
// the same strict 20/hour budget as actual test generation. Each is
// now applied directly to its own specific route inside
// generator.routes.js instead — see that file and
// rateLimiter.middleware.js's feasibilityLimiter comment for the full
// story.
// ────────────────────────────────────────────────────────────────

// ─── Routes ─────────────────────────────────────────────────────
app.use('/api/health', healthRouter);
app.use('/api/auth', authRouter);
app.use('/api/mcqs', mcqRouter);
// Prompt 10 (Feature 13): unified taxonomy preview/dry-run endpoint —
// separate top-level mount from /api/mcqs since it's a single
// operation-agnostic route, not part of the MCQ resource itself.
app.use('/api/taxonomy', taxonomyRouter);
app.use('/api/import', importRouter);
app.use('/api/exams', examRouter);
app.use('/api/blueprints', blueprintRouter);
app.use('/api/generator', generatorRouter);
app.use('/api/qa', qaRouter);
app.use('/api/analytics', analyticsRouter);
app.use('/api/reports', reportRouter);
// ────────────────────────────────────────────────────────────────

// ─── Activity log auto-capture (Prompt 92) ───────────────────────
// Mounted AFTER all routes so req.route/req.logContext reflect whatever
// the matched controller set, but BEFORE the error handler so failed
// requests (which never reach here via next(err) anyway — this only
// hooks res.on('finish')) are still covered for the 404 handler below.
app.use(autoLogResponse);

// ─── 404 handler ────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`,
    statusCode: 404,
  });
});

app.use(errorHandler);

// ─── Start server ───────────────────────────────────────────────
const startServer = async () => {
  try {
    await connectDB();
    await seedAdmin();

    app.listen(env.PORT, () => {
      console.log('─'.repeat(50));
      console.log(`🚀 ExamEngine server running`);
      console.log(`   Port     : ${env.PORT}`);
      console.log(`   Env      : ${env.NODE_ENV}`);
      console.log(`   CORS     : ${env.CORS_ORIGIN}`);
      console.log('─'.repeat(50));
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    process.exit(1);
  }
};

startServer();

export default app;
