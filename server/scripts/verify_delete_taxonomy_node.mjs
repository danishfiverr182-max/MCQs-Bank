// Standalone verification script — NOT part of the app.
//
// No live MongoDB is available in this environment (same limitation
// noted in every other Taxonomy verify_*.mjs script — see e.g.
// verify_merge_taxonomy_nodes.mjs's own header). What this DOES check,
// faithfully, is the exact transformation logic
// mcqService.deleteTaxonomyNode / previewTaxonomyDelete apply — replayed
// against plain in-memory arrays that mirror the real TaxonomyNode + MCQ
// documents byte-for-byte, including the recursive subject-level
// cascade and both `on_orphan_mcqs` branches.
//
// Four scenarios, straight out of this feature's own DoD:
//
//   1. previewTaxonomyDelete on a subject with topics + subtopics —
//      topic_count/subtopic_count/mcq_count must all be correct BEFORE
//      anything is touched.
//   2. Deleting that subject with on_orphan_mcqs: { action: 'move',
//      destination_node_id: <another subject> } — every MCQ under the
//      deleted subject (regardless of which topic/subtopic it was
//      filed under) must end up reassigned to the destination subject,
//      and EVERY TaxonomyNode in the deleted subject's subtree (the
//      subject itself, its topics, their subtopics) must be gone. Zero
//      orphans: no MCQ may still reference the deleted subject name.
//   3. Deleting a single topic with on_orphan_mcqs: { action: 'delete' }
//      — exactly the previewed mcq_count of MCQs must be removed, no
//      more, no less, and the topic + its subtopic must both be gone
//      while an unrelated sibling topic is untouched.
//   4. Deleting a subtopic with 'move' to a subtopic under a DIFFERENT
//      subject/topic entirely — proves the full-path (subject + topic +
//      subtopic) overwrite, not just the subtopic field.
import assert from 'node:assert/strict';

let nextId = 1;
const id = () => `node_${nextId++}`;

// ── Minimal in-memory TaxonomyNode + MCQ stores ──────────────────────
function makeStores(initialNodes, initialMcqs) {
  const nodes = new Map(initialNodes.map((n) => [n._id, { ...n }]));
  const mcqs = initialMcqs.map((m) => ({ ...m }));
  return {
    nodeById: (nid) => nodes.get(nid),
    childrenOf: (parentId, type) =>
      Array.from(nodes.values()).filter((n) => n.parent_id === parentId && n.type === type),
    childrenOfAny: (parentIds, type) =>
      Array.from(nodes.values()).filter((n) => parentIds.includes(n.parent_id) && n.type === type),
    deleteNodes: (ids) => ids.forEach((nid) => nodes.delete(nid)),
    allNodes: () => Array.from(nodes.values()),
    mcqs,
  };
}

// ── Mirrors mcq.service.js's mcqFilterForLevel / mcqUpdateForLevel /
// mcqUpdateForDeleteMove / resolveAncestorNames exactly ──────────────
const mcqFilterForLevel = (level, ancestorNames, name) => {
  if (level === 'subject') return (m) => m.subject === name;
  if (level === 'topic')
    return (m) => m.subject === ancestorNames.subject && m.topic.toLowerCase() === name.toLowerCase();
  return (m) =>
    m.subject === ancestorNames.subject &&
    m.topic.toLowerCase() === ancestorNames.topic.toLowerCase() &&
    m.subtopic.toLowerCase() === name.toLowerCase();
};
const applyDeleteMoveUpdate = (level, destinationAncestorNames, destinationName, mcq) => {
  if (level === 'subject') {
    mcq.subject = destinationName;
  } else if (level === 'topic') {
    mcq.subject = destinationAncestorNames.subject;
    mcq.topic = destinationName;
  } else {
    mcq.subject = destinationAncestorNames.subject;
    mcq.topic = destinationAncestorNames.topic;
    mcq.subtopic = destinationName;
  }
};
function resolveAncestorNames(store, node) {
  if (node.type === 'subject') return {};
  if (node.type === 'topic') {
    return { subject: store.nodeById(node.parent_id).name };
  }
  const topicNode = store.nodeById(node.parent_id);
  return { subject: store.nodeById(topicNode.parent_id).name, topic: topicNode.name };
}

