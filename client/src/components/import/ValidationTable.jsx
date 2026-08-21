// Renders row-level schema validation failures from an import report
// (Prompt 48). Pure presentational component — takes `failedRows` as
// produced by the backend's validateEachMCQ() (see import.service.js):
//   [{ row: 3, errors: [{ field: 'options.B', message: '...' }, ...] }]

import { Download } from 'lucide-react';

// ─── CSV export ─────────────────────────────────────────────────────
// Client-side only — no backend round trip. One CSV row per error
// (a row with 3 errors produces 3 CSV lines, all sharing the same
// `row` value), matching what's shown on screen exactly.
const escapeCSVField = (value) => {
  const str = String(value ?? '');
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
};

const buildCSV = (failedRows) => {
  const lines = ['row,field,message'];
  failedRows.forEach(({ row, errors }) => {
    errors.forEach(({ field, message }) => {
      lines.push([row, field, message].map(escapeCSVField).join(','));
    });
  });
  return lines.join('\n');
};

const downloadCSV = (failedRows) => {
  const csv = buildCSV(failedRows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `import-validation-errors-${Date.now()}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
};

export default function ValidationTable({ failedRows = [] }) {
  const hasErrors = failedRows.length > 0;

  return (
    <div className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="section-title">Validation Errors</h2>
        {hasErrors && (
          <button
            type="button"
            onClick={() => downloadCSV(failedRows)}
            className="inline-flex items-center gap-1.5 rounded-md border border-surface-border px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
          >
            <Download className="h-3.5 w-3.5" aria-hidden="true" />
            Download Error CSV
          </button>
        )}
      </div>

      {!hasErrors ? (
        <p className="text-sm text-gray-500">
          No validation errors — all rows passed schema checks.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table">
            <thead>
              <tr>
                <th className="w-20">Row #</th>
                <th className="w-48">Field</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {failedRows.map(({ row, errors }) =>
                errors.map((err, idx) => (
                  <tr key={`${row}-${idx}`}>
                    {idx === 0 && (
                      <td
                        rowSpan={errors.length}
                        className="align-top font-medium text-gray-900"
                      >
                        {row}
                      </td>
                    )}
                    <td className="font-mono text-xs text-gray-600">{err.field || '—'}</td>
                    <td>{err.message}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
