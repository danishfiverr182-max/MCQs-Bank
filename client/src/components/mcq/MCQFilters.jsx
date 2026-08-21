import { useState, useEffect } from 'react';
import { useDebouncedValue } from '@/utils/debounce';

const DIFFICULTY_OPTIONS = ['easy', 'medium', 'hard'];
// 'latest' is a pseudo-status (see mcq.service.js's findWithFilters) —
// selecting it shows every MCQ tagged with the most recently uploaded/
// imported batch's source_batch_id, regardless of pending/approved/
// rejected status, so a freshly imported batch is easy to review in
// one place. Kept in this same list (rather than a second dropdown) so
// it's a one-click filter alongside the real statuses.
const STATUS_OPTIONS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'latest', label: 'Latest import' },
];
const COGNITIVE_OPTIONS = ['recall', 'understanding', 'application', 'analysis'];

/**
 * Filter bar for the MCQ list/table.
 *
 * Props:
 *   filters  — { search, subject, difficulty, status, cognitive_level }
 *   onChange — (nextFilters) => void, called with the full next filter object
 *
 * The free-text fields (search, subject) are debounced via
 * useDebouncedValue (300ms) so we don't re-fetch on every keystroke; select
 * fields fire onChange immediately.
 */
export default function MCQFilters({ filters, onChange }) {
  const [local, setLocal] = useState(filters);

  // Keep local text state in sync if filters are reset from outside
  // (e.g. the "Clear filters" button in MCQList).
  useEffect(() => {
    setLocal(filters);
  }, [filters]);

  // The inputs below stay bound to the FAST `local.search`/`local.subject`
  // state, so every keystroke shows up instantly with zero input lag.
  // Only these debounced copies drive the actual onChange/re-fetch, 300ms
  // after typing pauses.
  const debouncedSearch = useDebouncedValue(local.search, 300);
  const debouncedSubject = useDebouncedValue(local.subject, 300);

  useEffect(() => {
    if (debouncedSearch !== filters.search || debouncedSubject !== filters.subject) {
      onChange({ ...filters, search: debouncedSearch, subject: debouncedSubject });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedSearch, debouncedSubject]);

  const handleTextChange = (key) => (e) => {
    setLocal((prev) => ({ ...prev, [key]: e.target.value }));
  };

  const handleSelectChange = (key) => (e) => {
    const next = { ...filters, [key]: e.target.value };
    setLocal(next);
    onChange(next);
  };

  return (
    <div className="card flex flex-wrap items-end gap-3">
      <div className="flex-1 min-w-[200px] space-y-1">
        <label className="text-xs font-medium text-gray-600">Search</label>
        <input
          type="text"
          value={local.search}
          onChange={handleTextChange('search')}
          placeholder="Search question text…"
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="min-w-[160px] space-y-1">
        <label className="text-xs font-medium text-gray-600">Subject</label>
        <input
          type="text"
          value={local.subject}
          onChange={handleTextChange('subject')}
          placeholder="e.g. Pakistan Affairs"
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      <div className="min-w-[140px] space-y-1">
        <label className="text-xs font-medium text-gray-600">Difficulty</label>
        <select
          value={local.difficulty}
          onChange={handleSelectChange('difficulty')}
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All</option>
          {DIFFICULTY_OPTIONS.map((d) => (
            <option key={d} value={d}>
              {d[0].toUpperCase() + d.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-[140px] space-y-1">
        <label className="text-xs font-medium text-gray-600">Status</label>
        <select
          value={local.status}
          onChange={handleSelectChange('status')}
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All</option>
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <div className="min-w-[160px] space-y-1">
        <label className="text-xs font-medium text-gray-600">Cognitive level</label>
        <select
          value={local.cognitive_level}
          onChange={handleSelectChange('cognitive_level')}
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        >
          <option value="">All</option>
          {COGNITIVE_OPTIONS.map((c) => (
            <option key={c} value={c}>
              {c[0].toUpperCase() + c.slice(1)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
