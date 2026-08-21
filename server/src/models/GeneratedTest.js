import mongoose from 'mongoose';

const { Schema } = mongoose;

// Lightweight per-question snapshot — deliberately NOT a full embedded
// copy of the MCQ (no question text/options/answer here). Full content
// is always resolved live from the MCQ collection by mcq_id whenever a
// test is viewed (Prompt 66/69) or exported. This is a conscious
// tradeoff: it keeps a 1000+ question test document cheap to store,
// and it means a rendered test always reflects the MCQ's *current*
// content rather than a possibly-stale snapshot taken at generation
// time (e.g. if a question is later corrected/edited). The cost is
// that if an MCQ is deleted after a test references it, resolving that
// question at view/export time must handle the miss gracefully — that
// is the resolver's responsibility, not this model's.
//
// `subject`/`topic`/`subtopic` are the one exception to "resolved
// live": they're taxonomy LABELS, not question content, and per the
// non-goal flagged in Prompt 1 (reaffirmed in taxonomy.service.js's
// rename/move/merge/delete comments — "GeneratedTest is deliberately
// NOT touched"), a past test must keep showing the labels that were
// true at generation time even after a later taxonomy rename/move/
// merge. `subject` was already snapshotted this way since Prompt 61.
// `topic`/`subtopic` were NOT — getGeneratedTestWithQuestions used to
// re-resolve `topic` live from the current MCQ document, so a renamed
// topic silently rewrote old tests' displayed labels (found in the
// Prompt 21 regression pass). Added here, populated once at generation
// time in generator.service.js's persistTest, and never written to
// again — fixing that.
const generatedTestQuestionSchema = new Schema(
  {
    mcq_id: { type: String, required: true, trim: true },
    subject: { type: String, required: true, trim: true },
    // '' is a legitimate value (MCQ.topic/subtopic both default to ''
    // for "no topic/subtopic set"), same convention as MCQ.js itself —
    // not `required`.
    topic: { type: String, trim: true, default: '' },
    subtopic: { type: String, trim: true, default: '' },
    difficulty: { type: String, required: true, trim: true },
  },
  { _id: false }
);

const generatedTestSchema = new Schema(
  {
    test_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
      // Format TEST_{year}_{sequence}, e.g. "TEST_2026_001" — generated
      // by the service layer (Prompt 65). This model only enforces
      // uniqueness at the DB level; it does not compute the sequence.
    },
    // String references, not ObjectId refs — consistent with how
    // Blueprint.exam_id references Exam by its stable public string id
    // (Phase 5 convention). blueprint_id follows the same pattern.
    exam_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    blueprint_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    question_count: {
      type: Number,
      required: true,
      min: 0,
    },
    questions: {
      type: [generatedTestQuestionSchema],
      default: [],
    },
    // Records exactly what overrides were used to produce this test
    // (quality threshold, any subject/difficulty overrides from Prompt
    // 62's dynamic options) so a past test's generation is fully
    // auditable / reproducible-in-spirit later. Deliberately open-ended
    // (Mixed) rather than a fixed sub-schema, mirroring how
    // Blueprint.selection_rules stays open-ended for the same reason.
    generation_params: {
      type: Schema.Types.Mixed,
      default: {},
    },
    // A 'failed' record can still be written (with a partial or empty
    // `questions` array) so a failed generation attempt is visible in
    // history rather than vanishing silently. The service layer
    // (Prompt 65) decides when to write 'failed' vs 'completed'.
    status: {
      type: String,
      enum: ['completed', 'failed'],
      default: 'completed',
    },
    generated_by: {
      type: String,
      trim: true,
    },
    generated_at: {
      type: Date,
      required: true,
    },
    // ─── Phase 8 patch (Prompt 85) ───────────────────────────────
    // NOT part of Phase 6's original spec — added here so
    // TestHistory.jsx / QADashboard.jsx can show a test's QA status
    // directly in a list view without a join/second query per row.
    // Both fields are denormalized from the latest QAReport for this
    // test_id and are updated by qa.service.js's runQAOnTest
    // immediately after that report is saved; this model itself never
    // computes them.
    latest_qa_status: {
      type: String,
      enum: ['passed', 'failed', 'not_run'],
      default: 'not_run',
    },
    latest_qa_report_id: {
      type: String,
      trim: true,
      default: null,
    },
    // ─── Phase 8 patch (Prompt 86) ───────────────────────────────
    // Set by qa.controller.js's approveWithQA ONLY when the test's
    // latest QAReport has passed === true — this is the concrete flag
    // behind the spec's "Failures block the test from being
    // finalized" rule. Never set anywhere else in the system.
    finalized: {
      type: Boolean,
      default: false,
    },
    finalized_at: {
      type: Date,
      default: null,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ─── Indexes ─────────────────────────────────────────────────────
// Compound index matching exactly the sort/filter TestHistory.jsx will
// need: tests for a given exam, newest first.
generatedTestSchema.index({ exam_id: 1, generated_at: -1 });
// Supports fetchRecentlyUsedMcqIds (generator.service.js) — "exclude
// recently-used MCQs by test count" queries this collection filtered
// by `questions.subject` and sorted by `generated_at` desc for every
// subject in a working config, so both fields need to be indexed
// together or that query falls back to a collection scan as
// GeneratedTest history grows.
generatedTestSchema.index({ 'questions.subject': 1, generated_at: -1 });

const GeneratedTest = mongoose.model('GeneratedTest', generatedTestSchema);

export default GeneratedTest;
