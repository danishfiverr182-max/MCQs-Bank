// Diagnostic ONLY — does not modify any data.
//
// Run with:  cd server && node scripts/audit_subtopic_duplicates.mjs
// (uses your existing server/.env MONGO_URI, same as the app itself)
//
// What it checks:
// Subtopic-matching in ensureTaxonomyNodesExist() is scoped UNDER its
// parent Topic node (Subject -> Topic -> Subtopic hierarchy, per the
// original spec). So if the exact same Subtopic *text* gets imported
// twice but under two different Topic (or Subject) parent nodes —
// e.g. "World Geography" the first time, "Geography" the second —
// each import correctly creates/matches its OWN Subtopic node, and
// the second one legitimately looks "new" to the system even though
// the text is identical.
//
// This script finds any Subtopic name (by slug) that exists more than
// once under DIFFERENT topic parents, and prints the full
// Subject > Topic > Subtopic chain for every occurrence, so you can
// see at a glance whether this is what happened.

import mongoose from 'mongoose';
import env from '../src/config/env.js';
import TaxonomyNode from '../src/models/TaxonomyNode.js';

await mongoose.connect(env.MONGO_URI, { dbName: env.MONGO_DB_NAME });

const subjects = await TaxonomyNode.find({ type: 'subject' }).lean();
const topics = await TaxonomyNode.find({ type: 'topic' }).lean();
const subtopics = await TaxonomyNode.find({ type: 'subtopic' }).lean();

const byId = new Map([...subjects, ...topics, ...subtopics].map((n) => [String(n._id), n]));

const chainFor = (subtopicNode) => {
  const topic = byId.get(String(subtopicNode.parent_id));
  const subject = topic ? byId.get(String(topic.parent_id)) : null;
  return {
    subject: subject?.name ?? '(missing subject)',
    topic: topic?.name ?? '(missing topic)',
    subtopic: subtopicNode.name,
    subtopic_id: String(subtopicNode._id),
    topic_id: String(subtopicNode.parent_id),
  };
};

// Group by (slug) only — this intentionally ignores parent, so we can
// spot the same subtopic text living under more than one topic.
const groups = new Map();
for (const st of subtopics) {
  const key = st.slug;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(st);
}

const collisions = [...groups.entries()].filter(([, nodes]) => {
  const distinctParents = new Set(nodes.map((n) => String(n.parent_id)));
  return distinctParents.size > 1;
});

console.log(`Total Subtopic nodes: ${subtopics.length}`);
console.log(`Subtopic slugs with MORE THAN ONE distinct Topic parent: ${collisions.length}\n`);

if (collisions.length === 0) {
  console.log('No cross-topic duplicates found — the "re-flagged as new" symptom likely has a different cause.');
} else {
  for (const [slug, nodes] of collisions) {
    console.log(`── "${nodes[0].name}"  (slug: ${slug}) — appears under ${nodes.length} different Topic parents:`);
    for (const n of nodes) {
      const chain = chainFor(n);
      console.log(`   Subject: "${chain.subject}"  >  Topic: "${chain.topic}"  >  Subtopic: "${chain.subtopic}"`);
      console.log(`     subtopic_id=${chain.subtopic_id}  topic_id=${chain.topic_id}`);
    }
    console.log('');
  }
}

await mongoose.disconnect();