// Mirrors mcqService.countDescendantNodes.
function countDescendantNodes(store, node) {
  if (node.type === 'subject') {
    const topics = store.childrenOf(node._id, 'topic');
    const topicIds = topics.map((t) => t._id);
    const subtopicCount = store.childrenOfAny(topicIds, 'subtopic').length;
    return { topic_count: topics.length, subtopic_count: subtopicCount };
  }
  if (node.type === 'topic') {
    return { topic_count: 0, subtopic_count: store.childrenOf(node._id, 'subtopic').length };
  }
  return { topic_count: 0, subtopic_count: 0 };
}

// Mirrors mcqService.previewTaxonomyDelete.
function previewTaxonomyDelete(store, nodeId) {
  const node = store.nodeById(nodeId);
  const ancestorNames = resolveAncestorNames(store, node);
  const { topic_count, subtopic_count } = countDescendantNodes(store, node);
  const mcq_count = store.mcqs.filter(mcqFilterForLevel(node.type, ancestorNames, node.name)).length;
  return { node_id: node._id, name: node.name, type: node.type, topic_count, subtopic_count, mcq_count };
}

// Mirrors mcqService.collectSubtreeNodeIds.
function collectSubtreeNodeIds(store, node) {
  const ids = [node._id];
  if (node.type === 'subject') {
    const topics = store.childrenOf(node._id, 'topic');
    ids.push(...topics.map((t) => t._id));
    ids.push(...store.childrenOfAny(topics.map((t) => t._id), 'subtopic').map((s) => s._id));
  } else if (node.type === 'topic') {
    ids.push(...store.childrenOf(node._id, 'subtopic').map((s) => s._id));
  }
  return ids;
}

// Mirrors mcqService.deleteTaxonomyNode.
function deleteTaxonomyNode(store, { node_id, on_orphan_mcqs }) {
  const node = store.nodeById(node_id);
  const ancestorNames = resolveAncestorNames(store, node);
  const filter = mcqFilterForLevel(node.type, ancestorNames, node.name);

  let destinationNode = null;
  let destinationAncestorNames = {};
  if (on_orphan_mcqs.action === 'move') {
    destinationNode = store.nodeById(on_orphan_mcqs.destination_node_id);
    assert.notEqual(destinationNode.type, undefined);
    assert.equal(destinationNode.type, node.type, 'destination must be same type as node being deleted');
    destinationAncestorNames = resolveAncestorNames(store, destinationNode);
  }

  const subtreeNodeIds = collectSubtreeNodeIds(store, node);

  let matched_count = 0;
  let deleted_mcq_count = 0;
  if (on_orphan_mcqs.action === 'move') {
    const matches = store.mcqs.filter(filter);
    for (const m of matches) applyDeleteMoveUpdate(node.type, destinationAncestorNames, destinationNode.name, m);
    matched_count = matches.length;
  } else {
    const before = store.mcqs.length;
    const keep = store.mcqs.filter((m) => !filter(m));
    deleted_mcq_count = before - keep.length;
    store.mcqs.length = 0;
    store.mcqs.push(...keep);
  }

  store.deleteNodes(subtreeNodeIds);

  return {
    node_id: node._id,
    node_type: node.type,
    deleted_node_count: subtreeNodeIds.length,
    on_orphan_mcqs: on_orphan_mcqs.action,
    matched_count,
    deleted_mcq_count,
  };
}

