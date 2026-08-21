import { Link } from 'react-router-dom';
import DifficultyBadge from '@/components/mcq/DifficultyBadge';
import StatusBadge from '@/components/mcq/StatusBadge';

// Shared column widths — used by both the fixed header row and every
// virtualized MCQRow, so the two always stay pixel-aligned regardless of
// which rows are currently mounted.
export const MCQ_ROW_GRID_COLS =
  'grid-cols-[40px_120px_minmax(0,1fr)_140px_110px_110px_140px]';

const truncate = (text, max = 80) =>
  text && text.length > max ? `${text.slice(0, max)}…` : text;

// Extracted out of MCQList.jsx so it can be handed to VirtualList's
// `renderRow` as a clean, self-contained row renderer. Row click navigates
// to the MCQ's detail page (same destination as the existing "View" link) —
// virtualized rows use an estimated fixed height, so the old inline
// click-to-expand accordion (which rendered a full MCQCard preview at a
// variable height) doesn't fit this layout and was replaced by that
// navigation instead. Every other row-level action (View, Edit, select
// checkbox) behaves identically to before.
export default function MCQRow({ mcq, isSelected, onToggleSelect, navigate }) {
  return (
    <div
      className={`grid ${MCQ_ROW_GRID_COLS} items-center h-full px-4 border-b border-gray-100 cursor-pointer hover:bg-gray-50`}
      onClick={() => navigate(`/admin/mcqs/${mcq._id}`)}
    >
      <div onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={isSelected} onChange={() => onToggleSelect(mcq._id)} />
      </div>
      <div className="font-mono text-xs text-gray-700 truncate pr-2">{mcq.question_id}</div>
      <div className="text-sm text-gray-700 truncate pr-2">{truncate(mcq.question)}</div>
      <div className="text-sm text-gray-700 truncate pr-2">{mcq.subject}</div>
      <div>
        <DifficultyBadge difficulty={mcq.difficulty} />
      </div>
      <div>
        <StatusBadge status={mcq.status} />
      </div>
      <div onClick={(e) => e.stopPropagation()} className="flex items-center gap-3 text-sm">
        <Link to={`/admin/mcqs/${mcq._id}`} className="text-primary-600 hover:underline">
          View
        </Link>
        <Link to={`/admin/mcqs/${mcq._id}/edit`} className="text-primary-600 hover:underline">
          Edit
        </Link>
      </div>
    </div>
  );
}
