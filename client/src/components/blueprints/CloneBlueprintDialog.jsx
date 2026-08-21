import { useState } from 'react';
import { Button } from '@/components/ui/button';

// Small, shared clone dialog used by both BlueprintList.jsx (row
// action) and BlueprintDetail.jsx (page action) — Prompt 60 calls for
// the same dialog pattern in both places, so it lives here once rather
// than being duplicated.
//
// Only exposes an optional total_questions override, since that's the
// one field an admin is likely to want to nudge on clone without
// opening the full builder. Leaving it blank sends no override at all,
// which mirrors the pre-Prompt-60 behavior of a plain no-override
// clone. Subject/difficulty rebalancing after a total_questions change
// is left to the builder (Edit, right after cloning) rather than
// crammed into this dialog — the backend already rejects an override
// that breaks the sum invariant (400), surfaced here as a normal error.
//
// Props:
// - blueprint: the source blueprint being cloned
// - onCancel(): close without cloning
// - onConfirm(overrides): called with a plain overrides object
// - isSubmitting: disables the form while the clone request is in flight
// - error: optional error string from a failed attempt, shown inline
export default function CloneBlueprintDialog({
  blueprint,
  onCancel,
  onConfirm,
  isSubmitting,
  error,
}) {
  const [overrideTotal, setOverrideTotal] = useState('');

  const handleConfirm = () => {
    const overrides = {};
    if (overrideTotal.trim() !== '') {
      const parsed = Number(overrideTotal);
      if (Number.isFinite(parsed) && parsed >= 0) {
        overrides.total_questions = parsed;
      }
    }
    onConfirm(overrides);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
    >
      <div className="card max-w-sm w-full space-y-4">
        <div className="space-y-1">
          <h2 className="text-base font-semibold text-gray-900">
            Clone {blueprint.blueprint_id}
          </h2>
          <p className="text-sm text-gray-500">
            Creates a new inactive blueprint version with the same subjects and difficulty mix.
            You can adjust everything afterward in the editor.
          </p>
        </div>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">
            Override total questions <span className="font-normal text-gray-400">(optional)</span>
          </span>
          <input
            type="number"
            min={0}
            placeholder={String(blueprint.total_questions)}
            value={overrideTotal}
            onChange={(e) => setOverrideTotal(e.target.value)}
            disabled={isSubmitting}
            className="w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <span className="block text-xs text-gray-400">
            Leave blank to clone with the same total ({blueprint.total_questions}). Note: if
            subjects or difficulty no longer sum to the new total, saving in the editor will be
            required before the clone can be activated.
          </span>
        </label>

        {error && <p className="text-sm text-danger">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={isSubmitting}
          >
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={handleConfirm} disabled={isSubmitting}>
            {isSubmitting ? 'Cloning…' : 'Clone'}
          </Button>
        </div>
      </div>
    </div>
  );
}
