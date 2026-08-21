import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import apiClient, { handleApiError } from '@/lib/axios';

// Searchable exam picker for the generator flow (Prompt 67).
//
// Fetches GET /api/exams?status=active — filtered at the source rather
// than fetching everything and letting an inactive exam slip through
// to selection, since Prompt 62's resolveBlueprint / loadExam rejects
// generation for an inactive exam anyway. Response arrives already
// grouped-by-org (same shape ExamList.jsx renders directly, per
// exam.service.js's listGroupedByOrg), so no client-side regrouping —
// only client-side *filtering* of that same grouped shape as the admin
// types.
//
// Props:
// - value: the currently selected exam object (optional; used to seed
//   the input's display text, e.g. when this selector is remounted or
//   pre-filled).
// - onSelect(exam): called with the full exam object (incl. exam_id)
//   when an option is chosen.
export default function ExamSelector({ value, onSelect }) {
  const [groupedExams, setGroupedExams] = useState({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const [query, setQuery] = useState(value?.exam_name ?? '');
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const containerRef = useRef(null);
  const inputRef = useRef(null);

  const fetchActiveExams = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get('/exams', { params: { status: 'active' } });
      setGroupedExams(response.data.data || {});
    } catch (err) {
      setError(handleApiError(err) || 'Failed to load exams');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchActiveExams();
  }, [fetchActiveExams]);

  // Keep the input text in sync if `value` changes from outside (e.g.
  // the parent form resets selection) without fighting the admin's own
  // typing — only resync while the dropdown is closed.
  useEffect(() => {
    if (!isOpen) setQuery(value?.exam_name ?? '');
  }, [value, isOpen]);

  // Close on outside click.
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

  // Filters the already-grouped shape rather than flattening then
  // regrouping — a query matching the ORG name keeps every exam in
  // that org visible (so "FPSC" surfaces all FPSC exams without the
  // admin needing to expand/scroll to find them), while a query
  // matching only an exam name narrows that one org's list down.
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groupedExams;

    const result = {};
    Object.entries(groupedExams).forEach(([org, exams]) => {
      const orgMatches = org.toLowerCase().includes(q);
      const visibleExams = orgMatches
        ? exams
        : exams.filter((exam) => exam.exam_name.toLowerCase().includes(q));
      if (visibleExams.length > 0) result[org] = visibleExams;
    });
    return result;
  }, [groupedExams, query]);

  // Flattened purely for keyboard navigation (arrow keys move through
  // one continuous index regardless of which org group an option sits
  // in); the grouped structure above is still what's rendered.
  const flatOptions = useMemo(
    () =>
      Object.entries(filteredGroups).flatMap(([org, exams]) =>
        exams.map((exam) => ({ ...exam, organization: exam.organization ?? org }))
      ),
    [filteredGroups]
  );

  useEffect(() => {
    setHighlightedIndex(0);
  }, [query, isOpen]);

  const commitSelection = (exam) => {
    onSelect(exam);
    setQuery(exam.exam_name);
    setIsOpen(false);
    inputRef.current?.blur();
  };

  const handleKeyDown = (e) => {
    if (!isOpen && (e.key === 'ArrowDown' || e.key === 'Enter')) {
      setIsOpen(true);
      return;
    }
    if (!isOpen) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.min(i + 1, flatOptions.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlightedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const exam = flatOptions[highlightedIndex];
      if (exam) commitSelection(exam);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setQuery(value?.exam_name ?? '');
    }
  };

  const organizations = Object.keys(filteredGroups);
  let runningIndex = -1; // tracks each option's position in flatOptions while rendering groups

  return (
    <div className="relative" ref={containerRef}>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-gray-700">Exam</span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={isOpen}
          aria-autocomplete="list"
          value={query}
          placeholder="Search by exam name or organization…"
          onChange={(e) => {
            setQuery(e.target.value);
            setIsOpen(true);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>

      {isOpen && (
        <div className="absolute z-20 mt-1 w-full max-h-80 overflow-y-auto rounded-md border border-surface-border bg-white shadow-lg">
          {isLoading && (
            <div className="px-4 py-3 space-y-2">
              <div className="h-4 w-2/3 rounded bg-gray-100 animate-pulse" />
              <div className="h-4 w-1/2 rounded bg-gray-100 animate-pulse" />
            </div>
          )}

          {!isLoading && error && (
            <div className="px-4 py-3 flex items-center justify-between gap-3">
              <p className="text-sm text-danger">{error}</p>
              <button
                type="button"
                onClick={fetchActiveExams}
                className="text-xs font-medium text-primary-600 hover:underline shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {!isLoading && !error && organizations.length === 0 && (
            <p className="px-4 py-3 text-sm text-gray-400">No matching active exams.</p>
          )}

          {!isLoading &&
            !error &&
            organizations.map((org) => (
              <div key={org}>
                <div className="sticky top-0 bg-gray-50 px-4 py-1.5 text-xs font-semibold uppercase tracking-wide text-gray-400 border-b border-surface-border">
                  {org}
                </div>
                <ul>
                  {filteredGroups[org].map((exam) => {
                    runningIndex += 1;
                    const optionIndex = runningIndex;
                    const isHighlighted = optionIndex === highlightedIndex;
                    return (
                      <li key={exam.exam_id}>
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()} // keep input focus so blur doesn't beat the click
                          onMouseEnter={() => setHighlightedIndex(optionIndex)}
                          onClick={() => commitSelection(exam)}
                          className={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm ${
                            isHighlighted ? 'bg-primary-50' : 'hover:bg-gray-50'
                          }`}
                        >
                          <span className="truncate text-gray-900">{exam.exam_name}</span>
                          <span className="shrink-0 inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600">
                            {exam.organization}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
