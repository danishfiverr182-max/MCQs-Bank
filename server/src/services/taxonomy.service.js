import mongoose from 'mongoose';
import MCQ from '../models/MCQ.js';
import TaxonomyNode from '../models/TaxonomyNode.js';
import Blueprint from '../models/Blueprint.js';
import ApiError from '../utils/ApiError.js';
import { logger } from '../utils/logger.js';
import { createLog } from './activityLog.service.js';
import { getTaxonomy, invalidateTaxonomyCache } from './mcq.service.js';
// Shared validation guardrails (Prompt 12 — Feature 18) — see the
// "Shared taxonomy validation guardrails" comment further below, right
// where these used to be defined inline, for the full rationale.
import {
  validateTaxonomyMove,
  resolveParentChain,
  validateMergeNodeIds,
  validateMergeSameType,
  validateMergeSameParent,
  validateMergeKeepName,
  validateDeleteDestination,
} from '../utils/taxonomyValidator.js';

// taxonomy.service.js — Prompt 11 (Feature 14). Every TaxonomyNode-
// mutating operation built across Prompts 4-9 (rename, the three
// reparenting movers, merge, delete) used to live inline in
// mcq.service.js, each hand-rolling its own
// `mongoose.startSession()` / `session.withTransaction()` /
// `session.endSession()` triple. That worked but meant the "does this
// operation commit or roll back atomically" guarantee was re-derived,
// by eye, six separate times — and the ActivityLog write for each one
// happened OUTSIDE that transaction entirely, via
// activityLogger.middleware.js's post-response `res.on('finish')`
// hook (see that file's own header comment). A rename could commit —
// TaxonomyNode renamed, every MCQ retagged, every referencing
// Blueprint updated — and then have its audit-trail row silently fail
// to write with nobody the wiser, or vice versa never happen at all if
// the process crashed between "response sent" and "log write ran".
//
// This file is now the ONLY place that runs a TaxonomyNode mutation.
// Every operation below goes through `withTaxonomyTransaction`, one
// shared session lifecycle that also makes the ActivityLog row for the
// action ONE MORE atomic write inside the same transaction — see that
// function's own comment for how the log write's failure semantics
// had to change to make that safe. mcq.service.js re-exports every
// function here unchanged (see its own bottom-of-file comment) so
// existing controllers/scripts that import these names from there
// keep working without modification.

// ─── Local copies of the case-insensitive MCQ match helpers ─────────
// Same regex-match trick generator.service.js / blueprint.service.js /
// mcq.service.js each keep their own local copy of (see any of their
// header comments on this) — topic/subtopic are free-text with no
// case normalization at the model level, so an exact match silently
// returns 0 rows the moment casing drifts. Duplicated here rather than
// imported from mcq.service.js for the same reason those other files
// give: this file already imports `getTaxonomy` from mcq.service.js
// below, and mcq.service.js in turn re-exports this file's operations
// (see its own bottom-of-file comment) — pulling every small helper
// across that same boundary too would make the two files' load order
// harder to reason about for something this cheap to just repeat.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const topicMatchFilter = (topicValue) => ({
  topic: { $regex: `^${escapeRegex(topicValue.trim())}$`, $options: 'i' },
});
const subtopicMatchFilter = (subtopicValue) => ({
  subtopic: { $regex: `^${escapeRegex(subtopicValue.trim())}$`, $options: 'i' },
});

// ─── withTaxonomyTransaction (Prompt 11 — Feature 14) ────────────────
// The one session lifecycle every taxonomy operation below now shares.
// `fn` receives the live `session` and runs entirely inside
// `session.withTransaction`, so every write `fn` performs — TaxonomyNode,
// MCQ, Blueprint, and (per this feature's own DoD) the ActivityLog row
// for the action — commits together or rolls back together. Whatever
// `fn` returns becomes this function's own return value; whatever `fn`
// throws propagates after the session has been torn down, exactly the
// same "abort commits nothing, rethrow so the caller's own catch block
// can translate e.g. a duplicate-key race into a clean ApiError"
// contract every individual mover already honored before this
// consolidation — see e.g. renameTaxonomyNode's own `catch` block below.
export const withTaxonomyTransaction = async (fn) => {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    // Every real (non-dryRun) taxonomy mutation commits through this one
    // function — see this file's own header comment — so this is also
    // the one place that needs to invalidate getTaxonomy()'s short-TTL
    // cache (mcq.service.js) once a commit actually lands, rather than
    // repeating that call at all 10 individual mutation call sites.
    // Dry-run previews never reach here at all (they return before
    // withTaxonomyTransaction is ever called), so a preview can never
    // itself trigger an invalidation.
    invalidateTaxonomyCache();
    return result;
  } finally {
    // Always torn down, success or failure — same "finally, not just
    // the happy path" shape every hand-rolled version already used.
    await session.endSession();
  }
};

// ─── recalculateTaxonomyCounts (Prompt 13 — Count Recalculation Engine) ─
// The ONE place that re-derives a TaxonomyNode's persisted `counts`
// (total/approved/pending/rejected — see models/TaxonomyNode.js) from
// live MCQ data and writes it back. Every mutation below (P4-P9) used
// to either not persist counts at all (moveTopicToSubject/
// moveSubtopicToTopic's own "not persisted anywhere, TaxonomyNode has
// no count field" comments) or recompute just enough for its own
// response payload — meaning a subtopic count change never corrected
// its parent topic's or grandparent subject's stored rollups, and six
// call sites each re-derived (or skipped) that math independently.
// This function is now the only place that math happens.
//
// `nodeIds` is a single id or an array of ids — the node(s) a mutation
// just directly touched (a renamed node, a moved node, a merge
// survivor, an ancestor that lost/gained a subtree). For EACH one,
// this walks up to its subject (topic -> subject; subtopic -> topic ->
// subject), collecting every node encountered along the way, then
// recomputes and persists every one of those nodes' counts — so a
// caller never has to remember to separately pass "and its parent, and
// ITS parent too": passing the leaf-most affected node is enough.
// Passing multiple ids (e.g. both the moved node and the subtree it
// moved OUT of) is how a caller covers two disjoint branches of the
// tree in one call; nodes reachable from more than one starting id are
// still only recomputed once each, since `toRecalculate` is keyed by
// node id.
//
// `session` is a REQUIRED, already-open transaction session, not
// something this function opens itself (unlike withTaxonomyTransaction
// above) — see this prompt's own DoD: every call site below invokes
// this as the LAST step inside its existing transaction, so the count
// write commits or rolls back atomically with the structural/MCQ
// changes that made it necessary, exactly like the ActivityLog write
// Prompt 11 folded into the same transactions.
//
// Deliberately does NOT touch descendants — only `nodeIds` themselves
// and their ancestors up to subject, per this prompt's own spec. A
// node's own count is a function of MCQ rows matching its own
// (subject, topic, subtopic) triple, which never changes just because
// some OTHER node's count changed; only the node whose own matching
// MCQs actually moved needs recomputing, plus everything that rolls
// its total up from there.
export const recalculateTaxonomyCounts = async (nodeIds, session) => {
  const ids = [...new Set((Array.isArray(nodeIds) ? nodeIds : [nodeIds]).map((id) => String(id)))];

  // node id (string) -> { node, ancestorNames }. ancestorNames is
  // exactly the shape mcqFilterForLevel (defined further below, for
  // P8's merge — reused here rather than duplicated) expects: {} for a
  // subject, {subject} for a topic, {subject, topic} for a subtopic.
  const toRecalculate = new Map();

  for (const id of ids) {
    const node = await TaxonomyNode.findById(id).session(session);
    // Already deleted (e.g. a caller passed a merged-away/deleted id
    // alongside real survivors) — nothing left to recompute for it.
    if (!node) continue;

    if (node.type === 'subject') {
      toRecalculate.set(String(node._id), { node, ancestorNames: {} });
      continue;
    }

    const parent = await TaxonomyNode.findById(node.parent_id).session(session);
    if (!parent) continue; // broken parent chain — nothing safe to recompute against

    if (node.type === 'topic') {
      toRecalculate.set(String(node._id), { node, ancestorNames: { subject: parent.name } });
      toRecalculate.set(String(parent._id), { node: parent, ancestorNames: {} });
      continue;
    }

    // subtopic: parent is its topic, grandparent is the subject.
    const grandparent = await TaxonomyNode.findById(parent.parent_id).session(session);
    if (!grandparent) continue;

    toRecalculate.set(String(node._id), {
      node,
      ancestorNames: { subject: grandparent.name, topic: parent.name },
    });
    toRecalculate.set(String(parent._id), { node: parent, ancestorNames: { subject: grandparent.name } });
    toRecalculate.set(String(grandparent._id), { node: grandparent, ancestorNames: {} });
  }

  const zeroCounts = { total: 0, approved: 0, pending: 0, rejected: 0 };
  const results = [];

  for (const { node, ancestorNames } of toRecalculate.values()) {
    const filter = mcqFilterForLevel(node.type, ancestorNames, node.name);
    const [row] = await MCQ.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
        },
      },
    ]).session(session);

    const counts = row
      ? { total: row.total, approved: row.approved, pending: row.pending, rejected: row.rejected }
      : { ...zeroCounts };

    await TaxonomyNode.updateOne({ _id: node._id }, { $set: { counts } }, { session });
    results.push({ node_id: String(node._id), type: node.type, name: node.name, counts });
  }

  return results;
};

// ─── Shared taxonomy validation guardrails (Taxonomy P7, consolidated
// into utils/taxonomyValidator.js by Prompt 12 — Feature 18) ──────────
// `validateTaxonomyMove` used to be defined inline, right here, and
// covered four checks every reparenting move (moveTopicToSubject — P5,
// moveSubjectIntoSubject — P6, moveSubtopicToTopic — P7) needs before
// it's safe to write anything: self-move, circular, same-name
// collision at the destination, and nesting depth. Prompt 12 moved
// that implementation — plus the merge (P8) and delete (P9) pre-checks
// that used to be hand-rolled inline in resolveMergeCandidates and
// deleteTaxonomyNode below, plus a NEW shared "broken parent chain"
// check that used to be re-derived five separate times across this
// file — into utils/taxonomyValidator.js. See that file's own header
// comment for the full rationale and the exact spec-case ->
// implementation mapping.
//
// Re-exported here (unchanged call shape) so every existing importer
// of `validateTaxonomyMove` from THIS file — including
// mcq.service.js's own backward-compatibility re-export, which
// verify_move_subtopic_and_shared_validator.mjs imports through — keeps
// working without modification.
export {
  validateTaxonomyMove,
  validateNotSelfOrDescendant,
  validateNoDuplicateHierarchy,
  validateNestingDepth,
  resolveParentChain,
  validateMergeNodeIds,
  validateMergeSameType,
  validateMergeSameParent,
  validateMergeKeepName,
  validateDeleteDestination,
} from '../utils/taxonomyValidator.js';

// How many extra levels of real descendants hang below `node` today —
// 0 (leaf), 1 (has children but they're leaves), or 2 (has children
// that themselves have children). Feeds `maxDepthBelowNode` above.
// Two queries regardless of tree width: this node's direct children,
// then a single count of THEIR children.
const computeMaxDepthBelow = async (node) => {
  const children = await TaxonomyNode.find({ parent_id: node._id }).lean();
  if (children.length === 0) return 0;
  const grandchildCount = await TaxonomyNode.countDocuments({
    parent_id: { $in: children.map((c) => c._id) },
  });
  return grandchildCount > 0 ? 2 : 1;
};

// ─── Dry-run tree helpers ──────────────────────────────────────────
// Pure, DB-free helpers that project a getTaxonomy()-shaped tree
// through the same transform each operation's real transaction would
// apply — the diff a Prompt 10 preview shows an admin. Moved here
// verbatim from mcq.service.js: nothing outside the taxonomy
// operations below (e.g. reconcileTaxonomy) ever called any of these.
const cloneTree = (tree) => JSON.parse(JSON.stringify(tree));

const findSubjectEntry = (tree, name) => tree.subjects.find((s) => s.name === name);
const findTopicEntry = (subjectEntry, name) =>
  subjectEntry?.topics.find((t) => t.name.toLowerCase() === name.toLowerCase());
const findSubtopicEntry = (topicEntry, name) =>
  topicEntry?.subtopics.find((st) => st.name.toLowerCase() === name.toLowerCase());

// Adds `addition`'s counts onto `target` in place. Subtopic rows only
// carry total/approved (see getTaxonomy()'s own comment on that
// shape); subject/topic rows also carry pending/rejected.
const mergeCountsInPlace = (target, addition) => {
  target.total += addition.total ?? 0;
  target.approved += addition.approved ?? 0;
  if ('pending' in target) target.pending += addition.pending ?? 0;
  if ('rejected' in target) target.rejected += addition.rejected ?? 0;
};

// Folds every child list in `awayChildrenLists` onto `survivorChildren`
// by name (case-insensitive) — a name that already exists among the
// survivor's children has its counts merged in (and, one level down,
// its own children folded too); a name that doesn't is simply appended.
// Mirrors mergeGroupIntoSurvivor's (Taxonomy P8) real recursive fold,
// just over plain display objects instead of TaxonomyNode documents.
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

