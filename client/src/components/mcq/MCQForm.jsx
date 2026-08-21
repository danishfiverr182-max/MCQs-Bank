import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import MCQCard from '@/components/mcq/MCQCard';

// ─── Client-side mirror of the server's createMcqSchema body ──────
// (server/src/validators/mcq.validator.js). Kept in sync manually —
// the server remains the source of truth and re-validates on submit.
const answerEnum = z.enum(['A', 'B', 'C', 'D'], {
  errorMap: () => ({ message: 'Select the correct answer' }),
});
const difficultyEnum = z.enum(['easy', 'medium', 'hard'], {
  errorMap: () => ({ message: 'Select a difficulty' }),
});
const cognitiveEnum = z.enum(['recall', 'understanding', 'application', 'analysis']);
const statusEnum = z.enum(['pending', 'approved', 'rejected']);

const mcqFormSchema = z.object({
  question: z.string().trim().min(5, 'Question must be at least 5 characters'),
  options: z.object({
    A: z.string().trim().min(1, 'Option A is required'),
    B: z.string().trim().min(1, 'Option B is required'),
    C: z.string().trim().min(1, 'Option C is required'),
    D: z.string().trim().min(1, 'Option D is required'),
  }),
  correct_answer: answerEnum,
  subject: z.string().trim().min(1, 'Subject is required'),
  topic: z.string().trim().optional().default(''),
  subtopic: z.string().trim().optional().default(''),
  difficulty: difficultyEnum,
  exam_tags: z.string().optional().default(''), // comma-separated text input; parsed to array on submit
  cognitive_level: cognitiveEnum.default('recall'),
  quality_score: z.coerce.number().min(0).max(100).default(50),
  status: statusEnum.default('pending'),
});

const OPTION_KEYS = ['A', 'B', 'C', 'D'];

const EMPTY_DEFAULTS = {
  question: '',
  options: { A: '', B: '', C: '', D: '' },
  correct_answer: undefined,
  subject: '',
  topic: '',
  subtopic: '',
  difficulty: '',
  exam_tags: '',
  cognitive_level: 'recall',
  quality_score: 50,
  status: 'pending',
};

// Server MCQ documents carry exam_tags as an array — this form works
// with a comma-separated string internally, so we convert on the way in.
const toFormValues = (mcq) => {
  if (!mcq) return EMPTY_DEFAULTS;
  return {
    question: mcq.question ?? '',
    options: {
      A: mcq.options?.A ?? '',
      B: mcq.options?.B ?? '',
      C: mcq.options?.C ?? '',
      D: mcq.options?.D ?? '',
    },
    correct_answer: mcq.correct_answer ?? undefined,
    subject: mcq.subject ?? '',
    topic: mcq.topic ?? '',
    subtopic: mcq.subtopic ?? '',
    difficulty: mcq.difficulty ?? '',
    exam_tags: Array.isArray(mcq.exam_tags) ? mcq.exam_tags.join(', ') : '',
    cognitive_level: mcq.cognitive_level ?? 'recall',
    quality_score: typeof mcq.quality_score === 'number' ? mcq.quality_score : 50,
    status: mcq.status ?? 'pending',
  };
};

/**
 * Shared create/edit form for MCQs. Doesn't know or care whether the
 * caller ends up POSTing or PATCHing — it just calls onSubmit with the
 * transformed payload and reports the result inline via react-hook-form.
 *
 * Props:
 *   initialValues — full MCQ object when editing, null when creating
 *   onSubmit      — async (payload) => void; throwing/rejecting is fine,
 *                    the page wrapper is responsible for catching and
 *                    surfacing server errors
 *   isSubmitting  — bool, disables the submit button and shows a loading label
 */
