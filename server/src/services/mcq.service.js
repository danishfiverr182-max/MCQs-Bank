import mongoose from 'mongoose';
import MCQ from '../models/MCQ.js';
import ImportBatch from '../models/importBatch.model.js';
import TaxonomyNode from '../models/TaxonomyNode.js';
import ApiError from '../utils/ApiError.js';
import { buildPaginatedResponse } from '../utils/pagination.js';
import { slugify } from '../utils/slugify.js';

// This is the only file allowed to run MCQ.find/create/update/delete
// queries. Controllers must go through these functions exclusively.

// Same fix as generator.service.js's topicMatchFilter / blueprint.service.js's
// local copy — topic (and, as of Prompt 109, subtopic) is free-text with no
// case normalization at the model level, so an exact string match silently
// returns 0 results the moment casing differs from how it's stored. Kept as
// a local copy rather than imported for the same reason blueprint.service.js
// gives: avoiding a circular import back into this file.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const topicMatchFilter = (topicValue) => ({
  topic: { $regex: `^${escapeRegex(topicValue.trim())}$`, $options: 'i' },
});
const subtopicMatchFilter = (subtopicValue) => ({
  subtopic: { $regex: `^${escapeRegex(subtopicValue.trim())}$`, $options: 'i' },
});

// ─── ensureTaxonomyNodesExist ───────────────────────────────────────
// Upserts the subject -> topic -> subtopic chain for one taxonomy
// triple into TaxonomyNode, creating whichever of the three nodes
// don't already exist. This is the second half of the "MCQs exist but
// Taxonomy Manager shows nothing" bug: TaxonomyNode was built as a
// management layer with getTaxonomy() rebuilt to read FROM it (see
// that function's own comment), but nothing was ever wired to create
// a node when an MCQ shows up carrying a subject/topic/subtopic
// combination that doesn't have one yet — so a brand-new taxonomy
// value was invisible in the Taxonomy Manager forever, even though
// the MCQ itself saved successfully. createMcq (below) and
// import.service.js's insertValid both call this now.
//
// $setOnInsert-only, matching seedTaxonomyFromMcqs.js's own upsert
// logic exactly — never overwrites a node that already exists, so an
// admin's hand-edited display casing/order survives a later MCQ
// merely reusing that taxonomy triple.
//
// `session` is optional: pass one to make this atomic with an MCQ
// write (createMcq does); omit it for best-effort, non-transactional
// use where failing to tag one node shouldn't roll back an otherwise-
// successful batch (bulk import).
// Return value: { subjectId, topicId, subtopicId, subtopicCreated }.
// `subtopicCreated` (added for the Import page's "New Subtopics From
// This Import" feature) is true only when the subtopic upsert below
// genuinely inserted a brand-new TaxonomyNode rather than matching an
// existing one — the same subject/topic/subtopic combo re-imported
// later reports `false`, since by then the node already exists. Uses
// `includeResultMetadata: true` (Mongoose 8's option name for this —
// the older `rawResult: true` name is silently ignored by
// findOneAndUpdate in this version, which would make `result.value`
// undefined and throw) to read the raw driver ModifyResult, so
// `lastErrorObject.upserted` (only present on an actual insert) tells
// us definitively whether this call created the node, without any
// extra query or before/after timestamp comparison.
export const ensureTaxonomyNodesExist = async ({ subject, topic, subtopic }, session = undefined) => {
  const upsertNode = async (type, parent_id, name) => {
    const slug = slugify(name ?? '');
    const result = await TaxonomyNode.findOneAndUpdate(
      { type, parent_id, slug },
      { $setOnInsert: { type, parent_id, slug, name: name ?? '' } },
      { upsert: true, new: true, setDefaultsOnInsert: true, session, includeResultMetadata: true }
    );
    return { id: result.value._id, created: Boolean(result.lastErrorObject?.upserted) };
  };

  const subjectRes = await upsertNode('subject', null, subject);
  const topicRes = await upsertNode('topic', subjectRes.id, topic ?? '');
  const subtopicRes = await upsertNode('subtopic', topicRes.id, subtopic ?? '');

  return {
    subjectId: subjectRes.id,
    topicId: topicRes.id,
    subtopicId: subtopicRes.id,
    subtopicCreated: subtopicRes.created,
  };
};

export const createMcq = async (data) => {
  const session = await mongoose.startSession();
  try {
    let created;
    await session.withTransaction(async () => {
      const [doc] = await MCQ.create([data], { session });
      created = doc;
      await ensureTaxonomyNodesExist(
        { subject: data.subject, topic: data.topic, subtopic: data.subtopic },
        session
      );
    });
    return created;
  } finally {
    await session.endSession();
  }
};

