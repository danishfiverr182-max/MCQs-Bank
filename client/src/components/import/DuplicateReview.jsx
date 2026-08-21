// Side-by-side duplicate review UI (Prompt 49).
//
// Input shape — from detectDuplicates() (see server/src/utils/duplicateDetector.js),
// each entry is tagged with where the conflict came from:
//   source: 'db'    → { row, existingQuestionId, similarity? } — conflicts with a
//                      question already in the MCQ bank. We fetch that question
//                      by id to render the "Existing" panel.
//   source: 'batch' → { row, duplicateOfRow, similarity? } — conflicts with
//                      ANOTHER row in the same uploaded file. There's nothing to
//                      fetch here — the "existing" side is just that other row's
//                      own incoming data.
//
// `incomingRows` is a { [rowNumber]: questionObject } map built client-side by
// BulkImport.jsx from the raw uploaded file (mirrors the backend's row
// numbering — see parseJSON in import.service.js) — needed because the report
// itself only carries row numbers, not question text, for duplicate entries.

import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import api, { handleApiError } from '@/lib/axios';

// ─── Similarity badge color banding ─────────────────────────────────
const similarityBadgeClass = (similarity) =>
  similarity >= 90 ? 'bg-danger-light text-danger-dark' : 'bg-warning-light text-warning-dark';

// ─── Default Keep/Skip decision per spec ────────────────────────────
// exact            → skip
// near, >95%       → skip
// near, 85–95%     → 'review' (forces the admin to actively decide,
//                     rather than silently defaulting either way)
const defaultDecisionFor = (entry) => {
  if (entry.kind === 'exact') return 'skip';
  return entry.similarity > 95 ? 'skip' : 'review';
};

function QuestionPanel({ title, question, loading, error }) {
  return (
    <div className="rounded-md border border-surface-border p-3 space-y-2 bg-gray-50/50">
      <p className="text-label font-semibold uppercase tracking-wide text-gray-400">{title}</p>
      {loading ? (
        <p className="text-sm text-gray-400">Loading…</p>
      ) : error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : question ? (
        <>
          <p className="text-sm text-gray-800">{question.question}</p>
          {question.options && (
            <ul className="text-xs text-gray-500 space-y-0.5">
              {Object.entries(question.options).map(([key, value]) => (
                <li
                  key={key}
                  className={key === question.correct_answer ? 'font-semibold text-success' : ''}
                >
                  {key}. {value}
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="text-sm text-gray-400">Not available</p>
      )}
    </div>
  );
}

export default function DuplicateReview({
  duplicates,
  incomingRows = {},
  onDecisionChange,
  readOnly = false,
}) {
  const exact = duplicates?.exact ?? [];
  const near = duplicates?.near ?? [];

  // Flatten into one list, tagged by kind, so a single map renders both.
  const entries = useMemo(
    () => [
      ...exact.map((e) => ({ ...e, kind: 'exact' })),
      ...near.map((e) => ({ ...e, kind: 'near' })),
    ],
    [exact, near]
  );

  const [decisions, setDecisions] = useState({});
  // Per existingQuestionId: { loading, data, error }
  const [existingById, setExistingById] = useState({});

  // Seed decisions with the spec's defaults whenever the entry set changes
  // (e.g. a fresh report). Keyed by row number, which is unique per report.
  useEffect(() => {
    setDecisions((prev) => {
      const next = { ...prev };
      entries.forEach((entry) => {
        if (!(entry.row in next)) {
          next[entry.row] = defaultDecisionFor(entry);
        }
      });
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, near]);

  useEffect(() => {
    onDecisionChange?.(decisions);
  }, [decisions, onDecisionChange]);

  // Fetch existing (DB-sourced) questions by id — deduped so the same
  // existingQuestionId is only ever fetched once even if it matches
  // multiple incoming rows.
  useEffect(() => {
    const idsToFetch = [
      ...new Set(
        entries
          .filter((e) => e.source === 'db' && e.existingQuestionId)
          .map((e) => e.existingQuestionId)
      ),
    ].filter((id) => !existingById[id]);

    if (idsToFetch.length === 0) return;

    idsToFetch.forEach(async (id) => {
      setExistingById((prev) => ({ ...prev, [id]: { loading: true } }));
      try {
        const res = await api.get(`/mcqs/${id}`);
        setExistingById((prev) => ({
          ...prev,
          [id]: { loading: false, data: res.data?.data?.mcq },
        }));
      } catch (err) {
        const message = handleApiError(err);
        setExistingById((prev) => ({ ...prev, [id]: { loading: false, error: message } }));
        toast.error(`Couldn't load existing question ${id}`);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exact, near]);

  const setDecision = (row, value) => {
    setDecisions((prev) => ({ ...prev, [row]: value }));
  };

  if (entries.length === 0) {
    return (
      <p className="text-sm text-gray-500">
        No duplicate questions detected — every row is unique.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {entries.map((entry) => {
        // entry.data is attached server-side (Prompt 50) so this works even
        // if the admin never re-selects the original file; incomingRows
        // (parsed client-side from the uploaded file) is kept as a fallback
        // for reports from before that backend change.
        const incoming = entry.data || incomingRows[entry.row];
        const decision = decisions[entry.row] || defaultDecisionFor(entry);

        const existingPanel =
          entry.source === 'db' ? (
            <QuestionPanel
              title="Existing"
              question={existingById[entry.existingQuestionId]?.data}
              loading={existingById[entry.existingQuestionId]?.loading}
              error={existingById[entry.existingQuestionId]?.error}
            />
          ) : (
            <QuestionPanel
              title={`Existing (row ${entry.duplicateOfRow} in this file)`}
              question={incomingRows[entry.duplicateOfRow]}
            />
          );

        return (
          <div key={`${entry.kind}-${entry.row}`} className="card space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-gray-700">
                <span>Row {entry.row}</span>
                {entry.kind === 'exact' ? (
                  <span className="badge bg-danger-light text-danger-dark">Exact duplicate</span>
                ) : (
                  <span className={`badge ${similarityBadgeClass(entry.similarity)}`}>
                    {entry.similarity}% similar
                  </span>
                )}
                <span className="text-xs text-gray-400">
                  {entry.source === 'db'
                    ? 'vs an existing question in the bank'
                    : `vs row ${entry.duplicateOfRow} in this upload`}
                </span>
              </div>

              <div className="flex items-center gap-2">
                {decision === 'review' && (
                  <span className="badge bg-warning-light text-warning-dark">Needs review</span>
                )}
                <div className="inline-flex rounded-md border border-surface-border overflow-hidden text-xs font-medium">
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => setDecision(entry.row, 'keep')}
                    className={`px-3 py-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      decision === 'keep'
                        ? 'bg-success text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Keep
                  </button>
                  <button
                    type="button"
                    disabled={readOnly}
                    onClick={() => setDecision(entry.row, 'skip')}
                    className={`px-3 py-1.5 border-l border-surface-border transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                      decision === 'skip'
                        ? 'bg-danger text-white'
                        : 'bg-white text-gray-600 hover:bg-gray-50'
                    }`}
                  >
                    Skip
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <QuestionPanel title="Incoming" question={incoming} />
              {existingPanel}
            </div>
          </div>
        );
      })}
    </div>
  );
}
