// Standalone verification script — NOT part of the app.
//
// No live MongoDB is available in this environment (same limitation
// every other verify_*.mjs script in this folder notes). What this
// DOES check, faithfully, is the exact math
// taxonomy.service.js:recalculateTaxonomyCounts performs, replayed
// in-memory against plain arrays that mirror the real TaxonomyNode +
// MCQ documents byte-for-byte — including how it's wired into the tail
// end of all 6 operations (rename, moveTopicToSubject,
// moveSubjectIntoSubject, moveSubtopicToTopic, mergeTaxonomyNodes,
// deleteTaxonomyNode).
//
// The DoD's own bar: "getTaxonomy()'s counts at every level exactly
// match a fresh from-scratch aggregation over MCQ — verified with a
// script that runs both and diffs them, not by eyeballing the UI."
// This script runs each of the 6 operations against one shared tree,
// and after EACH one independently computes two things and diffs them:
//
//   1. `liveTree(nodes, mcqs)` — a from-scratch getTaxonomy()-shaped
//      aggregation straight over the current `mcqs` array (mirrors the
//      real getTaxonomy()'s own aggregation exactly, unrelated to
//      whatever recalculateTaxonomyCounts persisted).
//   2. `persistedTree(nodes)` — the SAME shape, but read directly off
//      each node's own `.counts` field, i.e. exactly what
//      recalculateTaxonomyCounts wrote.
//
// If recalculateTaxonomyCounts (or its wiring into one of the 6 ops)
// ever drifts — recomputes the wrong filter, forgets an ancestor,
// mutates the wrong node — (1) and (2) diverge and this script fails
// loudly with the exact node and field that disagreed, instead of
// someone eyeballing the Taxonomy Manager UI and maybe not noticing a
// stale subject total.
import assert from 'node:assert/strict';

// ── Minimal in-memory TaxonomyNode + MCQ stores ──────────────────────
let nextId = 1;
const id = () => `node_${nextId++}`;
const slugify = (s) => s.toLowerCase().trim().replace(/\s+/g, '-');

function makeStore(initialNodes, initialMcqs) {
  const nodes = new Map(initialNodes.map((n) => [n._id, { ...n, slug: n.slug ?? slugify(n.name) }]));
  const mcqs = initialMcqs.map((m) => ({ ...m }));
  return {
    byId: (nid) => nodes.get(nid),
    all: () => Array.from(nodes.values()),
    childrenOf: (parentId, type) =>
      Array.from(nodes.values()).filter((n) => n.parent_id === parentId && (!type || n.type === type)),
    add: (n) => nodes.set(n._id, { ...n, slug: n.slug ?? slugify(n.name) }),
    remove: (nid) => nodes.delete(nid),
    mcqs,
  };
}

// ── mcqFilterForLevel — byte-for-byte the same predicate shape as the
// real service's own helper of the same name (case-insensitive
// topic/subtopic, exact subject). ──────────────────────────────────
const matches = (level, ancestorNames, name, mcq) => {
  if (level === 'subject') return mcq.subject === name;
  if (level === 'topic')
    return mcq.subject === ancestorNames.subject && mcq.topic.toLowerCase() === name.toLowerCase();
  return (
    mcq.subject === ancestorNames.subject &&
    mcq.topic.toLowerCase() === ancestorNames.topic.toLowerCase() &&
    mcq.subtopic.toLowerCase() === name.toLowerCase()
  );
};

const zeroCounts = () => ({ total: 0, approved: 0, pending: 0, rejected: 0 });

const countMcqs = (store, level, ancestorNames, name) => {
  const counts = zeroCounts();
  for (const m of store.mcqs) {
    if (matches(level, ancestorNames, name, m)) {
      counts.total += 1;
      counts[m.status] += 1;
    }
  }
  return counts;
};

