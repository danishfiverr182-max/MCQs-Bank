import crypto from 'crypto';

// ─────────────────────────────────────────────────────────────────
// SCHEMA DEPENDENCY — read before touching this file
// ─────────────────────────────────────────────────────────────────
// findExactDuplicates() assumes every MCQ document has a precomputed,
// indexed `question_hash` field so exact-match lookups are a single
// indexed $in query instead of re-normalizing/re-hashing 1M+ documents
// on every import.
//
// question_hash is sha256 of the FULL CONTENT FINGERPRINT — question
// stem + normalized/sorted options + correct answer text (see
// buildContentFingerprint / hashContentFingerprint below) — NOT just
// the question text. It started as question-text-only, which meant
// two rows sharing an identical/templated stem but testing entirely
// different content (different options, different correct answer —
// e.g. "Identify the correct sentence." reused across a dozen
// unrelated grammar points) hashed identically and were wrongly
// flagged as exact duplicates. Fixed by folding options + correct
// answer into the fingerprint everywhere question_hash is computed.
//
// This field was NOT part of the MCQ model from Phase 2. It has been
// added as a follow-up patch to server/src/models/MCQ.js:
//   - `question_hash: { type: String, index: true }`
//   - a pre-save hook that computes it via hashContentFingerprint
//     (imported from this file)
// Any existing MCQ documents created before that patch — or before the
// fingerprint was widened to include options/answer — won't have an
// up-to-date `question_hash` until they're next saved. A one-off
// backfill script (re-save every document, or an updateMany with $set
// computed client-side) is needed to make exact-match detection
// complete against pre-existing data. Not built here — out of scope
// for this prompt, called out so it isn't silently forgotten.
// ─────────────────────────────────────────────────────────────────