// ─────────────────────────────────────────────────────────────────
// Scenario 1 + 2 — delete subject "Islamic Studies" (2 topics, one
// with 2 subtopics, one with none), MCQs scattered across every
// topic/subtopic AND directly on the bare topic (no subtopic) —
// preview first, then execute with 'move' to another subject.
// ─────────────────────────────────────────────────────────────────
{
  const islamicStudies = { _id: id(), type: 'subject', name: 'Islamic Studies', parent_id: null };
  const topicA = { _id: id(), type: 'topic', name: 'Quran', parent_id: islamicStudies._id };
  const topicB = { _id: id(), type: 'topic', name: 'Hadith', parent_id: islamicStudies._id };
  const subA1 = { _id: id(), type: 'subtopic', name: 'Tafsir', parent_id: topicA._id };
  const subA2 = { _id: id(), type: 'subtopic', name: 'Recitation', parent_id: topicA._id };

  const generalKnowledge = { _id: id(), type: 'subject', name: 'General Knowledge', parent_id: null };

  const store = makeStores(
    [islamicStudies, topicA, topicB, subA1, subA2, generalKnowledge],
    [
      { question_id: 'Q1', subject: 'Islamic Studies', topic: 'Quran', subtopic: 'Tafsir' },
      { question_id: 'Q2', subject: 'Islamic Studies', topic: 'Quran', subtopic: 'Recitation' },
      { question_id: 'Q3', subject: 'Islamic Studies', topic: 'Hadith', subtopic: '' }, // bare topic, no subtopic
      { question_id: 'Q4', subject: 'Islamic Studies', topic: '', subtopic: '' }, // no topic at all
      { question_id: 'Q5', subject: 'General Knowledge', topic: 'Current Affairs', subtopic: '' }, // unrelated control
    ]
  );

  // ── Feature 8: preview ──
  const preview = previewTaxonomyDelete(store, islamicStudies._id);
  assert.equal(preview.type, 'subject');
  assert.equal(preview.topic_count, 2, 'Quran + Hadith');
  assert.equal(preview.subtopic_count, 2, 'Tafsir + Recitation (Hadith has none)');
  assert.equal(preview.mcq_count, 4, 'Q1-Q4 all sit under Islamic Studies, Q5 does not');
  console.log('Scenario 1: previewTaxonomyDelete on a subject reports correct topic/subtopic/mcq counts — PASSED');

  // ── Feature 9: delete with move ──
  const result = deleteTaxonomyNode(store, {
    node_id: islamicStudies._id,
    on_orphan_mcqs: { action: 'move', destination_node_id: generalKnowledge._id },
  });

  assert.equal(result.on_orphan_mcqs, 'move');
  assert.equal(result.matched_count, 4, 'every previewed MCQ (Q1-Q4) must be reassigned');
  assert.equal(result.deleted_node_count, 5, 'subject + 2 topics + 2 subtopics');

  // Zero orphans: no MCQ may still reference "Islamic Studies".
  assert.equal(
    store.mcqs.filter((m) => m.subject === 'Islamic Studies').length,
    0,
    'no MCQ should still reference the deleted subject'
  );
  assert.equal(
    store.mcqs.filter((m) => m.subject === 'General Knowledge').length,
    5,
    'all 4 reassigned MCQs + the 1 pre-existing control must now sit under General Knowledge'
  );
  // topic/subtopic values on the reassigned MCQs are untouched — only
  // `subject` changes for a subject-level move.
  assert.equal(store.mcqs.find((m) => m.question_id === 'Q1').topic, 'Quran');
  assert.equal(store.mcqs.find((m) => m.question_id === 'Q1').subtopic, 'Tafsir');
  assert.equal(store.mcqs.find((m) => m.question_id === 'Q5').topic, 'Current Affairs', 'unrelated control MCQ untouched');

  // Every node in the deleted subtree must be gone.
  for (const n of [islamicStudies, topicA, topicB, subA1, subA2]) {
    assert.equal(store.nodeById(n._id), undefined, `${n.name} node must be deleted`);
  }
  assert.equal(store.nodeById(generalKnowledge._id).name, 'General Knowledge', 'destination subject itself must survive');

  console.log('Scenario 2: deleteTaxonomyNode on a subject with "move" reassigns every MCQ and leaves zero orphans — PASSED');
}

