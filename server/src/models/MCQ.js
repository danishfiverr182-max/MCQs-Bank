import mongoose from 'mongoose';
import Counter from './Counter.js';
import { hashContentFingerprint } from '../utils/duplicateDetector.js';

const { Schema } = mongoose;

const mcqSchema = new Schema(
  {
    question_id: {
      type: String,
      unique: true,
      index: true,
      // Generated in the pre-save hook below — NEVER set by client input.
    },
    question: {
      type: String,
      required: true,
      trim: true,
    },
    // sha256 of the full content fingerprint (question + normalized/
    // sorted options + correct answer text — see hashContentFingerprint
    // in duplicateDetector.js), computed automatically below, never set
    // directly. Powers findExactDuplicates() in duplicateDetector.js: a
    // single indexed $in query instead of re-normalizing/re-hashing
    // every existing document per import.
    question_hash: {
      type: String,
      index: true,
    },
    options: {
      A: { type: String, required: true },
      B: { type: String, required: true },
      C: { type: String, required: true },
      D: { type: String, required: true },
    },
    correct_answer: {
      type: String,
      enum: ['A', 'B', 'C', 'D'],
      required: true,
    },
    subject: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    topic: {
      type: String,
      trim: true,
      default: '',
    },
    subtopic: {
      type: String,
      trim: true,
      default: '',
    },
    difficulty: {
      type: String,
      enum: ['easy', 'medium', 'hard'],
      required: true,
      index: true,
    },
    exam_tags: {
      type: [String],
      default: [],
      // Indexed below via schema.index() — not here, to avoid the
      // "duplicate schema index" warning from declaring it twice.
    },
    cognitive_level: {
      type: String,
      enum: ['recall', 'understanding', 'application', 'analysis'],
      default: 'recall',
    },
    quality_score: {
      type: Number,
      default: 50,
      min: 0,
      max: 100,
    },
    // Added so imports/exports can eventually carry a per-question
    // rationale through to the website-import export format, which
    // requires one. Optional and defaults to '' — nothing in this
    // codebase populates it yet (neither the Add/Edit MCQ forms nor
    // the bulk import pipeline collect it), so existing MCQs will have
    // an empty explanation until a future import/edit supplies one.
    explanation: {
      type: String,
      trim: true,
      default: '',
    },
    status: {
      type: String,
      enum: ['pending', 'approved', 'rejected'],
      default: 'pending',
      index: true,
    },
    // Both already existed pre-Phase-6 (no schema patch needed for
    // Prompt 63's own DoD), but used_count now gets an explicit index
    // here since generator.service.js's fetchAndSamplePool (Prompt 63)
    // sorts on { used_count: 1, last_used_at: 1 } for every subject/
    // difficulty bucket of every generated test — a hot path worth
    // indexing rather than leaving as a collection scan + in-memory sort.
    used_count: {
      type: Number,
      default: 0,
      index: true,
    },
    last_used_at: {
      type: Date,
      default: null,
    },
    // Which ImportBatch (import.service.js / importBatch.model.js
    // `batch_id`, e.g. "IMPORT_2026_0004") inserted this MCQ — null for
    // MCQs created through the Add MCQ form. Populated by insertValid()
    // in import.service.js. This is what makes it possible to cascade-
    // delete every MCQ a bad/failed import left behind (see
    // deleteImportBatch in import.service.js) instead of only deleting
    // the ImportBatch history row and leaving its MCQs orphaned in the
    // bank, silently available to be flagged as "duplicates" by a later
    // re-import of the same file.
    source_batch_id: {
      type: String,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

// ─── Pre-validate: correct_answer must match a non-empty option ────
mcqSchema.pre('validate', function checkCorrectAnswerHasOption(next) {
  if (!this.options?.[this.correct_answer]) {
    return next(
      new Error(
        `correct_answer "${this.correct_answer}" has no matching option text`
      )
    );
  }
  next();
});

// ─── Pre-save: keep question_hash in sync with question+options+answer ──
// BUGFIX: question_hash used to be sha256 of the question text ALONE,
// so two rows with an identical/templated stem but different options
// and correct answer (e.g. "Identify the correct sentence." reused
// across unrelated grammar points) hashed identically and were wrongly
// treated as exact duplicates by findExactDuplicates in
// duplicateDetector.js. Fixed by hashing the full content fingerprint
// (question + normalized/sorted options + correct answer text) via
// hashContentFingerprint — see that function's comment for details.
// Recomputed whenever ANY of the three inputs change, not just
// `question` — options/correct_answer edits (e.g. via the Edit MCQ
// form) must also keep this in sync, or a later import of the
// now-edited content would wrongly re-flag it as new/non-duplicate.
mcqSchema.pre('save', function computeQuestionHash(next) {
  if (this.isModified('question') || this.isModified('options') || this.isModified('correct_answer')) {
    this.question_hash = hashContentFingerprint(this.question, this.options, this.correct_answer);
  }
  next();
});

// ─── Pre-save: assign human-readable question_id on creation only ──
mcqSchema.pre('save', async function assignQuestionId(next) {
  if (this.isNew && !this.question_id) {
    const seq = await Counter.getNextSequence('mcq_question_id');
    this.question_id = `Q${String(seq).padStart(5, '0')}`;
  }
  next();
});

// ─── Indexes ─────────────────────────────────────────────────────
mcqSchema.index({ subject: 1, difficulty: 1, status: 1 }); // compound, matches filter combo used by service layer
// Prompt 93: analytics.service.js's mcqsBySubject() matches on status
// FIRST then groups by subject — the compound index above has subject as
// its leading key, so it can't be used for a status-only match. This
// index's leading key is status, matching that access pattern directly
// (the single-field `status` index above already makes the $match itself
// index-backed, but this compound lets the subsequent $group also walk
// an already subject-ordered index range instead of an unordered set).
mcqSchema.index({ status: 1, subject: 1 });
mcqSchema.index({ exam_tags: 1 });
mcqSchema.index({ question: 'text' }); // text search
// Taxonomy Manager perf fix: getTaxonomy() (mcq.service.js) runs
// MCQ.aggregate([{ $group: { _id: { subject, topic, subtopic }, ... } }])
// with NO preceding $match — every load of the Taxonomy page groups the
// ENTIRE collection. Without an index covering every field that stage
// reads (the three group-key fields plus status, which the $sum/$cond
// branches also read), Mongo has no choice but to COLLSCAN and fetch
// each full document off disk — question text, all 4 options, and
// explanation included — just to look at 4 short fields. This compound
// index lets that $group be satisfied as an index-only scan instead
// (no document fetch at all), which is what was making a single
// Taxonomy page load take several seconds once the bank grew past a
// few hundred MCQs.
mcqSchema.index({ subject: 1, topic: 1, subtopic: 1, status: 1 });

const MCQ = mongoose.model('MCQ', mcqSchema);

export default MCQ;
