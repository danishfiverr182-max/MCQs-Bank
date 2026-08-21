import { ArrowRight } from 'lucide-react';

// ─── TaxonomyDiffPreview ─────────────────────────────────────────────
// Prompt 16 — the ONE place a "current -> new" taxonomy diff is
// rendered. Every Prompt 10 preview response (rename / move_topic /
// move_subject / move_subtopic, and — per this prompt's own DoD —
// merge/delete in Prompts 17-18) returns the identical shape:
//   { current_structure, new_structure, subjects_affected,
//     topics_affected, subtopics_affected, mcqs_affected }
// `current_structure`/`new_structure` are full getTaxonomy()-shaped
// trees (every subject, whether touched or not) — diffing those two
// trees node-by-node in the UI would mean re-deriving, client-side,
// the exact same rename/reparent transform each service function
// already applied server-side to produce `new_structure`, and doing
// it robustly enough to survive a subject/topic RENAME (where the
// node's `name` — the only thing either tree keys on before Prompt 16
// added `id` — differs between the two trees for the very row being
// diffed). Rather than re-derive that, this component takes the
// human-readable "from path" / "to path" the CALLER already knows
// (it's the exact node + destination the admin picked) and pairs that
// with the preview response's own affected-counts/lists — accurate,
// and one implementation shared across every mutation type instead of
// three (Prompts 16-18) independently reconstructing a tree diff.
//
// `duplicateMcqCount` (Prompt 17): merge-only. previewTaxonomyMerge /
// mergeTaxonomyNodes's own dryRun branch (taxonomy.service.js) nets
// `mcqsAffected` down by any MCQ whose question_hash matches another
// MCQ under a DIFFERENT merge candidate — one physical row, not two —
// before this component ever sees it. Rename/move never sends this
// prop (nothing to net out), so it's undefined/0 there and this block
// simply doesn't render. When merge DOES send a non-zero count, this
// is the one place that edge case gets flagged for the admin instead
// of silently folding into `mcqsAffected` above.
export default function TaxonomyDiffPreview({
  fromPath,
  toPath,
  mcqsAffected,
  subjectsAffected = [],
  topicsAffected = [],
  subtopicsAffected = [],
  duplicateMcqCount = 0,
  rawMcqsAffected,
  note,
}) {
  const affectedGroups = [
    { label: 'Subject(s)', items: subjectsAffected },
    { label: 'Topic(s)', items: topicsAffected },
    { label: 'Subtopic(s)', items: subtopicsAffected },
  ].filter((group) => group.items.length > 0);

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-surface-border bg-gray-50 px-3 py-3">
        <div className="flex items-center gap-2 text-sm flex-wrap">
          <span className="text-gray-500 line-through decoration-gray-400">{fromPath}</span>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-gray-400" />
          <span className="font-semibold text-gray-900">{toPath}</span>
        </div>
      </div>

      <div className="rounded-md bg-primary-50 border border-primary-100 px-3 py-2 text-sm text-gray-700">
        This will affect <strong>{mcqsAffected}</strong> MCQ{mcqsAffected === 1 ? '' : 's'}.
        {note ? <span> {note}</span> : null}
      </div>

      {duplicateMcqCount > 0 && (
        <div className="rounded-md bg-warning-light border border-warning/40 px-3 py-2 text-sm text-warning-dark">
          <strong>{duplicateMcqCount}</strong> MCQ{duplicateMcqCount === 1 ? '' : 's'} match
          {duplicateMcqCount === 1 ? 'es' : ''} the exact same question content as another MCQ under a{' '}
          <em>different</em> one of the candidates being merged
          {typeof rawMcqsAffected === 'number' ? ` (${rawMcqsAffected} raw matches total, ` : ' ('}
          counted once above, not once per candidate). Both original questions are kept as separate
          rows — nothing is deleted by this merge.
        </div>
      )}

      {affectedGroups.length > 0 && (
        <div className="space-y-1.5">
          {affectedGroups.map((group) => (
            <div key={group.label} className="flex items-start gap-2 text-xs">
              <span className="shrink-0 font-medium text-gray-500 pt-0.5">{group.label}</span>
              <div className="flex flex-wrap gap-1">
                {group.items.map((item, idx) => (
                  <span
                    key={`${item}-${idx}`}
                    className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-gray-700"
                  >
                    {item && item.trim().length > 0 ? item : '(none)'}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
