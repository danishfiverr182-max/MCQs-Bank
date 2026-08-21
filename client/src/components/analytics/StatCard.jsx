import { ArrowUp, ArrowDown, Minus } from 'lucide-react';

// StatCard.jsx — Prompt 97. Reuses the existing `.card` utility (white
// surface, shadow-card, surface-border, p-6 — see index.css) rather than
// inventing new card styling, same "don't invent a new visual language"
// instruction the prompt calls for.
//
// Props:
//   icon:  a lucide-react icon component (not an element) — rendered
//          inside a small colored tile on the left.
//   value: the big number/stat, e.g. 1,248 or "86%".
//   label: the smaller caption beneath the value.
//   trend: optional { direction: 'up' | 'down' | 'flat', percent: number }.
//          Omitted entirely -> no trend row is rendered at all, rather
//          than a broken/empty arrow element — not every stat (e.g.
//          "Total Exams") has a meaningful trend to show.

const TREND_STYLES = {
  up: { Icon: ArrowUp, className: 'text-success' },
  down: { Icon: ArrowDown, className: 'text-danger' },
  flat: { Icon: Minus, className: 'text-gray-400' },
};

export default function StatCard({ icon: Icon, value, label, trend }) {
  const trendConfig = trend ? TREND_STYLES[trend.direction] : null;

  return (
    <div className="card flex items-start gap-4">
      <div className="shrink-0 h-11 w-11 rounded-lg bg-primary-light text-primary flex items-center justify-center">
        {Icon && <Icon size={22} strokeWidth={2} />}
      </div>

      <div className="min-w-0">
        <p className="text-display text-gray-900 leading-tight truncate">{value}</p>
        <p className="text-sm text-gray-500 mt-0.5">{label}</p>

        {trendConfig && (
          <div className={`flex items-center gap-1 mt-1.5 text-xs font-medium ${trendConfig.className}`}>
            <trendConfig.Icon size={13} strokeWidth={2.5} />
            <span>{trend.percent}%</span>
          </div>
        )}
      </div>
    </div>
  );
}
