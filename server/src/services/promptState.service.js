import PromptState from '../models/PromptState.js';
import { PROMPT_TEMPLATE } from '../constants/mcqConversionPromptTemplate.js';
import { slugify } from '../utils/slugify.js';
import { logger } from '../utils/logger.js';
import ApiError from '../utils/ApiError.js';

// ─── buildPromptText ────────────────────────────────────────────
// Pure function: no DB access, no side effects. Takes a PromptState-
// shaped object (a live Mongoose doc or a plain object both work, since
// only .range_start/.range_end/.subtopic_bank are read) and fills in
// PROMPT_TEMPLATE's three tokens. Kept separate from getPromptState so
// callers that already have a state in hand (e.g. right after
// advanceRange()) can rebuild the prompt text without a round trip.
export const buildPromptText = (state) => {
  const bankList = (state.subtopic_bank || []).map((name) => `- ${name}`).join('\n');

  return PROMPT_TEMPLATE.replace(/{{RANGE_START}}/g, String(state.range_start))
    .replace(/{{RANGE_END}}/g, String(state.range_end))
    .replace('{{SUBTOPIC_BANK_LIST}}', bankList);
};

// ─── getPromptState ─────────────────────────────────────────────
// The read path for the feature's UI: fetches (and, on first-ever call,
// seeds) the singleton doc, then attaches the ready-to-copy promptText
// alongside it so the caller never has to call buildPromptText itself.
export const getPromptState = async () => {
  const state = await PromptState.getOrCreate();
  return {
    ...state.toObject(),
    promptText: buildPromptText(state),
  };
};

// ─── mergeSubtopicsIntoBank ──────────────────────────────────────
// Best-effort, no-throw — same spirit as import.service.js's
// ensureTaxonomyForInsertedDocs: this runs as a side effect of an
// import that has ALREADY succeeded, so a failure here must never be
// allowed to look like an import failure. Adds each name in
// newSubtopics to subtopic_bank only if its slug doesn't already match
// an existing bank entry (reusing the same slugify used by
// TaxonomyNode's own uniqueness scoping, so "Rivers & Dams" and
// "rivers-and-dams" are treated as the same entry). Never removes,
// never reorders what's already there — new names are appended in the
// order given.
export const mergeSubtopicsIntoBank = async (newSubtopics = []) => {
  if (!Array.isArray(newSubtopics) || newSubtopics.length === 0) return;

  try {
    const state = await PromptState.getOrCreate();
    const existingSlugs = new Set(state.subtopic_bank.map((name) => slugify(name)));
    const toAdd = [];

    for (const name of newSubtopics) {
      const trimmed = String(name ?? '').trim();
      if (!trimmed) continue;
      const slug = slugify(trimmed);
      if (existingSlugs.has(slug)) continue;
      existingSlugs.add(slug);
      toAdd.push(trimmed);
    }

    if (toAdd.length === 0) return;

    await PromptState.updateOne(
      { _id: 'mcq_conversion_prompt' },
      { $push: { subtopic_bank: { $each: toAdd } } }
    );
  } catch (err) {
    logger.warn(`mergeSubtopicsIntoBank: failed to merge subtopics into bank: ${err.message}`);
  }
};

// ─── advanceRange ────────────────────────────────────────────────
// Best-effort, no-throw — called once per successfully-completed
// import (see import.service.js's runImportPipeline hook) to roll the
// "MCQ Number N to N+batch_size-1" window forward automatically, so
// the human doesn't have to update it by hand between batches. Wraps
// back to 1 once the window would run past total_cap.
export const advanceRange = async () => {
  try {
    const state = await PromptState.getOrCreate();

    let newStart = state.range_end + 1;
    if (newStart > state.total_cap) {
      newStart = 1;
    }
    const newEnd = Math.min(newStart + state.batch_size - 1, state.total_cap);

    const updated = await PromptState.findOneAndUpdate(
      { _id: 'mcq_conversion_prompt' },
      { $set: { range_start: newStart, range_end: newEnd } },
      { new: true }
    );

    return updated;
  } catch (err) {
    logger.warn(`advanceRange: failed to advance prompt range: ${err.message}`);
    return null;
  }
};

// ─── updateSettings ──────────────────────────────────────────────
// NOT best-effort — this is a direct, admin-initiated settings change
// (unlike the auto-advance hooks above), so validation failures should
// surface to the caller as a real 400, same as any other admin-facing
// write in this codebase (see ApiError usage throughout
// import.service.js/mcq.service.js).
export const updateSettings = async ({ batchSize, totalCap } = {}) => {
  const updates = {};

  if (batchSize !== undefined) {
    if (!Number.isInteger(batchSize) || batchSize <= 0) {
      throw new ApiError(400, 'batchSize must be a positive integer');
    }
    updates.batch_size = batchSize;
  }

  if (totalCap !== undefined) {
    if (!Number.isInteger(totalCap) || totalCap <= 0) {
      throw new ApiError(400, 'totalCap must be a positive integer');
    }
    updates.total_cap = totalCap;
  }

  if (Object.keys(updates).length === 0) {
    return PromptState.getOrCreate();
  }

  const current = await PromptState.getOrCreate();
  const effectiveBatchSize = updates.batch_size ?? current.batch_size;
  const effectiveTotalCap = updates.total_cap ?? current.total_cap;

  if (effectiveTotalCap < effectiveBatchSize) {
    throw new ApiError(400, 'totalCap must be greater than or equal to batchSize');
  }

  const updated = await PromptState.findOneAndUpdate(
    { _id: 'mcq_conversion_prompt' },
    { $set: updates },
    { new: true, upsert: true }
  );

  return updated;
};

// ─── resetRange ───────────────────────────────────────────────────
// A manual override for when the range needs to be redone or restarted
// against a new source PDF, rather than advanced automatically. Not
// best-effort — this is a deliberate admin action, so a failure here
// should surface, not be swallowed.
export const resetRange = async ({ rangeStart } = {}) => {
  const state = await PromptState.getOrCreate();

  const newStart = rangeStart ?? 1;
  const newEnd = Math.min(newStart + state.batch_size - 1, state.total_cap);

  const updated = await PromptState.findOneAndUpdate(
    { _id: 'mcq_conversion_prompt' },
    { $set: { range_start: newStart, range_end: newEnd } },
    { new: true, upsert: true }
  );

  return updated;
};
