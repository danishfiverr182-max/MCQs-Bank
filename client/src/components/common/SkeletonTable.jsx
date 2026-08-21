// Content-shaped skeleton for `.data-table`-style pages (MCQ list, Test
// history, Activity log). Purely presentational — no data fetching, no
// other props. Column widths vary (narrow first column like an ID, wider
// last column like a description/actions) so it reads as a real table
// silhouette rather than a uniform stack of gray blocks.
//
// Width pattern is deliberately varied per (row, column) combo rather than
// fixed per column, so rows don't look like a perfectly repeated stencil.
const WIDTH_STEPS = ['w-1/4', 'w-1/3', 'w-2/5', 'w-1/2', 'w-3/5', 'w-2/3', 'w-3/4', 'w-5/6'];

function barWidthClass(rowIndex, colIndex, columns) {
  if (colIndex === 0) return 'w-10'; // ID-like column: short, fixed
  if (colIndex === columns - 1) return 'w-16'; // actions-like column: short, fixed
  const step = (rowIndex * 3 + colIndex * 5) % WIDTH_STEPS.length;
  return WIDTH_STEPS[step];
}

export default function SkeletonTable({ rows = 8, columns = 5 }) {
  if (!rows || !columns) return null;

  return (
    <table className="data-table" aria-hidden="true">
      <tbody>
        {Array.from({ length: rows }).map((_, rowIndex) => (
          <tr key={rowIndex}>
            {Array.from({ length: columns }).map((__, colIndex) => (
              <td key={colIndex}>
                <div
                  className={`h-4 ${barWidthClass(rowIndex, colIndex, columns)} rounded bg-gray-200 animate-pulse`}
                />
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
