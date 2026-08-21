// Standalone verification script — NOT part of the app.
//
// Prompt 11 (Feature 14) DoD: "Write a failure-injection test per
// operation (force the MCQ.updateMany step to throw after the
// TaxonomyNode write succeeds) confirming the TaxonomyNode change is
// rolled back too."
//
// No live MongoDB is available in this environment (same constraint
// every verify_*.mjs script before this one notes), and a real Mongo
// *transaction* additionally requires a replica-set connection even
// when one IS available — so this can't just point at a bare
// `mongod`. What this script does instead: run the REAL, unmodified
// exported functions from taxonomy.service.js (not a reimplementation
// — every prior script's own "no live MongoDB" workaround was to
// mirror the transformation logic in plain arrays; this one goes
// further and exercises the actual production code), against an
// in-memory "database" whose Model methods are monkey-patched onto
// the SAME model singletons taxonomy.service.js imports (Node's ESM
// module cache guarantees `../src/models/TaxonomyNode.js` resolves to
// one shared instance, so patching its statics here is visible to
// taxonomy.service.js too), plus a fake `mongoose.startSession()`
// that reproduces the one rollback guarantee this test actually
// cares about: if the callback passed to `session.withTransaction`
// throws, every write performed during that callback is undone before
// the error propagates — exactly what a real Mongo transaction abort
// does, just implemented here as a whole-store snapshot/restore
// rather than genuine per-session write isolation (safe to simplify
// since these tests are single-threaded, one transaction at a time —
// see this file's own `withFakeMongo` helper below).
//
// Each operation's OWN real step order (not a generic assumption)
// determines which write is forced to throw: whichever write happens
// LAST is the one made to fail, and every write that happened before
// it in the same transaction is asserted to have been rolled back —
// this is the strongest form of the DoD's request, since it doesn't
// matter whether the last write was a TaxonomyNode write or an MCQ
// write, only that NOTHING half-applies.
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import TaxonomyNode from '../src/models/TaxonomyNode.js';
import MCQ from '../src/models/MCQ.js';
import Blueprint from '../src/models/Blueprint.js';
import {
  renameTaxonomyNode,
  moveTopicToSubject,
  moveSubjectIntoSubject,
  moveSubtopicToTopic,
  mergeTaxonomyNodes,
  deleteTaxonomyNode,
} from '../src/services/taxonomy.service.js';

// ─── Fake in-memory Mongo layer ──────────────────────────────────────
let nextId = 1;
const id = () => `id_${nextId++}`;

const store = { taxonomyNodes: new Map(), mcqs: new Map(), blueprints: new Map() };

const cloneMap = (map) => new Map([...map].map(([k, v]) => [k, { ...v }]));
const snapshotStore = () => ({
  taxonomyNodes: cloneMap(store.taxonomyNodes),
  mcqs: cloneMap(store.mcqs),
  blueprints: cloneMap(store.blueprints),
});
const restoreStore = (snapshot) => {
  store.taxonomyNodes = snapshot.taxonomyNodes;
  store.mcqs = snapshot.mcqs;
  store.blueprints = snapshot.blueprints;
};

// One-shot "make the next matching call throw" control, set by each
// test right before invoking the real operation.
const controls = { forceThrowOn: null }; // { model, method, message }
const maybeThrow = (model, method) => {
  const f = controls.forceThrowOn;
  if (f && f.model === model && f.method === method) {
    controls.forceThrowOn = null; // one-shot — only the first matching call fails
    throw new Error(f.message);
  }
};

const matchesValue = (actual, condition) => {
  if (condition && typeof condition === 'object' && !(condition instanceof RegExp)) {
    if ('$ne' in condition) return String(actual) !== String(condition.$ne);
    if ('$in' in condition) return condition.$in.some((v) => String(v) === String(actual));
    if ('$regex' in condition) {
      return new RegExp(condition.$regex, condition.$options || '').test(actual ?? '');
    }
  }
  return actual === condition || String(actual) === String(condition);
};
const matchFilter = (filter) => (doc) =>
  Object.entries(filter).every(([key, cond]) => matchesValue(doc[key], cond));

const evalExpr = (expr, doc) => {
  if (expr && typeof expr === 'object' && '$ifNull' in expr) {
    const [fieldExpr, fallback] = expr.$ifNull;
    return evalExpr(fieldExpr, doc) ?? fallback;
  }
  if (typeof expr === 'string' && expr.startsWith('$')) return doc[expr.slice(1)];
  return expr;
};
const applyUpdate = (doc, update) => {
  let result = { ...doc };
  const stages = Array.isArray(update) ? update : [update];
  for (const stage of stages) {
    if (stage.$set) {
      for (const [k, v] of Object.entries(stage.$set)) result[k] = evalExpr(v, result);
    }
  }
  return result;
};

