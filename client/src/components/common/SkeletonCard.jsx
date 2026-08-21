// Content-shaped skeleton for card-grid pages (Analytics stat cards, MCQCard
// grids). Mirrors StatCard.jsx's own layout (icon tile + value line + label
// line) and the grid conventions used wherever that grid is rendered
// (`grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4`), so swapping between
// skeleton and real content causes no layout jump.
export default function SkeletonCard({ count = 4 }) {
  if (!count) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4" aria-hidden="true">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="card flex items-start gap-4">
          <div className="shrink-0 h-11 w-11 rounded-lg bg-gray-200 animate-pulse" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-5 w-2/3 rounded bg-gray-200 animate-pulse" />
            <div className="h-3.5 w-1/2 rounded bg-gray-200 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}
