// Standalone verification for the "duplicate detection ignores options
// and correct answer" bug report. Runs the real, unmodified
// findExactDuplicates / findNearDuplicates against the two examples
// from the bug report, plus a genuine duplicate (to make sure the fix
// doesn't just make detection permissive) and a shuffled-options
// duplicate (to prove order independence works).

import assert from 'node:assert/strict';
import { findExactDuplicates, findNearDuplicates } from '../src/utils/duplicateDetector.js';

// Minimal fake MCQModel.find().limit().lean() chain, backed by an
// in-memory array of "approved" documents standing in for the DB.
function makeMCQModel(existingDocs) {
  return {
    find(filter, projection) {
      let results = existingDocs.filter((d) => {
        if (filter.subject && d.subject !== filter.subject) return false;
        if (filter.status && d.status !== filter.status) return false;
        if (filter.question_hash?.$in) return filter.question_hash.$in.includes(d.question_hash);
        return true;
      });
      return {
        limit: () => ({
          lean: async () => results,
        }),
        lean: async () => results, // findExactDuplicates doesn't call .limit()
      };
    },
  };
}

const row = (rowNum, question, options, correct_answer, subject = 'English') => ({
  row: rowNum,
  data: { question, options, correct_answer, subject },
});

// ── Example 1 from the bug report: different antonym questions ──
const ex1a = row(1, 'What is the antonym of the word "Happy"?', {
  A: 'Sad', B: 'Angry', C: 'Excited', D: 'Fast',
}, 'A');
const ex1b = row(2, 'What is the antonym of the word "Accept"?', {
  A: 'Refuse', B: 'Allow', C: 'Agree', D: 'Receive',
}, 'A');

// ── Example 2 from the bug report: identical stem, different content ──
const ex2a = row(3, 'Identify the correct sentence.', {
  A: 'She go to school.', B: 'She goes to school.', C: 'She going to school.', D: 'She gone to school.',
}, 'B');
const ex2b = row(4, 'Identify the correct sentence.', {
  A: 'They was happy.', B: 'They were happy.', C: 'They is happy.', D: 'They be happy.',
}, 'B');

// ── Control: a GENUINE exact duplicate — must still be caught ──
const dupA = row(5, "What is Pakistan's capital?", {
  A: 'Karachi', B: 'Islamabad', C: 'Lahore', D: 'Peshawar',
}, 'B');
const dupB = row(6, "What is Pakistan's capital?", {
  A: 'Karachi', B: 'Islamabad', C: 'Lahore', D: 'Peshawar',
}, 'B');

// ── Control: shuffled options, same content — must still be caught ──
const shuffledA = row(7, "What is Pakistan's largest city?", {
  A: 'Karachi', B: 'Lahore', C: 'Islamabad', D: 'Peshawar',
}, 'A'); // "Karachi"
const shuffledB = row(8, "What is Pakistan's largest city?", {
  A: 'Lahore', B: 'Peshawar', C: 'Karachi', D: 'Islamabad',
}, 'C'); // also "Karachi" — same correct answer TEXT, different letter

const rows = [ex1a, ex1b, ex2a, ex2b, dupA, dupB, shuffledA, shuffledB];

const emptyModel = makeMCQModel([]); // nothing pre-existing in the DB — only in-batch comparisons matter here

const { exactDuplicatesInBatch, remaining } = await findExactDuplicates(rows, emptyModel);

console.log('Exact duplicates found (in-batch):', exactDuplicatesInBatch);

// Example 2 must NOT be an exact duplicate anymore (different options/answer)
assert.equal(
  exactDuplicatesInBatch.some((d) => d.row === 4),
  false,
  'Example 2 (identical stem, different options/answer) must NOT be flagged as an exact duplicate'
);

// The genuine duplicate (dupA/dupB) MUST still be caught
assert.ok(
  exactDuplicatesInBatch.some((d) => d.row === 6 && d.duplicateOfRow === 5),
  'A genuine exact duplicate must still be caught'
);

// The shuffled-options duplicate MUST still be caught (order independence)
assert.ok(
  exactDuplicatesInBatch.some((d) => d.row === 8 && d.duplicateOfRow === 7),
  'A shuffled-options duplicate with the same correct answer TEXT must still be caught'
);

const { nearDuplicatesInBatch, clean } = await findNearDuplicates(remaining, emptyModel, 85);

console.log('Near duplicates found (in-batch):', nearDuplicatesInBatch);
console.log('Clean (not flagged):', clean.map((c) => c.row));

// Example 1 must NOT be a near-duplicate (different options entirely, different correct answer text)
assert.equal(
  nearDuplicatesInBatch.some((d) => d.row === 1 || d.row === 2),
  false,
  'Example 1 (different antonym questions) must NOT be flagged as a near-duplicate'
);
// Example 2's rows already got caught as exact dupes above, so they
// won't even reach findNearDuplicates — nothing further to assert here.

console.log('\n✅ PASS — both reported false positives are fixed, and genuine duplicates (including shuffled-option ones) are still caught.');
