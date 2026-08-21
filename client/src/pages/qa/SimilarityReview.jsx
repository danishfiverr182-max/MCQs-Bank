import { useEffect, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import SimilarPair from '@/components/qa/SimilarPair';
import MCQForm from '@/components/mcq/MCQForm';

// SimilarityReview.jsx — Phase 8, Prompt 90. The similarity resolution
// workspace: where an admin actually ACTS on a flagged pair, as
// opposed to SimilarPair.jsx (Prompt 89) which only ever displays one.
//
// Supports two entry points in one page, per the spec:
// - A specific known pair, via route state (mcqIdA/mcqIdB/score,
//   carried here by QAReport.jsx's "Review & Resolve" link).
// - A standalone `?question_id=` query param (an admin browsing MCQ
//   management wanting to check one question against the whole
//   database) — fetches every live candidate match and lets the admin
//   browse/resolve each one.

const RESOLUTION_LABELS = {
  kept: 'Kept both — marked as reviewed',
  deleted: 'Question B deleted',
  merged: 'Merged — surviving question updated, other deleted',
};

// ─── PairActions ─────────────────────────────────────────────────────
// One flagged pair's action controls (Keep Both / Delete #2 / Merge),
// composed alongside the read-only SimilarPair.jsx display. Shared by
// both entry modes below so there's exactly one implementation of
// "how a pair gets resolved" in this file.
function PairActions({ mcqA, mcqB, score, onResolved }) {
  const [resolution, setResolution] = useState(null); // null | 'kept' | 'deleted' | 'merged'
  const [busyAction, setBusyAction] = useState(null); // null | 'keep' | 'delete' | 'merge'
  const [showMergeForm, setShowMergeForm] = useState(false);

  const canAct = mcqA && mcqB && !resolution;

  const handleKeepBoth = async () => {
    setBusyAction('keep');
    try {
      await apiClient.post('/qa/pairs/dismiss', {
        mcq_id_a: mcqA.question_id,
        mcq_id_b: mcqB.question_id,
      });
      toast.success('Marked as reviewed — kept both');
      setResolution('kept');
      onResolved?.('kept');
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to record decision');
    } finally {
      setBusyAction(null);
    }
  };

  const handleDeleteSecond = async () => {
    setBusyAction('delete');
    try {
      await apiClient.delete(`/mcqs/${mcqB._id}`);
      toast.success(`${mcqB.question_id} deleted`);
      setResolution('deleted');
      onResolved?.('deleted');
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to delete question');
    } finally {
      setBusyAction(null);
    }
  };

  const handleMergeSubmit = async (payload) => {
    setBusyAction('merge');
    try {
      // Composite action: edit #1 with the merged content, then remove
      // #2 — reuses existing MCQ edit + delete endpoints rather than a
      // dedicated merge endpoint. This is a pragmatic "edit one, delete
      // other" scope, not true field-level content merging.
      await apiClient.patch(`/mcqs/${mcqA._id}`, payload);
      await apiClient.delete(`/mcqs/${mcqB._id}`);
      toast.success(`Merged into ${mcqA.question_id}; ${mcqB.question_id} deleted`);
      setShowMergeForm(false);
      setResolution('merged');
      onResolved?.('merged');
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to merge questions');
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className="space-y-4">
      <SimilarPair mcqA={mcqA} mcqB={mcqB} score={score} />

      {resolution ? (
        <div className="rounded-md border border-success bg-success-light px-4 py-2.5 text-sm font-medium text-success-dark">
          ✓ {RESOLUTION_LABELS[resolution]}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={handleKeepBoth} disabled={!canAct || busyAction}>
            {busyAction === 'keep' ? 'Saving…' : 'Keep Both'}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={handleDeleteSecond}
            disabled={!canAct || busyAction}
          >
            {busyAction === 'delete' ? 'Deleting…' : 'Delete #2'}
          </Button>
          <Button
            type="button"
            onClick={() => setShowMergeForm((v) => !v)}
            disabled={!canAct || busyAction}
          >
            {showMergeForm ? 'Cancel Merge' : 'Merge'}
          </Button>
        </div>
      )}

      {showMergeForm && !resolution && (
        <div className="border-t border-surface-border pt-4 space-y-2">
          <p className="text-sm text-gray-500">
            Editing <span className="font-mono">{mcqA.question_id}</span> as the surviving
            question. Saving will update this question and delete{' '}
            <span className="font-mono">{mcqB.question_id}</span>.
          </p>
          <MCQForm
            initialValues={mcqA}
            onSubmit={handleMergeSubmit}
            isSubmitting={busyAction === 'merge'}
          />
        </div>
      )}
    </div>
  );
}

export default function SimilarityReview() {
  const location = useLocation();
  const [searchParams] = useSearchParams();

  const routedPair = location.state || {};
  const hasRoutedPair = Boolean(routedPair.mcqIdA && routedPair.mcqIdB);
  const standaloneQuestionId = searchParams.get('question_id');

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // ── Pair mode state ──────────────────────────────────────────────
  const [mcqA, setMcqA] = useState(null);
  const [mcqB, setMcqB] = useState(null);

  // ── Browse mode state ────────────────────────────────────────────
  const [target, setTarget] = useState(null);
  const [candidates, setCandidates] = useState([]); // [{ mcq, score }]

  useEffect(() => {
    let cancelled = false;

    (async () => {
      setIsLoading(true);
      setLoadError(null);
      try {
        if (hasRoutedPair) {
          const [resA, resB] = await Promise.all([
            apiClient.get(`/mcqs/${routedPair.mcqIdA}`),
            apiClient.get(`/mcqs/${routedPair.mcqIdB}`),
          ]);
          if (cancelled) return;
          setMcqA(resA.data.data.mcq);
          setMcqB(resB.data.data.mcq);
        } else if (standaloneQuestionId) {
          const [targetRes, similarRes] = await Promise.all([
            apiClient.get(`/mcqs/${standaloneQuestionId}`),
            apiClient.get(`/qa/similar/${standaloneQuestionId}`),
          ]);
          if (cancelled) return;
          setTarget(targetRes.data.data.mcq);
          setCandidates(similarRes.data.data.results || []);
        } else {
          setLoadError('No question specified to review.');
        }
      } catch (err) {
        if (!cancelled) setLoadError(handleApiError(err) || 'Failed to load questions to compare');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasRoutedPair, routedPair.mcqIdA, routedPair.mcqIdB, standaloneQuestionId]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{loadError}</p>
        <Link to="/admin/qa" className="text-sm text-primary-600 hover:underline">
          Back to QA Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="section-title">Similarity Review</h1>
          <p className="text-sm text-gray-500">
            {hasRoutedPair
              ? 'Resolve this flagged pair.'
              : 'Browse candidate matches for this question across the whole bank.'}
          </p>
        </div>
        {routedPair.fromTestId && (
          <Link
            to={`/admin/qa/report/${routedPair.fromTestId}`}
            className="text-sm text-primary-600 hover:underline"
          >
            ← Back to QA Report
          </Link>
        )}
      </div>

      {/* Pair mode — exactly one comparison */}
      {hasRoutedPair && (
        <div className="card">
          <PairActions mcqA={mcqA} mcqB={mcqB} score={routedPair.score} />
        </div>
      )}

      {/* Browse mode — scrollable list of candidates */}
      {!hasRoutedPair && standaloneQuestionId && (
        <div className="space-y-4">
          {candidates.length === 0 && (
            <div className="card text-center py-8 text-sm text-gray-500">
              No similar questions found in the database for {target?.question_id}.
            </div>
          )}
          <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
            {candidates.map(({ mcq: candidateMcq, score }) => (
              <div key={candidateMcq.question_id} className="card">
                <PairActions mcqA={target} mcqB={candidateMcq} score={score} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
