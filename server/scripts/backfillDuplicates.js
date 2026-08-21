// Standalone script — NOT part of the Express app lifecycle.
// Run with: node scripts/backfillDuplicates.js            (report only, no changes)
//           node scripts/backfillDuplicates.js --delete    (also removes duplicates)
//
// WHY THIS SCRIPT EXISTS
// ───────────────────────────────────────────────────────────────────
// duplicateDetector.js's exact-match check relies on every MCQ having a
// precomputed `question_hash` field. Any MCQ inserted before that field
// existed on the schema has no hash — so when the SAME content is
// imported again later, the duplicate-check query (`question_hash: {
// $in: [...] }`) can't find the old rows at all, and the "duplicate"
// gets inserted as a brand-new MCQ with a different question_id. This
// is almost certainly how two full copies of the same 100-question
// import ended up in the database with different question_ids — this
// script fixes both the missing-hash root cause and the duplicates it
// already allowed through.
//
// STEP 1 (always runs): backfill question_hash on every MCQ missing it,
// so future imports can actually detect a repeat against ALL existing
// data, not just documents inserted after the hash field was added.
//
// STEP 2 (report by default, deletes only with --delete): groups MCQs
// by question_hash, reports every group with more than one document,
// and — only if --delete is passed — removes every document in a
// duplicate group except the one with the lowest question_id (i.e.
// keeps the original, removes the later re-imported copies). Deleting
// is opt-in and off by default since a duplicate MCQ may already be
// referenced by a past GeneratedTest — see MCQ.js / generator.service.js
// comments on why a referenced-but-deleted MCQ is handled gracefully
// (flagged question_unavailable) rather than silently disallowed, but
// it's still safer to let an admin review the report first.

import mongoose from 'mongoose';
import env from '../src/config/env.js';
import MCQ from '../src/models/MCQ.js';
import { normalizeQuestion, hashQuestion } from '../src/utils/duplicateDetector.js';

const shouldDelete = process.argv.includes('--delete');

const run = async () => {
  let connected = false;

  try {
    await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
    connected = true;

    // ── Step 1: backfill missing question_hash ──────────────────────
    const missingHash = await MCQ.find(
      { $or: [{ question_hash: { $exists: false } }, { question_hash: null }] },
      { _id: 1, question: 1 }
    ).lean();

    console.log(`Found ${missingHash.length} MCQ(s) missing question_hash.`);

    let backfilled = 0;
    for (const doc of missingHash) {
      const hash = hashQuestion(normalizeQuestion(doc.question));
      // eslint-disable-next-line no-await-in-loop
      await MCQ.updateOne({ _id: doc._id }, { $set: { question_hash: hash } });
      backfilled += 1;
    }
    console.log(`Backfilled question_hash on ${backfilled} MCQ(s).`);

    // ── Step 2: find duplicate groups by hash ───────────────────────
    const all = await MCQ.find({}, { question_id: 1, question_hash: 1, question: 1 })
      .sort({ question_id: 1 })
      .lean();

    const byHash = new Map();
    all.forEach((doc) => {
      if (!byHash.has(doc.question_hash)) byHash.set(doc.question_hash, []);
      byHash.get(doc.question_hash).push(doc);
    });

    const duplicateGroups = [...byHash.values()].filter((group) => group.length > 1);
    const totalExtraCopies = duplicateGroups.reduce((sum, g) => sum + (g.length - 1), 0);

    console.log(`\nFound ${duplicateGroups.length} duplicate question group(s), ${totalExtraCopies} extra copy/copies total.`);
    duplicateGroups.forEach((group) => {
      const ids = group.map((d) => d.question_id).join(', ');
      console.log(`  - "${group[0].question.slice(0, 70)}..." → ${ids}`);
    });

    if (!shouldDelete) {
      console.log('\nDry run only — no documents deleted. Re-run with --delete to remove the extra copies (keeps the lowest question_id in each group).');
    } else {
      let deletedCount = 0;
      for (const group of duplicateGroups) {
        const [, ...extras] = group; // keep first (lowest question_id), remove the rest
        const idsToDelete = extras.map((d) => d._id);
        // eslint-disable-next-line no-await-in-loop
        const result = await MCQ.deleteMany({ _id: { $in: idsToDelete } });
        deletedCount += result.deletedCount ?? 0;
      }
      console.log(`\nDeleted ${deletedCount} duplicate MCQ document(s).`);
    }

    process.exitCode = 0;
  } catch (error) {
    console.error('❌ Backfill/duplicate-check failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
    process.exit(process.exitCode ?? 1);
  }
};

run();
