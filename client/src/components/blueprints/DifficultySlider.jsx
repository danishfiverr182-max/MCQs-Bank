import { useCallback, useEffect, useRef, useState } from 'react';

// Single stacked bar with two draggable dividers, rather than three
// independent sliders — chosen per the spec's stated preference, and
// because it's what makes an invalid sum structurally hard to produce:
// only two divider positions are ever independently moved, and the
// three segment counts are derived from those two positions by
// subtraction, so they sum to totalQuestions exactly on every drag
// frame. There's no "third slider" whose count could drift out of sync.
const SEGMENTS = [
  { key: 'easy', label: 'Easy', barClass: 'bg-easy', textClass: 'text-easy-text' },
  { key: 'medium', label: 'Medium', barClass: 'bg-medium', textClass: 'text-medium-text' },
  { key: 'hard', label: 'Hard', barClass: 'bg-hard', textClass: 'text-hard-text' },
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Props:
// - distribution: { easy, medium, hard }
// - totalQuestions: number — the fixed total the three segments must sum to
// - onChange(updated) — called with a new { easy, medium, hard } object
export default function DifficultySlider({ distribution, totalQuestions, onChange }) {
  const containerRef = useRef(null);
  const [draggingHandle, setDraggingHandle] = useState(null); // 'first' | 'second' | null

  const total = totalQuestions > 0 ? totalQuestions : 0;
  const easy = distribution?.easy ?? 0;
  const medium = distribution?.medium ?? 0;
  const hard = distribution?.hard ?? 0;

  // Cumulative boundary counts along the bar. boundary1 sits between
  // easy/medium, boundary2 sits between medium/hard.
  const boundary1 = easy;
  const boundary2 = easy + medium;

  const pctOf = (count) => (total > 0 ? (count / total) * 100 : 0);

  const countFromClientX = useCallback(
    (clientX) => {
      const el = containerRef.current;
      if (!el || total <= 0) return 0;
      const rect = el.getBoundingClientRect();
      const fraction = clamp((clientX - rect.left) / rect.width, 0, 1);
      return Math.round(fraction * total);
    },
    [total]
  );

  // Moving the first (easy/medium) boundary never touches boundary2,
  // so `hard` (= total - boundary2) is untouched by construction.
  const applyFirstBoundary = useCallback(
    (rawBoundary1) => {
      const newBoundary1 = clamp(rawBoundary1, 0, boundary2);
      onChange({
        easy: newBoundary1,
        medium: boundary2 - newBoundary1,
        hard: total - boundary2,
      });
    },
    [boundary2, onChange, total]
  );

  // Moving the second (medium/hard) boundary never touches boundary1,
  // so `easy` is untouched by construction.
  const applySecondBoundary = useCallback(
    (rawBoundary2) => {
      const newBoundary2 = clamp(rawBoundary2, boundary1, total);
      onChange({
        easy: boundary1,
        medium: newBoundary2 - boundary1,
        hard: total - newBoundary2,
      });
    },
    [boundary1, onChange, total]
  );

  useEffect(() => {
    if (!draggingHandle) return undefined;

    const handleMove = (e) => {
      const clientX = 'touches' in e ? e.touches[0]?.clientX : e.clientX;
      if (clientX == null) return;
      const count = countFromClientX(clientX);
      if (draggingHandle === 'first') applyFirstBoundary(count);
      else applySecondBoundary(count);
    };
    const stopDrag = () => setDraggingHandle(null);

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', stopDrag);
    window.addEventListener('pointercancel', stopDrag);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', stopDrag);
      window.removeEventListener('pointercancel', stopDrag);
    };
  }, [applyFirstBoundary, applySecondBoundary, countFromClientX, draggingHandle]);

  const handleKeyDown = (handle) => (e) => {
    const step = e.shiftKey ? 5 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      if (handle === 'first') applyFirstBoundary(boundary1 - step);
      else applySecondBoundary(boundary2 - step);
    } else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (handle === 'first') applyFirstBoundary(boundary1 + step);
      else applySecondBoundary(boundary2 + step);
    }
  };

  // Manual precision entry, as an explicit fallback alongside the
  // slider — editing a number directly can momentarily take the total
  // out of sync; that's expected here, SumValidator (rendered by
  // BlueprintBuilder) is what surfaces that state, not this component.
  const handleManualChange = (key, rawValue) => {
    const parsed = Number(rawValue);
    const value = Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
    onChange({ easy, medium, hard, [key]: value });
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap justify-between gap-2 text-xs font-medium">
        {SEGMENTS.map((seg) => {
          const value = distribution?.[seg.key] ?? 0;
          const pct = total > 0 ? Math.round((value / total) * 100) : 0;
          return (
            <span key={seg.key} className={seg.textClass}>
              {seg.label}: {pct}% ({value} question{value === 1 ? '' : 's'})
            </span>
          );
        })}
      </div>

      <div
        ref={containerRef}
        className="relative h-8 w-full rounded-md bg-gray-100 overflow-visible select-none"
      >
        <div className="absolute inset-0 flex overflow-hidden rounded-md">
          <div className={`h-full ${SEGMENTS[0].barClass}`} style={{ width: `${pctOf(easy)}%` }} />
          <div className={`h-full ${SEGMENTS[1].barClass}`} style={{ width: `${pctOf(medium)}%` }} />
          <div className={`h-full ${SEGMENTS[2].barClass}`} style={{ width: `${pctOf(hard)}%` }} />
        </div>

        {/* Easy / Medium divider */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Easy/Medium boundary"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={boundary1}
          onPointerDown={(e) => {
            e.preventDefault();
            setDraggingHandle('first');
          }}
          onKeyDown={handleKeyDown('first')}
          className="absolute top-0 h-full w-3 -ml-1.5 cursor-col-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          style={{ left: `${pctOf(boundary1)}%` }}
        >
          <div className="mx-auto h-full w-1 rounded-full bg-white shadow" />
        </div>

        {/* Medium / Hard divider */}
        <div
          role="slider"
          tabIndex={0}
          aria-label="Medium/Hard boundary"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={boundary2}
          onPointerDown={(e) => {
            e.preventDefault();
            setDraggingHandle('second');
          }}
          onKeyDown={handleKeyDown('second')}
          className="absolute top-0 h-full w-3 -ml-1.5 cursor-col-resize focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
          style={{ left: `${pctOf(boundary2)}%` }}
        >
          <div className="mx-auto h-full w-1 rounded-full bg-white shadow" />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2">
        {SEGMENTS.map((seg) => (
          <label key={seg.key} className="space-y-1 text-xs text-gray-500">
            <span className="block">{seg.label} (exact)</span>
            <input
              type="number"
              min={0}
              value={distribution?.[seg.key] ?? 0}
              onChange={(e) => handleManualChange(seg.key, e.target.value)}
              className="w-full rounded-md border border-surface-border px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
            />
          </label>
        ))}
      </div>
    </div>
  );
}
