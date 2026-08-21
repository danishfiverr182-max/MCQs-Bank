import { useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import { previewTaxonomyOperation, mergeTaxonomyNodes } from '@/api/taxonomyApi';
import { displayName, joinTaxonomyPath } from '@/utils/taxonomyDisplay';
import TaxonomyDiffPreview from './TaxonomyDiffPreview';

const TYPE_LABEL = { subject: 'subjects', topic: 'topics', subtopic: 'subtopics' };

// ─── pickDefaultSurvivor ───────────────────────────────────────────────
// Prompt 17's own DoD: "keep this name" choice, "defaulting to the
// node with the highest MCQ count, but overridable". `nodes` here are
// the tree rows TaxonomyManager already had in state (each carries its
// own `total` from getTaxonomy() — see mcq.service.js), so no extra
// fetch is needed just to pick a sensible default. Ties (equal counts)
// keep whichever came first in the array — arbitrary but deterministic,
// and always overridable via the radio picker below regardless.
const pickDefaultSurvivor = (nodes) =>
  nodes.reduce((best, n) => ((n.total ?? 0) > (best.total ?? 0) ? n : best), nodes[0]);

// ─── MergeNodesModal ─────────────────────────────────────────────────
// Prompt 17 — the merge counterpart to RenameNodeModal/MoveNodeModal
// (Prompt 16), reusing the exact same preview -> confirm shape and the
// same <TaxonomyDiffPreview> component those two already use. Unlike
// them, this modal is never opened directly from a single row's own
// action — TaxonomyManager collects 2+ checked, same-type/same-parent
// nodes first (see its own mergeSelection state) and only then opens
// this modal with that whole set.
//
// `nodes`: array of { id, name, total } — the checked candidates, same
// type and same parent (TaxonomyManager enforces this at selection
// time, per this prompt's own "same type and same parent" constraint —
// see its buildMergeCheckbox/isMergeDisabled logic).
// `type`: 'subject' | 'topic' | 'subtopic'.
// `pathPrefix`: ancestor path ABOVE this group, already joined — same
// convention RenameNodeModal's own `pathPrefix` prop uses ('' for a
// subject group, subject name for a topic group, 'Subject → Topic' for
// a subtopic group).
export default function MergeNodesModal({ type, nodes, pathPrefix, onClose, onMerged }) {
  const [step, setStep] = useState('choose'); // 'choose' | 'preview'
  const [keepNodeId, setKeepNodeId] = useState(() => pickDefaultSurvivor(nodes).id);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewData, setPreviewData] = useState(null);

  const survivorNode = useMemo(
    () => nodes.find((n) => n.id === keepNodeId) ?? nodes[0],
    [nodes, keepNodeId]
  );

  // Mirrors mergeTaxonomyNodes' own oldLocationPath/newLocationPath
  // format server-side (taxonomy.service.js) — "prefix [A, B, C]" for
  // the merge group, "prefix survivor" for the result — so the diff
  // reads the same shape an admin would see in the ActivityLog for
  // this same action later.
  const namesList = nodes.map((n) => displayName(n.name)).join(', ');
  const fromPath = pathPrefix ? `${pathPrefix} → [${namesList}]` : `[${namesList}]`;
  const toPath = joinTaxonomyPath([pathPrefix || null, displayName(survivorNode.name)]);

  const handlePreview = async () => {
    if (isPreviewing) return;
    setIsPreviewing(true);
    try {
      const response = await previewTaxonomyOperation('merge', {
        node_ids: nodes.map((n) => n.id),
        keep_name: survivorNode.name,
      });
      setPreviewData(response.data.data);
      setStep('preview');
    } catch (err) {
      toast.error(handleApiError(err) || 'Could not preview this merge');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      const response = await mergeTaxonomyNodes({
        node_ids: nodes.map((n) => n.id),
        keep_name: survivorNode.name,
      });
      const { modified_count: modified = 0, matched_count: matched = 0 } = response.data.data ?? {};
      toast.success(`Merged — ${modified} of ${matched} MCQ${matched === 1 ? '' : 's'} retagged`);
      // Same optimistic-tree handoff as RenameNodeModal — see its own
      // comment on onRenamed above.
      onMerged(previewData?.new_structure?.subjects ?? null);
    } catch (err) {
      toast.error(handleApiError(err) || 'Merge failed');
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
          Merge {nodes.length} {TYPE_LABEL[type]}
        </h2>
        <p className="text-sm text-gray-500 mb-4">
          {pathPrefix ? `Under ${pathPrefix}. ` : ''}Every MCQ currently tagged with any of these will be
          retagged to whichever name you keep.
        </p>

        {step === 'choose' && (
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">Keep this name</label>
              <div className="space-y-1.5">
                {nodes.map((n) => (
                  <label
                    key={n.id}
                    className="flex items-center justify-between gap-3 rounded-md border border-surface-border px-3 py-2 text-sm cursor-pointer hover:bg-gray-50 has-[:checked]:border-primary-300 has-[:checked]:bg-primary-50"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="keep-name"
                        value={n.id}
                        checked={keepNodeId === n.id}
                        onChange={() => setKeepNodeId(n.id)}
                        className="h-4 w-4 text-primary-600 focus:ring-ring"
                      />
                      {displayName(n.name)}
                    </span>
                    <span className="text-xs text-gray-500 tabular-nums">
                      {n.total ?? 0} MCQ{(n.total ?? 0) === 1 ? '' : 's'}
                    </span>
                  </label>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={handlePreview} disabled={isPreviewing}>
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
              duplicateMcqCount={previewData.duplicate_mcq_count}
              rawMcqsAffected={previewData.raw_mcqs_affected}
            />

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={() => setStep('choose')} disabled={isSubmitting}>
                Back
              </Button>
              <Button type="button" size="sm" onClick={handleConfirm} disabled={isSubmitting}>
                {isSubmitting ? 'Merging…' : 'Confirm merge'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
