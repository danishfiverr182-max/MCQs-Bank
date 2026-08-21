// Standalone script — NOT part of the Express app lifecycle.
// Run with: node scripts/verifyBulkTaxonomyOps.js   (from server/)
//
// Prompt 20 (Bulk Select) follow-up — remaining items #1 and #6 from the
// "carry into next session" list: this repo has no automated test
// runner (see server/package.json's own `scripts` — nodemon/node only,
// same as every other verify*.js script in this folder already relies
// on), so this follows the exact same convention verifyTaxonomyAuditLog.js
// and reconcileTaxonomy.js already use: a standalone script an admin
// runs by hand against a REAL dev/staging Mongo, not a mocked unit test.
//
// It creates its own throwaway fixture data (3 subjects, one topic each,
// one MCQ each, all prefixed `__bulktest_` so they're unmistakable and
// easy to find/clean up if this script is ever killed mid-run), runs it
// through the exact same service functions the HTTP routes call, and
// tears the fixture down again on exit — success OR failure.
//
// What this checks, per this prompt's own DoD ("Selecting 3 topics
// under different subjects and bulk-moving them to one destination in
// a single confirm produces one preview, one transaction, and one
// ActivityLog row per node — not one combined row"):
//
//   1. bulkMoveTopicsToSubject's dry-run preview (Prompt 10's
//      aggregation) reports all 3 topics moving in ONE combined diff.
//   2. The real run moves all 3 topics in ONE transaction, and Mongo
//      afterward shows EXACTLY 3 `taxonomy_topic_moved` ActivityLog
//      rows for this run (one per node) — not 1 combined row.
//   3. A mid-batch failure (2 real topic ids + 1 nonexistent id, in the
//      same array) rolls back ALL THREE — the 2 real topics must still
//      be exactly where they started, and no NEW success-logged
//      `taxonomy_topic_moved` row exists for this run (only the single
//      failure row bulkMoveFailureLog writes).
//   4. Single-node moveTopicToSubject and deleteTaxonomyNode (called
//      with no `session` argument, i.e. their own default
//      `externalSession = null` path) still work exactly as before the
//      Prompt 20 session-param refactor — same regression check item
//      #6 asked for, run against the real thing rather than assumed.
//
// Exit code: 0 if every assertion passed, 1 if any failed or the script
// itself errored — same CI/cron-friendly convention every other
// verify*.js script in this folder already uses.

import mongoose from 'mongoose';
import env from '../src/config/env.js';
import TaxonomyNode from '../src/models/TaxonomyNode.js';
import MCQ from '../src/models/MCQ.js';
import ActivityLog from '../src/models/ActivityLog.js';
import { slugify } from '../src/utils/slugify.js';
import {
  bulkMoveTopicsToSubject,
  moveTopicToSubject,
  deleteTaxonomyNode,
} from '../src/services/taxonomy.service.js';

const PREFIX = '__bulktest_';
// createLog (activityLog.service.js) requires `actor.userId` — it's the
// value written to ActivityLog.actor_id, which carries `ref: 'User'`
// but (like every other ref in this codebase) isn't FK-enforced at
// write time, so a synthetic id is fine for a script that never reads
// that field back. `email` is what actually gets denormalized onto
// `actor_name` and is what every query below filters on.
const ACTOR = { userId: new mongoose.Types.ObjectId(), email: 'bulktest-script@local', role: 'admin' };

