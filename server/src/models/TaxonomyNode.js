import mongoose from 'mongoose';
import { slugify } from '../utils/slugify.js';

const { Schema } = mongoose;

// TaxonomyNode — the new taxonomy MANAGEMENT layer (see TAXONOMY_AUDIT.md).
//
// PURELY ADDITIVE as of this prompt: nothing in the existing codebase
// reads or writes this collection yet. MCQ.subject/topic/subtopic remain
// the system's actual source of truth for every current query
// (findWithFilters, fetchAndSamplePool, getTaxonomy, etc.) — this model
// only exists so a later prompt has somewhere durable to store
// restructuring metadata (canonical display name/casing, explicit
// ordering, a stable id to rename/move/merge against) without having to
// keep re-deriving that from a live MCQ aggregation every time.
//
// Shape: a 3-level tree — subject (root, parent_id: null) -> topic
// (parent_id: subject's _id) -> subtopic (parent_id: topic's _id).
// Deliberately nested this way (subtopic's parent is its TOPIC, not its
// subject) rather than a flat set of three parallel lists, mirroring how
// MCQ's own subject/topic/subtopic naturally nest and how
// getTaxonomy()/TaxonomyManager.jsx already present them as a tree.
const taxonomyNodeSchema = new Schema(
  {
    type: {
      type: String,
      enum: ['subject', 'topic', 'subtopic'],
      required: true,
      index: true,
    },
    // '' is a real, valid name here — the "(none)" topic/subtopic
    // bucket carried over verbatim from MCQ.topic/subtopic's own
    // `default: ''` semantics (see MCQ.js). Only meaningful for
    // type: 'topic' | 'subtopic'; a 'subject' node's name should never
    // be '' in practice (MCQ.subject is `required`), but nothing here
    // enforces that per-type — same "assumed, not validated" trust
    // level the rest of this codebase already places in subject being
    // picker-driven rather than free-typed (see TAXONOMY_AUDIT.md §3).
    name: {
      type: String,
      trim: true,
      default: '',
    },
    // Kept in sync with `name` by the pre-validate hook below — never
    // set directly by callers. Exists so uniqueness can be scoped on a
    // normalized value (case/whitespace-insensitive) instead of the
    // raw display `name`, the same casing-drift problem
    // TAXONOMY_AUDIT.md §6/§7 documents for the current MCQ-string-only
    // world. '' slugifies to '' (see utils/slugify.js) — itself a
    // valid, unique-per-(type,parent) slug for the "(none)" bucket.
    slug: {
      type: String,
      trim: true,
      lowercase: true,
      default: '',
    },
    // null for a 'subject' node (tree root). A 'topic' node's parent_id
    // points at its subject node's _id; a 'subtopic' node's parent_id
    // points at its topic node's _id — see the schema-level comment
    // above for why subtopic nests under topic rather than under
    // subject directly.
    // Indexed below via schema.index({ parent_id: 1 }), not here — a
    // field-level `index: true` PLUS a separate schema.index() call on
    // the same field throws Mongoose's "Duplicate schema index" warning
    // (same avoidance already documented in Blueprint.js's own index
    // comment for exam_id).
    parent_id: {
      type: Schema.Types.ObjectId,
      ref: 'TaxonomyNode',
      default: null,
    },
    // Manual ordering hook for later prompts (e.g. drag-to-reorder in a
    // future Taxonomy Manager UI). seedTaxonomyFromMcqs.js (this same
    // prompt) only ever assigns each node's position in getTaxonomy()'s
    // already-alphabetical sibling order on first creation — nothing
    // in the codebase reads this field yet.
    display_order: {
      type: Number,
      default: 0,
    },
    // ─── Rolled-up MCQ counts (Prompt 13 — Count Recalculation Engine) ──
    // Persisted here so a node's counts can be read without a live MCQ
    // aggregation. Written EXCLUSIVELY by
    // taxonomy.service.js:recalculateTaxonomyCounts — never set
    // directly by any mutation itself, the same "one function owns this
    // math" discipline the rest of that file's transactions now follow
    // (see that function's own header comment). A subject/topic node's
    // `total` is the roll-up of everything beneath it; a subtopic's
    // `total` is its own direct MCQ count (it has no children to roll
    // up in this 3-level tree). Defaults to all-zero so a freshly
    // created node (before its first recalculation) renders sanely
    // rather than as `undefined`.
    counts: {
      total: { type: Number, default: 0 },
      approved: { type: Number, default: 0 },
      pending: { type: Number, default: 0 },
      rejected: { type: Number, default: 0 },
    },
  },
  { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } }
);

// ─── Pre-validate: keep `slug` in sync with `name` ──────────────────
// Mirrors MCQ.js's own pattern of deriving a normalized field from a
// display field in a pre('save'-adjacent) hook (see MCQ.js's
// computeQuestionHash) — except this uses pre('validate') specifically
// so `slug` is already correct by the time the unique index below (and
// any `runValidators: true` update) evaluates it. Only recomputes when
// `name` actually changed (or slug was never set), same "don't touch
// what didn't change" discipline MCQ.js's own hash hook uses.
taxonomyNodeSchema.pre('validate', function computeSlug(next) {
  if (this.isModified('name') || !this.slug) {
    this.slug = slugify(this.name ?? '');
  }
  next();
});

// ─── Indexes ─────────────────────────────────────────────────────────
// One node per (type, parent, slug) — the DB-level guarantee that two
// upserts (or two admins) can never create two "Synonyms" topic nodes
// under the same subject, regardless of exact display casing, since
// both would normalize to the same slug and collide here.
taxonomyNodeSchema.index({ type: 1, parent_id: 1, slug: 1 }, { unique: true });
// "Every direct child of this node" — the shape every tree-walking read
// (rendering a subject's topics, a topic's subtopics) will need.
taxonomyNodeSchema.index({ parent_id: 1 });

const TaxonomyNode = mongoose.model('TaxonomyNode', taxonomyNodeSchema);

export default TaxonomyNode;
