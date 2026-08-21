// Paste-JSON entry point for Bulk Import.
//
// This is deliberately just an alternate *source* of the raw JSON text —
// once the user hits Validate or Import, the text is wrapped in a File
// (see toJSONFile in BulkImport.jsx) and handed to the exact same
// validate/import functions the file DropZone uses. There is no separate
// parsing, schema-checking, or duplicate-detection logic in here; that
// would defeat the point. See BulkImport.jsx's runImport/handlePasteValidate.
//
// NOTE: there used to be an auto-validate effect here that fired
// POST /import/validate ~700ms after the user stopped typing/pasting —
// on top of whatever the Import button itself triggers. Since both
// requests run the full server-side duplicate check (the slow part —
// see server/src/utils/duplicateDetector.js), that meant "Processing
// on server" effectively ran twice for a single paste-and-import: once
// silently in the background, then again for real on Import. Removed —
// validation now only runs when the user explicitly clicks "Validate
// JSON", or implicitly once via Import itself.
//
// Props:
//   open        — whether the modal is visible
//   onClose()   — close without importing (also used by Cancel / Esc / backdrop)
//   onValidate(text) — returns a Promise<report>, or throws (see handleApiError shape)
//   onImport(text)   — kicks off the real import; caller closes the modal itself
//                       once the request is in flight so the shared
//                       ImportProgressBar (already on the page behind the
//                       modal) can take over.
//   isImporting — true while an import triggered from anywhere on the page
//                 (file or paste) is in flight, so both entry points stay
//                 in sync and disable correctly.

import { useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

const PLACEHOLDER = `Paste JSON matching the import format, e.g.:

{
  "questions": [
    {
      "question": "What is the capital of Pakistan?",
      "options": { "A": "Karachi", "B": "Islamabad", "C": "Lahore", "D": "Peshawar" },
      "correct_answer": "B",
      "subject": "Pakistan Affairs",
      "topic": "Geography",
      "difficulty": "easy"
    }
  ]
}

A bare array of question objects is also accepted.`;

const MAX_PASTE_BYTES = 10 * 1024 * 1024; // mirrors the 10MB file-upload limit

export default function PasteJsonModal({ open, onClose, onValidate, onImport, isImporting }) {
  const [text, setText] = useState('');
  const [isValidating, setIsValidating] = useState(false);
  // null = not yet validated this text; otherwise { ok, summary, rowErrors }
  const [result, setResult] = useState(null);

  // Manual-only now (see file header note above) — triggered by the
  // "Validate JSON" button.
  const runValidation = async (rawText) => {
    const trimmed = rawText.trim();

    if (!trimmed) {
      setResult(null);
      return;
    }

    const size = new TextEncoder().encode(trimmed).length;
    if (size > MAX_PASTE_BYTES) {
      setResult({ ok: false, summary: 'Pasted JSON is too large. Maximum size is 10MB.', rowErrors: [] });
      return;
    }
    // Quick client-side syntax check first — instant feedback without a
    // round trip for the most common mistake (typo/trailing comma/etc).
    try {
      JSON.parse(trimmed);
    } catch (err) {
      setResult({ ok: false, summary: `Invalid JSON syntax: ${err.message}`, rowErrors: [] });
      return;
    }

    setIsValidating(true);
    try {
      const report = await onValidate(trimmed);
      const failedCount = report?.failed?.length ?? 0;
      const exactCount = report?.duplicates?.exact?.length ?? 0;
      const nearCount = report?.duplicates?.near?.length ?? 0;

      setResult({
        ok: failedCount === 0,
        summary:
          failedCount === 0
            ? `Looks good — ${report.total} question(s) passed validation` +
              (exactCount + nearCount > 0
                ? ` (${exactCount + nearCount} potential duplicate(s) will be flagged on import).`
                : '.')
            : `${failedCount} of ${report.total} row(s) failed validation.`,
        rowErrors: (report?.failed ?? []).map(
          (f) => `Row ${f.row}: ${f.errors.map((e) => `${e.field}: ${e.message}`).join('; ')}`
        ),
      });
    } catch (err) {
      const rowErrors = Array.isArray(err?.errors) ? err.errors : [];
      setResult({
        ok: false,
        summary: err?.message || 'Validation failed.',
        rowErrors,
      });
    } finally {
      setIsValidating(false);
    }
  };

  if (!open) return null;

  const byteSize = new TextEncoder().encode(text).length;
  const isTooLarge = byteSize > MAX_PASTE_BYTES;

  const resetAndClose = () => {
    setText('');
    setResult(null);
    setIsValidating(false);
    onClose?.();
  };

  const handleTextChange = (e) => {
    setText(e.target.value);
    // Any edit invalidates the previous Validate result so it doesn't
    // keep showing stale row errors/duplicate counts for text that's
    // since changed. Import itself no longer depends on this being set.
    if (result) setResult(null);
  };

  // Optional manual pre-check — runs schema validation + duplicate
  // detection once, on demand, and shows the result inline. Entirely
  // optional now: Import (below) no longer requires this to have run
  // first, so clicking it is purely "I want to see the report before
  // committing," not a required gate.
  const handleValidate = () => {
    if (!text.trim()) {
      setResult({ ok: false, summary: 'Paste some JSON before validating.', rowErrors: [] });
      return;
    }
    runValidation(text);
  };

  // Import runs straight off the pasted text — the server's own
  // validate → duplicate-detect → insert pipeline (POST /import/bulk)
  // does the identical checking Validate does, exactly once, as part
  // of this single request. No pre-validation round trip required.
  const handleImport = () => {
    if (!text.trim() || isTooLarge || isImporting || isValidating) return;
    onImport(text.trim());
    // Parent switches the page into its normal uploading/processing UI
    // and will navigate away on success — nothing left for the modal to
    // own past this point.
    resetAndClose();
  };

  const canValidate = text.trim().length > 0 && !isTooLarge && !isValidating && !isImporting;
  const canImport = text.trim().length > 0 && !isTooLarge && !isImporting && !isValidating;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="paste-json-title"
      onClick={resetAndClose}
    >
      <div
        className="w-full max-w-2xl rounded-lg bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-surface-border px-5 py-4">
          <h2 id="paste-json-title" className="text-base font-semibold text-gray-900">
            Paste JSON
          </h2>
          <button
            type="button"
            onClick={resetAndClose}
            aria-label="Close"
            className="rounded-full p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-gray-500">
            Paste raw JSON below. It must match the same structure as the imported file
            (a <code>questions</code> array, or a bare array of question objects). Click
            Import to validate, check for duplicates, and save in one step — or click
            "Validate JSON" first if you'd like to see the report before importing.
          </p>

          <textarea
            value={text}
            onChange={handleTextChange}
            placeholder={PLACEHOLDER}
            spellCheck={false}
            disabled={isImporting}
            className="h-64 w-full resize-y rounded-md border border-surface-border bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
          />

          <div className="flex items-center justify-between text-xs">
            <span className={isTooLarge ? 'text-danger font-medium' : 'text-gray-400'}>
              {(byteSize / 1024).toFixed(1)} KB{isTooLarge ? ' — exceeds the 10MB limit' : ''}
            </span>
            {isValidating && (
              <span className="flex items-center gap-1 text-gray-400">
                <Loader2 className="h-3 w-3 animate-spin" /> Validating…
              </span>
            )}
          </div>

          {result && (
            <div
              className={`rounded-md border px-3 py-2 text-sm ${
                result.ok
                  ? 'border-easy bg-easy-light/40 text-easy-dark'
                  : 'border-danger bg-red-50 text-danger'
              }`}
            >
              <p className="font-medium">{result.summary}</p>
              {result.rowErrors.length > 0 && (
                <ul className="mt-1.5 max-h-32 space-y-0.5 overflow-y-auto text-xs">
                  {result.rowErrors.slice(0, 20).map((line, i) => (
                    <li key={i} className="font-mono">
                      {line}
                    </li>
                  ))}
                  {result.rowErrors.length > 20 && (
                    <li className="italic">…and {result.rowErrors.length - 20} more</li>
                  )}
                </ul>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-surface-border px-5 py-4">
          <Button type="button" variant="outline" onClick={resetAndClose} disabled={isImporting}>
            Cancel
          </Button>
          <Button type="button" variant="outline" onClick={handleValidate} disabled={!canValidate}>
            {isValidating ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Validating…
              </span>
            ) : (
              'Validate JSON'
            )}
          </Button>
          <Button type="button" onClick={handleImport} disabled={!canImport}>
            Import
          </Button>
        </div>
      </div>
    </div>
  );
}