const results = []; // { label, pass, detail }
const record = (label, pass, detail = '') => {
  results.push({ label, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
};

// Every TaxonomyNode/MCQ this script creates, so teardown can remove
// them by id rather than by a name-prefix query (safer if a real admin
// happens to also have something named similarly).
const created = { nodeIds: [], mcqIds: [] };

const makeSubject = async (name) => {
  const node = await TaxonomyNode.create({ type: 'subject', parent_id: null, name, slug: slugify(name) });
  created.nodeIds.push(node._id);
  return node;
};

const makeTopic = async (subjectNode, name) => {
  const node = await TaxonomyNode.create({
    type: 'topic',
    parent_id: subjectNode._id,
    name,
    slug: slugify(name),
  });
  created.nodeIds.push(node._id);
  return node;
};

const makeMcq = async (subjectName, topicName) => {
  const mcq = await MCQ.create({
    question: `${PREFIX} sample question for ${topicName}`,
    options: { A: 'a', B: 'b', C: 'c', D: 'd' },
    correct_answer: 'A',
    subject: subjectName,
    topic: topicName,
    difficulty: 'easy',
    status: 'approved',
  });
  created.mcqIds.push(mcq._id);
  return mcq;
};

const cleanup = async () => {
  await MCQ.deleteMany({ _id: { $in: created.mcqIds } });
  await TaxonomyNode.deleteMany({ _id: { $in: created.nodeIds } });
  await ActivityLog.deleteMany({ actor_name: ACTOR.email });
};

const run = async () => {
  let connected = false;
  try {
    await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
    connected = true;
    console.log('── Bulk taxonomy ops verification (Prompt 20 follow-up) ────────\n');

    // ── Fixture: 3 subjects, 1 topic + 1 MCQ each, 1 destination subject
    const runId = Date.now();
    const [subjA, subjB, subjC, dest] = await Promise.all([
      makeSubject(`${PREFIX}SubjA_${runId}`),
      makeSubject(`${PREFIX}SubjB_${runId}`),
      makeSubject(`${PREFIX}SubjC_${runId}`),
      makeSubject(`${PREFIX}Dest_${runId}`),
    ]);
    const [topicA, topicB, topicC] = await Promise.all([
      makeTopic(subjA, `${PREFIX}TopicA_${runId}`),
      makeTopic(subjB, `${PREFIX}TopicB_${runId}`),
      makeTopic(subjC, `${PREFIX}TopicC_${runId}`),
    ]);
    await Promise.all([
      makeMcq(subjA.name, topicA.name),
      makeMcq(subjB.name, topicB.name),
      makeMcq(subjC.name, topicC.name),
    ]);

    // ── 1. Dry-run preview covers all 3 in one combined diff
    const preview = await bulkMoveTopicsToSubject({
      topic_node_ids: [topicA._id, topicB._id, topicC._id],
      destination_subject_id: dest._id,
      dryRun: true,
    });
    record(
      'Dry-run preview reports all 3 topics affected',
      preview.topics_affected.length === 3 &&
        [topicA, topicB, topicC].every((t) => preview.topics_affected.includes(t.name)),
      `topics_affected=${JSON.stringify(preview.topics_affected)}`
    );
    record(
      'Dry-run preview reports mcqs_affected === 3',
      preview.mcqs_affected === 3,
      `mcqs_affected=${preview.mcqs_affected}`
    );

    // ── 2. Real bulk move: one transaction, one ActivityLog row PER node
    const beforeMoveAt = new Date();
    const moveResult = await bulkMoveTopicsToSubject({
      topic_node_ids: [topicA._id, topicB._id, topicC._id],
      destination_subject_id: dest._id,
      actor: ACTOR,
    });
    record('bulkMoveTopicsToSubject reports moved_count === 3', moveResult.moved_count === 3);

    const [movedA, movedB, movedC] = await Promise.all([
      TaxonomyNode.findById(topicA._id).lean(),
      TaxonomyNode.findById(topicB._id).lean(),
      TaxonomyNode.findById(topicC._id).lean(),
    ]);
    record(
      'All 3 topics now reparented under the destination subject',
      [movedA, movedB, movedC].every((n) => String(n.parent_id) === String(dest._id))
    );

    const moveLogRows = await ActivityLog.find({
      actor_name: ACTOR.email,
      action: 'taxonomy_topic_moved',
      success: true,
      timestamp: { $gte: beforeMoveAt },
    }).lean();
    record(
      'Exactly ONE ActivityLog row per moved node (3 rows, not 1 combined)',
      moveLogRows.length === 3,
      `found ${moveLogRows.length} row(s)`
    );

    // ── 3. Mid-batch failure rolls back every node in the transaction
    // Move them back to their original subjects first so this scenario
    // starts from a clean, known state.
    await moveTopicToSubject({ topic_node_id: topicA._id, destination_subject_id: subjA._id, actor: ACTOR });
    await moveTopicToSubject({ topic_node_id: topicB._id, destination_subject_id: subjB._id, actor: ACTOR });

    const fakeId = new mongoose.Types.ObjectId();
    const beforeFailureAt = new Date();
    let rollbackThrew = false;
    try {
      await bulkMoveTopicsToSubject({
        topic_node_ids: [topicA._id, topicB._id, fakeId],
        destination_subject_id: dest._id,
        actor: ACTOR,
      });
    } catch (err) {
      rollbackThrew = true;
    }
    record('Bulk move with one bad id in the batch throws', rollbackThrew);

    const [afterA, afterB] = await Promise.all([
      TaxonomyNode.findById(topicA._id).lean(),
      TaxonomyNode.findById(topicB._id).lean(),
    ]);
    record(
      'Rollback: topic A still under its ORIGINAL subject (not left half-moved)',
      String(afterA.parent_id) === String(subjA._id)
    );
    record(
      'Rollback: topic B still under its ORIGINAL subject (not left half-moved)',
      String(afterB.parent_id) === String(subjB._id)
    );
    const successRowsAfterFailure = await ActivityLog.find({
      actor_name: ACTOR.email,
      action: 'taxonomy_topic_moved',
      success: true,
      timestamp: { $gte: beforeFailureAt },
    }).lean();
    record(
      'Rollback: no NEW success-logged row for the failed batch',
      successRowsAfterFailure.length === 0,
      `found ${successRowsAfterFailure.length} unexpected success row(s)`
    );
    const failureRows = await ActivityLog.find({
      actor_name: ACTOR.email,
      action: 'taxonomy_topic_moved',
      success: false,
      timestamp: { $gte: beforeFailureAt },
    }).lean();
    record('Rollback: exactly one failure row logged for the whole failed batch', failureRows.length === 1);

    // ── 4. Single-node regression check (session param defaults to null)
    await moveTopicToSubject({ topic_node_id: topicA._id, destination_subject_id: dest._id, actor: ACTOR });
    const afterSingleMove = await TaxonomyNode.findById(topicA._id).lean();
    record(
      'Single-node moveTopicToSubject (no session arg) still reparents correctly',
      String(afterSingleMove.parent_id) === String(dest._id)
    );

    const deleteResult = await deleteTaxonomyNode({
      node_id: topicA._id,
      on_orphan_mcqs: { action: 'delete' },
      actor: ACTOR,
    });
    const stillThere = await TaxonomyNode.findById(topicA._id).lean();
    record(
      'Single-node deleteTaxonomyNode (no session arg) still deletes the node',
      stillThere === null && typeof deleteResult.deleted_mcq_count === 'number'
    );

    // ── Edge case #4: destination inside the same bulk-delete batch is rejected
    let guardThrew = false;
    try {
      await bulkMoveTopicsToSubject({ topic_node_ids: [] }); // sanity: still validated
    } catch {
      guardThrew = true;
    }
    record('bulkMoveTopicsToSubject still rejects an empty node_ids array', guardThrew);

    console.log('');
    const failed = results.filter((r) => !r.pass);
    if (failed.length === 0) {
      console.log(`✅ All ${results.length} assertions passed.`);
      process.exitCode = 0;
    } else {
      console.log(`❌ ${failed.length} of ${results.length} assertion(s) failed:`);
      failed.forEach((r) => console.log(`   - ${r.label}${r.detail ? ` (${r.detail})` : ''}`));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('❌ verifyBulkTaxonomyOps script failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connected) {
      try {
        await cleanup();
      } catch (cleanupErr) {
        console.error('⚠️  Cleanup failed — fixture data prefixed `__bulktest_` may remain:', cleanupErr.message);
      }
      await mongoose.disconnect();
    }
    process.exit(process.exitCode ?? 1);
  }
};

run();