// Dry-run-only mirror of mergeTaxonomyNodes' real transaction — applies
// the fold-into-survivor transform to `tree` (a getTaxonomy()-shaped
// clone) in place. `ancestorNames` disambiguates WHICH subject (topic
// merges) or subject+topic (subtopic merges) the group lives under, per
// resolveMergeCandidates' own "all merged nodes share one parent" rule.
const mergeIntoSurvivorInPlace = (tree, { type, survivor, mergedAway, ancestorNames }) => {
  const mergedAwayNames = new Set(mergedAway.map((n) => n.name));

  if (type === 'subject') {
    const survivorEntry = findSubjectEntry(tree, survivor.name);
    const awayEntries = tree.subjects.filter((s) => mergedAwayNames.has(s.name));
    if (survivorEntry) {
      awayEntries.forEach((away) => mergeCountsInPlace(survivorEntry, away));
      foldChildrenByName(
        survivorEntry.topics,
        awayEntries.map((s) => s.topics),
        'topics'
      );
    }
    tree.subjects = tree.subjects.filter((s) => s === survivorEntry || !mergedAwayNames.has(s.name));
    return;
  }

  const subjectEntry = findSubjectEntry(tree, ancestorNames.subject);
  if (!subjectEntry) return;

  if (type === 'topic') {
    const survivorEntry = findTopicEntry(subjectEntry, survivor.name);
    const awayEntries = subjectEntry.topics.filter((t) => mergedAwayNames.has(t.name));
    if (survivorEntry) {
      awayEntries.forEach((away) => mergeCountsInPlace(survivorEntry, away));
      foldChildrenByName(
        survivorEntry.subtopics,
        awayEntries.map((t) => t.subtopics),
        'subtopics'
      );
    }
    subjectEntry.topics = subjectEntry.topics.filter(
      (t) => t === survivorEntry || !mergedAwayNames.has(t.name)
    );
    return;
  }

  // subtopic
  const topicEntry = findTopicEntry(subjectEntry, ancestorNames.topic);
  if (!topicEntry) return;
  const survivorEntry = findSubtopicEntry(topicEntry, survivor.name);
  const awayEntries = topicEntry.subtopics.filter((st) => mergedAwayNames.has(st.name));
  if (survivorEntry) {
    awayEntries.forEach((away) => mergeCountsInPlace(survivorEntry, away));
  }
  topicEntry.subtopics = topicEntry.subtopics.filter(
    (st) => st === survivorEntry || !mergedAwayNames.has(st.name)
  );
};

// Dry-run-only mirror of deleteTaxonomyNode's subtree removal, applied
// to a getTaxonomy()-shaped clone. Deliberately doesn't attempt to
// project an `on_orphan_mcqs: { action: 'move' }` destination's
// resulting counts — mcqs_affected already reports how many MCQs are
// touched; this only needs to show the deleted node disappearing.
const removeNodeFromTree = (tree, { type, name, ancestorNames }) => {
  if (type === 'subject') {
    tree.subjects = tree.subjects.filter((s) => s.name !== name);
    return;
  }
  const subjectEntry = findSubjectEntry(tree, ancestorNames.subject);
  if (!subjectEntry) return;
  if (type === 'topic') {
    subjectEntry.topics = subjectEntry.topics.filter(
      (t) => t.name.toLowerCase() !== name.toLowerCase()
    );
    return;
  }
  const topicEntry = findTopicEntry(subjectEntry, ancestorNames.topic);
  if (!topicEntry) return;
  topicEntry.subtopics = topicEntry.subtopics.filter(
    (st) => st.name.toLowerCase() !== name.toLowerCase()
  );
};

// ─── renameTaxonomyNode (Taxonomy P4) ───────────────────────────────
// Generalizes bulkReassignTopic (mcq.service.js) to every level of the
// tree, including subject. Renaming a TaxonomyNode has to keep FOUR
// places in sync in lockstep now, not three:
//   1. TaxonomyNode itself (name + derived slug)
//   2. every MCQ currently tagged with the OLD subject/topic/subtopic
//      string
//   3. every Blueprint.subjects[] entry referencing the OLD subject
//      name (subject-level renames only) — generator.service.js's
//      whole sampling pipeline keys off Blueprint.subjects[].name to
//      query MCQ, so leaving a blueprint pointing at a name that no
//      longer exists on any MCQ would make it silently match zero
//      questions on every future generation.
//   4. (Prompt 11) the ActivityLog row for this action — see
//      withTaxonomyTransaction's own header comment for why this one
//      more write now rides inside the same transaction as 1-3
//      instead of firing after the response via
//      activityLogger.middleware.js.
// GeneratedTest is deliberately NOT touched — a generated test's
// question/subject snapshot is a historical record of what was
// generated at the time (same "immutable snapshot" reasoning
// ActivityLog.js gives for actor_name), not a live reference that
// should retroactively change because a taxonomy label moved on.
//
// `actor` (the calling admin's `req.user`) is optional — callers that
// invoke this directly (seed/verify scripts) simply get no ActivityLog
// row, same as createLog's own "missing actor" branch outside a
// transaction; only HTTP callers (mcq.controller.js) pass one.
export const renameTaxonomyNode = async ({
  node_id: nodeId,
  new_name: rawNewName,
  dryRun = false,
  actor = null,
}) => {
  const newName = rawNewName.trim();

  const node = await TaxonomyNode.findById(nodeId);
  if (!node) {
    throw ApiError.notFound(`TaxonomyNode ${nodeId} not found`);
  }

  // A subject may never be '' — MCQ.subject is `required` (see MCQ.js)
  // and every subject is picker-driven, never free-typed. Topic/
  // subtopic have no such restriction: '' is their own real "(none)"
  // bucket (see TaxonomyNode.js's own comment on this).
  if (node.type === 'subject' && newName === '') {
    throw ApiError.badRequest('A subject name cannot be empty');
  }

  const oldName = node.name;
  if (newName === oldName) {
    throw ApiError.badRequest('new_name is identical to the current name — nothing to rename');
  }

  // ── Resolve the node's ancestor chain (for topic/subtopic), via the
  // shared "broken parent chain" guardrail (Prompt 12 — Feature 18) ──
  // Needed both to build the exact MCQ match filter (subject is always
  // matched exactly) and, for a subtopic rename, to scope the sibling-
  // collision check and MCQ update to the right parent topic.
  // `resolveParentChain` throws a SPECIFIC error (naming exactly which
  // hop is missing/dangling/wrong-type) rather than the generic
  // "TaxonomyNode X has a broken parent chain" this used to hand-roll
  // here — see utils/taxonomyValidator.js for every other place this
  // same check used to be re-derived.
  const ancestors = await resolveParentChain(node);
  const subjectNode = node.type === 'subject' ? node : ancestors.subject;
  const topicNode = node.type === 'subtopic' ? ancestors.topic : null;

  // ── Full before/after path (Prompt 14) ─────────────────────────────
  // "Subject > Topic > Subtopic"-shaped, computed once here so both the
  // success-path ActivityLog row below and the catch block's
  // success:false row (written if this transaction ends up aborting)
  // use the exact same reconstructable before/after values.
  const oldLocationParts =
    node.type === 'subject'
      ? [oldName]
      : node.type === 'topic'
      ? [subjectNode.name, oldName]
      : [subjectNode.name, topicNode.name, oldName];
  const newLocationParts =
    node.type === 'subject'
      ? [newName]
      : node.type === 'topic'
      ? [subjectNode.name, newName]
      : [subjectNode.name, topicNode.name, newName];
  const oldLocationPath = oldLocationParts.join(' > ');
  const newLocationPath = newLocationParts.join(' > ');

  // ── 1. Sibling-collision pre-check ─────────────────────────────────
  // Case-insensitive for topic/subtopic, exact for subject — same
  // split bulkReassignTopic's own header comment draws (subject is
  // picker-driven and matched exactly everywhere; topic/subtopic are
  // free-typed and always compared case-insensitively to paper over
  // casing drift). This is a friendly pre-check for a clear 409
  // message; TaxonomyNode's own {type, parent_id, slug} unique index
  // is the DB-level backstop if a race slips past it (caught below).
  const siblings = await TaxonomyNode.find({
    type: node.type,
    parent_id: node.parent_id,
    _id: { $ne: node._id },
  }).lean();
  const collides =
    node.type === 'subject'
      ? siblings.some((s) => s.name === newName)
      : siblings.some((s) => s.name.toLowerCase() === newName.toLowerCase());
  if (collides) {
    throw ApiError.conflict(
      `A ${node.type} named "${newName}" already exists ${node.type === 'subject' ? '' : 'under this parent '}— pick a different name`
    );
  }

  // ── Build the exact-string MCQ match filter for the OLD value ──────
  // Subject: exact match always. Topic/subtopic: case-insensitive
  // regex match, same as bulkReassignTopic, so a stray casing variant
  // already drifted onto some MCQ still gets swept up by this rename.
  let mcqFilter;
  let mcqUpdate;
  if (node.type === 'subject') {
    mcqFilter = { subject: oldName };
    mcqUpdate = { subject: newName };
  } else if (node.type === 'topic') {
    mcqFilter = { subject: subjectNode.name, ...topicMatchFilter(oldName) };
    mcqUpdate = { topic: newName };
  } else {
    mcqFilter = {
      subject: subjectNode.name,
      ...topicMatchFilter(topicNode.name),
      ...subtopicMatchFilter(oldName),
    };
    mcqUpdate = { subtopic: newName };
  }

  // ── Dry run (Prompt 10 — Feature 13) ───────────────────────────────
  // Every validation above has already run and thrown on anything that
  // would make the real rename fail — a dry run reaching this point is
  // exactly as safe to "apply" as a real call would be.
  if (dryRun) {
    const mcqsAffected = await MCQ.countDocuments(mcqFilter);
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);

    const subjectsAffected = [];
    const topicsAffected = [];
    const subtopicsAffected = [];

    if (node.type === 'subject') {
      const subjectEntry = findSubjectEntry(newStructure, oldName);
      if (subjectEntry) subjectEntry.name = newName;
      subjectsAffected.push(oldName);
    } else if (node.type === 'topic') {
      const subjectEntry = findSubjectEntry(newStructure, subjectNode.name);
      const topicEntry = findTopicEntry(subjectEntry, oldName);
      if (topicEntry) topicEntry.name = newName;
      topicsAffected.push(oldName);
    } else {
      const subjectEntry = findSubjectEntry(newStructure, subjectNode.name);
      const topicEntry = findTopicEntry(subjectEntry, topicNode.name);
      const subtopicEntry = findSubtopicEntry(topicEntry, oldName);
      if (subtopicEntry) subtopicEntry.name = newName;
      subtopicsAffected.push(oldName);
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: subjectsAffected,
      topics_affected: topicsAffected,
      subtopics_affected: subtopicsAffected,
      mcqs_affected: mcqsAffected,
    };
  }

  try {
    return await withTaxonomyTransaction(async (session) => {
      // 1. TaxonomyNode — `name` triggers the pre-validate slug-sync
      // hook (see TaxonomyNode.js); `save` (not updateOne) so that hook
      // actually runs and the unique index sees the correct slug.
      node.name = newName;
      await node.save({ session });

      // 2. Every MCQ under the OLD subject/topic/subtopic path.
      const mcqResult = await MCQ.updateMany(mcqFilter, { $set: mcqUpdate }, { session });

      // 3. Blueprint.subjects[].name — subject-level renames only.
      // arrayFilters targets just the matching embedded subject entry
      // rather than rewriting the whole subjects array; a blueprint
      // with subjects ["English", "Math"] renaming "English" ->
      // "English Language" only touches that one array element.
      let blueprintResult;
      if (node.type === 'subject') {
        blueprintResult = await Blueprint.updateMany(
          { 'subjects.name': oldName },
          { $set: { 'subjects.$[elem].name': newName } },
          { arrayFilters: [{ 'elem.name': oldName }], session }
        );
      }

      const matchedCount = mcqResult?.matchedCount ?? mcqResult?.n ?? 0;
      const modifiedCount = mcqResult?.modifiedCount ?? mcqResult?.nModified ?? 0;
      const blueprintsUpdated = blueprintResult?.modifiedCount ?? blueprintResult?.nModified ?? 0;

      // 4. Recompute + persist counts (Prompt 13) — the node's own
      // name changed but its matching MCQ set didn't, so this mostly
      // just re-stamps the same numbers; still run unconditionally
      // (rather than special-cased away) so a node that never had
      // `counts` populated gets it now, and so this call site never
      // has to be revisited if that assumption ever stops holding.
      await recalculateTaxonomyCounts([node._id], session);

      // 5. ActivityLog — the fifth write this transaction now covers
      // (Prompt 11). Only attempted when an actor was supplied; see
      // this function's own header comment on why that's optional.
      if (actor) {
        await createLog({
          actor,
          action: 'taxonomy_node_renamed',
          entityType: 'MCQ',
          entityId: null,
          summary:
            `Renamed ${node.type} "${oldName}" -> "${newName}": ${modifiedCount} MCQ(s)` +
            (node.type === 'subject' ? `, ${blueprintsUpdated} blueprint(s)` : ''),
          session,
          oldLocation: oldLocationPath,
          newLocation: newLocationPath,
          mcqsUpdated: modifiedCount,
          success: true,
        });
      }

      return {
        node_id: String(node._id),
        node_type: node.type,
        old_name: oldName,
        new_name: newName,
        matched_count: matchedCount,
        modified_count: modifiedCount,
        blueprints_updated: blueprintsUpdated,
      };
    });
  } catch (err) {
    // ── Failure ActivityLog row (Prompt 14) ──────────────────────────
    // `withTaxonomyTransaction` has already rolled everything back and
    // torn down its session by the time we get here — this write is a
    // fresh, standalone createLog call (no `session`), which is exactly
    // why it can't live inside the transaction above: a rolled-back
    // transaction cannot also contain the row recording that it rolled
    // back. Only attempted when an actor was supplied, same optionality
    // as the success-path row.
    if (actor) {
      await createLog({
        actor,
        action: 'taxonomy_node_renamed',
        entityType: 'MCQ',
        entityId: null,
        summary: `Failed to rename ${node.type} "${oldName}" -> "${newName}": ${err.message}`,
        oldLocation: oldLocationPath,
        newLocation: newLocationPath,
        mcqsUpdated: 0,
        success: false,
      });
    }

    // Duplicate key on TaxonomyNode's {type, parent_id, slug} index —
    // the race the pre-check above exists to make unlikely, not
    // impossible. Surfaced as the same 409 a clean pre-check failure
    // would give, rather than a raw Mongo error code.
    if (err?.code === 11000) {
      throw ApiError.conflict(
        `A ${node.type} named "${newName}" already exists ${node.type === 'subject' ? '' : 'under this parent '}— pick a different name`
      );
    }
    throw err;
  }
};

