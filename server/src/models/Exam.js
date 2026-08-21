import mongoose from 'mongoose';

const { Schema } = mongoose;

const examSchema = new Schema(
  {
    // Stable key other collections (Blueprint, MCQ.exam_tags) reference.
    // Uppercase-slugified from organization + exam_name — but that
    // derivation happens in the controller layer (Prompt 52), NOT here.
    // The schema's only job is to enforce it's present and unique.
    exam_id: {
      type: String,
      required: true,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    exam_name: {
      type: String,
      required: true,
      trim: true,
    },
    // Indexed on its own (org list grouping / listByOrg filter) AND as
    // part of the compound index below (org + name sort/search).
    organization: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      trim: true,
      default: '',
    },
    tags: {
      type: [String],
      default: [],
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      index: true,
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ─── Indexes ─────────────────────────────────────────────────────
// Org list view + search filter/sort on this combination often.
examSchema.index({ organization: 1, exam_name: 1 });

const Exam = mongoose.model('Exam', examSchema);

export default Exam;
