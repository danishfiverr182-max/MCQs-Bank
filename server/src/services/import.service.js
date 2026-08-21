import mongoose from 'mongoose';
import { z } from 'zod';
import ApiError from '../utils/ApiError.js';
import { detectDuplicates, hashContentFingerprint } from '../utils/duplicateDetector.js';
import Counter from '../models/Counter.js';
import TaxonomyNode from '../models/TaxonomyNode.js';
import { slugify } from '../utils/slugify.js';
import { logger } from '../utils/logger.js';
import { ensureTaxonomyNodesExist } from './mcq.service.js';
import { mergeSubtopicsIntoBank, advanceRange } from './promptState.service.js';

// ─── ensureTaxonomyForInsertedDocs ────────────────────────────────
// Same gap as createMcq/updateMcq in mcq.service.js (see
// ensureTaxonomyNodesExist's own comment there): insertMany() never
// touched TaxonomyNode, so an import introducing a genuinely new
// subject/topic/subtopic combination would insert the MCQs fine but
// leave them invisible in the Taxonomy Manager. Deduped to one upsert
// call per DISTINCT triple in the batch (an import is typically a
// handful of subjects/topics, not one per row), and best-effort —
// a node-creation hiccup here must never undo an otherwise-successful
// MCQ insert, so failures are logged and swallowed rather than thrown.
//
// Also the source of truth for the Import page's "New Subtopics From
// This Import" feature. Two layers of "is this genuinely new?":
//
//   1. Per-node: ensureTaxonomyNodesExist reports whether its subtopic
//      upsert genuinely inserted a new TaxonomyNode under that specific
//      Topic, vs. matching one that already existed there.
//   2. Per-name, across the WHOLE system: TaxonomyNode's unique index
//      is deliberately {type, parent_id, slug} — Subtopic identity is
//      scoped under its parent Topic (see TaxonomyNode.js), so the
//      SAME subtopic text reused under a different Topic legitimately
//      creates a separate node there. That's correct for the Taxonomy
//      Manager's tree (and everything taxonomy.service.js's
//      rename/move/merge tooling assumes about it) — but it means a
//      layer-1 "created" alone would make the same subtopic TEXT
//      resurface as "new" every time it's tagged under yet another
//      Topic, which defeats the point of a copy-paste, prompt-ready
//      vocabulary. So after collecting layer-1 candidates, we drop any
//      whose slug already existed on some OTHER subtopic node — under
//      any Topic — before this import ran. This never touches the DB
//      write itself (the Topic-scoped node above still gets created
//      exactly as before); it only changes what this function reports
//      as "new" to the copy-paste feature.
//
// Returns the deduped list of newly created subtopic display names for
// THIS call's batch of docs only — never all of MongoDB's subtopics.
// The blank '' subtopic ("(none)" bucket) is intentionally never
// reported here since it isn't a real, prompt-worthy subtopic name.
const ensureTaxonomyForInsertedDocs = async (docs) => {
  const seen = new Set();
  // { name, id } for every subtopic node THIS call's upserts genuinely
  // created (layer 1) — filtered down to layer 2 below.
  const createdCandidates = [];

  for (const doc of docs) {
    const key = `${doc.subject}\u0000${doc.topic ?? ''}\u0000${doc.subtopic ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await ensureTaxonomyNodesExist({
        subject: doc.subject,
        topic: doc.topic,
        subtopic: doc.subtopic,
      });
      const subtopicName = (doc.subtopic ?? '').trim();
      if (result?.subtopicCreated && subtopicName) {
        createdCandidates.push({ name: subtopicName, id: result.subtopicId });
      }
    } catch (err) {
      logger.warn(
        `ensureTaxonomyForInsertedDocs: failed to upsert TaxonomyNode for ` +
          `subject="${doc.subject}" topic="${doc.topic}" subtopic="${doc.subtopic}": ${err.message}`
      );
    }
  }

  if (createdCandidates.length === 0) return [];

  // Layer 2: was this subtopic TEXT already known under some OTHER
  // Topic before this import? One query for the whole batch (not one
  // per candidate), excluding the nodes we just created ourselves.
  const candidateSlugs = [...new Set(createdCandidates.map((c) => slugify(c.name)))];
  const createdIds = createdCandidates.map((c) => c.id).filter(Boolean);
  let priorSlugs = new Set();
  try {
    const priorMatches = await TaxonomyNode.find({
      type: 'subtopic',
      slug: { $in: candidateSlugs },
      _id: { $nin: createdIds },
    })
      .select('slug')
      .lean();
    priorSlugs = new Set(priorMatches.map((n) => n.slug));
  } catch (err) {
    // Best-effort, same spirit as the upsert loop above: if this
    // lookup fails, fall back to reporting every layer-1 candidate
    // rather than losing the "new subtopics" signal entirely.
    logger.warn(`ensureTaxonomyForInsertedDocs: prior-slug lookup failed: ${err.message}`);
  }

  const newSubtopics = new Set();
  for (const candidate of createdCandidates) {
    if (!priorSlugs.has(slugify(candidate.name))) {
      newSubtopics.add(candidate.name);
    }
  }

  return Array.from(newSubtopics);
};

// ─── parseJSON ──────────────────────────────────────────────────
// Turns a raw upload Buffer into a plain array of row objects.
// Pure function: no req/res, no DB. Throws ApiError on anything
// that isn't usable input, so the caller (controller) doesn't need
// its own try/catch around JSON.parse.
export const parseJSON = (buffer) => {
  let parsed;

  try {
    parsed = JSON.parse(buffer.toString('utf-8'));
  } catch (err) {
    throw new ApiError(400, 'Uploaded file is not valid JSON');
  }

  // Accept either a bare array, or { questions: [...] } — normalize
  // both to a plain array before returning.
  let rawQuestions;
  if (Array.isArray(parsed)) {
    rawQuestions = parsed;
  } else if (parsed && Array.isArray(parsed.questions)) {
    rawQuestions = parsed.questions;
  } else {
    rawQuestions = null;
  }

  if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) {
    throw new ApiError(400, 'No questions found in uploaded file');
  }

  return rawQuestions;
};

// ─── Row schema ─────────────────────────────────────────────────
// Mirrors the MCQ model/spec. Deliberately permissive on optional
// fields (topic, subtopic, exam_tags, cognitive_level, quality_score)
// since bulk import sources vary in how complete their data is —
// the create/edit forms remain the strict, fully-required path.
// Maps classic Bloom's Taxonomy naming (used by many question banks/
// generators) to this app's Revised Bloom's Taxonomy enum — see
// server/src/models/MCQ.js: ['recall', 'understanding', 'application',
// 'analysis']. Without this, a row like cognitive_level: "comprehension"
// passes THIS Zod schema fine (previously just z.string(), no enum
// check) but then fails Mongoose's stricter model-level enum
// validation at insert time — and since insertValid now runs inside
// runImportPipeline's transaction, one bad value like this took the
// ENTIRE import down with it ("Insert failed for N row(s)").
const COGNITIVE_LEVEL_ALIASES = {
  knowledge: 'recall',
  recall: 'recall',
  remembering: 'recall',
  comprehension: 'understanding',
  understanding: 'understanding',
  application: 'application',
  applying: 'application',
  analysis: 'analysis',
  analyzing: 'analysis',
  // Classic Bloom's has two tiers above this app's top level — no 1:1
  // equivalent in a 4-level scale, so they map to the closest/highest
  // available level rather than being rejected outright.
  synthesis: 'analysis',
  evaluation: 'analysis',
  evaluating: 'analysis',
  creating: 'analysis',
};

const normalizeCognitiveLevel = (value) => {
  const key = String(value ?? '').trim().toLowerCase();
  return COGNITIVE_LEVEL_ALIASES[key] ?? 'recall'; // unrecognized -> safe default, never throws
};

const mcqRowSchema = z.object({
  question: z.string().trim().min(10, 'Question must be at least 10 characters'),
  options: z.object({
    A: z.string().trim().min(1, 'Option A is required'),
    B: z.string().trim().min(1, 'Option B is required'),
    C: z.string().trim().min(1, 'Option C is required'),
    D: z.string().trim().min(1, 'Option D is required'),
  }),
  correct_answer: z.enum(['A', 'B', 'C', 'D'], {
    errorMap: () => ({ message: 'correct_answer must be one of A, B, C, D' }),
  }),
  subject: z.string().trim().min(1, 'Subject is required'),
  topic: z.string().trim().optional().default(''),
  subtopic: z.string().trim().optional().default(''),
  difficulty: z.enum(['easy', 'medium', 'hard'], {
    errorMap: () => ({ message: 'difficulty must be one of easy, medium, hard' }),
  }),
  exam_tags: z.array(z.string().trim()).optional().default([]),
  cognitive_level: z.string().trim().optional().default('recall').transform(normalizeCognitiveLevel),
  quality_score: z.coerce.number().min(0).max(100).optional().default(0),
  explanation: z.string().trim().optional().default(''),
});

// ─── validateEachMCQ ────────────────────────────────────────────
// Validates every row independently — one malformed row must never
// abort the whole batch. Returns a full report rather than throwing,
// so the controller can decide what to do with partial success.
export const validateEachMCQ = (rawQuestions) => {
  const valid = [];
  const failed = [];

  rawQuestions.forEach((row, index) => {
    const rowNumber = index + 1;
    const result = mcqRowSchema.safeParse(row);

    if (!result.success) {
      failed.push({
        row: rowNumber,
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
      return;
    }

    // Cross-field check Zod's object shape can't express on its own:
    // correct_answer must point at an option that actually has text.
    const { correct_answer, options } = result.data;
    const correctOptionText = options[correct_answer];

    if (!correctOptionText || correctOptionText.trim().length === 0) {
      failed.push({
        row: rowNumber,
        errors: [
          {
            field: 'correct_answer',
            message: `correct_answer "${correct_answer}" has no matching non-empty option text`,
          },
        ],
      });
      return;
    }

    valid.push({ row: rowNumber, data: result.data });
  });

  return { valid, failed, totalRows: rawQuestions.length };
};

// ─── insertValid ────────────────────────────────────────────────
// cleanRows: [{ row, data }] — the `clean` output of detectDuplicates.
// Bulk-inserts via insertMany({ ordered: false }) so one bad document
// never aborts the rest of the batch, per the DoD.
//
// Zod (validateEachMCQ) and detectDuplicates only know about the
// import row shape — they can't see Mongoose-level constraints like
// the MCQ model's own pre-validate hook (correct_answer must match a
// non-empty option) or schema-level enum/required checks applied at
// save time. Rather than lean on insertMany's own multi-error
// reporting — whose per-document index semantics get murky once some
// documents are skipped for failing validation — each document is
// validated individually first (async `.validate()`, which does run
// the model's pre('validate') hooks, unlike validateSync()). This
// guarantees every error is mapped back to the correct row number.
//
// BUGFIX (root cause of "100 rows detected, 1 inserted"): Mongoose's
// insertMany() intentionally does NOT run document-level 'save'
// middleware. MCQ.js's pre('save') hooks are exactly what generate
// question_id and question_hash. Previously those fields were left
// completely unset on every document handed to insertMany, so every
// row shared the same "missing" value on the unique-indexed
// `question_id` field. MongoDB's unique index treats a missing field
// as null for uniqueness purposes, so only the very first document in
// the batch could insert — every row after it hit an E11000 duplicate
// key error on question_id and was silently swept into insertErrors.
// That produced exactly the observed symptom: "100 rows" detected,
// "1 inserted". Fix: replicate what the pre('save') hooks would have
// done — assign question_hash and a real, unique question_id — on
// each document BEFORE it goes into the insertMany() batch.
export const insertValid = async (cleanRows, MCQModel, sourceBatchId = null, session = null) => {
  if (cleanRows.length === 0) {
    return { insertedCount: 0, insertedIds: [], insertErrors: [], newSubtopics: [] };
  }

  const toInsert = [];
  const insertErrors = [];

  for (const entry of cleanRows) {
    const doc = new MCQModel(entry.data);
    try {
      await doc.validate();

      // insertMany() below skips 'save' middleware, so the model's
      // pre-save hooks (question_hash / question_id assignment) never
      // run for these documents. Set them explicitly here, using the
      // same logic those hooks use, so every inserted document gets a
      // real, unique question_id instead of all of them sharing an
      // unset value that collides on the unique index after the first.
      doc.question_hash = hashContentFingerprint(doc.question, doc.options, doc.correct_answer);
      const seq = await Counter.getNextSequence('mcq_question_id');
      doc.question_id = `Q${String(seq).padStart(5, '0')}`;
      // Tag with the batch that's inserting it — see MCQ.js's
      // source_batch_id comment for why this matters: it's what lets
      // deleteImportBatch cascade-delete these rows if the batch later
      // turns out bad (or the admin just wants to undo an import).
      doc.source_batch_id = sourceBatchId;

      toInsert.push({ row: entry.row, doc });
    } catch (validationError) {
      insertErrors.push({ row: entry.row, error: validationError.message });
    }
  }

  if (toInsert.length === 0) {
    return { insertedCount: 0, insertedIds: [], insertErrors, newSubtopics: [] };
  }

  try {
    const inserted = await MCQModel.insertMany(
      toInsert.map((t) => t.doc),
      { ordered: false, ...(session ? { session } : {}) }
    );
    const newSubtopics = await ensureTaxonomyForInsertedDocs(inserted);
    return {
      insertedCount: inserted.length,
      insertedIds: inserted.map((doc) => doc._id.toString()),
      insertErrors,
      newSubtopics,
    };
  } catch (err) {
    // Partial failure under ordered:false — e.g. a unique index
    // violation on a subset of documents that individually passed
    // schema validation above. Mongoose/MongoDB reports how many
    // actually made it in (`insertedDocs`) plus per-document write
    // errors for the rest.
    const insertedCount = err.insertedDocs?.length ?? 0;
    const insertedIds = (err.insertedDocs || []).map((doc) => doc._id.toString());
    const writeErrors = err.writeErrors || [];

    for (const we of writeErrors) {
      const index = typeof we.index === 'number' ? we.index : we.err?.index;
      const row = toInsert[index]?.row ?? null;
      const message = we.errmsg || we.err?.errmsg || we.message || 'Insert failed';
      insertErrors.push({ row, error: message });
    }

    // Defensive fallback: if the error shape doesn't match what we
    // expect but not everything got inserted, don't silently lose
    // the discrepancy — surface it rather than under-report failures.
    if (writeErrors.length === 0 && insertedCount < toInsert.length) {
      insertErrors.push({ row: null, error: err.message || 'Bulk insert failed' });
    }

    const newSubtopics = await ensureTaxonomyForInsertedDocs(err.insertedDocs || []);

    return { insertedCount, insertedIds, insertErrors, newSubtopics };
  }
};

// ─── buildReport ────────────────────────────────────────────────
// Pure assembly — takes the outputs of every pipeline stage and
// shapes them into the response contract the frontend expects.
export const buildReport = ({
  totalRows,
  failed,
  exact,
  near,
  insertedCount,
  insertedIds = [],
  insertErrors,
  // Newly created Subtopic display names from THIS import's insert
  // pass only (see ensureTaxonomyForInsertedDocs) — empty for a
  // validate_only dry run, since nothing is ever inserted/upserted
  // for one of those. Powers the Import page's "New Subtopics From
  // This Import" section.
  newSubtopics = [],
}) => {
  return {
    total: totalRows,
    inserted: insertedCount,
    // MCQs are inserted with status: 'pending' by design (see
    // mcq.service.js's bulkSetStatus comment) and won't be drawn into a
    // generated test until approved. Surfacing the ids here lets the
    // frontend offer "Approve all N imported MCQs" right after import,
    // via PATCH /api/mcq/bulk-approve, instead of leaving admins to
    // discover the pending-approval gate only when test generation
    // fails with "not enough approved MCQs".
    insertedIds,
    pendingApprovalCount: insertedIds.length,
    failed,
    duplicates: {
      exact,
      near,
    },
    insertErrors,
    newSubtopics,
  };
};

// ─── resolveDuplicateInserts ─────────────────────────────────────
// Second-pass insert for duplicate rows the admin explicitly chose to
// "keep" in DuplicateReview.jsx (Prompt 49/50). Duplicate rows — exact
// or near, regardless of import mode — are NEVER part of the initial
// uploadBulk insert pass (see runImportPipeline below: only
// duplicateResult.clean rows get inserted there), so this is the only
// path that ever inserts a flagged duplicate.
//
// keepDecisions: [{ row, action: 'keep', data }] — `data` travels with
// the decision because this endpoint is stateless between requests; the
// server has no memory of a previous upload's report, so the frontend
// hands back exactly the row data it originally received (which is why
// buildReport/runImportPipeline above now attach `data` to every
// exact/near entry in the first place).
export const resolveDuplicateInserts = async (
  { batchId, keepDecisions = [] },
  MCQModel,
  ImportBatchModel
) => {
  const batch = await ImportBatchModel.findOne({ batch_id: batchId });
  if (!batch) {
    throw new ApiError(404, `Import batch "${batchId}" not found`);
  }

  const cleanRows = keepDecisions
    .filter((decision) => decision?.action === 'keep' && decision?.data)
    .map((decision) => ({ row: decision.row, data: decision.data }));

  if (cleanRows.length === 0) {
    return {
      batch_id: batch.batch_id,
      insertedCount: 0,
      insertedIds: [],
      insertErrors: [],
      totalInsertedCount: batch.inserted_count,
      newSubtopics: [],
    };
  }

  const { insertedCount, insertedIds, insertErrors, newSubtopics = [] } = await insertValid(
    cleanRows,
    MCQModel,
    batch.batch_id
  );

  // Best-effort, mirrors the runImportPipeline hook below — a reviewed
  // "keep" decision can still introduce genuinely new subtopics, so the
  // MCQ Conversion Prompt's subtopic bank should pick those up too.
  // Range only advances once per import (in runImportPipeline itself),
  // not per resolve, so advanceRange is deliberately NOT called here.
  try {
    await mergeSubtopicsIntoBank(newSubtopics);
  } catch (err) {
    logger.warn(`resolveDuplicateInserts: mergeSubtopicsIntoBank failed: ${err.message}`);
  }

  batch.inserted_count += insertedCount;
  // A "keep" decision on a reviewed duplicate can, in rare cases,
  // still introduce a genuinely new Subtopic (e.g. a near-duplicate
  // that was deliberately kept despite similar wording). Fold any such
  // names into the batch's persisted new_subtopics list — same dedup-
  // by-name semantics as the initial insert pass — so the Import page
  // reflects the batch's full picture, not just its first pass.
  if (newSubtopics.length > 0) {
    const merged = new Set([...(batch.new_subtopics || []), ...newSubtopics]);
    batch.new_subtopics = Array.from(merged);
  }
  await batch.save();

  return {
    batch_id: batch.batch_id,
    insertedCount,
    insertedIds,
    insertErrors,
    totalInsertedCount: batch.inserted_count,
    newSubtopics,
  };
};

// ─── deleteImportBatch ────────────────────────────────────────────
// Deletes an ImportBatch history row AND cascades to every MCQ that
// batch ever inserted (matched via MCQ.js's source_batch_id — see
// insertValid above). With the transactional rewrite of
// runImportPipeline, a genuinely FAILED import no longer leaves any
// batch row or MCQs behind at all — so this function's main remaining
// jobs are: (1) cleaning up any orphaned data from before that fix,
// and (2) letting an admin intentionally undo a COMPLETED import they
// no longer want, removing its history row and MCQs together in one
// action so a corrected re-upload of the same file won't come back
// flagged as "all duplicates" against rows nobody could otherwise
// find.
export const deleteImportBatch = async (batchId, MCQModel, ImportBatchModel) => {
  const batch = await ImportBatchModel.findOne({ batch_id: batchId });
  if (!batch) {
    throw new ApiError(404, `Import batch "${batchId}" not found`);
  }

  const mcqResult = await MCQModel.deleteMany({ source_batch_id: batchId });
  await ImportBatchModel.deleteOne({ _id: batch._id });

  logger.info(
    `[import] Deleted batch ${batchId} (was status=${batch.status}) and ` +
      `${mcqResult.deletedCount} associated MCQ(s)`
  );

  return { batch_id: batchId, deletedMcqCount: mcqResult.deletedCount };
};

// ─── runImportPipeline ──────────────────────────────────────────
// Orchestrates the full pipeline: parse → validate → duplicate-check
// → (insert mode only) insert, and records an ImportBatch — but ONLY
// once the run has genuinely finished successfully. Includes
// "validate only" dry runs, so a clean dry run still shows up in
// import history with inserted_count: 0.
//
// BUGFIX #2 ("failed imports still show up in Import History, and
// their MCQs still count as duplicates on the next retry"): the
// previous version (see the transaction-free history of this
// function) always created the ImportBatch document FIRST, before any
// processing, then updated that SAME document to 'failed' on error —
// which correctly made a failed batch's MCQs findable/cascade-
// deletable via deleteImportBatch, but still left both a 'failed'
// history row AND any MCQs inserted-before-the-failure sitting in the
// database until an admin noticed and manually deleted the batch. In
// the gap before that manual cleanup, a retried import would
// correctly (from MongoDB's perspective) flag those leftover rows as
// duplicates and skip them — so even a genuinely successful retry
// could come back showing most/all rows as "duplicate" and not
// actually insert them, exactly the symptom reported: "successful
// MCQs are shown as duplicate due to previous failed files."
//
// Fix: wrap the ENTIRE pipeline — schema validation, duplicate
// detection, the insert, AND the ImportBatch write itself — in one
// MongoDB transaction (Atlas replica sets support this even on the
// free M0 tier). Every read/write below MUST be run WITH { session }
// wherever schema/DB access happens, so it is included in the atomic
// unit. If anything throws for any reason (bad JSON, a genuine
// MongoDB connectivity blip mid-batch, etc.), the transaction aborts
// and MongoDB guarantees NOTHING from this run persists — no MCQs, no
// ImportBatch row. There is nothing left to clean up and nothing left
// behind to falsely trip duplicate-detection on the next attempt.
//
// NOTE: MCQ question_id and this ImportBatch's own batch_id are both
// generated via Counter.getNextSequence, which is deliberately NOT
// part of the transaction (see Counter.js's own "gap-tolerant"
// comment) — if a transaction aborts, those sequence numbers are
// simply skipped forever rather than reused. That's an intentional,
// harmless tradeoff (the same way SQL auto-increment columns behave
// under a rolled-back transaction), not a bug.
export const runImportPipeline = async (
  buffer,
  { mode, filename, adminId },
  MCQModel,
  ImportBatchModel
) => {
  // Parsing happens BEFORE the transaction even starts — malformed
  // JSON or an empty file is a pure input-format problem, nothing to
  // do with the database, so there's no reason to open a session for
  // it at all.
  const rawQuestions = parseJSON(buffer);
  const totalRows = rawQuestions.length;
  logger.info(`[import] ${filename}: detected ${totalRows} row(s), mode=${mode}`);

  const session = await mongoose.startSession();
  let batch;
  let report;

  try {
    await session.withTransaction(async () => {
      const validationResult = validateEachMCQ(rawQuestions);
      const failed = validationResult.failed;
      logger.info(
        `[import] ${filename}: schema-valid=${validationResult.valid.length} ` +
          `schema-failed=${failed.length}`
      );
      failed.forEach((f) =>
        logger.info(
          `[import]   row ${f.row} SKIPPED (validation): ` +
            f.errors.map((e) => `${e.field}: ${e.message}`).join('; ')
        )
      );

      // Read-only — duplicate detection deliberately runs outside the
      // session. It only needs to see already-committed data (which is
      // exactly what a non-transactional read gives it), and this run's
      // own inserts haven't happened yet at this point regardless.
      const duplicateResult = await detectDuplicates(validationResult.valid, MCQModel);

      const validDataByRow = new Map(validationResult.valid.map((entry) => [entry.row, entry.data]));
      const exact = duplicateResult.exact.map((entry) => ({ ...entry, data: validDataByRow.get(entry.row) }));
      const near = duplicateResult.near.map((entry) => ({ ...entry, data: validDataByRow.get(entry.row) }));
      logger.info(
        `[import] ${filename}: exact-duplicates=${exact.length} near-duplicates=${near.length} ` +
          `clean-for-insert=${duplicateResult.clean.length}`
      );
      exact.forEach((d) =>
        logger.info(
          `[import]   row ${d.row} SKIPPED (exact duplicate, source=${d.source}` +
            `${d.existingQuestionId ? `, matches ${d.existingQuestionId}` : ''})`
        )
      );
      near.forEach((d) =>
        logger.info(
          `[import]   row ${d.row} SKIPPED (near duplicate, ${d.similarity}% similar, source=${d.source}` +
            `${d.existingQuestionId ? `, matches ${d.existingQuestionId}` : ''})`
        )
      );

      // batch_id assigned up front (same scheme as the old pre-save
      // hook) so it can tag each inserted MCQ's source_batch_id BEFORE
      // the ImportBatch document itself is created below.
      const year = new Date().getFullYear();
      const seq = await Counter.getNextSequence(`import_batch_${year}`);
      const batchId = `IMPORT_${year}_${String(seq).padStart(4, '0')}`;

      let insertedCount = 0;
      let insertedIds = [];
      let insertErrors = [];
      let newSubtopics = [];

      if (mode === 'insert' && duplicateResult.clean.length > 0) {
        const insertResult = await insertValid(duplicateResult.clean, MCQModel, batchId, session);
        insertedCount = insertResult.insertedCount;
        insertedIds = insertResult.insertedIds;
        insertErrors = insertResult.insertErrors;
        newSubtopics = insertResult.newSubtopics ?? [];
        insertErrors.forEach((e) =>
          logger.error(`[import]   row ${e.row ?? '?'} SKIPPED (insert error): ${e.error}`)
        );

        // Any insert error here means insertMany couldn't cleanly place
        // every clean row (e.g. a genuine mid-batch connectivity issue,
        // not an expected duplicate — those were already filtered out
        // above). Inside a transaction, a partial insert is not a state
        // we want to keep: throw so the whole transaction aborts rather
        // than persisting an inconsistent "some rows silently missing"
        // result.
        if (insertErrors.length > 0) {
          throw new ApiError(
            500,
            `Insert failed for ${insertErrors.length} row(s) — rolling back the whole import so nothing is left half-inserted.`,
            insertErrors.map((e) => `Row ${e.row ?? '?'}: ${e.error}`)
          );
        }
      }

      logger.info(
        `[import] ${filename}: SUMMARY total=${totalRows} inserted=${insertedCount} ` +
          `skipped=${totalRows - insertedCount} ` +
          `(validation=${failed.length}, duplicates=${exact.length + near.length}, ` +
          `awaitingDuplicateReview=${mode === 'insert' ? exact.length + near.length : 0})`
      );

      report = buildReport({
        totalRows,
        failed,
        exact,
        near,
        insertedCount,
        insertedIds,
        insertErrors: [],
        newSubtopics,
      });

      const [batchDoc] = await ImportBatchModel.create(
        [
          {
            batch_id: batchId,
            filename,
            uploaded_by: adminId,
            mode,
            status: 'completed',
            total_rows: totalRows,
            inserted_count: insertedCount,
            failed_count: failed.length,
            exact_duplicate_count: exact.length,
            near_duplicate_count: near.length,
            new_subtopics: newSubtopics,
          },
        ],
        { session }
      );
      batch = batchDoc;
    });
  } catch (err) {
    // withTransaction already aborted everything — no MCQs, no
    // ImportBatch document. Nothing to clean up, nothing left behind
    // for a retry to trip over.
    logger.error(`[import] ${filename}: pipeline FAILED and was fully rolled back: ${err.message}`);
    throw err;
  } finally {
    await session.endSession();
  }

  // MCQ Conversion Prompt auto-advance (purely additive — see
  // promptState.service.js). The import has already committed
  // successfully at this point (the transaction above either fully
  // succeeded or threw and was rethrown), so these run outside any
  // transaction and are each independently best-effort: a failure here
  // must never turn a successful import into a failed one.
  if (mode === 'insert') {
    try {
      await mergeSubtopicsIntoBank(report.newSubtopics ?? []);
    } catch (err) {
      logger.warn(`runImportPipeline: mergeSubtopicsIntoBank failed: ${err.message}`);
    }
    try {
      await advanceRange();
    } catch (err) {
      logger.warn(`runImportPipeline: advanceRange failed: ${err.message}`);
    }
  }

  return { ...report, batch_id: batch.batch_id };
};
