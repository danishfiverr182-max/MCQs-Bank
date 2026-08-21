import mongoose from 'mongoose';

const { Schema } = mongoose;

// DismissedPair.js — Phase 8, Prompt 90. Pure data layer, same
// discipline as QAReport.js (Prompt 81): no service/controller logic
// here, just the shape a "keep both" decision is stored in.
//
// A dismissal is global — keyed by the sorted pair of mcq_ids, NOT
// scoped to a single test — because "these two questions are
// legitimately distinct despite the similarity score" is a fact about
// the two questions themselves, not about whichever test's QA run
// happened to first surface them. The same pair could otherwise
// resurface as an unresolved warning on every other test that also
// happens to draw both questions, which would make "Keep Both" feel
// like it didn't actually do anything.
const dismissedPairSchema = new Schema(
  {
    // `[mcq_id_a, mcq_id_b].sort().join('::')` — computed by the
    // service layer (qa.service.js's buildPairKey), never by this
    // model. Unique so the same pair can only ever be dismissed once;
    // a repeat "Keep Both" on an already-dismissed pair is a no-op
    // upsert, not a duplicate row.
    pair_key: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      index: true,
    },
    // Both ids stored individually (in addition to pair_key) purely so
    // a dismissal is human-readable straight off the document without
    // having to split pair_key back apart — pair_key remains the only
    // field actually queried against.
    mcq_id_a: { type: String, required: true, trim: true },
    mcq_id_b: { type: String, required: true, trim: true },
    reviewed_by: { type: String, trim: true },
    reviewed_at: { type: Date, required: true, default: Date.now },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

const DismissedPair = mongoose.model('DismissedPair', dismissedPairSchema);

export default DismissedPair;