// ─── getTopicsBySubject ────────────────────────────────────────────
// Distinct, sorted list of topic values recorded against APPROVED
// MCQs for one subject — powers SubjectTopicPicker.jsx's lazy,
// per-subject topic fetch (Prompt 77) and the `topics` override's
// availability checks elsewhere in Phase 7. Scoped to 'approved' only,
// matching every other subject/topic surface in this codebase
// (fetchAndSamplePool, checkOverrideFeasibility) — a topic that only
// exists on pending/rejected questions isn't a real, currently-usable
// filter option for generation.
export const getTopicsBySubject = async (subject) => {
  const topics = await MCQ.distinct('topic', { subject, status: 'approved' });

  // `topic` defaults to '' when never set (MCQ schema) — filter that
  // out so the picker never renders a blank option, then sort for a
  // stable, predictable order in the UI.
  return topics.filter((t) => t && t.trim().length > 0).sort();
};

export const findWithFilters = async (filters = {}, pagination = {}) => {
  const query = {};

  if (filters.subject) query.subject = filters.subject;
  if (filters.difficulty) query.difficulty = filters.difficulty;
  // 'latest' isn't a real value of the `status` field on MCQ — it's a
  // pseudo-status the MCQ Bank filter bar offers so an admin can jump
  // straight to "everything the most recent import just added",
  // regardless of each row's actual pending/approved/rejected status.
  // Resolve it to the newest ImportBatch's batch_id and filter on
  // source_batch_id instead of status (see MCQ.js's source_batch_id
  // comment — every row inserted by insertValid() is tagged with it).
  //
  // Restricted to mode: 'insert' — a 'validate_only' dry run (the
  // "Validate Only" toggle, or Paste JSON's Validate/auto-validate,
  // see import.service.js's runImportPipeline) still creates an
  // ImportBatch row for the audit trail, but never actually inserts
  // or tags any MCQ. If the newest batch overall happened to be one of
  // those, this would resolve to a batch_id nothing matches and "Latest
  // import" would come back empty even though a real import ran
  // earlier. Only batches that could possibly own any MCQs are eligible.
  if (filters.status === 'latest') {
    const latestBatch = await ImportBatch.findOne({ mode: 'insert' }).sort({ created_at: -1 });
    // No import has ever run: there is no "latest" batch to show.
    // Use a query that can never match rather than skipping the
    // filter, so the list correctly comes back empty instead of
    // silently falling through to "all MCQs".
    query.source_batch_id = latestBatch ? latestBatch.batch_id : '__no_import_yet__';
  } else if (filters.status) {
    query.status = filters.status;
  }
  if (filters.cognitive_level) query.cognitive_level = filters.cognitive_level;
  if (filters.exam_tag) query.exam_tags = filters.exam_tag;
  if (filters.search) query.$text = { $search: filters.search };
  // Taxonomy page's "View MCQs" deep link (Prompt 109). Checked against
  // `undefined` rather than truthiness — unlike every other filter above,
  // '' is a real, meaningful value here (the "(none)" topic/subtopic
  // bucket), not "unset". An exact (case-insensitive) match on '' is a
  // plain equality query; a non-empty value goes through the same
  // case-insensitive regex match the rest of the app already uses for
  // topic filtering.
  if (filters.topic !== undefined) {
    if (filters.topic === '') query.topic = '';
    else Object.assign(query, topicMatchFilter(filters.topic));
  }
  if (filters.subtopic !== undefined) {
    if (filters.subtopic === '') query.subtopic = '';
    else Object.assign(query, subtopicMatchFilter(filters.subtopic));
  }
  // Prompt 89: batched lookup by question_id — takes priority as an
  // exact-match filter; mutually usable alongside the other filters
  // above (e.g. ids + status) though callers typically pass it alone.
  if (filters.ids && filters.ids.length > 0) query.question_id = { $in: filters.ids };

  const { page, limit, sortBy, sortOrder } = pagination;
  const skip = (page - 1) * limit;
  const sort = { [sortBy]: sortOrder === 'asc' ? 1 : -1 };

  // When searching, project the text-relevance score and rank by it
  // first, falling back to the requested sort as a tiebreaker.
  const projection = filters.search ? { score: { $meta: 'textScore' } } : {};
  const effectiveSort = filters.search
    ? { score: { $meta: 'textScore' }, ...sort }
    : sort;

  const [items, totalCount] = await Promise.all([
    MCQ.find(query, projection)
      .sort(effectiveSort)
      .skip(skip)
      .limit(limit)
      .lean(),
    MCQ.countDocuments(query),
  ]);

  // Prompt 103: standardized { data, pagination } shape (was { items,
  // pagination: { total, ... } }) — see mcq.controller.js for the note
  // on the resulting frontend break.
  return buildPaginatedResponse(items, totalCount, { page, limit });
};

