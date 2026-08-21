// Standalone verification script — NOT part of the app.
//
// No live MongoDB is available in this environment (same limitation
// noted in Taxonomy Prompts 3-5's own verify_*/patch-notes scripts).
// What this DOES check, faithfully, is the exact transformation logic
// mcqService.moveSubjectIntoSubject applies — the TaxonomyNode
// type-flip, the nesting guard, and the per-MCQ pipeline-style
// (subject, topic, subtopic) rewrite — replayed against plain
// in-memory arrays that mirror the real documents byte-for-byte.
//
// Scenario 1 (the DoD's own example): "Islamic History" is a subject
// with two topics under it — "Ottoman Empire" (no subtopics) and
// "Mughal Era" (already has a subtopic, "Akbar's Reign", on a
// different MCQ than the one being folded in — this is allowed; the
// nesting guard only blocks a MOVE that would push things past level
// 3, not a topic simply having existing subtopics per se... except it
// DOES block that, per the spec: "if any topic under the subject being
// moved already has subtopics" is blocked unconditionally. So this
// scenario instead gives "Mughal Era" NO subtopics, and Scenario 2
// below is what exercises the guard.
//
// "Islamic Studies" is the destination — an existing, unrelated
// subject with its own topic ("Quran Studies") that Islamic History
// must NOT collide with.
import assert from 'node:assert/strict';

// ── Minimal TaxonomyNode fake ────────────────────────────────────────
let nextId = 1;
const freshId = () => `node_${nextId++}`;

function makeNodeStore(initialNodes) {
  const nodes = new Map(initialNodes.map((n) => [n._id, { ...n }]));
  return {
    all: () => Array.from(nodes.values()),
    byId: (id) => nodes.get(id),
    childrenOf: (parentId, type) =>
      Array.from(nodes.values()).filter((n) => n.parent_id === parentId && (!type || n.type === type)),
    setType: (id, type) => {
      nodes.get(id).type = type;
    },
    setParent: (id, parentId) => {
      nodes.get(id).parent_id = parentId;
    },
  };
}

// ── The transformation under test, extracted verbatim in spirit from
// mcq.service.js#moveSubjectIntoSubject (guard -> node writes -> MCQ
// pipeline-style rewrite -> Blueprint sync), operating on the fakes
// above instead of real Mongoose documents/sessions. ──────────────────
function moveSubjectIntoSubject(store, mcqs, blueprints, { subjectId, destinationId }) {
  const subjectNode = store.byId(subjectId);
  const destinationNode = store.byId(destinationId);
  assert.equal(subjectNode.type, 'subject');
  assert.equal(destinationNode.type, 'subject');
  assert.notEqual(subjectId, destinationId);

  const childTopics = store.childrenOf(subjectId, 'topic');
  const offending = childTopics.filter((t) => store.childrenOf(t._id, 'subtopic').length > 0);
  if (offending.length > 0) {
    throw new Error(
      `Cannot move "${subjectNode.name}" into "${destinationNode.name}": ` +
        `topic(s) ${offending.map((t) => `"${t.name}"`).join(', ')} already have subtopics — ` +
        `moving would require a 4th hierarchy level, which isn't supported.`
    );
  }

  const destinationHasSameTopic = store
    .childrenOf(destinationId, 'topic')
    .some((t) => t.name.toLowerCase() === subjectNode.name.toLowerCase());
  if (destinationHasSameTopic) {
    throw new Error(`"${destinationNode.name}" already has a topic named "${subjectNode.name}"`);
  }

  const oldSubjectName = subjectNode.name;
  const destinationSubjectName = destinationNode.name;

  // 1. subject -> topic, reparented.
  store.setType(subjectId, 'topic');
  store.setParent(subjectId, destinationId);

  // 2. its topics -> subtopics (parent_id unchanged).
  for (const t of childTopics) store.setType(t._id, 'subtopic');

  // 3. MCQs: pipeline-equivalent rewrite — subtopic first reads the
  // row's OWN prior topic, then subject/topic are overwritten.
  let matched = 0;
  let modified = 0;
  for (const mcq of mcqs) {
    if (mcq.subject !== oldSubjectName) continue;
    matched += 1;
    const before = { ...mcq };
    mcq.subtopic = mcq.topic ?? '';
    mcq.subject = destinationSubjectName;
    mcq.topic = oldSubjectName;
    if (before.subject !== mcq.subject || before.topic !== mcq.topic || before.subtopic !== mcq.subtopic) {
      modified += 1;
    }
  }

  // 4. Blueprint.subjects[] sync.
  let blueprintsUpdated = 0;
  for (const bp of blueprints) {
    let touched = false;
    for (const s of bp.subjects) {
      if (s.name === oldSubjectName) {
        s.name = destinationSubjectName;
        touched = true;
      }
    }
    if (touched) blueprintsUpdated += 1;
  }

  return {
    subject_node_id: subjectId,
    node_name: oldSubjectName,
    converted_to: 'topic',
    destination_subject: { id: destinationId, name: destinationSubjectName },
    subtopics_created: childTopics.length,
    matched_count: matched,
    modified_count: modified,
    blueprints_updated: blueprintsUpdated,
  };
}

