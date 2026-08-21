// In-memory stand-in for src/models/Counter.js, used only by
// verify_import_fix.mjs (via a loader hook) so the real insertValid()
// code path can run without a live MongoDB connection. Mirrors the
// real Counter's atomic-increment contract exactly.
const seqs = new Map();

export default {
  async getNextSequence(name) {
    const next = (seqs.get(name) ?? 0) + 1;
    seqs.set(name, next);
    return next;
  },
};
