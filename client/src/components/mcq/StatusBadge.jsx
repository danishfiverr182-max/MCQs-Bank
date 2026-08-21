// Small colored pill reflecting an MCQ's review status.
// Uses the approved/pending/rejected color tokens defined in tailwind.config.js.

const STYLES = {
  approved: 'bg-approved-light text-approved-text',
  pending: 'bg-pending-light text-pending-text',
  rejected: 'bg-rejected-light text-rejected-text',
};

const LABELS = {
  approved: 'Approved',
  pending: 'Pending',
  rejected: 'Rejected',
};

export default function StatusBadge({ status }) {
  if (!status || !STYLES[status]) {
    return (
      <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-500">
        —
      </span>
    );
  }

  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STYLES[status]}`}
    >
      {LABELS[status]}
    </span>
  );
}