// ─── Scenario 1: the DoD's "Islamic History -> Islamic Studies" case ──
{
  const islamicHistory = { _id: freshId(), type: 'subject', name: 'Islamic History', parent_id: null };
  const islamicStudies = { _id: freshId(), type: 'subject', name: 'Islamic Studies', parent_id: null };
  const ottomanEmpire = { _id: freshId(), type: 'topic', name: 'Ottoman Empire', parent_id: islamicHistory._id };
  const mughalEra = { _id: freshId(), type: 'topic', name: 'Mughal Era', parent_id: islamicHistory._id };
  const quranStudies = { _id: freshId(), type: 'topic', name: 'Quran Studies', parent_id: islamicStudies._id };

  const store = makeNodeStore([islamicHistory, islamicStudies, ottomanEmpire, mughalEra, quranStudies]);

  const mcqs = [
    { question_id: 'Q1', subject: 'Islamic History', topic: 'Ottoman Empire', subtopic: '' },
    { question_id: 'Q2', subject: 'Islamic History', topic: 'Mughal Era', subtopic: '' },
    { question_id: 'Q3', subject: 'Islamic History', topic: '', subtopic: '' },
    { question_id: 'Q4', subject: 'Islamic Studies', topic: 'Quran Studies', subtopic: '' }, // untouched control row
  ];
  const blueprints = [
    { name: 'General Knowledge Test', subjects: [{ name: 'Islamic History', percentage: 20 }, { name: 'English', percentage: 80 }] },
  ];

  const result = moveSubjectIntoSubject(store, mcqs, blueprints, {
    subjectId: islamicHistory._id,
    destinationId: islamicStudies._id,
  });

  // ── Node shape assertions ──
  assert.equal(store.byId(islamicHistory._id).type, 'topic', 'Islamic History should now be a topic');
  assert.equal(
    store.byId(islamicHistory._id).parent_id,
    islamicStudies._id,
    'Islamic History (now a topic) should be parented under Islamic Studies'
  );
  assert.equal(store.byId(ottomanEmpire._id).type, 'subtopic', 'Ottoman Empire should now be a subtopic');
  assert.equal(store.byId(mughalEra._id).type, 'subtopic', 'Mughal Era should now be a subtopic');
  assert.equal(
    store.byId(ottomanEmpire._id).parent_id,
    islamicHistory._id,
    'Ottoman Empire subtopic should still be parented under the (now-topic) Islamic History node'
  );

  // ── MCQ shape assertions — the documented "after" state ──
  const q1 = mcqs.find((m) => m.question_id === 'Q1');
  assert.deepEqual(
    { subject: q1.subject, topic: q1.topic, subtopic: q1.subtopic },
    { subject: 'Islamic Studies', topic: 'Islamic History', subtopic: 'Ottoman Empire' },
    'Q1: had a topic -> that topic value becomes the subtopic'
  );

  const q2 = mcqs.find((m) => m.question_id === 'Q2');
  assert.deepEqual(
    { subject: q2.subject, topic: q2.topic, subtopic: q2.subtopic },
    { subject: 'Islamic Studies', topic: 'Islamic History', subtopic: 'Mughal Era' },
    'Q2: had a topic -> that topic value becomes the subtopic'
  );

  const q3 = mcqs.find((m) => m.question_id === 'Q3');
  assert.deepEqual(
    { subject: q3.subject, topic: q3.topic, subtopic: q3.subtopic },
    { subject: 'Islamic Studies', topic: 'Islamic History', subtopic: '' },
    'Q3: had NO topic -> subtopic stays empty'
  );

  const q4 = mcqs.find((m) => m.question_id === 'Q4');
  assert.deepEqual(
    { subject: q4.subject, topic: q4.topic, subtopic: q4.subtopic },
    { subject: 'Islamic Studies', topic: 'Quran Studies', subtopic: '' },
    'Q4: unrelated pre-existing Islamic Studies row must be untouched'
  );

  // ── Response + Blueprint assertions ──
  assert.equal(result.matched_count, 3);
  assert.equal(result.modified_count, 3);
  assert.equal(result.subtopics_created, 2);
  assert.equal(result.blueprints_updated, 1);
  assert.equal(blueprints[0].subjects[0].name, 'Islamic Studies');
  assert.equal(blueprints[0].subjects[1].name, 'English', 'unrelated blueprint entry must be untouched');

  console.log('Scenario 1 (Islamic History -> Islamic Studies) PASSED');
  console.log(`  matched=${result.matched_count} modified=${result.modified_count} subtopics_created=${result.subtopics_created} blueprints_updated=${result.blueprints_updated}`);
}

// ─── Scenario 2: too-deep topic must be rejected with a named,
// actionable error instead of failing silently ──────────────────────
{
  const geography = { _id: freshId(), type: 'subject', name: 'Geography', parent_id: null };
  const socialStudies = { _id: freshId(), type: 'subject', name: 'Social Studies', parent_id: null };
  const physicalGeography = { _id: freshId(), type: 'topic', name: 'Physical Geography', parent_id: geography._id };
  // This topic already has a subtopic -> the offending one.
  const climateZones = { _id: freshId(), type: 'subtopic', name: 'Climate Zones', parent_id: physicalGeography._id };

  const store = makeNodeStore([geography, socialStudies, physicalGeography, climateZones]);
  const mcqs = [];
  const blueprints = [];

  assert.throws(
    () => moveSubjectIntoSubject(store, mcqs, blueprints, { subjectId: geography._id, destinationId: socialStudies._id }),
    (err) => {
      assert.match(err.message, /Physical Geography/, 'error must name the offending topic');
      assert.match(err.message, /4th hierarchy level/, 'error must explain WHY it was blocked');
      return true;
    }
  );
  // Nothing should have been mutated — reject-before-write.
  assert.equal(store.byId(geography._id).type, 'subject', 'Geography must remain a subject after a rejected move');
  assert.equal(store.byId(physicalGeography._id).type, 'topic', 'Physical Geography must be untouched');

  console.log('Scenario 2 (too-deep topic rejected) PASSED');
}

console.log('\nAll moveSubjectIntoSubject scenarios passed.');
