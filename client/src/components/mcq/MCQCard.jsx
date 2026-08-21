import DifficultyBadge from '@/components/mcq/DifficultyBadge';
import StatusBadge from '@/components/mcq/StatusBadge';

const OPTION_KEYS = ['A', 'B', 'C', 'D'];

/**
 * Renders a single MCQ — question, four options (with the correct one
 * highlighted), and its metadata badges.
 *
 * Deliberately tolerant of partial/incomplete data so it can double as
 * a live preview while a form is still being filled in: missing option
 * text, an unset correct_answer, or empty subject/topic strings should
 * render sensibly rather than throw.
 *
 * Props:
 *   mcq      — MCQ-shaped object (full document or partial form state)
 *   compact  — tighter layout for use inside table rows (default false)
 *   actions  — optional node rendered in a dedicated footer row (e.g.
 *               Edit/Approve/Reject/Delete buttons on the detail page);
 *               omitted entirely in compact mode and when not provided
 */
export default function MCQCard({ mcq, compact = false, actions = null }) {
  if (!mcq) return null;

  const options = mcq.options || {};
  const tags = Array.isArray(mcq.exam_tags) ? mcq.exam_tags : [];

  return (
    <div className={compact ? 'py-2' : 'card space-y-4'}>
      {/* Header: question id + badges */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          {mcq.question_id && (
            <span className="font-mono text-xs text-gray-400">{mcq.question_id}</span>
          )}
          <DifficultyBadge difficulty={mcq.difficulty} />
          <StatusBadge status={mcq.status} />
        </div>
        {typeof mcq.quality_score === 'number' && (
          <span className="text-xs text-gray-400 shrink-0">
            Quality: {mcq.quality_score}
          </span>
        )}
      </div>

      {/* Question */}
      <p className="text-sm font-medium text-gray-900 whitespace-pre-wrap">
        {mcq.question || <span className="text-gray-400 italic">No question text yet…</span>}
      </p>

      {/* Options */}
      <div className="grid gap-2 sm:grid-cols-2">
        {OPTION_KEYS.map((key) => {
          const isCorrect = mcq.correct_answer === key;
          const text = options[key];
          return (
            <div
              key={key}
              className={`flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${
                isCorrect
                  ? 'border-easy bg-easy-light text-easy-text'
                  : 'border-surface-border text-gray-700'
              }`}
            >
              <span className="font-semibold shrink-0">{key}.</span>
              <span className="break-words">
                {text || <span className="text-gray-400 italic">—</span>}
              </span>
              {isCorrect && (
                <span className="ml-auto shrink-0 text-xs font-semibold">✓</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Metadata footer */}
      {!compact && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-500 pt-1 border-t border-surface-border">
          {mcq.subject && <span>Subject: {mcq.subject}</span>}
          {mcq.topic && <span>Topic: {mcq.topic}</span>}
          {mcq.subtopic && <span>Subtopic: {mcq.subtopic}</span>}
          {mcq.cognitive_level && <span>Level: {mcq.cognitive_level}</span>}
          {tags.length > 0 && <span>Tags: {tags.join(', ')}</span>}
        </div>
      )}

      {/* Actions footer */}
      {!compact && actions && (
        <div className="flex items-center gap-2 pt-2 border-t border-surface-border">
          {actions}
        </div>
      )}
    </div>
  );
}
