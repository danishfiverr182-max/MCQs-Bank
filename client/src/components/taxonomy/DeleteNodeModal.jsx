import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import {
  previewTaxonomyOperation,
  getTaxonomyDeletePreview,
  getTaxonomyDeletePreviewBulk,
  deleteTaxonomyNode,
  deleteTaxonomyNodeBulk,
} from '@/api/taxonomyApi';
import { displayName, joinTaxonomyPath } from '@/utils/taxonomyDisplay';
import TaxonomyDiffPreview from './TaxonomyDiffPreview';

// ─── buildDeleteDestinationOptions ─────────────────────────────────────
// Every OTHER node of the same type, anywhere in the tree — deleting a
// node's "move" destination is a plain MCQ retag onto an EXISTING node
// (validateDeleteDestination, server/src/utils/taxonomyValidator.js,
// only checks exists / not-self / same-type), not a TaxonomyNode
// reparent, so unlike MoveNodeModal's own buildDestinationOptions there
// is no same-parent constraint, no duplicate-hierarchy check, and no
// nesting-depth guard to mirror here — every same-type node besides
// itself is a valid destination.
const buildDeleteDestinationOptions = (type, nodeId, subjects) => {
  if (type === 'subject') {
    return subjects.filter((s) => s.id !== nodeId).map((s) => ({ id: s.id, label: s.name }));
  }
  if (type === 'topic') {
    return subjects
      .flatMap((s) => (s.topics || []).map((t) => ({ id: t.id, subjectName: s.name, name: t.name })))
      .filter((t) => t.id !== nodeId)
      .map((t) => ({ id: t.id, label: joinTaxonomyPath([t.subjectName, displayName(t.name)]) }));
  }
  // 'subtopic'
  return subjects
    .flatMap((s) =>
      (s.topics || []).flatMap((t) =>
        (t.subtopics || []).map((st) => ({
          id: st.id,
          subjectName: s.name,
          topicName: t.name,
          name: st.name,
        }))
      )
    )
    .filter((st) => st.id !== nodeId)
    .map((st) => ({
      id: st.id,
      label: joinTaxonomyPath([st.subjectName, displayName(st.topicName), displayName(st.name)]),
    }));
};

