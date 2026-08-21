import { Link } from 'react-router-dom';
import DifficultyBadge from '@/components/mcq/DifficultyBadge';

// ExposureTable.jsx — Prompt 99.
//
// No shared `Table` component exists anywhere in this codebase (checked
// against MCQList.jsx, BlueprintDetail.jsx's subject-breakdown table,
// etc.) — every table so far is a plain `<table className="data-table">`
// (the class defined once in index.css) or `<table className="w-full
// text-sm">` built inline. This follows that same real convention
// instead of inventing a shared component that doesn't exist yet.
//
// Props: `{ rows, variant }`
//   rows: [{ mcq: { id, question_id, question, subject, difficulty }, usageCount }]
//   variant: 'overused' | 'fresh' | 'unused' (least-used has no
//     dedicated variant string in the row-coloring sense — it renders
//     with the plain/neutral styling, so any variant other than
//     'overused'/'fresh' falls through to that default)

const VARIANT_STYLES = {
  overused: 'bg-red-50/60 border-l-4 border-danger',
  fresh: 'bg-green-50/60 border-l-4 border-success',
};

const EMPTY_MESSAGES = {
  overused: 'No overused questions yet',
  fresh: 'No unused questions — full pool is in rotation',
  unused: 'No unused questions — full pool is in rotation',
};

const truncate = (text, max = 90) =>
  text && text.length > max ? `${text.slice(0, max)}…` : text;

export default function ExposureTable({ rows, variant }) {
  const rowClass = VARIANT_STYLES[variant] || 'border-l-4 border-transparent';
  const emptyMessage = EMPTY_MESSAGES[variant] || 'No usage data yet';

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Question ID</th>
            <th>Question</th>
            <th>Subject</th>
            <th>Difficulty</th>
            <th>Usage Count</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {(!rows || rows.length === 0) && (
            <tr>
              <td colSpan={6} className="text-center py-10 text-gray-500">
                {emptyMessage}
              </td>
            </tr>
          )}

          {(rows || []).map(({ mcq, usageCount }) => (
            <tr key={mcq.id || mcq.question_id} className={rowClass}>
              <td className="font-mono text-xs">{mcq.question_id}</td>
              <td className="max-w-md">
                <span title={mcq.question} className="block truncate">
                  {truncate(mcq.question)}
                </span>
              </td>
              <td>{mcq.subject}</td>
              <td>
                <DifficultyBadge difficulty={mcq.difficulty} />
              </td>
              <td className="font-medium text-gray-700">{usageCount}</td>
              <td>
                {mcq.id ? (
                  <Link to={`/admin/mcqs/${mcq.id}/edit`} className="text-primary-600 hover:underline">
                    Edit MCQ
                  </Link>
                ) : (
                  <span className="text-gray-300">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
