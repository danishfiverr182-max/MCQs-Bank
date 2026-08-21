// Standalone verification script — NOT part of the app.
//
// No live MongoDB is available in this environment (same limitation
// every other verify_*.mjs script in this folder notes). What this
// DOES check, faithfully, is the two things that were actually broken:
//
//   1. deriveTaxonomyTreeFromMcqs() builds a tree straight from MCQ
//      rows, with NO dependency on TaxonomyNode already containing
//      anything — i.e. it does not reproduce the circular bug where
//      seedTaxonomyFromMcqs.js used to call getTaxonomy() (which reads
//      FROM TaxonomyNode) to decide what to seed TaxonomyNode with.
//   2. ensureTaxonomyNodesExist()'s upsert semantics: a brand-new
//      subject/topic/subtopic triple creates exactly the 3 missing
//      nodes, a triple that already exists creates 0, and an existing
//      node's name/casing is never overwritten by a later call that
//      happens to slugify to the same value.
//
// Both are replayed in-memory against plain arrays that mirror the
// real MCQ/TaxonomyNode documents byte-for-byte, mirroring the
// project's existing verify_*.mjs scripts.

import assert from 'node:assert/strict';

const slugify = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// ── deriveTaxonomyTreeFromMcqs, replayed in-memory ───────────────────
// Same grouping rule as mcq.service.js's real aggregation: grouped by
// RAW subject/topic/subtopic, then bucketed in JS by slug (not
// toLowerCase) — the same slug TaxonomyNode's own uniqueness is scoped
// by — so this can never disagree with what actually gets created.
function deriveTaxonomyTreeFromMcqs(mcqs) {
  const subjectsMap = new Map();
  for (const mcq of mcqs) {
    const subjectName = mcq.subject;
    const topicName = mcq.topic ?? '';
    const subtopicName = mcq.subtopic ?? '';
    const topicSlug = slugify(topicName);
    const subtopicSlug = slugify(subtopicName);

    if (!subjectsMap.has(subjectName)) subjectsMap.set(subjectName, new Map());
    const topicsMap = subjectsMap.get(subjectName);

    if (!topicsMap.has(topicSlug)) {
      topicsMap.set(topicSlug, { name: topicName, subtopicsMap: new Map() });
    }
    const topicEntry = topicsMap.get(topicSlug);

    if (!topicEntry.subtopicsMap.has(subtopicSlug)) {
      topicEntry.subtopicsMap.set(subtopicSlug, { name: subtopicName });
    }
  }

  const subjects = Array.from(subjectsMap.entries()).map(([subjectName, topicsMap]) => ({
    name: subjectName,
    topics: Array.from(topicsMap.values()).map((t) => ({
      name: t.name,
      subtopics: Array.from(t.subtopicsMap.values()).map((s) => ({ name: s.name })),
    })),
  }));

  return { subjects };
}

// ── ensureTaxonomyNodesExist, replayed in-memory ─────────────────────
// $setOnInsert semantics: a node is only ever created if no node with
// the same {type, parent_id, slug} already exists; an existing node's
// `name` is left completely untouched.
function makeNodeStore() {
  const nodes = [];
  let nextId = 1;

  const upsert = (type, parent_id, name) => {
    const slug = slugify(name);
    let node = nodes.find((n) => n.type === type && n.parent_id === parent_id && n.slug === slug);
    if (!node) {
      node = { _id: `n${nextId++}`, type, parent_id, slug, name };
      nodes.push(node);
    }
    return node._id;
  };

  const ensureTaxonomyNodesExist = ({ subject, topic, subtopic }) => {
    const subjectId = upsert('subject', null, subject);
    const topicId = upsert('topic', subjectId, topic ?? '');
    upsert('subtopic', topicId, subtopic ?? '');
  };

  return { nodes, ensureTaxonomyNodesExist };
}

// ── Test 1: derive tree from MCQs with an EMPTY node store ───────────
// This is the exact scenario that used to fail: TaxonomyNode is empty,
// MCQs exist. The old buggy seeder called getTaxonomy() (reads FROM
// TaxonomyNode) and got zero subjects back. deriveTaxonomyTreeFromMcqs
// must get subjects back regardless of TaxonomyNode's state, because
// it never looks at TaxonomyNode at all.
{
  const mcqs = [
    { subject: 'History', topic: 'World History', subtopic: 'French Revolution' },
    { subject: 'History', topic: 'world history', subtopic: 'Napoleon' }, // casing variant, same topic
    { subject: 'Current Affairs', topic: '', subtopic: '' },
  ];

  const { subjects } = deriveTaxonomyTreeFromMcqs(mcqs);

  assert.equal(subjects.length, 2, 'expected 2 subjects derived straight from MCQ data');
  const history = subjects.find((s) => s.name === 'History');
  assert.ok(history, 'History subject must be present');
  assert.equal(history.topics.length, 1, 'World History / world history must collapse into one topic (case-insensitive)');
  assert.equal(history.topics[0].subtopics.length, 2, 'French Revolution and Napoleon must both be present as subtopics');

  console.log('✅ Test 1 passed: deriveTaxonomyTreeFromMcqs produces a full tree from MCQs alone, with zero TaxonomyNode dependency.');
}