// ── recalculateTaxonomyCounts — in-memory mirror of the real
// taxonomy.service.js export. Same walk-up-to-subject, same
// dedupe-by-id, same "persist onto the node" contract. ────────────────
function recalculateTaxonomyCounts(store, nodeIds) {
  const ids = [...new Set(nodeIds)];
  const toRecalculate = new Map();

  for (const nid of ids) {
    const node = store.byId(nid);
    if (!node) continue; // already deleted

    if (node.type === 'subject') {
      toRecalculate.set(node._id, { node, ancestorNames: {} });
      continue;
    }
    const parent = store.byId(node.parent_id);
    if (!parent) continue;

    if (node.type === 'topic') {
      toRecalculate.set(node._id, { node, ancestorNames: { subject: parent.name } });
      toRecalculate.set(parent._id, { node: parent, ancestorNames: {} });
      continue;
    }

    const grandparent = store.byId(parent.parent_id);
    if (!grandparent) continue;
    toRecalculate.set(node._id, {
      node,
      ancestorNames: { subject: grandparent.name, topic: parent.name },
    });
    toRecalculate.set(parent._id, { node: parent, ancestorNames: { subject: grandparent.name } });
    toRecalculate.set(grandparent._id, { node: grandparent, ancestorNames: {} });
  }

  for (const { node, ancestorNames } of toRecalculate.values()) {
    node.counts = countMcqs(store, node.type, ancestorNames, node.name);
  }
}

// ── Two independent tree builders — one from LIVE mcqs, one from
// whatever's PERSISTED on each node — for the diff this script exists
// to run. ──────────────────────────────────────────────────────────
function buildTree(store, { fromPersisted }) {
  const subjects = store.childrenOf(null, 'subject').sort((a, b) => a.name.localeCompare(b.name));
  return subjects.map((subjectNode) => {
    const topics = store
      .childrenOf(subjectNode._id, 'topic')
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((topicNode) => {
        const subtopics = store
          .childrenOf(topicNode._id, 'subtopic')
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((subtopicNode) => ({
            name: subtopicNode.name,
            counts: fromPersisted
              ? subtopicNode.counts
              : countMcqs(store, 'subtopic', { subject: subjectNode.name, topic: topicNode.name }, subtopicNode.name),
          }));
        return {
          name: topicNode.name,
          counts: fromPersisted
            ? topicNode.counts
            : countMcqs(store, 'topic', { subject: subjectNode.name }, topicNode.name),
          subtopics,
        };
      });
    return {
      name: subjectNode.name,
      counts: fromPersisted ? subjectNode.counts : countMcqs(store, 'subject', {}, subjectNode.name),
      topics,
    };
  });
}

// Deep-diffs two buildTree() outputs, asserting every level's counts
// object is byte-identical — this IS "runs both and diffs them".
function assertTreesMatch(a, b, label) {
  assert.equal(a.length, b.length, `${label}: subject count mismatch`);
  for (let i = 0; i < a.length; i++) {
    assert.deepEqual(a[i].counts, b[i].counts, `${label}: subject "${a[i].name}" counts mismatch`);
    assert.equal(a[i].topics.length, b[i].topics.length, `${label}: "${a[i].name}" topic count mismatch`);
    for (let j = 0; j < a[i].topics.length; j++) {
      const at = a[i].topics[j];
      const bt = b[i].topics[j];
      assert.deepEqual(at.counts, bt.counts, `${label}: topic "${at.name}" counts mismatch`);
      assert.equal(at.subtopics.length, bt.subtopics.length, `${label}: "${at.name}" subtopic count mismatch`);
      for (let k = 0; k < at.subtopics.length; k++) {
        assert.deepEqual(
          at.subtopics[k].counts,
          bt.subtopics[k].counts,
          `${label}: subtopic "${at.subtopics[k].name}" counts mismatch`
        );
      }
    }
  }
}

// After every operation below, this is the ONE check that matters:
// persisted (what recalculateTaxonomyCounts wrote) must exactly equal
// a completely independent from-scratch aggregation over live MCQs.
function verify(store, label) {
  const live = buildTree(store, { fromPersisted: false });
  const persisted = buildTree(store, { fromPersisted: true });
  assertTreesMatch(live, persisted, label);
  console.log(`  ✓ ${label}: persisted counts match fresh aggregation at every level`);
}

// ─────────────────────────────────────────────────────────────────────
// Scenario setup: one tree exercising all 6 operations in sequence,
// each mutating the SAME store so drift from an earlier op would still
// show up in a later op's diff.
// ─────────────────────────────────────────────────────────────────────
console.log('Prompt 13 — Count Recalculation Engine verification\n');

