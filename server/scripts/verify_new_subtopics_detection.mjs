// Standalone verification script — NOT part of the app, mirrors the
// existing verify_*.mjs scripts in this folder (no live MongoDB
// available in this environment).
//
// Checks the core logic added for the Import page's "New Subtopics
// From This Import" feature:
//
//   1. ensureTaxonomyNodesExist()'s new `subtopicCreated` flag is true
//      only on the call that actually inserts the subtopic node —
//      re-running the exact same triple reports `false`.
//   2. ensureTaxonomyForInsertedDocs() (replayed here) collects only
//      the subtopic NAMES flagged as newly created, deduped, and
//      never reports an already-existing subtopic even if it's reused
//      by many docs in the same batch.
//   3. The blank '' subtopic ("(none)" bucket) is never reported.
//   4. Minor formatting differences (case/whitespace/punctuation) that
//      slugify() already normalizes do NOT produce a false "new"
//      report on a second import — the exact scenario section 2/9 of
//      the spec describes.
//   5. The repeated-import workflow from the spec (section 14):
//      import #1 -> #2 -> #3 -> #4 each report only their own delta,
//      never the cumulative total.
//   6. REGRESSION (found against real data on 2026-08-08): the SAME
//      subtopic text reused under a DIFFERENT Topic must NOT resurface
//      as "new" a second time. TaxonomyNode's {type, parent_id, slug}
//      unique index scopes Subtopic identity under its parent Topic
//      (by design — see TaxonomyNode.js — the tree/rename/move/merge
//      machinery in taxonomy.service.js depends on this), so DB-level
//      node creation legitimately happens again there. But the "New
//      Subtopics" copy-paste feature is a flat, topic-independent
//      vocabulary from the admin's point of view, so it must filter
//      those out globally by name/slug.

import assert from 'node:assert/strict';

const slugify = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

// ── ensureTaxonomyNodesExist, replayed in-memory ─────────────────────
// Mirrors mcq.service.js's real includeResultMetadata-based upsert:
// `created` is true only the first time a given {type, parent_id,
// slug} is seen.
function makeNodeStore() {
  const nodes = [];
  let nextId = 1;

  const upsert = (type, parent_id, name) => {
    const slug = slugify(name);
    let node = nodes.find((n) => n.type === type && n.parent_id === parent_id && n.slug === slug);
    let created = false;
    if (!node) {
      node = { _id: `n${nextId++}`, type, parent_id, slug, name };
      nodes.push(node);
      created = true;
    }
    return { id: node._id, created };
  };

  const ensureTaxonomyNodesExist = ({ subject, topic, subtopic }) => {
    const subjectRes = upsert('subject', null, subject);
    const topicRes = upsert('topic', subjectRes.id, topic ?? '');
    const subtopicRes = upsert('subtopic', topicRes.id, subtopic ?? '');
    return {
      subjectId: subjectRes.id,
      topicId: topicRes.id,
      subtopicId: subtopicRes.id,
      subtopicCreated: subtopicRes.created,
    };
  };

  // Mirrors import.service.js's layer-2 lookup: any OTHER subtopic
  // node (any Topic) already using one of these slugs.
  const findPriorSubtopicSlugs = (slugs, excludeIds) =>
    new Set(
      nodes
        .filter((n) => n.type === 'subtopic' && slugs.includes(n.slug) && !excludeIds.includes(n._id))
        .map((n) => n.slug)
    );

  return { nodes, ensureTaxonomyNodesExist, findPriorSubtopicSlugs };
}