export default function MCQForm({ initialValues = null, onSubmit, isSubmitting = false }) {
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(mcqFormSchema),
    defaultValues: toFormValues(initialValues),
  });

  const watchedValues = watch();

  // Live preview needs exam_tags as an array and a real undefined (not
  // empty string) correct_answer so MCQCard doesn't falsely highlight
  // an option before one's been chosen.
  const previewMcq = {
    ...watchedValues,
    correct_answer: watchedValues.correct_answer || null,
    exam_tags: watchedValues.exam_tags
      ? watchedValues.exam_tags.split(',').map((t) => t.trim()).filter(Boolean)
      : [],
    question_id: initialValues?.question_id,
  };

  const submitHandler = (formData) => {
    const payload = {
      ...formData,
      exam_tags: formData.exam_tags
        ? formData.exam_tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [],
    };
    return onSubmit(payload);
  };

  const fieldClass =
    'w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
  const labelClass = 'text-sm font-medium text-gray-700';
  const errorClass = 'text-xs text-danger';

  return (
    <div className="grid gap-6 lg:grid-cols-2 items-start">
      {/* ── Form ─────────────────────────────────────────────── */}
      <form onSubmit={handleSubmit(submitHandler)} className="card space-y-5" noValidate>
        {/* Question */}
        <div className="space-y-1">
          <label htmlFor="question" className={labelClass}>
            Question
          </label>
          <textarea
            id="question"
            rows={3}
            className={fieldClass}
            {...register('question')}
          />
          {errors.question && <p className={errorClass}>{errors.question.message}</p>}
        </div>

        {/* Options A-D with aligned correct-answer radios */}
        <div className="space-y-2">
          <span className={labelClass}>Options</span>
          {OPTION_KEYS.map((key) => (
            <div key={key} className="flex items-start gap-2">
              <label className="flex items-center gap-1.5 pt-2.5 shrink-0">
                <input
                  type="radio"
                  value={key}
                  {...register('correct_answer')}
                  aria-label={`Mark option ${key} as correct`}
                />
                <span className="text-sm font-semibold w-4">{key}</span>
              </label>
              <div className="flex-1 space-y-1">
                <input
                  type="text"
                  placeholder={`Option ${key} text`}
                  className={fieldClass}
                  {...register(`options.${key}`)}
                />
                {errors.options?.[key] && (
                  <p className={errorClass}>{errors.options[key].message}</p>
                )}
              </div>
            </div>
          ))}
          {errors.correct_answer && (
            <p className={errorClass}>{errors.correct_answer.message}</p>
          )}
          <p className="text-xs text-gray-400">
            Select the radio next to the correct option.
          </p>
        </div>

        {/* Subject / Topic / Subtopic */}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1">
            <label htmlFor="subject" className={labelClass}>
              Subject
            </label>
            <input id="subject" type="text" className={fieldClass} {...register('subject')} />
            {errors.subject && <p className={errorClass}>{errors.subject.message}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor="topic" className={labelClass}>
              Topic
            </label>
            <input id="topic" type="text" className={fieldClass} {...register('topic')} />
          </div>
          <div className="space-y-1">
            <label htmlFor="subtopic" className={labelClass}>
              Subtopic
            </label>
            <input id="subtopic" type="text" className={fieldClass} {...register('subtopic')} />
          </div>
        </div>

        {/* Difficulty / Cognitive level */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="difficulty" className={labelClass}>
              Difficulty
            </label>
            <select id="difficulty" className={fieldClass} {...register('difficulty')}>
              <option value="">Select…</option>
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
            {errors.difficulty && <p className={errorClass}>{errors.difficulty.message}</p>}
          </div>
          <div className="space-y-1">
            <label htmlFor="cognitive_level" className={labelClass}>
              Cognitive level
            </label>
            <select id="cognitive_level" className={fieldClass} {...register('cognitive_level')}>
              <option value="recall">Recall</option>
              <option value="understanding">Understanding</option>
              <option value="application">Application</option>
              <option value="analysis">Analysis</option>
            </select>
          </div>
        </div>

        {/* Exam tags */}
        <div className="space-y-1">
          <label htmlFor="exam_tags" className={labelClass}>
            Exam tags
          </label>
          <input
            id="exam_tags"
            type="text"
            placeholder="e.g. MOD, FPSC, Intelligence"
            className={fieldClass}
            {...register('exam_tags')}
          />
          <p className="text-xs text-gray-400">Comma-separated.</p>
        </div>

        {/* Quality score / Status */}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <label htmlFor="quality_score" className={labelClass}>
              Quality score ({watchedValues.quality_score ?? 0})
            </label>
            <input
              id="quality_score"
              type="range"
              min={0}
              max={100}
              className="w-full"
              {...register('quality_score', { valueAsNumber: true })}
            />
            {errors.quality_score && (
              <p className={errorClass}>{errors.quality_score.message}</p>
            )}
          </div>
          <div className="space-y-1">
            <label htmlFor="status" className={labelClass}>
              Status
            </label>
            <select id="status" className={fieldClass} {...register('status')}>
              <option value="pending">Pending</option>
              <option value="approved">Approved</option>
              <option value="rejected">Rejected</option>
            </select>
          </div>
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : initialValues ? 'Save changes' : 'Create MCQ'}
        </Button>
      </form>

      {/* ── Live preview ─────────────────────────────────────── */}
      <div className="space-y-2 lg:sticky lg:top-6">
        <span className="text-xs font-medium uppercase tracking-wider text-gray-400">
          Live preview
        </span>
        <MCQCard mcq={previewMcq} />
      </div>
    </div>
  );
}
