// "MCQ Conversion Prompt" panel — the copy-paste-ready prompt Danish
// pastes into a fresh chat alongside the source PDF to convert MCQs
// into the JSON this app's import pipeline accepts. Backed by the
// PromptState singleton (see server/src/models/PromptState.js) via
// GET/PUT/POST /api/import/prompt-state* (see import.controller.js).
//
// Collapsed by default — the full prompt text is long and shouldn't
// dominate the Import page — but the header row (title + range/bank
// badges + expand toggle) is always visible so the current batch
// window is glanceable without opening it.

import { useEffect, useState, useCallback, useRef } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import { slugify } from '@/utils/taxonomySlug';
import api, { handleApiError } from '@/lib/axios';

// pendingSubtopics: optional array of { name, slug } (Prompt 2's
// findNewSubtopics) — an OPTIMISTIC preview of subtopics the parent
// (BulkImport.jsx) has just diffed out of a file that's mid-upload.
// Deliberately never merged into `state.subtopicBank` itself: that
// array is the server's confirmed truth (via GET /import/prompt-state)
// and a failed/rejected import must never leave stale "phantom" bank
// entries behind. Rendered as its own visually-distinct section
// instead.
//
// onBankChange: optional callback(bank: string[]) fired whenever this
// panel loads a fresh confirmed bank, so the sibling BulkImport can
// diff future uploads against it without either component reaching for
// Context or the react-query dependency already in package.json —
// props are sufficient for one piece of state shared between two
// siblings that are only ever mounted together on this one page.
// refreshSignal: optional value (e.g. a counter) that changes whenever
// the parent wants this panel to refetch its confirmed state right
// now — used after a real insert-mode import commits server-side
// (Prompt 4), so the new range/bank are visible on this page without
// waiting for a route change back to /admin/import (Prompt 1 found
// that was previously the only thing that re-triggered this panel's
// fetch). Deliberately just "a value that changes", not a boolean or
// timestamp, so the effect below can key off it directly.
export default function ConversionPromptPanel({ pendingSubtopics = [], onBankChange, refreshSignal } = {}) {
  const [state, setState] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [isExpanded, setIsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  // Settings row — bound to totalCap only (batchSize isn't exposed in
  // this panel's UI per spec, just totalCap's "Total questions in
  // source" field). Kept as a separate local string so the number
  // input doesn't fight the user mid-edit.
  const [totalCapInput, setTotalCapInput] = useState('');
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const [isResetting, setIsResetting] = useState(false);

  const fetchState = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await api.get('/import/prompt-state');
      const data = response.data?.data;
      setState(data);
      setTotalCapInput(String(data?.totalCap ?? ''));
      onBankChange?.(data?.subtopicBank ?? []);
    } catch (err) {
      const message = handleApiError(err);
      setLoadError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [onBankChange]);

  useEffect(() => {
    fetchState();
  }, [fetchState]);

  // Refetch on demand when the parent bumps refreshSignal (Prompt 4) —
  // kept as a SEPARATE effect from the mount-time fetch above rather
  // than merging the two, specifically so the initial mount only ever
  // fetches once. isInitialRefreshSignal guards against firing again
  // for the very first render (where refreshSignal is simply present
  // for the first time, not actually "changed").
  const isInitialRefreshSignal = useRef(true);
  useEffect(() => {
    if (isInitialRefreshSignal.current) {
      isInitialRefreshSignal.current = false;
      return;
    }
    fetchState();
  }, [refreshSignal, fetchState]);

  const handleSaveSettings = async () => {
    const totalCap = Number(totalCapInput);
    if (!Number.isInteger(totalCap) || totalCap <= 0) {
      toast.error('Total questions in source must be a positive whole number');
      return;
    }

    setIsSavingSettings(true);
    try {
      await api.put('/import/prompt-state/settings', { totalCap });
      toast.success('Prompt settings saved');
      await fetchState();
    } catch (err) {
      toast.error(handleApiError(err));
    } finally {
      setIsSavingSettings(false);
    }
  };

  const handleResetRange = async () => {
    const confirmed = window.confirm(
      'Reset the batch range back to 1? This rewinds the "next batch" window — use this if you want to redo a batch or start over on a new source PDF.'
    );
    if (!confirmed) return;

    setIsResetting(true);
    try {
      await api.post('/import/prompt-state/reset');
      toast.success('Batch range reset');
      await fetchState();
    } catch (err) {
      toast.error(handleApiError(err));
    } finally {
      setIsResetting(false);
    }
  };

  const handleCopy = async () => {
    if (!state?.promptText) return;
    try {
      await navigator.clipboard.writeText(state.promptText);
      setCopied(true);
      toast.success('Prompt copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy to clipboard — your browser may be blocking clipboard access');
    }
  };

  // Re-filter the parent's pending list against whatever bank this
  // panel actually has loaded right now — defensive only. In the
  // common case (fetchState only runs on mount, per Prompt 1) this
  // changes nothing; it just guards against a pending entry that
  // somehow already matches the confirmed bank being shown twice.
  const confirmedSlugs = new Set((state?.subtopicBank ?? []).map((name) => slugify(name)));
  const reconciledPending = (pendingSubtopics ?? []).filter((p) => !confirmedSlugs.has(p.slug));

  return (
    <div className="card p-0 overflow-hidden">
      <button
        type="button"
        onClick={() => setIsExpanded((prev) => !prev)}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-gray-50"
        aria-expanded={isExpanded}
      >
        <div className="flex items-center gap-3 min-w-0">
          {isExpanded ? (
            <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
          ) : (
            <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
          )}
          <span className="text-sm font-semibold text-gray-900 truncate">
            MCQ Conversion Prompt
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {isLoading ? (
            <span className="h-5 w-40 rounded-full bg-gray-200 animate-pulse" />
          ) : state ? (
            <>
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-primary-light text-primary-700">
                Next batch: {state.rangeStart}–{state.rangeEnd}
              </span>
              <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-gray-100 text-gray-600">
                {state.subtopicCount} subtopic{state.subtopicCount === 1 ? '' : 's'} in bank
              </span>
            </>
          ) : (
            <span className="inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium bg-rejected-light text-rejected-text">
              Failed to load
            </span>
          )}

          {/* Pending preview badge — shown regardless of loading state
              or expanded/collapsed, since the whole point is that it's
              visible the instant an import starts, without the admin
              needing to open the panel or wait on the network. */}
          {reconciledPending.length > 0 && (
            <span
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-amber-400 bg-amber-50 px-2.5 py-0.5 text-xs font-medium text-amber-700"
              title="Detected in the file currently importing — not yet confirmed by the server"
            >
              +{reconciledPending.length} pending
            </span>
          )}
        </div>
      </button>

      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-surface-border pt-4">
          {loadError && !state ? (
            <div className="text-sm text-danger">
              {loadError}
              <Button type="button" variant="outline" size="sm" className="ml-3" onClick={fetchState}>
                Retry
              </Button>
            </div>
          ) : isLoading || !state ? (
            <div className="space-y-2" aria-hidden="true">
              <div className="h-4 w-1/3 rounded bg-gray-200 animate-pulse" />
              <div className="h-40 w-full rounded bg-gray-200 animate-pulse" />
            </div>
          ) : (
            <>
              {/* Settings row */}
              <div className="flex flex-wrap items-end gap-3">
                <div className="min-w-[220px] space-y-1">
                  <label className="text-xs font-medium text-gray-600">
                    Total questions in source (cap)
                  </label>
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={totalCapInput}
                    onChange={(e) => setTotalCapInput(e.target.value)}
                    className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  />
                </div>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSaveSettings}
                  disabled={isSavingSettings}
                >
                  {isSavingSettings ? 'Saving…' : 'Save'}
                </Button>

                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="ml-auto text-gray-500"
                  onClick={handleResetRange}
                  disabled={isResetting}
                >
                  {isResetting ? 'Resetting…' : 'Reset to batch 1'}
                </Button>
              </div>

              {/* Pending subtopics preview — optimistic, from the file
                  currently mid-upload (Prompt 2's findNewSubtopics,
                  passed down from BulkImport.jsx). Deliberately kept
                  visually and structurally separate from the confirmed
                  subtopic_bank rendered in the prompt text below: this
                  list is NOT merged into state, so a failed or rejected
                  import can never leave a phantom entry behind here —
                  BulkImport clears pendingSubtopics the moment the
                  request resolves, success or error. */}
              {reconciledPending.length > 0 && (
                <div className="space-y-1.5 rounded-md border border-dashed border-amber-300 bg-amber-50 p-3">
                  <p className="text-xs font-medium text-amber-800">
                    Pending — detected in the file currently importing, not yet confirmed
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {reconciledPending.map((subtopic) => (
                      <span
                        key={subtopic.slug}
                        className="inline-flex items-center rounded-full border border-dashed border-amber-400 bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800"
                      >
                        {subtopic.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Copy + prompt text */}
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">Full Prompt</span>
                <Button type="button" variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? 'Copied!' : 'Copy Prompt'}
                </Button>
              </div>

              <pre className="max-h-96 overflow-y-auto whitespace-pre-wrap rounded-md border border-surface-border bg-gray-50 p-3 text-xs font-mono text-gray-700">
                {state.promptText}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