// ─── moveTopicToSubject (Taxonomy P5 — Feature 1) ───────────────────
// Reparents an entire topic (and every subtopic under it) from one
// subject to another — e.g. splitting "Current Affairs" out of
// "General Knowledge" into its own subject. Distinct from
// renameTaxonomyNode above: the topic's own name/slug never changes
// here, only which subject it lives under.
//
// Reparenting the topic node is the WHOLE structural move — its
// subtopic children's parent_id already points at the TOPIC node's
// own _id (see TaxonomyNode.js's tree-shape comment: "subtopic's
// parent is its TOPIC, not its subject"), not at the subject, so they
// automatically move along with it. Nothing about them needs touching.
//
// MCQ: every MCQ currently tagged with the OLD (subject, topic) pair
// gets its `subject` field updated to the destination subject's name.
// `topic`/`subtopic` are deliberately left untouched — per the DoD,
// this moves the topic, it doesn't rename it or any of its subtopics.
export const moveTopicToSubject = async ({
  topic_node_id: topicNodeId,
  destination_subject_id: destinationSubjectId,
  dryRun = false,
  actor = null,
  // Prompt 20 (Bulk Select) — when bulkMoveTopicsToSubject below is
  // moving several topics to one destination in a single transaction,
  // it calls this function once per topic and passes ITS OWN already-open
  // session through here instead of letting each call open (and
  // separately commit/rollback) its own — see the branch at the bottom
  // of this function for how that changes control flow.
  session: externalSession = null,
}) => {
  const topicNode = await TaxonomyNode.findById(topicNodeId);
  if (!topicNode || topicNode.type !== 'topic') {
    throw ApiError.notFound(`Topic node ${topicNodeId} not found`);
  }

  const destinationSubject = await TaxonomyNode.findById(destinationSubjectId);
  if (!destinationSubject || destinationSubject.type !== 'subject') {
    throw ApiError.notFound(`Subject node ${destinationSubjectId} not found`);
  }

  // Broken-parent-chain guard (Prompt 12 — Feature 18): see
  // utils/taxonomyValidator.js's resolveParentChain for the shared
  // implementation every mover now calls instead of hand-rolling this.
  const { subject: sourceSubject } = await resolveParentChain(topicNode);

  if (String(sourceSubject._id) === String(destinationSubject._id)) {
    throw ApiError.badRequest(
      `"${topicNode.name}" is already under "${destinationSubject.name}" — nothing to move`
    );
  }

  // ── Shared checks (Taxonomy P7): self-move already handled above with
  // its own friendlier "nothing to move" message; circular is a no-op
  // here (a subject can never be a topic's descendant) but still run
  // generically; same-name collision and depth are the two checks that
  // actually bite for this move.
  const destinationSiblingTopics = await TaxonomyNode.find({
    type: 'topic',
    parent_id: destinationSubject._id,
  }).lean();

  await validateTaxonomyMove({
    node: topicNode,
    destinationNode: destinationSubject,
    resultingType: 'topic',
    maxDepthBelowNode: await computeMaxDepthBelow(topicNode),
    destinationSiblings: destinationSiblingTopics,
  });

  const topicName = topicNode.name;
  const sourceSubjectName = sourceSubject.name;
  const destinationSubjectName = destinationSubject.name;
  const mcqFilter = { subject: sourceSubjectName, ...topicMatchFilter(topicName) };

  // Full before/after path (Prompt 14) — see renameTaxonomyNode's own
  // comment on why this is computed once, ahead of both the success
  // and failure ActivityLog rows below.
  const oldLocationPath = `${sourceSubjectName} > ${topicName}`;
  const newLocationPath = `${destinationSubjectName} > ${topicName}`;

  // ── Dry run (Prompt 10 — Feature 13) ───────────────────────────────
  if (dryRun) {
    const mcqsAffected = await MCQ.countDocuments(mcqFilter);
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);

    const sourceEntry = findSubjectEntry(newStructure, sourceSubjectName);
    const destEntry = findSubjectEntry(newStructure, destinationSubjectName);
    const topicIndex =
      sourceEntry?.topics.findIndex((t) => t.name.toLowerCase() === topicName.toLowerCase()) ?? -1;
    let movedTopicEntry = null;

    if (sourceEntry && topicIndex !== -1) {
      [movedTopicEntry] = sourceEntry.topics.splice(topicIndex, 1);
      const countKeys = ['total', 'approved', 'pending', 'rejected'];
      countKeys.forEach((k) => { sourceEntry[k] -= movedTopicEntry[k]; });
      if (destEntry) {
        destEntry.topics.push(movedTopicEntry);
        countKeys.forEach((k) => { destEntry[k] += movedTopicEntry[k]; });
      }
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: [sourceSubjectName, destinationSubjectName],
      topics_affected: [topicName],
      subtopics_affected: (movedTopicEntry?.subtopics ?? []).map((s) => s.name),
      mcqs_affected: mcqsAffected,
    };
  }

  // The actual transactional body, factored out so a bulk caller (see
  // `session: externalSession` above) can run it against an existing
  // session instead of this function always opening its own — same
  // steps either way, just a different session source.
  const runMove = async (session) => {
      // 1. Reparent — the topic's subtopic children need no update of
      // their own (see header comment above); this one write moves the
      // whole subtree.
      topicNode.parent_id = destinationSubject._id;
      await topicNode.save({ session });

      // 2. Every MCQ under the OLD (subject, topic) pair -> new subject.
      const mcqResult = await MCQ.updateMany(
        mcqFilter,
        { $set: { subject: destinationSubjectName } },
        { session }
      );

      // 3. Recompute the affected counts inside the same session, so
      // what's returned reflects the post-move, post-commit state
      // rather than a stale pre-move read.
      const [sourceSubjectTotal, destinationSubjectTotal, movedTopicTotal] = await Promise.all([
        MCQ.countDocuments({ subject: sourceSubjectName }, { session }),
        MCQ.countDocuments({ subject: destinationSubjectName }, { session }),
        MCQ.countDocuments({ subject: destinationSubjectName, ...topicMatchFilter(topicName) }, { session }),
      ]);

      const matchedCount = mcqResult?.matchedCount ?? mcqResult?.n ?? 0;
      const modifiedCount = mcqResult?.modifiedCount ?? mcqResult?.nModified ?? 0;

      // 4. Recompute + persist counts (Prompt 13). The topic itself
      // is passed — recalculateTaxonomyCounts walks up from its (now
      // reparented) `parent_id` to pick up the DESTINATION subject
      // automatically — plus the source subject explicitly, since
      // once the topic is reparented it's no longer reachable by
      // walking up from anything the caller passed. Replaces the old
      // "not persisted anywhere" confirmation-numbers-only math this
      // step used to be (see this function's own former comment).
      await recalculateTaxonomyCounts([topicNode._id, sourceSubject._id], session);

      // 5. ActivityLog (Prompt 11) — see renameTaxonomyNode's own
      // comment on why this rides inside the transaction now.
      if (actor) {
        await createLog({
          actor,
          action: 'taxonomy_topic_moved',
          entityType: 'MCQ',
          entityId: null,
          summary:
            `Moved topic "${topicName}" from "${sourceSubjectName}" to ` +
            `"${destinationSubjectName}": ${modifiedCount} MCQ(s)`,
          session,
          oldLocation: oldLocationPath,
          newLocation: newLocationPath,
          mcqsUpdated: modifiedCount,
          success: true,
        });
      }

      return {
        topic_node_id: String(topicNode._id),
        topic_name: topicName,
        source_subject: { id: String(sourceSubject._id), name: sourceSubjectName, total: sourceSubjectTotal },
        destination_subject: {
          id: String(destinationSubject._id),
          name: destinationSubjectName,
          total: destinationSubjectTotal,
        },
        moved_topic_total: movedTopicTotal,
        matched_count: matchedCount,
        modified_count: modifiedCount,
      };
  };

  // Bulk mode: an outer transaction (opened by bulkMoveTopicsToSubject)
  // already owns commit/rollback for every topic in the batch, so this
  // call just runs its steps against it and lets ITS caller translate
  // any error / write any failure log, once, for the whole batch —
  // writing a session-less failure row here (like the single-node path
  // below does) would log "failed" for one topic even though the
  // surrounding transaction (and therefore this topic's own attempted
  // move) may still roll back along with every other topic in the batch.
  if (externalSession) {
    return await runMove(externalSession);
  }

  try {
    return await withTaxonomyTransaction(runMove);
  } catch (err) {
    // Failure ActivityLog row (Prompt 14) — see renameTaxonomyNode's
    // own catch block comment for why this must be a fresh,
    // session-less write after the transaction above has already
    // rolled back.
    if (actor) {
      await createLog({
        actor,
        action: 'taxonomy_topic_moved',
        entityType: 'MCQ',
        entityId: null,
        summary:
          `Failed to move topic "${topicName}" from "${sourceSubjectName}" to ` +
          `"${destinationSubjectName}": ${err.message}`,
        oldLocation: oldLocationPath,
        newLocation: newLocationPath,
        mcqsUpdated: 0,
        success: false,
      });
    }

    if (err?.code === 11000) {
      // Same race the pre-check above exists to make unlikely: another
      // request created a same-named topic under the destination
      // between the check and this transaction's own reparent write.
      throw ApiError.conflict(
        `"${destinationSubjectName}" already has a topic named "${topicName}" — ` +
          `merge the two topics instead of moving, or rename one first`
      );
    }
    throw err;
  }
};

