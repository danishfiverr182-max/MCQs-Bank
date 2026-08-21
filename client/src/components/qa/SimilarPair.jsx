import MCQCard from '@/components/mcq/MCQCard';

// Side-by-side similarity comparison — the "Two MCQCard side by side"
// pattern the spec names explicitly. Reuses MCQCard.jsx (Phase 3) as-is
// rather than building a second, near-duplicate presentational
// component, in compact mode so two cards comfortably fit side by side
// even on a laptop-width screen.
//
// Purely presentational in this prompt — no action buttons live here.
// SimilarityReview.jsx (Prompt 90) composes this component alongside
// its own Keep Both / Delete #2 / Merge controls, keeping the
// comparison-DISPLAY concern separate from the action-TAKING concern.
//
// Props:
// - mcqA, mcqB: full MCQ-shaped objects (question, options,
//   correct_answer, subject, difficulty, question_id).
// - score: 0–100 similarity score for this specific pair.

// Same color-banding pattern DuplicateReview.jsx (Phase 4) already
// established: 90%+ is a red "this is very likely the same question"
// signal, 85–90% is an amber "worth a look" signal.
const scoreBadgeClasses = (score) =>
  score >= 90 ? 'bg-danger-light text-danger-dark' : 'bg-warning-light text-warning-dark';

export default function SimilarPair({ mcqA, mcqB, score }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-center">
        <span
          className={`inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold ${scoreBadgeClasses(
            score
          )}`}
        >
          {typeof score === 'number' ? `${score}% similar` : 'Similarity unknown'}
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <p className="text-label font-semibold uppercase tracking-wide text-gray-400 px-1">
            Question A
          </p>
          {mcqA ? (
            <MCQCard mcq={mcqA} compact={false} />
          ) : (
            <div className="card text-sm text-gray-400 italic">Not available</div>
          )}
        </div>

        <div className="space-y-1.5">
          <p className="text-label font-semibold uppercase tracking-wide text-gray-400 px-1">
            Question B
          </p>
          {mcqB ? (
            <MCQCard mcq={mcqB} compact={false} />
          ) : (
            <div className="card text-sm text-gray-400 italic">Not available</div>
          )}
        </div>
      </div>
    </div>
  );
}
