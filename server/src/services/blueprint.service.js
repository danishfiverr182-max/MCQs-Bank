import Blueprint from '../models/Blueprint.js';
import MCQ from '../models/MCQ.js';
import ApiError from '../utils/ApiError.js';
import { sumsMatch, findDuplicateSubjectNames } from '../utils/blueprintMath.js';
import { cloneOverridesSchema } from '../validators/blueprint.validator.js';

// Same fix as generator.service.js's topicMatchFilter — kept as a
// separate local copy rather than imported, since generator.service.js
// already imports THIS file (importing back would be circular). Topic
// is a free-text field (MCQ.js: no case normalization), so an exact
// string match on a requested topic silently returns 0 results the
// moment casing differs even slightly from how it's stored.
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const topicMatchFilter = (topicValue) => ({
  topic: { $regex: `^${escapeRegex(topicValue.trim())}$`, $options: 'i' },
});

// ─── generateBlueprintId ─────────────────────────────────────────────
// "BP" + zero-padded incrementing count, scoped per exam (BP001, BP002,
// ...) matching the system spec's own example. blueprint_id is globally
// unique at the model level though (Prompt 53), so two different exams
// could otherwise both mint "BP001" — the while loop below is the same
// collision-avoidance pattern as Exam's generateUniqueExamId (Prompt 52):
// per-exam sequential numbering as the common case, with a global
// uniqueness guarantee as the backstop.
const generateBlueprintId = async (examId) => {
  const existingCount = await Blueprint.countDocuments({ exam_id: examId });

  let seq = existingCount + 1;
  let candidate = `BP${String(seq).padStart(3, '0')}`;

  // eslint-disable-next-line no-await-in-loop
  while (await Blueprint.exists({ blueprint_id: candidate })) {
    seq += 1;
    candidate = `BP${String(seq).padStart(3, '0')}`;
  }

  return candidate;
};

// ─── validateDistribution ───────────────────────────────────────────
// Thin service-layer wrapper around the SAME sumsMatch/
// findDuplicateSubjectNames helpers the Zod superRefine (Prompt 53)
// uses — so this and the validator can never disagree on what counts
// as "valid". Exists because setActive and cloneBlueprint work with
// already-persisted/merged data, not a fresh request body, so running
// them back through Zod would mean re-wrapping a Mongoose document as
// a plain object just to satisfy the schema. Returns a plain report
// instead of throwing, so callers decide what to do with it.
export const validateDistribution = (blueprintData) => {
  const errors = [];

  const { subjectSum, difficultySum, subjectsMatch, difficultyMatch } = sumsMatch(
    blueprintData.subjects,
    blueprintData.difficulty_distribution,
    blueprintData.total_questions
  );

  if (!subjectsMatch) {
    errors.push(
      `Subject counts sum to ${subjectSum}, expected ${blueprintData.total_questions}`
    );
  }

  if (!difficultyMatch) {
    errors.push(
      `Difficulty distribution sums to ${difficultySum}, expected ${blueprintData.total_questions}`
    );
  }

  const duplicates = findDuplicateSubjectNames(blueprintData.subjects);
  if (duplicates.length > 0) {
    errors.push(`Duplicate subject name(s) found (case-insensitive): ${duplicates.join(', ')}`);
  }

  return { valid: errors.length === 0, errors };
};

// ─── cloneBlueprint ──────────────────────────────────────────────
export const cloneBlueprint = async (sourceBlueprintId, overrides = {}) => {
  const source = await Blueprint.findOne({ blueprint_id: sourceBlueprintId });
  if (!source) {
    throw new ApiError(404, `Blueprint not found: ${sourceBlueprintId}`);
  }

  // Overrides come in as a raw object from the controller — validate
  // shape with the same partial schema used at the route layer before
  // trusting any of it (cloneBlueprint may also be called internally,
  // not only from an HTTP request, so this can't assume it's already
  // been through route-level `validate` middleware).
  const parsedOverrides = cloneOverridesSchema.shape.body.parse(overrides ?? {});

  const merged = {
    exam_id: source.exam_id,
    total_questions: source.total_questions,
    subjects: source.subjects.map((s) => ({ name: s.name, count: s.count })),
    difficulty_distribution: {
      easy: source.difficulty_distribution.easy,
      medium: source.difficulty_distribution.medium,
      hard: source.difficulty_distribution.hard,
    },
    selection_rules: source.selection_rules,
    ...parsedOverrides,
  };

  // Only re-run the invariant check when an override actually touched
  // one of the fields the sum check depends on — cheap early-out for
  // the common case of overriding something unrelated (e.g. just
  // selection_rules).
  const touchedSumFields =
    'subjects' in parsedOverrides ||
    'difficulty_distribution' in parsedOverrides ||
    'total_questions' in parsedOverrides;

  if (touchedSumFields) {
    const { valid, errors } = validateDistribution(merged);
    if (!valid) {
      throw new ApiError(400, `Clone overrides break the distribution invariant: ${errors.join('; ')}`);
    }
  }

  const newVersion = source.version + 1;
  const newBlueprintId = `${source.blueprint_id}_v${newVersion}`;

  const clone = await Blueprint.create({
    blueprint_id: newBlueprintId,
    exam_id: merged.exam_id,
    version: newVersion,
    // Cloning must NEVER silently activate a new blueprint over the
    // currently active one, even if the source was active — the admin
    // must explicitly call setActive afterward (Prompt 55).
    is_active: false,
    total_questions: merged.total_questions,
    subjects: merged.subjects,
    difficulty_distribution: merged.difficulty_distribution,
    selection_rules: merged.selection_rules,
    created_by: source.created_by,
  });

  return clone;
};

