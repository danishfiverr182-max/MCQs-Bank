import PDFDocument from 'pdfkit';
import asyncHandler from '../utils/asyncHandler.js';
import ApiError from '../utils/ApiError.js';
import ApiResponse from '../utils/ApiResponse.js';
import { logger } from '../utils/logger.js';
import { buildCSV } from '../utils/csvBuilder.js';
import { hashContentFingerprint } from '../utils/duplicateDetector.js';
import * as generatorService from '../services/generator.service.js';
import * as blueprintService from '../services/blueprint.service.js';
import * as examService from '../services/exam.service.js';
import * as analyticsService from '../services/analytics.service.js';
import QAReport from '../models/QAReport.js';

// report.controller.js — Prompt 96. The test export pipeline: JSON, CSV,
// print-ready PDF, and a blueprint compliance report. The three file
// exports are deliberately raw streamed downloads (Content-Disposition:
// attachment), NOT wrapped in ApiResponse — the whole point of a file
// export is that the file IS the payload, not JSON describing one.
// generateBlueprintReport is the one endpoint in this file that stays a
// normal ApiResponse, since it's meant to be read on-screen, not
// downloaded.
//
// All three file exports reuse generator.service.js's
// getGeneratedTestWithQuestions as the single source of truth for
// "what does this test's content actually look like right now" — the
// same resolver GeneratedTest.jsx's detail view already uses (Phase 6/8
// convention: content is always resolved live from MCQ by mcq_id, never
// from a stale embedded snapshot). It also already throws ApiError(404)
// for an unknown testId, which is exactly the "clean 404 JSON error, not
// a broken/empty file" behavior the DoD asks for — nothing extra needed
// here for that case, since asyncHandler forwards the throw to
// errorHandler before any response has been written.

// ─── loadExamAndBlueprintSafely ────────────────────────────────────
// Best-effort metadata lookup for the JSON export. An exam or blueprint
// referenced by an older test may since have been edited or (rarely)
// removed — that shouldn't turn a still-valid test export into a 404.
// Returns null for whichever side can't be resolved rather than
// throwing, so the export always succeeds if the test itself exists.
const loadExamAndBlueprintSafely = async (examId, blueprintId) => {
  const [exam, blueprint] = await Promise.all([
    examService.findByExamId(examId).catch(() => null),
    blueprintService.findByBlueprintId(blueprintId).catch(() => null),
  ]);
  return { exam, blueprint };
};

// ─── exportTestJSON ─────────────────────────────────────────────────
// GET /api/reports/test/:testId/json
export const exportTestJSON = asyncHandler(async (req, res) => {
  const { testId } = req.params;

  const test = await generatorService.getGeneratedTestWithQuestions(testId); // throws 404 upstream

  const [{ exam, blueprint }, latestQAReport] = await Promise.all([
    loadExamAndBlueprintSafely(test.exam_id, test.blueprint_id),
    test.latest_qa_report_id
      ? QAReport.findOne({ report_id: test.latest_qa_report_id }).lean()
      : Promise.resolve(null),
  ]);

  const payload = {
    ...test,
    exam,
    blueprint,
    latest_qa_report: latestQAReport,
  };

  logger.info(`Exporting test ${testId} as JSON`);

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${test.test_id}.json"`);
  // Raw file payload — deliberately NOT ApiResponse-wrapped (see file header note).
  res.status(200).send(JSON.stringify(payload, null, 2));
});

// ─── exportTestWebsiteImport ────────────────────────────────────────
// GET /api/reports/test/:testId/website-import
//
// Transforms a generated test into the EXACT shape the destination
// website's own JSON importer expects — a bare array of:
//   { question, options: ["A) ...", "B) ...", "C) ...", "D) ..."],
//     correctAnswer: "A", explanation: "..." }
// This is deliberately a different shape from exportTestJSON above:
// that one is a faithful internal snapshot (mcq_id/subject/difficulty/
// topic included) meant for this system's own records; this one is
// meant to be fed straight into a different system that only
// understands its own format and would reject anything else.
//
// Two defensive steps happen here, not just a field remap:
//   1. De-dupe by normalized question text (same hash used at import
//      time). generator.service.js's mergeAndDeduplicate now also
//      dedupes on text going forward, but a test generated BEFORE that
//      fix can still have baked-in text duplicates — this catches
//      those too so a duplicate is never shipped to the destination
//      site even from an older test record. Kept ones are whichever
//      occurrence came first; dropped ones are logged.
//   2. A fresh Fisher-Yates shuffle of the final order, independent of
//      whatever order the test happened to persist in.
//
// NOTE: `explanation` has no real data behind it yet anywhere in this
// system (see MCQ.js) — it's included for shape-compatibility and will
// be an empty string until MCQs are imported/edited with real
// explanations.
const shuffle = (array) => {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
};

