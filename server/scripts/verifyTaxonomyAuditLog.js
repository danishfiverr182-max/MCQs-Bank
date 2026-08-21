// Standalone script — NOT part of the Express app lifecycle.
// Run with: node scripts/verifyTaxonomyAuditLog.js   (from server/)
//
// Prompt 15's own verification pass. Prompts 14-15 wired every
// structural taxonomy mutation (rename, the three reparenting movers,
// merge, delete — taxonomy.service.js's renameTaxonomyNode/
// moveTopicToSubject/moveSubjectIntoSubject/moveSubtopicToTopic/
// mergeTaxonomyNodes/deleteTaxonomyNode) to write an ActivityLog row
// carrying its own `mcqs_updated` count, inside the SAME transaction
// as the mutation. Prompt 13 separately made every one of those same
// mutations call recalculateTaxonomyCounts to persist a live-derived
// `counts.total` onto the affected TaxonomyNode(s), inside that same
// transaction.
//
// Those are two different pieces of code computing two different
// numbers from two different angles — the ActivityLog row's
// `mcqs_updated` is a byproduct of the MCQ.updateMany/deleteMany call
// the mutation itself ran; a TaxonomyNode's persisted `counts.total`
// is a fresh MCQ.countDocuments/aggregate re-derived independently by
// recalculateTaxonomyCounts. This script adds a THIRD, completely
// independent computation — re-deriving the same count a fourth way,
// by parsing the ActivityLog row's own `new_location` string and
// issuing a plain MCQ.countDocuments query built from scratch, without
// importing or reusing anything from taxonomy.service.js — and prints
// a table comparing all of them. Three independent code paths landing
// on the same number for the same operation is a much stronger
// correctness signal than any one of them being internally consistent
// with itself.
//
// WHAT "MATCH" MEANS, PER ACTION (see the per-row notes in the
// printed table for the reasoning):
//   - taxonomy_node_renamed, taxonomy_topic_moved,
//     taxonomy_subtopic_moved, taxonomy_subject_merged_into_subject:
//     single-target operations — the destination path named in
//     `new_location` should end up containing EXACTLY the MCQs this
//     operation touched, nothing more. `mcqs_updated` (logged),
//     `counts.total` (persisted), and this script's own independent
//     recount should all be equal.
//   - taxonomy_nodes_merged: the survivor may already have had MCQs
//     of its own before the merge, so `mcqs_updated` (only the
//     newly-retagged rows) is generally LESS than the survivor's
//     final `counts.total` — that inequality is expected, not a bug.
//     `counts.total` and the independent recount must still agree
//     with EACH OTHER, which is the actual bug-catching check for
//     this action.
//   - taxonomy_node_deleted with on_orphan_mcqs "move": same
//     "survivor may have pre-existing content" caveat as merge.
//     `counts.total` vs. the independent recount at the destination
//     must still agree.
//   - taxonomy_node_deleted with on_orphan_mcqs "delete": there is no
//     destination node left to check `counts.total` on (the whole
//     subtree was deleted along with it). This script instead
//     independently recounts MCQs still matching the OLD location and
//     asserts that count is now zero — the only thing left to verify
//     for an outright delete.
//
// Exit code: 0 if every row that CAN be checked came back with no
// mismatch, 1 if any mismatch was found OR the script itself errored
// — same CI/cron-friendly convention reconcileTaxonomy.js already
// uses.

import mongoose from 'mongoose';
import env from '../src/config/env.js';
import ActivityLog from '../src/models/ActivityLog.js';
import TaxonomyNode from '../src/models/TaxonomyNode.js';
import MCQ from '../src/models/MCQ.js';

const TAXONOMY_ACTIONS = [
  'taxonomy_node_renamed',
  'taxonomy_topic_moved',
  'taxonomy_subject_merged_into_subject',
  'taxonomy_subtopic_moved',
  'taxonomy_nodes_merged',
  'taxonomy_node_deleted',
];

// Deliberately NOT imported from taxonomy.service.js — this whole
// script's value is that its filter-building logic is written from
// scratch, so a bug shared between recalculateTaxonomyCounts and this
// helper is far less likely than one written once and reused
// everywhere. Case-insensitive on topic/subtopic (same free-typed-
// field reasoning every other independent copy of this trick in the
// codebase already gives), exact on subject.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const independentMcqCount = async (subject, topic, subtopic) => {
  const filter = { subject };
  if (topic !== undefined) filter.topic = { $regex: `^${escapeRegex(topic)}$`, $options: 'i' };
  if (subtopic !== undefined) filter.subtopic = { $regex: `^${escapeRegex(subtopic)}$`, $options: 'i' };
  return MCQ.countDocuments(filter);
};

// Resolves the same (subject, topic?, subtopic?) chain to its
// TaxonomyNode, so `counts.total` (what recalculateTaxonomyCounts
// persisted) can be read straight off it. Returns null if the tree
// has since changed shape enough that the path no longer resolves
// (e.g. a later operation renamed/moved/deleted it again) — reported
// as "stale" rather than a mismatch, since that's a timing artifact of
// running this script long after the fact, not a bug in either number.
const resolveNodeByPath = async (subject, topic, subtopic) => {
  const subjectNode = await TaxonomyNode.findOne({ type: 'subject', name: subject }).lean();
  if (!subjectNode) return null;
  if (topic === undefined) return subjectNode;

  const topicNode = await TaxonomyNode.findOne({
    type: 'topic',
    parent_id: subjectNode._id,
    name: { $regex: `^${escapeRegex(topic)}$`, $options: 'i' },
  }).lean();
  if (!topicNode) return null;
  if (subtopic === undefined) return topicNode;

  const subtopicNode = await TaxonomyNode.findOne({
    type: 'subtopic',
    parent_id: topicNode._id,
    name: { $regex: `^${escapeRegex(subtopic)}$`, $options: 'i' },
  }).lean();
  return subtopicNode ?? null;
};

