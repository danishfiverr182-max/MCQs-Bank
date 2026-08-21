import mongoose from 'mongoose';

const { Schema } = mongoose;

const subjectEntrySchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    count: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const difficultyDistributionSchema = new Schema(
  {
    easy: { type: Number, default: 0, min: 0 },
    medium: { type: Number, default: 0, min: 0 },
    hard: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

const blueprintSchema = new Schema(
  {
    blueprint_id: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    // String reference, not an ObjectId ref — exam_id is the spec's
    // stable public identifier used across the whole system (see
    // Exam.js), so Blueprint keys off it the same way MCQ.exam_tags does.
    exam_id: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    // Incremented on clone (Prompt 54's cloneBlueprint), never mutated
    // on a plain edit of an existing blueprint.
    version: {
      type: Number,
      default: 1,
    },
    is_active: {
      type: Boolean,
      default: false,
    },
    total_questions: {
      type: Number,
      required: true,
      min: 1,
    },
    subjects: {
      type: [subjectEntrySchema],
      default: [],
    },
    difficulty_distribution: {
      type: difficultyDistributionSchema,
      default: () => ({}),
    },
    // Deliberately open-ended per the system spec's "Custom Rules"
    // option. Phase 5 only stores and passes this through — interpreting
    // it is Phase 6's Test Generation Engine's job, not this model's.
    selection_rules: {
      type: Schema.Types.Mixed,
      default: {},
    },
    created_by: {
      type: String,
      trim: true,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ─── Indexes ─────────────────────────────────────────────────────
// Fast lookup of every blueprint belonging to an exam (e.g. version
// history, or the "delete exam" guard in exam.service.js) is already
// covered by the field-level `index: true` on exam_id above — no need
// for a separate schema.index({ exam_id: 1 }) call (that was causing
// the "Duplicate schema index on {exam_id:1}" warning).

// PARTIAL UNIQUE INDEX — the DB-level backstop for "only one active
// blueprint per exam at a time". Mongo has no native "unique among
// true values only" constraint on a boolean, so this is implemented as
// a compound unique index scoped down to is_active: true via
// partialFilterExpression. Any number of is_active: false documents
// for the same exam_id are unaffected (they simply don't match the
// partial filter, so the uniqueness constraint never applies to them).
// The service layer (blueprint.service.js, Prompt 54/55's setActive)
// also enforces this explicitly by deactivating the previous active
// blueprint before activating a new one — this index exists purely to
// catch the race-condition case where two concurrent requests both try
// to activate a blueprint for the same exam at once.
blueprintSchema.index(
  { exam_id: 1, is_active: 1 },
  { unique: true, partialFilterExpression: { is_active: true } }
);

const Blueprint = mongoose.model('Blueprint', blueprintSchema);

export default Blueprint;