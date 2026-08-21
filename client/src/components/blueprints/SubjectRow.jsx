import { useEffect, useId, useRef, useState } from 'react';

// Small delay so rapid typing in the count field doesn't fire a parent
// re-render/re-validation (which recomputes SumValidator's sums and
// re-renders every sibling row) on every single keystroke.
const DEBOUNCE_MS = 350;

// Props:
// - subject: { name, count } — initial values, read once on mount. This
//   component owns its own draft state between keystrokes; the parent
//   list should key each row on something stable (index is fine since
//   rows aren't reordered elsewhere) so a genuinely new subject list
//   (e.g. loading a different blueprint) remounts rather than merging
//   into stale local state.
// - onChange(updated) — debounced, called with { name, count }.
// - onRemove() — remove this row.
// - disableRemove — true when this is the last remaining row; a
//   blueprint needs at least one subject.
// - existingSubjectNames — previously-used subject names across the
//   exam, offered as datalist suggestions. Purely a typo-guard (e.g.
//   "English" vs "english "); free-text entry of a genuinely new
//   subject is never blocked.
export default function SubjectRow({
  subject,
  onChange,
  onRemove,
  disableRemove = false,
  existingSubjectNames = [],
}) {
  const [name, setName] = useState(subject?.name ?? '');
  const [count, setCount] = useState(subject?.count ?? 0);
  const debounceRef = useRef(null);
  const datalistId = useId();

  useEffect(
    () => () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    },
    []
  );

  const scheduleChange = (nextName, nextCount) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      onChange({ name: nextName, count: nextCount });
    }, DEBOUNCE_MS);
  };

  const handleNameChange = (e) => {
    const value = e.target.value;
    setName(value);
    scheduleChange(value, count);
  };

  const handleCountChange = (e) => {
    const raw = Number(e.target.value);
    const value = Number.isFinite(raw) ? Math.max(0, raw) : 0;
    setCount(value);
    scheduleChange(name, value);
  };

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 min-w-0">
        <input
          type="text"
          list={datalistId}
          value={name}
          onChange={handleNameChange}
          placeholder="Subject name"
          aria-label="Subject name"
          className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <datalist id={datalistId}>
          {existingSubjectNames.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      </div>

      <input
        type="number"
        min={0}
        value={count}
        onChange={handleCountChange}
        aria-label="Question count for this subject"
        className="w-24 shrink-0 rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />

      <button
        type="button"
        onClick={onRemove}
        disabled={disableRemove}
        title={disableRemove ? 'A blueprint needs at least one subject' : 'Remove subject'}
        aria-label="Remove subject"
        className="shrink-0 h-9 w-9 rounded-md border border-surface-border text-gray-400 hover:text-danger hover:border-danger transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:text-gray-400 disabled:hover:border-surface-border"
      >
        ×
      </button>
    </div>
  );
}