// `id` is normally a Mongo _id (the standard admin-UI lookup path). But
// duplicateDetector.js's findExactDuplicates/findNearDuplicates surface
// matches as `existingQuestionId`, which is the human-readable
// `question_id` field (e.g. "MCQ-000123"), NOT `_id` — see the SCHEMA
// DEPENDENCY note at the top of that file. Prompt 49's DuplicateReview
// screen calls this same GET /api/mcq/:id route with those values, so
// this needs to resolve either identifier correctly.
export const findById = async (id) => {
  const mcq = mongoose.isValidObjectId(id)
    ? await MCQ.findById(id)
    : await MCQ.findOne({ question_id: id });

  if (!mcq) throw new ApiError(404, 'MCQ not found');
  return mcq;
};

// BUGFIX: `findByIdAndUpdate` only accepts a real Mongo ObjectId — but
// `findById` above (this same GET /mcqs/:id route family) has always
// accepted EITHER identifier: Mongo `_id` (the standard admin-UI path)
// OR the human-readable `question_id` (e.g. "MCQ-000123"), per the
// SCHEMA DEPENDENCY note there. This function was the odd one out:
// pass it a `question_id` and Mongoose throws a CastError trying to
// parse it as an ObjectId, since it's never a valid 24-char hex string.
// That gap became a real bug once GeneratedTest.jsx (Prompt XX, "make
// generated-test questions editable") started calling this route with
// `question_id` directly — that page only ever has the snapshot's
// `mcq_id` (= `question_id`) on hand, never the Mongo `_id` (which
// getGeneratedTestWithQuestions deliberately doesn't expose in its
// response — it's an internal detail, not part of the documented
// question shape). Mirrors findById's exact dual-lookup logic instead
// of teaching every caller to know which identifier they happen to have.
export const updateMcq = async (id, data) => {
  const mcq = mongoose.isValidObjectId(id)
    ? await MCQ.findByIdAndUpdate(id, data, { new: true, runValidators: true })
    : await MCQ.findOneAndUpdate({ question_id: id }, data, { new: true, runValidators: true });
  if (!mcq) throw new ApiError(404, 'MCQ not found');

  // Same gap as createMcq: an edit that retags an MCQ onto a brand-new
  // subject/topic/subtopic combination needs that combination to
  // exist in TaxonomyNode too, or it's invisible in the Taxonomy
  // Manager until the next full seed. Only bother when one of those
  // three fields was actually part of this update — the common case
  // (editing question text, options, etc.) shouldn't pay for an extra
  // round-trip of upserts it doesn't need.
  if ('subject' in data || 'topic' in data || 'subtopic' in data) {
    await ensureTaxonomyNodesExist({
      subject: mcq.subject,
      topic: mcq.topic,
      subtopic: mcq.subtopic,
    });
  }

  return mcq;
};

export const deleteMcq = async (id) => {
  const mcq = await MCQ.findByIdAndDelete(id);
  if (!mcq) throw new ApiError(404, 'MCQ not found');
  return mcq;
};

// Used by both approve and reject controller actions.
export const setStatus = async (id, status) => {
  const mcq = await MCQ.findByIdAndUpdate(id, { status }, { new: true });
  if (!mcq) throw new ApiError(404, 'MCQ not found');
  return mcq;
};

// ─── bulkSetStatus ──────────────────────────────────────────────
// Every MCQ — whether created via the Add MCQ form or via bulk import
// (import.service.js's insertValid) — is inserted with status:
// 'pending' by design, and generator.service.js's fetchAndSamplePool /
// checkOverrideFeasibility ONLY ever draw from status: 'approved'
// questions. That QA gate is intentional (an admin should get to
// review content before it can appear on a real test), but importing
// e.g. 100 MCQs and then having to click Approve one row at a time in
// MCQList.jsx isn't a reasonable workflow. This gives admins a single
// call to move many rows through the gate at once — e.g. every MCQ
// from a given import batch.
export const bulkSetStatus = async (ids, status) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(400, 'ids must be a non-empty array');
  }
  const result = await MCQ.updateMany(
    { _id: { $in: ids } },
    { $set: { status } }
  );
  return {
    matchedCount: result.matchedCount ?? result.n ?? 0,
    modifiedCount: result.modifiedCount ?? result.nModified ?? 0,
  };
};

// ─── bulkDelete ─────────────────────────────────────────────────
// Same "select many rows in MCQList.jsx, act on all of them at once"
// pattern as bulkSetStatus, for permanent deletion. Kept as its own
// service function (rather than a `status: 'deleted'` flag) because
// MCQ.js's status enum only models the review workflow — deletion is
// a real removal, matching the existing single-row deleteMcq above.
export const bulkDelete = async (ids) => {
  if (!Array.isArray(ids) || ids.length === 0) {
    throw new ApiError(400, 'ids must be a non-empty array');
  }
  const result = await MCQ.deleteMany({ _id: { $in: ids } });
  return {
    deletedCount: result.deletedCount ?? 0,
  };
};

