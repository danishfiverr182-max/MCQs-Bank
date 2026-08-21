// Standalone verification script — NOT part of the app.
//
// No live MongoDB is available in this environment (same limitation
// noted in Taxonomy Prompts 3-7's own verify_*.mjs scripts). What this
// DOES check, faithfully, is the exact transformation logic
// mcqService.mergeTaxonomyNodes / mergeGroupIntoSurvivor apply —
// replayed against plain in-memory arrays that mirror the real
// TaxonomyNode + MCQ documents byte-for-byte, including the recursive
// fold and the duplicate-MCQ (question_hash) edge case.
//
// Three scenarios, each straight out of this feature's own DoD:
//
//   1. "Current Affairs" / "current affairs" — a case-only topic
//      duplicate under the same subject. Each already has its own
//      "World Affairs" subtopic (different casing) — this is what
//      exercises the RECURSIVE fold, since after the topic merge those
//      two subtopics would collide under the same parent unless they
//      too get collapsed.
//   2. "Pak Study" / "Pakistan Studies" — a different-name SUBJECT
//      duplicate, no shared parent constraint to check.
//   3. The duplicate-MCQ edge case: two MCQs with the SAME
//      question_hash living under the two merged nodes. The survivor's
//      reported mcq_count must equal (sum of both originals) - (that
//      overlap), not a naive double-count — and the case must be
//      logged, not silently absorbed.
import assert from 'node:assert/strict';

let nextId = 1;
const id = () => `node_${nextId++}`;
const slugify = (s) => s.toLowerCase().trim().replace(/\s+/g, '-');

// ── Minimal in-memory TaxonomyNode + MCQ stores ──────────────────────
function makeStores(initialNodes, initialMcqs) {
  const nodes = new Map(initialNodes.map((n) => [n._id, { ...n, slug: n.slug ?? slugify(n.name) }]));
  const mcqs = initialMcqs.map((m) => ({ ...m }));
  return {
    nodeById: (nid) => nodes.get(nid),
    childrenOf: (parentIds, type) =>
      Array.from(nodes.values()).filter((n) => parentIds.includes(n.parent_id) && n.type === type),
    deleteNodes: (ids) => ids.forEach((nid) => nodes.delete(nid)),
    reparent: (nid, newParentId) => {
      nodes.get(nid).parent_id = newParentId;
    },
    allNodes: () => Array.from(nodes.values()),
    mcqs,
  };
}

const mcqFilterForLevel = (level, ancestorNames, name) => {
  if (level === 'subject') return (m) => m.subject === name;
  if (level === 'topic')
    return (m) => m.subject === ancestorNames.subject && m.topic.toLowerCase() === name.toLowerCase();
  return (m) =>
    m.subject === ancestorNames.subject &&
    m.topic.toLowerCase() === ancestorNames.topic.toLowerCase() &&
    m.subtopic.toLowerCase() === name.toLowerCase();
};
const applyUpdateForLevel = (level, name, mcq) => {
  if (level === 'subject') mcq.subject = name;
  else if (level === 'topic') mcq.topic = name;
  else mcq.subtopic = name;
};

// Mirrors mcqService.mergeGroupIntoSurvivor exactly: retag matching
// MCQs, fold children (collapsing duplicate-slug groups recursively),
// then delete the now-fully-folded merged-away nodes.
function mergeGroupIntoSurvivor(store, { survivor, mergedAway, ancestorNames, stats }) {
  const level = survivor.type;

  for (const away of mergedAway) {
    const matches = store.mcqs.filter(mcqFilterForLevel(level, ancestorNames, away.name));
    for (const mcq of matches) {
      applyUpdateForLevel(level, survivor.name, mcq);
      stats.modified_count += 1;
    }
    stats.matched_count += matches.length;
  }

  const childType = level === 'subject' ? 'topic' : level === 'topic' ? 'subtopic' : null;
  if (childType) {
    const parentIds = [survivor._id, ...mergedAway.map((n) => n._id)];
    const children = store.childrenOf(parentIds, childType);

    const groupsBySlug = new Map();
    for (const child of children) {
      if (!groupsBySlug.has(child.slug)) groupsBySlug.set(child.slug, []);
      groupsBySlug.get(child.slug).push(child);
    }

    for (const group of groupsBySlug.values()) {
      if (group.length === 1) {
        const only = group[0];
        if (only.parent_id !== survivor._id) store.reparent(only._id, survivor._id);
        continue;
      }

      const preferred = group.find((c) => c.parent_id === survivor._id);
      const childSurvivor = preferred ?? group.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
      const childMergedAway = group.filter((c) => c._id !== childSurvivor._id);

      if (childSurvivor.parent_id !== survivor._id) store.reparent(childSurvivor._id, survivor._id);

      stats.duplicate_children_collapsed.push({
        level: childType,
        kept: childSurvivor.name,
        merged_away: childMergedAway.map((c) => c.name),
      });

      const nestedAncestorNames =
        level === 'subject'
          ? { subject: survivor.name }
          : { subject: ancestorNames.subject, topic: survivor.name };

      mergeGroupIntoSurvivor(store, {
        survivor: childSurvivor,
        mergedAway: childMergedAway,
        ancestorNames: nestedAncestorNames,
        stats,
      });
    }
  }

  store.deleteNodes(mergedAway.map((n) => n._id));
}

