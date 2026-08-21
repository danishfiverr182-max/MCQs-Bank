// Standalone verification script — NOT part of the app, mirrors the
// existing server/scripts/verify_*.mjs pattern (e.g.
// verify_new_subtopics_detection.mjs), extended to also exercise the
// REAL client-side utility from Prompt 2 (client/src/utils/
// detectNewSubtopics.js is plain, framework-free ESM, so it can be
// imported directly here — no live browser, no live MongoDB).
//
// This is Prompt 5's hardening check for sequential/rapid imports:
//
//   1. mergeSubtopicsIntoBank + advanceRange (promptState.service.js's
//      real algorithms, replayed in-memory the same way
//      verify_new_subtopics_detection.mjs replays
//      ensureTaxonomyForInsertedDocs — the real functions require a
//      live Mongoose connection via PromptState.getOrCreate(), so the
//      pure computational logic is mirrored here instead) behave
//      correctly across TWO back-to-back imports:
//        - the final subtopic_bank contains the union of both imports'
//          genuinely new subtopics, slug-deduplicated (mergeSubtopics-
//          IntoBank's own existingSlugs check — see
//          promptState.service.js lines ~50-60)
//        - range_start/range_end advance exactly twice, once per
//          import, using batch_size each time (matches advanceRange's
//          real formula)
//   2. The REAL client-side findNewSubtopics (Prompt 2) — given the
//      confirmedBank as it would look AFTER import #1 has been merged
//      and refetched (Prompt 4's refreshSignal flow) — does NOT
//      re-flag import #1's subtopics as "new" during import #2's
//      optimistic preview, even when import #2's file reuses one of
//      import #1's subtopic names in a different case/whitespace form.
//      This is the specific staleness risk Prompt 5 was asked to trace
//      for back-to-back imports of different JSON files.
//
// Run with: node server/scripts/verify_sequential_import_prompt_state.mjs

import assert from 'node:assert/strict';
import { slugify } from '../src/utils/slugify.js';
import { findNewSubtopics } from '../../client/src/utils/detectNewSubtopics.js';

// ── In-memory PromptState + the two service functions, replayed ────
// Mirrors promptState.service.js's mergeSubtopicsIntoBank/advanceRange
// EXACTLY for their computational logic — only the Mongoose read/write
// calls (PromptState.getOrCreate/updateOne/findOneAndUpdate) are
// replaced with plain object mutation, since there's no live DB here.
function makePromptState({ batchSize = 100, totalCap = 1000 } = {}) {
  return {
    subtopic_bank: [],
    range_start: 1,
    range_end: batchSize,
    batch_size: batchSize,
    total_cap: totalCap,
  };
}

// Mirrors mergeSubtopicsIntoBank's exact dedup logic: appends each name
// whose slug isn't already in subtopic_bank, in order, never removes,
// never reorders.
function mergeSubtopicsIntoBank(state, newSubtopics = []) {
  if (!Array.isArray(newSubtopics) || newSubtopics.length === 0) return;

  const existingSlugs = new Set(state.subtopic_bank.map((name) => slugify(name)));
  const toAdd = [];

  for (const name of newSubtopics) {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) continue;
    const slug = slugify(trimmed);
    if (existingSlugs.has(slug)) continue;
    existingSlugs.add(slug);
    toAdd.push(trimmed);
  }

  state.subtopic_bank.push(...toAdd);
}

// Mirrors advanceRange's exact formula, including the wrap-to-1 past
// total_cap.
function advanceRange(state) {
  let newStart = state.range_end + 1;
  if (newStart > state.total_cap) {
    newStart = 1;
  }
  const newEnd = Math.min(newStart + state.batch_size - 1, state.total_cap);
  state.range_start = newStart;
  state.range_end = newEnd;
}

// ── Test: two back-to-back imports, server-side state ────────────────
{
  const state = makePromptState({ batchSize: 100, totalCap: 1000 });
  let advanceCount = 0;

  // Import #1: two genuinely new subtopics.
  mergeSubtopicsIntoBank(state, ['Capitals', 'Rivers & Dams']);
  advanceRange(state);
  advanceCount += 1;

  assert.deepEqual(state.subtopic_bank, ['Capitals', 'Rivers & Dams'], 'import #1 should add both subtopics');
  assert.equal(state.range_start, 101, 'import #1 should advance range_start to 101');
  assert.equal(state.range_end, 200, 'import #1 should advance range_end to 200');

  // Import #2: reuses import #1's subtopics in different case/whitespace
  // (must NOT duplicate), plus one genuinely new subtopic.
  mergeSubtopicsIntoBank(state, ['capitals', '  Rivers & Dams  ', 'Nuclear Policy']);
  advanceRange(state);
  advanceCount += 1;

  assert.deepEqual(
    state.subtopic_bank,
    ['Capitals', 'Rivers & Dams', 'Nuclear Policy'],
    'import #2 should add only the genuinely new subtopic, not duplicate reused ones (slug-deduped)'
  );
  assert.equal(state.range_start, 201, 'import #2 should advance range_start to 201');
  assert.equal(state.range_end, 300, 'import #2 should advance range_end to 300');
  assert.equal(advanceCount, 2, 'range must have advanced exactly twice, once per import');

  console.log('✅ Test 1 passed: two sequential imports merge a deduped subtopic union and advance range exactly twice.');
}

