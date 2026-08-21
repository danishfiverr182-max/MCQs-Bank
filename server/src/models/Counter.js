import mongoose from 'mongoose';

const { Schema } = mongoose;

// Internal helper collection — NOT exposed via any route. Used solely
// to hand out atomic, gap-tolerant sequence numbers (e.g. for
// question_id generation in MCQ.js).
const counterSchema = new Schema({
  _id: { type: String, required: true }, // e.g. "mcq_question_id"
  seq: { type: Number, default: 0 },
});

// Atomic at the MongoDB level: $inc + upsert means two simultaneous
// callers can never receive the same sequence number, even under high
// concurrency. A plain countDocuments()+1 approach would race and is
// explicitly avoided here.
counterSchema.statics.getNextSequence = async function getNextSequence(name) {
  const doc = await this.findByIdAndUpdate(
    name,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

const Counter = mongoose.model('Counter', counterSchema);

export default Counter;