// ─── DeleteNodeModal ────────────────────────────────────────────────
// Prompt 18 — the delete counterpart to RenameNodeModal/MoveNodeModal
// (Prompt 16) and MergeNodesModal (Prompt 17), reusing the exact same
// <TaxonomyDiffPreview> and preview -> confirm shape those three
// already use, with two additions specific to delete: an upfront
// counts step (previewTaxonomyDelete, before any choice exists to run
// the full operation preview with) and a REQUIRED move-vs-delete-
// outright choice for orphaned MCQs, since — per this prompt's own
// note — a "delete outright" choice is the only IRREVERSIBLE operation
// among all six taxonomy mutations. That irreversibility is why this
// is also the only one of the four modals with a typed-confirmation
// step (re-type the node's own name) before "Preview changes" even
// unlocks, on top of the preview screen every other modal already
// requires before its own commit.
//
// `node` shape: { id, type: 'subject'|'topic'|'subtopic', name }
// `pathPrefix`: ancestor path ABOVE this node, already joined — same
// convention RenameNodeModal's own `pathPrefix` prop uses.
// `subjects`: the full tree already held in TaxonomyManager's state —
// same source MoveNodeModal builds its own destination list from.
//
// `nodes` (Prompt 20, optional): an ARRAY of `{ id, type, name,
// pathPrefix }` objects instead of the single `node`/`pathPrefix` pair
// above — each entry carries its OWN pathPrefix since bulk-selected
// nodes can have different parents (see TaxonomyManager's own
// selection comment). Set when this modal was opened from the
// bulk-selection toolbar's "Delete" button with 2+ same-type nodes
// checked. In bulk mode: ONE combined counts screen
// (previewTaxonomyDeleteBulk, summed across every selected node), ONE
// shared move-vs-delete-outright choice applied to the whole batch, ONE
// combined preview (previewTaxonomyOperation('delete_bulk', ...)), and
// ONE confirm that deletes all of them in a single transaction
// (deleteTaxonomyNodeBulk — see bulkDeleteTaxonomyNodes's own header
// comment in taxonomy.service.js for why that's still "one ActivityLog
// row per node"). Single-node callers (row "Delete" button) are
// untouched — they never pass `nodes`, so `nodeList` below is just
// `[{ ...node, pathPrefix }]` and every branch behaves exactly as it
// did before this prompt.
export default function DeleteNodeModal({ node, pathPrefix, nodes, subjects, onClose, onDeleted }) {
  const [step, setStep] = useState('info'); // 'info' | 'choose' | 'preview'
  const [counts, setCounts] = useState(null);
  const [countsError, setCountsError] = useState(null);
  const [orphanAction, setOrphanAction] = useState('move'); // 'move' | 'delete'
  const [destinationId, setDestinationId] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [previewData, setPreviewData] = useState(null);

  const nodeList = nodes && nodes.length ? nodes : [{ ...node, pathPrefix }];
  const isBulk = nodeList.length > 1;
  const nodeType = nodeList[0].type;
  const nodeIdSet = useMemo(() => new Set(nodeList.map((n) => n.id)), [nodeList]);

  const fromPath = isBulk
    ? `${nodeList.length} ${nodeType}s: ${nodeList
        .map((n) => joinTaxonomyPath([n.pathPrefix || null, displayName(n.name)]))
        .join('; ')}`
    : joinTaxonomyPath([nodeList[0].pathPrefix || null, displayName(nodeList[0].name)]);

  // What the admin has to re-type to unlock "delete outright". Single
  // node: its own name (or "(none)" for an empty topic/subtopic
  // bucket, same reasoning as before this prompt). Bulk: the different
  // selected nodes rarely share one name, so there's no single
  // canonical value to ask for — the literal word "DELETE" instead,
  // same idea, just batch-appropriate.
  const expectedConfirmText = isBulk ? 'DELETE' : displayName(nodeList[0].name);

  const options = useMemo(
    () =>
      buildDeleteDestinationOptions(nodeType, null, subjects).filter((o) => !nodeIdSet.has(o.id)),
    [nodeType, subjects, nodeIdSet]
  );

  // Same fixed-length-deps reasoning as MoveNodeModal's own `nodeIdsKey`
  // (see that file's comment) — `nodeList` here is reconstructed fresh
  // every render too, so a spread of its ids into this effect's deps
  // array previously risked a between-renders LENGTH change, which
  // useEffect's deps comparison doesn't handle any more gracefully than
  // useMemo's does.
  const nodeIdsKey = nodeList.map((n) => n.id).join(',');

  useEffect(() => {
    let cancelled = false;
    const request = isBulk
      ? getTaxonomyDeletePreviewBulk(nodeList.map((n) => n.id))
      : getTaxonomyDeletePreview(nodeList[0].id);
    request
      .then((response) => {
        if (!cancelled) setCounts(response.data.data);
      })
      .catch((err) => {
        if (!cancelled) setCountsError(handleApiError(err) || 'Could not load delete preview');
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBulk, nodeIdsKey]);

  // No destinations to move onto at all is a real dead end for
  // 'move' (e.g. the only subject in the whole bank) — default to
  // 'delete' outright in that case, same "don't offer a picker that's
  // always empty" stance MoveNodeModal's own blockedReason takes.
  useEffect(() => {
    if (options.length === 0) setOrphanAction('delete');
  }, [options.length]);

  const selectedOption = options.find((o) => o.id === destinationId) ?? null;
  const canProceedFromChoose =
    orphanAction === 'move' ? !!destinationId : confirmText === expectedConfirmText;

  const buildPayload = () => ({
    ...(isBulk ? { node_ids: nodeList.map((n) => n.id) } : { node_id: nodeList[0].id }),
    on_orphan_mcqs:
      orphanAction === 'move' ? { action: 'move', destination_node_id: destinationId } : { action: 'delete' },
  });

  const handlePreview = async () => {
    if (!canProceedFromChoose || isPreviewing) return;
    setIsPreviewing(true);
    try {
      const response = await previewTaxonomyOperation(isBulk ? 'delete_bulk' : 'delete', buildPayload());
      setPreviewData(response.data.data);
      setStep('preview');
    } catch (err) {
      toast.error(handleApiError(err) || 'Could not preview this delete');
    } finally {
      setIsPreviewing(false);
    }
  };

  const handleConfirm = async () => {
    setIsSubmitting(true);
    try {
      const response = isBulk ? await deleteTaxonomyNodeBulk(buildPayload()) : await deleteTaxonomyNode(buildPayload());
      const data = response.data.data ?? {};
      let message;
      if (isBulk) {
        const count = data.deleted_count ?? nodeList.length;
        message =
          orphanAction === 'move'
            ? `Deleted ${count} ${nodeType}${count === 1 ? '' : 's'} — MCQs moved to "${selectedOption?.label ?? ''}"`
            : `Deleted ${count} ${nodeType}${count === 1 ? '' : 's'} — MCQs permanently removed`;
      } else {
        message =
          orphanAction === 'move'
            ? `Deleted — ${data.modified_count ?? 0} of ${data.matched_count ?? 0} MCQ${
                (data.matched_count ?? 0) === 1 ? '' : 's'
              } moved to "${data.destination_name ?? ''}"`
            : `Deleted — ${data.deleted_mcq_count ?? 0} MCQ${(data.deleted_mcq_count ?? 0) === 1 ? '' : 's'} permanently removed`;
      }
      toast.success(message);
      // Same optimistic-tree handoff as RenameNodeModal — see its own
      // comment on onRenamed above.
      onDeleted(previewData?.new_structure?.subjects ?? null);
    } catch (err) {
      toast.error(handleApiError(err) || 'Delete failed');
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
        <h2 className="section-title mb-1">{isBulk ? `Delete ${nodeList.length} ${nodeType}s` : `Delete ${nodeType}`}</h2>
        <p className="text-sm text-gray-500 mb-4">{fromPath}</p>

        {step === 'info' && (
          <div className="space-y-4">
            {countsError ? (
              <div className="rounded-md bg-red-50 border border-danger/30 px-3 py-2 text-sm text-danger">
                {countsError}
              </div>
            ) : !counts ? (
              <div className="flex items-center justify-center py-6">
                <div className="h-6 w-6 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
              </div>
            ) : (
              <div className="rounded-md bg-red-50 border border-danger/30 px-3 py-2 text-sm text-gray-700 space-y-1">
                <p>
                  Deleting <strong>{isBulk ? `${nodeList.length} ${nodeType}s` : fromPath}</strong> will remove:
                </p>
                <ul className="list-disc list-inside space-y-0.5">
                  {counts.topic_count > 0 && (
                    <li>
                      {counts.topic_count} topic{counts.topic_count === 1 ? '' : 's'}
                    </li>
                  )}
                  {counts.subtopic_count > 0 && (
                    <li>
                      {counts.subtopic_count} subtopic{counts.subtopic_count === 1 ? '' : 's'}
                    </li>
                  )}
                  <li>
                    {counts.mcq_count} MCQ{counts.mcq_count === 1 ? '' : 's'} currently tagged here
                  </li>
                </ul>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button type="button" size="sm" onClick={() => setStep('choose')} disabled={!counts}>
                Continue
              </Button>
            </div>
          </div>
        )}

        {step === 'choose' && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600">
              What should happen to the {counts?.mcq_count ?? 0} MCQ{(counts?.mcq_count ?? 0) === 1 ? '' : 's'}{' '}
              currently tagged here?
            </p>

            <div className="space-y-2">
              <label
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer ${
                  orphanAction === 'move' ? 'border-primary-300 bg-primary-50' : 'border-surface-border'
                } ${options.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="orphan-action"
                  className="mt-0.5 h-4 w-4 text-primary-600 focus:ring-ring"
                  checked={orphanAction === 'move'}
                  disabled={options.length === 0}
                  onChange={() => setOrphanAction('move')}
                />
                <span>
                  <span className="block font-medium text-gray-800">Move to another {nodeType}</span>
                  <span className="block text-xs text-gray-500">
                    Every affected MCQ is retagged onto the {nodeType} you pick below.
                  </span>
                </span>
              </label>

              {orphanAction === 'move' && (
                <div className="pl-6 space-y-1">
                  {options.length === 0 ? (
                    <p className="text-xs text-gray-500">
                      There's no other {nodeType} to move these MCQs to.
                    </p>
                  ) : (
                    <select
                      value={destinationId}
                      onChange={(e) => setDestinationId(e.target.value)}
                      className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                    >
                      <option value="" disabled>
                        Select a {nodeType}…
                      </option>
                      {options.map((opt) => (
                        <option key={opt.id} value={opt.id}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              )}

              <label
                className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm cursor-pointer ${
                  orphanAction === 'delete' ? 'border-danger/50 bg-red-50' : 'border-surface-border'
                }`}
              >
                <input
                  type="radio"
                  name="orphan-action"
                  className="mt-0.5 h-4 w-4 text-danger focus:ring-ring"
                  checked={orphanAction === 'delete'}
                  onChange={() => setOrphanAction('delete')}
                />
                <span>
                  <span className="block font-medium text-danger">Delete these MCQs permanently</span>
                  <span className="block text-xs text-gray-500">
                    Irreversible — the MCQs themselves are removed, not just untagged.
                  </span>
                </span>
              </label>

              {orphanAction === 'delete' && (
                <div className="pl-6 space-y-1">
                  <label className="text-xs font-medium text-gray-600">
                    Type <strong>{expectedConfirmText}</strong> to confirm
                  </label>
                  <input
                    type="text"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    autoFocus
                    className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-danger"
                  />
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={() => setStep('info')} disabled={isPreviewing}>
                Back
              </Button>
              <Button type="button" size="sm" onClick={handlePreview} disabled={!canProceedFromChoose || isPreviewing}>
                {isPreviewing ? 'Checking…' : 'Preview changes'}
              </Button>
            </div>
          </div>
        )}

        {step === 'preview' && previewData && (
          <div className="space-y-4">
            <TaxonomyDiffPreview
              fromPath={fromPath}
              toPath={
                orphanAction === 'move' && selectedOption
                  ? selectedOption.label
                  : '(deleted — MCQs permanently removed, not moved)'
              }
              mcqsAffected={previewData.mcqs_affected}
              subjectsAffected={previewData.subjects_affected}
              topicsAffected={previewData.topics_affected}
              subtopicsAffected={previewData.subtopics_affected}
              note={
                orphanAction === 'move'
                  ? `MCQs will be moved to "${selectedOption?.label ?? ''}".`
                  : 'These MCQs will be permanently deleted, not moved.'
              }
            />

            <div className="flex items-center justify-end gap-2 pt-1">
              <Button type="button" variant="outline" size="sm" onClick={() => setStep('choose')} disabled={isSubmitting}>
                Back
              </Button>
              <Button
                type="button"
                size="sm"
                variant={orphanAction === 'delete' ? 'destructive' : 'default'}
                onClick={handleConfirm}
                disabled={isSubmitting}
              >
                {isSubmitting ? 'Deleting…' : isBulk ? `Confirm delete (${nodeList.length})` : 'Confirm delete'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