function mergeTaxonomyNodes(store, { nodeIds, keepName }) {
  const nodes = nodeIds.map((nid) => store.nodeById(nid));
  const type = nodes[0].type;
  const survivor = nodes.find((n) => n.name === keepName);
  const mergedAway = nodes.filter((n) => n._id !== survivor._id);

  let ancestorNames = {};
  if (type === 'topic') {
    ancestorNames = { subject: store.nodeById(survivor.parent_id).name };
  } else if (type === 'subtopic') {
    const topicNode = store.nodeById(survivor.parent_id);
    ancestorNames = { subject: store.nodeById(topicNode.parent_id).name, topic: topicNode.name };
  }

  const stats = { matched_count: 0, modified_count: 0, duplicate_children_collapsed: [] };
  mergeGroupIntoSurvivor(store, { survivor, mergedAway, ancestorNames, stats });

  const finalMatch = mcqFilterForLevel(type, ancestorNames, survivor.name);
  const finalMcqs = store.mcqs.filter(finalMatch);
  const byHash = new Map();
  for (const m of finalMcqs) {
    if (!byHash.has(m.question_hash)) byHash.set(m.question_hash, []);
    byHash.get(m.question_hash).push(m);
  }
  const duplicateGroups = Array.from(byHash.values()).filter((g) => g.length > 1);
  const duplicateMcqCount = duplicateGroups.reduce((sum, g) => sum + (g.length - 1), 0);

  return {
    survivor,
    stats,
    raw_mcq_count: finalMcqs.length,
    duplicate_mcq_count: duplicateMcqCount,
    mcq_count: finalMcqs.length - duplicateMcqCount,
  };
}

