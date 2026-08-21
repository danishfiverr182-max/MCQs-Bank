import { useState } from 'react';
import apiClient from '@/lib/axios';

// Row for one topic+count entry within a subject
function TopicRequirementRow({ subjectName, requirement, onUpdate, onDelete, subjectTotal, allRequirementsForSubject }) {
  const otherCounts = allRequirementsForSubject
    .filter((r) => r.topic !== requirement.topic)
    .reduce((sum, r) => sum + r.count, 0);
  const maxForThisTopic = subjectTotal - otherCounts;

  return (
    <div className="flex items-end gap-2 py-2">
      <label className="flex-1 space-y-0.5">
        <span className="block text-xs font-medium text-gray-600">Topic</span>
        <input
          type="text"
          value={requirement.topic}
          onChange={(e) => onUpdate({ ...requirement, topic: e.target.value })}
          placeholder="e.g., Synonyms"
          className="w-full rounded-md border border-surface-border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="w-20 space-y-0.5">
        <span className="block text-xs font-medium text-gray-600">Count</span>
        <input
          type="number"
          min={1}
          max={maxForThisTopic}
          value={requirement.count}
          onChange={(e) => onUpdate({ ...requirement, count: Number(e.target.value) || 0 })}
          className="w-full rounded-md border border-surface-border px-3 py-1.5 text-sm text-center focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <button
        type="button"
        onClick={() => onDelete(requirement.topic)}
        className="rounded-md border border-danger-light bg-danger-light/10 px-2.5 py-1.5 text-xs font-medium text-danger-dark hover:bg-danger-light/20 transition-colors"
      >
        Remove
      </button>
    </div>
  );
}

// Level 2: expanded subject's topic requirements input
function SubjectRequirementsSection({ subject, requirements = [], onUpdate, subjectAvailableTopics = [] }) {
  // Single source of truth for the text field — BUGFIX: previously this
  // was split across `addingTopic` (what you typed) and `selectedTopic`
  // (what you clicked from the suggestion pills), and the Add button
  // only ever enabled when `selectedTopic` was set. That meant typing a
  // topic name directly and pressing Add did nothing — the button
  // stayed disabled unless you clicked a suggestion pill first, even
  // though the exact same text was sitting in the box. Typing and
  // clicking a suggestion now both just set this one value.
  const [topicInput, setTopicInput] = useState('');
  const [topicsLoading, setTopicsLoading] = useState(false);
  const [topicsList, setTopicsList] = useState(subjectAvailableTopics);

  const trimmedInput = topicInput.trim();
  const isDuplicate = requirements.some(
    (r) => r.topic.toLowerCase() === trimmedInput.toLowerCase()
  );

  const handleAddTopic = () => {
    if (!trimmedInput || isDuplicate) return;
    onUpdate([...requirements, { topic: trimmedInput, count: 1 }]);
    setTopicInput('');
  };

  const handleUpdateRequirement = (updatedReq) => {
    const next = requirements.map((r) => (r.topic === updatedReq.topic ? updatedReq : r));
    onUpdate(next);
  };

  const handleDeleteRequirement = (topic) => {
    onUpdate(requirements.filter((r) => r.topic !== topic));
  };

  const totalCount = requirements.reduce((sum, r) => sum + r.count, 0);

  return (
    <div className="space-y-3 pl-6 pt-2 border-t border-surface-border">
      {/* Current requirements list */}
      {requirements.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-gray-600">
            {totalCount} / {subject.count} MCQs allocated to specific topics
          </p>
          {requirements.map((req) => (
            <TopicRequirementRow
              key={req.topic}
              subjectName={subject.name}
              requirement={req}
              onUpdate={handleUpdateRequirement}
              onDelete={handleDeleteRequirement}
              subjectTotal={subject.count}
              allRequirementsForSubject={requirements}
            />
          ))}
        </div>
      )}

      {/* Add topic row */}
      {totalCount < subject.count && (
        <div className="flex items-end gap-2 py-2 border-t border-gray-100 pt-3">
          <label className="flex-1 space-y-0.5">
            <span className="block text-xs font-medium text-gray-600">Add topic</span>
            <input
              type="text"
              placeholder="Type a topic name, or pick a suggestion below"
              value={topicInput}
              onChange={(e) => setTopicInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleAddTopic();
                }
              }}
              onFocus={async () => {
                if (topicsList.length === 0 && !topicsLoading) {
                  setTopicsLoading(true);
                  try {
                    const response = await apiClient.get('/mcqs/topics', {
                      params: { subject: subject.name },
                    });
                    setTopicsList(response.data?.data?.topics || []);
                  } catch (err) {
                    // Silent fail — user can still type manually
                  } finally {
                    setTopicsLoading(false);
                  }
                }
              }}
              className="w-full rounded-md border border-surface-border px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
          <button
            type="button"
            onClick={handleAddTopic}
            disabled={!trimmedInput || isDuplicate}
            title={isDuplicate ? 'This topic is already added' : undefined}
            className="rounded-md border border-primary bg-primary-light px-2.5 py-1.5 text-xs font-medium text-primary-dark hover:bg-primary-light/70 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Add
          </button>
        </div>
      )}

      {/* Topic suggestions dropdown — clicking one fills the box above;
          it doesn't add immediately, so you can still glance at the
          count before hitting Add (or Enter). */}
      {topicsList.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {topicsList
            .filter((t) => !requirements.some((r) => r.topic === t))
            .filter((t) => (trimmedInput ? t.toLowerCase().includes(trimmedInput.toLowerCase()) : true))
            .slice(0, 8)
            .map((topic) => (
              <button
                key={topic}
                type="button"
                onClick={() => setTopicInput(topic)}
                className="rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
              >
                {topic}
              </button>
            ))}
        </div>
      )}

      {totalCount >= subject.count && (
        <p className="text-xs text-gray-400">All {subject.count} MCQ slots allocated to topics.</p>
      )}
    </div>
  );
}

