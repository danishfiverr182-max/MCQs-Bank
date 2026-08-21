// Dedicated report view for a completed import (Prompt 49), extended in
// Prompt 50 to close the loop: submitting the admin's duplicate
// Keep/Skip decisions as a real insert via POST /api/import/resolve.
//
// Reports aren't fetched by ID yet at this stage — the `report` object
// (produced by BulkImport.jsx's upload call) is passed via React Router
// navigation state instead. This means a hard refresh on this page
// loses the report entirely — full re-fetch of a stored report by
// batch_id is a natural Phase 5+ enhancement (see the note above
// ImportHistory.jsx's row-click modal for the same reasoning).

import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import ValidationTable from '@/components/import/ValidationTable';
import DuplicateReview from '@/components/import/DuplicateReview';
import NewSubtopicsPanel from '@/components/import/NewSubtopicsPanel';
import api, { handleApiError } from '@/lib/axios';

const buildStatCards = (report, insertedOverride) => [
  { label: 'Total Rows', value: report.total, className: 'text-gray-900' },
  { label: 'Inserted', value: insertedOverride ?? report.inserted, className: 'text-success' },
  { label: 'Failed', value: report.failed?.length ?? 0, className: 'text-danger' },
  {
    label: 'Exact Duplicates',
    value: report.duplicates?.exact?.length ?? 0,
    className: 'text-warning-dark',
  },
  {
    label: 'Near Duplicates',
    value: report.duplicates?.near?.length ?? 0,
    className: 'text-warning-dark',
  },
];

