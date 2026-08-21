// Standalone script — NOT part of the Express app lifecycle.
// Run with: node scripts/seedTaxonomyFromMcqs.js   (from server/)
//
// ONE-TIME (but always safe to re-run) seeder for the new TaxonomyNode
// management layer (see models/TaxonomyNode.js). Reads every distinct
// (subject, topic, subtopic) combination currently recorded on MCQ —
// via mcq.service.js's deriveTaxonomyTreeFromMcqs(), which aggregates
// MCQ directly with the same case-insensitive topic/subtopic
// casing-collapse every other taxonomy read path uses — and creates
// one TaxonomyNode per subject/topic/subtopic.
//
// IMPORTANT: this MUST call deriveTaxonomyTreeFromMcqs(), never
// getTaxonomy(). getTaxonomy() was rebuilt (Taxonomy P3) to read its
// tree FROM TaxonomyNode — calling it here to decide what to seed
// TaxonomyNode with is circular: on an empty TaxonomyNode collection,
// getTaxonomy() reports zero subjects, this script "successfully"
// creates zero nodes, and TaxonomyNode never gets populated even
// though MCQs exist. (This is exactly the bug that shipped: the
// seeder was written against getTaxonomy() before Prompt 3 rebuilt
// it, and nothing re-ran the seeder afterward to notice the contract
// had changed underneath it.) deriveTaxonomyTreeFromMcqs() has no
// dependency on TaxonomyNode at all, which is what makes it safe to
// use for bootstrapping — or rebuilding — that collection from
// scratch.
//
// PURELY ADDITIVE: this script only ever READS MCQ and WRITES
// TaxonomyNode. It never updates, creates, or deletes an MCQ document.
// MCQ.subject/topic/subtopic strings remain the system's actual source
// of truth for every existing query — TaxonomyNode is a new, separate
// management layer that later prompts build on, not a replacement (yet).
//
// IDEMPOTENT: every write below is an upsert scoped to TaxonomyNode's
// own unique index ({type, parent_id, slug}), using $setOnInsert so a
// node that already exists (same slug under the same parent) is left
// completely untouched on a re-run — including its `name` (display
// casing) and `display_order`. This matters even beyond "don't create
// duplicates": a later prompt is expected to let an admin hand-edit a
// TaxonomyNode's name/order directly, and re-running this seeder must
// never clobber that edit just because the MCQ collection changed or
// getTaxonomy()'s $first-picked display casing happened to differ this
// run.

import mongoose from 'mongoose';
import env from '../src/config/env.js';
import TaxonomyNode from '../src/models/TaxonomyNode.js';
import { deriveTaxonomyTreeFromMcqs } from '../src/services/mcq.service.js';
import { slugify } from '../src/utils/slugify.js';

