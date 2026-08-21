// Standalone verification script — NOT part of the app.
//
// Prompt 12 (Feature 18)'s own DoD: "A table of invalid-move test
// cases (one per bullet in the spec), each producing a distinct,
// correct error message and no database write."
//
// Every check below calls the REAL, exported functions from
// server/src/utils/taxonomyValidator.js directly — not a
// reimplementation — against plain-object nodes and an injected
// `findNodeById` resolver, same "test the shared helper's own logic,
// not a manual replay of what it's supposed to do" discipline
// verify_move_subtopic_and_shared_validator.mjs (Taxonomy P7) already
// established for `validateTaxonomyMove`.
//
// "No database write" is proven by a `writeAttempted` flag: every
// scenario below wraps its call to the validator in the exact same
// shape a real taxonomy.service.js mutation uses — validate, THEN
// write — with the "write" step replaced by a spy that flips
// `writeAttempted = true` if it's ever reached. Since every scenario
// here is an INVALID move, the validator must throw before that spy
// ever runs; if it didn't (a regression), the assertion at the bottom
// of each block fails loudly instead of the table silently reporting
// a false pass.
import assert from 'node:assert/strict';
import {
  validateTaxonomyMove,
  resolveParentChain,
} from '../src/utils/taxonomyValidator.js';

let nextId = 1;
const id = () => `id_${nextId++}`;
const slugify = (s) => s.toLowerCase().trim().replace(/\s+/g, '-');
const mkNode = (type, name, parent_id = null) => ({
  _id: id(),
  type,
  name,
  slug: slugify(name),
  parent_id,
});

// Runs `fn` (an async validator call) exactly the way a real
// taxonomy.service.js mutation would gate a write behind it: if `fn`
// resolves without throwing, the "write" spy fires; if `fn` throws,
// it never does. Returns { threw, writeAttempted, error }.
const runGuarded = async (fn) => {
  let writeAttempted = false;
  const write = () => {
    writeAttempted = true;
  };
  try {
    await fn();
    write(); // only reached if the validator did NOT throw
    return { threw: false, writeAttempted, error: null };
  } catch (error) {
    return { threw: true, writeAttempted, error };
  }
};

const results = [];
const record = (caseLabel, bullet, expectedPattern, { threw, writeAttempted, error }) => {
  assert.equal(threw, true, `[${caseLabel}] must throw — an invalid move must never reach the write step`);
  assert.equal(writeAttempted, false, `[${caseLabel}] must NOT attempt a write`);
  assert.ok(error.statusCode >= 400 && error.statusCode < 500, `[${caseLabel}] must be a 4xx, got ${error.statusCode}`);
  assert.match(error.message, expectedPattern, `[${caseLabel}] error message must match the expected, specific reason`);
  results.push({
    bullet,
    case: caseLabel,
    status: error.statusCode,
    message: error.message,
    write_attempted: writeAttempted,
  });
  console.log(`${caseLabel}: PASSED — ${error.statusCode} "${error.message}"`);
};

// ═══════════════════════════════════════════════════════════════════
// Bullet 1 — Node into itself, or into its own descendant (circular)
// ═══════════════════════════════════════════════════════════════════

// 1a. Self-move: moving a node into itself.
{
  const subject = mkNode('subject', 'Math');
  const outcome = await runGuarded(() =>
    validateTaxonomyMove({ node: subject, destinationNode: subject })
  );
  record('1a. Self-move', 1, /cannot be moved into itself/, outcome);
}

// 1b. Circular: moving a subject into a topic that is nested under it.
{
  const subject = mkNode('subject', 'Science');
  const topic = mkNode('topic', 'Physics', subject._id);
  const findNodeById = (nodeId) => (String(nodeId) === String(subject._id) ? subject : null);
  const outcome = await runGuarded(() =>
    validateTaxonomyMove({
      node: subject,
      destinationNode: topic,
      resultingType: 'topic',
      findNodeById,
    })
  );
  record('1b. Circular move', 1, /circular reference/, outcome);
}

