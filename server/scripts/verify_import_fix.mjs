// Standalone verification script — NOT part of the app.
//
// Real MongoDB isn't reachable from this sandbox, so this reproduces
// the exact semantics that caused the bug using a minimal in-memory
// stub of the pieces of Mongoose that matter here:
//   1. `new MCQModel(data)` — a plain object, no hooks run.
//   2. `doc.validate()` — only runs pre('validate'), never pre('save').
//   3. `MCQModel.insertMany(docs, { ordered:false })` — does NOT run
//      pre('save') hooks (this is real, documented Mongoose behavior),
//      and enforces a unique index on `question_id`, throwing an
//      aggregated bulk-write error with `insertedDocs` / `writeErrors`
//      for whatever succeeded/failed — exactly like MongoDB does.
//
// This isolates the ONE thing we changed (insertValid explicitly
// assigning question_hash/question_id before insertMany) from every
// other moving part, so we can prove the fix independent of Mongo
// being available.

import assert from 'node:assert/strict';
import { insertValid } from '../src/services/import.service.js';

class FakeDoc {
  constructor(data) {
    Object.assign(this, data);
    this._id = `oid_${FakeDoc._seq++}`;
  }

  // Mirrors MCQ.js's pre('validate') hook: correct_answer must match a
  // non-empty option. Deliberately does NOT set question_hash/
  // question_id here — those are pre('save') hooks in the real model,
  // and insertMany() never runs pre('save').
  async validate() {
    const optionText = this.options?.[this.correct_answer];
    if (!optionText || String(optionText).trim().length === 0) {
      throw new Error(`correct_answer "${this.correct_answer}" has no matching option text`);
    }
  }
}
FakeDoc._seq = 1;

// Fake collection with a real unique index on question_id, exactly
// like MongoDB would enforce it (missing field treated as null; only
// one document may have a given value, including null).
class FakeMCQModel {
  constructor() {
    this._store = [];
  }

  // eslint-disable-next-line class-methods-use-this
  new_(data) {
    return new FakeDoc(data);
  }

  async insertMany(docs, { ordered } = {}) {
    if (ordered) throw new Error('test only supports ordered:false');

    const insertedDocs = [];
    const writeErrors = [];
    const seenQuestionIds = new Set(this._store.map((d) => d.question_id ?? null));

    docs.forEach((doc, index) => {
      const key = doc.question_id ?? null; // MongoDB: missing field ~ null for unique index purposes
      if (seenQuestionIds.has(key)) {
        writeErrors.push({
          index,
          errmsg: `E11000 duplicate key error collection: exam.mcqs index: question_id_1 dup key: { question_id: ${JSON.stringify(key)} }`,
        });
        return;
      }
      seenQuestionIds.add(key);
      this._store.push(doc);
      insertedDocs.push(doc);
    });

    if (writeErrors.length > 0) {
      const err = new Error(`${writeErrors.length} write errors`);
      err.insertedDocs = insertedDocs;
      err.writeErrors = writeErrors;
      throw err;
    }

    return insertedDocs;
  }
}

// Mongoose's Model constructor is normally called as `new MCQModel(data)`.
// Wrap FakeMCQModel so `new MCQModel(data)` and `MCQModel.insertMany(...)`
// both work the way import.service.js actually calls them.
function makeModelConstructor() {
  const store = new FakeMCQModel();
  function MCQModel(data) {
    return store.new_(data);
  }
  MCQModel.insertMany = (...args) => store.insertMany(...args);
  return MCQModel;
}

const sampleRow = (i) => ({
  row: i,
  data: {
    question: `Sample question number ${i} needs ten chars`,
    options: { A: 'Karachi', B: 'Islamabad', C: 'Lahore', D: 'Peshawar' },
    correct_answer: 'B',
    subject: 'Pakistan Affairs',
    topic: 'Geography',
    subtopic: 'Capitals',
    difficulty: 'easy',
    exam_tags: ['MOD', 'FPSC'],
    cognitive_level: 'recall',
    quality_score: 80,
  },
});

const rows = Array.from({ length: 100 }, (_, i) => sampleRow(i + 1));

const MCQModel = makeModelConstructor();
const result = await insertValid(rows, MCQModel, 'IMPORT_2026_TEST');

console.log('insertedCount:', result.insertedCount);
console.log('insertErrors:', result.insertErrors.length);
console.log('insertedIds sample:', result.insertedIds.slice(0, 3), '...');

assert.equal(result.insertedCount, 100, 'expected all 100 rows to insert after the fix');
assert.equal(result.insertErrors.length, 0, 'expected zero insert errors after the fix');
assert.equal(new Set(result.insertedIds).size, 100, 'expected 100 distinct inserted ids');

console.log('\n✅ PASS — all 100 rows inserted (previously only 1 would have inserted).');
