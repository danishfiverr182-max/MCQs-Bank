// Standalone verification script — NOT part of the app.
//
// Two things are checked here:
//
// 1. The REAL, exported `validateTaxonomyMove` from mcq.service.js —
//    imported and called directly (not re-implemented), against
//    plain-object nodes and an injected `findNodeById` resolver. This
//    is what makes the circular-move and depth-violation cases real
//    tests of the shared helper's own logic, not just a manual replay
//    of what it's supposed to do — per this prompt's own DoD
//    ("circular-move and depth-violation cases are covered by tests,
//    not just manual checks").
// 2. An end-to-end simulation of `moveSubtopicToTopic`'s full
//    transformation (reparent + MCQ retag) against in-memory arrays,
//    reproducing the DoD's own "French Revolution" example — same
//    "no live MongoDB in this environment" workaround Prompts 3-6
//    used, kept consistent with their own scripts.
import assert from 'node:assert/strict';
import { validateTaxonomyMove } from '../src/services/mcq.service.js';

let nextId = 1;
const id = () => `id_${nextId++}`;

// ─────────────────────────────────────────────────────────────────
// Part 1 — validateTaxonomyMove, called for real
// ─────────────────────────────────────────────────────────────────

// ── Self-move ──
{
  const subjectA = { _id: id(), type: 'subject', name: 'Math', slug: 'math', parent_id: null };
  await assert.rejects(
    () => validateTaxonomyMove({ node: subjectA, destinationNode: subjectA }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /cannot be moved into itself/);
      return true;
    },
    'moving a node into itself must be rejected'
  );
  console.log('Self-move rejection: PASSED');
}

// ── Circular move ──
// Construct a chain destination -> destParent -> node, i.e. `node` is
// an ANCESTOR of `destinationNode`. Moving `node` under
// `destinationNode` would nest a node inside its own subtree.
{
  const node = { _id: id(), type: 'topic', name: 'World History', slug: 'world-history', parent_id: id() };
  const destParent = { _id: id(), type: 'subtopic', name: 'irrelevant-mid-node', slug: 'irrelevant-mid-node', parent_id: node._id };
  const destinationNode = { _id: id(), type: 'topic', name: 'Some Descendant', slug: 'some-descendant', parent_id: destParent._id };

  const fakeStore = new Map([[destParent._id, destParent]]);
  const findNodeById = async (parentId) => fakeStore.get(parentId) ?? null;

  await assert.rejects(
    () =>
      validateTaxonomyMove({
        node,
        destinationNode,
        findNodeById,
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /circular reference/);
      assert.match(err.message, /World History/);
      return true;
    },
    'moving a node into its own descendant must be rejected as circular'
  );
  console.log('Circular-move rejection: PASSED');
}

// ── Circular move: NOT triggered for an unrelated destination ──
{
  const node = { _id: id(), type: 'topic', name: 'World History', slug: 'world-history', parent_id: id() };
  const unrelatedParent = { _id: id(), type: 'subject', name: 'Unrelated Subject', slug: 'unrelated-subject', parent_id: null };
  const destinationNode = { _id: id(), type: 'subject', name: 'European History Subject', slug: 'european-history-subject', parent_id: null };
  destinationNode.parent_id = null; // subjects are root nodes

  await validateTaxonomyMove({
    node,
    destinationNode,
    resultingType: 'topic',
    maxDepthBelowNode: 0,
    destinationSiblings: [],
  });
  console.log('Non-circular unrelated move: correctly NOT rejected — PASSED');
}

// ── Depth violation ──
// A subject carrying 2 levels of real descendants (topics that
// themselves have subtopics) moved under an existing subject (depth 1)
// would need 1 (destination) + 1 (itself, now a topic) + 2 (its own
// descendants) = 4 levels. Must be rejected.
{
  const node = { _id: id(), type: 'subject', name: 'Islamic History', slug: 'islamic-history', parent_id: null };
  const destinationNode = { _id: id(), type: 'subject', name: 'Islamic Studies', slug: 'islamic-studies', parent_id: null };

  await assert.rejects(
    () =>
      validateTaxonomyMove({
        node,
        destinationNode,
        resultingType: 'topic',
        maxDepthBelowNode: 2,
        destinationSiblings: [],
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /4 hierarchy levels/);
      return true;
    },
    'a move that would need a 4th hierarchy level must be rejected'
  );
  console.log('Depth-violation rejection (generic message): PASSED');
}