// NOTE: OPTION_LETTERS is declared once, further down this file
// (originally added for exportTestPDF) — reused here rather than
// redeclared, since `const` doesn't allow two bindings of the same
// name in one module scope. Both this function and exportTestPDF
// reference that single shared declaration.

export const exportTestWebsiteImport = asyncHandler(async (req, res) => {
  const { testId } = req.params;

  const test = await generatorService.getGeneratedTestWithQuestions(testId); // throws 404 upstream

  const seenHashes = new Set();
  let duplicatesDropped = 0;

  // BUGFIX: was hashing question TEXT alone, so two genuinely different
  // questions sharing an identical/templated stem (different options,
  // different correct answer — see duplicateDetector.js's
  // buildContentFingerprint comment for the canonical example) got
  // treated as the same question and one was silently dropped from the
  // export. Uses the same full content fingerprint (question + options
  // + correct answer) as the import-time duplicate detector now does,
  // via getGeneratedTestWithQuestions' select() which already includes
  // options/correct_answer for this export.
  const deduped = test.questions.filter((q) => {
    if (q.question_unavailable) return false; // deleted MCQ — can't export content that no longer exists
    const hash = hashContentFingerprint(q.question, q.options, q.correct_answer);
    if (seenHashes.has(hash)) {
      duplicatesDropped += 1;
      return false;
    }
    seenHashes.add(hash);
    return true;
  });

  if (duplicatesDropped > 0) {
    logger.warn(
      `Test ${testId}: dropped ${duplicatesDropped} duplicate question(s) by text during website-import export`
    );
  }

  const shuffled = shuffle(deduped);

  const payload = shuffled.map((q) => ({
    question: q.question,
    options: OPTION_LETTERS.map((letter) => `${letter}) ${q.options?.[letter] ?? ''}`),
    correctAnswer: q.correct_answer,
    explanation: q.explanation || '',
  }));

  logger.info(
    `Exporting test ${testId} for website import (${payload.length} question(s)` +
      `${duplicatesDropped > 0 ? `, ${duplicatesDropped} duplicate(s) dropped` : ''})`
  );

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${test.test_id}_website_import.json"`);
  res.setHeader('X-Duplicates-Dropped', String(duplicatesDropped));
  res.setHeader('X-Final-Question-Count', String(payload.length));
  // Raw array payload, deliberately NOT ApiResponse-wrapped and NOT
  // matching this system's own internal question shape — the whole
  // point is that it must be exactly what the destination site's
  // importer expects, nothing more.
  res.status(200).send(JSON.stringify(payload, null, 2));
});

// ─── exportTestCSV ──────────────────────────────────────────────────
// GET /api/reports/test/:testId/csv
const CSV_COLUMNS = [
  { key: 'question_id', header: 'Question ID' },
  { key: 'question', header: 'Question' },
  { key: 'option_a', header: 'Option A' },
  { key: 'option_b', header: 'Option B' },
  { key: 'option_c', header: 'Option C' },
  { key: 'option_d', header: 'Option D' },
  { key: 'correct_answer', header: 'Correct Answer' },
  { key: 'subject', header: 'Subject' },
  { key: 'topic', header: 'Topic' },
  { key: 'difficulty', header: 'Difficulty' },
];

export const exportTestCSV = asyncHandler(async (req, res) => {
  const { testId } = req.params;

  const test = await generatorService.getGeneratedTestWithQuestions(testId); // throws 404 upstream

  const rows = test.questions.map((q) => ({
    question_id: q.mcq_id,
    question: q.question_unavailable ? '[Question no longer available]' : q.question,
    option_a: q.options?.A ?? '',
    option_b: q.options?.B ?? '',
    option_c: q.options?.C ?? '',
    option_d: q.options?.D ?? '',
    correct_answer: q.correct_answer ?? '',
    subject: q.subject,
    topic: q.topic ?? '',
    difficulty: q.difficulty,
  }));

  const csv = buildCSV(rows, CSV_COLUMNS);

  logger.info(`Exporting test ${testId} as CSV (${rows.length} rows)`);

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${test.test_id}.csv"`);
  res.status(200).send(csv);
});

// ─── exportTestPDF ────────────────────────────────────────────────────
// GET /api/reports/test/:testId/pdf
// A print-ready exam paper: numbered questions, lettered A-D options,
// a header block with blank candidate fields, and a separate answer
// key as the final page. pdfkit handles page breaks itself as content
// overflows — this never hand-calculates a Y-position against a page
// height, it just keeps writing and lets pdfkit paginate.
//
// Everything that can fail (loading the test, resolving questions) is
// done BEFORE the PDFDocument is created and piped to `res` — headers
// can't be changed and a stream can't be "un-started" once bytes have
// gone out, so any error found after that point could only ever produce
// a broken, truncated download. Keeping all fallible work up front means
// a failure here always surfaces as a clean ApiError JSON response
// instead.
const PAGE_MARGIN = 50;

