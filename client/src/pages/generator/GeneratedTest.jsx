import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import TestStats from '@/components/generator/TestStats';
import QABadge from '@/components/qa/QABadge';

// Same static badge classes as elsewhere in the app (DifficultySlider.jsx
// / BlueprintDetail.jsx's segment coloring) — restated as a literal
// lookup object rather than building the class name with a template
// string, since Tailwind's content scanner only picks up class names it
// can see written out in full; `bg-${difficulty}-light` would never be
// generated into the CSS bundle.
const DIFFICULTY_BADGE_CLASSES = {
  easy: 'bg-easy-light text-easy-text',
  medium: 'bg-medium-light text-medium-text',
  hard: 'bg-hard-light text-hard-text',
};

const OPTION_KEYS = ['A', 'B', 'C', 'D'];

function DifficultyBadge({ difficulty }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide ${
        DIFFICULTY_BADGE_CLASSES[difficulty] || 'bg-gray-100 text-gray-500'
      }`}
    >
      {difficulty}
    </span>
  );
}

// Minimal client-side mirror of the fields updateMcqSchema actually
// requires for a question/options/correct_answer-only PATCH — the
// server re-validates regardless, this just avoids a round trip for
// the obvious cases (empty option, no answer selected).
function validateEdit(draft) {
  const errors = {};
  if (!draft.question.trim() || draft.question.trim().length < 5) {
    errors.question = 'Question must be at least 5 characters';
  }
  OPTION_KEYS.forEach((key) => {
    if (!draft.options[key].trim()) errors[`option_${key}`] = `Option ${key} is required`;
  });
  if (!draft.correct_answer) errors.correct_answer = 'Select the correct answer';
  return errors;
}

// ─── Edit mode ("Editable Generated Tests") ────────────────────────
// Scoped deliberately narrow — question text, 4 options, correct
// answer — NOT the full MCQForm.jsx create/edit form (subject, topic,
// difficulty, quality_score, status, etc.). Those taxonomy/metadata
// fields are already editable from the main MCQ Bank (client/src/pages/
// mcq/EditMCQ.jsx) where they make sense; surfacing them here, on a
// specific already-generated test, would invite confusion given
// generator.service.js's getGeneratedTestWithQuestions deliberately
// freezes THIS test's own subject/topic/subtopic/difficulty display to
// what they were at generation time (see that function's header
// comment) — editing them from here would silently do nothing to this
// test's own display while still affecting future generations, which
// is correct but not obvious without that context. Question content
// (text/options/answer), by contrast, is explicitly documented there as
// "resolved live... since corrections to those SHOULD be reflected
// immediately" — this UI is what finally makes that possible.
//
// Saves go straight to PATCH /mcqs/:mcq_id (the same MCQ Bank edit
// endpoint EditMCQ.jsx uses) — there's no test-scoped "local override"
// of a question's content. That's the whole point: fixing a typo here
// fixes the master MCQ record, so every OTHER test — past exports
// already generated and every future one — reflects the correction too,
// rather than needing to be caught and re-fixed each time it resurfaces.
function QuestionCard({ question, index, showAnswers, onSaved }) {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errors, setErrors] = useState({});
  const [draft, setDraft] = useState(null);

  const startEditing = () => {
    setDraft({
      question: question.question,
      options: { ...question.options },
      correct_answer: question.correct_answer,
    });
    setErrors({});
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setDraft(null);
    setErrors({});
  };

  const handleSave = async () => {
    const validationErrors = validateEdit(draft);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      return;
    }
    setIsSaving(true);
    try {
      const payload = {
        question: draft.question.trim(),
        options: {
          A: draft.options.A.trim(),
          B: draft.options.B.trim(),
          C: draft.options.C.trim(),
          D: draft.options.D.trim(),
        },
        correct_answer: draft.correct_answer,
      };
      // mcq_id here is the human-readable question_id (e.g.
      // "MCQ-000123"), not a Mongo _id — getGeneratedTestWithQuestions
      // never exposes the latter. Requires mcq.service.js's updateMcq
      // to accept either identifier (see that function's own comment).
      await apiClient.patch(`/mcqs/${question.mcq_id}`, payload);
      toast.success(`${question.mcq_id} updated`);
      onSaved(question.mcq_id, payload);
      setIsEditing(false);
      setDraft(null);
    } catch (err) {
      toast.error(handleApiError(err) || 'Failed to save changes');
    } finally {
      setIsSaving(false);
    }
  };

  if (question.question_unavailable) {
    return (
      <div className="card space-y-2 border-dashed">
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium text-gray-400">Q{index}</span>
          <DifficultyBadge difficulty={question.difficulty} />
        </div>
        <p className="text-sm text-gray-500 italic">
          This question is no longer available in the question bank.
        </p>
        <p className="text-xs font-mono text-gray-300">{question.mcq_id}</p>
      </div>
    );
  }

  if (isEditing) {
    const fieldClass =
      'w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
    const errorClass = 'text-xs text-danger';

    return (
      <div className="card space-y-3 ring-1 ring-primary-200">
        <div className="flex items-start justify-between gap-3">
          <span className="text-sm font-medium text-gray-400">Q{index}</span>
          <DifficultyBadge difficulty={question.difficulty} />
        </div>

        <div className="space-y-1">
          <textarea
            rows={3}
            className={fieldClass}
            value={draft.question}
            onChange={(e) => setDraft((d) => ({ ...d, question: e.target.value }))}
          />
          {errors.question && <p className={errorClass}>{errors.question}</p>}
        </div>

        <div className="space-y-2">
          {OPTION_KEYS.map((key) => (
            <div key={key} className="flex items-start gap-2">
              <label className="flex items-center gap-1.5 pt-2.5 shrink-0">
                <input
                  type="radio"
                  checked={draft.correct_answer === key}
                  onChange={() => setDraft((d) => ({ ...d, correct_answer: key }))}
                  aria-label={`Mark option ${key} as correct`}
                />
                <span className="text-sm font-semibold w-4">{key}</span>
              </label>
              <div className="flex-1 space-y-1">
                <input
                  type="text"
                  className={fieldClass}
                  value={draft.options[key]}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, options: { ...d.options, [key]: e.target.value } }))
                  }
                />
                {errors[`option_${key}`] && <p className={errorClass}>{errors[`option_${key}`]}</p>}
              </div>
            </div>
          ))}
          {errors.correct_answer && <p className={errorClass}>{errors.correct_answer}</p>}
        </div>

        <div className="flex items-center gap-2">
          <Button type="button" onClick={handleSave} disabled={isSaving}>
            {isSaving ? 'Saving…' : 'Save changes'}
          </Button>
          <Button type="button" variant="outline" onClick={cancelEditing} disabled={isSaving}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="card space-y-3">
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-medium text-gray-400">Q{index}</span>
        <div className="flex items-center gap-3">
          <DifficultyBadge difficulty={question.difficulty} />
          <button
            type="button"
            onClick={startEditing}
            className="text-xs font-medium text-primary-600 hover:underline"
          >
            Edit
          </button>
        </div>
      </div>

      <p className="text-sm text-gray-900">{question.question}</p>

      <div className="grid gap-2 sm:grid-cols-2">
        {OPTION_KEYS.map((key) => {
          const isCorrect = showAnswers && key === question.correct_answer;
          return (
            <div
              key={key}
              className={`rounded-md border px-3 py-2 text-sm ${
                isCorrect
                  ? 'border-success bg-success-light text-success-dark font-medium'
                  : 'border-surface-border text-gray-700'
              }`}
            >
              <span className="font-semibold mr-1.5">{key}.</span>
              {question.options?.[key]}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function GeneratedTest() {
  const { testId } = useParams();

  const [test, setTest] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  // Best-effort parent exam name — same graceful-degradation pattern as
  // BlueprintDetail.jsx's own second lookup, since GeneratedTest only
  // stores exam_id (a string reference), not an embedded exam document.
  const [examName, setExamName] = useState(null);

  const [showAnswers, setShowAnswers] = useState(false);

  const fetchTest = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/generator/${testId}`);
      setTest(response.data.data.test);
    } catch (err) {
      setError(handleApiError(err) || 'Test not found');
    } finally {
      setIsLoading(false);
    }
  }, [testId]);

  useEffect(() => {
    fetchTest();
  }, [fetchTest]);

  useEffect(() => {
    if (!test?.exam_id) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const response = await apiClient.get(`/exams/${test.exam_id}`);
        if (!cancelled) setExamName(response.data.data.exam?.exam_name || null);
      } catch {
        if (!cancelled) setExamName(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [test?.exam_id]);

  // Merges a saved edit into local state in place, matched by mcq_id —
  // avoids a full re-fetch (which for a large test means re-resolving
  // every question's MCQ join again) just to reflect the one row that
  // actually changed. Same shallow-merge-by-id pattern TestStats/
  // groupedBySubject already assume `test.questions` entries have.
  const handleQuestionSaved = useCallback((mcqId, updates) => {
    setTest((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        questions: prev.questions.map((q) => (q.mcq_id === mcqId ? { ...q, ...updates } : q)),
      };
    });
  }, []);

  // Grouped in first-seen order (mirrors the blueprint's own subject
  // ordering, since that's the order Prompt 65's generator wrote the
  // question stubs in) rather than alphabetically re-sorting them.
  const groupedBySubject = useMemo(() => {
    const groups = new Map();
    (test?.questions || []).forEach((q) => {
      if (!groups.has(q.subject)) groups.set(q.subject, []);
      groups.get(q.subject).push(q);
    });
    return Array.from(groups.entries());
  }, [test?.questions]);

  // Downloads exactly the object this page fetched — the API response
  // already is the system spec's test export shape, so no client-side
  // reshaping happens here; this is a pure Blob/URL.createObjectURL
  // download, no backend export endpoint involved.
  const handleDownloadJson = () => {
    if (!test) return;
    const blob = new Blob([JSON.stringify(test, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${test.test_id}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  if (!test) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{error || 'Test not found'}</p>
        <Link to="/admin/exams" className="text-sm text-primary-600 hover:underline">
          Back to exams
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-4xl space-y-6">
      {/* Header */}
      <div className="card space-y-3">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-1">
            <h1 className="section-title font-mono">{test.test_id}</h1>
            <p className="text-sm text-gray-500">
              Exam:{' '}
              <Link
                to={`/admin/exams/${test.exam_id}`}
                className="text-primary-600 hover:underline"
              >
                {examName || test.exam_id}
              </Link>
            </p>
            <p className="text-xs text-gray-400">
              Generated {test.generated_at ? new Date(test.generated_at).toLocaleString() : '—'}
              {test.generated_by ? ` by ${test.generated_by}` : ''}
            </p>
            <div className="flex items-center gap-3 pt-1">
              {/* Prompt 90: denormalized on GeneratedTest since Prompt 85 —
                  no extra fetch needed to show this here. */}
              <QABadge status={test.latest_qa_status} size="sm" />
              <Link
                to={`/admin/qa/report/${test.test_id}`}
                className="text-sm text-primary-600 hover:underline"
              >
                View QA Report →
              </Link>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" onClick={handleDownloadJson}>
              Download JSON
            </Button>
            {/* Website-import format (Prompt 108) — a DIFFERENT shape from
                "Download JSON" above: options as a lettered string array,
                correctAnswer/explanation keys, no mcq_id/subject/difficulty/
                topic. Built server-side (report.controller.js) since it also
                de-dupes by question text and re-shuffles order, neither of
                which the client-side blob above does. */}
            <a
              href={`/api/reports/test/${test.test_id}/website-import`}
              className="inline-flex items-center justify-center h-10 px-4 py-2 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Export for Website Import
            </a>
            {/* Prompt 100: CSV/PDF now come from the real backend export
                pipeline (report.controller.js, Prompt 96) rather than a
                client-side reshape — plain <a> downloads work here
                because auth is cookie-based (verifyJWT checks
                req.cookies.accessToken first), so the browser attaches
                the httpOnly cookie to these requests same as any other
                same-origin navigation, no fetch+blob dance required. */}
            <a
              href={`/api/reports/test/${test.test_id}/csv`}
              className="inline-flex items-center justify-center h-10 px-4 py-2 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Download CSV
            </a>
            <a
              href={`/api/reports/test/${test.test_id}/pdf`}
              className="inline-flex items-center justify-center h-10 px-4 py-2 rounded-md text-sm font-medium border border-input bg-background hover:bg-accent hover:text-accent-foreground transition-colors"
            >
              Print / Download PDF
            </a>
          </div>
        </div>

        <p className="text-sm text-gray-600">
          {test.question_count} question{test.question_count === 1 ? '' : 's'}
        </p>
      </div>

      {/* Stats */}
      <div className="card space-y-3">
        <h2 className="text-sm font-semibold text-gray-800">Test composition</h2>
        <TestStats questions={test.questions} />
      </div>

      {/* Question list */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Questions</h2>
          <label className="flex items-center gap-2 text-sm text-gray-600 select-none">
            <input
              type="checkbox"
              checked={showAnswers}
              onChange={(e) => setShowAnswers(e.target.checked)}
            />
            Show Correct Answers
          </label>
        </div>

        {groupedBySubject.map(([subject, subjectQuestions]) => (
          <div key={subject} className="space-y-3">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-400 border-b border-surface-border pb-1">
              {subject} · {subjectQuestions.length} question{subjectQuestions.length === 1 ? '' : 's'}
            </h3>
            <div className="space-y-3">
              {subjectQuestions.map((q, i) => (
                <QuestionCard
                  key={`${subject}-${q.mcq_id}-${i}`}
                  question={q}
                  index={i + 1}
                  showAnswers={showAnswers}
                  onSaved={handleQuestionSaved}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