// ─── moveSubjectIntoSubject (Taxonomy P6 — Feature 2) ───────────────
// The highest-risk taxonomy mutation so far: unlike moveTopicToSubject
// above (which only ever changes a node's PARENT), this changes a
// node's TYPE — an entire subject collapses down one level to become
// a topic inside another subject, e.g. "Islamic History" (a subject
// in its own right, with its own topics) folding into "Islamic
// Studies" as one of ITS topics.
//
// Why the nesting guard is load-bearing: TaxonomyNode is a fixed
// 3-level tree — subject -> topic -> subtopic. The subject being moved
// sits at level 1, its topics at level 2, and if any of THOSE topics
// already has subtopics at level 3, this move would need to push
// subject -> topic (ex-subject, now level 2), topic -> subtopic (ex-
// topic, now level 3), and subtopic -> level 4 — which the schema has
// nowhere to put. This is caught and refused with a named list of the
// offending topic(s) rather than either failing a low-level unique-
// index write partway through, or (worse) silently truncating the
// deepest level and quietly losing data.
//
// The conversion itself, once clear:
//   1. The subject node's own `type` flips 'subject' -> 'topic' and
//      its `parent_id` is repointed at the destination subject — this
//      one node keeps its `_id` throughout, so nothing downstream
//      needs to "find the new node", it's the same node, relabeled.
//   2. Every topic that was directly under it (guaranteed subtopic-
//      free by the guard above) has ITS `type` flipped 'topic' ->
//      'subtopic'. Its `parent_id` needs no change — it already
//      pointed at the subject-turned-topic node's `_id`, and that
//      _id didn't change, only what it now represents.
//
// MCQ retagging mirrors that same type promotion, one level down, for
// every MCQ that was under the old subject:
//   subject: oldSubjectName          -> destinationSubjectName
//   topic:   <whatever it was, incl. ''>  -> oldSubjectName
//   subtopic: <whatever `topic` used to hold> (so '' stays '', and a
//             real prior topic value becomes the new subtopic)
// Done as a single aggregation-pipeline update ($set reading $topic
// before the second $set overwrites it) so each row's own prior
// `topic` value — not a constant — becomes its new `subtopic`.
export const moveSubjectIntoSubject = async ({
  subject_node_id: subjectNodeId,
  destination_subject_id: destinationSubjectId,
  dryRun = false,
  actor = null,
  // Prompt 20 (Bulk Select) — see moveTopicToSubject's own comment on
  // this same param for what it's for.
  session: externalSession = null,
}) => {
  const subjectNode = await TaxonomyNode.findById(subjectNodeId);
  if (!subjectNode || subjectNode.type !== 'subject') {
    throw ApiError.notFound(`Subject node ${subjectNodeId} not found`);
  }

  const destinationSubject = await TaxonomyNode.findById(destinationSubjectId);
  if (!destinationSubject || destinationSubject.type !== 'subject') {
    throw ApiError.notFound(`Subject node ${destinationSubjectId} not found`);
  }

  // ── Nesting guard (critical), via the shared validator (Taxonomy P7) ─
  // Every topic directly under the subject being moved, plus — for
  // each — whether it has any subtopic children (one aggregation, not
  // N round-trips), feeds `maxDepthBelowNode`. `depthViolationMessage`
  // overrides the shared validator's generic depth wording so the
  // error still names every offending topic.
  const childTopics = await TaxonomyNode.find({
    type: 'topic',
    parent_id: subjectNode._id,
  }).lean();

  let maxDepthBelowNode = 0;
  let depthViolationMessage;
  if (childTopics.length > 0) {
    const topicIds = childTopics.map((t) => t._id);
    const subtopicCountsByParent = await TaxonomyNode.aggregate([
      { $match: { type: 'subtopic', parent_id: { $in: topicIds } } },
      { $group: { _id: '$parent_id', count: { $sum: 1 } } },
    ]);
    const parentsWithSubtopics = new Set(subtopicCountsByParent.map((row) => String(row._id)));
    const offendingTopics = childTopics.filter((t) => parentsWithSubtopics.has(String(t._id)));

    maxDepthBelowNode = offendingTopics.length > 0 ? 2 : 1;
    if (offendingTopics.length > 0) {
      const names = offendingTopics.map((t) => `"${t.name}"`).join(', ');
      depthViolationMessage =
        `Cannot move "${subjectNode.name}" into "${destinationSubject.name}": ` +
        `${offendingTopics.length === 1 ? 'topic' : 'topics'} ${names} already ` +
        `${offendingTopics.length === 1 ? 'has' : 'have'} subtopics — moving "${subjectNode.name}" ` +
        `in would push ${offendingTopics.length === 1 ? 'it' : 'them'} to a 4th hierarchy level, ` +
        `which isn't supported. Flatten or remove ${offendingTopics.length === 1 ? 'its' : 'their'} ` +
        `subtopics first.`;
    }
  }

  // ── Reject if the destination already has a topic with this name ──
  // Same collision rule (and same deliberate non-auto-merge stance) as
  // moveTopicToSubject above — the subject being moved is about to
  // BECOME a topic under the destination, so it has to clear the same
  // sibling-collision bar any other topic landing there would.
  const destinationSiblingTopics = await TaxonomyNode.find({
    type: 'topic',
    parent_id: destinationSubject._id,
  }).lean();

  await validateTaxonomyMove({
    node: subjectNode,
    destinationNode: destinationSubject,
    resultingType: 'topic',
    maxDepthBelowNode,
    destinationSiblings: destinationSiblingTopics,
    depthViolationMessage,
  });

  const oldSubjectName = subjectNode.name;
  const destinationSubjectName = destinationSubject.name;

  // Full before/after path (Prompt 14). The node itself never changes
  // name — only its type/parent (see this function's own header
  // comment) — so `oldLocation` is just the old top-level subject name,
  // and `newLocation` is that same name nested one level under the
  // destination subject, reflecting the type-flip subject -> topic.
  const oldLocationPath = oldSubjectName;
  const newLocationPath = `${destinationSubjectName} > ${oldSubjectName}`;

  // ── Dry run (Prompt 10 — Feature 13) ───────────────────────────────
  if (dryRun) {
    const mcqsAffected = await MCQ.countDocuments({ subject: oldSubjectName });
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);

    const subjectIndex = newStructure.subjects.findIndex((s) => s.name === oldSubjectName);
    const destEntry = findSubjectEntry(newStructure, destinationSubjectName);

    if (subjectIndex !== -1) {
      const [movedSubjectEntry] = newStructure.subjects.splice(subjectIndex, 1);
      if (destEntry) {
        mergeCountsInPlace(destEntry, movedSubjectEntry);
        destEntry.topics.push({
          name: movedSubjectEntry.name,
          total: movedSubjectEntry.total,
          approved: movedSubjectEntry.approved,
          pending: movedSubjectEntry.pending,
          rejected: movedSubjectEntry.rejected,
          // Every former topic under it becomes a subtopic — see this
          // function's own header comment on the type-flip this move
          // performs one level down.
          subtopics: movedSubjectEntry.topics.map((t) => ({
            name: t.name,
            total: t.total,
            approved: t.approved,
          })),
        });
      }
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: [oldSubjectName, destinationSubjectName],
      topics_affected: [oldSubjectName],
      subtopics_affected: childTopics.map((t) => t.name),
      mcqs_affected: mcqsAffected,
    };
  }

  // See moveTopicToSubject's own comment on this same factoring.
  const runMove = async (session) => {
      // 1. The subject itself: 'subject' -> 'topic', reparented under
      // the destination. Same node, same _id, new type + parent.
      subjectNode.type = 'topic';
      subjectNode.parent_id = destinationSubject._id;
      await subjectNode.save({ session });

      // 2. Every topic that was directly under it -> 'subtopic'.
      // parent_id is untouched: it already pointed at subjectNode._id,
      // and that _id hasn't changed — only what it now represents has.
      if (childTopics.length > 0) {
        await TaxonomyNode.updateMany(
          { _id: { $in: childTopics.map((t) => t._id) } },
          { $set: { type: 'subtopic' } },
          { session }
        );
      }

      // 3. Every MCQ under the OLD subject. Pipeline update so each
      // row's own prior `topic` becomes its new `subtopic` (see header
      // comment above) rather than one constant value for every row.
      const mcqResult = await MCQ.updateMany(
        { subject: oldSubjectName },
        [
          { $set: { subtopic: { $ifNull: ['$topic', ''] } } },
          { $set: { subject: destinationSubjectName, topic: oldSubjectName } },
        ],
        { session }
      );

      // 4. Blueprint.subjects[] entries referencing the old subject
      // name — same concern renameTaxonomyNode's own comment gives:
      // every MCQ formerly under this name now lives under
      // destinationSubjectName, so a blueprint left pointing at the
      // old name would silently match zero questions on next
      // generation.
      const blueprintResult = await Blueprint.updateMany(
        { 'subjects.name': oldSubjectName },
        { $set: { 'subjects.$[elem].name': destinationSubjectName } },
        { arrayFilters: [{ 'elem.name': oldSubjectName }], session }
      );

      const matchedCount = mcqResult?.matchedCount ?? mcqResult?.n ?? 0;
      const modifiedCount = mcqResult?.modifiedCount ?? mcqResult?.nModified ?? 0;
      const blueprintsUpdated = blueprintResult?.modifiedCount ?? blueprintResult?.nModified ?? 0;

      // 5. Recompute + persist counts (Prompt 13). subjectNode is now
      // TYPE 'topic' — walking up from it picks up the destination
      // subject automatically. Every former child topic (now a
      // subtopic — step 2 above) is passed too, since each one's own
      // matching-MCQ filter changed shape (topic/subtopic values
      // rewritten in step 3) even though its `parent_id` didn't.
      await recalculateTaxonomyCounts(
        [subjectNode._id, ...childTopics.map((t) => t._id)],
        session
      );

      // 6. ActivityLog (Prompt 11).
      if (actor) {
        await createLog({
          actor,
          action: 'taxonomy_subject_merged_into_subject',
          entityType: 'MCQ',
          entityId: null,
          summary:
            `Moved subject "${oldSubjectName}" into "${destinationSubjectName}" as a topic: ` +
            `${modifiedCount} MCQ(s), ${childTopics.length} subtopic(s) created, ` +
            `${blueprintsUpdated} blueprint(s)`,
          session,
          oldLocation: oldLocationPath,
          newLocation: newLocationPath,
          mcqsUpdated: modifiedCount,
          success: true,
        });
      }

      return {
        subject_node_id: String(subjectNode._id),
        // The moved node's own name never changes — only its type/parent —
        // so this is both "the subject's old name" and "the new topic's
        // name" at once.
        node_name: oldSubjectName,
        converted_to: 'topic',
        destination_subject: {
          id: String(destinationSubject._id),
          name: destinationSubjectName,
        },
        subtopics_created: childTopics.length,
        matched_count: matchedCount,
        modified_count: modifiedCount,
        blueprints_updated: blueprintsUpdated,
      };
  };

  // See moveTopicToSubject's own comment on this same branch.
  if (externalSession) {
    return await runMove(externalSession);
  }

  try {
    return await withTaxonomyTransaction(runMove);
  } catch (err) {
    // Failure ActivityLog row (Prompt 14) — see renameTaxonomyNode's
    // own catch block comment.
    if (actor) {
      await createLog({
        actor,
        action: 'taxonomy_subject_merged_into_subject',
        entityType: 'MCQ',
        entityId: null,
        summary:
          `Failed to move subject "${oldSubjectName}" into "${destinationSubjectName}": ${err.message}`,
        oldLocation: oldLocationPath,
        newLocation: newLocationPath,
        mcqsUpdated: 0,
        success: false,
      });
    }

    if (err?.code === 11000) {
      // Same race the pre-check above exists to make unlikely: another
      // request created a same-named topic under the destination
      // between the check and this transaction's own write.
      throw ApiError.conflict(
        `"${destinationSubjectName}" already has a topic named "${oldSubjectName}" — ` +
          `merge the two instead of moving, or rename one first`
      );
    }
    throw err;
  }
};

// ─── moveSubtopicToTopic (Taxonomy P7 — Feature 3) ──────────────────
// The mirror of moveTopicToSubject (P5), one level down: reparents a
// single subtopic from one topic to another — e.g. pulling "French
// Revolution" out from under "World History" and into "European
// History". Same transactional shape, no type change (unlike P6's
// moveSubjectIntoSubject) — a subtopic stays a subtopic, only its
// `parent_id` moves.
//
// Unlike P5/P6, the destination topic isn't necessarily under the
// SAME subject as the source topic — "European History" could be its
// own subject, or a topic elsewhere under "World History" itself.
// Every MCQ under the OLD (subject, topic, subtopic) triple therefore
// gets BOTH `subject` and `topic` rewritten to the destination
// topic's own subject/name; `subtopic` is deliberately left
// untouched, per the DoD ("leaving subtopic unchanged").
export const moveSubtopicToTopic = async ({
  subtopic_node_id: subtopicNodeId,
  destination_topic_id: destinationTopicId,
  dryRun = false,
  actor = null,
  // Prompt 20 (Bulk Select) — see moveTopicToSubject's own comment on
  // this same param for what it's for.
  session: externalSession = null,
}) => {
  const subtopicNode = await TaxonomyNode.findById(subtopicNodeId);
  if (!subtopicNode || subtopicNode.type !== 'subtopic') {
    throw ApiError.notFound(`Subtopic node ${subtopicNodeId} not found`);
  }

  const destinationTopic = await TaxonomyNode.findById(destinationTopicId);
  if (!destinationTopic || destinationTopic.type !== 'topic') {
    throw ApiError.notFound(`Topic node ${destinationTopicId} not found`);
  }

  // Broken-parent-chain guards (Prompt 12 — Feature 18): both the
  // subtopic's own two-hop chain (-> topic -> subject) and the
  // destination topic's one-hop chain (-> subject) now go through the
  // shared resolveParentChain guardrail — see
  // utils/taxonomyValidator.js for the specific error each hop throws
  // if it's missing, dangling, or the wrong type.
  const [sourceAncestors, destinationAncestors] = await Promise.all([
    resolveParentChain(subtopicNode),
    resolveParentChain(destinationTopic),
  ]);
  const sourceTopic = sourceAncestors.topic;
  const sourceSubject = sourceAncestors.subject;
  const destinationSubject = destinationAncestors.subject;

  if (String(sourceTopic._id) === String(destinationTopic._id)) {
    throw ApiError.badRequest(
      `"${subtopicNode.name}" is already under "${destinationTopic.name}" — nothing to move`
    );
  }

  // ── Shared checks (Taxonomy P7): self-move handled above with its
  // own "nothing to move" message; circular is a no-op here (a
  // subtopic never has children of its own in this schema, so it can
  // never be an ancestor of anything) but still run generically for
  // the same future-proofing reason moveTopicToSubject now does.
  const destinationSiblingSubtopics = await TaxonomyNode.find({
    type: 'subtopic',
    parent_id: destinationTopic._id,
  }).lean();

  await validateTaxonomyMove({
    node: subtopicNode,
    destinationNode: destinationTopic,
    resultingType: 'subtopic',
    // Subtopics never have children in this schema — nothing can hang
    // below one, so there's no need to even query for it.
    maxDepthBelowNode: 0,
    destinationSiblings: destinationSiblingSubtopics,
  });

  const subtopicName = subtopicNode.name;
  const sourceTopicName = sourceTopic.name;
  const destinationTopicName = destinationTopic.name;
  const sourceSubjectName = sourceSubject.name;
  const destinationSubjectName = destinationSubject.name;

  const mcqFilter = {
    subject: sourceSubjectName,
    ...topicMatchFilter(sourceTopicName),
    ...subtopicMatchFilter(subtopicName),
  };

  // Full before/after path (Prompt 14) — see renameTaxonomyNode's own
  // comment on why this is computed once, ahead of both the success
  // and failure ActivityLog rows below.
  const oldLocationPath = `${sourceSubjectName} > ${sourceTopicName} > ${subtopicName}`;
  const newLocationPath = `${destinationSubjectName} > ${destinationTopicName} > ${subtopicName}`;

  // ── Dry run (Prompt 10 — Feature 13) ───────────────────────────────
  if (dryRun) {
    const mcqsAffected = await MCQ.countDocuments(mcqFilter);
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);

    const sourceSubjEntry = findSubjectEntry(newStructure, sourceSubjectName);
    const sourceTopicEntry = findTopicEntry(sourceSubjEntry, sourceTopicName);
    const destSubjEntry = findSubjectEntry(newStructure, destinationSubjectName);
    const destTopicEntry = findTopicEntry(destSubjEntry, destinationTopicName);

    const subtopicIndex =
      sourceTopicEntry?.subtopics.findIndex(
        (s) => s.name.toLowerCase() === subtopicName.toLowerCase()
      ) ?? -1;

    if (sourceTopicEntry && subtopicIndex !== -1) {
      const [movedSubtopicEntry] = sourceTopicEntry.subtopics.splice(subtopicIndex, 1);
      // Only total/approved are known at the subtopic level — parent
      // topic/subject pending/rejected counts are left as-is, so this
      // is an approximation for display purposes, not a live recount.
      sourceTopicEntry.total -= movedSubtopicEntry.total;
      sourceTopicEntry.approved -= movedSubtopicEntry.approved;
      if (sourceSubjEntry) {
        sourceSubjEntry.total -= movedSubtopicEntry.total;
        sourceSubjEntry.approved -= movedSubtopicEntry.approved;
      }
      if (destTopicEntry) {
        destTopicEntry.subtopics.push(movedSubtopicEntry);
        destTopicEntry.total += movedSubtopicEntry.total;
        destTopicEntry.approved += movedSubtopicEntry.approved;
      }
      if (destSubjEntry) {
        destSubjEntry.total += movedSubtopicEntry.total;
        destSubjEntry.approved += movedSubtopicEntry.approved;
      }
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: [sourceSubjectName, destinationSubjectName],
      topics_affected: [sourceTopicName, destinationTopicName],
      subtopics_affected: [subtopicName],
      mcqs_affected: mcqsAffected,
    };
  }

  // See moveTopicToSubject's own comment on this same factoring.
  const runMove = async (session) => {
      // 1. Reparent — a subtopic has no children of its own, so this
      // one write is the whole structural move.
      subtopicNode.parent_id = destinationTopic._id;
      await subtopicNode.save({ session });

      // 2. Every MCQ under the OLD (subject, topic, subtopic) triple
      // -> new (subject, topic) pair. `subtopic` untouched.
      const mcqResult = await MCQ.updateMany(
        mcqFilter,
        { $set: { subject: destinationSubjectName, topic: destinationTopicName } },
        { session }
      );

      // 3. Recompute affected counts inside the same session, for the
      // response payload's confirmation numbers.
      const [sourceTopicTotal, destinationTopicTotal] = await Promise.all([
        MCQ.countDocuments(
          { subject: sourceSubjectName, ...topicMatchFilter(sourceTopicName) },
          { session }
        ),
        MCQ.countDocuments(
          { subject: destinationSubjectName, ...topicMatchFilter(destinationTopicName) },
          { session }
        ),
      ]);

      const matchedCount = mcqResult?.matchedCount ?? mcqResult?.n ?? 0;
      const modifiedCount = mcqResult?.modifiedCount ?? mcqResult?.nModified ?? 0;

      // 4. Persist counts (Prompt 13). subtopicNode is passed —
      // recalculateTaxonomyCounts walks up its (now reparented)
      // `parent_id` to pick up the destination topic + subject
      // automatically — plus the source topic explicitly, since once
      // reparented it's no longer reachable by walking up from
      // anything passed here (mirrors moveTopicToSubject's own
      // source-subject handling one level up the tree).
      await recalculateTaxonomyCounts([subtopicNode._id, sourceTopic._id], session);

      // 5. ActivityLog (Prompt 11).
      if (actor) {
        await createLog({
          actor,
          action: 'taxonomy_subtopic_moved',
          entityType: 'MCQ',
          entityId: null,
          summary:
            `Moved subtopic "${subtopicName}" from "${sourceTopicName}" to ` +
            `"${destinationTopicName}": ${modifiedCount} MCQ(s)`,
          session,
          oldLocation: oldLocationPath,
          newLocation: newLocationPath,
          mcqsUpdated: modifiedCount,
          success: true,
        });
      }

      return {
        subtopic_node_id: String(subtopicNode._id),
        subtopic_name: subtopicName,
        source_topic: { id: String(sourceTopic._id), name: sourceTopicName, total: sourceTopicTotal },
        destination_topic: {
          id: String(destinationTopic._id),
          name: destinationTopicName,
          total: destinationTopicTotal,
        },
        matched_count: matchedCount,
        modified_count: modifiedCount,
      };
  };

  // See moveTopicToSubject's own comment on this same branch.
  if (externalSession) {
    return await runMove(externalSession);
  }

  try {
    return await withTaxonomyTransaction(runMove);
  } catch (err) {
    // Failure ActivityLog row (Prompt 14) — see renameTaxonomyNode's
    // own catch block comment.
    if (actor) {
      await createLog({
        actor,
        action: 'taxonomy_subtopic_moved',
        entityType: 'MCQ',
        entityId: null,
        summary:
          `Failed to move subtopic "${subtopicName}" from "${sourceTopicName}" to ` +
          `"${destinationTopicName}": ${err.message}`,
        oldLocation: oldLocationPath,
        newLocation: newLocationPath,
        mcqsUpdated: 0,
        success: false,
      });
    }

    if (err?.code === 11000) {
      // Same race the pre-check above exists to make unlikely: another
      // request created a same-named subtopic under the destination
      // between the check and this transaction's own reparent write.
      throw ApiError.conflict(
        `"${destinationTopicName}" already has a subtopic named "${subtopicName}" — ` +
          `merge the two instead of moving, or rename one first`
      );
    }
    throw err;
  }
};