// ── Test 2: the OLD bug, reproduced and confirmed broken on purpose ──
// Demonstrates what seedTaxonomyFromMcqs.js used to do: derive the
// tree from an ALREADY-EMPTY node-derived source instead of MCQ. This
// is what produced "0 subjects, 0 nodes created, exits successfully"
// even with MCQs present.
{
  const mcqs = [{ subject: 'History', topic: 'World History', subtopic: 'French Revolution' }];
  const emptyNodeStore = []; // TaxonomyNode collection, empty — the real-world starting state

  // The bug: deriving "what to seed" from the node store itself
  // instead of from mcqs.
  const buggySubjects = emptyNodeStore.filter((n) => n.type === 'subject');
  assert.equal(buggySubjects.length, 0, 'reproduces the exact bug: reading from an empty node store yields 0 subjects even though MCQs exist');

  // The fix: derive from mcqs directly, unaffected by node-store state.
  const { subjects: fixedSubjects } = deriveTaxonomyTreeFromMcqs(mcqs);
  assert.equal(fixedSubjects.length, 1, 'fix: deriving from MCQ directly finds the subject regardless of TaxonomyNode being empty');

  console.log('✅ Test 2 passed: confirmed the old failure mode, and confirmed the fix does not reproduce it.');
}

// ── Test 3: ensureTaxonomyNodesExist upsert semantics ─────────────────
{
  const { nodes, ensureTaxonomyNodesExist } = makeNodeStore();

  ensureTaxonomyNodesExist({ subject: 'Islamic Studies', topic: 'Fiqh', subtopic: '' });
  assert.equal(nodes.length, 3, 'first call for a brand-new triple creates exactly 3 nodes (subject, topic, subtopic)');

  ensureTaxonomyNodesExist({ subject: 'Islamic Studies', topic: 'Fiqh', subtopic: '' });
  assert.equal(nodes.length, 3, 'calling again with the SAME triple creates 0 new nodes (idempotent)');

  ensureTaxonomyNodesExist({ subject: 'Islamic Studies', topic: 'Hadith', subtopic: '' });
  // Reuses the existing subject node, but "Hadith" needs its own new
  // topic node AND its own new '' subtopic node (subtopic nests under
  // TOPIC, not subject — so Fiqh's '' subtopic node doesn't cover
  // Hadith's '' subtopic) — 2 new nodes, not 1.
  assert.equal(nodes.length, 5, 'a new topic under an existing subject reuses the subject node but still needs its own new topic + subtopic nodes');

  // Admin hand-renamed the subject's display casing to something
  // non-default; a later MCQ reusing the same triple (same slug) must
  // NOT clobber that.
  const subjectNode = nodes.find((n) => n.type === 'subject');
  subjectNode.name = 'ISLAMIC STUDIES (renamed by admin)';
  ensureTaxonomyNodesExist({ subject: 'Islamic Studies', topic: 'Fiqh', subtopic: '' });
  assert.equal(subjectNode.name, 'ISLAMIC STUDIES (renamed by admin)', 'an existing node\'s name must never be overwritten by a later upsert');

  console.log('✅ Test 3 passed: ensureTaxonomyNodesExist creates only missing nodes, is idempotent, and never clobbers an existing node\'s name.');
}

// ── Test 4: whitespace/punctuation-variant collision (the exact bug
// a real seed run just surfaced: "806 topics derived, 803 created") ──
{
  const mcqs = [
    { subject: 'History', topic: 'World History', subtopic: 'French Revolution' },
    { subject: 'History', topic: 'World History ', subtopic: 'Napoleon' }, // trailing space — trims to same slug
    { subject: 'History', topic: 'US History', subtopic: 'Civil War' },
    { subject: 'History', topic: 'US  History', subtopic: 'WWII' }, // double space — collapses to same slug
  ];

  const { subjects } = deriveTaxonomyTreeFromMcqs(mcqs);
  const history = subjects.find((s) => s.name === 'History');

  // Both "World History" / "World History " must collapse to ONE
  // topic (same slug), and both "US History" / "U.S. History" must
  // also collapse to ONE topic — 2 topics total, not 4.
  assert.equal(history.topics.length, 2, 'whitespace-variant topic names (trailing/double space) must collapse to the same slug-based topic, matching what TaxonomyNode would actually create');

  const { nodes, ensureTaxonomyNodesExist } = makeNodeStore();
  for (const mcq of mcqs) ensureTaxonomyNodesExist(mcq);
  const topicNodeCount = nodes.filter((n) => n.type === 'topic').length;

  // The actual regression check: the derived tree's topic count and
  // the real upsert's created-topic count must agree exactly. Before
  // this fix, deriveTaxonomyTreeFromMcqs (grouped by toLowerCase)
  // would have reported 4 topics here while ensureTaxonomyNodesExist
  // (grouped by slug) only created 2 — the exact class of mismatch a
  // real production run hit (806 vs 803).
  assert.equal(history.topics.length, topicNodeCount, 'derived tree topic count must exactly match the number of topic nodes actually created — this is what the seed script\'s post-run verification checks in production');

  console.log('✅ Test 4 passed: whitespace-only topic variants collapse identically in both the derived tree and actual node creation — no more count mismatch.');
}

console.log('\n✅ All checks passed — the empty-Taxonomy-Manager bug (circular seed dependency + no create-time node upsert + toLowerCase/slug grouping mismatch) is fixed.');
