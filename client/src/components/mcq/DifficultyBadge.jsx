// Small colored pill reflecting an MCQ's difficulty.
// Uses the easy/medium/hard color tokens defined in tailwind.config.js.

const STYLES = {
  easy: 'bg-easy-light text-easy-text',
  medium: 'bg-medium-light text-medium-text',
  hard: 'bg-hard-light text-hard-text',
};

const LABELS = {
  easy: 'Easy',
  medium: 'Medium',
  hard: 'Hard',
};

export default function DifficultyBadge({ difficulty }) {
  if (!difficulty || !STYLES[difficulty]) {
    return (
      <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-500">
        —
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[difficulty]}`}
    >
      {LABELS[difficulty]}
    </span>
  );
}