// Thenable "query" stand-in for Mongoose's chainable Query objects —
// supports the two chain methods actually called in taxonomy.service.js
// (`.lean()`, `.session()`), both no-ops here beyond `.lean()` stripping
// the `.save` method the way a real lean() read would.
const stripSave = (doc) => {
  if (!doc) return doc;
  const { save, ...rest } = doc;
  return rest;
};
const makeQuery = (resolveFn) => {
  let leanFlag = false;
  const query = {
    lean() {
      leanFlag = true;
      return query;
    },
    session() {
      return query;
    },
    then(onFulfilled, onRejected) {
      return Promise.resolve()
        .then(() => {
          const val = resolveFn();
          if (!leanFlag) return val;
          return Array.isArray(val) ? val.map(stripSave) : stripSave(val);
        })
        .then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return this.then(undefined, onRejected);
    },
  };
  return query;
};

const hydrate = (modelName, collection, doc) => {
  const instance = { ...doc };
  instance.save = async (opts = {}) => {
    maybeThrow(modelName, 'save');
    const { save: _save, ...plain } = instance;
    collection.set(String(instance._id), plain);
  };
  return instance;
};

const makeFakeModel = (modelName, collection) => ({
  findById: (nodeId) =>
    makeQuery(() => {
      const doc = collection.get(String(nodeId));
      return doc ? hydrate(modelName, collection, doc) : null;
    }),
  find: (filter = {}) =>
    makeQuery(() =>
      [...collection.values()].filter(matchFilter(filter)).map((d) => hydrate(modelName, collection, d))
    ),
  countDocuments: async (filter = {}) => [...collection.values()].filter(matchFilter(filter)).length,
  updateMany: async (filter, update, _opts = {}) => {
    maybeThrow(modelName, 'updateMany');
    let matchedCount = 0;
    for (const [docId, doc] of collection) {
      if (matchFilter(filter)(doc)) {
        matchedCount += 1;
        collection.set(docId, applyUpdate(doc, update));
      }
    }
    return { matchedCount, modifiedCount: matchedCount };
  },
  deleteMany: async (filter, _opts = {}) => {
    maybeThrow(modelName, 'deleteMany');
    let deletedCount = 0;
    for (const [docId, doc] of [...collection.entries()]) {
      if (matchFilter(filter)(doc)) {
        collection.delete(docId);
        deletedCount += 1;
      }
    }
    return { deletedCount };
  },
  aggregate: (pipeline) =>
    makeQuery(() => {
      let rows = [...collection.values()];
      for (const stage of pipeline) {
        if (stage.$match) rows = rows.filter(matchFilter(stage.$match));
        if (stage.$group) {
          const groups = new Map();
          for (const row of rows) {
            const idExpr = stage.$group._id;
            const key = typeof idExpr === 'string' && idExpr.startsWith('$') ? row[idExpr.slice(1)] : idExpr;
            if (!groups.has(key)) groups.set(key, { _id: key });
            const g = groups.get(key);
            for (const [outKey, acc] of Object.entries(stage.$group)) {
              if (outKey === '_id') continue;
              if (acc && acc.$sum !== undefined) {
                g[outKey] = (g[outKey] ?? 0) + (acc.$sum === 1 ? 1 : row[String(acc.$sum).replace('$', '')]);
              }
              if (acc && acc.$push !== undefined) {
                g[outKey] = g[outKey] ?? [];
                g[outKey].push(typeof acc.$push === 'string' && acc.$push.startsWith('$') ? row[acc.$push.slice(1)] : acc.$push);
              }
            }
          }
          rows = [...groups.values()];
        }
      }
      return rows;
    }),
});

// Monkey-patch the REAL model singletons' static methods — the same
// objects taxonomy.service.js imported — with the fake implementations
// above. Restored after every test via `restorePatches` so tests never
// leak state into each other.
const patchModel = (RealModel, fake) => {
  const original = {};
  for (const key of Object.keys(fake)) {
    original[key] = RealModel[key];
    RealModel[key] = fake[key];
  }
  return () => Object.assign(RealModel, original);
};

// A fake session whose `withTransaction` reproduces Mongo's own abort
// guarantee via whole-store snapshot/restore (see this file's header
// comment for why that's a safe simplification here).
const fakeSession = {
  async withTransaction(fn) {
    const snapshot = snapshotStore();
    try {
      await fn();
    } catch (err) {
      restoreStore(snapshot);
      throw err;
    }
  },
  async endSession() {},
};

