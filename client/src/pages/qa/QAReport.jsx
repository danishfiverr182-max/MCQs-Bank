import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import QABadge from '@/components/qa/QABadge';
import QAChecklist from '@/components/qa/QAChecklist';
import SimilarPair from '@/components/qa/SimilarPair';

// QAReport.jsx — Phase 8, Prompt 89. The detailed, single-test QA
// page: full checklist plus any flagged similar pairs. Deliberately
// scoped to one test — QADashboard.jsx (Prompt 88) is the cross-test
// launcher/activity feed, this page is where an admin actually reads
// and acts on one test's result.

export default function QAReport() {
  const { testId } = useParams();
  const navigate = useNavigate();

  const [test, setTest] = useState(null);
  const [examName, setExamName] = useState(null);
  const [report, setReport] = useState(null);
  const [reportMissing, setReportMissing] = useState(false);

  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [isRunning, setIsRunning] = useState(false); // covers both "Run QA Now" and "Re-run QA"
  const [isFinalizing, setIsFinalizing] = useState(false);

  // Similar-pair MCQ content — one batched map, shared across every
  // SimilarPair rendered on the page, never fetched per pair.
  const [mcqsById, setMcqsById] = useState(new Map());
  const [isLoadingPairs, setIsLoadingPairs] = useState(false);

  const fetchReport = useCallback(async () => {
    try {
      const response = await apiClient.get(`/qa/${testId}/latest`);
      setReport(response.data.data.report);
      setReportMissing(false);
    } catch (err) {
      if (err?.statusCode === 404) {
        setReport(null);
        setReportMissing(true);
      } else {
        throw err;
      }
    }
  }, [testId]);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      // getTestById (Phase 6) is the only single-test fetch this
      // system exposes — heavier than strictly needed for header
      // fields alone, but reusing it avoids a second, near-duplicate
      // "test summary" endpoint just for this page.
      const testResponse = await apiClient.get(`/generator/${testId}`);
      setTest(testResponse.data.data.test);

      await fetchReport();
    } catch (err) {
      setLoadError(handleApiError(err) || 'Failed to load QA report');
    } finally {
      setIsLoading(false);
    }
  }, [testId, fetchReport]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  // Best-effort exam name — same graceful-degradation pattern
  // GeneratedTest.jsx already uses, since GeneratedTest only stores
  // exam_id (a string reference), not an embedded exam document.
  useEffect(() => {
    if (!test?.exam_id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiClient.get(`/exams/${test.exam_id}`);
        if (!cancelled) setExamName(response.data.data.exam?.exam_name || null);
      } catch {
        if (!cancelled) setExamName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [test?.exam_id]);

  const nearDuplicateWarnings = useMemo(
    () => (report?.warnings || []).filter((w) => w.check === 'near_duplicates' && w.mcq_ids?.length === 2),
    [report]
  );

  // Batched fetch of every MCQ referenced across ALL near-duplicate
  // warnings on this page — one request, not one per pair.
  useEffect(() => {
    if (nearDuplicateWarnings.length === 0) {
      setMcqsById(new Map());
      return undefined;
    }

    let cancelled = false;
    (async () => {
      setIsLoadingPairs(true);
      try {
        const uniqueIds = [...new Set(nearDuplicateWarnings.flatMap((w) => w.mcq_ids))];
        const response = await apiClient.get('/mcqs', {
          params: { ids: uniqueIds.join(','), limit: 100 },
        });
        if (cancelled) return;
        const map = new Map();
        (response.data.data?.items || []).forEach((mcq) => map.set(mcq.question_id, mcq));
        setMcqsById(map);
      } catch {
        if (!cancelled) setMcqsById(new Map());
      } finally {
        if (!cancelled) setIsLoadingPairs(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nearDuplicateWarnings]);

  const handleRunQA = async () => {
    setIsRunning(true);
    try {
      await apiClient.post(`/qa/${testId}/run`);
      toast.success('QA run completed');
      await fetchReport();
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to run QA');
    } finally {
      setIsRunning(false);
    }
  };

  const handleFinalize = async () => {
    setIsFinalizing(true);
    try {
      const response = await apiClient.post(`/qa/${testId}/finalize`);
      setTest(response.data.data.test);
      toast.success('Test finalized');
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to finalize test');
    } finally {
      setIsFinalizing(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  if (!test) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{loadError || 'Test not found'}</p>
        <Link to="/admin/qa" className="text-sm text-primary-600 hover:underline">
          Back to QA Dashboard
        </Link>
      </div>
    );
  }

  const badgeStatus = report ? (report.passed ? 'passed' : 'failed') : 'not_run';
  const isFinalized = Boolean(test.finalized);

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div className="card space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-1">
            <h1 className="section-title font-mono">{test.test_id}</h1>
            <p className="text-sm text-gray-500">
              Exam:{' '}
              <Link
                to={`/admin/generator/tests/${test.test_id}`}
                className="text-primary-600 hover:underline"
              >
                {examName || test.exam_id}
              </Link>
            </p>
            <p className="text-xs text-gray-400">
              Generated {test.generated_at ? new Date(test.generated_at).toLocaleString() : '—'}
              {report && (
                <> · QA last checked {new Date(report.generated_at).toLocaleString()}</>
              )}
            </p>
          </div>

          <div className="flex items-center gap-2">
            {isFinalized && (
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-success-light text-success-dark">
                Finalized ✓
              </span>
            )}
            <QABadge status={badgeStatus} size="md" />
          </div>
        </div>
      </div>

      {/* Empty state — no QA run yet */}
      {reportMissing && (
        <div className="card text-center py-10 space-y-3">
          <p className="text-gray-600 font-medium">QA has not been run on this test.</p>
          <p className="text-sm text-gray-400">
            Run the QA pipeline to check question count, subject/difficulty distribution,
            duplicates, and content validity.
          </p>
          <Button type="button" onClick={handleRunQA} disabled={isRunning}>
            {isRunning ? 'Running QA…' : 'Run QA Now'}
          </Button>
        </div>
      )}

      {/* Checklist + actions */}
      {report && (
        <>
          <div className="card space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-semibold text-gray-800">QA Checklist</h2>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleRunQA}
                disabled={isRunning}
              >
                {isRunning ? 'Re-running…' : 'Re-run QA'}
              </Button>
            </div>
            <QAChecklist checks={report.checks} />
          </div>

          {/* Similar Pairs Found */}
          {nearDuplicateWarnings.length > 0 && (
            <div className="card space-y-4">
              <h2 className="text-sm font-semibold text-gray-800">Similar Pairs Found</h2>

              {isLoadingPairs && (
                <div className="space-y-3">
                  {Array.from({ length: nearDuplicateWarnings.length }).map((_, i) => (
                    <div
                      key={`pair-skeleton-${i}`}
                      className="h-24 bg-gray-100 rounded-lg animate-pulse"
                    />
                  ))}
                </div>
              )}

              {!isLoadingPairs &&
                nearDuplicateWarnings.map((warning, index) => {
                  const [idA, idB] = warning.mcq_ids;
                  return (
                    <div
                      key={`${idA}-${idB}-${index}`}
                      className="space-y-3 border-t border-surface-border pt-4 first:border-t-0 first:pt-0"
                    >
                      <SimilarPair
                        mcqA={mcqsById.get(idA)}
                        mcqB={mcqsById.get(idB)}
                        score={warning.score}
                      />
                      <div className="flex justify-end">
                        <button
                          type="button"
                          onClick={() =>
                            navigate('/admin/qa/similarity', {
                              state: {
                                mcqIdA: idA,
                                mcqIdB: idB,
                                score: warning.score,
                                fromTestId: test.test_id,
                              },
                            })
                          }
                          className="text-sm font-medium text-primary-600 hover:underline"
                        >
                          Review &amp; Resolve →
                        </button>
                      </div>
                    </div>
                  );
                })}
            </div>
          )}

          {/* Finalize */}
          <div className="card flex items-center justify-between gap-4 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-gray-800">Finalize Test</h2>
              <p className="text-xs text-gray-500">
                {isFinalized
                  ? 'This test has been finalized.'
                  : report.passed
                    ? 'This test has passed QA and can be finalized.'
                    : 'Cannot finalize — resolve failing checks first.'}
              </p>
            </div>
            <span
              title={
                !report.passed && !isFinalized
                  ? 'Cannot finalize — resolve failing checks first'
                  : undefined
              }
            >
              <Button
                type="button"
                onClick={handleFinalize}
                disabled={!report.passed || isFinalizing || isFinalized}
              >
                {isFinalized ? 'Finalized ✓' : isFinalizing ? 'Finalizing…' : 'Finalize Test'}
              </Button>
            </span>
          </div>
        </>
      )}
    </div>
  );
}