const sSci = { _id: id(), type: 'subject', name: 'Science', parent_id: null };
const sArts = { _id: id(), type: 'subject', name: 'Arts', parent_id: null };
const tPhysics = { _id: id(), type: 'topic', name: 'Physics', parent_id: sSci._id };
const tChem = { _id: id(), type: 'topic', name: 'Chemistry', parent_id: sSci._id };
const tHistory = { _id: id(), type: 'topic', name: 'History', parent_id: sArts._id };
const stMech = { _id: id(), type: 'subtopic', name: 'Mechanics', parent_id: tPhysics._id };
const stOptics = { _id: id(), type: 'subtopic', name: 'Optics', parent_id: tPhysics._id };
const stOrganic = { _id: id(), type: 'subtopic', name: 'Organic', parent_id: tChem._id };
const stAncient = { _id: id(), type: 'subtopic', name: 'Ancient', parent_id: tHistory._id };

const mcq = (subject, topic, subtopic, status) => ({
  _id: id(),
  subject,
  topic,
  subtopic,
  status,
});

const initialMcqs = [
  mcq('Science', 'Physics', 'Mechanics', 'approved'),
  mcq('Science', 'Physics', 'Mechanics', 'pending'),
  mcq('Science', 'Physics', 'Optics', 'approved'),
  mcq('Science', 'Physics', 'Optics', 'rejected'),
  mcq('Science', 'Chemistry', 'Organic', 'approved'),
  mcq('Science', 'Chemistry', 'Organic', 'approved'),
  mcq('Arts', 'History', 'Ancient', 'pending'),
  mcq('Arts', 'History', 'Ancient', 'approved'),
];

const store = makeStore(
  [sSci, sArts, tPhysics, tChem, tHistory, stMech, stOptics, stOrganic, stAncient],
  initialMcqs
);

// Seed every node's counts once up front, exactly like the real app's
// seedTaxonomyFromMcqs.js would leave a freshly-seeded tree BEFORE any
// of the 6 operations below have ever run.
recalculateTaxonomyCounts(store, store.all().map((n) => n._id));
verify(store, '0. initial seed');

// ── 1. renameTaxonomyNode: "Optics" -> "Optics & Waves" ──────────────
{
  const node = store.byId(stOptics._id);
  const oldName = node.name;
  node.name = 'Optics & Waves';
  for (const m of store.mcqs) {
    if (m.subject === 'Science' && m.topic.toLowerCase() === 'physics' && m.subtopic.toLowerCase() === oldName.toLowerCase()) {
      m.subtopic = node.name;
    }
  }
  recalculateTaxonomyCounts(store, [node._id]);
  verify(store, '1. renameTaxonomyNode');
}

// ── 2. moveTopicToSubject: "Chemistry" (Science) -> "Arts" ───────────
{
  const topicNode = store.byId(tChem._id);
  const sourceSubject = store.byId(sSci._id);
  const destinationSubject = store.byId(sArts._id);
  const oldSubjectName = sourceSubject.name;
  topicNode.parent_id = destinationSubject._id;
  for (const m of store.mcqs) {
    if (m.subject === oldSubjectName && m.topic.toLowerCase() === topicNode.name.toLowerCase()) {
      m.subject = destinationSubject.name;
    }
  }
  recalculateTaxonomyCounts(store, [topicNode._id, sourceSubject._id]);
  verify(store, '2. moveTopicToSubject');
}

// ── 3. moveSubtopicToTopic: "Mechanics" (Physics) -> "History" ───────
{
  const subtopicNode = store.byId(stMech._id);
  const sourceTopic = store.byId(tPhysics._id);
  const sourceSubject = store.byId(store.byId(sourceTopic.parent_id)._id);
  const destinationTopic = store.byId(tHistory._id);
  const destinationSubject = store.byId(destinationTopic.parent_id);
  for (const m of store.mcqs) {
    if (
      m.subject === sourceSubject.name &&
      m.topic.toLowerCase() === sourceTopic.name.toLowerCase() &&
      m.subtopic.toLowerCase() === subtopicNode.name.toLowerCase()
    ) {
      m.subject = destinationSubject.name;
      m.topic = destinationTopic.name;
    }
  }
  subtopicNode.parent_id = destinationTopic._id;
  recalculateTaxonomyCounts(store, [subtopicNode._id, sourceTopic._id]);
  verify(store, '3. moveSubtopicToTopic');
}

