import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import {
  previewTaxonomyOperation,
  buildMovePayload,
  buildBulkMovePayload,
  MOVE_OPERATION_BY_KIND,
  MOVE_MUTATION_BY_KIND,
  MOVE_BULK_OPERATION_BY_KIND,
  MOVE_BULK_MUTATION_BY_KIND,
} from '@/api/taxonomyApi';
import { displayName, joinTaxonomyPath } from '@/utils/taxonomyDisplay';
import { slugify } from '@/utils/taxonomySlug';
import TaxonomyDiffPreview from './TaxonomyDiffPreview';

const KIND_LABELS = {
  subject: { title: 'Move subject into another subject', destinationNoun: 'subject', movingNoun: 'subject' },
  topic: { title: 'Move topic to another subject', destinationNoun: 'subject', movingNoun: 'topic' },
  subtopic: { title: 'Move subtopic to another topic', destinationNoun: 'topic', movingNoun: 'subtopic' },
};

// ─── buildDestinationOptions ───────────────────────────────────────────
// Mirrors, client-side, exactly the guardrails validateTaxonomyMove
// (server/src/utils/taxonomyValidator.js, Prompt 12) would apply to
// each candidate destination for this specific `kind` of move — see
// each branch's own comment for which of the three checks
// (self/circular, duplicate-hierarchy, nesting-depth) is actually
// reachable for that kind, and why. Per this prompt's own DoD, an
// excluded destination is left OUT of the returned list entirely
// (never shown disabled with a reason) — "the picker itself should not
// even offer a destination that validateTaxonomyMove would reject."
//
// Returns { blockedReason, options }. `blockedReason`, when set, means
// EVERY destination is invalid regardless of which one is picked (only
// possible for kind: 'subject' — see below) — the caller renders that
// instead of a picker at all, rather than a picker that would always
// end up empty.
//
// Named export (Prompt 19): TaxonomyManager's own drag-and-drop
// validity check (computeDropValidity, TaxonomyManager.jsx) reuses
// this EXACT function to decide whether a drag-over target should be
// visually accepted or rejected, rather than re-deriving the same
// self/duplicate-hierarchy/nesting-depth rules a second time — one
// implementation of "which destinations does Prompt 12 actually
// allow for this move", used both at drag-time and inside this modal.
export const buildDestinationOptions = (kind, node, subjects) => {
  if (kind === 'subject') {
    // Nesting-depth guard (validateNestingDepth): moving a subject
    // ALWAYS lands it one level down, as a topic (destinationDepth 1 + 1).
    // That only still fits the fixed 3-level tree if none of its own
    // topics already have subtopics of their own (maxDepthBelowNode via
    // computeMaxDepthBelow — see taxonomy.service.js) — a property of
    // the SOURCE subject alone, true or false for every destination
    // alike. So this is a single global check, not a per-destination
    // filter.
    const blockedByDepth = (node.topics || []).some((t) => (t.subtopics || []).length > 0);
    if (blockedByDepth) {
      return {
        blockedReason:
          `"${node.name}" has at least one topic that already has its own subtopics — moving it into ` +
          `another subject would need a 4th hierarchy level, which isn't supported. Move or merge its ` +
          `subtopics up first, then try again.`,
        options: [],
      };
    }

    const options = subjects
      // Self/circular (validateNotSelfOrDescendant): a subject can
      // never be nested under another subject as a DESCENDANT subject
      // (subjects have no subject-type children in this fixed tree),
      // so the only self/circular case reachable here is the trivial
      // "move it into itself" — excluded by id.
      .filter((s) => s.id !== node.id)
      // Duplicate-hierarchy (validateNoDuplicateHierarchy): the moved
      // subject becomes a TOPIC under its destination — blocked if that
      // destination already has a topic with the same slug.
      .filter((s) => !(s.topics || []).some((t) => slugify(t.name) === slugify(node.name)))
      .map((s) => ({ id: s.id, label: s.name }));
    return { blockedReason: null, options };
  }

  if (kind === 'topic') {
    // Depth is never an issue here: destination is always a subject
    // (depth 1) and a topic carries at most one more level of
    // subtopics with it (maxDepthBelowNode <= 1), so resultingDepth
    // <= 3 always.
    const options = subjects
      .filter((s) => s.id !== node.subjectId) // self: already there
      .filter((s) => !(s.topics || []).some((t) => slugify(t.name) === slugify(node.name)))
      .map((s) => ({ id: s.id, label: s.name }));
    return { blockedReason: null, options };
  }

  // kind === 'subtopic'. Depth never an issue: destination is always a
  // topic (depth 2), a subtopic carries no children of its own
  // (maxDepthBelowNode 0), so resultingDepth is always exactly 3.
  const allTopics = subjects.flatMap((s) =>
    (s.topics || []).map((t) => ({ ...t, subjectId: s.id, subjectName: s.name }))
  );
  const options = allTopics
    .filter((t) => t.id !== node.topicId) // self: already there
    .filter((t) => !(t.subtopics || []).some((st) => slugify(st.name) === slugify(node.name)))
    .map((t) => ({ id: t.id, label: joinTaxonomyPath([t.subjectName, displayName(t.name)]) }));
  return { blockedReason: null, options };
};

