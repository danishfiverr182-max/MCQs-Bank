import MCQ from '../models/MCQ.js';
import ApiError from '../utils/ApiError.js';
import { normalizeQuestion, levenshteinSimilarity } from '../utils/duplicateDetector.js';

// similarity.service.js — Phase 8, Prompt 82.
//
// The single shared entry point for similarity scoring across the
// whole system. Built directly on top of Phase 4's existing
// duplicateDetector.js primitives (normalizeQuestion,
// levenshteinSimilarity) rather than reimplementing edit-distance
// scoring a second time — both the import-time near-duplicate check
// (Phase 4) and everything in Phase 8 (the QA pipeline, and any future
// on-demand "find similar" feature) now converge on this one function
// for scoring, so a pair of questions can never score differently
// depending on which feature asked.

// ─── computeSimilarity ────────────────────────────────────────────
// Thin public wrapper: normalize both strings with the SAME normalizer
// Phase 4 uses (so "What is  Pakistan's capital?" and
// "what is pakistans capital" collapse identically here as they do at
// import time), then hand off to the shared Levenshtein implementation.
//
// This is the ONLY function anything outside this file should call to
// score similarity — never call levenshteinSimilarity directly from
// outside this service, or normalization could silently drift out of
// sync between callers.
export const computeSimilarity = (str1, str2) => {
  const normalized1 = normalizeQuestion(str1);
  const normalized2 = normalizeQuestion(str2);
  const rawScore = levenshteinSimilarity(normalized1, normalized2);
  return Math.round(rawScore);
};

// Deliberately LOWER than Phase 4's import-time default (85). Import-
// time near-duplicate detection is trying to catch likely real
// duplicates before they enter the bank — a stricter bar keeps false
// positives (two genuinely different questions on the same fact) from
// blocking a legitimate import. findSimilarInDatabase, by contrast, is
// an on-demand exploratory tool an admin reaches for deliberately
// ("show me anything moderately similar to this one") — a looser bar
// is the right default for that use case, and the admin reviewing the
// results is the final filter, not this function. This is an
// intentional difference in defaults between the two call sites, not
// an inconsistency to reconcile.
const DEFAULT_THRESHOLD = 70;
const DEFAULT_LIMIT = 20;

// ─── findSimilarInDatabase ─────────────────────────────────────────
// Props:
// - question_id: the MCQ to find similar questions FOR.
// - options.threshold: minimum score to include (default 70, see
//   comment above).
// - options.limit: max results returned, sorted score descending
//   (default 20).
//
// Returns [{ mcq: { question_id, question, options, subject, difficulty }, score }].
export const findSimilarInDatabase = async (question_id, options = {}) => {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const target = await MCQ.findOne({ question_id }).lean();
  if (!target) {
    throw new ApiError(404, `MCQ not found: ${question_id}`);
  }

  // Same scoping discipline as Phase 4's findNearDuplicates: only ever
  // compare within the same subject, never brute-force the whole
  // collection — both for correctness ("similar question" is a
  // same-subject concept) and to keep the comparison pool bounded at
  // scale. Projected down to just what's needed for scoring + display,
  // same query-projection discipline Phases 4/5 already follow.
  const candidates = await MCQ.find(
    {
      subject: target.subject,
      status: 'approved',
      question_id: { $ne: target.question_id },
    },
    { question_id: 1, question: 1, options: 1, subject: 1, difficulty: 1 }
  ).lean();

  const scored = candidates
    .map((candidate) => ({
      mcq: {
        question_id: candidate.question_id,
        question: candidate.question,
        options: candidate.options,
        subject: candidate.subject,
        difficulty: candidate.difficulty,
      },
      score: computeSimilarity(target.question, candidate.question),
    }))
    .filter((entry) => entry.score >= threshold);

  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
};
