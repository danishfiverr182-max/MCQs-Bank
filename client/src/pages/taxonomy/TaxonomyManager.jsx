import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronRight, ListTree, Pencil, ArrowRightLeft, GitMerge, Trash2, X, GripVertical } from 'lucide-react';
import apiClient, { handleApiError } from '@/lib/axios';
import EmptyState from '@/components/common/EmptyState';
import RenameNodeModal from '@/components/taxonomy/RenameNodeModal';
import MoveNodeModal, { buildDestinationOptions } from '@/components/taxonomy/MoveNodeModal';
import MergeNodesModal from '@/components/taxonomy/MergeNodesModal';
import DeleteNodeModal from '@/components/taxonomy/DeleteNodeModal';
import { displayName, joinTaxonomyPath } from '@/utils/taxonomyDisplay';

// TaxonomyManager.jsx — Prompt 109, extended in Prompts 16-18.
//
// One GET /api/mcqs/taxonomy call on mount (refetched after any
// successful rename/move/merge/delete — see handleMutated below),
// rendered as an expandable Subject -> Topic -> Subtopic tree. No
// pagination here — per the prompt's own note, subject/topic/subtopic
// counts are small (dozens of nodes), unlike the MCQ list itself.
//
// Prompt 16 replaced the old topic/subtopic-only, string-match-based
// rename modal (which called PATCH /mcqs/bulk-reassign-topic) with
// RenameNodeModal/MoveNodeModal — id-based, work at any of the three
// levels (including subject, which the old modal couldn't rename at
// all), and go through the Prompt 10 preview endpoint before
// committing via the Prompt 4-7 node-mutation routes. This file's own
// GET /mcqs/taxonomy read now carries each node's `id` (see
// mcq.service.js's getTaxonomy, Prompt 16) specifically so those two
// modals have something to mutate by.
//
// Prompt 17 adds a THIRD, multi-node selection flow on top of that:
// checkboxes on every row let an admin tick 2+ same-type nodes and
// merge them via MergeNodesModal, which reuses the exact same
// preview -> confirm pattern and <TaxonomyDiffPreview> as rename/move.
// Prompt 20 (Bulk Select, Feature 12) generalizes this same checkbox
// selection to feed Move and Delete too, not just Merge — see
// isSelectionDisabled/BulkSelectionBar below for how Move/Delete allow
// selecting across different parents while Merge alone still requires
// one shared parent.
//
// Prompt 18 adds the FOURTH and last taxonomy mutation, delete, via
// DeleteNodeModal — same preview -> confirm shape and
// <TaxonomyDiffPreview> again, plus its own upfront counts step and
// required move-vs-delete-outright choice (see that file's own header
// comment for why delete alone needs those two extra beats). With
// this, every one of the six taxonomy mutations (rename, 3x move,
// merge, delete) is reachable from this page through exactly ONE
// shared preview/confirm implementation — see the Prompt 16-18 audit
// note at the bottom of this file.
//
// Prompt 19 adds drag-and-drop as a FASTER WAY TO OPEN the existing
// move flow, not a new mutation path of its own: dragging a topic row
// onto a subject row, a subtopic row onto a topic row, or a subject
// row onto another subject row opens the exact same MoveNodeModal a
// click on that row's own "Move" button would (see RowActions) —
// pre-filled with the dropped-onto destination via MoveNodeModal's new
// `initialDestinationId` prop, but still stopping at the 'select' step
// for the admin to hit "Preview changes" then "Confirm move" like any
// other move. Drag-target validity (handleDragOver/computeDropValidity
// below) reuses MoveNodeModal's own exported `buildDestinationOptions`
// — the SAME function that decides what the modal's destination picker
// itself offers — so a target that's invisibly rejected here is
// exactly the target the modal itself would've rejected, not a
// separately-maintained set of rules that could drift from Prompt 12's
// actual guardrails.

// Coverage thresholds — deliberately a top-of-file constant, not a
// settings page (see Prompt 109's "keep this lightweight" note).
// < THIN_THRESHOLD is a hard warning (red), THIN_THRESHOLD..<HEALTHY_THRESHOLD
// is a soft warning (amber), >= HEALTHY_THRESHOLD reads as healthy (green).
const THIN_THRESHOLD = 10;
const HEALTHY_THRESHOLD = 30;

const countTone = (count) => {
  if (count < THIN_THRESHOLD) return 'danger';
  if (count < HEALTHY_THRESHOLD) return 'warning';
  return 'success';
};

const COUNT_BADGE_STYLES = {
  danger: 'bg-danger-light text-danger-dark',
  warning: 'bg-warning-light text-warning-dark',
  success: 'bg-success-light text-success-dark',
};

function InlineSpinner() {
  return (
    <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
  );
}