// ─── normalizeQuestion ──────────────────────────────────────────
// Shared by exact hashing AND Levenshtein comparison, so
// "What is  Pakistan's capital?" and "what is pakistans capital"
// collapse to the same normalized form.
export const normalizeQuestion = (text) => {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[.,?!;:"']/g, '') // strip punctuation
    .replace(/\s+/g, ' ') // collapse multiple spaces into one
    .trim();
};

// ─── hashQuestion ───────────────────────────────────────────────
export const hashQuestion = (normalizedText) => {
  return crypto.createHash('sha256').update(normalizedText).digest('hex');
};

// ─── normalizeOptions ───────────────────────────────────────────
// Same treatment as normalizeQuestion (lowercase, strip punctuation,
// collapse whitespace), applied to each of the four options.
//
// Returns a SORTED array, not a joined A→D string — so two questions
// with the exact same four options but shuffled into different
// letters (e.g. import re-ran through a script that randomized option
// order) still compare as identical content. Per the reported bug's
// suggested fix ("Options match (ignoring option order if desired)"),
// order independence only matters for identifying whether two
// question BANKS the same underlying content — the actual A/B/C/D
// letter mapping a student sees is irrelevant to duplicate detection.
export const normalizeOptions = (options) => {
  const opts = options || {};
  return ['A', 'B', 'C', 'D']
    .map((key) => normalizeQuestion(opts[key]))
    .filter((text) => text.length > 0)
    .sort();
};

// ─── normalizeCorrectAnswerText ─────────────────────────────────
// Resolves the correct_answer LETTER (e.g. "B") to the normalized TEXT
// of that option (e.g. "islamabad"), not just the letter. This matters
// for the same shuffled-options reason as normalizeOptions above: if
// two rows have the same options in a different order, "B" in one row
// and "A" in the other can both be the correct answer's actual text —
// comparing letters alone would wrongly treat them as different.
export const normalizeCorrectAnswerText = (options, correctAnswer) => {
  const opts = options || {};
  return normalizeQuestion(opts[correctAnswer]);
};

// ─── buildComparisonText ─────────────────────────────────────────
// BUGFIX (root cause of "5 rows in, 4 inserted" / "100 rows in, ~70
// inserted"): findNearDuplicates() used to run Levenshtein similarity
// on the QUESTION STEM ALONE. Exam-prep MCQ banks are heavily
// templated -- e.g. "Choose the word most SIMILAR in meaning to
// 'BENEVOLENT':" vs "...to 'DILIGENT':" -- so two rows that differ in
// nothing but the one word being tested (and therefore have entirely
// different correct answers) can still score 85%+ on stem text alone,
// because only a handful of characters differ out of a long shared
// template. That falsely flagged genuinely distinct questions as near-
// duplicates and silently diverted them out of the insert pass into
// the duplicate-review queue instead of being inserted.
//
// Fix: fold the four options into the text being compared. Two rows
// that share a template but test different words also have entirely
// different options, which pulls their combined similarity score well
// below the threshold -- while two rows that really are the same
// question (reworded stem, same options/answer, or vice versa) still
// score high, since both stem AND options remain substantially the
// same. This is now the single fingerprint near-duplicate detection
// compares, for both incoming rows and existing DB candidates.
//
// FOLLOW-UP BUGFIX (root cause of "different questions with the same
// or similar stem get flagged as duplicates/near-duplicates"):
// folding in options alone still wasn't enough for two failure modes:
//   1. Two rows with IDENTICAL question text but entirely different
//      options/correct answers (e.g. "Identify the correct sentence"
//      used as a template for a dozen different grammar points) still
//      hashed identically in findExactDuplicates, because that
//      function hashed the question text ALONE, ignoring this
//      function entirely. See buildContentFingerprint below — that's
//      the fix for exact-match; this function remains the near-match
//      fuzzy-text fingerprint (question + options, unhashed).
//   2. Options are now compared order-independent (sorted) via
//      normalizeOptions, so shuffled A/B/C/D letters don't defeat a
//      genuine content match.
// Correct answer is deliberately NOT folded into this fuzzy-text
// string — see findNearDuplicates, which checks it as a separate hard
// gate (must match exactly) rather than blending it into a Levenshtein
// score, since a one-letter-different WRONG answer ("Sad" vs "Mad")
// could otherwise still score high enough to slip through fuzzy text
// matching despite testing genuinely different content.
export const buildComparisonText = (question, options) => {
  return `${normalizeQuestion(question)} :: ${normalizeOptions(options).join(' | ')}`;
};

// ─── buildContentFingerprint ────────────────────────────────────
// THE identity fingerprint for EXACT duplicate detection: question
// stem + normalized/sorted options + the correct answer's own text
// (not its letter — see normalizeCorrectAnswerText). Two rows only
// hash identically here if they are the same question testing the
// same options with the same correct answer; a shared template with
// different options/answer (this bug report's Example 2: "Identify
// the correct sentence." reused for unrelated grammar points) no
// longer collides, because the options and answer text differ even
// though the stem is byte-for-byte identical.
export const buildContentFingerprint = (question, options, correctAnswer) => {
  return [
    normalizeQuestion(question),
    normalizeOptions(options).join(' | '),
    normalizeCorrectAnswerText(options, correctAnswer),
  ].join(' :: ');
};

// ─── hashContentFingerprint ─────────────────────────────────────
// Convenience wrapper so every call site that needs question_hash
// computes it the exact same way, instead of each one separately
// composing buildContentFingerprint + hashQuestion (and risking one of
// them drifting out of sync with the others, which is exactly how the
// original question-only hash bug went unnoticed for so long — it was
// duplicated across MCQ.js and import.service.js instead of shared).
export const hashContentFingerprint = (question, options, correctAnswer) =>
  hashQuestion(buildContentFingerprint(question, options, correctAnswer));

// ─── findExactDuplicates ────────────────────────────────────────
// validRows: [{ row, data }] — the `valid` output of validateEachMCQ.
// MCQModel: the Mongoose MCQ model, passed in rather than imported,
// so this file stays a pure, testable utility with no hard dependency
// on the database layer.
export const findExactDuplicates = async (validRows, MCQModel) => {
  // 1. Compute a hash per row up front — from the full content
  // fingerprint (question + options + correct answer), NOT the
  // question text alone. See buildContentFingerprint's comment: this
  // is the fix for rows that share an identical/templated question
  // stem but test different content (different options, different
  // correct answer) — those no longer collide into a false "exact
  // duplicate."
  const rowsWithHash = validRows.map((entry) => ({
    ...entry,
    hash: hashContentFingerprint(entry.data.question, entry.data.options, entry.data.correct_answer),
  }));

  // 2. One batch query against the DB for every hash in this upload —
  // never one query per row. This is what keeps a 1,000-row import
  // against a 500,000+ row collection to a small, constant number of
  // queries regardless of batch size.
  const allHashes = [...new Set(rowsWithHash.map((r) => r.hash))];
  const existingMatches = await MCQModel.find(
    { question_hash: { $in: allHashes } },
    { question_hash: 1, question_id: 1 }
  ).lean();

  const dbHashToQuestionId = new Map(
    existingMatches.map((doc) => [doc.question_hash, doc.question_id])
  );

  const exactDuplicatesInDB = [];
  const exactDuplicatesInBatch = [];
  const remaining = [];

  // 3. DB matches take priority — if a row collides with something
  // already in the database, that's the more important conflict to
  // surface, regardless of whether it's also duplicated in-batch.
  const notInDB = [];
  for (const entry of rowsWithHash) {
    const existingQuestionId = dbHashToQuestionId.get(entry.hash);
    if (existingQuestionId) {
      exactDuplicatesInDB.push({ row: entry.row, existingQuestionId });
    } else {
      notInDB.push(entry);
    }
  }

  // 4. Among what's left, catch duplicates within the batch itself
  // using an in-memory Map — first occurrence of a hash survives into
  // `remaining`, every later occurrence is flagged against it.
  const seenHashToRow = new Map();
  for (const entry of notInDB) {
    const firstRow = seenHashToRow.get(entry.hash);
    if (firstRow !== undefined) {
      exactDuplicatesInBatch.push({ row: entry.row, duplicateOfRow: firstRow });
    } else {
      seenHashToRow.set(entry.hash, entry.row);
      remaining.push({ row: entry.row, data: entry.data });
    }
  }

  return { exactDuplicatesInDB, exactDuplicatesInBatch, remaining };
};

// ─── boundedLevenshteinSimilarity ───────────────────────────────
// Performance-only twin of levenshteinSimilarity, used ONLY inside
// findNearDuplicates' candidate scan below. NOT exported for general
// use, and NOT a drop-in replacement for levenshteinSimilarity itself
// — similarity.service.js and any other caller that needs an exact
// score regardless of a pass/fail threshold should keep calling
// levenshteinSimilarity directly.
//
// WHY THIS EXISTS: findNearDuplicates compares every incoming row
// against every existing approved question in the same subject.
// Levenshtein's classic O(len(a) * len(b)) DP means a subject with a
// few thousand existing questions, scanned against a 100-row import,
// can mean tens of millions of DP cells computed — almost all of it
// wasted, since the overwhelming majority of candidate pairs are
// nowhere near the similarity threshold and get discarded immediately
// anyway. This function throws that wasted work away WITHOUT changing
// what gets flagged: for any pair actually >= threshold it returns
// the EXACT SAME similarity score levenshteinSimilarity would, and
// for anything below threshold it returns null (meaning "below
// threshold, exact value was never needed") — never an approximate
// "close enough" number. It does this with two safe, lossless
// shortcuts:
//
//   1. Length bound (O(1)): edit distance is always >= the difference
//      in the two strings' lengths, so if that alone already implies
//      a similarity below `threshold`, skip the DP entirely.
//   2. Row-min early abandonment: while filling the DP row by row, if
//      every value in the current row already exceeds the maximum
//      edit distance the threshold allows, the final distance can
//      only be >= that row's minimum — a standard, provably-safe
//      property of edit-distance DP (any full alignment path must
//      pass through every row, so no row's minimum can exceed the
//      final answer) — so we stop immediately, having done only a
//      fraction of the full O(n*m) work.
export const boundedLevenshteinSimilarity = (a, b, threshold) => {
  const strA = String(a ?? '');
  const strB = String(b ?? '');

  if (strA === strB) return 100;

  const maxLength = Math.max(strA.length, strB.length);
  if (maxLength === 0) return 100; // both empty

  // Max edit distance that could still meet `threshold`:
  //   similarity = (1 - distance / maxLength) * 100 >= threshold
  //   => distance <= maxLength * (1 - threshold / 100)
  // The tiny epsilon guards against floating-point subtraction (e.g.
  // `1 - 90/100` evaluates to 0.09999999999999998, not 0.1) rounding
  // an exact boundary DOWN by one and wrongly rejecting a pair that's
  // precisely at the threshold.
  const maxDistance = Math.floor(maxLength * (1 - threshold / 100) + 1e-9);

  // Shortcut 1 — length bound, O(1). Distance is always >= the
  // length difference, so this alone can rule a pair out.
  if (Math.abs(strA.length - strB.length) > maxDistance) return null;

  const rows = strA.length + 1;
  const cols = strB.length + 1;

  let previousRow = new Array(cols);
  let currentRow = new Array(cols);
  for (let j = 0; j < cols; j += 1) previousRow[j] = j;

  for (let i = 1; i < rows; i += 1) {
    currentRow[0] = i;
    let rowMin = currentRow[0];

    for (let j = 1; j < cols; j += 1) {
      const cost = strA[i - 1] === strB[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        previousRow[j] + 1, // deletion
        currentRow[j - 1] + 1, // insertion
        previousRow[j - 1] + cost // substitution
      );
      if (currentRow[j] < rowMin) rowMin = currentRow[j];
    }

    // Shortcut 2 — every value in this row already exceeds what the
    // threshold allows, so the final distance can't meet it either.
    if (rowMin > maxDistance) return null;

    const swap = previousRow;
    previousRow = currentRow;
    currentRow = swap;
  }

  const distance = previousRow[cols - 1];
  if (distance > maxDistance) return null;

  return (1 - distance / maxLength) * 100;
};

// ─── levenshteinSimilarity ──────────────────────────────────────
// Standard edit-distance DP, converted to a 0–100 similarity score.
// Pure and dependency-free by design — easy to unit test, and cheap
// enough to run per-pair since it's only ever invoked after subject
// scoping has already cut the comparison pool down drastically.
//
// Phase 8 (Prompt 82): this is now the SHARED similarity primitive for
// the whole system — both this file's own import-time near-duplicate
// detection (above/below) AND server/src/services/similarity.service.js
// (the QA pipeline's and any on-demand "find similar" feature's entry
// point) call this exact function. Nothing else in the codebase should
// reimplement Levenshtein distance; if a caller needs similarity
// scoring, it goes through similarity.service.js's computeSimilarity,
// which itself just normalizes + delegates here.
export const levenshteinSimilarity = (a, b) => {
  const strA = String(a ?? '');
  const strB = String(b ?? '');

  if (strA === strB) return 100;

  const maxLength = Math.max(strA.length, strB.length);
  if (maxLength === 0) return 100; // both empty

  const rows = strA.length + 1;
  const cols = strB.length + 1;
  const dp = Array.from({ length: rows }, () => new Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) dp[i][0] = i;
  for (let j = 0; j < cols; j += 1) dp[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = strA[i - 1] === strB[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1, // deletion
        dp[i][j - 1] + 1, // insertion
        dp[i - 1][j - 1] + cost // substitution
      );
    }
  }

  const distance = dp[rows - 1][cols - 1];
  return (1 - distance / maxLength) * 100;
};