const drawExamHeader = (doc, exam, test) => {
  doc
    .fontSize(18)
    .font('Helvetica-Bold')
    .text(exam?.exam_name || test.exam_id, { align: 'center' });

  doc.moveDown(0.3);
  doc
    .fontSize(10)
    .font('Helvetica')
    .text(`Test ID: ${test.test_id}`, { align: 'center' })
    .text(`Total Questions: ${test.question_count}`, { align: 'center' })
    .text(`Date: ${new Date().toLocaleDateString()}`, { align: 'center' });

  doc.moveDown(1);
  doc
    .fontSize(11)
    .text('Candidate Name: ______________________________', PAGE_MARGIN)
    .moveDown(0.5)
    .text('Roll Number: ______________________________', PAGE_MARGIN);

  doc.moveDown(0.5);
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .strokeColor('#999999')
    .stroke();
  doc.moveDown(1);
};

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

const drawQuestions = (doc, questions) => {
  questions.forEach((q, index) => {
    // pdfkit auto-paginates as content overflows the page — no manual
    // page-break math here. addPage() is only called explicitly further
    // down, to force the answer key onto its own page.
    doc
      .fontSize(11)
      .font('Helvetica-Bold')
      .text(`${index + 1}. ${q.question_unavailable ? '[Question no longer available]' : q.question}`, {
        width: doc.page.width - PAGE_MARGIN * 2,
      });

    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(10);

    if (!q.question_unavailable) {
      OPTION_LETTERS.forEach((letter) => {
        doc.text(`   ${letter}.  ${q.options?.[letter] ?? ''}`, {
          width: doc.page.width - PAGE_MARGIN * 2,
        });
      });
    }

    doc.moveDown(1);
  });
};

const drawAnswerKey = (doc, questions) => {
  doc.addPage();
  doc
    .fontSize(16)
    .font('Helvetica-Bold')
    .text('ANSWER KEY', { align: 'center' });
  doc.moveDown(0.3);
  doc
    .fontSize(9)
    .font('Helvetica-Oblique')
    .text('Tear off or omit this page before distributing to candidates.', {
      align: 'center',
    });
  doc.moveDown(1);

  doc.font('Helvetica').fontSize(11);
  questions.forEach((q, index) => {
    const answer = q.question_unavailable ? '—' : q.correct_answer;
    doc.text(`${index + 1}.  ${answer}`);
  });
};

export const exportTestPDF = asyncHandler(async (req, res) => {
  const { testId } = req.params;

  // Everything that can throw happens here, before any streaming starts.
  const test = await generatorService.getGeneratedTestWithQuestions(testId); // throws 404 upstream
  const { exam } = await loadExamAndBlueprintSafely(test.exam_id, test.blueprint_id);

  let doc;
  try {
    doc = new PDFDocument({ margin: PAGE_MARGIN, size: 'A4', bufferPages: true });
  } catch (err) {
    logger.error(`Failed to initialize PDF document for test ${testId}`, err);
    throw new ApiError(500, 'Failed to generate PDF export');
  }

  logger.info(`Exporting test ${testId} as PDF (${test.questions.length} questions)`);

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${test.test_id}.pdf"`);

  doc.pipe(res);

  try {
    drawExamHeader(doc, exam, test);
    drawQuestions(doc, test.questions);
    drawAnswerKey(doc, test.questions);
  } catch (err) {
    // At this point headers/streaming have already started, so we can't
    // fall back to a JSON ApiError response — the best we can do is stop
    // writing and let the client see a truncated/aborted download rather
    // than hang. This branch should be effectively unreachable given the
    // synchronous, well-formed draw calls above; it exists purely as a
    // safety net.
    logger.error(`PDF generation failed mid-stream for test ${testId}`, err);
    doc.end();
    return;
  }

  doc.end();
});

// ─── generateBlueprintReport ──────────────────────────────────────────
// GET /api/reports/blueprint/:blueprintId
// NOT a file download — a normal ApiResponse. Thin composition of
// analytics.service.js's subjectCoveragePercent (Phase 9) with the
// blueprint's own metadata, answering "is this blueprint currently
// generatable from the existing MCQ pool, and where are the gaps."
export const generateBlueprintReport = asyncHandler(async (req, res) => {
  const { blueprintId } = req.params;

  const blueprint = await blueprintService.findByBlueprintId(blueprintId); // throws 404 upstream
  const coverage = await analyticsService.subjectCoveragePercent(blueprintId);

  const overallGeneratable = coverage.every((c) => c.available >= c.required);

  return res.status(200).json(
    new ApiResponse(
      200,
      { blueprint, coverage, overallGeneratable },
      'Blueprint compliance report generated'
    )
  );
});
