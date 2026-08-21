// Standalone verification script — NOT part of the app.
//
// Reproduces the "5 rows in, 4 inserted" / "100 rows in, ~70 inserted"
// symptom without needing a live MongoDB: findNearDuplicates() only
// needs an object with a `.find(filter, projection).limit(n).lean()`
// chain, so a minimal in-memory stub of that is enough to run the real
// duplicateDetector.js code end-to-end.
//
// Scenario: the DB already has one APPROVED English "synonym" MCQ
// (a common situation once a bank has been imported/approved before).
// The new batch being imported contains a DIFFERENT synonym question —
// same template ("Choose the word most SIMILAR in meaning to 'X':"),
// different target word, different options, different correct answer.
// Before the fix, comparing question-stem-only text scored these two
// as 85%+ similar and silently diverted the new, legitimate question
// into the duplicate-review queue instead of inserting it.

import assert from 'node:assert/strict';
import { findNearDuplicates } from '../src/utils/duplicateDetector.js';

class FakeMCQModel {
  constructor(existingDocs) {
    this._docs = existingDocs;
  }

  find(filter) {
    const matches = this._docs.filter(
      (d) => d.subject === filter.subject && d.status === filter.status
    );
    return {
      limit() {
        return this;
      },
      lean: async () => matches,
    };
  }
}

const existingApproved = [
  {
    question_id: 'Q00001',
    subject: 'English',
    status: 'approved',
    question: "Choose the word most SIMILAR in meaning to 'DILIGENT':",
    options: { A: 'Lazy', B: 'Hardworking', C: 'Careless', D: 'Slow' },
  },
];

const incomingBatch = [
  {
    row: 1,
    data: {
      subject: 'English',
      question: "Choose the word most SIMILAR in meaning to 'BENEVOLENT':",
      options: { A: 'Cruel', B: 'Kind', C: 'Hostile', D: 'Greedy' },
    },
  },
];

const MCQModel = new FakeMCQModel(existingApproved);
const result = await findNearDuplicates(incomingBatch, MCQModel, 85);

console.log('nearDuplicatesInDB:', JSON.stringify(result.nearDuplicatesInDB));
console.log('clean:', result.clean.map((c) => c.row));

assert.equal(
  result.nearDuplicatesInDB.length,
  0,
  'expected the different-word synonym question NOT to be flagged as a near-duplicate'
);
assert.equal(result.clean.length, 1, 'expected the row to survive into clean (insertable)');

// Sanity check the other direction: two rows that really ARE the same
// question (only the stem reworded, options/answer identical) should
// still be caught.
const trueDuplicateExisting = [
  {
    question_id: 'Q00002',
    subject: 'English',
    status: 'approved',
    question: "Choose the word most SIMILAR in meaning to 'BENEVOLENT':",
    options: { A: 'Cruel', B: 'Kind', C: 'Hostile', D: 'Greedy' },
  },
];
const rewordedDuplicateBatch = [
  {
    row: 1,
    data: {
      subject: 'English',
      // Trivial formatting drift (spacing/punctuation/case) from the
      // same source question re-exported or re-copied elsewhere --
      // exactly the kind of "actual duplicate" this check exists to
      // catch, as opposed to the different-word templated case above.
      question: "Choose  the word most similar in meaning to BENEVOLENT",
      options: { A: 'Cruel', B: 'Kind', C: 'Hostile', D: 'Greedy' },
    },
  },
];
const model2 = new FakeMCQModel(trueDuplicateExisting);
const result2 = await findNearDuplicates(rewordedDuplicateBatch, model2, 85);

console.log('\ntrue-duplicate nearDuplicatesInDB:', JSON.stringify(result2.nearDuplicatesInDB));

assert.equal(
  result2.nearDuplicatesInDB.length,
  1,
  'expected a genuinely reworded duplicate (same options/answer) to still be caught'
);

console.log(
  '\n✅ PASS — templated-but-different questions no longer false-positive, ' +
    'genuine reworded duplicates are still caught.'
);
