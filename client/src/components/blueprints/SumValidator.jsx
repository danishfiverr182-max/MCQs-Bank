// Purely presentational — no internal state, no API calls. Takes the
// already-computed sum and the target total as props and renders a
// live green/red indicator. Reused twice in BlueprintBuilder.jsx
// (Prompt 59): once for the subjects sum, once for the difficulty sum.
export default function SumValidator({ label, currentSum, expectedTotal }) {
  const isValid = currentSum === expectedTotal;
  const delta = currentSum - expectedTotal;
  const deltaLabel = delta > 0 ? `${delta} over` : `${Math.abs(delta)} short`;

  return (
    <div
      role="status"
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-medium ${
        isValid ? 'bg-success-light text-success-dark' : 'bg-danger-light text-danger-dark'
      }`}
    >
      <span aria-hidden="true">{isValid ? '✓' : '✗'}</span>
      <span>
        {label} sum: {currentSum}/{expectedTotal}
        {!isValid && ` (${deltaLabel})`}
      </span>
    </div>
  );
}