// Props:
// - blueprintSubjects: [{ name, count }, ...]
// - selectedTopicRequirements: { [subjectName]: [{ topic, count }, ...] }
// - onChange(nextRequirements): fired when anything changes
export default function TopicRequirementsPicker({
  blueprintSubjects = [],
  selectedTopicRequirements = {},
  onChange,
}) {
  const [expanded, setExpanded] = useState(new Set());

  const toggleExpand = (subjectName) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(subjectName)) {
        next.delete(subjectName);
      } else {
        next.add(subjectName);
      }
      return next;
    });
  };

  const handleUpdateRequirements = (subjectName, nextRequirements) => {
    const next = { ...selectedTopicRequirements };
    if (nextRequirements.length === 0) {
      delete next[subjectName];
    } else {
      next[subjectName] = nextRequirements;
    }
    onChange(next);
  };

  const totalSpecified = Object.values(selectedTopicRequirements).reduce(
    (sum, reqs) => sum + reqs.reduce((subSum, r) => subSum + r.count, 0),
    0
  );

  return (
    <div className="space-y-2">
      {totalSpecified > 0 && (
        <p className="text-xs text-gray-600 font-medium">
          {totalSpecified} MCQ{totalSpecified === 1 ? '' : 's'} guaranteed from specific topics
        </p>
      )}

      {blueprintSubjects.map((subject) => {
        const isExpanded = expanded.has(subject.name);
        const requirements = selectedTopicRequirements[subject.name] || [];
        const allocatedCount = requirements.reduce((sum, r) => sum + r.count, 0);
        const showBadge = allocatedCount > 0;

        return (
          <div key={subject.name} className="rounded-md border border-surface-border px-3 py-2">
            <button
              type="button"
              onClick={() => toggleExpand(subject.name)}
              aria-expanded={isExpanded}
              className="w-full flex items-center justify-between gap-2 text-sm font-medium text-gray-700 text-left hover:text-gray-900 transition-colors"
            >
              <span className="flex items-center gap-2">
                {subject.name}
                <span className="text-xs font-normal text-gray-400">({subject.count} total)</span>
                {showBadge && (
                  <span className="rounded-full bg-primary-light px-2 py-0.5 text-[10px] font-semibold text-primary-700">
                    {allocatedCount} guaranteed
                  </span>
                )}
              </span>
              <span className="text-gray-400">{isExpanded ? '▲' : '▾'}</span>
            </button>

            {isExpanded && (
              <SubjectRequirementsSection
                subject={subject}
                requirements={requirements}
                onUpdate={(nextReqs) => handleUpdateRequirements(subject.name, nextReqs)}
              />
            )}
          </div>
        );
      })}

      {blueprintSubjects.length === 0 && (
        <p className="text-xs text-gray-400 italic">No subjects in this blueprint.</p>
      )}
    </div>
  );
}
