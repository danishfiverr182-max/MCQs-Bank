import mongoose from 'mongoose';
import Exam from '../models/Exam.js';
import ApiError from '../utils/ApiError.js';

// ─── exam_id derivation ─────────────────────────────────────────────
// "MOD" + "Sub Inspector" -> "MOD_SUB_INSPECTOR"
// Strips anything that isn't A-Z/0-9, collapses whitespace runs into a
// single underscore, then joins org_name with an underscore.
const slugifyPart = (value) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');

const buildBaseExamId = (organization, examName) =>
  `${slugifyPart(organization)}_${slugifyPart(examName)}`;

// Exam names can legitimately collide across similar postings (e.g. two
// different "Sub Inspector" postings under MOD in different years), so
// on collision we append a numeric suffix instead of failing outright.
const generateUniqueExamId = async (organization, examName) => {
  const base = buildBaseExamId(organization, examName);

  let candidate = base;
  let suffix = 2;
  // eslint-disable-next-line no-await-in-loop
  while (await Exam.exists({ exam_id: candidate })) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }

  return candidate;
};

// ─── Create ──────────────────────────────────────────────────────
export const createExam = async ({ exam_name, organization, description, tags }) => {
  const normalizedOrg = organization.trim().toUpperCase();
  const exam_id = await generateUniqueExamId(normalizedOrg, exam_name);

  const exam = await Exam.create({
    exam_id,
    exam_name,
    organization: normalizedOrg,
    description,
    tags,
  });

  return exam;
};

// ─── Get single ──────────────────────────────────────────────────
export const findByExamId = async (examId) => {
  const exam = await Exam.findOne({ exam_id: examId.toUpperCase() });

  if (!exam) {
    throw new ApiError(404, `Exam not found: ${examId}`);
  }

  return exam;
};

// ─── Update ──────────────────────────────────────────────────────
export const updateExam = async (examId, updates) => {
  if (Object.prototype.hasOwnProperty.call(updates, 'exam_id')) {
    throw new ApiError(400, 'exam_id cannot be changed after creation');
  }

  const exam = await findByExamId(examId);

  Object.assign(exam, updates);
  await exam.save();

  return exam;
};

// ─── Delete ──────────────────────────────────────────────────────
// Blueprint doesn't exist yet as of Prompt 52 (arrives in Phase 5's
// later prompts). We look the model up dynamically via the mongoose
// registry rather than importing it directly, so this file has zero
// hard dependency on Blueprint and doesn't crash before it exists.
// Once Blueprint.js is created, this check activates automatically —
// no changes needed here.
export const deleteExam = async (examId) => {
  const exam = await findByExamId(examId);

  if (mongoose.modelNames().includes('Blueprint')) {
    const Blueprint = mongoose.model('Blueprint');
    const blueprintCount = await Blueprint.countDocuments({ exam_id: exam.exam_id });

    if (blueprintCount > 0) {
      throw new ApiError(
        409,
        'Cannot delete an exam with existing blueprints — delete or reassign its blueprints first'
      );
    }
  }

  await exam.deleteOne();

  return exam;
};

// ─── Toggle status ─────────────────────────────────────────────────
export const toggleStatus = async (examId) => {
  const exam = await findByExamId(examId);

  exam.status = exam.status === 'active' ? 'inactive' : 'active';
  await exam.save();

  return exam;
};

// ─── List, grouped by organization ─────────────────────────────────
// Shape: { MOD: [...], KPPSC: [...], ... } — orgs alphabetical, exams
// within each org sorted by exam_name. Matches ExamList.jsx exactly so
// no client-side regrouping is needed.
export const listGroupedByOrg = async (statusFilter) => {
  const query = statusFilter ? { status: statusFilter } : {};

  const exams = await Exam.find(query).sort({ organization: 1, exam_name: 1 }).lean();

  const grouped = {};
  for (const exam of exams) {
    if (!grouped[exam.organization]) {
      grouped[exam.organization] = [];
    }
    grouped[exam.organization].push(exam);
  }

  // Re-key alphabetically — insertion order above already tracks the
  // sorted query, but this guards against any future query changes.
  return Object.keys(grouped)
    .sort()
    .reduce((acc, org) => {
      acc[org] = grouped[org];
      return acc;
    }, {});
};