// ═══════════════════════════════════════════════════════════════════
// Bullet 2 — Duplicate hierarchy creation (destination already has a
// same-name child)
// ═══════════════════════════════════════════════════════════════════
{
  const sourceSubject = mkNode('subject', 'History');
  const destSubject = mkNode('subject', 'Social Studies');
  const topicToMove = mkNode('topic', 'World War II', sourceSubject._id);
  const existingTopic = mkNode('topic', 'world war ii', destSubject._id); // same slug, different casing
  const outcome = await runGuarded(() =>
    validateTaxonomyMove({
      node: topicToMove,
      destinationNode: destSubject,
      resultingType: 'topic',
      destinationSiblings: [existingTopic],
    })
  );
  record('2. Duplicate hierarchy', 2, /already has a topic named "World War II"/, outcome);
}

// ═══════════════════════════════════════════════════════════════════
// Bullet 3 — Invalid nesting depth (the fixed 3-level guard)
// ═══════════════════════════════════════════════════════════════════
{
  // A subject with a topic that already has subtopics, being moved
  // into another subject — would need a 4th hierarchy level.
  const subjectToMove = mkNode('subject', 'Islamic History');
  const destSubject = mkNode('subject', 'Islamic Studies');
  const outcome = await runGuarded(() =>
    validateTaxonomyMove({
      node: subjectToMove,
      destinationNode: destSubject,
      resultingType: 'topic',
      maxDepthBelowNode: 2, // subjectToMove's own topics already have subtopics
    })
  );
  record('3. Invalid nesting depth', 3, /4 hierarchy levels, but only 3/, outcome);
}

// ═══════════════════════════════════════════════════════════════════
// Bullet 4 — Broken parent chain (parent_id -> non-existent or
// wrong-type node)
// ═══════════════════════════════════════════════════════════════════

// 4a. parent_id points at an id that doesn't resolve to anything.
{
  const danglingId = id();
  const topic = mkNode('topic', 'Orphaned Topic', danglingId);
  const findNodeById = () => null;
  const outcome = await runGuarded(() => resolveParentChain(topic, { findNodeById }));
  record('4a. Dangling parent_id', 4, /parent .* does not exist/, outcome);
}

// 4b. parent_id resolves to a real node, but of the WRONG type
// (a topic pointing at another topic instead of a subject).
{
  const wrongTypeParent = mkNode('topic', 'Not A Subject');
  const topic = mkNode('topic', 'Mislabeled Topic', wrongTypeParent._id);
  const findNodeById = (nodeId) =>
    String(nodeId) === String(wrongTypeParent._id) ? wrongTypeParent : null;
  const outcome = await runGuarded(() => resolveParentChain(topic, { findNodeById }));
  record('4b. Wrong-type parent', 4, /is a topic, expected a subject/, outcome);
}

// 4c. parent_id is missing entirely on a node that requires one.
{
  const subtopic = mkNode('subtopic', 'Missing-Parent Subtopic', null);
  const outcome = await runGuarded(() => resolveParentChain(subtopic, { findNodeById: () => null }));
  record('4c. Missing parent_id', 4, /parent_id is missing — expected a topic/, outcome);
}

// ═══════════════════════════════════════════════════════════════════
// Summary table
// ═══════════════════════════════════════════════════════════════════
console.log('\n─── Invalid-move test case table (Prompt 12 DoD) ───');
console.table(
  results.map((r) => ({
    Bullet: r.bullet,
    Case: r.case,
    Status: r.status,
    'Write attempted?': r.write_attempted,
    Message: r.message.length > 90 ? `${r.message.slice(0, 87)}...` : r.message,
  }))
);

// Every bullet 1-4 must be represented, and every case's message must
// be DISTINCT from every other case's — a generic "invalid move"
// reused across cases would defeat the whole point of this guardrail
// (per this prompt's own framing: "not a generic 'invalid move'").
const bulletsCovered = new Set(results.map((r) => r.bullet));
assert.deepEqual([...bulletsCovered].sort(), [1, 2, 3, 4], 'all four spec bullets must be covered');

const messages = results.map((r) => r.message);
assert.equal(new Set(messages).size, messages.length, 'every test case must produce a DISTINCT error message');

assert.ok(
  results.every((r) => r.write_attempted === false),
  'no test case may have reached the write step'
);

console.log(
  '\n✅ PASS — all 4 spec bullets covered, every case has a distinct, specific 4xx error, and none reached a write.'
);