// Powers the future stats/dashboard widget.
export const getStats = async () => {
  const [result] = await MCQ.aggregate([
    {
      $facet: {
        bySubject: [{ $group: { _id: '$subject', count: { $sum: 1 } } }],
        byDifficulty: [{ $group: { _id: '$difficulty', count: { $sum: 1 } } }],
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  const bySubject = {};
  for (const { _id, count } of result.bySubject) {
    bySubject[_id] = count;
  }

  const byDifficulty = { easy: 0, medium: 0, hard: 0 };
  for (const { _id, count } of result.byDifficulty) {
    byDifficulty[_id] = count;
  }

  const byStatus = { pending: 0, approved: 0, rejected: 0 };
  for (const { _id, count } of result.byStatus) {
    byStatus[_id] = count;
  }

  return {
    total: result.total[0]?.count || 0,
    bySubject,
    byDifficulty,
    byStatus,
  };
};

// ─── deriveTaxonomyTreeFromMcqs ─────────────────────────────────────
// Builds the subject -> topic -> subtopic tree PURELY from MCQ, with
// no dependency on TaxonomyNode whatsoever. This is what getTaxonomy()
// itself used to be (pre-Taxonomy-P3) before that function was rebuilt
// to read its tree from TaxonomyNode instead.
//
// Exists as its own function specifically so seedTaxonomyFromMcqs.js
// (and anything else that needs to bootstrap or rebuild TaxonomyNode
// from scratch) has a source of truth that does NOT go through
// TaxonomyNode/getTaxonomy() — calling getTaxonomy() for that purpose
// is a circular dependency (TaxonomyNode is empty -> getTaxonomy()
// reports zero subjects -> the seeder "successfully" creates zero
// nodes -> TaxonomyNode stays empty forever). That bug is exactly what
// left production with MCQs in the database but nothing in the
// Taxonomy Manager: seedTaxonomyFromMcqs.js was calling getTaxonomy()
// after it had already been rebuilt on TaxonomyNode.
//
// Grouping rule matches every other taxonomy read path: subject
// compared as-is, topic/subtopic case-insensitively via $toLower for
// the grouping key, with $first picking one representative display
// casing per group (whichever a matching document happens to have
// first — same "don't invent a canonical casing, just pick one and be
// consistent" approach the rest of this file already uses).
export const deriveTaxonomyTreeFromMcqs = async () => {
  // Grouped by RAW subject/topic/subtopic (no normalization in the
  // pipeline) — normalization happens in JS below, using the exact
  // same `slugify()` TaxonomyNode's own uniqueness is scoped by. This
  // must match slug-for-slug, not just case-fold-for-case-fold: two
  // topic values that differ only in whitespace or punctuation (e.g.
  // "History" vs "History ") produce the SAME node under TaxonomyNode's
  // {type, parent_id, slug} unique index, but a $toLower-only grouping
  // key here would still count them as 2 distinct topics — which is
  // exactly the mismatch a real run surfaced ("806 topics" derived vs
  // "803" actually created, upsertNode silently reusing the existing
  // node for 3 of them). Grouping by slug here guarantees this
  // function's counts can never disagree with what actually gets
  // created in TaxonomyNode.
  const rows = await MCQ.aggregate([
    {
      $group: {
        _id: { subject: '$subject', topic: '$topic', subtopic: '$subtopic' },
        total: { $sum: 1 },
        approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
        pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
      },
    },
  ]);

  // subjectName -> { topicSlug -> { name, subtopicSlug -> { name, counts } } }
  const subjectsMap = new Map();
  for (const row of rows) {
    const subjectName = row._id.subject;
    const topicName = row._id.topic ?? '';
    const subtopicName = row._id.subtopic ?? '';
    const topicSlug = slugify(topicName);
    const subtopicSlug = slugify(subtopicName);
    const rowCounts = {
      total: row.total,
      approved: row.approved,
      pending: row.pending,
      rejected: row.rejected,
    };

    if (!subjectsMap.has(subjectName)) subjectsMap.set(subjectName, new Map());
    const topicsMap = subjectsMap.get(subjectName);

    if (!topicsMap.has(topicSlug)) {
      topicsMap.set(topicSlug, { name: topicName, subtopicsMap: new Map() });
    }
    const topicEntry = topicsMap.get(topicSlug);

    if (!topicEntry.subtopicsMap.has(subtopicSlug)) {
      topicEntry.subtopicsMap.set(subtopicSlug, {
        name: subtopicName,
        counts: { total: 0, approved: 0, pending: 0, rejected: 0 },
      });
    }
    // Accumulate rather than overwrite — unlike the old $first-display
    // approach, multiple raw MCQ variants (e.g. "History" and
    // "History ") can now land in the SAME slug bucket, and their
    // counts must all be represented, not just whichever row happened
    // to group first.
    const subtopicEntry = topicEntry.subtopicsMap.get(subtopicSlug);
    subtopicEntry.counts.total += rowCounts.total;
    subtopicEntry.counts.approved += rowCounts.approved;
    subtopicEntry.counts.pending += rowCounts.pending;
    subtopicEntry.counts.rejected += rowCounts.rejected;
  }

  const byName = (a, b) => a.name.localeCompare(b.name);

  const subjects = Array.from(subjectsMap.entries())
    .map(([subjectName, topicsMap]) => {
      const topics = Array.from(topicsMap.values())
        .map((topicEntry) => {
          const subtopics = Array.from(topicEntry.subtopicsMap.values())
            .map((subtopicEntry) => ({ name: subtopicEntry.name, ...subtopicEntry.counts }))
            .sort(byName);
          return { name: topicEntry.name, subtopics };
        })
        .sort(byName);
      return { name: subjectName, topics };
    })
    .sort(byName);

  return { subjects };
};

// ─── getTaxonomy (Prompt 109, rebuilt on TaxonomyNode — Taxonomy P3) ─
// Powers the Taxonomy Manager page: every Subject -> Topic -> Subtopic
// combination, with a per-status count at every level. Response SHAPE
// is byte-identical to the pre-P3 version (TaxonomyManager.jsx gets no
// changes) — what changed is where the TREE comes from.
//
// Before (Prompt 109): the tree was *derived* from MCQ itself — one
// aggregation produced both the structure (which subjects/topics/
// subtopics exist) and the counts.
//
// As of this prompt: TaxonomyNode (see models/TaxonomyNode.js) is the
// structure's backing store. MCQ is now consulted ONLY for live counts,
// joined onto that structure by name — a node with no matching MCQs
// renders with all-zero counts instead of not existing, and an MCQ
// whose subject/topic/subtopic has drifted away from every node simply
// won't be represented in this tree at all (see reconcileTaxonomy()
// below, which is what surfaces that drift instead of this function
// silently absorbing it).
//
// Both reads run in parallel — they're independent until the join step.
//
// ─── Perf: short-TTL cache (Taxonomy page speed pass) ────────────────
// This is the single most-called function on the Taxonomy Manager page
// — the page's own initial load, every one of the 10 taxonomy-mutation
// preview calls (rename/3x move/merge/delete, plus their bulk twins,
// each running getTaxonomy() fresh to build their "current -> new"
// diff — see taxonomy.service.js), and any manual page refresh, ALL
// hit this same full-collection aggregation with no $match. Nothing
// about any single call was slow on its own (the compound
// {subject,topic,subtopic,status} index makes the $group index-only —
// see MCQ.js's own comment on that index), but a normal admin session
// — open a modal, preview, cancel, open another; two admins on the
// page at once — fires several of these full aggregations within a
// couple seconds of each other for what's functionally the same
// answer, and on Atlas that's several round-trips of network latency
// stacking up into exactly the "every click takes seconds" feeling.
//
// `taxonomyCache` memoizes the in-flight/most-recent result. Caching
// the PROMISE (not just the resolved value) means two calls that land
// while the FIRST is still in flight share that one aggregation instead
// of each firing their own — the common case when a page load's own GET
// and a modal's preview race each other, and now confirmed in practice
// to matter a lot: this aggregation measured 8-17s on a real-sized bank
// (nowhere near the "small, dozens of nodes" case the rest of this
// file's comments assume), so overlapping calls are the norm, not the
// exception, on this page.
//
// CORRECTION: an earlier version of this cache keyed its TTL off when
// the call STARTED, which meant a second call arriving after
// CACHE_TTL_MS (but before that first 8-17s aggregation had actually
// FINISHED) saw the entry as "expired" and fired its own redundant
// aggregation in parallel — actively making a slow page slower instead
// of helping. `resolvedAt` fixes that: an in-flight entry (resolvedAt
// still null) is ALWAYS shared, no matter how long it's taking; the
// CACHE_TTL_MS clock only starts once the aggregation has actually
// finished, and only governs whether a genuinely NEW request has to
// re-run it or can reuse the just-finished one.
//
// invalidateTaxonomyCache() is called the instant any taxonomy mutation
// actually commits (see withTaxonomyTransaction below) so a rename/
// move/merge/delete is NEVER read back stale — the TTL alone only ever
// papers over redundant reads of unchanged data, never masks a real
// change. Ordinary MCQ writes elsewhere (approve/reject/edit/bulk-
// import) don't call this — those can leave counts up to CACHE_TTL_MS
// stale after the aggregation finishes, a deliberate trade given how
// short that window is relative to the read cost it saves.
let taxonomyCache = null; // { promise: Promise<{ subjects }>, resolvedAt: number|null }
const CACHE_TTL_MS = 5000;

export const invalidateTaxonomyCache = () => {
  taxonomyCache = null;
};

export const getTaxonomy = async () => {
  if (taxonomyCache) {
    // Still running — share it unconditionally, regardless of how long
    // it's already taken. This is the branch the old start-time-keyed
    // TTL got wrong (see comment above).
    if (taxonomyCache.resolvedAt === null) return taxonomyCache.promise;
    // Finished recently enough — reuse the settled result.
    if (Date.now() - taxonomyCache.resolvedAt < CACHE_TTL_MS) return taxonomyCache.promise;
  }
  const entry = { promise: null, resolvedAt: null };
  entry.promise = computeTaxonomy()
    .then((result) => {
      entry.resolvedAt = Date.now();
      return result;
    })
    .catch((err) => {
      // Don't let a failed aggregation poison the cache — the next call
      // should get a fresh attempt, not the same rejected promise.
      if (taxonomyCache === entry) taxonomyCache = null;
      throw err;
    });
  taxonomyCache = entry;
  return entry.promise;
};

const computeTaxonomy = async () => {
  const [nodes, rows] = await Promise.all([
    TaxonomyNode.find({}).lean(),
    // Grouped by RAW subject/topic/subtopic — see
    // deriveTaxonomyTreeFromMcqs()'s own comment on why: the count
    // join below keys on slugify(topicNode.name)/slugify(subtopicNode.name),
    // matching TaxonomyNode's actual {type, parent_id, slug} uniqueness
    // exactly. A $toLower-only key here would UNDERCOUNT any MCQ whose
    // topic/subtopic differs from the node's stored display name only
    // by whitespace or punctuation (e.g. "History" vs "History ") —
    // that MCQ's row wouldn't match any node's countKey and would
    // silently vanish from every total. Normalization happens in JS
    // below instead, once, using the one slugify() every taxonomy
    // write path already agrees on.
    MCQ.aggregate([
      {
        $group: {
          _id: { subject: '$subject', topic: '$topic', subtopic: '$subtopic' },
          total: { $sum: 1 },
          approved: { $sum: { $cond: [{ $eq: ['$status', 'approved'] }, 1, 0] } },
          pending: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, 1, 0] } },
          rejected: { $sum: { $cond: [{ $eq: ['$status', 'rejected'] }, 1, 0] } },
        },
      },
    ]),
  ]);

  const zeroCounts = { total: 0, approved: 0, pending: 0, rejected: 0 };
  // Composite key: subject as-is, topic/subtopic as their SLUG (not a
  // plain lowercase) — see this function's own comment above on why
  // slug, specifically, is what must be used here. NUL-separated so a
  // literal '\u0000' can never appear inside a subject/slug and
  // accidentally collide two different triples.
  const countKey = (subject, topicSlug, subtopicSlug) =>
    `${subject}\u0000${topicSlug}\u0000${subtopicSlug}`;
  // Accumulate (not overwrite) — multiple raw MCQ variants can now
  // land on the same slugged key (that's the whole point), and every
  // one of their counts needs to be represented in the total.
  const countsByKey = new Map();
  for (const row of rows) {
    const key = countKey(row._id.subject, slugify(row._id.topic ?? ''), slugify(row._id.subtopic ?? ''));
    const existing = countsByKey.get(key) ?? { ...zeroCounts };
    countsByKey.set(key, {
      total: existing.total + row.total,
      approved: existing.approved + row.approved,
      pending: existing.pending + row.pending,
      rejected: existing.rejected + row.rejected,
    });
  }

  // Group nodes by parent for the tree walk below. 'root' stands in for
  // parent_id: null (subject nodes) since Map can't key on null cleanly
  // alongside ObjectId strings.
  const childrenByParent = new Map();
  for (const node of nodes) {
    const key = node.parent_id ? String(node.parent_id) : 'root';
    if (!childrenByParent.has(key)) childrenByParent.set(key, []);
    childrenByParent.get(key).push(node);
  }
  const byName = (a, b) => a.name.localeCompare(b.name);
  const childrenOf = (parentKey) => (childrenByParent.get(parentKey) ?? []).slice().sort(byName);

  const subjects = childrenOf('root').map((subjectNode) => {
    let subjectTotals = { ...zeroCounts };

    const topics = childrenOf(String(subjectNode._id)).map((topicNode) => {
      let topicTotals = { ...zeroCounts };
      const topicSlug = slugify(topicNode.name);

      const subtopics = childrenOf(String(topicNode._id)).map((subtopicNode) => {
        const counts =
          countsByKey.get(countKey(subjectNode.name, topicSlug, slugify(subtopicNode.name))) ??
          zeroCounts;
        topicTotals = {
          total: topicTotals.total + counts.total,
          approved: topicTotals.approved + counts.approved,
          pending: topicTotals.pending + counts.pending,
          rejected: topicTotals.rejected + counts.rejected,
        };
        // Same fields the pre-P3 subtopic rows carried — total/approved
        // only, no pending/rejected — kept identical for the frontend.
        // `id` (Prompt 16) added on top of that unchanged shape: the
        // Taxonomy Manager's rename/move modals mutate TaxonomyNodes by
        // _id (see taxonomy.service.js's renameTaxonomyNode/moveTopicToSubject/
        // moveSubjectIntoSubject/moveSubtopicToTopic), and this tree —
        // the only client-facing read of the TaxonomyNode collection —
        // previously carried names only. Purely additive; every existing
        // consumer of this shape (reconcileTaxonomy's own re-derivation,
        // the dry-run tree helpers in taxonomy.service.js) ignores the
        // extra key.
        return { id: String(subtopicNode._id), name: subtopicNode.name, total: counts.total, approved: counts.approved };
      });

      subjectTotals = {
        total: subjectTotals.total + topicTotals.total,
        approved: subjectTotals.approved + topicTotals.approved,
        pending: subjectTotals.pending + topicTotals.pending,
        rejected: subjectTotals.rejected + topicTotals.rejected,
      };

      return { id: String(topicNode._id), name: topicNode.name, ...topicTotals, subtopics };
    });

    return { id: String(subjectNode._id), name: subjectNode.name, ...subjectTotals, topics };
  });

  return { subjects };
};

// ─── reconcileTaxonomy (Taxonomy P3) ────────────────────────────────
// Read-only drift check between TaxonomyNode (the structure
// getTaxonomy() now renders) and MCQ (still the actual source of truth
// for every question's subject/topic/subtopic). Flags, never fixes:
//
// 1. `orphan_mcq_triples` — a distinct (subject, topic, subtopic)
//    combination that exists on at least one MCQ but has no matching
//    TaxonomyNode chain. These MCQs are invisible in getTaxonomy()'s
//    tree today (see that function's own comment on this).
// 2. `empty_taxonomy_nodes` — a TaxonomyNode (any level) with zero
//    MCQs under it. Not necessarily wrong (an admin may have added a
//    node ahead of any MCQs existing for it yet), just worth surfacing.
//
// Matching rules mirror getTaxonomy() exactly: subject compared as-is,
// topic/subtopic compared case-insensitively.
export const reconcileTaxonomy = async () => {
  const [{ subjects }, mcqTriples] = await Promise.all([
    // Reuse getTaxonomy() itself rather than re-deriving the tree+counts
    // a second time — same "don't disagree with the rest of the app"
    // reasoning seedTaxonomyFromMcqs.js's own header comment gives for
    // reusing it.
    getTaxonomy(),
    MCQ.aggregate([
      { $group: { _id: { subject: '$subject', topic: '$topic', subtopic: '$subtopic' } } },
    ]),
  ]);

  const emptyTaxonomyNodes = [];
  for (const subject of subjects) {
    if (subject.total === 0) emptyTaxonomyNodes.push({ type: 'subject', subject: subject.name });
    for (const topic of subject.topics) {
      if (topic.total === 0) {
        emptyTaxonomyNodes.push({ type: 'topic', subject: subject.name, topic: topic.name });
      }
      for (const subtopic of topic.subtopics) {
        if (subtopic.total === 0) {
          emptyTaxonomyNodes.push({
            type: 'subtopic',
            subject: subject.name,
            topic: topic.name,
            subtopic: subtopic.name,
          });
        }
      }
    }
  }

  const orphanMcqTriples = [];
  for (const row of mcqTriples) {
    const { subject: subjectName, topic, subtopic } = row._id;
    const subjectEntry = subjects.find((s) => s.name === subjectName);
    // slugify — not toLowerCase — matching getTaxonomy()'s own count
    // join and TaxonomyNode's actual {type, parent_id, slug}
    // uniqueness. A toLowerCase-only comparison here would flag an
    // MCQ as a false-positive "orphan" any time its topic/subtopic
    // differs from the node's stored display name only by whitespace
    // or punctuation — it isn't actually orphaned, TaxonomyNode
    // already has a node for it, this comparison just wasn't using
    // the same normalization that node was created with.
    const topicEntry = subjectEntry?.topics.find(
      (t) => slugify(t.name) === slugify(topic ?? '')
    );
    const subtopicEntry = topicEntry?.subtopics.find(
      (st) => slugify(st.name) === slugify(subtopic ?? '')
    );
    if (!subtopicEntry) {
      orphanMcqTriples.push({ subject: subjectName, topic: topic ?? '', subtopic: subtopic ?? '' });
    }
  }

  return {
    orphan_mcq_triples: orphanMcqTriples,
    empty_taxonomy_nodes: emptyTaxonomyNodes,
    orphan_count: orphanMcqTriples.length,
    empty_count: emptyTaxonomyNodes.length,
    is_clean: orphanMcqTriples.length === 0 && emptyTaxonomyNodes.length === 0,
  };
};

// ─── bulkReassignTopic (Prompt 109) ─────────────────────────────────
// Renames/reassigns a topic or subtopic across every MCQ currently
// tagged with it — the Taxonomy Manager's fix for "a bulk import
// mistagged 200 MCQs and there's no way to correct that except one row
// at a time via PATCH /:id".
//
// `subject` matches exactly (not case-insensitively) — deliberately
// different from `from_topic`/`from_subtopic` below. Subject comes
// from a fixed list (SubjectTopicPicker / blueprint subjects), never
// free-typed, so unlike topic/subtopic it was never at risk of the
// casing-drift problem the regex match exists to paper over.
//
// Matching: `from_subtopic` present (including '', the "(none)"
// bucket) narrows the match to that exact subtopic under from_topic —
// a subtopic-level rename. `from_subtopic` absent (null/undefined)
// matches every MCQ under subject+from_topic regardless of subtopic —
// a topic-level rename. Either way, `to_subtopic` present (including
// '') overwrites subtopic on every matched row; absent leaves each
// row's existing subtopic untouched. This one filter/update pair
// covers both rename shapes the validator's docstring describes —
// see bulkReassignTopicSchema in mcq.validator.js.
export const bulkReassignTopic = async ({
  subject,
  from_topic: fromTopic,
  to_topic: toTopic,
  from_subtopic: fromSubtopic,
  to_subtopic: toSubtopic,
}) => {
  const matchFilter = { subject, ...topicMatchFilter(fromTopic) };
  if (fromSubtopic !== undefined && fromSubtopic !== null) {
    Object.assign(matchFilter, subtopicMatchFilter(fromSubtopic));
  }

  const update = { topic: toTopic.trim() };
  if (toSubtopic !== undefined && toSubtopic !== null) {
    update.subtopic = toSubtopic.trim();
  }

  const result = await MCQ.updateMany(matchFilter, { $set: update });

  return {
    matched_count: result.matchedCount ?? result.n ?? 0,
    modified_count: result.modifiedCount ?? result.nModified ?? 0,
  };
};

// `excludeId` mirrors the same dual-identifier support as findById/
// updateMcq above — its one caller (mcq.controller.js's updateMcq,
// checking "is this edit's new question text a duplicate of some OTHER
// MCQ") now passes through whatever `req.params.id` was, which since
// the updateMcq fix above can be a `question_id` string just as often
// as a Mongo `_id`. Building `{ _id: { $ne: excludeId } }`
// unconditionally would throw a CastError the moment excludeId isn't a
// valid ObjectId — which, worse, would surface as an edit to an
// UNCHANGED question's own text failing with a 500, since that
// question always "matches itself" and the exclusion is exactly what's
// supposed to prevent that false positive.
export const checkDuplicateQuestion = async (questionText, excludeId = null) => {
  const filter = { question: questionText.trim() };
  if (excludeId) {
    Object.assign(
      filter,
      mongoose.isValidObjectId(excludeId)
        ? { _id: { $ne: excludeId } }
        : { question_id: { $ne: excludeId } }
    );
  }
  const existing = await MCQ.findOne(filter);
  return !!existing;
};

// ─── Taxonomy operation re-exports (Prompt 11 — Feature 14) ─────────
// Every TaxonomyNode-mutating operation (rename, the three reparenting
// movers, merge, delete) and their shared move-validation helper used
// to be defined inline in this file (Prompts 4-9). Prompt 11
// consolidated all of them into taxonomy.service.js behind one shared
// `withTaxonomyTransaction` session lifecycle — see that file's own
// header comment for why. Re-exported here, unchanged, purely so
// existing importers of these names from mcq.service.js (mcq.
// controller.js, taxonomy.controller.js, the taxonomy validators, and
// verify_move_subtopic_and_shared_validator.mjs's own
// `validateTaxonomyMove` import) keep working without every call site
// needing to be repointed at the new file.
export {
  validateTaxonomyMove,
  renameTaxonomyNode,
  moveTopicToSubject,
  moveSubjectIntoSubject,
  moveSubtopicToTopic,
  mergeTaxonomyNodes,
  deleteTaxonomyNode,
  previewTaxonomyMerge,
  previewTaxonomyDelete,
  // Prompt 13 — the shared count-recalculation engine every operation
  // above now calls as the last step inside its own transaction.
  recalculateTaxonomyCounts,
  // Prompt 20 (Bulk Select, Feature 12) — the bulk counterparts of the
  // three movers + delete above, each running its single-node sibling
  // once per selected node inside ONE shared transaction. See these
  // functions' own header comment in taxonomy.service.js.
  bulkMoveTopicsToSubject,
  bulkMoveSubjectsIntoSubject,
  bulkMoveSubtopicsToTopic,
  bulkDeleteTaxonomyNodes,
  previewTaxonomyDeleteBulk,
} from './taxonomy.service.js';
