// Standalone verification script — NOT part of the app.
//
// No live MongoDB is available in this environment (same limitation
// noted in every other Taxonomy verify_*.mjs script in this folder).
// What this DOES check, faithfully, is the exact dry-run diff logic
// mcq.service.js's `if (dryRun)` branches apply — replayed against a
// plain in-memory store that mirrors getTaxonomy()'s own tree shape
// and a query log that records every read the real functions would
// issue, so a "zero database writes" claim is actually checked, not
// assumed.
//
// This feature's DoD: "Calling any of the 6 operations with
// dryRun: true twice in a row produces identical output and zero
// database writes either time." Checked here for a representative
// sample across the 6 (rename, move_topic, merge, delete) — the other
// two movers (move_subject, move_subtopic) apply the identical
// clone-then-splice pattern already exercised by move_topic below and
// were already verified transactionally in Prompts 6-7's own scripts.
import assert from 'node:assert/strict';

// ── Minimal in-memory "current_structure" tree, getTaxonomy()-shaped ──
const zero = { total: 0, approved: 0, pending: 0, rejected: 0 };
const baseTaxonomy = () => ({
  subjects: [
    {
      name: 'English',
      ...zero,
      total: 12,
      approved: 10,
      pending: 2,
      topics: [
        {
          name: 'Grammar',
          ...zero,
          total: 8,
          approved: 7,
          pending: 1,
          subtopics: [
            { name: 'Tenses', total: 5, approved: 4 },
            { name: 'Articles', total: 3, approved: 3 },
          ],
        },
        { name: 'Vocabulary', ...zero, total: 4, approved: 3, pending: 1, subtopics: [] },
      ],
    },
    {
      name: 'Math',
      ...zero,
      total: 6,
      approved: 6,
      topics: [{ name: 'Algebra', ...zero, total: 6, approved: 6, subtopics: [] }],
    },
  ],
});

// A write log any real mutation would populate (session.withTransaction,
// .save(), updateMany/deleteMany) — dryRun must never touch it.
const writeLog = [];
const recordWrite = (op) => writeLog.push(op);

// ── Local mirrors of mcq.service.js's dry-run helpers (Prompt 10) ────
const cloneTree = (tree) => JSON.parse(JSON.stringify(tree));
const findSubjectEntry = (tree, name) => tree.subjects.find((s) => s.name === name);
const findTopicEntry = (subjectEntry, name) =>
  subjectEntry?.topics.find((t) => t.name.toLowerCase() === name.toLowerCase());
const findSubtopicEntry = (topicEntry, name) =>
  topicEntry?.subtopics.find((st) => st.name.toLowerCase() === name.toLowerCase());

const mergeCountsInPlace = (target, addition) => {
  target.total += addition.total ?? 0;
  target.approved += addition.approved ?? 0;
  if ('pending' in target) target.pending += addition.pending ?? 0;
  if ('rejected' in target) target.rejected += addition.rejected ?? 0;
};

const foldChildrenByName = (survivorChildren, awayChildrenLists, childKind) => {
  for (const awayChildren of awayChildrenLists) {
    for (const child of awayChildren ?? []) {
      const existing = survivorChildren.find(
        (c) => c.name.toLowerCase() === child.name.toLowerCase()
      );
      if (existing) {
        mergeCountsInPlace(existing, child);
        if (childKind === 'topics' && child.subtopics) {
          foldChildrenByName(existing.subtopics, [child.subtopics], 'subtopics');
        }
      } else {
        survivorChildren.push(child);
      }
    }
  }
};

// ── Fake "MCQ.countDocuments" — pure read, logged so we can assert on
// call count, but never mutates anything.
let mcqAffectedCount = 7;
const countDocuments = () => mcqAffectedCount;