// ─── CountBadge ──────────────────────────────────────────────────────
function CountBadge({ count }) {
  const tone = countTone(count);
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums ${COUNT_BADGE_STYLES[tone]}`}
    >
      {count}
    </span>
  );
}

// ─── StatusDots ──────────────────────────────────────────────────────
// Small colored dots summarizing the approved/pending/rejected split for
// one node, each with a title tooltip since there's no room for labels
// inline in a tree row.
function StatusDots({ approved = 0, pending = 0, rejected = 0 }) {
  return (
    <span className="inline-flex items-center gap-1" title={`${approved} approved · ${pending} pending · ${rejected} rejected`}>
      <span className="h-1.5 w-1.5 rounded-full bg-success" />
      <span className="h-1.5 w-1.5 rounded-full bg-warning" />
      <span className="h-1.5 w-1.5 rounded-full bg-danger" />
    </span>
  );
}

// ─── SelectionCheckbox ─────────────────────────────────────────────
// Prompt 17, generalized in Prompt 20 (Bulk Select, Feature 12). One
// shared checkbox for every row's bulk-selection column — feeds
// TaxonomyManager's Move/Merge/Delete toolbar (BulkSelectionBar below),
// not merge alone anymore. `disabled` is true whenever a selection
// already exists AND it's a DIFFERENT node TYPE than this row (see
// TaxonomyManager's own isSelectionDisabled) — same-type nodes under
// DIFFERENT parents can still be checked together (Move and Delete
// don't require a shared parent; only Merge does, enforced at the
// toolbar's own "Merge" button instead of at checkbox-time — see
// BulkSelectionBar's own comment for why).
function SelectionCheckbox({ checked, disabled, onChange, label }) {
  return (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      title={disabled ? 'Selection is limited to one node type at a time — clear it first' : label}
      className="h-4 w-4 rounded border-gray-300 text-primary-600 focus:ring-ring disabled:opacity-30 disabled:cursor-not-allowed"
    />
  );
}

// ─── mcqBankLink ─────────────────────────────────────────────────────
// Builds a /admin/mcqs deep link pre-filtered to a subject+topic(+subtopic),
// consumed by MCQList.jsx's own Prompt 109 read of these same param names.
const mcqBankLink = (subject, topic, subtopic) => {
  const params = new URLSearchParams();
  params.set('subject', subject);
  if (topic !== undefined) params.set('topic', topic);
  if (subtopic !== undefined) params.set('subtopic', subtopic);
  return `/admin/mcqs?${params.toString()}`;
};

// ─── drag-and-drop helpers (Prompt 19) ────────────────────────────────
// `dnd` (passed down through SubjectSection -> TopicRow -> SubtopicRow,
// same shape as `merge`) carries the CURRENT drag state and the
// curried event-handler factories every draggable/droppable row needs:
//   dragState:    { kind, node } of whatever's currently being
//                 dragged, or null — `node` is the exact shape
//                 MoveNodeModal's own `node` prop expects for that
//                 `kind` (see that file's own header comment).
//   dragOverInfo: { targetId, valid } for whichever row is currently
//                 being dragged over, or null — `valid` drives the
//                 row's own visual accept/reject styling below.
//   onDragStart(kind, node) -> event handler — records what's being
//                 dragged.
//   onDragOver(targetKind, targetId) -> event handler — the ONLY place
//                 drop validity is decided (via computeDropValidity,
//                 defined inside TaxonomyManager itself since it needs
//                 the live `subjects` tree); calls preventDefault()
//                 ONLY when valid, which is what actually produces the
//                 native browser "no-drop" cursor AND blocks onDrop
//                 from ever firing for an invalid target — this
//                 prompt's own DoD ("invalid targets should visually
//                 reject the drop... at drag-time, not just when the
//                 resulting modal opens") is this line, not a check
//                 inside handleDrop.
//   onDragLeave(targetId) -> event handler — clears dragOverInfo when
//                 the pointer leaves that row.
//   onDrop(targetKind, targetId) -> event handler — re-validates (drop
//                 can theoretically fire without a matching dragover on
//                 some browsers/paths) and, if still valid, opens
//                 MoveNodeModal via setMoveTarget with the dropped-onto
//                 target as `initialDestinationId`.
//
// draggingRowClass/dropTargetRowClass below are the shared visual
// vocabulary every draggable/droppable row's className string appends
// — dimmed while it's the thing being dragged, ring-highlighted
// (green-ish "accept" vs red "reject") while something else is
// hovering over it as a drop candidate.
const draggingRowClass = (dnd, kind, id) =>
  dnd.dragState && dnd.dragState.kind === kind && dnd.dragState.node.id === id ? 'opacity-40' : '';

const dropTargetRowClass = (dnd, targetId) => {
  if (!dnd.dragOverInfo || dnd.dragOverInfo.targetId !== targetId) return '';
  return dnd.dragOverInfo.valid
    ? 'ring-2 ring-inset ring-primary-400 bg-primary-50'
    : 'ring-2 ring-inset ring-danger/60 bg-red-50 cursor-not-allowed';
};

// ─── DragHandle ──────────────────────────────────────────────────────
// Fix for the "whole row is draggable" problem: previously `draggable`
// lived on the entire row div, which meant a mousedown-and-move over
// ANY control inside it (Rename/Move/Delete buttons, the "View MCQs"
// link, even the checkbox) got captured by the browser as a native
// drag gesture instead of reaching that control's own click handler.
// Native HTML drag-and-drop only needs `draggable` on the specific
// element you want to grab, not its container — so this small grip
// icon is now the ONLY draggable element in a row. The row div itself
// keeps onDragOver/onDragLeave/onDrop (it's still a valid DROP
// target), it just no longer initiates a drag itself.
function DragHandle({ dnd, kind, node, label }) {
  return (
    <span
      draggable
      onDragStart={dnd.onDragStart(kind, node)}
      onDragEnd={dnd.onDragEnd}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      title="Drag to move"
      aria-label={label}
      className="flex items-center justify-center h-6 w-4 shrink-0 text-gray-300 hover:text-gray-500 cursor-grab active:cursor-grabbing transition-colors"
    >
      <GripVertical className="h-4 w-4" />
    </span>
  );
}


// Shared "Rename" / "Move" / "Delete" action set, identical at all
// three levels (Prompt 16-18) — only the click handlers differ per row.
function RowActions({ onRename, onMove, onDelete, moveLabel }) {
  return (
    <>
      <button
        type="button"
        onClick={onRename}
        className="inline-flex items-center gap-1 text-gray-500 hover:text-primary-600"
      >
        <Pencil className="h-3.5 w-3.5" /> Rename
      </button>
      <button
        type="button"
        onClick={onMove}
        className="inline-flex items-center gap-1 text-gray-500 hover:text-primary-600"
      >
        <ArrowRightLeft className="h-3.5 w-3.5" /> {moveLabel}
      </button>
      <button
        type="button"
        onClick={onDelete}
        className="inline-flex items-center gap-1 text-gray-500 hover:text-danger"
      >
        <Trash2 className="h-3.5 w-3.5" /> Delete
      </button>
    </>
  );
}

// ─── SubtopicRow ─────────────────────────────────────────────────────
// Wrapped in memo() (perf pass): with a stable `dnd`/`selection` object
// identity from the parent (see TaxonomyManager's own useMemo on those
// below) and a stable `subtopic` object identity between fetches, this
// lets a row skip re-rendering entirely when some UNRELATED row's
// state changes (e.g. opening the Rename modal for a different node,
// or checking a different row's selection box) — previously EVERY row
// in the whole tree re-rendered on any such interaction because
// SubjectSection/TopicRow/SubtopicRow had no memoization and the `dnd`
// object was a brand-new object literal every render, which defeated
// memo even if it had been present.
const SubtopicRow = memo(function SubtopicRow({ subjectId, subjectName, topicId, topicName, subtopic, onRename, onMove, onDelete, selection, dnd }) {
  return (
    <div
      className={`grid grid-cols-[auto_auto_1fr_auto_auto_auto] items-center gap-3 pl-12 pr-4 py-1.5 text-sm hover:bg-gray-50 transition-colors ${draggingRowClass(dnd, 'subtopic', subtopic.id)}`}
    >
      <DragHandle
        dnd={dnd}
        kind="subtopic"
        node={{ id: subtopic.id, name: subtopic.name, topicId, topicName, subjectName }}
        label={`Drag to move "${displayName(subtopic.name)}"`}
      />
      <SelectionCheckbox
        checked={selection.isChecked(subtopic.id)}
        disabled={selection.isDisabled('subtopic')}
        onChange={() =>
          selection.onToggle(
            'subtopic',
            topicId,
            joinTaxonomyPath([subjectName, displayName(topicName)]),
            { id: subtopic.id, name: subtopic.name, total: subtopic.total },
            { id: subtopic.id, name: subtopic.name, topicId, topicName, subjectName }
          )
        }
        label={`Select "${displayName(subtopic.name)}"`}
      />
      <span className="text-gray-600">{displayName(subtopic.name)}</span>
      <StatusDots {...subtopic} />
      <CountBadge count={subtopic.total} />
      <span className="flex items-center gap-3 text-xs">
        <Link
          to={mcqBankLink(subjectName, topicName, subtopic.name)}
          className="text-primary-600 hover:underline"
        >
          View MCQs
        </Link>
        <RowActions
          onRename={() =>
            onRename({
              node: { id: subtopic.id, type: 'subtopic', name: subtopic.name },
              pathPrefix: joinTaxonomyPath([subjectName, displayName(topicName)]),
            })
          }
          onMove={() =>
            onMove({
              kind: 'subtopic',
              node: {
                id: subtopic.id,
                name: subtopic.name,
                topicId,
                topicName,
                subjectName,
              },
            })
          }
          onDelete={() =>
            onDelete({
              node: { id: subtopic.id, type: 'subtopic', name: subtopic.name },
              pathPrefix: joinTaxonomyPath([subjectName, displayName(topicName)]),
            })
          }
          moveLabel="Move"
        />
      </span>
    </div>
  );
});

// ─── TopicRow ────────────────────────────────────────────────────────
const TopicRow = memo(function TopicRow({ subjectId, subjectName, topic, onRename, onMove, onDelete, selection, dnd }) {
  const [expanded, setExpanded] = useState(false);
  const hasSubtopics = topic.subtopics.length > 0;
  const onlyUnnamedSubtopic = topic.subtopics.length === 1 && topic.subtopics[0].name === '';

  return (
    <div className="border-t border-gray-100 first:border-t-0">
      <div
        onDragOver={dnd.onDragOver('topic', topic.id)}
        onDragLeave={dnd.onDragLeave(topic.id)}
        onDrop={dnd.onDrop('topic', topic.id)}
        className={`grid grid-cols-[auto_auto_1fr_auto_auto_auto] items-center gap-3 pl-4 pr-4 py-2 text-sm hover:bg-gray-50 transition-colors ${draggingRowClass(
          dnd,
          'topic',
          topic.id
        )} ${dropTargetRowClass(dnd, topic.id)}`}
      >
        <DragHandle
          dnd={dnd}
          kind="topic"
          node={{ id: topic.id, name: topic.name, subjectId, subjectName }}
          label={`Drag to move "${displayName(topic.name)}"`}
        />
        <SelectionCheckbox
          checked={selection.isChecked(topic.id)}
          disabled={selection.isDisabled('topic')}
          onChange={() =>
            selection.onToggle(
              'topic',
              subjectId,
              subjectName,
              { id: topic.id, name: topic.name, total: topic.total },
              { id: topic.id, name: topic.name, subjectId, subjectName }
            )
          }
          label={`Select "${displayName(topic.name)}"`}
        />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          disabled={!hasSubtopics || onlyUnnamedSubtopic}
          className="flex items-center gap-1.5 text-left font-medium text-gray-800 disabled:cursor-default"
        >
          <ChevronRight
            className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${
              expanded ? 'rotate-90' : ''
            } ${!hasSubtopics || onlyUnnamedSubtopic ? 'opacity-0' : ''}`}
          />
          {displayName(topic.name)}
        </button>
        <StatusDots {...topic} />
        <CountBadge count={topic.total} />
        <span className="flex items-center gap-3 text-xs">
          <Link to={mcqBankLink(subjectName, topic.name)} className="text-primary-600 hover:underline">
            View MCQs
          </Link>
          <RowActions
            onRename={() =>
              onRename({
                node: { id: topic.id, type: 'topic', name: topic.name },
                pathPrefix: subjectName,
              })
            }
            onMove={() =>
              onMove({
                kind: 'topic',
                node: { id: topic.id, name: topic.name, subjectId, subjectName },
              })
            }
            onDelete={() =>
              onDelete({
                node: { id: topic.id, type: 'topic', name: topic.name },
                pathPrefix: subjectName,
              })
            }
            moveLabel="Move to subject"
          />
        </span>
      </div>

      {expanded && !onlyUnnamedSubtopic && (
        <div className="pb-1">
          {topic.subtopics.map((subtopic) => (
            <SubtopicRow
              key={subtopic.id ?? subtopic.name}
              subjectId={subjectId}
              subjectName={subjectName}
              topicId={topic.id}
              topicName={topic.name}
              subtopic={subtopic}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
              selection={selection}
              dnd={dnd}
            />
          ))}
        </div>
      )}
    </div>
  );
});