// Beyond this many existing approved questions in a single subject,
// brute-force Levenshtein against every candidate stops being
// tractable. For now we just cap the comparison pool (via the query's
// limit) so memory stays bounded and the check still completes — the
// real fix, when a subject grows past this, is swapping this function
// out for a vector/embedding similarity search (e.g. an ANN index)
// instead of pairwise string comparison. Not built here; flagged for
// whoever picks up performance work on the import pipeline next.
const MAX_COMPARISON_POOL = 50000;

// ─── findNearDuplicates ─────────────────────────────────────────
// remainingRows: the `remaining` output of findExactDuplicates —
// rows with no exact hash match, still candidates for a reworded
// near-duplicate.
// ─── groupByCorrectAnswer ───────────────────────────────────────
// PERFORMANCE FIX (root cause of imports taking ~60s+ once a subject
// accumulates a few thousand approved questions): both loops below
// used to be a flat nested scan — every incoming row against EVERY
// candidate in the subject, with the correct-answer gate applied
// AFTER already paying for the array iteration. That's wasted work
// on a massive scale: in a typical MCQ bank the correct-answer TEXT
// is close to unique per question, so the overwhelming majority of
// (row, candidate) pairs were always going to be gated out — they
// just weren't gated out until deep inside the loop.
//
// This buckets candidates by their exact correctAnswerText up front,
// once per subject, so each incoming row only ever scans the (usually
// tiny) slice of candidates that could possibly pass the gate, instead
// of the whole pool. Nothing about WHAT gets flagged changes — this is
// the identical gate, just applied via a Map lookup instead of an
// O(n) filter per row. Cuts near-duplicate detection from O(rows *
// candidates) to roughly O(rows * candidates-sharing-that-answer),
// which in practice is the difference between minutes and seconds on
// a bank with thousands of approved questions per subject.
const groupByCorrectAnswer = (entries) => {
  const map = new Map();
  for (const entry of entries) {
    const key = entry.correctAnswerText;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(entry);
  }
  return map;
};

