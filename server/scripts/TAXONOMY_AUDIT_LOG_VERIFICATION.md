# Taxonomy ActivityLog cross-check (Prompt 15)

Verification pass for Prompts 14-15: every structural taxonomy
mutation — rename, the three reparenting movers, merge, delete — now
writes an `ActivityLog` row (inside the same transaction as the
mutation itself) carrying `old_location`, `new_location`,
`mcqs_updated`, and `success`. Prompt 13 separately made every one of
those same mutations persist a live-derived `counts.total` onto the
TaxonomyNode(s) it touched, via `recalculateTaxonomyCounts` — also
inside that same transaction.

This doc, and the script it documents
(`server/scripts/verifyTaxonomyAuditLog.js`), close the loop: they
confirm those two numbers — and a third, independently-computed one —
agree with each other, so a bug in either the logging path or the
count-persisting path would show up as a mismatch rather than going
unnoticed because each one only ever checked itself.

## How to run it

```bash
cd server
npm run verify:taxonomy-audit
# or directly:
node scripts/verifyTaxonomyAuditLog.js
```

Run this **after** exercising the rename/move/merge/delete endpoints
(Prompts 4-9) against a real database — e.g. after a manual QA pass
through the Taxonomy Manager UI, or after any integration test suite
that drives those endpoints. The script is read-only: it never writes
to `ActivityLog`, `TaxonomyNode`, or `MCQ`.

## What it checks, and why three numbers instead of two

For every `ActivityLog` row whose `action` is one of the six
`taxonomy_*` values, the script computes:

1. **Logged `mcqs_updated`** — read straight off the `ActivityLog` row
   itself, written by the mutation's own `MCQ.updateMany`/`deleteMany`
   result at the time it ran.
2. **Persisted `counts.total`** — read straight off the
   `TaxonomyNode` the row's `new_location` resolves to, written by
   `recalculateTaxonomyCounts` in that same transaction.
3. **Independent recount** — a brand-new `MCQ.countDocuments` query,
   built from scratch inside the verification script (not imported
   from `taxonomy.service.js`), matching the exact same
   subject/topic/subtopic path.

Three independently-written pieces of code landing on the same number
for the same operation is a much stronger signal than any one of them
merely being self-consistent — a bug shared between the mutation's own
count and `recalculateTaxonomyCounts` (e.g. both using a filter that's
subtly case-sensitive when it shouldn't be) would still show up here,
because the verification script's filter was written independently.

### What "match" means per action

| Action | Logged vs. Persisted | Persisted vs. Independent recount |
|---|---|---|
| `taxonomy_node_renamed` | must match | must match |
| `taxonomy_topic_moved` | must match | must match |
| `taxonomy_subtopic_moved` | must match | must match |
| `taxonomy_subject_merged_into_subject` | must match | must match |
| `taxonomy_nodes_merged` | **not** expected to match (survivor may have had pre-existing MCQs before the merge) | must match |
| `taxonomy_node_deleted` (`on_orphan_mcqs: move`) | **not** expected to match (destination may have had pre-existing MCQs) | must match |
| `taxonomy_node_deleted` (`on_orphan_mcqs: delete`) | n/a — no destination node survives to check | independently re-counts MCQs still at the OLD path; must be **zero** |

The single-target operations (rename, the three movers,
subject-into-subject) move or relabel an entire, self-contained set of
MCQs into a location with (by construction — the sibling-collision
pre-check every one of them runs) no pre-existing content, so all
three numbers are expected to agree exactly. Merge and a move-outcome
delete can land on a destination that already had MCQs of its own
before the operation, so `mcqs_updated` (only the newly-retagged rows)
is allowed to be smaller than the destination's final total — what
still has to hold is that the destination's *persisted* total and an
*independent* recount of it agree with each other, which is the actual
bug-catching check for those two actions.

## Output shape

The script prints a Markdown table directly to stdout — paste it below
once you've run it against real data:

```
| # | Action | Old Location | New Location | Logged mcqs_updated | Persisted counts.total | Independent Recount | Match |
|---|---|---|---|---|---|---|---|
| 1 | taxonomy_node_renamed | ... | ... | ... | ... | ... | ✅ |
| 2 | taxonomy_topic_moved | ... | ... | ... | ... | ... | ✅ |
...
```

Exit code `0` means every checkable row matched (zero mismatches);
`1` means at least one `❌` row was found, or the script itself
errored (e.g. couldn't connect to the database) — same convention as
`scripts/reconcileTaxonomy.js`.

### Rows that can't be checked

- **`⚠️ stale`** — the row's `new_location` path no longer resolves to
  a `TaxonomyNode` at all, because a *later* operation renamed, moved,
  or deleted it again after this row was written. This is a timing
  artifact of running the script long after the fact, not a bug in
  either number — re-run the check closer to when the operations
  happened for a fully clean table.
- **`⚠️ skipped`** — the row's `new_location` string didn't parse to a
  path (shouldn't happen for any of the six actions as currently
  written; would only fire if a future change to `taxonomy.service.js`
  altered the `new_location` shape without updating this script's
  parser to match).

## Result

**Zero mismatches** across every operation type from Prompts 4-9 is
the Prompt 15 DoD. Run the command above against your own test/QA data
and paste the resulting table into this section as the record of that
run.