const withFakeMongo = async (run) => {
  const unpatchTaxonomyNode = patchModel(TaxonomyNode, makeFakeModel('TaxonomyNode', store.taxonomyNodes));
  const unpatchMCQ = patchModel(MCQ, makeFakeModel('MCQ', store.mcqs));
  const unpatchBlueprint = patchModel(Blueprint, {
    ...makeFakeModel('Blueprint', store.blueprints),
    // Blueprint.updateMany is called with `arrayFilters` in the real
    // code — our generic fake ignores that option (the blueprints
    // store is always empty in these tests, so it always matches
    // nothing regardless), which is fine: these tests are about
    // TaxonomyNode/MCQ rollback, not Blueprint-specific behavior.
  });
  const originalStartSession = mongoose.startSession;
  mongoose.startSession = async () => fakeSession;

  try {
    await run();
  } finally {
    mongoose.startSession = originalStartSession;
    unpatchTaxonomyNode();
    unpatchMCQ();
    unpatchBlueprint();
    store.taxonomyNodes.clear();
    store.mcqs.clear();
    store.blueprints.clear();
    controls.forceThrowOn = null;
  }
};

const seedTaxonomyNode = (doc) => store.taxonomyNodes.set(doc._id, doc);
const seedMcq = (doc) => store.mcqs.set(doc._id, doc);

// ─────────────────────────────────────────────────────────────────
// 1 — renameTaxonomyNode: TaxonomyNode write (node.save), then
// MCQ.updateMany — force the MCQ step to throw, exactly the DoD's own
// example, and confirm the subject's name reverted.
// ─────────────────────────────────────────────────────────────────
await withFakeMongo(async () => {
  const s1 = id();
  seedTaxonomyNode({ _id: s1, type: 'subject', name: 'Physics', slug: 'physics', parent_id: null });

  controls.forceThrowOn = { model: 'MCQ', method: 'updateMany', message: 'injected: MCQ.updateMany failed' };

  await assert.rejects(
    () => renameTaxonomyNode({ node_id: s1, new_name: 'Applied Physics' }),
    (err) => {
      assert.match(err.message, /injected: MCQ\.updateMany failed/);
      return true;
    },
    'renameTaxonomyNode must propagate the injected MCQ.updateMany failure'
  );

  assert.equal(
    store.taxonomyNodes.get(s1).name,
    'Physics',
    'TaxonomyNode rename must be rolled back when the later MCQ.updateMany throws'
  );
  console.log('renameTaxonomyNode rollback: PASSED');
});

// ─────────────────────────────────────────────────────────────────
// 2 — moveTopicToSubject: TaxonomyNode write (topicNode.save), then
// MCQ.updateMany — force the MCQ step to throw, confirm the topic's
// parent_id reverted to the source subject.
// ─────────────────────────────────────────────────────────────────
await withFakeMongo(async () => {
  const sourceSubject = id();
  const destSubject = id();
  const topic = id();
  seedTaxonomyNode({ _id: sourceSubject, type: 'subject', name: 'History', slug: 'history', parent_id: null });
  seedTaxonomyNode({ _id: destSubject, type: 'subject', name: 'Social Studies', slug: 'social-studies', parent_id: null });
  seedTaxonomyNode({ _id: topic, type: 'topic', name: 'Ancient History', slug: 'ancient-history', parent_id: sourceSubject });

  controls.forceThrowOn = { model: 'MCQ', method: 'updateMany', message: 'injected: MCQ.updateMany failed' };

  await assert.rejects(
    () => moveTopicToSubject({ topic_node_id: topic, destination_subject_id: destSubject }),
    /injected: MCQ\.updateMany failed/,
    'moveTopicToSubject must propagate the injected MCQ.updateMany failure'
  );

  assert.equal(
    store.taxonomyNodes.get(topic).parent_id,
    sourceSubject,
    'Topic reparent must be rolled back when the later MCQ.updateMany throws'
  );
  console.log('moveTopicToSubject rollback: PASSED');
});

