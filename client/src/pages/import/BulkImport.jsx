import { useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import DropZone from '@/components/import/DropZone';
import ImportProgressBar from '@/components/import/ImportProgressBar';
import PasteJsonModal from '@/components/import/PasteJsonModal';
import ConversionPromptPanel from '@/components/import/ConversionPromptPanel';
import { findNewSubtopics } from '@/utils/detectNewSubtopics';
import api, { handleApiError } from '@/lib/axios';

const SCHEMA_EXAMPLE = `{
  "questions": [
    {
      "question": "What is the capital of Pakistan?",
      "options": {
        "A": "Karachi",
        "B": "Islamabad",
        "C": "Lahore",
        "D": "Peshawar"
      },
      "correct_answer": "B",
      "subject": "Pakistan Affairs",
      "topic": "Geography",
      "subtopic": "Capitals",
      "difficulty": "easy",
      "exam_tags": ["MOD", "FPSC"],
      "cognitive_level": "recall",
      "quality_score": 80
    }
  ]
}`;

// Mirrors the backend's parseJSON() (see server/src/services/import.service.js)
// so row numbers line up exactly with what the report refers to. Built
// client-side purely so DuplicateReview (Prompt 49) can show the actual
// "Incoming" question text for a flagged row — the report itself only
// carries row numbers and errors, not question data.
const buildIncomingRows = (rawText) => {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {};
  }

  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.questions)
      ? parsed.questions
      : [];

  const map = {};
  rows.forEach((question, index) => {
    map[index + 1] = question;
  });
  return map;
};

// Wraps raw JSON text in a File object so pasted text can be pushed
// through the exact same multipart upload — and therefore the exact
// same backend pipeline (parseJSON → validateEachMCQ → detectDuplicates
// → insert) — as a genuine file selection. Nothing downstream (upload
// middleware, controller, import.service.js) can tell the difference,
// which is the point: there is no second import code path to maintain.
const toJSONFile = (rawText, filename = 'pasted-import.json') =>
  new File([rawText], filename, { type: 'application/json' });

