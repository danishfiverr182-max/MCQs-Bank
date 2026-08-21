import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import QABadge from '@/components/qa/QABadge';

// QADashboard.jsx — Phase 8, Prompt 88. The QA landing page: a
// cross-test launcher + activity feed, deliberately distinct from
// QAReport.jsx (Prompt 89), which is scoped to one test's detailed
// checklist. This page never renders a full checklist itself — only a
// picker to run QA, and a table of where to go look at results.

const RECENT_ACTIVITY_LIMIT = 10;
const SEARCH_DEBOUNCE_MS = 300;

// ─── Test picker ─────────────────────────────────────────────────────
// A lighter-weight sibling of ExamSelector.jsx (Phase 6) — searches
// GeneratedTest records by test_id (server-side, Prompt 88's `search`
// param on GET /api/generator) rather than exams. Exam names are
// resolved from the `examNames` map the parent page already builds
// (same batched-fetch-once pattern TestHistory.jsx uses), so this
// component never fetches exams itself.
function TestPicker({ selected, onSelect, examNames }) {
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [results, setResults] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const containerRef = useRef(null);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (!isOpen) return undefined;
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    // An empty query still searches (shows the most recent tests) —
    // the admin shouldn't have to type anything to see options.
    debounceRef.current = setTimeout(async () => {
      setIsLoading(true);
      try {
        const response = await apiClient.get('/generator', {
          params: { search: query || undefined, limit: 8, sortBy: 'generated_at' },
        });
        setResults(response.data.data?.items || []);
      } catch {
        setResults([]);
      } finally {
        setIsLoading(false);
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => clearTimeout(debounceRef.current);
  }, [query, isOpen]);

  // Client-side supplement: exam-name matching on top of the server's
  // test_id search, using the already-fetched examNames map — so
  // "FPSC" (an exam/org name, not a test_id substring) still narrows
  // results sensibly once the initial by-test_id fetch has come back.
  const visibleResults = results.filter((test) => {
    if (!query.trim()) return true;
    const q = query.trim().toLowerCase();
    const examName = (examNames.get(test.exam_id) || test.exam_id || '').toLowerCase();
    return test.test_id.toLowerCase().includes(q) || examName.includes(q);
  });

  const commitSelection = (test) => {
    onSelect(test);
    setQuery(test.test_id);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={containerRef}>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-gray-700">Search by test ID or exam name</span>
        <input
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          value={isOpen ? query : selected?.test_id || query}
          placeholder="e.g. TEST_2026_014 or FPSC…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      {isOpen && (
        <div className="absolute z-20 mt-1 w-full max-h-72 overflow-y-auto rounded-md border border-surface-border bg-white shadow-lg">
          {isLoading && (
            <div className="px-4 py-3 space-y-2">
              <div className="h-4 w-2/3 rounded bg-gray-100 animate-pulse" />
              <div className="h-4 w-1/2 rounded bg-gray-100 animate-pulse" />
            </div>
          )}

          {!isLoading && visibleResults.length === 0 && (
            <p className="px-4 py-3 text-sm text-gray-400">No matching tests.</p>
          )}

          {!isLoading &&
            visibleResults.map((test) => (
              <button
                key={test.test_id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commitSelection(test)}
                className="flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm hover:bg-gray-50"
              >
                <span className="min-w-0">
                  <span className="block font-mono text-xs text-gray-800 truncate">
                    {test.test_id}
                  </span>
                  <span className="block text-xs text-gray-400 truncate">
                    {examNames.get(test.exam_id) || test.exam_id}
                  </span>
                </span>
                <QABadge status={test.latest_qa_status} size="sm" />
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

export default function QADashboard() {
  const navigate = useNavigate();

  const [examNames, setExamNames] = useState(new Map());
  const [selectedTest, setSelectedTest] = useState(null);
  const [isRunning, setIsRunning] = useState(false);

  const [activity, setActivity] = useState([]);
  const [isLoadingActivity, setIsLoadingActivity] = useState(true);
  const [activityError, setActivityError] = useState(null);

  // Same batched exam-name lookup TestHistory.jsx already uses — one
  // fetch of every exam (active + inactive), never a per-row request.
  useEffect(() => {
    (async () => {
      try {
        const response = await apiClient.get('/exams');
        const grouped = response.data.data || {};
        const map = new Map();
        Object.values(grouped).forEach((exams) => {
          exams.forEach((exam) => map.set(exam.exam_id, exam.exam_name));
        });
        setExamNames(map);
      } catch {
        // Non-fatal — rows just fall back to showing the raw exam_id.
      }
    })();
  }, []);

  const fetchActivity = useCallback(async () => {
    setIsLoadingActivity(true);
    setActivityError(null);
    try {
      const response = await apiClient.get('/generator', {
        params: {
          qa_checked: 'true',
          sortBy: 'updated_at',
          limit: RECENT_ACTIVITY_LIMIT,
        },
      });
      setActivity(response.data.data?.items || []);
    } catch (err) {
      setActivityError(handleApiError(err) || 'Failed to load recent QA activity');
    } finally {
      setIsLoadingActivity(false);
    }
  }, []);

  useEffect(() => {
    fetchActivity();
  }, [fetchActivity]);

  const handleRunQA = async () => {
    if (!selectedTest) return;
    setIsRunning(true);
    try {
      await apiClient.post(`/qa/${selectedTest.test_id}/run`);
      toast.success(`QA completed for ${selectedTest.test_id}`);
      navigate(`/admin/qa/report/${selectedTest.test_id}`);
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to run QA');
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-6 max-w-4xl">
      <div>
        <h1 className="section-title">Quality Assurance</h1>
        <p className="text-sm text-gray-500">
          Run QA on any generated test, or jump into a recent QA result below.
        </p>
      </div>

      {/* ── Run QA ─────────────────────────────────────────────── */}
      <div className="card space-y-4">
        <h2 className="text-sm font-semibold text-gray-800">Run QA</h2>

        <TestPicker
          selected={selectedTest}
          onSelect={setSelectedTest}
          examNames={examNames}
        />

        {selectedTest && (
          <div className="flex items-center justify-between rounded-md border border-surface-border bg-gray-50/50 px-4 py-3">
            <div className="min-w-0">
              <p className="font-mono text-sm text-gray-800 truncate">{selectedTest.test_id}</p>
              <p className="text-xs text-gray-500 truncate">
                {examNames.get(selectedTest.exam_id) || selectedTest.exam_id} ·{' '}
                {selectedTest.question_count} question
                {selectedTest.question_count === 1 ? '' : 's'}
              </p>
            </div>
            <Button type="button" onClick={handleRunQA} disabled={isRunning}>
              {isRunning ? 'Running QA…' : 'Run QA'}
            </Button>
          </div>
        )}
      </div>

      {/* ── Recent QA Activity ─────────────────────────────────── */}
      <div className="card p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-surface-border">
          <h2 className="text-sm font-semibold text-gray-800">Recent QA Activity</h2>
          <p className="text-xs text-gray-500">
            Tests that have had QA run at least once, most recently checked first.
          </p>
        </div>

        {activityError && !isLoadingActivity && (
          <div className="px-4 py-4 flex items-center justify-between gap-3">
            <p className="text-sm text-danger">{activityError}</p>
            <button
              type="button"
              onClick={fetchActivity}
              className="text-xs font-medium text-primary-600 hover:underline shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        {isLoadingActivity && (
          <div className="p-4 space-y-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={`skeleton-${i}`} className="h-12 bg-gray-100 rounded-md animate-pulse" />
            ))}
          </div>
        )}

        {!isLoadingActivity && !activityError && activity.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-gray-500">
            No tests have had QA run yet — use "Run QA" above to check your first one.
          </p>
        )}

        {!isLoadingActivity && !activityError && activity.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-gray-400 border-b border-surface-border bg-gray-50">
                  <th className="py-2.5 px-4 font-medium">Test ID</th>
                  <th className="py-2.5 px-4 font-medium">Exam</th>
                  <th className="py-2.5 px-4 font-medium">QA Status</th>
                  <th className="py-2.5 px-4 font-medium">Last Checked</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {activity.map((test) => (
                  <tr
                    key={test.test_id}
                    role="button"
                    tabIndex={0}
                    onClick={() => navigate(`/admin/qa/report/${test.test_id}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') navigate(`/admin/qa/report/${test.test_id}`);
                    }}
                    className="cursor-pointer hover:bg-gray-50"
                  >
                    <td className="py-2.5 px-4 font-mono text-xs text-gray-800">
                      {test.test_id}
                    </td>
                    <td className="py-2.5 px-4 text-gray-700">
                      {examNames.get(test.exam_id) || test.exam_id}
                    </td>
                    <td className="py-2.5 px-4">
                      <QABadge status={test.latest_qa_status} size="sm" />
                    </td>
                    <td className="py-2.5 px-4 text-gray-500">
                      {test.updated_at ? new Date(test.updated_at).toLocaleString() : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