// ─── SubjectSection ──────────────────────────────────────────────────
const SubjectSection = memo(function SubjectSection({ subject, onRename, onMove, onDelete, selection, dnd }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="card p-0 overflow-hidden">
      <div
        onDragOver={dnd.onDragOver('subject', subject.id)}
        onDragLeave={dnd.onDragLeave(subject.id)}
        onDrop={dnd.onDrop('subject', subject.id)}
        className={`grid grid-cols-[auto_auto_1fr_auto_auto_auto] items-center gap-3 px-4 py-3 bg-gray-50 border-b border-gray-200 transition-colors ${draggingRowClass(
          dnd,
          'subject',
          subject.id
        )} ${dropTargetRowClass(dnd, subject.id)}`}
      >
        <DragHandle
          dnd={dnd}
          kind="subject"
          node={{ id: subject.id, name: subject.name, topics: subject.topics }}
          label={`Drag to move "${subject.name}"`}
        />
        <SelectionCheckbox
          checked={selection.isChecked(subject.id)}
          disabled={selection.isDisabled('subject')}
          onChange={() =>
            selection.onToggle(
              'subject',
              'root',
              '',
              { id: subject.id, name: subject.name, total: subject.total },
              { id: subject.id, name: subject.name, topics: subject.topics }
            )
          }
          label={`Select "${subject.name}"`}
        />
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 text-left font-semibold text-gray-900"
        >
          <ChevronRight
            className={`h-4 w-4 shrink-0 text-gray-400 transition-transform ${expanded ? 'rotate-90' : ''}`}
          />
          {subject.name}
        </button>
        <StatusDots {...subject} />
        <CountBadge count={subject.total} />
        <span className="flex items-center gap-3 text-xs">
          <RowActions
            onRename={() =>
              onRename({
                node: { id: subject.id, type: 'subject', name: subject.name },
                pathPrefix: '',
              })
            }
            onMove={() =>
              onMove({
                kind: 'subject',
                node: { id: subject.id, name: subject.name, topics: subject.topics },
              })
            }
            onDelete={() =>
              onDelete({
                node: { id: subject.id, type: 'subject', name: subject.name },
                pathPrefix: '',
              })
            }
            moveLabel="Move into subject"
          />
        </span>
      </div>

      {expanded && (
        <div>
          {subject.topics.map((topic) => (
            <TopicRow
              key={topic.id ?? topic.name}
              subjectId={subject.id}
              subjectName={subject.name}
              topic={topic}
              onRename={onRename}
              onMove={onMove}
              onDelete={onDelete}
              selection={selection}
              dnd={dnd}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const TYPE_LABEL = { subject: 'subject(s)', topic: 'topic(s)', subtopic: 'subtopic(s)' };

// ─── BulkSelectionBar ──────────────────────────────────────────────
// Prompt 17 (merge-only) generalized in Prompt 20 (Bulk Select, Feature
// 12) into three actions. Appears the instant 1+ node is checked.
//
// Move/Delete enable at 1+ selected (a bulk move/delete of exactly one
// node is harmless — it's the same request the row's own "Move"/
// "Delete" button would send, just routed through the *_bulk endpoint;
// the backend's own bulkMove*/bulkDeleteTaxonomyNodes schemas require
// 2+ ids specifically so that single-node case is instead forced back
// through the already-audited single-node route — see
// taxonomy.validator.js's own comment on bulkMoveTopicsToSubjectSchema
// — so this bar keeps Move/Delete requiring 2+ too, to always land on
// the bulk path when it's actually used).
//
// Merge additionally requires every selected node to share the same
// PARENT (`allSameParent`) — mergeTaxonomyNodes' own
// validateMergeSameParent guardrail (Prompt 12) — since unlike Move/
// Delete, a merge collapses N siblings into one of themselves; nodes
// with different parents have nothing to collapse into. Move/Delete
// have no such constraint (see TaxonomyManager's own
// isSelectionDisabled — type-only, no parentKey check), which is what
// makes "3 topics under different subjects, one bulk move" (this
// prompt's own DoD) possible in the first place.
function BulkSelectionBar({ selection, onClear, onMoveClick, onMergeClick, onDeleteClick }) {
  const nodesArr = [...selection.nodes.values()];
  const count = nodesArr.length;
  const allSameParent = nodesArr.every((n) => n.parentKey === nodesArr[0].parentKey);
  const canBulk = count >= 2;
  const canMerge = canBulk && allSameParent;

  return (
    <div className="card flex items-center justify-between gap-3 border-primary-200 bg-primary-50 flex-wrap">
      <span className="text-sm text-gray-700">
        <strong>{count}</strong> {TYPE_LABEL[selection.type]} selected
        {count === 1 ? ' — pick at least one more for a bulk action' : ''}
      </span>
      <span className="flex items-center gap-2 shrink-0 flex-wrap">
        <button
          type="button"
          onClick={onClear}
          className="inline-flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700"
        >
          <X className="h-3.5 w-3.5" /> Clear
        </button>
        <button
          type="button"
          onClick={onMoveClick}
          disabled={!canBulk}
          title={!canBulk ? 'Select at least 2 nodes to bulk-move' : ''}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <ArrowRightLeft className="h-3.5 w-3.5" /> Move {canBulk ? count : ''}
        </button>
        <button
          type="button"
          onClick={onMergeClick}
          disabled={!canMerge}
          title={
            !canBulk
              ? 'Select at least 2 nodes to merge'
              : !allSameParent
              ? 'Merge requires every selected node to share the same parent'
              : ''
          }
          className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <GitMerge className="h-3.5 w-3.5" /> Merge {canMerge ? count : ''}
        </button>
        <button
          type="button"
          onClick={onDeleteClick}
          disabled={!canBulk}
          title={!canBulk ? 'Select at least 2 nodes to bulk-delete' : ''}
          className="inline-flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          <Trash2 className="h-3.5 w-3.5" /> Delete {canBulk ? count : ''}
        </button>
      </span>
    </div>
  );
}

// ─── TaxonomyManager ─────────────────────────────────────────────────
export default function TaxonomyManager() {
  const [subjects, setSubjects] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  // Perf pass: distinct from `isLoading` — set only for a SILENT
  // background reconcile (see fetchTaxonomy/handleMutated below), never
  // blanks the tree or shows the centered spinner. `isLoading` is now
  // reserved for the true first paint and an explicit Retry click only.
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [renameTarget, setRenameTarget] = useState(null); // { node, pathPrefix }
  const [moveTarget, setMoveTarget] = useState(null); // { kind, node, initialDestinationId? }
  const [deleteTarget, setDeleteTarget] = useState(null); // { node, pathPrefix }

  // Prompt 17 — bulk selection state, generalized in Prompt 20 (Bulk
  // Select, Feature 12) from merge-only to feed Move/Merge/Delete
  // alike. `null` when nothing is checked. Otherwise:
  // { type, nodes: Map<id, { id, name, total, parentKey, pathPrefix,
  // moveShape }> }.
  //   - `parentKey` is 'root' for subjects, the parent subject's id for
  //     topics, the parent topic's id for subtopics — used to check
  //     "does the whole batch share one parent" for Merge (see
  //     BulkSelectionBar's own comment on why only Merge needs that).
  //   - `pathPrefix` is that same node's own ancestor path, joined —
  //     what DeleteNodeModal's bulk `nodes` prop needs per-node (its
  //     own header comment explains why: bulk-selected nodes can have
  //     DIFFERENT parents for Move/Delete, so there's no single shared
  //     prefix to pass once).
  //   - `moveShape` is the exact per-kind object MoveNodeModal's own
  //     `nodes` prop expects (see that file's header comment: subject
  //     needs `topics`, topic needs `subjectId`/`subjectName`, subtopic
  //     needs `topicId`/`topicName`/`subjectName`) — captured once, at
  //     checkbox-time, from the same row data RowActions' own onMove
  //     already builds for a single-node move.
  const [selection, setSelection] = useState(null);
  const [mergeModalOpen, setMergeModalOpen] = useState(false);
  const [bulkMoveModalOpen, setBulkMoveModalOpen] = useState(false);
  const [bulkDeleteModalOpen, setBulkDeleteModalOpen] = useState(false);

  // Prompt 19 — drag-and-drop state. `dragState` is { kind, node } for
  // whatever's currently being dragged (same shapes buildDragNode/
  // MoveNodeModal's own `node` prop expect for that `kind`), or null
  // when nothing is. `dragOverInfo` is { targetId, valid } for
  // whichever row the pointer is currently over as a drop candidate,
  // or null — `valid` is decided ONCE, in computeDropValidity below,
  // and both the dragover visual state AND the eventual drop handler
  // read from that same function, so a row can never visually accept a
  // drop it would then silently refuse (or vice versa).
  const [dragState, setDragState] = useState(null);
  const [dragOverInfo, setDragOverInfo] = useState(null);

  // Perf pass: bumped on every call so an in-flight response that's been
  // superseded by a NEWER fetchTaxonomy() call (e.g. a background
  // reconcile still in flight when the admin fires off another
  // mutation) can recognize itself as stale and skip applying — without
  // this, a slow silent reconcile could land AFTER a subsequent
  // optimistic update and stomp it back to older data.
  const fetchRequestIdRef = useRef(0);

  // `silent`: used for the post-mutation background reconcile
  // (handleMutated below) — never touches isLoading/error/the visible
  // tree on failure, so it can never blank the page or flash the
  // spinner. A plain (non-silent) call is still the true first-load /
  // explicit-Retry path, unchanged from before.
  const fetchTaxonomy = useCallback(async ({ silent = false } = {}) => {
    const requestId = ++fetchRequestIdRef.current;
    if (silent) {
      setIsSyncing(true);
    } else {
      setIsLoading(true);
      setError(null);
    }
    try {
      // Overrides the shared 10s default (see lib/axios.js). Unlike every
      // other list in the app, this aggregation has no $match and no
      // pagination — it groups the ENTIRE MCQ collection by subject/topic/
      // subtopic every time the page loads (see mcq.service.js's
      // getTaxonomy). That's fine while the bank is small, but as it grows
      // the query can legitimately take longer than 10s — the same
      // "genuinely still working, just slow" situation BulkImport.jsx
      // already special-cases with its own 120s override. Without this,
      // a slow-but-successful response was being aborted client-side and
      // misreported as "Network error — check your connection" even
      // though nothing was actually wrong with the connection.
      const response = await apiClient.get('/mcqs/taxonomy', { timeout: 120000 });
      if (requestId !== fetchRequestIdRef.current) return; // superseded — drop it
      setSubjects(response.data.data?.subjects ?? []);
    } catch (err) {
      if (requestId !== fetchRequestIdRef.current) return;
      // A silent reconcile failing is deliberately swallowed rather than
      // surfaced: the optimistic tree already on screen (see
      // handleMutated) is still the best data the admin has, and popping
      // an error banner over a background sync would be more disruptive
      // than the staleness it's protecting against. It gets another
      // chance on the next mutation or an explicit Retry/reload.
      if (!silent) setError(handleApiError(err) || 'Failed to load taxonomy');
    } finally {
      if (requestId === fetchRequestIdRef.current) {
        if (!silent) setIsLoading(false);
        setIsSyncing(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchTaxonomy();
  }, [fetchTaxonomy]);

  const totalMcqs = useMemo(() => subjects.reduce((sum, s) => sum + s.total, 0), [subjects]);

  // Shared by rename, move, merge, AND delete — a successful mutation
  // of any kind invalidates the whole tree (names/counts/structure all
  // potentially changed), so all four just close their modal. Bulk
  // move/merge/delete additionally clear the checkbox selection itself,
  // since the moved/merged-away/deleted node ids no longer exist (or no
  // longer live where they did) to be checked.
  //
  // Perf pass: this used to just call fetchTaxonomy() here — a full,
  // BLOCKING re-fetch that flipped isLoading back to true, which tore
  // down the whole rendered tree in favor of the centered spinner and
  // brought it back a couple seconds later. That round trip (on top of
  // the one the modal's own "Preview changes" step had just made) was
  // the literal "whole page refreshes" / "every click costs 5 seconds"
  // complaint — two full getTaxonomy() aggregations for one move.
  //
  // Every modal's preview step already computed the exact predicted
  // post-mutation tree server-side (`new_structure` — see e.g.
  // renameTaxonomyNode's dryRun branch in taxonomy.service.js) and now
  // hands it up as `newSubjects`. Applying that directly repaints the
  // tree in the SAME tick the modal closes — no spinner, no flash, no
  // second network round trip for the common case. A silent background
  // fetchTaxonomy({ silent: true }) right behind it reconciles against
  // whatever's actually in the DB (covers e.g. another admin's
  // concurrent edit landing in between) without disturbing the UI —
  // see fetchTaxonomy's own `silent` handling above.
  //
  // `newSubjects` can be null (a modal that couldn't supply one, or any
  // future call site) — that falls back to the old blocking refetch
  // rather than leaving the tree showing stale data with nothing to
  // correct it.
  const handleMutated = (newSubjects) => {
    setRenameTarget(null);
    setMoveTarget(null);
    setDeleteTarget(null);
    setMergeModalOpen(false);
    setBulkMoveModalOpen(false);
    setBulkDeleteModalOpen(false);
    setSelection(null);
    if (newSubjects) {
      setSubjects(newSubjects);
      fetchTaxonomy({ silent: true });
    } else {
      fetchTaxonomy();
    }
  };

  const clearSelection = () => setSelection(null);

  // Toggles one node's membership in the current bulk selection.
  // Prompt 20 (Bulk Select) broadened this from Prompt 17's own
  // same-type-AND-same-parent constraint to same-TYPE only — Move and
  // Delete both allow selecting nodes under different parents (that's
  // what makes "3 topics under different subjects, one bulk move" this
  // prompt's own DoD describes possible); only Merge still requires a
  // shared parent, checked at BulkSelectionBar's own "Merge" button
  // instead of here, so the checkbox itself doesn't have to know which
  // of the three actions the admin will eventually pick.
  //
  // Starting a fresh TYPE while a different one is already active is
  // unreachable in practice — every row's own checkbox is `disabled`
  // whenever it doesn't match the active type (see isSelectionDisabled
  // below) — but this still resets cleanly to a fresh single-node
  // selection rather than silently mixing two types together if it
  // were ever reached some other way.
  // Perf pass: every one of these was a plain function re-created on
  // every TaxonomyManager render, and `selectionHelpers`/`dnd` below
  // were plain object literals wrapping them — so even with memo() on
  // the row components (added above), EVERY row in the tree still
  // would have re-rendered on every state change anywhere on the page
  // (opening a modal, checking one box, one dragover tick), because
  // `dnd`/`selection` are the two props every row receives, and their
  // identity was changing every render regardless of memo. Wrapping
  // the handlers in useCallback and the two container objects in
  // useMemo means `dnd`/`selectionHelpers` now only change identity
  // when something they actually depend on changes — which is what
  // lets memo() on SubjectSection/TopicRow/SubtopicRow actually skip
  // re-rendering rows that aren't affected by a given interaction.
  const toggleSelectionNode = useCallback((type, parentKey, pathPrefix, node, moveShape) => {
    setSelection((prev) => {
      const sameType = prev && prev.type === type;
      const nextMap = sameType ? new Map(prev.nodes) : new Map();
      if (nextMap.has(node.id)) {
        nextMap.delete(node.id);
      } else {
        nextMap.set(node.id, { ...node, parentKey, pathPrefix, moveShape });
      }
      if (nextMap.size === 0) return null;
      return { type, nodes: nextMap };
    });
  }, []);

  const isSelectionChecked = useCallback((id) => selection?.nodes.has(id) ?? false, [selection]);
  const isSelectionDisabled = useCallback((type) => !!selection && selection.type !== type, [selection]);

  const selectionHelpers = useMemo(
    () => ({
      isChecked: isSelectionChecked,
      isDisabled: isSelectionDisabled,
      onToggle: toggleSelectionNode,
    }),
    [isSelectionChecked, isSelectionDisabled, toggleSelectionNode]
  );

  // ─── Drag-and-drop (Prompt 19) ───────────────────────────────────
  // `targetKind` here is the TYPE OF ROW being dragged over — 'subject'
  // (a subject header row) or 'topic' (a topic row) — not the kind of
  // thing being dragged. A subject row accepts a dragged subject (P6:
  // subject-into-subject) OR a dragged topic (P5: topic-into-subject);
  // a topic row accepts only a dragged subtopic (P7). Subtopic rows are
  // never drop targets (nothing moves onto a subtopic in this 3-level
  // tree), so there's no 'subtopic' branch here at all.
  //
  // Reuses MoveNodeModal's own exported `buildDestinationOptions` — the
  // literal function that decides the modal's own destination picker —
  // so "is this a valid drop target" and "is this a selectable
  // destination in the modal" can never disagree.
  const computeDropValidity = useCallback(
    (targetKind, targetId) => {
      if (!dragState) return false;
      if (targetKind === 'subject' && dragState.kind !== 'subject' && dragState.kind !== 'topic') return false;
      if (targetKind === 'topic' && dragState.kind !== 'subtopic') return false;
      const { blockedReason, options } = buildDestinationOptions(dragState.kind, dragState.node, subjects);
      if (blockedReason) return false;
      return options.some((o) => o.id === targetId);
    },
    [dragState, subjects]
  );

  const handleDragStart = useCallback(
    (kind, node) => (e) => {
      setDragState({ kind, node });
      try {
        e.dataTransfer.effectAllowed = 'move';
        // Firefox requires setData to be called for a drag to actually
        // start at all — the value itself is never read back (all the
        // real state lives in `dragState` above), so any non-empty
        // payload works.
        e.dataTransfer.setData('text/plain', node.id);
      } catch {
        // dataTransfer can be unavailable in some test/embed contexts —
        // dragState above is still set, so the rest of the flow degrades
        // gracefully rather than throwing.
      }
    },
    []
  );

  const handleDragEnd = useCallback(() => {
    // Fires on drop OR on a cancelled drag (dropped outside any valid
    // target, Escape pressed, etc.) — clearing both pieces of state
    // here means a cancelled drag never leaves a stale ring/dim style
    // behind on some row.
    setDragState(null);
    setDragOverInfo(null);
  }, []);

  const handleDragOver = useCallback(
    (targetKind, targetId) => (e) => {
      if (!dragState) return;
      const valid = computeDropValidity(targetKind, targetId);
      // Per this prompt's own DoD: calling preventDefault() ONLY when
      // valid is what makes an invalid target visibly reject the drop
      // DURING the drag — the browser shows its native "no-drop" cursor
      // and never fires onDrop at all for this element when
      // preventDefault() was never called on its dragover.
      if (valid) {
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      } else if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'none';
      }
      setDragOverInfo((prev) => (prev && prev.targetId === targetId && prev.valid === valid ? prev : { targetId, valid }));
    },
    [dragState, computeDropValidity]
  );

  const handleDragLeave = useCallback(
    (targetId) => () => {
      setDragOverInfo((prev) => (prev && prev.targetId === targetId ? null : prev));
    },
    []
  );

  const handleDrop = useCallback(
    (targetKind, targetId) => (e) => {
      e.preventDefault();
      // Re-validated rather than trusted from the last dragover — belt
      // and suspenders against any browser path where drop can fire
      // without a matching dragover having run first.
      const valid = computeDropValidity(targetKind, targetId);
      const dragged = dragState;
      setDragOverInfo(null);
      setDragState(null);
      if (!dragged || !valid) return;
      // Opens the SAME MoveNodeModal a click on that row's own "Move"
      // button opens (see RowActions/onMove above) — just pre-filled.
      // Nothing here calls the move API directly.
      setMoveTarget({ kind: dragged.kind, node: dragged.node, initialDestinationId: targetId });
    },
    [dragState, computeDropValidity]
  );

  const dnd = useMemo(
    () => ({
      dragState,
      dragOverInfo,
      onDragStart: handleDragStart,
      onDragEnd: handleDragEnd,
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
    }),
    [dragState, dragOverInfo, handleDragStart, handleDragEnd, handleDragOver, handleDragLeave, handleDrop]
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="section-title">Taxonomy</h1>
          <p className="text-sm text-gray-500 flex items-center gap-2">
            <span>
              {totalMcqs} question{totalMcqs === 1 ? '' : 's'} across {subjects.length} subject
              {subjects.length === 1 ? '' : 's'}
            </span>
            {/* Perf pass: tiny, non-blocking — the background reconcile
                fetchTaxonomy({ silent: true }) kicks off after every
                optimistic update (see handleMutated). This is the ONLY
                visible sign it's running; it never replaces the tree or
                shows the centered spinner. */}
            {isSyncing && (
              <span className="inline-flex items-center gap-1 text-xs text-gray-400">
                <span className="h-1.5 w-1.5 rounded-full bg-gray-300 animate-pulse" />
                syncing…
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Legend */}
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-gray-600">
        <span className="font-medium text-gray-500">Coverage:</span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-danger" /> under {THIN_THRESHOLD} — thin
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-warning" /> {THIN_THRESHOLD}–{HEALTHY_THRESHOLD - 1} — okay
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-success" /> {HEALTHY_THRESHOLD}+ — healthy
        </span>
        <span className="mx-2 h-3 w-px bg-gray-200" />
        <span className="font-medium text-gray-500">Status split:</span>
        <StatusDots approved={1} pending={1} rejected={1} />
        <span>approved · pending · rejected (hover a row's dots for the exact split)</span>
        <span className="mx-2 h-3 w-px bg-gray-200" />
        <span>
          Drag a row onto a valid parent (a topic/subtopic onto its new subject/topic, or a subject onto
          another subject) to move it — this only opens the same move dialog pre-filled, it never moves
          anything by itself.
        </span>
      </div>

      {selection && (
        <BulkSelectionBar
          selection={selection}
          onClear={clearSelection}
          onMoveClick={() => setBulkMoveModalOpen(true)}
          onMergeClick={() => setMergeModalOpen(true)}
          onDeleteClick={() => setBulkDeleteModalOpen(true)}
        />
      )}

      {error && !isLoading && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{error}</p>
          <button
            type="button"
            onClick={() => fetchTaxonomy()}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {!error && isLoading && (
        <div className="flex items-center justify-center py-16">
          <InlineSpinner />
        </div>
      )}

      {!error && !isLoading && subjects.length === 0 && (
        <EmptyState
          icon={ListTree}
          title="No MCQs yet"
          message="Once MCQs are added or imported, their subjects, topics, and subtopics will show up here."
        />
      )}

      {!error && !isLoading && subjects.length > 0 && (
        <div className="space-y-3">
          {subjects.map((subject) => (
            <SubjectSection
              key={subject.id ?? subject.name}
              subject={subject}
              onRename={setRenameTarget}
              onMove={setMoveTarget}
              onDelete={setDeleteTarget}
              selection={selectionHelpers}
              dnd={dnd}
            />
          ))}
        </div>
      )}

      {renameTarget && (
        <RenameNodeModal
          node={renameTarget.node}
          pathPrefix={renameTarget.pathPrefix}
          onClose={() => setRenameTarget(null)}
          onRenamed={handleMutated}
        />
      )}

      {moveTarget && (
        <MoveNodeModal
          kind={moveTarget.kind}
          node={moveTarget.node}
          subjects={subjects}
          initialDestinationId={moveTarget.initialDestinationId}
          onClose={() => setMoveTarget(null)}
          onMoved={handleMutated}
        />
      )}

      {mergeModalOpen && selection && (
        <MergeNodesModal
          type={selection.type}
          nodes={[...selection.nodes.values()].map((n) => ({ id: n.id, name: n.name, total: n.total }))}
          pathPrefix={[...selection.nodes.values()][0]?.pathPrefix}
          onClose={() => setMergeModalOpen(false)}
          onMerged={handleMutated}
        />
      )}

      {bulkMoveModalOpen && selection && (
        <MoveNodeModal
          kind={selection.type}
          nodes={[...selection.nodes.values()].map((n) => n.moveShape)}
          subjects={subjects}
          onClose={() => setBulkMoveModalOpen(false)}
          onMoved={handleMutated}
        />
      )}

      {bulkDeleteModalOpen && selection && (
        <DeleteNodeModal
          nodes={[...selection.nodes.values()].map((n) => ({
            id: n.id,
            type: selection.type,
            name: n.name,
            pathPrefix: n.pathPrefix,
          }))}
          subjects={subjects}
          onClose={() => setBulkDeleteModalOpen(false)}
          onDeleted={handleMutated}
        />
      )}

      {deleteTarget && (
        <DeleteNodeModal
          node={deleteTarget.node}
          pathPrefix={deleteTarget.pathPrefix}
          subjects={subjects}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleMutated}
        />
      )}
    </div>
  );
}

// ─── Prompt 16-18 audit note ───────────────────────────────────────
// DoD for Prompt 18: "confirm all four modals (rename, move, merge,
// delete) share the same <TaxonomyDiffPreview> component and the same
// two-step confirm pattern, rather than each having drifted into its
// own slightly-different flow."
//
// Shared preview component — one, not four:
//   RenameNodeModal, MoveNodeModal, MergeNodesModal, and
//   DeleteNodeModal (client/src/components/taxonomy/) each import and
//   render `client/src/components/taxonomy/TaxonomyDiffPreview.jsx` —
//   grep for "TaxonomyDiffPreview" across that directory turns up the
//   one component file plus exactly those four import sites, no
//   parallel copy anywhere. Every call site passes it the same five
//   core fields (fromPath, toPath, mcqsAffected, subjects/topics/
//   subtopicsAffected) sourced from the same shape of response, since
//   all four ultimately go through the one previewTaxonomyOperation()
//   dispatcher in api/taxonomyApi.js (delete's own upfront counts
//   step is the one addition — see DeleteNodeModal's own header
//   comment — but its actual diff step uses the same dispatcher and
//   the same component as the other three). Merge's `duplicateMcqCount`/
//   `rawMcqsAffected` and delete's `note` are optional props the other
//   callers simply don't pass — additive, not a fork.
//
// Shared confirm pattern — one two-step shape, not four:
//   Every modal is `useState('<first step>')` -> ... ->
//   `useState('preview')`, where the LAST step before "preview" always
//   ends in a "Preview changes" button that calls
//   previewTaxonomyOperation(operation, payload), and the 'preview'
//   step always renders <TaxonomyDiffPreview> plus a "Back" (returns to
//   the prior step) and a "Confirm <verb>" button that calls the real
//   mutation and then the parent's onXxx callback (onRenamed/onMoved/
//   onMerged/onDeleted) to close + refetch. Rename and merge are
//   literally two steps (edit/choose -> preview); move is the same two
//   steps under a different first-step name (select -> preview);
//   delete is the one outlier with THREE steps (info -> choose ->
//   preview) — but that's the extra upfront counts screen this
//   prompt's own DoD calls for, not a different confirm pattern: its
//   own last two steps (choose -> preview -> confirm) are the exact
//   same shape as the other three's only two.
//
// Net: one <TaxonomyDiffPreview>, one previewTaxonomyOperation()
// dispatcher, one confirm shape — extended with per-operation
// content (merge's keep-name choice, delete's counts screen and
// orphan-handling choice), not reimplemented four times.
