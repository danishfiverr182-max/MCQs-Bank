// csvBuilder.js — Prompt 96. Tiny, dependency-free CSV writer.
// No external CSV library needed at this scale (a single test's ~100
// rows) — RFC 4180-style quoting is only a handful of rules, and pulling
// in a full library (csv-stringify, papaparse, etc.) for this would be
// overkill for the one export endpoint that needs it.

// ─── escapeField ────────────────────────────────────────────────────
// A field needs wrapping in double quotes if it contains a comma, a
// double quote, or any line break (\n or \r) — any of those would
// otherwise corrupt the column/row structure when the file is opened
// in Excel/Sheets. Internal double quotes are escaped by doubling them
// ("" ), which is the RFC 4180 convention every spreadsheet app expects.
const escapeField = (value) => {
  const str = value === null || value === undefined ? '' : String(value);

  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }

  return str;
};

// ─── buildCSV ────────────────────────────────────────────────────────
// rows: array of plain objects, e.g. [{ question_id: 'Q001', question: '...' }, ...]
// columns: [{ key: 'question_id', header: 'Question ID' }, ...] — controls
// both column order and the display header, independent of each row
// object's own key order.
// Returns a single CSV string using \r\n line endings throughout
// (including after the header row), matching the RFC 4180 convention
// most spreadsheet software expects rather than a bare \n.
export const buildCSV = (rows, columns) => {
  const headerLine = columns.map((col) => escapeField(col.header)).join(',');

  const dataLines = rows.map((row) =>
    columns.map((col) => escapeField(row[col.key])).join(',')
  );

  return [headerLine, ...dataLines].join('\r\n') + '\r\n';
};

export default buildCSV;