// Strips the decorations taxonomy.service.js's various oldLocation/
// newLocation strings can carry — deleteTaxonomyNode's " (moved)"
// suffix on a move outcome, its "(deleted — ...)" sentinel on a
// delete-outright outcome, and mergeTaxonomyNodes' "[A, B, C]"
// bracket-list shape (only ever used in `old_location`, never
// `new_location` — a merge's `new_location` is a single surviving
// name, same plain "Subject > Topic" shape rename/move already use,
// see mergeTaxonomyNodes' own oldLocationPath/newLocationPath
// comment) — down to a plain "Subject > Topic > Subtopic" path, or
// `null` if the string doesn't describe a resolvable path at all
// (the delete-outright sentinel).
const parseLocationPath = (raw) => {
  if (!raw) return null;
  if (raw.startsWith('(deleted')) return null;
  const cleaned = raw.replace(/\s*\(moved\)\s*$/, '');
  if (cleaned.includes('[')) return null; // old_location merge list, not a path
  return cleaned.split(' > ').map((part) => part.trim());
};

const run = async () => {
  let connected = false;
  let mismatchCount = 0;

  try {
    await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });
    connected = true;

    const rows = await ActivityLog.find({ action: { $in: TAXONOMY_ACTIONS }, success: true })
      .sort({ timestamp: 1 })
      .lean();

    console.log('── Taxonomy ActivityLog cross-check (Prompt 15) ────────────────');
    console.log(`${rows.length} taxonomy_* row(s) with success: true found.\n`);

    const tableRows = [];

    for (const row of rows) {
      const isOutrightDelete = row.action === 'taxonomy_node_deleted' && row.new_location?.startsWith('(deleted');

      if (isOutrightDelete) {
        const oldPath = parseLocationPath(row.old_location);
        const remaining = oldPath ? await independentMcqCount(...oldPath) : null;
        const clean = remaining === 0;
        if (!clean) mismatchCount += 1;
        tableRows.push({
          timestamp: row.timestamp.toISOString(),
          action: row.action,
          old_location: row.old_location,
          new_location: row.new_location,
          logged_mcqs_updated: row.mcqs_updated,
          persisted_node_total: 'n/a (node deleted)',
          independent_recount: remaining === null ? 'unresolvable' : `${remaining} still at old path`,
          match: clean ? '✅' : '❌',
        });
        continue;
      }

      const newPath = parseLocationPath(row.new_location);
      if (!newPath) {
        tableRows.push({
          timestamp: row.timestamp.toISOString(),
          action: row.action,
          old_location: row.old_location,
          new_location: row.new_location,
          logged_mcqs_updated: row.mcqs_updated,
          persisted_node_total: 'unresolvable',
          independent_recount: 'unresolvable',
          match: '⚠️ skipped',
        });
        continue;
      }

      const node = await resolveNodeByPath(...newPath);
      const independentCount = await independentMcqCount(...newPath);
      const persistedTotal = node ? node.counts?.total ?? 0 : null;

      // Single-target actions: mcqs_updated should equal BOTH the
      // persisted total and the independent recount. Cumulative
      // actions (merge, delete-with-move): only persisted-vs-
      // independent has to agree — see this file's header comment.
      const isSingleTarget = [
        'taxonomy_node_renamed',
        'taxonomy_topic_moved',
        'taxonomy_subtopic_moved',
        'taxonomy_subject_merged_into_subject',
      ].includes(row.action);

      const persistedVsIndependentMatch = persistedTotal !== null && persistedTotal === independentCount;
      const loggedVsPersistedMatch = isSingleTarget
        ? persistedTotal !== null && row.mcqs_updated === persistedTotal
        : true; // not expected to match for merge/delete-move — see header

      const clean = node !== null && persistedVsIndependentMatch && loggedVsPersistedMatch;
      if (node !== null && !clean) mismatchCount += 1;

      tableRows.push({
        timestamp: row.timestamp.toISOString(),
        action: row.action,
        old_location: row.old_location,
        new_location: row.new_location,
        logged_mcqs_updated: row.mcqs_updated,
        persisted_node_total: node ? persistedTotal : 'stale (path no longer resolves)',
        independent_recount: independentCount,
        match: node === null ? '⚠️ stale' : clean ? '✅' : '❌',
      });
    }

    // Markdown table, printed to stdout — copy straight into a report.
    console.log(
      '| # | Action | Old Location | New Location | Logged mcqs_updated | Persisted counts.total | Independent Recount | Match |'
    );
    console.log('|---|---|---|---|---|---|---|---|');
    tableRows.forEach((r, i) => {
      console.log(
        `| ${i + 1} | ${r.action} | ${r.old_location} | ${r.new_location} | ${r.logged_mcqs_updated} | ` +
          `${r.persisted_node_total} | ${r.independent_recount} | ${r.match} |`
      );
    });

    console.log('');
    if (mismatchCount === 0) {
      console.log('✅ Zero mismatches across every checkable taxonomy_* ActivityLog row.');
      process.exitCode = 0;
    } else {
      console.log(`⚠️  ${mismatchCount} mismatch(es) found — see ❌ rows above.`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('❌ verifyTaxonomyAuditLog script failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
    process.exit(process.exitCode ?? 1);
  }
};

run();