// ─────────────────────────────────────────────────────────────────
// Scenario 3 — Feature 10: delete a single topic ("Algebra", with one
// subtopic "Equations") with on_orphan_mcqs: { action: 'delete' }.
// Exactly the previewed count must be removed — a sibling topic
// ("Geometry") under the same subject must be untouched.
// ─────────────────────────────────────────────────────────────────
{
  const math = { _id: id(), type: 'subject', name: 'Math', parent_id: null };
  const algebra = { _id: id(), type: 'topic', name: 'Algebra', parent_id: math._id };
  const geometry = { _id: id(), type: 'topic', name: 'Geometry', parent_id: math._id };
  const equations = { _id: id(), type: 'subtopic', name: 'Equations', parent_id: algebra._id };

  const store = makeStores(
    [math, algebra, geometry, equations],
    [
      { question_id: 'Q20', subject: 'Math', topic: 'Algebra', subtopic: 'Equations' },
      { question_id: 'Q21', subject: 'Math', topic: 'Algebra', subtopic: '' },
      { question_id: 'Q22', subject: 'Math', topic: 'Geometry', subtopic: '' }, // must survive
    ]
  );

  const preview = previewTaxonomyDelete(store, algebra._id);
  assert.equal(preview.topic_count, 0, 'a topic node has no topic-level descendants');
  assert.equal(preview.subtopic_count, 1, 'Equations');
  assert.equal(preview.mcq_count, 2, 'Q20 + Q21');

  const result = deleteTaxonomyNode(store, {
    node_id: algebra._id,
    on_orphan_mcqs: { action: 'delete' },
  });

  assert.equal(result.on_orphan_mcqs, 'delete');
  assert.equal(result.deleted_mcq_count, preview.mcq_count, 'deleted count must exactly match the previewed count — no more, no less');
  assert.equal(result.deleted_node_count, 2, 'Algebra + its subtopic Equations');

  assert.equal(store.mcqs.length, 1, 'only Q22 (Geometry) should remain');
  assert.equal(store.mcqs[0].question_id, 'Q22');
  assert.equal(store.nodeById(algebra._id), undefined, 'Algebra node must be deleted');
  assert.equal(store.nodeById(equations._id), undefined, 'Equations subtopic must be deleted');
  assert.ok(store.nodeById(geometry._id), 'sibling topic Geometry must survive untouched');
  assert.ok(store.nodeById(math._id), 'parent subject Math must survive untouched');

  console.log('Scenario 3: deleteTaxonomyNode on a topic with "delete" removes exactly the previewed MCQ count, no more no less — PASSED');
}

// ─────────────────────────────────────────────────────────────────
// Scenario 4 — delete a subtopic with 'move' to a subtopic under a
// DIFFERENT subject+topic entirely, proving the full-path
// (subject+topic+subtopic) overwrite rather than just the subtopic
// field.
// ─────────────────────────────────────────────────────────────────
{
  const history = { _id: id(), type: 'subject', name: 'History', parent_id: null };
  const worldHistory = { _id: id(), type: 'topic', name: 'World History', parent_id: history._id };
  const frenchRev = { _id: id(), type: 'subtopic', name: 'French Revolution', parent_id: worldHistory._id };

  const geography = { _id: id(), type: 'subject', name: 'Geography', parent_id: null };
  const europe = { _id: id(), type: 'topic', name: 'Europe', parent_id: geography._id };
  const modernEurope = { _id: id(), type: 'subtopic', name: 'Modern Europe', parent_id: europe._id };

  const store = makeStores(
    [history, worldHistory, frenchRev, geography, europe, modernEurope],
    [
      { question_id: 'Q30', subject: 'History', topic: 'World History', subtopic: 'French Revolution' },
      { question_id: 'Q31', subject: 'History', topic: 'World History', subtopic: 'French Revolution' },
    ]
  );

  const result = deleteTaxonomyNode(store, {
    node_id: frenchRev._id,
    on_orphan_mcqs: { action: 'move', destination_node_id: modernEurope._id },
  });

  assert.equal(result.matched_count, 2);
  assert.equal(result.deleted_node_count, 1, 'a subtopic has no descendants of its own');

  for (const m of store.mcqs) {
    assert.equal(m.subject, 'Geography', 'subject must follow the destination, not stay History');
    assert.equal(m.topic, 'Europe', 'topic must follow the destination, not stay World History');
    assert.equal(m.subtopic, 'Modern Europe');
  }
  assert.equal(store.nodeById(frenchRev._id), undefined, 'the deleted subtopic node must be gone');
  assert.ok(store.nodeById(worldHistory._id), 'the now-empty parent topic is NOT deleted by a subtopic-level delete');

  console.log('Scenario 4: deleteTaxonomyNode on a subtopic with "move" to a different subject/topic overwrites the full path — PASSED');
}

console.log('\n✅ PASS — previewTaxonomyDelete/deleteTaxonomyNode never leave an MCQ referencing a deleted taxonomy string, and "delete" removes exactly the previewed count.');