// ─── mergeTaxonomyNodes (Taxonomy P8 — Features 4, 5, 6) ────────────
// One function handling subject-, topic-, and subtopic-level merges —
// e.g. collapsing "Current Affairs" / "current affairs" (a case-only
// duplicate) or "Pak Study" / "Pakistan Studies" (a different-name
// duplicate) into a single node. Unlike every mover in P5-P7, nothing
// here changes a node's TYPE or PARENT — a merge only ever collapses
// N siblings of the SAME type/parent into one of themselves.
const mcqFilterForLevel = (level, ancestorNames, name) => {
  if (level === 'subject') return { subject: name };
  if (level === 'topic') return { subject: ancestorNames.subject, ...topicMatchFilter(name) };
  return {
    subject: ancestorNames.subject,
    ...topicMatchFilter(ancestorNames.topic),
    ...subtopicMatchFilter(name),
  };
};
const mcqUpdateForLevel = (level, name) => {
  if (level === 'subject') return { subject: name };
  if (level === 'topic') return { topic: name };
  return { subtopic: name };
};

// ─── resolveMergeCandidates ──────────────────────────────────────────
// Shared validation + lookup for both previewTaxonomyMerge (read-only)
// and mergeTaxonomyNodes (the real write) — so the preview a caller
// shows an admin can never describe a merge the execute step would
// then refuse to perform for a reason the preview never checked.
// Prompt 12 (Feature 18): every check below now calls the shared
// guardrail in utils/taxonomyValidator.js instead of hand-rolling its
// own — see that file's own "Merge-specific guardrails" section for
// each check's full rationale and exact error wording.
const resolveMergeCandidates = async ({ node_ids: nodeIds, keep_name: rawKeepName }) => {
  const uniqueIds = validateMergeNodeIds(nodeIds);

  const nodes = await TaxonomyNode.find({ _id: { $in: uniqueIds } });
  if (nodes.length !== uniqueIds.length) {
    const foundIds = new Set(nodes.map((n) => String(n._id)));
    const missing = uniqueIds.filter((id) => !foundIds.has(id));
    throw ApiError.notFound(`TaxonomyNode(s) not found: ${missing.join(', ')}`);
  }

  const type = validateMergeSameType(nodes);
  validateMergeSameParent(nodes, type);

  const keepName = (rawKeepName ?? '').trim();
  const survivor = validateMergeKeepName(nodes, keepName);
  const mergedAway = nodes.filter((n) => String(n._id) !== String(survivor._id));

  // Ancestor names for building MCQ filters — resolved once here, off
  // the survivor, via the shared broken-parent-chain guardrail
  // (resolveParentChain), since every node in the group already
  // shares the same parent (enforced above) so a single lookup covers
  // the whole group.
  const ancestors = await resolveParentChain(survivor);
  const ancestorNames = {};
  if (ancestors.subject) ancestorNames.subject = ancestors.subject.name;
  if (ancestors.topic) ancestorNames.topic = ancestors.topic.name;

  return { type, nodes, survivor, mergedAway, ancestorNames };
};

// ─── previewTaxonomyMerge ─────────────────────────────────────────────
// Read-only confirmation payload — no TaxonomyNode/MCQ writes at all —
// so an API layer can show an admin "you're about to merge X and Y
// into Y, N MCQs total" and let them confirm or pick a different
// keep_name before mergeTaxonomyNodes actually runs.
export const previewTaxonomyMerge = async ({ node_ids, keep_name }) => {
  const { type, nodes, survivor, mergedAway, ancestorNames } = await resolveMergeCandidates({
    node_ids,
    keep_name,
  });

  const perNode = await Promise.all(
    nodes.map(async (n) => {
      const count = await MCQ.countDocuments(mcqFilterForLevel(type, ancestorNames, n.name));
      return { node_id: String(n._id), name: n.name, mcq_count: count };
    })
  );

  // Same-content (question_hash) overlap across the nodes about to be
  // merged — detected here BEFORE anything is written.
  const hashGroups = await MCQ.aggregate([
    { $match: { $or: nodes.map((n) => mcqFilterForLevel(type, ancestorNames, n.name)) } },
    { $group: { _id: '$question_hash', count: { $sum: 1 }, question_ids: { $push: '$question_id' } } },
  ]);
  const duplicateGroups = hashGroups.filter((g) => g.count > 1);
  const rawCombinedCount = perNode.reduce((sum, n) => sum + n.mcq_count, 0);
  const duplicateMcqCount = duplicateGroups.reduce((sum, g) => sum + (g.count - 1), 0);

  if (duplicateGroups.length > 0) {
    logger.warn(
      `previewTaxonomyMerge: ${duplicateGroups.length} question(s) already share identical ` +
        `content (same question_hash) across the ${nodes.length} ${type}(s) being previewed for ` +
        `merge (${nodes.map((n) => `"${n.name}"`).join(' / ')}) — combined_mcq_count below is ` +
        `reported net of these rather than double-counted.`,
      duplicateGroups.map((g) => ({ question_hash: g._id, question_ids: g.question_ids }))
    );
  }

  return {
    node_type: type,
    nodes: perNode,
    keep_name: survivor.name,
    keep_node_id: String(survivor._id),
    merged_away_node_ids: mergedAway.map((n) => String(n._id)),
    raw_combined_mcq_count: rawCombinedCount,
    duplicate_mcq_count: duplicateMcqCount,
    combined_mcq_count: rawCombinedCount - duplicateMcqCount,
  };
};

// ─── mergeGroupIntoSurvivor ───────────────────────────────────────────
// The recursive fold at the heart of mergeTaxonomyNodes. Given one
// already-resolved group of TaxonomyNode siblings (same type, same
// parent — one `survivor`, the rest `mergedAway`) it:
//
//   1. Retags every MCQ still pointing at a merged-away node's OLD
//      name (at this level) to the survivor's name.
//   2. Folds the CHILDREN of every node in the group (subject ->
//      topic, or topic -> subtopic) onto the survivor. A child whose
//      slug doesn't collide with any sibling just gets reparented. A
//      child whose slug DOES collide is itself a duplicate pair now
//      landing under the same parent — recursing into
//      mergeGroupIntoSurvivor again collapses that pair too, instead
//      of leaving two same-slug siblings that would trip
//      TaxonomyNode's {type, parent_id, slug} unique index the moment
//      they're both reparented onto the survivor.
//   3. Deletes the now-fully-folded merged-away nodes at this level.
//
// `stats` is a shared, mutated accumulator (matched/modified MCQ
// counts, and a log of every duplicate-child pair collapsed along the
// way) so the outermost caller can report one combined summary across
// however many levels of recursion actually happened.
const mergeGroupIntoSurvivor = async ({ survivor, mergedAway, ancestorNames, session, stats }) => {
  const level = survivor.type;

  // Prompt 13: every node this fold actually keeps around — the
  // survivor at this level, plus every child (reparented as-is, or
  // itself a recursively-resolved child-survivor) — needs its counts
  // recomputed once everything's committed, since its matching-MCQ
  // filter may now cover a merged-in name. `stats.affectedNodeIds` is
  // shared with every recursive call, same accumulator shape as
  // `stats.duplicate_children_collapsed` already uses.
  stats.affectedNodeIds.add(String(survivor._id));

  // 1. MCQ retag — filters built from each merged-away node's own
  // name, captured before any write, so order-of-processing across
  // sibling groups never matters.
  for (const away of mergedAway) {
    const filter = mcqFilterForLevel(level, ancestorNames, away.name);
    const update = mcqUpdateForLevel(level, survivor.name);
    const result = await MCQ.updateMany(filter, { $set: update }, { session });
    stats.matched_count += result.matchedCount ?? result.n ?? 0;
    stats.modified_count += result.modifiedCount ?? result.nModified ?? 0;
  }

  // 2. Fold children one level down. Subtopics have no children of
  // their own in this 3-level tree, so there's nothing left to recurse
  // into once `level === 'subtopic'`.
  const childType = level === 'subject' ? 'topic' : level === 'topic' ? 'subtopic' : null;
  if (childType) {
    const parentIds = [survivor._id, ...mergedAway.map((n) => n._id)];
    const children = await TaxonomyNode.find({
      type: childType,
      parent_id: { $in: parentIds },
    }).session(session);

    const groupsBySlug = new Map();
    for (const child of children) {
      if (!groupsBySlug.has(child.slug)) groupsBySlug.set(child.slug, []);
      groupsBySlug.get(child.slug).push(child);
    }

    for (const group of groupsBySlug.values()) {
      if (group.length === 1) {
        // No collision — a plain reparent, same as moveTopicToSubject/
        // moveSubtopicToTopic's own single-node reparent write.
        const only = group[0];
        if (String(only.parent_id) !== String(survivor._id)) {
          only.parent_id = survivor._id;
          await only.save({ session });
        }
        stats.affectedNodeIds.add(String(only._id));
        continue;
      }

      // A duplicate child group — recursively fold it into one. Prefer
      // whichever candidate already lived under the SURVIVOR's own
      // (pre-merge) subtree, so the winning parent's own naming choice
      // cascades down naturally; falls back to the alphabetically
      // first name if the survivor had no child with this slug at all.
      const preferred = group.find((c) => String(c.parent_id) === String(survivor._id));
      const childSurvivor = preferred ?? group.slice().sort((a, b) => a.name.localeCompare(b.name))[0];
      const childMergedAway = group.filter((c) => String(c._id) !== String(childSurvivor._id));

      if (String(childSurvivor.parent_id) !== String(survivor._id)) {
        childSurvivor.parent_id = survivor._id;
        await childSurvivor.save({ session });
      }

      stats.duplicate_children_collapsed.push({
        level: childType,
        kept: childSurvivor.name,
        merged_away: childMergedAway.map((c) => c.name),
      });

      const nestedAncestorNames =
        level === 'subject'
          ? { subject: survivor.name }
          : { subject: ancestorNames.subject, topic: survivor.name };

      await mergeGroupIntoSurvivor({
        survivor: childSurvivor,
        mergedAway: childMergedAway,
        ancestorNames: nestedAncestorNames,
        session,
        stats,
      });
    }
  }

  // 3. The merged-away nodes at THIS level are now fully folded — every
  // MCQ that pointed at them retagged, every child either reparented or
  // itself collapsed into the survivor's subtree — safe to delete.
  await TaxonomyNode.deleteMany({ _id: { $in: mergedAway.map((n) => n._id) } }, { session });
};

