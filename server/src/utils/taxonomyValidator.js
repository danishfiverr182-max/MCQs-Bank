import TaxonomyNode from '../models/TaxonomyNode.js';
import ApiError from './ApiError.js';

// ─── taxonomyValidator.js (Prompt 12 — Feature 18) ────────────────────
// Every guardrail a TaxonomyNode-mutating operation needs BEFORE it is
// safe to open a transaction, in one place. Before this prompt these
// checks were split across two files:
//
//   - `validateTaxonomyMove` (Taxonomy P7) lived inline in
//     taxonomy.service.js and covered self-move / circular / same-name
//     collision / depth for the three reparenting movers (P5-P7).
//   - The merge (P8) and delete (P9) pre-checks — same-type, same-
//     parent, keep_name resolution, delete-destination shape — were
//     each hand-rolled again, inline, inside resolveMergeCandidates and
//     deleteTaxonomyNode respectively.
//   - "Broken parent chain" wasn't a shared check at ALL — it was
//     re-derived FIVE separate times (renameTaxonomyNode,
//     moveTopicToSubject, moveSubjectIntoSubject, moveSubtopicToTopic,
//     and resolveAncestorNames used by both merge and delete), each
//     its own slightly different `if (!subjectNode) throw
//     ApiError.internal(...)` walk.
//
// This file is now the ONLY place any of those checks are implemented.
// taxonomy.service.js imports every function below rather than
// re-deriving any of them — see that file's own comment at each call
// site for exactly which guardrail replaced which inline check.
//
// Every exported check here is a pure, synchronous-where-possible,
// DB-write-free function: given already-fetched node documents (plus,
// where a tree walk is needed, an injectable `findNodeById`), it either
// returns normally or throws a specific `ApiError` — same "throw before
// any transaction opens" contract every caller already relied on
// before this consolidation, just now guaranteed by ONE implementation
// instead of six independently-maintained copies of it.
//
// ─── The four spec cases (Prompt 12's own DoD) ────────────────────────
//   1. Node into itself, or into its own descendant (circular)
//        -> validateNotSelfOrDescendant
//   2. Duplicate hierarchy creation (destination already has a
//      same-name child)
//        -> validateNoDuplicateHierarchy
//   3. Invalid nesting depth (the fixed 3-level subject/topic/subtopic
//      guard, generalized to however many descendant levels a moved
//      node is carrying with it)
//        -> validateNestingDepth
//   4. Broken parent chain (parent_id pointing to a non-existent or
//      wrong-type node)
//        -> resolveParentChain
//
// validateTaxonomyMove() composes 1-3 (unchanged call shape from
// Taxonomy P7, so every existing caller — including
// verify_move_subtopic_and_shared_validator.mjs's own direct import —
// keeps working without modification). Merge/delete-specific checks
// (same-type, same-parent, keep_name resolution, delete-destination
// shape) are exported separately below since they don't fit the
// "moving one node into a destination" shape validateTaxonomyMove
// assumes.

export const NODE_TYPE_DEPTH = { subject: 1, topic: 2, subtopic: 3 };
export const MAX_TAXONOMY_DEPTH = 3;

// What type a node's OWN parent must be, keyed by the node's own type.
// `null` for 'subject' — a subject is the tree root and has no parent
// to validate (see TaxonomyNode.js's own schema comment: parent_id is
// `default: null` for a subject node).
export const REQUIRED_PARENT_TYPE = { subject: null, topic: 'subject', subtopic: 'topic' };

const capitalize = (value) => value.charAt(0).toUpperCase() + value.slice(1);

// Default lookup used by every guardrail below when a caller doesn't
// supply its own — real callers (taxonomy.service.js) pass this
// implicitly; verify_*.mjs scripts inject an in-memory lookup instead
// so every check here stays testable without a live MongoDB (same
// injectable-lookup pattern validateTaxonomyMove already used before
// this consolidation).
export const defaultFindNodeById = (id) => TaxonomyNode.findById(id).lean();

// ─── 1. Self-move / circular (node into itself or its own descendant) ─
// Two related but distinct failure shapes, given two distinct
// messages so the frontend confirmation dialog (Prompt 14) can show an
// admin exactly which one they hit rather than one generic "invalid
// move":
//   - Self-move: destination IS the node being moved.
//   - Circular: destination is somewhere INSIDE the node's own
//     subtree — walks destinationNode's ancestor chain (via
//     `findNodeById`) looking for `node`'s own id.
export const validateNotSelfOrDescendant = async ({
  node,
  destinationNode,
  findNodeById = defaultFindNodeById,
}) => {
  if (String(node._id) === String(destinationNode._id)) {
    throw ApiError.badRequest(`"${node.name}" cannot be moved into itself`);
  }

  let cursor = destinationNode;
  const seen = new Set();
  while (cursor && cursor.parent_id) {
    const cursorId = String(cursor._id);
    if (seen.has(cursorId)) break; // defensive: never loop forever on bad data
    seen.add(cursorId);
    if (String(cursor.parent_id) === String(node._id)) {
      throw ApiError.badRequest(
        `Cannot move "${node.name}" into "${destinationNode.name}" — "${destinationNode.name}" ` +
          `is nested under "${node.name}", which would create a circular reference`
      );
    }
    cursor = await findNodeById(cursor.parent_id);
  }
};

