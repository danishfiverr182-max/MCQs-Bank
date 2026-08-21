import mongoose from 'mongoose';

const { Schema } = mongoose;

// QAReport.js — Phase 8, Prompt 81. Pure data layer: no
// controller/service imports, no pipeline logic. The actual QA checks
// (question count, subject/difficulty distribution, near-duplicate
// detection, etc.) are a later prompt's job — this model only defines
// the shape a completed run's result is stored in, chosen specifically
// so QAChecklist.jsx (and later SimilarityReview.jsx) can render
// straight off the stored document with zero transformation.

// ─── checkResultSchema ────────────────────────────────────────────
// One entry per check the pipeline ran, regardless of outcome — this
// is what lets QAChecklist.jsx render a COMPLETE checklist (every
// check, pass or fail) rather than only ever showing failures.
const checkResultSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    label: { type: String, required: true, trim: true },
    status: {
      type: String,
      required: true,
      enum: ['pass', 'fail', 'warning'],
    },
    // Empty string is a valid, common case (a passing check usually
    // has nothing further to say) — not `required`, but always present
    // as a field so the frontend never has to guard against a missing
    // key.
    detail: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

// ─── failureSchema ─────────────────────────────────────────────────
// Denormalized, filtered view of just the checks array's `fail`
// entries — kept as its own array (rather than making every consumer
// re-filter `checks`) since the finalize-blocking logic (Prompt 85/86)
// needs a cheap, explicit `failures.length === 0` check.
const failureSchema = new Schema(
  {
    check: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
  },
  { _id: false }
);

// ─── warningSchema ──────────────────────────────────────────────────
// `mcq_ids` / `score` are optional and specifically exist for
// near-duplicate warnings — SimilarityReview.jsx (Prompt 90) needs the
// exact pair of MCQs and the similarity score directly, rather than
// having to re-parse them back out of a loosely-typed message string.
// Any other warning type (that isn't about a specific MCQ pair) simply
// omits both fields.
const warningSchema = new Schema(
  {
    check: { type: String, required: true, trim: true },
    message: { type: String, required: true, trim: true },
    mcq_ids: {
      type: [String],
      default: undefined, // stays genuinely absent when not supplied, rather than `[]`
    },
    score: {
      type: Number,
      min: 0,
      max: 100,
    },
  },
  { _id: false }
);

const qaReportSchema = new Schema(
  {
    report_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
      // Format QA_{year}_{sequence}, e.g. "QA_2026_0001" — mirrors
      // GeneratedTest.test_id's own convention (Phase 6) for
      // consistency across the system. Computed by the service layer;
      // this model only enforces uniqueness at the DB level.
    },
    // String reference, not an ObjectId ref — same convention every
    // other cross-model reference in this system already follows
    // (Blueprint.exam_id, GeneratedTest.blueprint_id, etc.).
    test_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // true only if failures.length === 0 at the time this report was
    // generated — warnings never affect this flag, which is the whole
    // point of the pass/fail vs. warning distinction the spec draws.
    // Stored as its own field (rather than always deriving it from
    // `failures` on read) so it's directly queryable/sortable, e.g.
    // for a QADashboard.jsx list of failing reports.
    passed: {
      type: Boolean,
      required: true,
    },
    checks: {
      type: [checkResultSchema],
      default: [],
    },
    failures: {
      type: [failureSchema],
      default: [],
    },
    warnings: {
      type: [warningSchema],
      default: [],
    },
    generated_at: {
      type: Date,
      required: true,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ─── Indexes ─────────────────────────────────────────────────────
// A test can be QA'd more than once (e.g. a manual re-run after fixing
// something the first run flagged) — both QADashboard.jsx and
// QAReport.jsx need "latest report for this test" as a common,
// efficient query: { test_id } filter, sorted generated_at desc.
qaReportSchema.index({ test_id: 1, generated_at: -1 });

const QAReport = mongoose.model('QAReport', qaReportSchema);

export default QAReport;