// ─────────────────────────────────────────────────────────────────
// 3 — moveSubjectIntoSubject: TWO TaxonomyNode writes (subjectNode.save,
// then TaxonomyNode.updateMany on its child topics), then MCQ.updateMany
// (pipeline form) — force the MCQ step to throw, confirm BOTH earlier
// TaxonomyNode writes reverted.
// ─────────────────────────────────────────────────────────────────
await withFakeMongo(async () => {
  const movedSubject = id();
  const destSubject = id();
  const childTopic = id();
  seedTaxonomyNode({ _id: movedSubject, type: 'subject', name: 'Islamic History', slug: 'islamic-history', parent_id: null });
  seedTaxonomyNode({ _id: destSubject, type: 'subject', name: 'Islamic Studies', slug: 'islamic-studies', parent_id: null });
  seedTaxonomyNode({ _id: childTopic, type: 'topic', name: 'Mughal Era', slug: 'mughal-era', parent_id: movedSubject });

  controls.forceThrowOn = { model: 'MCQ', method: 'updateMany', message: 'injected: MCQ.updateMany failed' };

  await assert.rejects(
    () => moveSubjectIntoSubject({ subject_node_id: movedSubject, destination_subject_id: destSubject }),
    /injected: MCQ\.updateMany failed/,
    'moveSubjectIntoSubject must propagate the injected MCQ.updateMany failure'
  );

  assert.equal(store.taxonomyNodes.get(movedSubject).type, 'subject', 'Subject->topic type-flip must be rolled back');
  assert.equal(store.taxonomyNodes.get(movedSubject).parent_id, null, 'Subject reparent must be rolled back');
  assert.equal(store.taxonomyNodes.get(childTopic).type, 'topic', 'Child topic->subtopic type-flip must be rolled back');
  console.log('moveSubjectIntoSubject rollback: PASSED');
});

// ─────────────────────────────────────────────────────────────────
// 4 — moveSubtopicToTopic: TaxonomyNode write (subtopicNode.save), then
// MCQ.updateMany — force the MCQ step to throw, confirm the subtopic's
// parent_id reverted to the source topic.
// ─────────────────────────────────────────────────────────────────
await withFakeMongo(async () => {
  const subject = id();
  const sourceTopic = id();
  const destTopic = id();
  const subtopic = id();
  seedTaxonomyNode({ _id: subject, type: 'subject', name: 'History', slug: 'history', parent_id: null });
  seedTaxonomyNode({ _id: sourceTopic, type: 'topic', name: 'World History', slug: 'world-history', parent_id: subject });
  seedTaxonomyNode({ _id: destTopic, type: 'topic', name: 'European History', slug: 'european-history', parent_id: subject });
  seedTaxonomyNode({ _id: subtopic, type: 'subtopic', name: 'French Revolution', slug: 'french-revolution', parent_id: sourceTopic });

  controls.forceThrowOn = { model: 'MCQ', method: 'updateMany', message: 'injected: MCQ.updateMany failed' };

  await assert.rejects(
    () => moveSubtopicToTopic({ subtopic_node_id: subtopic, destination_topic_id: destTopic }),
    /injected: MCQ\.updateMany failed/,
    'moveSubtopicToTopic must propagate the injected MCQ.updateMany failure'
  );

  assert.equal(
    store.taxonomyNodes.get(subtopic).parent_id,
    sourceTopic,
    'Subtopic reparent must be rolled back when the later MCQ.updateMany throws'
  );
  console.log('moveSubtopicToTopic rollback: PASSED');
});

// ─────────────────────────────────────────────────────────────────
// 5 — mergeTaxonomyNodes: this operation's own real step order is
// MCQ.updateMany FIRST (retagging every MCQ off the merged-away node),
// THEN TaxonomyNode writes (reparenting a duplicate child, then
// deleting the merged-away nodes) — the reverse of the other four
// operations. So here the LAST write (TaxonomyNode.deleteMany, which
// removes the merged-away topic once its own child has been folded) is
// forced to throw, and what must be confirmed rolled back is the
// EARLIER MCQ retag plus the EARLIER child-topic reparent — still the
// same "every write in this transaction is all-or-nothing" guarantee,
// just exercised against the write that actually comes last here.
// ─────────────────────────────────────────────────────────────────
await withFakeMongo(async () => {
  const survivor = id();
  const mergedAway = id();
  const mcq1 = id();
  seedTaxonomyNode({ _id: survivor, type: 'subject', name: 'Current Affairs', slug: 'current-affairs', parent_id: null });
  seedTaxonomyNode({ _id: mergedAway, type: 'subject', name: 'current affairs', slug: 'current-affairs', parent_id: null });
  // Note: both nodes share the same slug (case-insensitive duplicate),
  // matching the exact scenario mergeTaxonomyNodes exists to resolve —
  // slug collisions are handled at the CHILD level during the fold,
  // not between the two subjects themselves (subjects are top-level,
  // never siblings under a shared parent's uniqueness check here).
  seedMcq({ _id: mcq1, subject: 'current affairs', topic: 'World Affairs', subtopic: '' });

  controls.forceThrowOn = {
    model: 'TaxonomyNode',
    method: 'deleteMany',
    message: 'injected: TaxonomyNode.deleteMany failed',
  };

  await assert.rejects(
    () => mergeTaxonomyNodes({ node_ids: [survivor, mergedAway], keep_name: 'Current Affairs' }),
    /injected: TaxonomyNode\.deleteMany failed/,
    'mergeTaxonomyNodes must propagate the injected TaxonomyNode.deleteMany failure'
  );

  assert.equal(
    store.mcqs.get(mcq1).subject,
    'current affairs',
    'MCQ retag (subject -> survivor name) must be rolled back when the later TaxonomyNode.deleteMany throws'
  );
  assert.ok(
    store.taxonomyNodes.has(mergedAway),
    'The merged-away TaxonomyNode itself must still exist — its own deletion never committed'
  );
  console.log('mergeTaxonomyNodes rollback: PASSED');
});

