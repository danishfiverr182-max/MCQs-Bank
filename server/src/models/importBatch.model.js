import mongoose from 'mongoose';
import Counter from './Counter.js';

const { Schema } = mongoose;

const importBatchSchema = new Schema(
  {
    batch_id: {
      type: String,
      unique: true,
      index: true,
      // Generated in the pre-save hook below — NEVER set by client input.
    },
    filename: {
      type: String,
      required: true,
      trim: true,
    },
    uploaded_by: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    total_rows: {
      type: Number,
      required: true,
      default: 0,
    },
    inserted_count: {
      type: Number,
      default: 0,
    },
    failed_count: {
      type: Number,
      default: 0,
    },
    exact_duplicate_count: {
      type: Number,
      default: 0,
    },
    near_duplicate_count: {
      type: Number,
      default: 0,
    },
    // Subtopic display names that were newly created in TaxonomyNode as
    // a direct result of THIS batch (initial insert pass, plus any
    // later "keep duplicate" resolutions — see import.service.js's
    // resolveDuplicateInserts) — never a snapshot of all Subtopics in
    // the system. Persisted here (rather than only returned in the
    // response) so it belongs to this specific import operation and
    // survives independently of the in-memory report the frontend
    // builds right after upload — see import.service.js's
    // ensureTaxonomyForInsertedDocs for how "newly created" is
    // determined. Powers the Import page's "New Subtopics From This
    // Import" feature.
    new_subtopics: {
      type: [String],
      default: [],
    },
    mode: {
      type: String,
      enum: ['insert', 'validate_only'],
      required: true,
    },
    status: {
      type: String,
      enum: ['processing', 'completed', 'failed'],
      default: 'processing',
      // NOTE: as of the transactional rewrite in import.service.js,
      // an ImportBatch document is only ever created AFTER a run has
      // fully succeeded — inside the same DB transaction as its MCQ
      // inserts. So in practice this field is always written as
      // 'completed' at creation time; 'processing' and 'failed' are
      // kept in the enum for backward compatibility with any
      // documents that predate this change, not because new runs can
      // still produce them.
    },
  },
  {
    // Named to match the `created_at` field shown in the system spec,
    // rather than Mongoose's default `createdAt`/`updatedAt` casing.
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

// ─── Pre-save: assign human-readable batch_id on creation only ─────
// Scoped per-year (IMPORT_<year>_0001, IMPORT_<year>_0002, ...) so the
// counter resets annually rather than growing unbounded forever,
// matching the example in the system spec.
importBatchSchema.pre('save', async function assignBatchId(next) {
  if (this.isNew && !this.batch_id) {
    const year = new Date().getFullYear();
    const seq = await Counter.getNextSequence(`import_batch_${year}`);
    this.batch_id = `IMPORT_${year}_${String(seq).padStart(4, '0')}`;
  }
  next();
});

const ImportBatch = mongoose.model('ImportBatch', importBatchSchema);

export default ImportBatch;