// ─── checkMCQAvailability ────────────────────────────────────────────
// Early-warning feasibility check, NOT a guarantee: it reports whether
// the pool of approved MCQs looks big enough per-subject and per-
// difficulty-overall, but the blueprint's difficulty distribution
// applies across the whole paper rather than per subject, so a paper
// could pass this check subject-by-subject and difficulty-overall and
// still be infeasible in the specific combination the Test Generation
// Engine (Phase 6) actually needs (e.g. "enough hard questions total"
// but none of them happen to be in the one subject that's short).
// Resolving that exact interaction is Phase 6's job — this function
// only surfaces the coarse, cheap-to-compute warning signs up front.
export const checkMCQAvailability = async (blueprint) => {
  const subjectNames = blueprint.subjects.map((s) => s.name);

  // Single aggregation for all subjects at once — never one query per
  // subject — same scaling discipline as Phase 4's duplicate detector,
  // which is what keeps this a small constant number of queries
  // regardless of how large the MCQ collection grows (1M+ per spec).
  const subjectCounts = await MCQ.aggregate([
    { $match: { subject: { $in: subjectNames }, status: 'approved' } },
    { $group: { _id: '$subject', count: { $sum: 1 } } },
  ]);
  const subjectCountMap = new Map(subjectCounts.map((r) => [r._id, r.count]));

  const subjects = blueprint.subjects.map((entry) => {
    const available = subjectCountMap.get(entry.name) ?? 0;
    return {
      name: entry.name,
      required: entry.count,
      available,
      sufficient: available >= entry.count,
    };
  });

  // Second aggregation for the overall (paper-wide) difficulty split —
  // scoped to the same subject set so the counts stay relevant to this
  // blueprint's exam rather than the entire MCQ bank.
  const difficultyCounts = await MCQ.aggregate([
    { $match: { subject: { $in: subjectNames }, status: 'approved' } },
    { $group: { _id: '$difficulty', count: { $sum: 1 } } },
  ]);
  const difficultyCountMap = new Map(difficultyCounts.map((r) => [r._id, r.count]));

  const { easy = 0, medium = 0, hard = 0 } = blueprint.difficulty_distribution ?? {};
  const requiredByDifficulty = { easy, medium, hard };

  const overallDifficulty = {};
  for (const level of ['easy', 'medium', 'hard']) {
    const available = difficultyCountMap.get(level) ?? 0;
    overallDifficulty[level] = {
      required: requiredByDifficulty[level],
      available,
      sufficient: available >= requiredByDifficulty[level],
    };
  }

  // ── Topic-level requirements ("Topics to Include") ──────────────────
  // Only ever present on a generation-time workingConfig — acceptOverrides
  // attaches topic_requirements per subject from the override payload;
  // a plain persisted Blueprint document never has this field, so this
  // whole block is a no-op (empty `topics` array, no effect on
  // `feasible`) for the ordinary "Check Feasibility" blueprint-only
  // call site.
  const topicRequirements = [];
  blueprint.subjects.forEach((entry) => {
    (entry.topic_requirements ?? []).forEach((req) => {
      topicRequirements.push({ subject: entry.name, topic: req.topic, required: req.count });
    });
  });

  let topics = [];
  if (topicRequirements.length > 0) {
    const topicCounts = await MCQ.aggregate([
      {
        $match: {
          status: 'approved',
          $or: topicRequirements.map((r) => ({ subject: r.subject, ...topicMatchFilter(r.topic) })),
        },
      },
      {
        $group: {
          // Normalized to lowercase so "Synonyms" and "synonyms" collapse
          // into the same bucket regardless of casing on either side.
          _id: { subject: '$subject', topic: { $toLower: '$topic' } },
          count: { $sum: 1 },
        },
      },
    ]);
    const topicCountMap = new Map(
      topicCounts.map((r) => [`${r._id.subject}::${r._id.topic}`, r.count])
    );
    topics = topicRequirements.map((r) => {
      const available = topicCountMap.get(`${r.subject}::${r.topic.trim().toLowerCase()}`) ?? 0;
      return { ...r, available, sufficient: available >= r.required };
    });
  }

  const feasible =
    subjects.every((s) => s.sufficient) &&
    Object.values(overallDifficulty).every((d) => d.sufficient) &&
    topics.every((t) => t.sufficient);

  return { feasible, subjects, overallDifficulty, topics };
};