// ─── 2. Duplicate hierarchy creation ──────────────────────────────────
// Destination already has a child with the same normalized (slug)
// name as the node being moved/converted — same rule every individual
// mover used to hand-roll, now expressed once against a caller-
// supplied sibling list. Case-insensitive via `slug` (see
// TaxonomyNode.js's own comment on why slug, not name, backs the
// uniqueness guarantee).
export const validateNoDuplicateHierarchy = ({
  node,
  destinationNode,
  resultingType = node.type,
  destinationSiblings = [],
}) => {
  const collides = destinationSiblings.some((sibling) => sibling.slug === node.slug);
  if (collides) {
    throw ApiError.conflict(
      `"${destinationNode.name}" already has a ${resultingType} named "${node.name}" — ` +
        `merge the two instead of moving, or rename one first`
    );
  }
};

// ─── 3. Invalid nesting depth ─────────────────────────────────────────
// TaxonomyNode is a fixed 3-level tree (subject -> topic -> subtopic).
// A move is only legal if `destinationDepth + 1 (the node itself, at
// its new level) + maxDepthBelowNode (however many levels of real
// descendants the node is carrying with it)` still fits inside that
// limit. `depthViolationMessage`, when supplied, replaces the generic
// wording — moveSubjectIntoSubject uses this to name the exact
// offending topic(s) rather than a generic "4th level" message.
export const validateNestingDepth = ({
  node,
  destinationNode,
  maxDepthBelowNode = 0,
  depthViolationMessage,
}) => {
  const destinationDepth = NODE_TYPE_DEPTH[destinationNode.type];
  const resultingDepth = destinationDepth + 1 + maxDepthBelowNode;
  if (resultingDepth > MAX_TAXONOMY_DEPTH) {
    throw ApiError.badRequest(
      depthViolationMessage ??
        `Cannot move "${node.name}" into "${destinationNode.name}": the result would need ` +
          `${resultingDepth} hierarchy levels, but only ${MAX_TAXONOMY_DEPTH} (subject/topic/subtopic) ` +
          `are supported.`
    );
  }
};

// ─── 4. Broken parent chain ────────────────────────────────────────────
// Walks UP from `node` through as many parent_id hops as its type
// requires (a topic: one hop, expecting a subject; a subtopic: two
// hops, expecting a topic then a subject), throwing a SPECIFIC 500 the
// instant any hop is missing, dangling, or the wrong type, rather than
// letting a later `.name` read on `undefined` blow up with a generic
// stack trace, or — worse — silently building an MCQ filter/update
// against `undefined` and quietly mis-tagging rows.
//
// Returns the resolved ancestor(s) by type — `{}` for a subject (no
// ancestors to resolve), `{ subject }` for a topic, `{ subject, topic }`
// for a subtopic — the exact `ancestorNames`-shaped object
// mcqFilterForLevel/mcqUpdateForLevel (taxonomy.service.js) already
// expect, so every caller gets validation AND the data it needed to
// look up anyway in one call instead of two.
export const resolveParentChain = async (node, { findNodeById = defaultFindNodeById } = {}) => {
  const requiredParentType = REQUIRED_PARENT_TYPE[node.type];
  if (!requiredParentType) return {}; // subject: root, nothing above it to validate

  // topic -> just its own parent, expected type 'subject'.
  // subtopic -> its own parent (expected 'topic'), then THAT node's
  // parent (expected 'subject').
  const hops = node.type === 'subtopic' ? ['topic', 'subject'] : ['subject'];

  const ancestors = {};
  let current = node;
  for (const expectedType of hops) {
    const parentId = current.parent_id;
    if (!parentId) {
      throw ApiError.internal(
        `${capitalize(current.type)} "${current.name}" (${current._id}) has a broken parent chain: ` +
          `parent_id is missing — expected a ${expectedType}`
      );
    }
    const parent = await findNodeById(parentId);
    if (!parent) {
      throw ApiError.internal(
        `${capitalize(current.type)} "${current.name}" (${current._id}) has a broken parent chain: ` +
          `parent ${parentId} does not exist (expected a ${expectedType})`
      );
    }
    if (parent.type !== expectedType) {
      throw ApiError.internal(
        `${capitalize(current.type)} "${current.name}" (${current._id}) has a broken parent chain: ` +
          `parent ${parentId} ("${parent.name}") is a ${parent.type}, expected a ${expectedType}`
      );
    }
    ancestors[expectedType] = parent;
    current = parent;
  }
  return ancestors;
};