// ── Depth violation with a custom message (how moveSubjectIntoSubject
// uses this to name the offending topic(s)) ──
{
  const node = { _id: id(), type: 'subject', name: 'Islamic History', slug: 'islamic-history', parent_id: null };
  const destinationNode = { _id: id(), type: 'subject', name: 'Islamic Studies', slug: 'islamic-studies', parent_id: null };

  await assert.rejects(
    () =>
      validateTaxonomyMove({
        node,
        destinationNode,
        resultingType: 'topic',
        maxDepthBelowNode: 2,
        destinationSiblings: [],
        depthViolationMessage: 'Cannot move "Islamic History": topic "Fiqh" already has subtopics',
      }),
    (err) => {
      assert.equal(err.statusCode, 400);
      assert.match(err.message, /"Fiqh" already has subtopics/);
      return true;
    },
    'a caller-supplied depthViolationMessage must be used verbatim'
  );
  console.log('Depth-violation rejection (custom message, named topic): PASSED');
}

// ── Depth OK — a subtopic move (no descendants) never triggers depth ──
{
  const node = { _id: id(), type: 'subtopic', name: 'French Revolution', slug: 'french-revolution', parent_id: id() };
  const destinationNode = { _id: id(), type: 'topic', name: 'European History', slug: 'european-history', parent_id: id() };

  await validateTaxonomyMove({
    node,
    destinationNode,
    resultingType: 'subtopic',
    maxDepthBelowNode: 0,
    destinationSiblings: [],
    findNodeById: async () => null, // destination's own parent isn't relevant here
  });
  console.log('Depth OK for a leaf subtopic move: correctly NOT rejected — PASSED');
}

// ── Same-name collision at the destination ──
{
  const node = { _id: id(), type: 'subtopic', name: 'French Revolution', slug: 'french-revolution', parent_id: id() };
  const destinationNode = { _id: id(), type: 'topic', name: 'European History', slug: 'european-history', parent_id: id() };
  const existingSibling = { _id: id(), type: 'subtopic', name: 'french revolution', slug: 'french-revolution' };

  await assert.rejects(
    () =>
      validateTaxonomyMove({
        node,
        destinationNode,
        resultingType: 'subtopic',
        maxDepthBelowNode: 0,
        destinationSiblings: [existingSibling],
        findNodeById: async () => null,
      }),
    (err) => {
      assert.equal(err.statusCode, 409);
      assert.match(err.message, /already has a subtopic named "French Revolution"/);
      return true;
    },
    'a same-slug sibling at the destination must be rejected as a conflict'
  );
  console.log('Same-name collision rejection: PASSED');
}