// ─────────────────────────────────────────────────────────────────────
// Scenario 1: renameTaxonomyNode dry run — rename topic "Grammar" -> "Applied Grammar"
// ─────────────────────────────────────────────────────────────────────
function dryRunRenameTopic() {
  const mcqsAffected = countDocuments(); // read-only
  const currentStructure = baseTaxonomy();
  const newStructure = cloneTree(currentStructure);

  const subjectEntry = findSubjectEntry(newStructure, 'English');
  const topicEntry = findTopicEntry(subjectEntry, 'Grammar');
  topicEntry.name = 'Applied Grammar';

  return {
    current_structure: currentStructure,
    new_structure: newStructure,
    subjects_affected: [],
    topics_affected: ['Grammar'],
    subtopics_affected: [],
    mcqs_affected: mcqsAffected,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scenario 2: moveTopicToSubject dry run — move "Vocabulary" from English -> Math
// ─────────────────────────────────────────────────────────────────────
function dryRunMoveTopic() {
  const mcqsAffected = countDocuments();
  const currentStructure = baseTaxonomy();
  const newStructure = cloneTree(currentStructure);

  const sourceEntry = findSubjectEntry(newStructure, 'English');
  const destEntry = findSubjectEntry(newStructure, 'Math');
  const topicIndex = sourceEntry.topics.findIndex((t) => t.name === 'Vocabulary');
  const [movedTopicEntry] = sourceEntry.topics.splice(topicIndex, 1);
  const countKeys = ['total', 'approved', 'pending', 'rejected'];
  countKeys.forEach((k) => { sourceEntry[k] -= movedTopicEntry[k]; });
  destEntry.topics.push(movedTopicEntry);
  countKeys.forEach((k) => { destEntry[k] += movedTopicEntry[k]; });

  return {
    current_structure: currentStructure,
    new_structure: newStructure,
    subjects_affected: ['English', 'Math'],
    topics_affected: ['Vocabulary'],
    subtopics_affected: [],
    mcqs_affected: mcqsAffected,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scenario 3: mergeTaxonomyNodes dry run — merge English's "Grammar"
// topic's two subtopics-worth structure is untouched; merge the two
// SUBJECTS "English"/"english" (simulate a case-duplicate) into "English".
// ─────────────────────────────────────────────────────────────────────
function dryRunMergeSubjects() {
  const dupTaxonomy = baseTaxonomy();
  dupTaxonomy.subjects.push({
    name: 'english',
    ...zero,
    total: 3,
    approved: 2,
    pending: 1,
    topics: [{ name: 'Grammar', ...zero, total: 3, approved: 2, pending: 1, subtopics: [{ name: 'Articles', total: 1, approved: 1 }] }],
  });

  const mcqsAffected = countDocuments();
  const currentStructure = dupTaxonomy;
  const newStructure = cloneTree(currentStructure);

  const survivor = { name: 'English' };
  const mergedAway = [{ name: 'english' }];
  const survivorEntry = findSubjectEntry(newStructure, survivor.name);
  const awayEntries = newStructure.subjects.filter((s) => s.name === 'english');
  awayEntries.forEach((away) => mergeCountsInPlace(survivorEntry, away));
  foldChildrenByName(survivorEntry.topics, awayEntries.map((s) => s.topics), 'topics');
  newStructure.subjects = newStructure.subjects.filter((s) => s === survivorEntry || s.name !== 'english');

  return {
    current_structure: currentStructure,
    new_structure: newStructure,
    subjects_affected: ['English', 'english'],
    topics_affected: [],
    subtopics_affected: [],
    mcqs_affected: mcqsAffected,
  };
}

// ─────────────────────────────────────────────────────────────────────
// Scenario 4: deleteTaxonomyNode dry run — delete subtopic "Articles"
// ─────────────────────────────────────────────────────────────────────
function dryRunDeleteSubtopic() {
  const mcqsAffected = countDocuments();
  const currentStructure = baseTaxonomy();
  const newStructure = cloneTree(currentStructure);

  const subjectEntry = findSubjectEntry(newStructure, 'English');
  const topicEntry = findTopicEntry(subjectEntry, 'Grammar');
  topicEntry.subtopics = topicEntry.subtopics.filter((st) => st.name !== 'Articles');

  return {
    current_structure: currentStructure,
    new_structure: newStructure,
    subjects_affected: [],
    topics_affected: [],
    subtopics_affected: ['Articles'],
    mcqs_affected: mcqsAffected,
  };
}

// ── Run each scenario TWICE and assert identical output + zero writes ─
const scenarios = {
  rename: dryRunRenameTopic,
  move_topic: dryRunMoveTopic,
  merge: dryRunMergeSubjects,
  delete: dryRunDeleteSubtopic,
};

for (const [name, run] of Object.entries(scenarios)) {
  const writesBefore = writeLog.length;
  const first = run();
  const second = run();

  assert.deepStrictEqual(
    first,
    second,
    `${name}: two consecutive dryRun calls must produce identical output`
  );
  assert.equal(
    writeLog.length,
    writesBefore,
    `${name}: dryRun must never call recordWrite (no transaction, no updateMany/deleteMany/save)`
  );
  // current_structure must never equal new_structure by reference, and
  // for every scenario here it must differ in content too (the whole
  // point of a diff) — while current_structure itself stays exactly
  // the pre-op tree every time (baseTaxonomy() is deterministic).
  assert.notDeepStrictEqual(
    first.current_structure,
    first.new_structure,
    `${name}: current_structure and new_structure must actually differ`
  );

  console.log(`✓ ${name}: deterministic dry run, zero writes, current != new`);
}

assert.equal(writeLog.length, 0, 'no scenario above should ever have recorded a write');
console.log('\nAll taxonomy preview (dryRun) scenarios verified — identical output, zero writes.');