export default function ImportReport() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('validation');

  const report = location.state?.report;
  const incomingRows = location.state?.incomingRows || {};

  // Decisions map lifted up from DuplicateReview so Confirm Insertion can
  // see it, keyed by row number: { [row]: 'keep' | 'skip' | 'review' }.
  const [decisions, setDecisions] = useState({});
  const [isResolving, setIsResolving] = useState(false);
  const [isResolved, setIsResolved] = useState(false);
  const [insertedOverride, setInsertedOverride] = useState(null);

  // MCQs — whether from this initial import or from a later duplicate
  // "keep" decision — are inserted with status: 'pending' and won't be
  // pulled into a generated test until approved (see mcq.service.js's
  // bulkSetStatus comment). Track every id we know is pending approval
  // from this batch so "Approve all" has something to send, and so we
  // can update counts/disable the button once it's done.
  const [pendingApprovalIds, setPendingApprovalIds] = useState(
    () => report?.insertedIds ?? []
  );
  const [isApproving, setIsApproving] = useState(false);
  const [approvedCount, setApprovedCount] = useState(0);

  // Subtopics newly created in the Taxonomy by THIS import (see
  // import.service.js's ensureTaxonomyForInsertedDocs) — never all of
  // MongoDB's subtopics, only the delta this specific batch introduced.
  // Confirm Insertion (a "keep duplicate" second pass) can occasionally
  // add a few more, so this starts from the initial report and merges
  // in anything resolveDuplicates reports too.
  const [newSubtopics, setNewSubtopics] = useState(() => report?.newSubtopics ?? []);

  // "Prompt updated" banner — only meaningful after a real insert (a
  // dry run/validate_only always has report.inserted === 0, since
  // nothing is ever written for one of those — see import.service.js's
  // buildReport). The server is the source of truth for the new
  // range, so this fetches the current prompt-state fresh on mount
  // rather than trying to derive X–Y client-side.
  const [promptRange, setPromptRange] = useState(null);
  const [isPromptBannerDismissed, setIsPromptBannerDismissed] = useState(false);

  useEffect(() => {
    if (!report) return;
    api
      .get('/import/prompt-state')
      .then((response) => {
        const data = response.data?.data;
        if (data) setPromptRange({ rangeStart: data.rangeStart, rangeEnd: data.rangeEnd });
      })
      .catch(() => {
        // Non-critical — the banner simply won't render without a range.
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const duplicateEntries = useMemo(() => {
    if (!report) return [];
    return [...(report.duplicates?.exact ?? []), ...(report.duplicates?.near ?? [])];
  }, [report]);

  // Confirm Insertion stays disabled until every duplicate row has an
  // explicit keep/skip — i.e. nothing left in the default "needs review"
  // state (or simply not decided upon yet, e.g. the admin never opened
  // the Duplicates tab).
  const pendingReviewCount = duplicateEntries.filter(
    (entry) => (decisions[entry.row] || 'review') === 'review'
  ).length;

  const handleConfirmInsertion = async () => {
    if (!report || isResolving || isResolved) return;

    const keepDecisions = duplicateEntries
      .filter((entry) => decisions[entry.row] === 'keep')
      .map((entry) => ({ row: entry.row, action: 'keep', data: entry.data }));

    setIsResolving(true);
    try {
      const response = await api.post('/import/resolve', {
        batchId: report.batch_id,
        keepDecisions,
      });
      const result = response.data?.data;

      setInsertedOverride(result?.totalInsertedCount ?? report.inserted);
      setIsResolved(true);
      // Newly-kept duplicates are pending approval too — fold their ids
      // in so "Approve all" covers this batch's full insert set.
      if (Array.isArray(result?.insertedIds) && result.insertedIds.length > 0) {
        setPendingApprovalIds((prev) => [...prev, ...result.insertedIds]);
      }
      if (Array.isArray(result?.newSubtopics) && result.newSubtopics.length > 0) {
        setNewSubtopics((prev) => Array.from(new Set([...prev, ...result.newSubtopics])));
      }
      toast.success(
        keepDecisions.length > 0
          ? `Inserted ${result?.insertedCount ?? 0} kept duplicate(s)`
          : 'Duplicates resolved — nothing marked "keep"'
      );
    } catch (err) {
      toast.error(handleApiError(err));
    } finally {
      setIsResolving(false);
    }
  };

  // Approves every MCQ this batch inserted in one call, via
  // PATCH /api/mcq/bulk-approve, instead of leaving the admin to click
  // Approve one row at a time in MCQList.jsx. This is the step that
  // makes imported MCQs actually available to the test generator —
  // generator.service.js only ever draws from status: 'approved'.
  const handleApproveAll = async () => {
    if (pendingApprovalIds.length === 0 || isApproving) return;

    setIsApproving(true);
    try {
      const response = await api.patch('/mcqs/bulk-approve', { ids: pendingApprovalIds });
      const result = response.data?.data;
      const modified = result?.modifiedCount ?? pendingApprovalIds.length;

      setApprovedCount(modified);
      setPendingApprovalIds([]);
      toast.success(
        `Approved ${modified} MCQ${modified === 1 ? '' : 's'} — ready for test generation`
      );
    } catch (err) {
      toast.error(handleApiError(err));
    } finally {
      setIsApproving(false);
    }
  };

  if (!report) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="section-title">Import Report</h1>
        <div className="card">
          <p className="text-sm text-gray-500">
            No report to show here — this page only renders right after a
            completed upload.
          </p>
          <Link
            to="/admin/import"
            className="mt-4 inline-block text-sm font-medium text-primary hover:underline"
          >
            ← Back to Import
          </Link>
        </div>
      </div>
    );
  }

  const stats = buildStatCards(report, insertedOverride);
  const duplicateCount = duplicateEntries.length;

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">Import Report</h1>
          {report.batch_id && <p className="text-xs text-gray-400">Batch {report.batch_id}</p>}
        </div>
        <div className="flex items-center gap-4">
          <Link
            to="/admin/import/history"
            className="text-sm font-medium text-gray-500 hover:text-gray-700"
          >
            Import History
          </Link>
          <button
            type="button"
            onClick={() => navigate('/admin/import')}
            className="text-sm font-medium text-primary hover:underline"
          >
            ← Back to Import
          </button>
        </div>
      </div>

      {report.inserted > 0 && promptRange && !isPromptBannerDismissed && (
        <div className="card flex items-center justify-between bg-primary-light border-primary-200 py-3">
          <p className="text-sm text-primary-700">
            Prompt updated — {newSubtopics.length} new subtopic{newSubtopics.length === 1 ? '' : 's'}{' '}
            added to the bank, next batch is now {promptRange.rangeStart}–{promptRange.rangeEnd}.
          </p>
          <button
            type="button"
            onClick={() => setIsPromptBannerDismissed(true)}
            aria-label="Dismiss"
            className="text-primary-700 hover:text-primary-900 text-sm font-medium ml-4"
          >
            Dismiss
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        {stats.map((stat) => (
          <div key={stat.label} className="card p-4">
            <p className={`text-2xl font-semibold ${stat.className}`}>{stat.value}</p>
            <p className="text-xs text-gray-500 mt-1">{stat.label}</p>
          </div>
        ))}
      </div>

      <NewSubtopicsPanel subtopics={newSubtopics} />

      {(pendingApprovalIds.length > 0 || approvedCount > 0) && (
        <div className="card flex items-center justify-between bg-amber-50 border-amber-200">
          <div className="text-sm text-gray-700">
            {approvedCount > 0 && pendingApprovalIds.length === 0 ? (
              <span className="text-success font-medium">
                {approvedCount} MCQ{approvedCount === 1 ? '' : 's'} approved — available for test
                generation now.
              </span>
            ) : (
              <span>
                <strong>{pendingApprovalIds.length}</strong> imported MCQ
                {pendingApprovalIds.length === 1 ? '' : 's'} {pendingApprovalIds.length === 1 ? 'is' : 'are'} saved
                but still <strong>pending approval</strong> — the test generator only draws from
                approved questions, so they won't show up in a generated test until approved.
              </span>
            )}
          </div>
          {pendingApprovalIds.length > 0 && (
            <Button type="button" onClick={handleApproveAll} disabled={isApproving}>
              {isApproving ? 'Approving…' : `Approve all ${pendingApprovalIds.length}`}
            </Button>
          )}
        </div>
      )}

      <div className="border-b border-surface-border flex gap-6">
        <button
          type="button"
          onClick={() => setActiveTab('validation')}
          className={`pb-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'validation'
              ? 'border-primary text-primary'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Validation Errors ({report.failed?.length ?? 0})
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('duplicates')}
          className={`pb-3 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'duplicates'
              ? 'border-primary text-primary'
              : 'border-transparent text-gray-500 hover:text-gray-700'
          }`}
        >
          Duplicates ({duplicateCount})
        </button>
      </div>

      {activeTab === 'validation' ? (
        <ValidationTable failedRows={report.failed ?? []} />
      ) : (
        <DuplicateReview
          duplicates={report.duplicates}
          incomingRows={incomingRows}
          onDecisionChange={setDecisions}
          readOnly={isResolved}
        />
      )}

      {/* Confirm Insertion — only relevant when there's actually something
          to resolve. Duplicate rows are never part of the initial insert
          pass regardless of mode, so this is the only path that inserts
          whichever ones the admin marks "keep". */}
      {duplicateCount > 0 && (
        <div className="card flex items-center justify-between">
          <div className="text-sm text-gray-500">
            {isResolved ? (
              <span className="text-success font-medium">
                Duplicates resolved — this batch has already been confirmed.
              </span>
            ) : pendingReviewCount > 0 ? (
              <span>
                {pendingReviewCount} near-duplicate{pendingReviewCount === 1 ? '' : 's'} still
                need{pendingReviewCount === 1 ? 's' : ''} a Keep/Skip decision in the Duplicates
                tab before you can confirm.
              </span>
            ) : (
              <span>All duplicates have a decision — ready to confirm.</span>
            )}
          </div>
          <Button
            type="button"
            onClick={handleConfirmInsertion}
            disabled={isResolved || isResolving || pendingReviewCount > 0}
          >
            {isResolving ? 'Confirming…' : isResolved ? 'Confirmed' : 'Confirm Insertion'}
          </Button>
        </div>
      )}
    </div>
  );
}