// ── Test: client-side pending preview stays correct across the same
//    two imports (the Prompt 5 staleness trace) ─────────────────────
{
  const rawTextImport1 = JSON.stringify({
    questions: [
      { question: 'q1', subtopic: 'Capitals' },
      { question: 'q2', subtopic: 'Rivers & Dams' },
    ],
  });

  // confirmedBank before import #1 has ever run — matches BulkImport's
  // `confirmedBank` state as loaded from ConversionPromptPanel's
  // initial mount fetch.
  const confirmedBankBeforeImport1 = [];
  const pendingForImport1 = findNewSubtopics(rawTextImport1, confirmedBankBeforeImport1);
  assert.deepEqual(
    pendingForImport1.map((p) => p.name).sort(),
    ['Capitals', 'Rivers & Dams'].sort(),
    'import #1 preview should flag both subtopics as pending (bank is empty)'
  );

  // Simulate Prompt 4's reconciliation: after import #1's response
  // arrives, refreshSignal triggers ConversionPromptPanel to refetch,
  // which calls handleBankChange with the server's now-updated bank —
  // exactly what merging pendingForImport1's names would produce.
  const confirmedBankAfterImport1 = ['Capitals', 'Rivers & Dams'];

  // Import #2's file reuses import #1's subtopics under different
  // case/whitespace (the exact staleness risk being traced), plus one
  // genuinely new one.
  const rawTextImport2 = JSON.stringify({
    questions: [
      { question: 'q3', subtopic: 'capitals' }, // reused, different case
      { question: 'q4', subtopic: '  Rivers & Dams  ' }, // reused, padded
      { question: 'q5', subtopic: 'Nuclear Policy' }, // genuinely new
    ],
  });

  const pendingForImport2 = findNewSubtopics(rawTextImport2, confirmedBankAfterImport1);
  assert.deepEqual(
    pendingForImport2.map((p) => p.name),
    ['Nuclear Policy'],
    "import #2 preview must NOT re-flag import #1's already-confirmed subtopics, even in a different case/whitespace form"
  );

  console.log(
    "✅ Test 2 passed: the client's pending preview for import #2 does not go stale — it correctly excludes import #1's now-confirmed subtopics and reports only the genuinely new one."
  );
}

// ── Test: a THIRD import's preview, if a refetch never happened
//    (defensive — confirms the panel's Prompt 3 reconciledPending
//    filter, not just BulkImport's confirmedBank, would still be
//    correct if it somehow saw a stale pending list) ────────────────
{
  // If, hypothetically, confirmedBank were still stale (e.g. the
  // refetch from import #1 hadn't landed yet), a subsequent diff
  // against the ORIGINAL empty bank would over-report reused names.
  // This is exactly why Prompt 1's isUploading guard matters: the
  // upload button/paste modal stay disabled for the entire in-flight
  // window (through the 500ms "done" pause, since isUploading is only
  // ever reset to false in the error path — success always navigates
  // away instead), so a second import literally cannot start before
  // the first one's response — and therefore its refreshSignal-
  // triggered refetch — has already resolved. This test just documents
  // what WOULD happen if that guard were ever removed, as a canary.
  const staleBank = []; // what confirmedBank would incorrectly still be
  const rawTextImport2 = JSON.stringify({
    questions: [
      { question: 'q3', subtopic: 'Capitals' },
      { question: 'q5', subtopic: 'Nuclear Policy' },
    ],
  });
  const wouldBeOverReported = findNewSubtopics(rawTextImport2, staleBank);
  assert.equal(
    wouldBeOverReported.length,
    2,
    'canary: confirms a stale/empty confirmedBank WOULD over-report — this is why the isUploading guard (Prompt 1) blocking a second import until the first fully resolves is load-bearing, not incidental'
  );
  console.log('✅ Test 3 passed (canary): confirms why the isUploading guard is load-bearing for pending-preview correctness.');
}

console.log('\nAll sequential-import hardening checks passed.');
