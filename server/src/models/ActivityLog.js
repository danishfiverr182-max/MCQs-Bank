import mongoose from 'mongoose';

const { Schema } = mongoose;

// ActivityLog — Prompt 91. One row per meaningful admin action across the
// whole system. Written by activityLog.service.js's createLog(), either
// directly from a controller or automatically via
// activityLogger.middleware.js (Prompt 92). Rows are immutable: no
// `updated_at`, nothing in this codebase ever calls
// ActivityLog.findByIdAndUpdate — a log is a fact about what happened, not
// a record that evolves.

const activityLogSchema = new Schema(
  {
    actor_id: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    // Denormalized snapshot of the actor's email at log time. Deliberately
    // NOT populated from User on read — if the account is later renamed,
    // disabled, or deleted, the historical log entry should still read
    // "admin@examengine.com did X on this date", not silently change or
    // break. Same "snapshot, don't ref-and-populate" trade-off the rest of
    // the system already makes (e.g. GeneratedTestQuestion vs live MCQ).
    actor_name: {
      type: String,
      required: true,
      trim: true,
    },
    action: {
      type: String,
      required: true,
      index: true,
      // Grouped by domain, one enum value per loggable event. Extend this
      // list in future phases — do not rename existing values, since old
      // ActivityLog rows in the database will keep whatever string was
      // valid when they were written.
      enum: [
        // MCQ domain
        'mcq_created',
        'mcq_updated',
        'mcq_deleted',
        'mcq_bulk_imported',
        'mcq_approved',
        'mcq_rejected',
        'mcq_merged',
        // Prompt 109: Taxonomy Manager's bulk topic/subtopic rename —
        // one row per rename action, not one per affected MCQ (mirrors
        // mcq_bulk_imported/mcq_bulk_approved-style granularity).
        'mcq_bulk_reassigned',
        // Taxonomy domain (Prompt 14). One row per structural taxonomy
        // mutation — rename, or one of the three reparenting movers —
        // written inside the SAME transaction as the mutation itself
        // (see taxonomy.service.js's renameTaxonomyNode/
        // moveTopicToSubject/moveSubjectIntoSubject/moveSubtopicToTopic).
        // Additive only, per this enum's own comment above: these are
        // new values, nothing existing was renamed or removed, so old
        // rows already written as 'mcq_bulk_reassigned' by those same
        // four functions before this prompt keep reading exactly as
        // they did.
        'taxonomy_node_renamed',
        'taxonomy_topic_moved',
        'taxonomy_subject_merged_into_subject',
        'taxonomy_subtopic_moved',
        // Prompt 15: the remaining two taxonomy mutations — merge
        // (Taxonomy P8) and delete (Taxonomy P9) — wired the same way
        // (same transaction, same old_location/new_location/
        // mcqs_updated/success fields) as the four rename/move actions
        // just above.
        'taxonomy_nodes_merged',
        'taxonomy_node_deleted',
        // Blueprint domain
        'blueprint_created',
        'blueprint_updated',
        'blueprint_deleted',
        'blueprint_cloned',
        // Exam domain
        'exam_created',
        'exam_updated',
        'exam_deleted',
        // Test / generator domain
        'test_generated',
        'test_finalized',
        // QA domain
        'qa_run',
        'qa_finalize_blocked',
        // Auth domain
        'admin_login',
        'admin_logout',
      ],
    },
    entity_type: {
      type: String,
      required: true,
      enum: ['MCQ', 'Blueprint', 'Exam', 'Test', 'QAReport', 'Auth'],
    },
    // Mixed, not ObjectId. The system uses two different id conventions
    // depending on domain (Phase 3-8 convention, not introduced here):
    // MCQ/QAReport routes key off the Mongo _id (see mcq.service.js
    // findById), while Blueprint/Exam/Test key off their own stable
    // human-readable business id (blueprint_id / exam_id / test_id —
    // see blueprint.controller.js, exam.controller.js,
    // generator.controller.js). Typing this as ObjectId would make every
    // Blueprint/Exam/Test log entry fail to save. Auth-domain rows
    // (admin_login/admin_logout) have no single entity beyond the actor,
    // so entity_id is left null there.
    entity_id: {
      type: Schema.Types.Mixed,
      index: true,
      default: null,
    },
    details: {
      // Shallow diffs only, never full documents. At 1M+ MCQs, storing a
      // full before/after document snapshot on every edit would balloon
      // ActivityLog storage far past the size of the collections it is
      // auditing, for no real benefit — the fields that changed are what
      // matters for an audit trail, not a duplicate of the whole record.
      before: {
        type: Schema.Types.Mixed,
        default: null,
      },
      after: {
        type: Schema.Types.Mixed,
        default: null,
      },
      summary: {
        type: String,
        trim: true,
        default: '',
      },
    },
    ip_address: {
      type: String,
      trim: true,
      default: '',
    },
    // ── Taxonomy move/rename fields (Prompt 14) ──────────────────────
    // Additive, top-level (not nested in `details`) since they apply to
    // exactly one family of actions (the four `taxonomy_*` values
    // above) and need to stay independently queryable/displayable
    // without callers reaching into `details.before`/`details.after`,
    // which remain the generic shallow-diff pair every other domain
    // already uses. Left `default: null` for every action that isn't
    // a taxonomy rename/move — same "unused-here, not removed" stance
    // `entity_id` already takes for admin_login/admin_logout above.
    old_location: {
      // Full "Subject > Topic > Subtopic" path as it read BEFORE the
      // operation, at whatever depth the moved/renamed node sits.
      type: String,
      trim: true,
      default: null,
    },
    new_location: {
      // Same shape as old_location, AFTER the operation. Together
      // old_location/new_location are what let an admin reconstruct
      // exactly what moved from where to where without re-deriving it
      // from `details.before`/`details.after`'s generic field diff.
      type: String,
      trim: true,
      default: null,
    },
    mcqs_updated: {
      // Count of MCQ documents retagged by this rename/move. Null
      // (not 0) for every non-taxonomy action, and also for a
      // `success: false` row, where the transaction rolled back and
      // no MCQ was actually retagged — 0 there would misleadingly
      // read as "ran, touched nothing" rather than "did not run".
      type: Number,
      default: null,
    },
    success: {
      // Defaults true: every action type that existed before this
      // prompt only ever wrote a row on success (createLog is never
      // called on a failed mcq_updated/blueprint_created/etc — see
      // this file's own createLog usage across the codebase), so
      // `true` is the correct implicit value for all of that history.
      // The four taxonomy_* actions above are the first to also write
      // a row with `success: false`, for an operation whose
      // transaction aborted after already partially validating —
      // written OUTSIDE that aborted transaction, see
      // taxonomy.service.js's own comment on why.
      type: Boolean,
      default: true,
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true,
    },
  },
  {
    // No createdAt/updatedAt pair — `timestamp` is the single source of
    // truth for when the action happened, and logs are never edited after
    // creation, so an `updated_at` field would be permanently identical to
    // `timestamp` and misleading to keep around.
    timestamps: false,
  }
);

// Paginated global feed ("all recent admin activity"), newest first.
activityLogSchema.index({ timestamp: -1 });

// "History of this one entity" — TestDetail / MCQDetail "history" tabs
// (wired up in a later phase) query exactly this shape: one entity,
// newest first. Compound index keeps that an index-only scan instead of
// a collection scan + in-memory sort.
activityLogSchema.index({ entity_type: 1, entity_id: 1, timestamp: -1 });

const ActivityLog = mongoose.model('ActivityLog', activityLogSchema);

export default ActivityLog;