// ─── validateTaxonomyMove (composes 1-3) ──────────────────────────────
// Unchanged call shape from Taxonomy P7's own `validateTaxonomyMove` —
// every existing caller (the three reparenting movers in
// taxonomy.service.js, plus verify_move_subtopic_and_shared_validator.
// mjs's own direct import via mcq.service.js's re-export) keeps
// working without modification. Composition, not reimplementation:
// each check below is the same exported function a caller could also
// invoke individually (and the DoD verify script for this prompt does,
// to prove each one in isolation).
export const validateTaxonomyMove = async ({
  node,
  destinationNode,
  resultingType = node.type,
  maxDepthBelowNode = 0,
  destinationSiblings = [],
  depthViolationMessage,
  findNodeById = defaultFindNodeById,
}) => {
  await validateNotSelfOrDescendant({ node, destinationNode, findNodeById });
  validateNoDuplicateHierarchy({ node, destinationNode, resultingType, destinationSiblings });
  validateNestingDepth({ node, destinationNode, maxDepthBelowNode, depthViolationMessage });
};

// ─── Merge-specific guardrails (Taxonomy P8) ───────────────────────────
// mergeTaxonomyNodes/previewTaxonomyMerge's shared resolveMergeCandidates
// used to hand-roll each of these four checks inline. Split out here so
// each has its own name, its own specific message, and can be unit-
// tested (and reused by a future bulk-merge endpoint) independently.

// At least two DISTINCT ids were actually supplied — the shape check
// every other guardrail here assumes has already passed before it
// ever sees real TaxonomyNode documents.
export const validateMergeNodeIds = (nodeIds) => {
  if (!Array.isArray(nodeIds) || nodeIds.length < 2) {
    throw ApiError.badRequest('node_ids must contain at least two TaxonomyNode ids to merge');
  }
  const uniqueIds = [...new Set(nodeIds.map(String))];
  if (uniqueIds.length < 2) {
    throw ApiError.badRequest('node_ids must reference at least two DISTINCT TaxonomyNode ids');
  }
  return uniqueIds;
};

// Every merged node must be the SAME taxonomy level — merging a topic
// with a subtopic would collapse two different kinds of thing into
// one, which this schema has no representation for.
export const validateMergeSameType = (nodes) => {
  const type = nodes[0].type;
  if (nodes.some((n) => n.type !== type)) {
    throw ApiError.badRequest(
      'All merged node_ids must be the same taxonomy level — all subject, all topic, or all subtopic'
    );
  }
  return type;
};

// Every merged topic/subtopic must share the same parent — a merge
// only ever collapses SIBLINGS; two same-named topics under two
// different subjects are a coincidence, not a duplicate, and merging
// them would silently reparent one into the other's subject. (Subjects
// have no parent to compare, so this is a no-op for `type ===
// 'subject'`.)
export const validateMergeSameParent = (nodes, type) => {
  if (type === 'subject') return;
  const parentIds = new Set(nodes.map((n) => String(n.parent_id)));
  if (parentIds.size > 1) {
    throw ApiError.badRequest(
      `All merged ${type}s must share the same parent — these ${type}s currently live under ` +
        `different parents. Move them under a common parent first, or merge at a shared ` +
        `ancestor level instead.`
    );
  }
};

// `keep_name` must exactly match the CURRENT name of one of the merged
// nodes — picking the survivor by name (not id) so the caller doesn't
// need to already know which id is "the good one", but that means an
// unmatched name has to be rejected explicitly rather than silently
// merging into nothing.
export const validateMergeKeepName = (nodes, keepName) => {
  const survivor = nodes.find((n) => n.name === keepName);
  if (!survivor) {
    throw ApiError.badRequest(
      `keep_name "${keepName}" must exactly match the current name of one of the merged nodes ` +
        `(${nodes.map((n) => `"${n.name}"`).join(', ')})`
    );
  }
  return survivor;
};

// ─── Delete-specific guardrail (Taxonomy P9) ───────────────────────────
// deleteTaxonomyNode's `on_orphan_mcqs: { action: 'move',
// destination_node_id }` branch used to hand-roll this three-part
// check (exists / not-self / same-type) inline. A destination that
// doesn't exist, IS the node being deleted, or is the wrong taxonomy
// level would otherwise either 500 on a later `.name` read or quietly
// retag MCQs onto a nonsensical destination (e.g. a subject's MCQs
// "moved" onto a topic node).
export const validateDeleteDestination = ({ node, destinationNode }) => {
  if (!destinationNode) {
    throw ApiError.notFound('Destination TaxonomyNode not found');
  }
  if (String(destinationNode._id) === String(node._id)) {
    throw ApiError.badRequest('destination_node_id cannot be the node being deleted');
  }
  if (destinationNode.type !== node.type) {
    throw ApiError.badRequest(
      `on_orphan_mcqs destination must be a ${node.type} (got a ${destinationNode.type}) — ` +
        `reassign to another ${node.type} instead`
    );
  }
};