// ─── mergeTaxonomyNodes (Taxonomy P8) ─────────────────────────────────
// Executes the merge previewTaxonomyMerge above described. Runs the
// entire recursive fold inside one Mongo transaction — same "half-
// applied is worse than not done" reasoning every other taxonomy
// mutation in this file gives — then, still inside that transaction,
// recomputes the survivor's final MCQ count AND flags any now-
// duplicate content (same question_hash, previously split across two
// of the merged nodes) this merge produced.
//
// DEFINED EDGE CASE: merging two nodes that each already contained the
// "same" MCQ (identical question + options + correct answer, i.e.
// matching MCQ.question_hash) does NOT delete either row — this
// function has no basis to decide which of two real, possibly-
// independently-QA'd MCQ documents is the one to discard. Both survive
// as separate documents under the survivor node. What this function
// DOES do: report `mcq_count` as the physical row count MINUS that
// duplicate overlap — not a naively double-counted sum of both
// originals — and log every such overlap via logger.warn so an admin
// can go delete the redundant row by hand if they want to.
export const mergeTaxonomyNodes = async ({ node_ids, keep_name, dryRun = false, actor = null }) => {
  const { type, nodes, survivor, mergedAway, ancestorNames } = await resolveMergeCandidates({
    node_ids,
    keep_name,
  });

  // Full before/after path (Prompt 15) — see renameTaxonomyNode's own
  // comment (Prompt 14) on why this is computed once, ahead of both
  // the success and failure ActivityLog rows below. For a merge,
  // "before" is EVERY name that went into the merge (there's no single
  // old location — that's the whole point of a merge), and "after" is
  // just the one name that survived, at the same ancestor path (a
  // merge never changes level/parent — see this function's own header
  // comment above).
  const ancestorPrefix =
    type === 'subject' ? '' : type === 'topic' ? `${ancestorNames.subject} > ` : `${ancestorNames.subject} > ${ancestorNames.topic} > `;
  const oldLocationPath = `${ancestorPrefix}[${nodes.map((n) => n.name).join(', ')}]`;
  const newLocationPath = `${ancestorPrefix}${survivor.name}`;

  // ── Dry run (Prompt 10 — Feature 13) ───────────────────────────────
  // mcqs_affected reuses previewTaxonomyMerge's own per-node-count +
  // duplicate-question_hash-overlap logic, so this can never disagree
  // with what that endpoint already reports for the same node_ids/
  // keep_name.
  if (dryRun) {
    const perNode = await Promise.all(
      nodes.map(async (n) => ({
        name: n.name,
        mcq_count: await MCQ.countDocuments(mcqFilterForLevel(type, ancestorNames, n.name)),
      }))
    );
    const hashGroups = await MCQ.aggregate([
      { $match: { $or: nodes.map((n) => mcqFilterForLevel(type, ancestorNames, n.name)) } },
      { $group: { _id: '$question_hash', count: { $sum: 1 } } },
    ]);
    const duplicateMcqCount = hashGroups
      .filter((g) => g.count > 1)
      .reduce((sum, g) => sum + (g.count - 1), 0);
    const rawMcqsAffected = perNode.reduce((sum, n) => sum + n.mcq_count, 0);
    const mcqsAffected = rawMcqsAffected - duplicateMcqCount;

    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);
    mergeIntoSurvivorInPlace(newStructure, { type, survivor, mergedAway, ancestorNames });

    const mergedNames = nodes.map((n) => n.name);
    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: type === 'subject' ? mergedNames : [],
      topics_affected: type === 'topic' ? mergedNames : [],
      subtopics_affected: type === 'subtopic' ? mergedNames : [],
      // `mcqs_affected` is already net of the double-counted-MCQ edge
      // case (Prompt 8) — an MCQ whose question_hash matches another
      // MCQ under a DIFFERENT merge candidate is one physical row, not
      // two, so it's counted once here, same as the real (non-dry-run)
      // branch below reports it post-merge via `duplicate_mcq_count`.
      // `raw_mcqs_affected`/`duplicate_mcq_count` are surfaced ON TOP
      // of that net figure (Prompt 17) purely so the preview UI can
      // flag the edge case explicitly when it's actually present,
      // rather than folding it silently into one number the admin has
      // no way to notice.
      mcqs_affected: mcqsAffected,
      raw_mcqs_affected: rawMcqsAffected,
      duplicate_mcq_count: duplicateMcqCount,
    };
  }

  const stats = {
    matched_count: 0,
    modified_count: 0,
    duplicate_children_collapsed: [],
    // Prompt 13 — every node mergeGroupIntoSurvivor keeps around
    // (survivor(s) at every level touched by the fold), fed into
    // recalculateTaxonomyCounts once the fold has fully committed.
    affectedNodeIds: new Set(),
  };

  try {
    const { finalTotal, duplicateGroups, duplicateMcqCount } = await withTaxonomyTransaction(
      async (session) => {
        await mergeGroupIntoSurvivor({ survivor, mergedAway, ancestorNames, session, stats });

        // Recompute counts on the surviving node, inside the same
        // transaction — same "confirmation numbers only once everything
        // else has committed" reasoning the movers above already use.
        const finalFilter = mcqFilterForLevel(type, ancestorNames, survivor.name);
        const [total, hashGroups] = await Promise.all([
          MCQ.countDocuments(finalFilter, { session }),
          MCQ.aggregate([
            { $match: finalFilter },
            {
              $group: {
                _id: '$question_hash',
                count: { $sum: 1 },
                question_ids: { $push: '$question_id' },
              },
            },
          ]).session(session),
        ]);
        const groups = hashGroups.filter((g) => g.count > 1);
        const dupCount = groups.reduce((sum, g) => sum + (g.count - 1), 0);

        // Persist counts (Prompt 13) — every survivor node the fold
        // touched (collected in stats.affectedNodeIds as it recursed),
        // plus everything above them up to their subject. Merged-away
        // nodes are already deleted by this point, so nothing further
        // needs excluding here.
        await recalculateTaxonomyCounts([...stats.affectedNodeIds], session);

        // ActivityLog (Prompt 11; action/location fields Prompt 15).
        if (actor) {
          await createLog({
            actor,
            action: 'taxonomy_nodes_merged',
            entityType: 'MCQ',
            entityId: null,
            summary:
              `Merged ${type}(s) ${nodes.map((n) => `"${n.name}"`).join(' / ')} into ` +
              `"${survivor.name}": ${stats.modified_count} MCQ(s)`,
            session,
            oldLocation: oldLocationPath,
            newLocation: newLocationPath,
            mcqsUpdated: stats.modified_count,
            success: true,
          });
        }

        return { finalTotal: total, duplicateGroups: groups, duplicateMcqCount: dupCount };
      }
    );

    if (duplicateGroups.length > 0) {
      logger.warn(
        `mergeTaxonomyNodes: merging ${type}(s) ${nodes.map((n) => `"${n.name}"`).join(' / ')} into ` +
          `"${survivor.name}" left ${duplicateGroups.length} question(s) now duplicated by content ` +
          `(${duplicateMcqCount} extra MCQ row(s) sharing a question_hash with another row under the ` +
          `survivor) — both rows were KEPT, not deleted, but excluded from mcq_count below.`,
        duplicateGroups.map((g) => ({ question_hash: g._id, question_ids: g.question_ids }))
      );
    }

    return {
      node_type: type,
      kept_node_id: String(survivor._id),
      kept_name: survivor.name,
      merged_away_node_ids: mergedAway.map((n) => String(n._id)),
      merged_away_names: mergedAway.map((n) => n.name),
      duplicate_children_collapsed: stats.duplicate_children_collapsed,
      matched_count: stats.matched_count,
      modified_count: stats.modified_count,
      // Physical row count under the survivor after the merge (nothing
      // deleted) vs. that same total net of same-content duplicates.
      raw_mcq_count: finalTotal,
      duplicate_mcq_count: duplicateMcqCount,
      mcq_count: finalTotal - duplicateMcqCount,
    };
  } catch (err) {
    // Failure ActivityLog row (Prompt 15) — see renameTaxonomyNode's
    // own catch block comment (Prompt 14) for why this must be a
    // fresh, session-less write after the transaction above has
    // already rolled back.
    if (actor) {
      await createLog({
        actor,
        action: 'taxonomy_nodes_merged',
        entityType: 'MCQ',
        entityId: null,
        summary: `Failed to merge ${type}(s) ${nodes.map((n) => `"${n.name}"`).join(' / ')} into "${survivor.name}": ${err.message}`,
        oldLocation: oldLocationPath,
        newLocation: newLocationPath,
        mcqsUpdated: 0,
        success: false,
      });
    }

    if (err?.code === 11000) {
      // Should be unreachable — mergeGroupIntoSurvivor is specifically
      // designed to resolve every same-slug collision (recursively)
      // before deleting anything — but surfaced as a clean conflict
      // rather than a raw Mongo error if some untested tree shape still
      // slips past it, same defensive stance the movers above take.
      throw ApiError.conflict(
        `Merging ${nodes.map((n) => `"${n.name}"`).join(' / ')} hit an unresolved naming ` +
          `collision — please retry, or report this as a bug`
      );
    }
    throw err;
  }
};

// ─── resolveAncestorNames ─────────────────────────────────────────────
// Small shared lookup for the delete path below (Taxonomy P9): given
// any TaxonomyNode, resolves the display names of everything ABOVE it
// in the tree — {} for a subject (no ancestors), {subject} for a
// topic, {subject, topic} for a subtopic. This is exactly the shape
// mcqFilterForLevel/mcqUpdateForLevel (defined above, for P8's merge)
// already expect as their `ancestorNames` argument, so both the node
// being deleted AND a "move to X" destination can reuse those same two
// helpers rather than this function duplicating their filter/update
// logic.
//
// Prompt 12 (Feature 18): the actual chain-walk + broken-chain error
// now lives once, shared, in utils/taxonomyValidator.js's
// resolveParentChain — this function is just the thin "unwrap node
// objects down to their names" adapter mcqFilterForLevel/
// mcqUpdateForLevel expect.
const resolveAncestorNames = async (node) => {
  const ancestors = await resolveParentChain(node);
  const ancestorNames = {};
  if (ancestors.subject) ancestorNames.subject = ancestors.subject.name;
  if (ancestors.topic) ancestorNames.topic = ancestors.topic.name;
  return ancestorNames;
};

// Every TaxonomyNode id in the subtree rooted at `node`, INCLUDING
// `node` itself — a subject-level delete recurses two levels down
// (its topics, then those topics' subtopics), a topic-level delete
// recurses one level down (its subtopics), a subtopic-level delete has
// no descendants of its own. Collected as one flat id list up front so
// the actual delete (inside the transaction, see deleteTaxonomyNode
// below) is a single TaxonomyNode.deleteMany rather than a recursive
// walk that could half-apply if it failed partway through.
const collectSubtreeNodeIds = async (node) => {
  const ids = [node._id];
  if (node.type === 'subject') {
    const topics = await TaxonomyNode.find({ type: 'topic', parent_id: node._id }).lean();
    ids.push(...topics.map((t) => t._id));
    if (topics.length > 0) {
      const subtopics = await TaxonomyNode.find({
        type: 'subtopic',
        parent_id: { $in: topics.map((t) => t._id) },
      }).lean();
      ids.push(...subtopics.map((s) => s._id));
    }
  } else if (node.type === 'topic') {
    const subtopics = await TaxonomyNode.find({ type: 'subtopic', parent_id: node._id }).lean();
    ids.push(...subtopics.map((s) => s._id));
  }
  return ids;
};

// Per-type descendant TaxonomyNode counts for previewTaxonomyDelete
// below — how many topic nodes and how many subtopic nodes would be
// deleted along with `node` itself. Deliberately node-COUNTS (what's
// being removed from the taxonomy tree), NOT MCQ counts — mcq_count is
// computed separately via mcqFilterForLevel, same as every other
// taxonomy read in this file.
const countDescendantNodes = async (node) => {
  if (node.type === 'subject') {
    const topics = await TaxonomyNode.find({ type: 'topic', parent_id: node._id }).lean();
    const topicIds = topics.map((t) => t._id);
    const subtopicCount = topicIds.length
      ? await TaxonomyNode.countDocuments({ type: 'subtopic', parent_id: { $in: topicIds } })
      : 0;
    return { topic_count: topics.length, subtopic_count: subtopicCount };
  }
  if (node.type === 'topic') {
    const subtopicCount = await TaxonomyNode.countDocuments({ type: 'subtopic', parent_id: node._id });
    return { topic_count: 0, subtopic_count: subtopicCount };
  }
  // 'subtopic' — the leaf of this 3-level tree, nothing hangs below it.
  return { topic_count: 0, subtopic_count: 0 };
};

// ─── previewTaxonomyDelete (Taxonomy P9 — Features 8, 9, 10) ────────
// Read-only confirmation payload for the destructive deleteTaxonomyNode
// below — same "preview can never promise something the real call then
// disagrees with" contract previewTaxonomyMerge already gives P8's
// mergeTaxonomyNodes.
export const previewTaxonomyDelete = async (nodeId) => {
  const node = await TaxonomyNode.findById(nodeId).lean();
  if (!node) {
    throw ApiError.notFound(`TaxonomyNode ${nodeId} not found`);
  }

  const ancestorNames = await resolveAncestorNames(node);
  const [{ topic_count, subtopic_count }, mcqCount] = await Promise.all([
    countDescendantNodes(node),
    MCQ.countDocuments(mcqFilterForLevel(node.type, ancestorNames, node.name)),
  ]);

  return {
    node_id: String(node._id),
    name: node.name,
    type: node.type,
    topic_count,
    subtopic_count,
    mcq_count: mcqCount,
  };
};

// Builds the MCQ $set update for a "move" delete — unlike
// mcqUpdateForLevel (P8's merge helper, which only ever sets the ONE
// field at its own level because a merge's survivor/merged-away nodes
// are guaranteed to share the same parent), a delete's move
// destination can sit ANYWHERE else in the tree at the same level —
// so every field from `subject` down through this level has to be
// overwritten from the destination's own resolved path, the same
// full-path overwrite moveSubtopicToTopic (P7) already uses for its
// own cross-subject subtopic moves.
const mcqUpdateForDeleteMove = (level, destinationAncestorNames, destinationName) => {
  if (level === 'subject') return { subject: destinationName };
  if (level === 'topic') return { subject: destinationAncestorNames.subject, topic: destinationName };
  return {
    subject: destinationAncestorNames.subject,
    topic: destinationAncestorNames.topic,
    subtopic: destinationName,
  };
};