// ─── buildBulkDestinationOptions (Prompt 20 — Bulk Select) ────────────
// The bulk sibling of buildDestinationOptions above: given 2+ selected
// same-type nodes (possibly with different parents — see
// TaxonomyManager's own bulk-selection comment on why Move/Delete allow
// that while Merge doesn't), a destination is only valid for the WHOLE
// batch if it's valid for EVERY node in it individually. So this just
// calls buildDestinationOptions once per node and intersects the
// resulting option lists by id, rather than re-deriving the
// self/duplicate-hierarchy/nesting-depth rules a second time.
//
// If ANY node in the batch is blocked outright (kind: 'subject' with a
// too-deep topic — the only blockedReason case, see above), the whole
// batch is blocked: showing a picker that would still let the admin
// move the OTHER nodes but silently skip the blocked one is worse than
// just explaining why nothing can proceed until it's fixed.
export const buildBulkDestinationOptions = (kind, nodeList, subjects) => {
  const perNode = nodeList.map((node) => buildDestinationOptions(kind, node, subjects));
  const blocked = perNode.find((r) => r.blockedReason);
  if (blocked) {
    return { blockedReason: blocked.blockedReason, options: [] };
  }
  const [first, ...rest] = perNode.map((r) => r.options);
  const options = first.filter((opt) => rest.every((optionSet) => optionSet.some((o) => o.id === opt.id)));
  return { blockedReason: null, options };
};

