import mongoose from 'mongoose';
import { SEED_SUBTOPIC_BANK } from '../constants/mcqConversionPromptTemplate.js';

const { Schema } = mongoose;

// PromptState — a deliberate SINGLETON collection, not per-user/per-batch
// (contrast Counter.js, which hands out many independent named counters
// keyed by _id). There is exactly one document here, ever, fixed at
// _id: "mcq_conversion_prompt". Its job is to hold the durable, growing
// state behind the "MCQ Conversion Prompt" copy-paste feature:
//   - subtopic_bank: the ever-growing vocabulary of reusable subtopics
//     (see mcqConversionPromptTemplate.js's SEED_SUBTOPIC_BANK for the
//     one-time seed). Items are NEVER removed automatically — only
//     appended to, via promptState.service.js's mergeSubtopicsIntoBank.
//   - range_start/range_end/batch_size/total_cap: the auto-advancing
//     "MCQ Number N to N+99" window handed to the human each time they
//     copy the prompt, so they don't have to track it by hand between
//     imports.
const promptStateSchema = new Schema(
  {
    _id: { type: String, required: true }, // always "mcq_conversion_prompt"
    subtopic_bank: { type: [String], default: [] },
    range_start: { type: Number, default: 1 },
    range_end: { type: Number, default: 100 },
    batch_size: { type: Number, default: 100 },
    total_cap: { type: Number, default: 600 },
  },
  {
    timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' },
  }
);

// getOrCreate — the ONLY way this singleton doc should ever be fetched.
// findOneAndUpdate + upsert:true guarantees the doc always exists after
// the first call, and setOnInsert guarantees it is seeded exactly once,
// ever: once the doc exists, subsequent calls never touch
// subtopic_bank/range_*/batch_size/total_cap here again (those evolve
// only via the explicit service methods below), so re-running this never
// resets anything an admin has since changed.
promptStateSchema.statics.getOrCreate = async function getOrCreate() {
  return this.findOneAndUpdate(
    { _id: 'mcq_conversion_prompt' },
    {
      $setOnInsert: {
        subtopic_bank: SEED_SUBTOPIC_BANK,
        range_start: 1,
        range_end: 100,
        batch_size: 100,
        total_cap: 600,
      },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
};

const PromptState = mongoose.model('PromptState', promptStateSchema);

export default PromptState;
