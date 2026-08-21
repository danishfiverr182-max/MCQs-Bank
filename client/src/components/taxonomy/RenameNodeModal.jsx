import { useState } from 'react';
import toast from 'react-hot-toast';
import { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import { previewTaxonomyOperation, renameTaxonomyNode } from '@/api/taxonomyApi';
import { displayName, joinTaxonomyPath } from '@/utils/taxonomyDisplay';
import TaxonomyDiffPreview from './TaxonomyDiffPreview';

// ─── RenameNodeModal ─────────────────────────────────────────────────
// Prompt 16, item 1: "A rename modal — single node, name input, calls
// renameTaxonomyNode (Prompt 4) via the Prompt 10 preview endpoint
// first." Works at any of the three levels — subject, topic, subtopic
// — since renameTaxonomyNode itself does (unlike the old Prompt 109
// bulk-reassign-topic modal this replaces, which had no subject-level
// rename at all and always renamed via topic/subtopic STRING matching
// rather than a specific TaxonomyNode's own `_id`).
//
// `node` shape: { id, type: 'subject'|'topic'|'subtopic', name }
// `pathPrefix`: the ancestor path ABOVE this node, already joined
// (e.g. '' for a subject, 'Physics' for a topic under Physics,
// 'Physics → Mechanics' for a subtopic) — TaxonomyManager builds this
// from the tree it already has in state, so this modal never needs to
// know about siblings/ancestors itself.
export default function RenameNodeModal({ node, pathPrefix, onClose, onRenamed }) {
  const [step, setStep] = useState('edit'); // 'edit' | 'preview'
  const [newName, setNewName] = useState(node.name);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewData, setPreviewData] = useState(null);

  const trimmedName = newName.trim();
  // A subject may never be '' (see renameTaxonomyNode's own guard) —
  // topic/subtopic have no such restriction, '' is their real "(none)"
  // bucket. Mirrored here purely so the Preview button can't be
  // clicked into a request the server would reject outright, not as a
  // replacement for that server-side check.
  const isUnchanged = trimmedName === node.name;
  const isInvalidEmpty = node.type === 'subject' && trimmedName === '';
  const canPreview = !isUnchanged && !isInvalidEmpty && !isPreviewing;

  const fromPath = joinTaxonomyPath([pathPrefix || null, displayName(node.name)]);
  const toPath = joinTaxonomyPath([pathPrefix || null, displayName(trimmedName)]);

  const handlePreview = async (e) => {
    e.preventDefault();
    if (!canPreview) return;
    setIsPreviewing(true);
    try {
      const response = await previewTaxonomyOperation('rename', {
        node_id: node.id,
        new_name: trimmedName,
      });
      setPreviewData(response.data.data);
      setStep('preview');
    } catch (err) {
      toast.error(handleApiError(err) || 'Could not preview this rename');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      const response = await renameTaxonomyNode({ node_id: node.id, new_name: trimmedName });
      const { modified_count: modified = 0, matched_count: matched = 0 } = response.data.data ?? {};
      toast.success(`Renamed — ${modified} of ${matched} MCQ${matched === 1 ? '' : 's'} retagged`);
      // Prompt 16's own preview step already computed the exact predicted
      // post-rename tree server-side (new_structure — see
      // renameTaxonomyNode's dryRun branch in taxonomy.service.js).
      // Handing it up lets TaxonomyManager repaint the tree instantly
      // instead of blocking on a second full getTaxonomy() round trip —
      // see handleMutated's own comment for the background reconcile.
      onRenamed(previewData?.new_structure?.subjects ?? null);
    } catch (err) {
      toast.error(handleApiError(err) || 'Rename failed');
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
        <h2 className="section-title mb-1">Rename {node.type}</h2>
        <p className="text-sm text-gray-500 mb-4">This affects every MCQ currently tagged {fromPath}.</p>

        {step === 'edit' && (
          <form onSubmit={handlePreview} className="space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-gray-600">New name</label>
              <input
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                autoFocus
                placeholder={node.type === 'subject' ? undefined : '(none)'}
                className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              />
              {isInvalidEmpty && <p className="text-xs text-danger">A subject name cannot be empty.</p>}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={!canPreview}>
                {isPreviewing ? 'Checking…' : 'Preview changes'}
              </Button>
            </div>
          </form>
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
              <Button type="button" variant="outline" size="sm" onClick={() => setStep('edit')} disabled={isSubmitting}>
                Back
              </Button>
              <Button type="button" size="sm" onClick={handleConfirm} disabled={isSubmitting}>
                {isSubmitting ? 'Renaming…' : 'Confirm rename'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