// ─── deleteTaxonomyNode (Taxonomy P9 — Features 8, 9, 10) ────────────
// Permanently removes a TaxonomyNode (and, for a subject/topic, every
// topic/subtopic descending from it — see collectSubtreeNodeIds) along
// with deciding what happens to every MCQ that was tagged under it —
// either reassigned onto a same-type destination node
// (`on_orphan_mcqs: { action: 'move', destination_node_id }`) or
// permanently deleted (`{ action: 'delete' }`).
//
// Either way, the MCQ step and the TaxonomyNode subtree deletion (and,
// per Prompt 11, the ActivityLog write) run inside ONE Mongo
// transaction — deleting the node(s) without first resolving their
// MCQs (or vice versa) would leave an MCQ pointing at a subject/topic/
// subtopic string nothing in TaxonomyNode represents anymore, i.e.
// exactly the "orphan_mcq_triples" drift reconcileTaxonomy() exists to
// detect — this function's whole job is to never produce one.
export const deleteTaxonomyNode = async ({
  node_id: nodeId,
  on_orphan_mcqs: onOrphanMcqs,
  dryRun = false,
  actor = null,
  // Prompt 20 (Bulk Select) — see moveTopicToSubject's own comment on
  // this same param for what it's for; bulkDeleteTaxonomyNodes below
  // deletes several nodes inside ONE transaction the same way.
  session: externalSession = null,
}) => {
  if (!onOrphanMcqs || !['move', 'delete'].includes(onOrphanMcqs.action)) {
    throw ApiError.badRequest('on_orphan_mcqs.action must be "move" or "delete"');
  }

  const node = await TaxonomyNode.findById(nodeId);
  if (!node) {
    throw ApiError.notFound(`TaxonomyNode ${nodeId} not found`);
  }

  const ancestorNames = await resolveAncestorNames(node);
  const mcqFilter = mcqFilterForLevel(node.type, ancestorNames, node.name);

  let destinationNode = null;
  let destinationAncestorNames = {};
  if (onOrphanMcqs.action === 'move') {
    const destinationId = onOrphanMcqs.destination_node_id;
    if (!destinationId) {
      throw ApiError.badRequest(
        'on_orphan_mcqs.destination_node_id is required when action is "move"'
      );
    }
    destinationNode = await TaxonomyNode.findById(destinationId).lean();
    // Prompt 12 (Feature 18): exists / not-self / same-type, all via
    // the shared guardrail — see utils/taxonomyValidator.js's
    // validateDeleteDestination for each specific error message.
    validateDeleteDestination({ node, destinationNode });
    destinationAncestorNames = await resolveAncestorNames(destinationNode);
  }

  // Resolved BEFORE the transaction starts — same "collect everything
  // that has to disappear, then do it all atomically" shape
  // mergeTaxonomyNodes' own mergedAway resolution already follows.
  const subtreeNodeIds = await collectSubtreeNodeIds(node);

  // Full before/after path (Prompt 15) — see renameTaxonomyNode's own
  // comment (Prompt 14) for why this is computed once, ahead of both
  // the success and failure ActivityLog rows below. "after" records
  // whichever of the two `on_orphan_mcqs` outcomes actually happened —
  // moved to a named destination, or deleted outright — so the log row
  // alone (without cross-referencing `details.summary`) tells you which
  // one this was.
  const deleteAncestorPrefix =
    node.type === 'subject' ? '' : node.type === 'topic' ? `${ancestorNames.subject} > ` : `${ancestorNames.subject} > ${ancestorNames.topic} > `;
  const oldLocationPath = `${deleteAncestorPrefix}${node.name}`;
  const newLocationPath =
    onOrphanMcqs.action === 'move'
      ? `${destinationNode.type === 'subject' ? '' : destinationNode.type === 'topic' ? `${destinationAncestorNames.subject} > ` : `${destinationAncestorNames.subject} > ${destinationAncestorNames.topic} > `}${destinationNode.name} (moved)`
      : '(deleted — MCQs permanently removed, not moved)';

  // ── Dry run (Prompt 10 — Feature 13) ───────────────────────────────
  if (dryRun) {
    const mcqsAffected = await MCQ.countDocuments(mcqFilter);
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);

    // Names of every node in the subtree being removed, for the
    // affected-lists below — resolved from the already-collected
    // subtree ids rather than re-derived from the tree diff, so it
    // stays correct regardless of how removeNodeFromTree is implemented.
    const subtreeNodes = await TaxonomyNode.find({ _id: { $in: subtreeNodeIds } }).lean();
    const subjectsAffected = subtreeNodes.filter((n) => n.type === 'subject').map((n) => n.name);
    const topicsAffected = subtreeNodes.filter((n) => n.type === 'topic').map((n) => n.name);
    const subtopicsAffected = subtreeNodes.filter((n) => n.type === 'subtopic').map((n) => n.name);

    removeNodeFromTree(newStructure, { type: node.type, name: node.name, ancestorNames });

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: subjectsAffected,
      topics_affected: topicsAffected,
      subtopics_affected: subtopicsAffected,
      mcqs_affected: mcqsAffected,
    };
  }

  // See moveTopicToSubject's own comment on this same factoring.
  const runDelete = async (session) => {
      let matchedCount = 0;
      let modifiedCount = 0;
      let deletedMcqCount = 0;

      if (onOrphanMcqs.action === 'move') {
        const update = mcqUpdateForDeleteMove(node.type, destinationAncestorNames, destinationNode.name);
        const result = await MCQ.updateMany(mcqFilter, { $set: update }, { session });
        matchedCount = result.matchedCount ?? result.n ?? 0;
        modifiedCount = result.modifiedCount ?? result.nModified ?? 0;
      } else {
        const result = await MCQ.deleteMany(mcqFilter, { session });
        deletedMcqCount = result.deletedCount ?? 0;
      }

      // Every node in the subtree — the node itself plus every
      // topic/subtopic descendant collected above — deleted in one
      // write, only after every MCQ that referenced any part of this
      // subtree has already been resolved above in the SAME transaction.
      await TaxonomyNode.deleteMany({ _id: { $in: subtreeNodeIds } }, { session });

      // Persist counts (Prompt 13). The deleted node itself is gone, so
      // it can't be passed to recalculateTaxonomyCounts (there'd be
      // nothing to walk up FROM) — its own immediate parent is passed
      // explicitly instead, letting the walk climb the rest of the way
      // to subject on its own. For a subject-level delete there's no
      // parent to notify. A "move" destination gains a subtree's worth
      // of MCQs, so it (and ITS ancestors) need recomputing too.
      const countsToRecalculate = [];
      if (node.parent_id) countsToRecalculate.push(node.parent_id);
      if (onOrphanMcqs.action === 'move') countsToRecalculate.push(destinationNode._id);
      if (countsToRecalculate.length > 0) {
        await recalculateTaxonomyCounts(countsToRecalculate, session);
      }

      // ActivityLog (Prompt 11; action/location fields Prompt 15).
      // mcqsUpdated is whichever count actually happened — modifiedCount
      // for a "move" outcome, deletedMcqCount for a "delete" outcome —
      // `new_location` (computed above) is what disambiguates which of
      // the two this row is without needing to parse `details.summary`.
      if (actor) {
        await createLog({
          actor,
          action: 'taxonomy_node_deleted',
          entityType: 'MCQ',
          entityId: null,
          summary:
            `Deleted ${node.type} "${node.name}" (${subtreeNodeIds.length} node(s)): ` +
            (onOrphanMcqs.action === 'move'
              ? `${modifiedCount} MCQ(s) moved to "${destinationNode.name}"`
              : `${deletedMcqCount} MCQ(s) deleted`),
          session,
          oldLocation: oldLocationPath,
          newLocation: newLocationPath,
          mcqsUpdated: onOrphanMcqs.action === 'move' ? modifiedCount : deletedMcqCount,
          success: true,
        });
      }

      return {
        node_id: String(node._id),
        node_type: node.type,
        name: node.name,
        deleted_node_count: subtreeNodeIds.length,
        on_orphan_mcqs: onOrphanMcqs.action,
        ...(onOrphanMcqs.action === 'move'
          ? {
              destination_node_id: String(destinationNode._id),
              destination_name: destinationNode.name,
              matched_count: matchedCount,
              modified_count: modifiedCount,
            }
          : {
              deleted_mcq_count: deletedMcqCount,
            }),
      };
  };

  // See moveTopicToSubject's own comment on this same branch.
  if (externalSession) {
    return await runDelete(externalSession);
  }

  try {
    return await withTaxonomyTransaction(runDelete);
  } catch (err) {
    // Failure ActivityLog row (Prompt 15) — see renameTaxonomyNode's
    // own catch block comment (Prompt 14). deleteTaxonomyNode had no
    // try/catch of its own before this prompt (nothing here previously
    // needed to translate a Mongo error into a friendlier ApiError,
    // unlike the movers/merge above) — added now solely so a rolled-
    // back delete still gets its own success:false row, same as every
    // other taxonomy mutation.
    if (actor) {
      await createLog({
        actor,
        action: 'taxonomy_node_deleted',
        entityType: 'MCQ',
        entityId: null,
        summary: `Failed to delete ${node.type} "${node.name}": ${err.message}`,
        oldLocation: oldLocationPath,
        newLocation: newLocationPath,
        mcqsUpdated: 0,
        success: false,
      });
    }
    throw err;
  }
};


// ─── Bulk taxonomy moves & delete (Prompt 20 — Bulk Select, Feature 12) ─
// TaxonomyManager's checkbox-based multi-select (client-side) lets an
// admin tick 2+ same-TYPE nodes — regardless of parent, for move/delete
// (merge alone still requires same parent too; see mergeTaxonomyNodes'
// own validateMergeSameParent) — and run ONE move/delete across all of
// them in a single confirm.
//
// Per this prompt's own DoD: "one preview, one transaction, and one
// ActivityLog row per node (not one combined row that loses per-node
// traceability)". Each function below delivers that by:
//   - dryRun: building ONE combined current/new tree diff by applying
//     every node's own move/removal onto the SAME cloned tree in
//     sequence (not N independent diffs each starting fresh from the
//     real DB) — so a preview showing "3 topics moving to Physics"
//     actually shows all 3 landing there together, not just whichever
//     ran last.
//   - real run: ONE withTaxonomyTransaction session, inside which the
//     existing single-node mover/deleter (moveTopicToSubject etc.) is
//     called once per node id with THAT session passed through (see
//     each mover's own `session: externalSession` param above) — so
//     every node's reparent/removal + MCQ retag + its own ActivityLog
//     row (written by that same single-node function, unchanged) all
//     land in one atomic commit. A failure on node 2 of 3 rolls back
//     node 1's already-applied change too, exactly like a single move
//     failing rolls back its own — nothing here re-derives that
//     atomicity separately.
const bulkMoveFailureLog = async (actor, action, summary) => {
  if (!actor) return;
  // Session-less, same as every single-node mover's own failure-log
  // catch above — the transaction that would have held it has already
  // rolled back by the time this runs.
  await createLog({
    actor,
    action,
    entityType: 'MCQ',
    entityId: null,
    summary,
    mcqsUpdated: 0,
    success: false,
  });
};

// ─── bulkMoveTopicsToSubject ──────────────────────────────────────────
export const bulkMoveTopicsToSubject = async ({
  topic_node_ids: topicNodeIds,
  destination_subject_id: destinationSubjectId,
  dryRun = false,
  actor = null,
}) => {
  if (!Array.isArray(topicNodeIds) || topicNodeIds.length === 0) {
    throw ApiError.badRequest('topic_node_ids must be a non-empty array');
  }

  const destinationSubject = await TaxonomyNode.findById(destinationSubjectId);
  if (!destinationSubject || destinationSubject.type !== 'subject') {
    throw ApiError.notFound(`Subject node ${destinationSubjectId} not found`);
  }

  if (dryRun) {
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);
    const subjectsAffected = new Set([destinationSubject.name]);
    const topicsAffected = new Set();
    const subtopicsAffected = new Set();
    let mcqsAffected = 0;

    for (const topicNodeId of topicNodeIds) {
      const topicNode = await TaxonomyNode.findById(topicNodeId);
      if (!topicNode || topicNode.type !== 'topic') {
        throw ApiError.notFound(`Topic node ${topicNodeId} not found`);
      }
      const { subject: sourceSubject } = await resolveParentChain(topicNode);
      subjectsAffected.add(sourceSubject.name);
      topicsAffected.add(topicNode.name);
      mcqsAffected += await MCQ.countDocuments({
        subject: sourceSubject.name,
        ...topicMatchFilter(topicNode.name),
      });

      const sourceEntry = findSubjectEntry(newStructure, sourceSubject.name);
      const destEntry = findSubjectEntry(newStructure, destinationSubject.name);
      const topicIndex =
        sourceEntry?.topics.findIndex((t) => t.name.toLowerCase() === topicNode.name.toLowerCase()) ?? -1;
      if (sourceEntry && topicIndex !== -1) {
        const [movedTopicEntry] = sourceEntry.topics.splice(topicIndex, 1);
        const countKeys = ['total', 'approved', 'pending', 'rejected'];
        countKeys.forEach((k) => { sourceEntry[k] -= movedTopicEntry[k]; });
        if (destEntry) {
          destEntry.topics.push(movedTopicEntry);
          countKeys.forEach((k) => { destEntry[k] += movedTopicEntry[k]; });
        }
        (movedTopicEntry.subtopics ?? []).forEach((s) => subtopicsAffected.add(s.name));
      }
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: [...subjectsAffected],
      topics_affected: [...topicsAffected],
      subtopics_affected: [...subtopicsAffected],
      mcqs_affected: mcqsAffected,
    };
  }

  try {
    return await withTaxonomyTransaction(async (session) => {
      const results = [];
      for (const topicNodeId of topicNodeIds) {
        results.push(
          await moveTopicToSubject({
            topic_node_id: topicNodeId,
            destination_subject_id: destinationSubjectId,
            actor,
            session,
          })
        );
      }
      return {
        moved_count: results.length,
        destination_subject: { id: String(destinationSubject._id), name: destinationSubject.name },
        results,
      };
    });
  } catch (err) {
    await bulkMoveFailureLog(
      actor,
      'taxonomy_topic_moved',
      `Failed bulk move of ${topicNodeIds.length} topic(s) to "${destinationSubject.name}": ${err.message}`
    );
    throw err;
  }
};