// ─── upsertNode ────────────────────────────────────────────────────
// $setOnInsert only — see this file's header comment on why a
// pre-existing node must never be overwritten by a re-run. Returns the
// node's _id (either newly created or the one already there) so the
// caller can use it as the next level's parent_id.
const upsertNode = async ({ type, parent_id, name, display_order }) => {
  const slug = slugify(name);
  const node = await TaxonomyNode.findOneAndUpdate(
    { type, parent_id, slug },
    { $setOnInsert: { type, parent_id, slug, name, display_order } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return node._id;
};

const run = async () => {
  let connected = false;

  try {
    console.log('Connecting to MongoDB...');
    // A hang here (no further output for a long time) means the
    // connection itself is the problem — wrong MONGO_URI/MONGO_DB_NAME
    // in this shell's .env, Atlas IP whitelist, or network — not the
    // seeding logic below. serverSelectionTimeoutMS below caps how
    // long Mongoose will silently retry before actually throwing, so
    // this fails loudly within 10s instead of hanging indefinitely.
    await mongoose.connect(env.MONGO_URI, {
      dbName: env.MONGO_DB_NAME,
      serverSelectionTimeoutMS: 10000,
    });
    connected = true;
    console.log(`Connected. Host: ${mongoose.connection.host} | DB: ${mongoose.connection.name}`);

    console.log('Counting existing documents...');
    const mcqCountBefore = await mongoose.connection.db
      .collection('mcqs')
      .countDocuments({});
    const nodeCountBefore = await TaxonomyNode.countDocuments({});
    console.log(`MCQ collection: ${mcqCountBefore} document(s). TaxonomyNode collection: ${nodeCountBefore} document(s) before this run.`);

    console.log('Aggregating distinct subject/topic/subtopic combinations from MCQ (this is a full collection scan — may take a moment on a large collection)...');
    // Derived directly from MCQ — see mcq.service.js's own comment on
    // deriveTaxonomyTreeFromMcqs() for exactly how the grouping/casing
    // works, and why this must not be getTaxonomy().
    const { subjects } = await deriveTaxonomyTreeFromMcqs();
    console.log(`Aggregation done: ${subjects.length} distinct subject(s) found. Upserting TaxonomyNode documents...`);

    let subjectCount = 0;
    let topicCount = 0;
    let subtopicCount = 0;

    for (const [subjectIndex, subject] of subjects.entries()) {
      subjectCount += 1;
      console.log(`  [${subjectCount}/${subjects.length}] ${subject.name} (${subject.topics.length} topic(s))`);
      // eslint-disable-next-line no-await-in-loop
      const subjectId = await upsertNode({
        type: 'subject',
        parent_id: null,
        name: subject.name,
        display_order: subjectIndex,
      });

      for (const [topicIndex, topic] of subject.topics.entries()) {
        topicCount += 1;
        // eslint-disable-next-line no-await-in-loop
        const topicId = await upsertNode({
          type: 'topic',
          parent_id: subjectId,
          name: topic.name,
          display_order: topicIndex,
        });

        for (const [subtopicIndex, subtopic] of topic.subtopics.entries()) {
          subtopicCount += 1;
          // eslint-disable-next-line no-await-in-loop
          await upsertNode({
            type: 'subtopic',
            parent_id: topicId,
            name: subtopic.name,
            display_order: subtopicIndex,
          });
        }
      }
    }

    const mcqCountAfter = await mongoose.connection.db
      .collection('mcqs')
      .countDocuments({});
    const nodeCountAfter = await TaxonomyNode.countDocuments({});
    const [dbSubjectCount, dbTopicCount, dbSubtopicCount] = await Promise.all([
      TaxonomyNode.countDocuments({ type: 'subject' }),
      TaxonomyNode.countDocuments({ type: 'topic' }),
      TaxonomyNode.countDocuments({ type: 'subtopic' }),
    ]);

    console.log('── seedTaxonomyFromMcqs summary ──────────────────────────────');
    console.log(`MCQ collection has     : ${subjectCount} subject(s), ${topicCount} topic(s), ${subtopicCount} subtopic(s)`);
    console.log(`TaxonomyNode now holds : ${dbSubjectCount} subject(s), ${dbTopicCount} topic(s), ${dbSubtopicCount} subtopic(s)`);
    console.log(`TaxonomyNode total     : ${nodeCountBefore} -> ${nodeCountAfter} (${nodeCountAfter - nodeCountBefore} new node(s) this run)`);
    console.log(`MCQ collection count   : ${mcqCountBefore} -> ${mcqCountAfter} (must be identical — this script never touches MCQ)`);

    const countsMatch =
      dbSubjectCount === subjectCount &&
      dbTopicCount === topicCount &&
      dbSubtopicCount === subtopicCount;
    const mcqUntouched = mcqCountBefore === mcqCountAfter;

    if (!countsMatch) {
      console.error('❌ TaxonomyNode counts do not match the MCQ-derived tree — investigate before relying on TaxonomyNode.');
      process.exitCode = 1;
    } else if (!mcqUntouched) {
      // Should be unreachable — this script has no MCQ write path at
      // all — but checked explicitly rather than assumed, since the
      // DoD calls it out as a hard requirement.
      console.error('❌ MCQ collection count changed during this run — this script should never write to MCQ.');
      process.exitCode = 1;
    } else if (subjectCount === 0) {
      // A "successful" run that created zero nodes because MCQ itself
      // is empty looks identical (0 === 0) to the circular-dependency
      // bug this script used to have. Flag it loudly instead of
      // printing a clean checkmark either way, so an empty MCQ
      // collection is never mistaken for "taxonomy is up to date".
      console.warn('⚠️  MCQ collection has zero documents — nothing to seed. If MCQs DO exist, this indicates a bug.');
      process.exitCode = 0;
    } else {
      console.log('✅ TaxonomyNode counts match the MCQ-derived tree exactly, and zero MCQs were touched.');
      process.exitCode = 0;
    }
  } catch (error) {
    console.error('❌ seedTaxonomyFromMcqs failed:', error.message);
    process.exitCode = 1;
  } finally {
    if (connected) {
      await mongoose.disconnect();
    }
    process.exit(process.exitCode ?? 1);
  }
};

run();