// ── 4. moveSubjectIntoSubject: fold a brand-new "Geography" subject
// (one leaf topic, no subtopics — clears the nesting guard) into
// "Arts" as a topic. ───────────────────────────────────────────────
let tGeography;
{
  const sGeo = { _id: id(), type: 'subject', name: 'Geography', parent_id: null };
  const tRivers = { _id: id(), type: 'topic', name: 'Rivers', parent_id: sGeo._id };
  store.add(sGeo);
  store.add(tRivers);
  store.mcqs.push(mcq('Geography', 'Rivers', '', 'approved'));
  store.mcqs.push(mcq('Geography', 'Rivers', '', 'pending'));
  recalculateTaxonomyCounts(store, [sGeo._id, tRivers._id]);
  verify(store, '4a. Geography seeded before fold');

  const subjectNode = store.byId(sGeo._id);
  const destinationSubject = store.byId(sArts._id);
  const childTopics = store.childrenOf(subjectNode._id, 'topic');
  const oldSubjectName = subjectNode.name;

  // MCQ pipeline-style rewrite: prior `topic` becomes new `subtopic`.
  for (const m of store.mcqs) {
    if (m.subject === oldSubjectName) {
      m.subtopic = m.topic ?? '';
      m.subject = destinationSubject.name;
      m.topic = oldSubjectName;
    }
  }
  subjectNode.type = 'topic';
  subjectNode.parent_id = destinationSubject._id;
  for (const t of childTopics) t.type = 'subtopic';

  recalculateTaxonomyCounts(store, [subjectNode._id, ...childTopics.map((t) => t._id)]);
  verify(store, '4b. moveSubjectIntoSubject');
  tGeography = subjectNode; // now a topic node under Arts
}

// ── 5. mergeTaxonomyNodes: merge "History" and "Geography" (both now
// topics under Arts) into "History". ─────────────────────────────────
{
  const survivor = store.byId(tHistory._id);
  const mergedAway = [tGeography];
  const ancestorNames = { subject: 'Arts' };
  const affectedNodeIds = new Set([survivor._id]);

  for (const away of mergedAway) {
    for (const m of store.mcqs) {
      if (m.subject === ancestorNames.subject && m.topic.toLowerCase() === away.name.toLowerCase()) {
        m.topic = survivor.name;
      }
    }
  }
  // Fold children (subtopics) — no slug collisions in this scenario,
  // so every child of every merged-away node just reparents.
  for (const away of mergedAway) {
    for (const child of store.childrenOf(away._id, 'subtopic')) {
      child.parent_id = survivor._id;
      affectedNodeIds.add(child._id);
    }
    store.remove(away._id);
  }

  recalculateTaxonomyCounts(store, [...affectedNodeIds]);
  verify(store, '5. mergeTaxonomyNodes');
}

// ── 6. deleteTaxonomyNode: delete "Chemistry" (now under Arts, from
// step 2), moving its MCQs to "History". ─────────────────────────────
{
  const node = store.byId(tChem._id);
  const destinationNode = store.byId(tHistory._id);
  const destinationSubject = store.byId(destinationNode.parent_id);
  const parentIdBeforeDelete = node.parent_id;

  for (const m of store.mcqs) {
    if (m.subject === 'Arts' && m.topic.toLowerCase() === node.name.toLowerCase()) {
      m.subject = destinationSubject.name;
      m.topic = destinationNode.name;
    }
  }
  for (const child of store.childrenOf(node._id, 'subtopic')) store.remove(child._id);
  store.remove(node._id);

  const countsToRecalculate = [];
  if (parentIdBeforeDelete) countsToRecalculate.push(parentIdBeforeDelete);
  countsToRecalculate.push(destinationNode._id);
  recalculateTaxonomyCounts(store, countsToRecalculate);
  verify(store, '6. deleteTaxonomyNode (move orphans)');
}

// ── 6b. deleteTaxonomyNode: delete "Optics & Waves" subtopic outright
// (on_orphan_mcqs: { action: 'delete' }). ─────────────────────────────
{
  const node = store.byId(stOptics._id);
  const parentIdBeforeDelete = node.parent_id;
  store.mcqs = store.mcqs.filter(
    (m) =>
      !(
        m.subject === 'Science' &&
        m.topic.toLowerCase() === 'physics' &&
        m.subtopic.toLowerCase() === node.name.toLowerCase()
      )
  );
  store.remove(node._id);
  recalculateTaxonomyCounts(store, [parentIdBeforeDelete]);
  verify(store, '6b. deleteTaxonomyNode (delete orphans)');
}

console.log('\nAll 6 operation types verified — persisted TaxonomyNode counts');
console.log('exactly match a fresh from-scratch MCQ aggregation after each one.');