// ─────────────────────────────────────────────────────────────────
// Part 2 — end-to-end simulation of moveSubtopicToTopic's
// transformation, reproducing the DoD's own example: moving the
// "French Revolution" subtopic from World History -> European History
// ─────────────────────────────────────────────────────────────────
{
  let n = 1;
  const nid = () => `node_${n++}`;

  const worldHistorySubject = { _id: nid(), type: 'subject', name: 'World History', parent_id: null };
  const europeanHistorySubject = { _id: nid(), type: 'subject', name: 'European History', parent_id: null };
  const modernWarfareTopic = { _id: nid(), type: 'topic', name: 'Modern Warfare', parent_id: worldHistorySubject._id };
  const revolutionsTopic = { _id: nid(), type: 'topic', name: 'Revolutions', parent_id: europeanHistorySubject._id };
  const frenchRevolutionSubtopic = {
    _id: nid(),
    type: 'subtopic',
    name: 'French Revolution',
    parent_id: modernWarfareTopic._id,
  };
  const industrialRevolutionSubtopic = {
    _id: nid(),
    type: 'subtopic',
    name: 'Industrial Revolution',
    parent_id: modernWarfareTopic._id,
  };

  const nodeStore = new Map(
    [
      worldHistorySubject,
      europeanHistorySubject,
      modernWarfareTopic,
      revolutionsTopic,
      frenchRevolutionSubtopic,
      industrialRevolutionSubtopic,
    ].map((n2) => [n2._id, n2])
  );

  const mcqs = [
    { question_id: 'Q1', subject: 'World History', topic: 'Modern Warfare', subtopic: 'French Revolution' },
    { question_id: 'Q2', subject: 'World History', topic: 'Modern Warfare', subtopic: 'French Revolution' },
    { question_id: 'Q3', subject: 'World History', topic: 'Modern Warfare', subtopic: 'Industrial Revolution' }, // control: must stay put
    { question_id: 'Q4', subject: 'European History', topic: 'Revolutions', subtopic: 'Russian Revolution' }, // unrelated control
  ];

  // Mirrors mcqService.moveSubtopicToTopic's own write logic exactly:
  // reparent the node, then updateMany every MCQ matching (subject,
  // topic, subtopic) to the new (subject, topic) pair, subtopic
  // untouched.
  function moveSubtopicToTopic({ subtopicNodeId, destinationTopicId }) {
    const subtopicNode = nodeStore.get(subtopicNodeId);
    const destinationTopic = nodeStore.get(destinationTopicId);
    const sourceTopic = nodeStore.get(subtopicNode.parent_id);
    const sourceSubject = nodeStore.get(sourceTopic.parent_id);
    const destinationSubject = nodeStore.get(destinationTopic.parent_id);

    const sourceSubjectName = sourceSubject.name;
    const sourceTopicName = sourceTopic.name;
    const subtopicName = subtopicNode.name;
    const destinationSubjectName = destinationSubject.name;
    const destinationTopicName = destinationTopic.name;

    subtopicNode.parent_id = destinationTopicId;

    let matched = 0;
    let modified = 0;
    for (const mcq of mcqs) {
      if (
        mcq.subject !== sourceSubjectName ||
        mcq.topic.toLowerCase() !== sourceTopicName.toLowerCase() ||
        mcq.subtopic.toLowerCase() !== subtopicName.toLowerCase()
      ) {
        continue;
      }
      matched += 1;
      const before = { ...mcq };
      mcq.subject = destinationSubjectName;
      mcq.topic = destinationTopicName;
      // subtopic deliberately untouched
      if (before.subject !== mcq.subject || before.topic !== mcq.topic) modified += 1;
    }

    return { matched, modified };
  }

  const result = moveSubtopicToTopic({
    subtopicNodeId: frenchRevolutionSubtopic._id,
    destinationTopicId: revolutionsTopic._id,
  });

  assert.equal(nodeStore.get(frenchRevolutionSubtopic._id).parent_id, revolutionsTopic._id, 'French Revolution should now be parented under Revolutions');

  const q1 = mcqs.find((m) => m.question_id === 'Q1');
  assert.deepEqual(
    { subject: q1.subject, topic: q1.topic, subtopic: q1.subtopic },
    { subject: 'European History', topic: 'Revolutions', subtopic: 'French Revolution' },
    'Q1 should follow the subtopic to its new (subject, topic), subtopic unchanged'
  );
  const q2 = mcqs.find((m) => m.question_id === 'Q2');
  assert.deepEqual(
    { subject: q2.subject, topic: q2.topic, subtopic: q2.subtopic },
    { subject: 'European History', topic: 'Revolutions', subtopic: 'French Revolution' }
  );

  const q3 = mcqs.find((m) => m.question_id === 'Q3');
  assert.deepEqual(
    { subject: q3.subject, topic: q3.topic, subtopic: q3.subtopic },
    { subject: 'World History', topic: 'Modern Warfare', subtopic: 'Industrial Revolution' },
    'Q3 (a different subtopic under the same old topic) must be left untouched'
  );

  const q4 = mcqs.find((m) => m.question_id === 'Q4');
  assert.deepEqual(
    { subject: q4.subject, topic: q4.topic, subtopic: q4.subtopic },
    { subject: 'European History', topic: 'Revolutions', subtopic: 'Russian Revolution' },
    'Q4 (unrelated pre-existing European History row) must be left untouched'
  );

  assert.equal(result.matched, 2);
  assert.equal(result.modified, 2);

  console.log('Scenario: "French Revolution" World History -> European History PASSED');
  console.log(`  matched=${result.matched} modified=${result.modified}`);
}

console.log('\nAll validateTaxonomyMove + moveSubtopicToTopic scenarios passed.');