export const findNearDuplicates = async (remainingRows, MCQModel, threshold = 85) => {
  const nearDuplicatesInDB = [];
  const nearDuplicatesInBatch = [];
  const clean = [];

  // Group by subject — comparisons only ever happen within the same
  // subject, never across the whole collection, both for correctness
  // ("same fact repeated" is a same-subject concept) and to keep the
  // comparison pool bounded at scale.
  const rowsBySubject = new Map();
  for (const entry of remainingRows) {
    const subject = entry.data.subject;
    if (!rowsBySubject.has(subject)) rowsBySubject.set(subject, []);
    rowsBySubject.get(subject).push(entry);
  }

  // Fire every distinct subject's candidate query concurrently rather
  // than sequentially awaiting one subject at a time — an import that
  // touches N subjects now pays for the slowest single query instead
  // of the sum of all of them. Each query is still the same bounded,
  // indexed ({status,subject}) lookup as before; only the scheduling
  // changed.
  const subjectEntries = [...rowsBySubject.entries()];
  const candidateSets = await Promise.all(
    subjectEntries.map(([subject]) =>
      MCQModel.find(
        { subject, status: 'approved' },
        { question_id: 1, question: 1, options: 1, correct_answer: 1 }
      )
        .limit(MAX_COMPARISON_POOL)
        .lean()
    )
  );

  subjectEntries.forEach(([subject, subjectRows], idx) => {
    // Precompute the fuzzy comparison text (question + sorted options,
    // see buildComparisonText above) AND the correct-answer text once
    // per row for this subject.
    //
    // BUGFIX (root cause of "different questions with a similar/
    // identical stem get flagged as near-duplicates"): similarity
    // alone — even with options folded in — isn't a strict enough
    // test on its own for heavily-templated banks ("What is the
    // antonym of X?", "Identify the correct sentence.", etc.), where
    // two genuinely different questions can still land close to the
    // threshold by coincidence. The correct answer is now a hard,
    // exact (not fuzzy) gate: a candidate only counts as a near-
    // duplicate if its correct-answer TEXT matches too, not just its
    // letter — see normalizeCorrectAnswerText for why text, not
    // letter (shuffled option order shouldn't defeat a real match,
    // and matching letters alone would falsely equate two DIFFERENT
    // correct answers that both happen to sit in slot "B").
    const normalizedRows = subjectRows.map((entry) => ({
      ...entry,
      normalized: buildComparisonText(entry.data.question, entry.data.options),
      correctAnswerText: normalizeCorrectAnswerText(entry.data.options, entry.data.correct_answer),
    }));

    const normalizedCandidates = candidateSets[idx].map((doc) => ({
      question_id: doc.question_id,
      normalized: buildComparisonText(doc.question, doc.options),
      correctAnswerText: normalizeCorrectAnswerText(doc.options, doc.correct_answer),
    }));

    // Bucket candidates by correct-answer text ONCE per subject — see
    // groupByCorrectAnswer above. Every row below looks up only its
    // own bucket instead of filtering the full candidate list.
    const candidatesByAnswer = groupByCorrectAnswer(normalizedCandidates);

    const stillInPlay = [];

    // 1. DB comparison first — mirrors the priority used for exact
    // matches: a conflict with existing approved content is the more
    // important thing to surface.
    for (const entry of normalizedRows) {
      let bestMatch = null;
      const bucket = candidatesByAnswer.get(entry.correctAnswerText);

      if (bucket) {
        for (const candidate of bucket) {
          const similarity = boundedLevenshteinSimilarity(entry.normalized, candidate.normalized, threshold);
          if (similarity !== null && (!bestMatch || similarity > bestMatch.similarity)) {
            bestMatch = { existingQuestionId: candidate.question_id, similarity };
          }
        }
      }

      if (bestMatch) {
        nearDuplicatesInDB.push({
          row: entry.row,
          existingQuestionId: bestMatch.existingQuestionId,
          similarity: Math.round(bestMatch.similarity * 100) / 100,
        });
      } else {
        stillInPlay.push(entry);
      }
    }

    // 2. Within-batch comparison among what's left in this subject —
    // pairwise, first occurrence survives, later ones flagged against
    // it. Survivors get the same correct-answer bucketing as the DB
    // pass above, rebuilt incrementally as each row is resolved.
    const survivorsByAnswer = new Map();
    for (const entry of stillInPlay) {
      let matchedAgainst = null;
      const bucket = survivorsByAnswer.get(entry.correctAnswerText);

      if (bucket) {
        for (const survivor of bucket) {
          const similarity = boundedLevenshteinSimilarity(entry.normalized, survivor.normalized, threshold);
          if (similarity !== null) {
            matchedAgainst = { row: survivor.row, similarity };
            break;
          }
        }
      }

      if (matchedAgainst) {
        nearDuplicatesInBatch.push({
          row: entry.row,
          duplicateOfRow: matchedAgainst.row,
          similarity: Math.round(matchedAgainst.similarity * 100) / 100,
        });
      } else {
        clean.push({ row: entry.row, data: entry.data });
        if (!survivorsByAnswer.has(entry.correctAnswerText)) survivorsByAnswer.set(entry.correctAnswerText, []);
        survivorsByAnswer.get(entry.correctAnswerText).push(entry);
      }
    }
  });

  return { nearDuplicatesInDB, nearDuplicatesInBatch, clean };
};

// ─── detectDuplicates ───────────────────────────────────────────
// Orchestrator: runs exact-match first, then near-match on whatever
// survives, and merges everything into the { exact, near, clean }
// shape the system spec requires — each flagged entry tagged with
// where the conflict came from ('db' | 'batch').
export const detectDuplicates = async (validRows, MCQModel, threshold = 85) => {
  const { exactDuplicatesInDB, exactDuplicatesInBatch, remaining } =
    await findExactDuplicates(validRows, MCQModel);

  const { nearDuplicatesInDB, nearDuplicatesInBatch, clean } = await findNearDuplicates(
    remaining,
    MCQModel,
    threshold
  );

  const exact = [
    ...exactDuplicatesInDB.map((d) => ({ ...d, source: 'db' })),
    ...exactDuplicatesInBatch.map((d) => ({ ...d, source: 'batch' })),
  ];

  const near = [
    ...nearDuplicatesInDB.map((d) => ({ ...d, source: 'db' })),
    ...nearDuplicatesInBatch.map((d) => ({ ...d, source: 'batch' })),
  ];

  return { exact, near, clean };
};