export default function BulkImport() {
  const navigate = useNavigate();

  const [selectedFile, setSelectedFile] = useState(null);
  const [validateOnly, setValidateOnly] = useState(false);
  const [isSchemaOpen, setIsSchemaOpen] = useState(false);
  const [isPasteOpen, setIsPasteOpen] = useState(false);

  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  // 'idle' | 'uploading' | 'processing' | 'done' | 'error'
  const [status, setStatus] = useState('idle');

  // ─── Optimistic "pending subtopics" preview ────────────────────
  // confirmedBank mirrors ConversionPromptPanel's last-loaded
  // subtopic_bank (see handleBankChange below — the panel reports it
  // up via a plain callback prop, since BulkImport and the panel are
  // siblings in the same tree and this is the only piece of panel
  // state anything outside the panel needs). Starts `null` (not yet
  // known) rather than `[]` (known to be empty) so runImport can tell
  // "haven't loaded the real bank yet" apart from "loaded, empty" —
  // diffing against an empty array before the real bank has loaded
  // would flag every subtopic in the file as "new", which isn't a
  // preview, it's just wrong.
  const [confirmedBank, setConfirmedBank] = useState(null);
  const handleBankChange = useCallback((bank) => setConfirmedBank(bank ?? []), []);

  // Candidate {name, slug} entries (Prompt 2's findNewSubtopics) for
  // whichever import is currently in flight — cleared the instant a
  // response (success OR error) comes back, since its only job is to
  // fill the gap between "upload started" and "server has an answer".
  const [pendingSubtopics, setPendingSubtopics] = useState([]);

  // Bumped once per successful insert-mode import, right after the
  // response arrives (see runImport below). Passed to
  // ConversionPromptPanel as a prop it can watch to know "refetch
  // your confirmed state now" — a plain counter rather than a
  // boolean/timestamp so two imports in a row (each incrementing it)
  // are each guaranteed to register as a change even if the panel's
  // effect hasn't re-run yet. Safe to fetch immediately at this point:
  // runImportPipeline's mergeSubtopicsIntoBank/advanceRange calls are
  // both awaited server-side BEFORE the HTTP response is sent (see
  // import.service.js), so by the time `response` resolves here, the
  // range/bank this refetch reads back is already the real, confirmed
  // post-import state — not a race.
  const [refreshSignal, setRefreshSignal] = useState(0);

  // ─── Shared import pipeline ─────────────────────────────────────
  // The single place that talks to POST /import/bulk. Both the file
  // DropZone (via handleUpload below) and PasteJsonModal's Import
  // button funnel through this exact function — same request, same
  // progress/status handling, same navigation, same error handling.
  const runImport = async (file, mode) => {
    if (!file || isUploading) return;

    setIsUploading(true);
    setStatus('uploading');
    setProgress(0);

    try {
      // Read the file client-side too — purely to build the row→question
      // map DuplicateReview needs (see buildIncomingRows above). This is
      // separate from the FormData upload below.
      const rawText = await file.text();
      const incomingRows = buildIncomingRows(rawText);

      // Optimistic preview (Prompt 2's findNewSubtopics) — diffed
      // against the last subtopic_bank ConversionPromptPanel reported
      // via handleBankChange. Set BEFORE the API call below so the
      // panel can show a "pending" badge the instant upload starts,
      // without waiting on the network. If the bank hasn't loaded yet
      // (confirmedBank still null), skip rather than diffing against
      // nothing and over-reporting every subtopic in the file as new.
      //
      // Only for mode === 'insert': validate_only never touches
      // PromptState server-side (see import.service.js's
      // runImportPipeline — mergeSubtopicsIntoBank/advanceRange only
      // run `if (mode === 'insert')`), so showing a "pending" badge
      // during a dry run would imply a bank change that will never
      // actually happen. Skip the preview entirely for that mode
      // rather than trying to separately label it.
      setPendingSubtopics(mode === 'insert' && confirmedBank ? findNewSubtopics(rawText, confirmedBank) : []);

      const formData = new FormData();
      formData.append('file', file);
      formData.append('mode', mode);

      const response = await api.post('/import/bulk', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        // Overrides the shared 10s default (see lib/axios.js) just for
        // this request. Import runs schema validation + duplicate-
        // detection (which scans the growing MCQ collection) inside a
        // single DB transaction before responding at all — on a slow
        // dev machine or a large-ish file, that can legitimately take
        // longer than 10s, which was previously throwing a false
        // "Network error" even though the import was actually still
        // succeeding on the server. This was the real trigger for the
        // repeated-retry duplicate problem: each "failed" attempt was
        // often not a failure at all, just a client that gave up too
        // early on a real backend that kept working (see the
        // transaction rewrite in import.service.js for the other half
        // of this fix — a genuinely failed run now leaves nothing
        // behind either way).
        timeout: 120000,
        onUploadProgress: (event) => {
          if (!event.total) return;
          const percent = Math.round((event.loaded / event.total) * 100);
          setProgress(percent);
          // Bytes are fully sent but the response (schema validation +
          // dup-check, which takes longer than the upload itself) hasn't
          // come back yet — switch to the indeterminate state rather than
          // sitting at a frozen 100%.
          if (percent >= 100) setStatus('processing');
        },
      });

      const report = response.data?.data;
      setStatus('done');
      // Response is back — the "pending" preview's only job (bridging
      // the gap while the network call was in flight) is done.
      setPendingSubtopics([]);
      // For a real insert, the server has ALREADY merged newSubtopics
      // into subtopic_bank and advanced range_start/range_end (both
      // awaited inside runImportPipeline before it responds — see
      // import.service.js). Bumping refreshSignal tells the still-
      // mounted ConversionPromptPanel to refetch right now, so the
      // confirmed range and bank are visible on THIS page immediately,
      // without requiring the admin to navigate back to /admin/import
      // to see them. validate_only never mutates PromptState, so
      // there's nothing to refetch for that mode.
      if (mode === 'insert') {
        setRefreshSignal((prev) => prev + 1);
      }

      if (report?.duplicates) {
        // eslint-disable-next-line no-console
        console.log('Duplicates in report (reviewed on the next page):', report.duplicates);
      }

      // Give the "done" state a beat on screen before navigating away,
      // so the progress bar's resolution is actually visible.
      setTimeout(() => {
        navigate('/admin/import/report', { state: { report, incomingRows } });
      }, 500);
    } catch (err) {
      setStatus('error');
      setIsUploading(false);
      // The import failed — nothing was merged into the bank server-
      // side, so the optimistic preview must not linger and imply
      // otherwise.
      setPendingSubtopics([]);
      // err.errors — when present — is the actual per-row reason each
      // failed (e.g. "Row 42: <mongoose validation message>"), set by
      // import.service.js's runImportPipeline. The summary message
      // alone ("Insert failed for N row(s)...") doesn't say WHY, which
      // makes this kind of failure hard to diagnose from the UI alone.
      const rowErrors = Array.isArray(err?.errors) ? err.errors : [];
      if (rowErrors.length > 0) {
        // eslint-disable-next-line no-console
        console.error('Import row-level errors:', rowErrors);
        const preview = rowErrors.slice(0, 5).join('\n');
        const more = rowErrors.length > 5 ? `\n…and ${rowErrors.length - 5} more (see browser console)` : '';
        toast.error(`${handleApiError(err)}\n${preview}${more}`, {
          duration: 12000,
          style: { whiteSpace: 'pre-line', textAlign: 'left', maxWidth: '480px' },
        });
      } else {
        toast.error(handleApiError(err));
      }
    }
  };

  // File-import entry point — unchanged behaviour, now just a thin
  // wrapper around the shared runImport().
  const handleUpload = () => runImport(selectedFile, validateOnly ? 'validate_only' : 'insert');

  // Paste-import entry point — builds a File from the pasted text and
  // hands it to the exact same runImport() the DropZone uses.
  const handlePasteImport = (rawText) =>
    runImport(toJSONFile(rawText), validateOnly ? 'validate_only' : 'insert');

  // Dry-run validation for the paste modal. Hits the dedicated
  // POST /import/validate endpoint — a thin wrapper (see
  // import.controller.js) around the identical runImportPipeline() used
  // by /import/bulk, just forced to mode: 'validate_only'. Same schema
  // validation, same duplicate detection, nothing is inserted.
  const handlePasteValidate = async (rawText) => {
    const formData = new FormData();
    formData.append('file', toJSONFile(rawText));

    const response = await api.post('/import/validate', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000,
    });
    return response.data?.data;
  };

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h1 className="section-title">Bulk Import MCQs</h1>
        <p className="text-sm text-gray-500">
          Add questions to the MCQ bank from a JSON file or by pasting JSON directly.
          Each row is validated and checked for duplicates before anything is saved.
        </p>
      </div>

      {/* Collapsed by default — the range/bank badges stay glanceable in
          the header row without pushing the upload form down.
          pendingSubtopics/onBankChange (Prompt 3) let this sibling
          component show an optimistic "pending" preview the instant an
          import starts. refreshSignal (Prompt 4) tells it to refetch
          its confirmed state right after a real insert commits, so the
          new range/bank are visible here without navigating away. */}
      <ConversionPromptPanel
        pendingSubtopics={pendingSubtopics}
        onBankChange={handleBankChange}
        refreshSignal={refreshSignal}
      />

      {/* Collapsible schema hint — collapsed by default */}
      <div className="card p-0 overflow-hidden">
        <button
          type="button"
          onClick={() => setIsSchemaOpen((prev) => !prev)}
          className="w-full flex items-center justify-between px-4 py-3 text-sm font-medium text-gray-700 hover:bg-gray-50"
          aria-expanded={isSchemaOpen}
        >
          Expected JSON Schema
          <span className="text-gray-400">{isSchemaOpen ? '−' : '+'}</span>
        </button>
        {isSchemaOpen && (
          <pre className="px-4 pb-4 text-xs font-mono text-gray-600 overflow-x-auto whitespace-pre">
            {SCHEMA_EXAMPLE}
          </pre>
        )}
      </div>

      {/* Two equally-visible ways in: pick a file, or paste JSON directly */}
      <div className={`card space-y-3 ${isUploading ? 'opacity-50 pointer-events-none' : ''}`}>
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-gray-700">Import JSON File</span>
          <Button type="button" variant="outline" size="sm" onClick={() => setIsPasteOpen(true)}>
            Paste JSON instead
          </Button>
        </div>
        <DropZone onFileSelected={setSelectedFile} accept=".json" maxSizeMB={10} />
      </div>

      {/* Progress bar — shown once an upload has started, for either
          entry point */}
      {status !== 'idle' && (
        <div className="card">
          <ImportProgressBar progress={progress} status={status} />
        </div>
      )}

      {/* Validate Only toggle + Upload */}
      <div className="card flex items-center justify-between">
        <label
          className={`flex items-center gap-3 select-none ${
            isUploading ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'
          }`}
        >
          <span
            role="switch"
            aria-checked={validateOnly}
            onClick={() => !isUploading && setValidateOnly((prev) => !prev)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
              validateOnly ? 'bg-primary' : 'bg-gray-300'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform ${
                validateOnly ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </span>
          <span className="text-sm text-gray-700">
            Validate Only
            <span className="block text-xs text-gray-400">
              Check for errors and duplicates without saving anything. Applies to both
              file and pasted imports.
            </span>
          </span>
        </label>

        <Button type="button" onClick={handleUpload} disabled={!selectedFile || isUploading}>
          {isUploading ? 'Uploading…' : 'Upload'}
        </Button>
      </div>

      <PasteJsonModal
        open={isPasteOpen}
        onClose={() => setIsPasteOpen(false)}
        onValidate={handlePasteValidate}
        onImport={handlePasteImport}
        isImporting={isUploading}
      />
    </div>
  );
}