// ─── MoveNodeModal ─────────────────────────────────────────────────────
// Prompt 16, item 2: one reusable modal for all three reparenting
// movers (topic->subject / P5, subject->subject / P6, subtopic->topic
// / P7). `kind` selects which of the three this instance is; the
// destination-building, payload-building, and API-call-selection logic
// all key off it via the lookup tables in api/taxonomyApi.js and
// buildDestinationOptions above, rather than three near-duplicate
// modal components.
//
// `node` shape by kind:
//   subject:  { id, name, topics }                    (topics: this
//             subject's own topics, incl. THEIR subtopics — needed for
//             the depth guard above)
//   topic:    { id, name, subjectId, subjectName }
//   subtopic: { id, name, topicId, topicName, subjectName }
//
// `subjects`: the full tree already held in TaxonomyManager's state
// (now id-bearing — Prompt 16's own backend addition to getTaxonomy(),
// see mcq.service.js) — this modal builds its destination list from it
// directly rather than issuing its own fetch.
//
// `initialDestinationId` (Prompt 19, optional): set when this modal was
// opened by dropping a dragged node onto a target row in the tree
// (TaxonomyManager's own handleDrop) rather than via a row's own "Move"
// button — pre-fills the destination picker with whatever the admin
// dropped onto, so drag-and-drop is a faster way to REACH this exact
// same preview -> confirm flow, not a shortcut that skips it: the
// admin still has to click "Preview changes" and then "Confirm move"
// like any other move, same as this prompt's own DoD requires.
//
// `nodes` (Prompt 20, optional): an ARRAY of same-shaped node objects
// instead of the single `node` above — set when this modal was opened
// from TaxonomyManager's bulk-selection toolbar's "Move" button with
// 2+ same-type nodes checked (possibly under different parents; see
// TaxonomyManager's own selection comment). When present (and longer
// than 1), this modal switches into bulk mode: one combined destination
// list (buildBulkDestinationOptions — a destination valid for every
// selected node), one combined preview covering all of them
// (previewTaxonomyOperation('move_*_bulk', ...)), and one confirm that
// commits all of them in a single transaction (moveTopicsToSubjectBulk
// etc. — see taxonomy.service.js's own header comment on why that's
// still "one ActivityLog row per node", not one combined row). Single-
// node callers (row "Move" button, drag-and-drop) are untouched — they
// never pass `nodes`, so `nodeList` below is just `[node]` and every
// branch behaves exactly as it did before this prompt.
export default function MoveNodeModal({
  kind,
  node,
  nodes,
  subjects,
  initialDestinationId = '',
  onClose,
  onMoved,
}) {
  const [step, setStep] = useState('select'); // 'select' | 'preview'
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewData, setPreviewData] = useState(null);

  const labels = KIND_LABELS[kind];
  const nodeList = nodes && nodes.length ? nodes : [node];
  const isBulk = nodeList.length > 1;

  // Bulk-select follow-up (Prompt 20 remaining item #2): `nodeList` is
  // reconstructed fresh every render (it's `nodes ?? [node]`, and
  // `nodes` itself arrives as a fresh array from TaxonomyManager's own
  // `[...selection.nodes.values()]` each time IT re-renders), so
  // spreading `...nodeList.map((n) => n.id)` directly into this array
  // literal previously meant the dependency array's own LENGTH could
  // in principle differ between renders — React's useMemo assumes a
  // stable-length deps array and only compares element-by-element, so
  // a length change is undefined behavior (a dev-mode warning at best,
  // a stale-memo bug at worst) rather than the "just recompute" fallback
  // it would be for a genuinely new array reference of the SAME shape.
  // Joining into one stable string keeps the array literal itself a
  // fixed length (3 entries) no matter how many nodes are selected —
  // still recomputes whenever the actual set of ids changes (that's
  // the whole point), just without ever changing the deps array's own
  // size to do it.
  const nodeIdsKey = nodeList.map((n) => n.id).join(',');
  const { blockedReason, options } = useMemo(
    () =>
      isBulk
        ? buildBulkDestinationOptions(kind, nodeList, subjects)
        : buildDestinationOptions(kind, nodeList[0], subjects),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [kind, isBulk, subjects, nodeIdsKey]
  );

  // Lazy initializer: only pre-fills when the dropped-onto target is
  // ACTUALLY among the valid options this modal itself computed — in
  // practice always true, since TaxonomyManager's own drag-time check
  // (computeDropValidity) runs this same buildDestinationOptions
  // against the same `subjects` before ever allowing the drop that
  // opens this modal, but checked again here rather than trusted
  // blindly, same defensive stance the server's own guardrails take
  // toward anything a client already claims to have validated. (Bulk
  // moves are never opened via drag-and-drop, so `initialDestinationId`
  // is always '' in that case — this still behaves correctly, it just
  // never has anything to pre-fill.)
  const [destinationId, setDestinationId] = useState(() =>
    options.some((o) => o.id === initialDestinationId) ? initialDestinationId : ''
  );

  const nodeFromPath = (n) =>
    kind === 'subject'
      ? n.name
      : kind === 'topic'
      ? joinTaxonomyPath([n.subjectName, displayName(n.name)])
      : joinTaxonomyPath([n.subjectName, displayName(n.topicName), displayName(n.name)]);

  const fromPath = isBulk
    ? `${nodeList.length} ${labels.movingNoun}s: ${nodeList.map(nodeFromPath).join('; ')}`
    : nodeFromPath(nodeList[0]);

  const selectedOption = options.find((o) => o.id === destinationId) ?? null;
  const toPath = selectedOption
    ? isBulk
      ? `All moving to: ${selectedOption.label}`
      : kind === 'subject'
      ? joinTaxonomyPath([selectedOption.label, nodeList[0].name])
      : joinTaxonomyPath([selectedOption.label, displayName(nodeList[0].name)])
    : null;

  const handlePreview = async () => {
    if (!destinationId || isPreviewing) return;
    setIsPreviewing(true);
    try {
      const operation = isBulk ? MOVE_BULK_OPERATION_BY_KIND[kind] : MOVE_OPERATION_BY_KIND[kind];
      const payload = isBulk
        ? buildBulkMovePayload(kind, nodeList.map((n) => n.id), destinationId)
        : buildMovePayload(kind, nodeList[0].id, destinationId);
      const response = await previewTaxonomyOperation(operation, payload);
      setPreviewData(response.data.data);
      setStep('preview');
    } catch (err) {
      toast.error(handleApiError(err) || 'Could not preview this move');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      const mutate = isBulk ? MOVE_BULK_MUTATION_BY_KIND[kind] : MOVE_MUTATION_BY_KIND[kind];
      const payload = isBulk
        ? buildBulkMovePayload(kind, nodeList.map((n) => n.id), destinationId)
        : buildMovePayload(kind, nodeList[0].id, destinationId);
      const response = await mutate(payload);
      if (isBulk) {
        const { moved_count: movedCount = nodeList.length } = response.data.data ?? {};
        toast.success(`Moved ${movedCount} ${labels.movingNoun}${movedCount === 1 ? '' : 's'}`);
      } else {
        const { modified_count: modified = 0, matched_count: matched = 0 } = response.data.data ?? {};
        toast.success(`Moved — ${modified} of ${matched} MCQ${matched === 1 ? '' : 's'} retagged`);
      }
      // Same optimistic-tree handoff as RenameNodeModal — see its own
      // comment on onRenamed above.
      onMoved(previewData?.new_structure?.subjects ?? null);
    } catch (err) {
      toast.error(handleApiError(err) || 'Move failed');
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4" onClick={onClose}>
      <div
        className="card w-full max-w-md shadow-modal my-8 max-h-[85vh] overflow-y-auto"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="section-title mb-1">
          {isBulk ? `Move ${nodeList.length} ${labels.movingNoun}s` : labels.title}
        </h2>
        <p className="text-sm text-gray-500 mb-4">Currently: {fromPath}</p>

        {step === 'select' && (
          <div className="space-y-4">
            {blockedReason ? (
              <div className="rounded-md bg-red-50 border border-danger/30 px-3 py-2 text-sm text-danger">
                {blockedReason}
              </div>
            ) : options.length === 0 ? (
              <div className="rounded-md bg-gray-50 border border-surface-border px-3 py-2 text-sm text-gray-600">
                {isBulk
                  ? `No single ${labels.destinationNoun} is a valid destination for every selected ${labels.movingNoun} — ` +
                    `pick a smaller selection, or move them one at a time.`
                  : `No valid destination ${labels.destinationNoun} available — every other ${labels.destinationNoun} ` +
                    `already has a ${labels.movingNoun} named "${nodeList[0].name || '(none)'}", or there's nowhere ` +
                    `else to move this to.`}
              </div>
            ) : (
              <div className="space-y-1">
                <label className="text-xs font-medium text-gray-600">
                  Move to which {labels.destinationNoun}?
                </label>
                <select
                  value={destinationId}
                  onChange={(e) => setDestinationId(e.target.value)}
                  autoFocus
                  className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  <option value="" disabled>
                    Select a {labels.destinationNoun}…
                  </option>
                  {options.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={handlePreview}
                disabled={!destinationId || isPreviewing || !!blockedReason}
              >
                {isPreviewing ? 'Checking…' : 'Preview changes'}
              </Button>
            </div>
          </div>
        )}

        {step === 'preview' && previewData && (
          <div className="space-y-4">
            <TaxonomyDiffPreview
              fromPath={fromPath}
              toPath={toPath}
              mcqsAffected={previewData.mcqs_affected}
              subjectsAffected={previewData.subjects_affected}
              topicsAffected={previewData.topics_affected}
              subtopicsAffected={previewData.subtopics_affected}
            />

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={() => setStep('select')} disabled={isSubmitting}>
                Back
              </Button>
              <Button type="button" size="sm" onClick={handleConfirm} disabled={isSubmitting}>
                {isSubmitting ? 'Moving…' : isBulk ? `Confirm move (${nodeList.length})` : 'Confirm move'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