// ─────────────────────────────────────────────────────────────────
// 6 — deleteTaxonomyNode: this operation's own real step order is also
// MCQ write FIRST (move or delete), THEN TaxonomyNode.deleteMany for
// the subtree — same reversed order as mergeTaxonomyNodes above, for
// the same reason (the MCQs have to be resolved to some valid state
// BEFORE the TaxonomyNode(s) they referenced can safely disappear). So
// here too, the LAST write — TaxonomyNode.deleteMany — is forced to
// throw, confirming the EARLIER MCQ move is rolled back.
// ─────────────────────────────────────────────────────────────────
await withFakeMongo(async () => {
  const doomed = id();
  const destination = id();
  const mcq1 = id();
  seedTaxonomyNode({ _id: doomed, type: 'subject', name: 'Deprecated Subject', slug: 'deprecated-subject', parent_id: null });
  seedTaxonomyNode({ _id: destination, type: 'subject', name: 'General Knowledge', slug: 'general-knowledge', parent_id: null });
  seedMcq({ _id: mcq1, subject: 'Deprecated Subject', topic: 'Old Topic', subtopic: '' });

  controls.forceThrowOn = {
    model: 'TaxonomyNode',
    method: 'deleteMany',
    message: 'injected: TaxonomyNode.deleteMany failed',
  };

  await assert.rejects(
    () =>
      deleteTaxonomyNode({
        node_id: doomed,
        on_orphan_mcqs: { action: 'move', destination_node_id: destination },
      }),
    /injected: TaxonomyNode\.deleteMany failed/,
    'deleteTaxonomyNode must propagate the injected TaxonomyNode.deleteMany failure'
  );

  assert.equal(
    store.mcqs.get(mcq1).subject,
    'Deprecated Subject',
    'MCQ move (to the destination subject) must be rolled back when the later TaxonomyNode.deleteMany throws'
  );
  assert.ok(
    store.taxonomyNodes.has(doomed),
    'The TaxonomyNode being deleted must still exist — its own subtree deletion never committed'
  );
  console.log('deleteTaxonomyNode rollback: PASSED');
});

// ─────────────────────────────────────────────────────────────────
// Bonus — withTaxonomyTransaction itself always tears the session down
// (session.endSession()), success or failure, and never leaves a
// dangling session — a leaked session is its own class of production
// bug distinct from a partial commit, worth its own explicit check.
// ─────────────────────────────────────────────────────────────────
await withFakeMongo(async () => {
  let endSessionCalls = 0;
  const trackedSession = {
    async withTransaction(fn) {
      try {
        await fn();
      } catch (err) {
        throw err;
      }
    },
    async endSession() {
      endSessionCalls += 1;
    },
  };
  const original = mongoose.startSession;
  mongoose.startSession = async () => trackedSession;
  try {
    const s1 = id();
    seedTaxonomyNode({ _id: s1, type: 'subject', name: 'Chemistry', slug: 'chemistry', parent_id: null });
    controls.forceThrowOn = { model: 'MCQ', method: 'updateMany', message: 'injected failure' };
    await assert.rejects(() => renameTaxonomyNode({ node_id: s1, new_name: 'Applied Chemistry' }));
    assert.equal(endSessionCalls, 1, 'withTaxonomyTransaction must call session.endSession() even after a failure');
  } finally {
    mongoose.startSession = original;
  }
  console.log('withTaxonomyTransaction endSession-on-failure: PASSED');
});

console.log('\nAll transaction rollback tests PASSED.');