// ─── findByBlueprintId ───────────────────────────────────────────────
export const findByBlueprintId = async (blueprintId) => {
  const blueprint = await Blueprint.findOne({ blueprint_id: blueprintId });
  if (!blueprint) {
    throw new ApiError(404, `Blueprint not found: ${blueprintId}`);
  }
  return blueprint;
};

// ─── createBlueprint ─────────────────────────────────────────────────
// Assumes the caller (controller) has already validated the body shape
// + sum invariant via blueprintInputSchema, and already confirmed
// exam_id references a real Exam — this function's only remaining job
// is ID assignment and persistence.
export const createBlueprint = async (data) => {
  const blueprint_id = data.blueprint_id || (await generateBlueprintId(data.exam_id));

  const blueprint = await Blueprint.create({
    blueprint_id,
    exam_id: data.exam_id,
    total_questions: data.total_questions,
    subjects: data.subjects,
    difficulty_distribution: data.difficulty_distribution,
    selection_rules: data.selection_rules ?? {},
    created_by: data.created_by,
    // Creating a blueprint never auto-activates it — is_active always
    // starts false regardless of what the (already-stripped) body did
    // or didn't contain; activation is the separate, explicit setActive step.
    is_active: false,
  });

  return blueprint;
};

// ─── updateBlueprint ─────────────────────────────────────────────────
export const updateBlueprint = async (blueprintId, updates) => {
  const blueprint = await findByBlueprintId(blueprintId);

  // exam_id and blueprint_id are immutable post-creation — same
  // reasoning as Exam.exam_id (Prompt 52): other records (generated
  // tests, clones) may already reference this blueprint_id/exam_id pair.
  if (
    Object.prototype.hasOwnProperty.call(updates, 'exam_id') &&
    updates.exam_id !== blueprint.exam_id
  ) {
    throw new ApiError(400, 'exam_id cannot be changed after creation');
  }
  if (
    Object.prototype.hasOwnProperty.call(updates, 'blueprint_id') &&
    updates.blueprint_id !== blueprint.blueprint_id
  ) {
    throw new ApiError(400, 'blueprint_id cannot be changed after creation');
  }

  blueprint.total_questions = updates.total_questions;
  blueprint.subjects = updates.subjects;
  blueprint.difficulty_distribution = updates.difficulty_distribution;
  if (updates.selection_rules !== undefined) {
    blueprint.selection_rules = updates.selection_rules;
  }

  await blueprint.save();
  return blueprint;
};

// ─── deleteBlueprint ─────────────────────────────────────────────────
export const deleteBlueprint = async (blueprintId) => {
  const blueprint = await findByBlueprintId(blueprintId);

  if (blueprint.is_active) {
    throw new ApiError(
      409,
      'Cannot delete the active blueprint — activate another one first'
    );
  }

  await blueprint.deleteOne();
  return blueprint;
};

// ─── setActive ───────────────────────────────────────────────────────
// TRANSACTION FOLLOW-UP: this is a two-step deactivate-then-activate
// rather than a single atomic Mongo transaction. A standalone MongoDB
// deployment (no replica set) can't run multi-document transactions,
// which is the likely dev/local setup at this stage — hardening this
// into a proper session-based transaction once the deployment target
// supports it is flagged as follow-up work, not done here. The DB
// partial unique index from Prompt 53 is the actual safety net against
// a race condition landing two active blueprints for the same exam;
// this two-step sequence is the application-layer half of "belt and
// suspenders", not the sole guarantee.
export const setActive = async (blueprintId) => {
  const target = await findByBlueprintId(blueprintId);

  await Blueprint.updateMany(
    { exam_id: target.exam_id, is_active: true },
    { $set: { is_active: false } }
  );

  target.is_active = true;
  await target.save();

  return target;
};

// ─── listByExam ──────────────────────────────────────────────────────
export const listByExam = async (examId) => {
  return Blueprint.find({ exam_id: examId }).sort({ version: 1, created_at: 1 }).lean();
};