// ─── bulkMoveSubjectsIntoSubject ──────────────────────────────────────
export const bulkMoveSubjectsIntoSubject = async ({
  subject_node_ids: subjectNodeIds,
  destination_subject_id: destinationSubjectId,
  dryRun = false,
  actor = null,
}) => {
  if (!Array.isArray(subjectNodeIds) || subjectNodeIds.length === 0) {
    throw ApiError.badRequest('subject_node_ids must be a non-empty array');
  }

  const destinationSubject = await TaxonomyNode.findById(destinationSubjectId);
  if (!destinationSubject || destinationSubject.type !== 'subject') {
    throw ApiError.notFound(`Subject node ${destinationSubjectId} not found`);
  }

  if (dryRun) {
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);
    const subjectsAffected = new Set([destinationSubject.name]);
    const topicsAffected = new Set();
    const subtopicsAffected = new Set();
    let mcqsAffected = 0;

    for (const subjectNodeId of subjectNodeIds) {
      const subjectNode = await TaxonomyNode.findById(subjectNodeId);
      if (!subjectNode || subjectNode.type !== 'subject') {
        throw ApiError.notFound(`Subject node ${subjectNodeId} not found`);
      }
      const oldSubjectName = subjectNode.name;
      subjectsAffected.add(oldSubjectName);
      topicsAffected.add(oldSubjectName);
      mcqsAffected += await MCQ.countDocuments({ subject: oldSubjectName });

      const childTopics = await TaxonomyNode.find({ type: 'topic', parent_id: subjectNode._id }).lean();
      childTopics.forEach((t) => subtopicsAffected.add(t.name));

      const subjectIndex = newStructure.subjects.findIndex((s) => s.name === oldSubjectName);
      const destEntry = findSubjectEntry(newStructure, destinationSubject.name);
      if (subjectIndex !== -1) {
        const [movedSubjectEntry] = newStructure.subjects.splice(subjectIndex, 1);
        if (destEntry) {
          mergeCountsInPlace(destEntry, movedSubjectEntry);
          destEntry.topics.push({
            name: movedSubjectEntry.name,
            total: movedSubjectEntry.total,
            approved: movedSubjectEntry.approved,
            pending: movedSubjectEntry.pending,
            rejected: movedSubjectEntry.rejected,
            subtopics: movedSubjectEntry.topics.map((t) => ({ name: t.name, total: t.total, approved: t.approved })),
          });
        }
      }
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: [...subjectsAffected],
      topics_affected: [...topicsAffected],
      subtopics_affected: [...subtopicsAffected],
      mcqs_affected: mcqsAffected,
    };
  }

  try {
    return await withTaxonomyTransaction(async (session) => {
      const results = [];
      for (const subjectNodeId of subjectNodeIds) {
        results.push(
          await moveSubjectIntoSubject({
            subject_node_id: subjectNodeId,
            destination_subject_id: destinationSubjectId,
            actor,
            session,
          })
        );
      }
      return {
        moved_count: results.length,
        destination_subject: { id: String(destinationSubject._id), name: destinationSubject.name },
        results,
      };
    });
  } catch (err) {
    await bulkMoveFailureLog(
      actor,
      'taxonomy_subject_merged_into_subject',
      `Failed bulk move of ${subjectNodeIds.length} subject(s) into "${destinationSubject.name}": ${err.message}`
    );
    throw err;
  }
};

// ─── bulkMoveSubtopicsToTopic ─────────────────────────────────────────
export const bulkMoveSubtopicsToTopic = async ({
  subtopic_node_ids: subtopicNodeIds,
  destination_topic_id: destinationTopicId,
  dryRun = false,
  actor = null,
}) => {
  if (!Array.isArray(subtopicNodeIds) || subtopicNodeIds.length === 0) {
    throw ApiError.badRequest('subtopic_node_ids must be a non-empty array');
  }

  const destinationTopic = await TaxonomyNode.findById(destinationTopicId);
  if (!destinationTopic || destinationTopic.type !== 'topic') {
    throw ApiError.notFound(`Topic node ${destinationTopicId} not found`);
  }
  const { subject: destinationSubject } = await resolveParentChain(destinationTopic);

  if (dryRun) {
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);
    const subjectsAffected = new Set([destinationSubject.name]);
    const topicsAffected = new Set([destinationTopic.name]);
    const subtopicsAffected = new Set();
    let mcqsAffected = 0;

    for (const subtopicNodeId of subtopicNodeIds) {
      const subtopicNode = await TaxonomyNode.findById(subtopicNodeId);
      if (!subtopicNode || subtopicNode.type !== 'subtopic') {
        throw ApiError.notFound(`Subtopic node ${subtopicNodeId} not found`);
      }
      const { topic: sourceTopic, subject: sourceSubject } = await resolveParentChain(subtopicNode);
      subjectsAffected.add(sourceSubject.name);
      topicsAffected.add(sourceTopic.name);
      subtopicsAffected.add(subtopicNode.name);
      mcqsAffected += await MCQ.countDocuments({
        subject: sourceSubject.name,
        ...topicMatchFilter(sourceTopic.name),
        ...subtopicMatchFilter(subtopicNode.name),
      });

      const sourceSubjEntry = findSubjectEntry(newStructure, sourceSubject.name);
      const sourceTopicEntry = findTopicEntry(sourceSubjEntry, sourceTopic.name);
      const destSubjEntry = findSubjectEntry(newStructure, destinationSubject.name);
      const destTopicEntry = findTopicEntry(destSubjEntry, destinationTopic.name);
      const subtopicIndex =
        sourceTopicEntry?.subtopics.findIndex((s) => s.name.toLowerCase() === subtopicNode.name.toLowerCase()) ?? -1;
      if (sourceTopicEntry && subtopicIndex !== -1) {
        const [movedSubtopicEntry] = sourceTopicEntry.subtopics.splice(subtopicIndex, 1);
        sourceTopicEntry.total -= movedSubtopicEntry.total;
        sourceTopicEntry.approved -= movedSubtopicEntry.approved;
        if (sourceSubjEntry) {
          sourceSubjEntry.total -= movedSubtopicEntry.total;
          sourceSubjEntry.approved -= movedSubtopicEntry.approved;
        }
        if (destTopicEntry) {
          destTopicEntry.subtopics.push(movedSubtopicEntry);
          destTopicEntry.total += movedSubtopicEntry.total;
          destTopicEntry.approved += movedSubtopicEntry.approved;
        }
        if (destSubjEntry) {
          destSubjEntry.total += movedSubtopicEntry.total;
          destSubjEntry.approved += movedSubtopicEntry.approved;
        }
      }
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: [...subjectsAffected],
      topics_affected: [...topicsAffected],
      subtopics_affected: [...subtopicsAffected],
      mcqs_affected: mcqsAffected,
    };
  }

  try {
    return await withTaxonomyTransaction(async (session) => {
      const results = [];
      for (const subtopicNodeId of subtopicNodeIds) {
        results.push(
          await moveSubtopicToTopic({
            subtopic_node_id: subtopicNodeId,
            destination_topic_id: destinationTopicId,
            actor,
            session,
          })
        );
      }
      return {
        moved_count: results.length,
        destination_topic: { id: String(destinationTopic._id), name: destinationTopic.name },
        results,
      };
    });
  } catch (err) {
    await bulkMoveFailureLog(
      actor,
      'taxonomy_subtopic_moved',
      `Failed bulk move of ${subtopicNodeIds.length} subtopic(s) to "${destinationTopic.name}": ${err.message}`
    );
    throw err;
  }
};

// ─── previewTaxonomyDeleteBulk ────────────────────────────────────────
// The bulk counterpart to previewTaxonomyDelete above — DeleteNodeModal's
// own first-step counts screen, summed across every selected node,
// BEFORE an on_orphan_mcqs choice exists to run bulkDeleteTaxonomyNodes'
// own full dry-run preview with (same two-step reason
// previewTaxonomyDelete's own header comment gives for the single-node
// version).
export const previewTaxonomyDeleteBulk = async (nodeIds) => {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw ApiError.badRequest('nodeIds must be a non-empty array');
  }
  const perNode = await Promise.all(nodeIds.map((id) => previewTaxonomyDelete(id)));
  return {
    node_ids: perNode.map((n) => n.node_id),
    type: perNode[0]?.type,
    count: perNode.length,
    topic_count: perNode.reduce((sum, n) => sum + n.topic_count, 0),
    subtopic_count: perNode.reduce((sum, n) => sum + n.subtopic_count, 0),
    mcq_count: perNode.reduce((sum, n) => sum + n.mcq_count, 0),
    nodes: perNode,
  };
};

// ─── bulkDeleteTaxonomyNodes ──────────────────────────────────────────
// Deletes 2+ same-type TaxonomyNodes (and each one's own subtree) in
// ONE transaction, with the SAME `on_orphan_mcqs` choice applied to
// every one of them (the bulk delete flow asks the move-vs-delete-
// outright question once, up front, for the whole selection — see
// DeleteNodeModal's own bulk-mode comment). Per this prompt's own DoD,
// each node still gets its OWN ActivityLog row — written by
// deleteTaxonomyNode itself (unchanged) once per iteration below, same
// pattern the three bulk movers above already use.
export const bulkDeleteTaxonomyNodes = async ({
  node_ids: nodeIds,
  on_orphan_mcqs: onOrphanMcqs,
  dryRun = false,
  actor = null,
}) => {
  if (!Array.isArray(nodeIds) || nodeIds.length === 0) {
    throw ApiError.badRequest('node_ids must be a non-empty array');
  }
  if (!onOrphanMcqs || !['move', 'delete'].includes(onOrphanMcqs.action)) {
    throw ApiError.badRequest('on_orphan_mcqs.action must be "move" or "delete"');
  }

  // Prompt 20 follow-up (Bulk Select edge case #4): a "move" destination
  // that's ALSO one of the nodes being deleted in this same batch is a
  // guaranteed dangling reference — deleteTaxonomyNode retags every
  // affected MCQ onto `destination_node_id` and only THEN, later in the
  // same loop, may delete that very node when its own turn in `nodeIds`
  // comes up, leaving those MCQs pointing at a subject/topic/subtopic
  // string nothing in TaxonomyNode represents anymore (the same
  // "orphan_mcq_triples" drift deleteTaxonomyNode's own header comment
  // says its whole job is to prevent). DeleteNodeModal's client-side
  // `options` list already filters every batch member out of the
  // destination picker (see that file's own `nodeIdSet` filter), so
  // this is unreachable via the UI — this is the server-side guard for
  // any other caller of this endpoint. Chosen over silently accepting
  // it: the failure mode (invisible orphaned MCQs) is worse than a
  // blunt upfront rejection.
  if (onOrphanMcqs.action === 'move' && nodeIds.includes(onOrphanMcqs.destination_node_id)) {
    throw ApiError.badRequest(
      'on_orphan_mcqs.destination_node_id cannot be one of the nodes being deleted in this same batch — ' +
        'pick a destination outside the selection, or move that node out of the batch first'
    );
  }

  if (dryRun) {
    const currentStructure = await getTaxonomy();
    const newStructure = cloneTree(currentStructure);
    const subjectsAffected = new Set();
    const topicsAffected = new Set();
    const subtopicsAffected = new Set();
    let mcqsAffected = 0;

    for (const nodeId of nodeIds) {
      const node = await TaxonomyNode.findById(nodeId);
      if (!node) {
        throw ApiError.notFound(`TaxonomyNode ${nodeId} not found`);
      }
      const ancestorNames = await resolveAncestorNames(node);
      const mcqFilter = mcqFilterForLevel(node.type, ancestorNames, node.name);
      mcqsAffected += await MCQ.countDocuments(mcqFilter);

      const subtreeNodeIds = await collectSubtreeNodeIds(node);
      const subtreeNodes = await TaxonomyNode.find({ _id: { $in: subtreeNodeIds } }).lean();
      subtreeNodes.filter((n) => n.type === 'subject').forEach((n) => subjectsAffected.add(n.name));
      subtreeNodes.filter((n) => n.type === 'topic').forEach((n) => topicsAffected.add(n.name));
      subtreeNodes.filter((n) => n.type === 'subtopic').forEach((n) => subtopicsAffected.add(n.name));

      removeNodeFromTree(newStructure, { type: node.type, name: node.name, ancestorNames });
    }

    return {
      current_structure: currentStructure,
      new_structure: newStructure,
      subjects_affected: [...subjectsAffected],
      topics_affected: [...topicsAffected],
      subtopics_affected: [...subtopicsAffected],
      mcqs_affected: mcqsAffected,
    };
  }

  try {
    return await withTaxonomyTransaction(async (session) => {
      const results = [];
      for (const nodeId of nodeIds) {
        results.push(
          await deleteTaxonomyNode({
            node_id: nodeId,
            on_orphan_mcqs: onOrphanMcqs,
            actor,
            session,
          })
        );
      }
      return {
        deleted_count: results.length,
        on_orphan_mcqs: onOrphanMcqs.action,
        results,
      };
    });
  } catch (err) {
    await bulkMoveFailureLog(
      actor,
      'taxonomy_node_deleted',
      `Failed bulk delete of ${nodeIds.length} node(s): ${err.message}`
    );
    throw err;
  }
};
