// Progress indicator for the Bulk Import upload flow (Prompt 48).
//
// Three phases map to two very different sources of truth:
//   1. 'uploading'  — real byte progress from Axios' onUploadProgress.
//   2. 'processing' — bytes are already on the server, but the response
//      (schema validation + dup-check across possibly 1000+ rows) hasn't
//      come back yet. There's no real percentage to report here, so this
//      renders as an indeterminate sliding bar instead of freezing at 100%
//      or lying about progress.
//   3. 'done' / 'error' — terminal states, solid green/red bar + icon.

import { CheckCircle2, XCircle, Loader2 } from 'lucide-react';

const STATUS_LABEL = {
  uploading: 'Uploading…',
  processing: 'Processing on server…',
  done: 'Import complete',
  error: 'Import failed',
};

const STATUS_BAR_CLASS = {
  uploading: 'bg-primary',
  processing: 'bg-primary',
  done: 'bg-success',
  error: 'bg-danger',
};

export default function ImportProgressBar({ progress = 0, status = 'uploading' }) {
  const label = STATUS_LABEL[status] || STATUS_LABEL.uploading;
  const barClass = STATUS_BAR_CLASS[status] || STATUS_BAR_CLASS.uploading;
  const clampedProgress = Math.min(100, Math.max(0, progress));
  const isIndeterminate = status === 'processing';
  const isTerminal = status === 'done' || status === 'error';

  return (
    <div className="space-y-2" role="status" aria-live="polite">
      <div className="flex items-center justify-between text-sm">
        <span className="flex items-center gap-1.5 font-medium text-gray-700">
          {status === 'done' && <CheckCircle2 className="h-4 w-4 text-success" aria-hidden="true" />}
          {status === 'error' && <XCircle className="h-4 w-4 text-danger" aria-hidden="true" />}
          {(status === 'uploading' || status === 'processing') && (
            <Loader2 className="h-4 w-4 text-primary animate-spin" aria-hidden="true" />
          )}
          {label}
        </span>
        {status === 'uploading' && (
          <span className="text-gray-400 tabular-nums">{clampedProgress}%</span>
        )}
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-100">
        {isIndeterminate ? (
          <div className="h-full w-1/3 rounded-full bg-primary animate-indeterminate-bar" />
        ) : (
          <div
            className={`h-full rounded-full transition-all duration-200 ${barClass}`}
            style={{ width: `${isTerminal ? 100 : clampedProgress}%` }}
          />
        )}
      </div>
    </div>
  );
}