// ── ensureTaxonomyForInsertedDocs, replayed in-memory ────────────────
// Same two-layer dedup as the real import.service.js version: layer 1
// dedups by distinct (subject, topic, subtopic) triple within the
// batch and asks the store whether it just created a new node; layer 2
// then drops any candidate whose slug already existed on some OTHER
// (any-Topic) subtopic node before this call.
function ensureTaxonomyForInsertedDocs(store, docs) {
  const seen = new Set();
  const createdCandidates = [];

  for (const doc of docs) {
    const key = `${doc.subject}\u0000${doc.topic ?? ''}\u0000${doc.subtopic ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const result = store.ensureTaxonomyNodesExist(doc);
    const subtopicName = (doc.subtopic ?? '').trim();
    if (result.subtopicCreated && subtopicName) {
      createdCandidates.push({ name: subtopicName, id: result.subtopicId });
    }
  }

  if (createdCandidates.length === 0) return [];

  const candidateSlugs = [...new Set(createdCandidates.map((c) => slugify(c.name)))];
  const createdIds = createdCandidates.map((c) => c.id);
  const priorSlugs = store.findPriorSubtopicSlugs(candidateSlugs, createdIds);

  const newSubtopics = new Set();
  for (const c of createdCandidates) {
    if (!priorSlugs.has(slugify(c.name))) {
      newSubtopics.add(c.name);
    }
  }
  return Array.from(newSubtopics);
}

// ── Test 1: first import into an empty store ─────────────────────────
{
  const store = makeNodeStore();
  const docs = [
    { subject: 'Pakistan Affairs', topic: 'Foreign Policy', subtopic: 'Pakistan Foreign Policy' },
    { subject: 'Pakistan Affairs', topic: 'Foreign Policy', subtopic: 'Pakistan Foreign Policy' }, // same MCQ subtopic reused
    { subject: 'Pakistan Affairs', topic: 'Foreign Policy', subtopic: 'Space Exploration' },
    { subject: 'Current Affairs', topic: 'World', subtopic: '' }, // blank subtopic must never be reported
  ];

  const newSubtopics = ensureTaxonomyForInsertedDocs(store, docs);
  assert.deepEqual(
    newSubtopics.sort(),
    ['Pakistan Foreign Policy', 'Space Exploration'].sort(),
    'first import should report exactly the 2 distinct new subtopics, deduped, blank excluded'
  );
  console.log('✅ Test 1 passed: first import reports only the genuinely new, deduped subtopics.');

  // ── Test 2: minor formatting differences must NOT look "new" ───────
  // Re-importing near-duplicate spellings of an already-known subtopic
  // (the exact fragmentation example from spec section 2/9) must
  // resolve to the SAME slug and therefore report zero new subtopics.
  const variants = [
    { subject: 'Pakistan Affairs', topic: 'Foreign Policy', subtopic: 'pakistan foreign policy' },
    { subject: 'Pakistan Affairs', topic: 'Foreign Policy', subtopic: 'Pakistan Foreign Policy ' },
    { subject: 'Pakistan Affairs', topic: 'Foreign Policy', subtopic: 'PAKISTAN FOREIGN POLICY' },
  ];
  const shouldBeEmpty = ensureTaxonomyForInsertedDocs(store, variants);
  assert.deepEqual(shouldBeEmpty, [], 'formatting variants of an existing subtopic must not be reported as new');
  console.log('✅ Test 2 passed: case/whitespace variants of an existing subtopic are never reported as new.');
}

// ── Test 3: repeated-import workflow (spec section 14) ────────────────
{
  const store = makeNodeStore();

  const import1 = Array.from({ length: 100 }, (_, i) => ({
    subject: 'General Science',
    topic: 'Physics',
    subtopic: `Topic ${i}`,
  }));
  const result1 = ensureTaxonomyForInsertedDocs(store, import1);
  assert.equal(result1.length, 100, 'import #1: before 0 -> after 100 -> 100 new');

  // import #2: 86 reuse existing subtopics, 14 are genuinely new
  const import2 = [
    ...Array.from({ length: 86 }, (_, i) => ({
      subject: 'General Science',
      topic: 'Physics',
      subtopic: `Topic ${i}`, // reuses import #1's subtopics
    })),
    ...Array.from({ length: 14 }, (_, i) => ({
      subject: 'General Science',
      topic: 'Physics',
      subtopic: `New Topic ${i}`,
    })),
  ];
  const result2 = ensureTaxonomyForInsertedDocs(store, import2);
  assert.equal(result2.length, 14, 'import #2: before 100 -> after 114 -> only 14 new, not 114 and not 100');

  // import #3: everything reuses existing subtopics -> zero new
  const import3 = Array.from({ length: 7 }, (_, i) => ({
    subject: 'General Science',
    topic: 'Physics',
    subtopic: `Topic ${i}`,
  }));
  const result3 = ensureTaxonomyForInsertedDocs(store, import3);
  assert.equal(result3.length, 0, 'import #3: all-existing-subtopic import must report zero new');

  console.log('✅ Test 3 passed: each import in the repeated workflow reports only its own delta.');
}

console.log('\nAll new-subtopic-detection checks passed.');

// ── Test 4: cross-topic reuse (the exact real-world regression) ──────
// Replays the user's actual scenario: import #1 tags "Earth Dimensions
// & Physical Features" under Topic "Physical Features"; import #2
// reuses the identical subtopic TEXT under a DIFFERENT Topic ("Oceans")
// plus introduces one genuinely brand-new subtopic. The DB-level node
// still gets created under "Oceans" (unchanged, tree stays intact for
// taxonomy.service.js's tooling) — but the "New Subtopics" panel must
// only report the ONE genuinely-new name, not the reused one.
{
  const store = makeNodeStore();

  const import1 = [
    {
      subject: 'Geography',
      topic: 'Physical Features',
      subtopic: 'Earth Dimensions & Physical Features',
    },
    { subject: 'Geography', topic: 'Oceans', subtopic: 'Oceans, Seas & Gulfs' },
  ];
  const result1 = ensureTaxonomyForInsertedDocs(store, import1);
  assert.deepEqual(
    result1.sort(),
    ['Earth Dimensions & Physical Features', 'Oceans, Seas & Gulfs'].sort(),
    'import #1: both subtopics are genuinely new'
  );

  const import2 = [
    // Same TEXT as import #1, but under a DIFFERENT Topic — DB creates
    // a second node (Subtopic is scoped per-Topic by design), but this
    // must NOT show up as "new" in the panel again.
    { subject: 'Geography', topic: 'Oceans', subtopic: 'Earth Dimensions & Physical Features' },
    // Genuinely new subtopic this time.
    { subject: 'Geography', topic: 'Physical Features', subtopic: 'Geographical Concepts & History' },
  ];
  const result2 = ensureTaxonomyForInsertedDocs(store, import2);
  assert.deepEqual(
    result2,
    ['Geographical Concepts & History'],
    'import #2: reused subtopic text under a new Topic must be filtered out; only the genuinely new one is reported'
  );

  // Confirm the DB-level tree itself is untouched by this filter — the
  // reused subtopic really did get its own node under "Oceans", exactly
  // as taxonomy.service.js's tree/merge/move tooling expects.
  const subtopicNodes = store.nodes.filter((n) => n.type === 'subtopic' && n.slug === 'earth-dimensions-physical-features');
  assert.equal(
    subtopicNodes.length,
    2,
    'the underlying TaxonomyNode tree still gets a node per Topic — only the panel´s reporting changed'
  );

  console.log('✅ Test 4 passed: cross-topic reuse of the same subtopic text is filtered from "New Subtopics", DB tree unaffected.');
}

console.log('\nAll checks passed (including the cross-topic regression fix).');
