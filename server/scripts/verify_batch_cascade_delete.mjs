// Standalone verification for the "failed import still shows MCQs as
// duplicates" fix. Proves two things against the real, unmodified
// insertValid()/deleteImportBatch() code:
//   1. Every inserted MCQ is tagged with the batch that inserted it.
//   2. deleteImportBatch cascades: deleting a batch also removes every
//      MCQ tagged with it, so a corrected re-import won't see them as
//      duplicates anymore.
//
// Uses the same in-memory Mongo-like stubs as verify_import_fix.mjs
// (see that file's header for why real MongoDB isn't available here).

import assert from 'node:assert/strict';
import { insertValid, deleteImportBatch } from '../src/services/import.service.js';

class FakeDoc {
  constructor(data) {
    Object.assign(this, data);
    this._id = `oid_${FakeDoc._seq++}`;
  }

  async validate() {
    const optionText = this.options?.[this.correct_answer];
    if (!optionText) throw new Error('bad correct_answer');
  }
}
FakeDoc._seq = 1;

function makeMCQModel() {
  const store = [];
  function MCQModel(data) {
    return new FakeDoc(data);
  }
  MCQModel.insertMany = async (docs) => {
    store.push(...docs);
    return docs;
  };
  MCQModel.deleteMany = async (filter) => {
    const before = store.length;
    const keep = store.filter((d) => d.source_batch_id !== filter.source_batch_id);
    const deletedCount = before - keep.length;
    store.length = 0;
    store.push(...keep);
    return { deletedCount };
  };
  MCQModel._store = store;
  return MCQModel;
}

function makeImportBatchModel(seed) {
  const store = [...seed];
  return {
    findOne: async ({ batch_id }) => store.find((b) => b.batch_id === batch_id) ?? null,
    deleteOne: async ({ _id }) => {
      const idx = store.findIndex((b) => b._id === _id);
      if (idx >= 0) store.splice(idx, 1);
    },
  };
}

const sampleRow = (i) => ({
  row: i,
  data: {
    question: `Sample question number ${i} needs ten chars`,
    options: { A: 'Karachi', B: 'Islamabad', C: 'Lahore', D: 'Peshawar' },
    correct_answer: 'B',
    subject: 'Pakistan Affairs',
  },
});

const rows = Array.from({ length: 10 }, (_, i) => sampleRow(i + 1));

const MCQModel = makeMCQModel();
const BAD_BATCH_ID = 'IMPORT_2026_0099';

const result = await insertValid(rows, MCQModel, BAD_BATCH_ID);
assert.equal(result.insertedCount, 10);
assert.ok(
  MCQModel._store.every((d) => d.source_batch_id === BAD_BATCH_ID),
  'every inserted MCQ should be tagged with the batch that inserted it'
);
console.log('✅ insertValid tags every inserted MCQ with source_batch_id');

const ImportBatchModel = makeImportBatchModel([
  { _id: 'batch_oid_1', batch_id: BAD_BATCH_ID, status: 'failed' },
]);

const deleteResult = await deleteImportBatch(BAD_BATCH_ID, MCQModel, ImportBatchModel);
assert.equal(deleteResult.deletedMcqCount, 10, 'expected all 10 tagged MCQs to be cascade-deleted');
assert.equal(MCQModel._store.length, 0, 'MCQ store should be empty after cascade delete');
assert.equal(await ImportBatchModel.findOne({ batch_id: BAD_BATCH_ID }), null, 'batch record itself should be gone');

console.log('✅ deleteImportBatch cascades — deleting a batch removes every MCQ it inserted');
console.log('\n✅ PASS — a deleted "bad" batch leaves zero trace, so re-importing the same file will not be flagged as duplicate.');