// ─────────────────────────────────────────────────────────────────
// Scenario 1 — "Current Affairs" / "current affairs" (case-only topic
// duplicate) under subject "General Knowledge", each with its own
// "World Affairs" / "world affairs" subtopic (recursive fold target),
// plus a duplicate-content MCQ pair across the two topics.
// ─────────────────────────────────────────────────────────────────
{
  const gk = { _id: id(), type: 'subject', name: 'General Knowledge', parent_id: null };
  const topicA = { _id: id(), type: 'topic', name: 'Current Affairs', parent_id: gk._id };
  const topicB = { _id: id(), type: 'topic', name: 'current affairs', parent_id: gk._id };
  const subA = { _id: id(), type: 'subtopic', name: 'World Affairs', parent_id: topicA._id };
  const subB = { _id: id(), type: 'subtopic', name: 'world affairs', parent_id: topicB._id };
  // A subtopic under topicB with NO collision, to prove non-colliding
  // children just get reparented rather than folded.
  const subC = { _id: id(), type: 'subtopic', name: 'Regional Politics', parent_id: topicB._id };

  const store = makeStores([gk, topicA, topicB, subA, subB, subC], [
    { question_id: 'Q1', subject: 'General Knowledge', topic: 'Current Affairs', subtopic: 'World Affairs', question_hash: 'hashX' },
    // Same content (question_hash) as Q1, but filed under the OTHER
    // duplicate topic/subtopic casing — this is the "now-duplicate"
    // edge case.
    { question_id: 'Q2', subject: 'General Knowledge', topic: 'current affairs', subtopic: 'world affairs', question_hash: 'hashX' },
    { question_id: 'Q3', subject: 'General Knowledge', topic: 'current affairs', subtopic: 'Regional Politics', question_hash: 'hashY' },
    { question_id: 'Q4', subject: 'Math', topic: 'Algebra', subtopic: '', question_hash: 'hashZ' }, // unrelated control
  ]);

  const result = mergeTaxonomyNodes(store, {
    nodeIds: [topicA._id, topicB._id],
    keepName: 'Current Affairs',
  });

  assert.equal(result.survivor.name, 'Current Affairs', 'survivor keeps the caller-chosen name');
  assert.equal(store.nodeById(topicB._id), undefined, 'the merged-away topic node must be deleted');
  assert.equal(store.allNodes().filter((n) => n.type === 'topic').length, 1, 'only one topic should remain under General Knowledge');

  // Recursive fold: subA (World Affairs, under survivor already) and
  // subB (world affairs, under the merged-away topic) must collapse
  // into ONE subtopic node, not two colliding siblings.
  const remainingSubtopics = store.allNodes().filter((n) => n.type === 'subtopic');
  assert.equal(remainingSubtopics.length, 2, 'World Affairs pair collapses to 1; Regional Politics survives separately = 2 total');
  const worldAffairs = remainingSubtopics.find((n) => n.slug === 'world-affairs');
  assert.ok(worldAffairs, 'a single World Affairs subtopic must remain');
  assert.equal(worldAffairs.parent_id, topicA._id, 'the collapsed World Affairs subtopic must be reparented onto the surviving topic');
  const regionalPolitics = remainingSubtopics.find((n) => n.slug === 'regional-politics');
  assert.equal(regionalPolitics.parent_id, topicA._id, 'non-colliding subtopic (Regional Politics) must simply be reparented onto the survivor');

  assert.deepEqual(
    result.stats.duplicate_children_collapsed,
    [{ level: 'subtopic', kept: 'World Affairs', merged_away: ['world affairs'] }],
    'the duplicate-child collapse must be recorded'
  );

  // Every MCQ retagged onto the surviving topic name.
  assert.equal(store.mcqs.find((m) => m.question_id === 'Q2').topic, 'Current Affairs');
  assert.equal(store.mcqs.find((m) => m.question_id === 'Q2').subtopic, 'World Affairs');
  assert.equal(store.mcqs.find((m) => m.question_id === 'Q3').topic, 'Current Affairs');
  assert.equal(store.mcqs.find((m) => m.question_id === 'Q4').topic, 'Algebra', 'unrelated control MCQ must be untouched');

  // Duplicate-MCQ edge case: Q1 + Q2 share question_hash 'hashX' and
  // both now sit under the same (subject, topic, subtopic) triple.
  // raw_mcq_count = 3 (Q1, Q2, Q3) but mcq_count must be net of the
  // one duplicate overlap, per this feature's own DoD wording ("sum of
  // both originals minus any now-duplicate MCQs that existed in both").
  assert.equal(result.raw_mcq_count, 3, 'all 3 physical MCQ rows survive (Q1, Q2, Q3) — nothing deleted');
  assert.equal(result.duplicate_mcq_count, 1, 'exactly one now-duplicate MCQ (Q1/Q2 share content) must be detected');
  assert.equal(result.mcq_count, 2, 'reported mcq_count must be net of the duplicate, not a naive sum');

  console.log('Scenario 1: "Current Affairs" / "current affairs" topic merge + recursive subtopic fold + duplicate-MCQ edge case — PASSED');
}

// ─────────────────────────────────────────────────────────────────
// Scenario 2 — "Pak Study" / "Pakistan Studies" (different-name
// SUBJECT duplicate). No parent constraint applies at subject level.
// ─────────────────────────────────────────────────────────────────
{
  const subjA = { _id: id(), type: 'subject', name: 'Pak Study', parent_id: null };
  const subjB = { _id: id(), type: 'subject', name: 'Pakistan Studies', parent_id: null };

  const store = makeStores([subjA, subjB], [
    { question_id: 'Q10', subject: 'Pak Study', topic: 'History', subtopic: '', question_hash: 'h1' },
    { question_id: 'Q11', subject: 'Pak Study', topic: 'Geography', subtopic: '', question_hash: 'h2' },
    { question_id: 'Q12', subject: 'Pakistan Studies', topic: 'Constitution', subtopic: '', question_hash: 'h3' },
  ]);

  const result = mergeTaxonomyNodes(store, {
    nodeIds: [subjA._id, subjB._id],
    keepName: 'Pakistan Studies',
  });

  assert.equal(result.survivor.name, 'Pakistan Studies');
  assert.equal(store.nodeById(subjA._id), undefined, '"Pak Study" node must be deleted after merging away');
  assert.equal(store.mcqs.filter((m) => m.subject === 'Pakistan Studies').length, 3, 'all 3 MCQs must now sit under the kept subject name');
  assert.equal(result.raw_mcq_count, 3);
  assert.equal(result.duplicate_mcq_count, 0, 'no overlapping content in this scenario');
  assert.equal(result.mcq_count, 3, 'sum of both originals, no duplicates to subtract');

  console.log('Scenario 2: "Pak Study" / "Pakistan Studies" subject merge (different names, no overlap) — PASSED');
}

console.log('\nAll mergeTaxonomyNodes scenarios passed.');
