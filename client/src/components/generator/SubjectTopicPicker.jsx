import { useCallback, useState } from 'react';
import apiClient, { handleApiError } from '@/lib/axios';

// Level-2: one expanded subject's topic multi-select. Purely
// presentational — all fetch/cache state lives in the parent
// (topicsState) so re-collapsing and re-expanding the same subject
// never triggers a second fetch.
function SubjectTopicList({ subjectName, entry, selected, onToggleTopic }) {
  if (!entry || entry.status === 'loading') {
    return (
      <div className="space-y-1.5 pl-6 pt-2" aria-live="polite" aria-busy="true">
        <div className="h-4 w-2/3 rounded bg-gray-100 animate-pulse" />
        <div className="h-4 w-1/2 rounded bg-gray-100 animate-pulse" />
      </div>
    );
  }

  if (entry.status === 'error') {
    return (
      <p className="pl-6 pt-2 text-xs text-danger-dark">
        {entry.error || 'Failed to load topics for this subject.'}
      </p>
    );
  }

  if (!entry.topics.length) {
    return (
      <p className="pl-6 pt-2 text-xs text-gray-400">
        No topics recorded for this subject.
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 pl-6 pt-2">
      {entry.topics.map((topic) => (
        <label
          key={topic}
          className="flex items-center gap-1.5 text-sm text-gray-600 select-none"
        >
          <input
            type="checkbox"
            checked={selected.includes(topic)}
            onChange={() => onToggleTopic(subjectName, topic)}
          />
          {topic}
        </label>
      ))}
    </div>
  );
}

// Props:
// - blueprintSubjects: [{ name, count, ... }] — the active blueprint's
//   subject list (e.g. from GET /api/blueprints/exam/:examId).
// - selectedSubjects: string[] | undefined — subject names currently
//   in the override. Omit (undefined) to get the default "no
//   restriction" state, which is every blueprint subject checked —
//   once the admin interacts, control passes fully to the parent via
//   onSubjectsChange, including an explicit empty array if every
//   subject gets unchecked.
// - selectedTopics: { [subjectName]: string[] } — topics explicitly
//   picked per subject. A subject with no key here (the only shape
//   this component ever produces — see handleToggleTopic) means "no
//   topic restriction for this subject."
// - onSubjectsChange(nextSelectedSubjects)
// - onTopicsChange(nextSelectedTopics)
export default function SubjectTopicPicker({
  blueprintSubjects = [],
  selectedSubjects,
  selectedTopics = {},
  onSubjectsChange,
  onTopicsChange,
}) {
  // undefined prop => nothing has been touched yet => every blueprint
  // subject is checked, matching "no override" = full subject list.
  // An explicit array (even []) is always respected as-is from here
  // on — this is what makes "all checked by default" true on first
  // render without the parent (OverridePanel) having to pre-seed
  // state itself.
  const effectiveSelectedSubjects =
    selectedSubjects ?? blueprintSubjects.map((s) => s.name);

  // Per-subject expand/collapse — purely local UI state, the parent
  // never needs to know which subjects' topic pickers are open.
  const [expanded, setExpanded] = useState(() => new Set());

  // Per-subject fetch cache: { [name]: { status: 'loading'|'loaded'|'error', topics, error? } }.
  // Lives here (not in the parent) since it's a derived cache of a GET
  // that never needs to outlive this component.
  const [topicsState, setTopicsState] = useState({});

  const fetchTopicsFor = useCallback(async (subjectName) => {
    // Functional update so this "already loading/loaded?" check always
    // sees the latest state, even under rapid repeated expand clicks —
    // guarantees exactly one fetch per subject regardless of render
    // timing.
    let shouldFetch = false;
    setTopicsState((prev) => {
      if (prev[subjectName]) return prev;
      shouldFetch = true;
      return { ...prev, [subjectName]: { status: 'loading', topics: [] } };
    });
    if (!shouldFetch) return;

    try {
      const response = await apiClient.get('/mcqs/topics', {
        params: { subject: subjectName },
      });
      const topics = response.data?.data?.topics || [];
      setTopicsState((prev) => ({
        ...prev,
        [subjectName]: { status: 'loaded', topics },
      }));
    } catch (err) {
      setTopicsState((prev) => ({
        ...prev,
        [subjectName]: {
          status: 'error',
          topics: [],
          error: handleApiError(err),
        },
      }));
    }
  }, []);

  const toggleSubject = (name) => {
    const isSelected = effectiveSelectedSubjects.includes(name);
    const next = isSelected
      ? effectiveSelectedSubjects.filter((n) => n !== name)
      : [...effectiveSelectedSubjects, name];
    onSubjectsChange?.(next);

    // Unchecking a subject hides/collapses its topic picker
    // immediately — it's no longer part of the override, so there's
    // nothing meaningful left to expand.
    if (isSelected && expanded.has(name)) {
      setExpanded((prev) => {
        const nextExpanded = new Set(prev);
        nextExpanded.delete(name);
        return nextExpanded;
      });
    }
  };

  const toggleExpand = (name) => {
    setExpanded((prev) => {
      const nextExpanded = new Set(prev);
      if (nextExpanded.has(name)) {
        nextExpanded.delete(name);
      } else {
        nextExpanded.add(name);
        fetchTopicsFor(name);
      }
      return nextExpanded;
    });
  };

  const handleToggleTopic = (subjectName, topic) => {
    const current = selectedTopics[subjectName] || [];
    const isSelected = current.includes(topic);
    const nextTopics = isSelected
      ? current.filter((t) => t !== topic)
      : [...current, topic];

    const next = { ...selectedTopics };
    if (nextTopics.length === 0) {
      // Empty selection means "no restriction" for this subject — omit
      // the key entirely rather than keeping `{ [subjectName]: [] }`,
      // which would otherwise be indistinguishable from "restrict to
      // zero topics" (match nothing) once this becomes an actual
      // override payload. An empty-array override should never be
      // sent for any subject.
      delete next[subjectName];
    } else {
      next[subjectName] = nextTopics;
    }
    onTopicsChange?.(next);
  };

  return (
    <div className="space-y-2">
      {blueprintSubjects.map((subject) => {
        const isChecked = effectiveSelectedSubjects.includes(subject.name);
        const isExpanded = expanded.has(subject.name);
        const topicCount = selectedTopics[subject.name]?.length ?? 0;

        return (
          <div
            key={subject.name}
            className="rounded-md border border-surface-border px-3 py-2"
          >
            <div className="flex items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm font-medium text-gray-700 select-none">
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => toggleSubject(subject.name)}
                />
                {subject.name}
                <span className="font-normal text-gray-400">
                  ({subject.count} question{subject.count === 1 ? '' : 's'})
                </span>
              </label>

              {isChecked && (
                <button
                  type="button"
                  onClick={() => toggleExpand(subject.name)}
                  aria-expanded={isExpanded}
                  className="flex shrink-0 items-center gap-1 text-xs font-medium text-gray-500 hover:text-gray-700"
                >
                  {isExpanded ? 'Hide topics ▲' : 'Filter by topic ▾'}
                  {topicCount > 0 && (
                    <span className="rounded-full bg-primary-light px-1.5 py-0.5 text-[10px] font-semibold text-primary-700">
                      {topicCount}
                    </span>
                  )}
                </button>
              )}
            </div>

            {isChecked && isExpanded && (
              <SubjectTopicList
                subjectName={subject.name}
                entry={topicsState[subject.name]}
                selected={selectedTopics[subject.name] || []}
                onToggleTopic={handleToggleTopic}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
