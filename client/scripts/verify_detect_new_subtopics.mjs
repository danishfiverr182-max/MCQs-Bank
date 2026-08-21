// Standalone verification script — NOT part of the app, mirrors the
// existing server/scripts/verify_*.mjs pattern, adapted for a pure
// client-side utility (no live browser or MongoDB needed — just Node
// running the real module via a relative import).
//
// Checks client/src/utils/detectNewSubtopics.js's findNewSubtopics():
//
//   1. Basic case: subtopics not in the bank are reported; subtopics
//      already in the bank are not.
//   2. Case/whitespace-insensitive matching against the bank — matches
//      slugify's normalization (mirrors
//      server/scripts/verify_new_subtopics_detection.mjs's Test 2 for
//      the equivalent server-side behavior).
//   3. Within-file de-duplication — the same subtopic text repeated
//      across many rows is reported once, not once per row.
//   4. The blank '' subtopic ("(none)" bucket) is never reported, even
//      when present in the file.
//   5. Malformed / unparsable JSON degrades to an empty result rather
//      than throwing.
//   6. Both accepted JSON shapes — a bare array and a
//      { questions: [...] } envelope — are read identically.
//   7. An empty currentBank reports every distinct, non-blank subtopic
//      in the file.
//
// Run with: node client/scripts/verify_detect_new_subtopics.mjs

import assert from 'node:assert/strict';
import { findNewSubtopics } from '../src/utils/detectNewSubtopics.js';

const sortByName = (arr) => [...arr].sort((a, b) => a.name.localeCompare(b.name));

// ── Test 1: basic new-vs-existing split ──────────────────────────────
{
  const bank = ['Capitals', 'Rivers & Dams'];
  const rawText = JSON.stringify({
    questions: [
      { question: 'q1', subtopic: 'Capitals' }, // already in bank
      { question: 'q2', subtopic: 'Space Exploration' }, // new
      { question: 'q3', subtopic: 'Nuclear Policy' }, // new
    ],
  });

  const result = findNewSubtopics(rawText, bank);
  assert.deepEqual(
    sortByName(result).map((r) => r.name),
    ['Nuclear Policy', 'Space Exploration'],
    'should report only the subtopics not already in the bank'
  );
  assert.deepEqual(
    new Set(result.map((r) => r.slug)),
    new Set(['nuclear-policy', 'space-exploration']),
    'each result entry should carry its computed slug'
  );
  console.log('✅ Test 1 passed: reports only subtopics missing from the bank.');
}

// ── Test 2: case/whitespace-insensitive match against the bank ──────
{
  const bank = ['Pakistan Foreign Policy'];
  const rawText = JSON.stringify({
    questions: [
      { question: 'q1', subtopic: 'pakistan foreign policy' }, // same slug, different case
      { question: 'q2', subtopic: '  Pakistan Foreign Policy  ' }, // same slug, padded
      { question: 'q3', subtopic: 'PAKISTAN FOREIGN POLICY' }, // same slug, upper
      { question: 'q4', subtopic: 'Rivers & Dams' }, // genuinely new
    ],
  });

  const result = findNewSubtopics(rawText, bank);
  assert.deepEqual(
    result.map((r) => r.name),
    ['Rivers & Dams'],
    'case/whitespace variants of an existing bank entry must not be reported as new'
  );
  console.log('✅ Test 2 passed: case/whitespace variants of an existing bank entry are filtered out (matches slugify).');
}

// ── Test 3: within-file de-duplication ───────────────────────────────
{
  const rawText = JSON.stringify({
    questions: Array.from({ length: 40 }, (_, i) => ({
      question: `q${i}`,
      subtopic: i % 2 === 0 ? 'Capitals' : 'capitals ', // same slug both ways
    })),
  });

  const result = findNewSubtopics(rawText, []);
  assert.equal(result.length, 1, 'the same subtopic repeated across many rows must collapse to one entry');
  assert.equal(result[0].slug, 'capitals');
  console.log('✅ Test 3 passed: repeated subtopic text within one file is deduped to a single entry.');
}

// ── Test 4: blank subtopic is never reported ─────────────────────────
{
  const rawText = JSON.stringify({
    questions: [
      { question: 'q1', subtopic: '' },
      { question: 'q2' }, // subtopic field missing entirely
      { question: 'q3', subtopic: '   ' }, // whitespace-only
      { question: 'q4', subtopic: 'Real Subtopic' },
    ],
  });

  const result = findNewSubtopics(rawText, []);
  assert.deepEqual(result.map((r) => r.name), ['Real Subtopic'], 'blank/missing/whitespace-only subtopics must never be reported');
  console.log('✅ Test 4 passed: blank, missing, and whitespace-only subtopic values are never reported.');
}

// ── Test 5: malformed JSON degrades to empty, never throws ──────────
{
  assert.doesNotThrow(() => findNewSubtopics('{ this is not valid json', ['Capitals']));
  const result = findNewSubtopics('{ this is not valid json', ['Capitals']);
  assert.deepEqual(result, [], 'unparsable JSON should yield an empty result, not throw');

  const resultNoQuestions = findNewSubtopics(JSON.stringify({ notQuestions: [] }), []);
  assert.deepEqual(resultNoQuestions, [], 'JSON without a bare array or a questions[] envelope should yield an empty result');

  console.log('✅ Test 5 passed: malformed or unrecognized JSON shapes degrade to an empty result rather than throwing.');
}

// ── Test 6: both accepted JSON shapes read identically ──────────────
{
  const rows = [
    { question: 'q1', subtopic: 'Oceans, Seas & Gulfs' },
    { question: 'q2', subtopic: 'Mountain Ranges' },
  ];

  const asBareArray = findNewSubtopics(JSON.stringify(rows), []);
  const asEnvelope = findNewSubtopics(JSON.stringify({ questions: rows }), []);

  assert.deepEqual(
    sortByName(asBareArray),
    sortByName(asEnvelope),
    'a bare array and a { questions: [...] } envelope must be read identically'
  );
  console.log('✅ Test 6 passed: bare-array and { questions } envelope shapes are read identically.');
}

// ── Test 7: empty bank reports every distinct, non-blank subtopic ───
{
  const rawText = JSON.stringify({
    questions: [
      { question: 'q1', subtopic: 'A' },
      { question: 'q2', subtopic: 'B' },
      { question: 'q3', subtopic: '' },
    ],
  });

  const result = findNewSubtopics(rawText, []);
  assert.deepEqual(sortByName(result).map((r) => r.name), ['A', 'B'], 'an empty bank should report every distinct non-blank subtopic');
  console.log('✅ Test 7 passed: an empty currentBank reports every distinct, non-blank subtopic in the file.');
}

console.log('\nAll findNewSubtopics checks passed.');
