// detectNewSubtopics.js
//
// Client-side PREVIEW of the server's "New Subtopics" detection
// (server/src/services/import.service.js's ensureTaxonomyForInsertedDocs,
// merged into PromptState.subtopic_bank by promptState.service.js's
// mergeSubtopicsIntoBank). This is intentionally NOT a guaranteed match
// for what the server will eventually report — see the caveats below —
// it exists so the Import page can show something useful before the
// upload round-trip completes.
//
// Reuses:
//   - client/src/utils/taxonomySlug.js's slugify, which is itself a
//     deliberate line-for-line mirror of server/src/utils/slugify.js.
//     Using the SAME slugify as mergeSubtopicsIntoBank is the whole
//     point here: mergeSubtopicsIntoBank only appends a name to
//     subtopic_bank if its slug doesn't already match an existing
//     entry (promptState.service.js lines ~50-60), so this function
//     must bucket names by that exact same slug or it will disagree
//     with the server about what's "new" for something as simple as
//     "Rivers & Dams" vs "rivers-and-dams" vs "RIVERS  &  DAMS".
//   - The same raw-JSON parsing shape as BulkImport.jsx's
//     buildIncomingRows(): JSON.parse, then accept either a bare array
//     or { questions: [...] }, else treat as no rows. Kept as an
//     inline, side-effect-free re-implementation (rather than an
//     import) since buildIncomingRows lives in a page component and
//     returns a different shape (a 1-indexed row map for
//     DuplicateReview) — this function only needs the row list itself.
//
// Caveats vs. the server's real "new subtopics" report (see Prompt 1's
// trace, section 3): this reads EVERY row's `subtopic` field as typed
// in the raw JSON, before any schema validation, duplicate detection,
// or actual insert has happened. The server's report is scoped to rows
// that validated, weren't duplicates, and were actually inserted, and
// additionally drops any subtopic whose slug already exists on some
// OTHER TaxonomyNode anywhere in the system (see
// ensureTaxonomyForInsertedDocs's "layer 2" comment). This function has
// no access to that DB-wide state — it can only compare against the
// subtopic_bank array it's given. It is a same-side, better-than-
// nothing preview, not a source of truth.
//
// No API calls. No DOM/browser globals. Pure in, pure out.

import { slugify } from './taxonomySlug.js';

// ─── parseQuestionRows ────────────────────────────────────────────
// Mirrors BulkImport.jsx's buildIncomingRows() parsing branch:
// JSON.parse the raw text, then accept a bare array OR a
// { questions: [...] } envelope (see import.service.js's parseJSON,
// which the client intentionally mirrors so behavior lines up).
// Anything else — invalid JSON, neither shape — yields an empty list
// rather than throwing, since this is a best-effort client preview,
// not a validator.
const parseQuestionRows = (rawText) => {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.questions)) return parsed.questions;
  return [];
};

// ─── findNewSubtopics ───────────────────────────────────────────────
// (rawText: string, currentBank: string[]) -> Array<{ name, slug }>
//
// - Case/whitespace-insensitive: comparison is entirely by slug, via
//   the shared slugify(), so "Capitals", " capitals ", and "CAPITALS"
//   are all the same entry.
// - The blank '' subtopic ("(none)" bucket — see slugify.js's own
//   comment on why '' is a real, meaningful value elsewhere in this
//   codebase) is never reported here, same as the server's
//   ensureTaxonomyForInsertedDocs, since it isn't a real, prompt-worthy
//   subtopic name.
// - Dedupes WITHIN the incoming JSON itself: if 40 rows all say
//   "Capitals", that's one entry in the result, not 40.
// - `name` is the first-seen raw (trimmed) spelling for that slug in
//   the file, so the result reads naturally even though comparison
//   itself is slug-based.
export const findNewSubtopics = (rawText, currentBank = []) => {
  const rows = parseQuestionRows(rawText);

  const bankSlugs = new Set(
    (Array.isArray(currentBank) ? currentBank : [])
      .map((name) => slugify(name))
      .filter((slug) => slug.length > 0)
  );

  const seenSlugs = new Set();
  const result = [];

  for (const row of rows) {
    const raw = String(row?.subtopic ?? '').trim();
    if (!raw) continue; // blank subtopic — never reported, matches server behavior

    const slug = slugify(raw);
    if (!slug) continue; // defensive: a name that slugifies to '' (e.g. all punctuation)

    if (bankSlugs.has(slug)) continue; // already in the bank — not new
    if (seenSlugs.has(slug)) continue; // already collected from an earlier row in this file

    seenSlugs.add(slug);
    result.push({ name: raw, slug });
  }

  return result;
};

export default findNewSubtopics;
