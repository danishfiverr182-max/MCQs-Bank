import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';

// ─── Client-side mirror of the server's updateExamSchema body ──────
// (server/src/validators/exam.validator.js) — exam_id is intentionally
// absent, it's never sent from this form.
const editExamSchema = z.object({
  organization: z.string().trim().min(2, 'organization must be at least 2 characters'),
  exam_name: z.string().trim().min(3, 'exam_name must be at least 3 characters'),
  description: z.string().trim().optional().default(''),
  tags: z.string().optional().default(''), // comma-separated text input; parsed to array on submit
  status: z.enum(['active', 'inactive']),
});

const toFormValues = (exam) => ({
  organization: exam?.organization ?? '',
  exam_name: exam?.exam_name ?? '',
  description: exam?.description ?? '',
  tags: Array.isArray(exam?.tags) ? exam.tags.join(', ') : '',
  status: exam?.status ?? 'active',
});

export default function EditExam() {
  const { examId } = useParams();
  const navigate = useNavigate();

  const [exam, setExam] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(editExamSchema),
    defaultValues: toFormValues(null),
  });

  useEffect(() => {
    let cancelled = false;

    const fetchExam = async () => {
      setIsLoading(true);
      try {
        const response = await apiClient.get(`/exams/${examId}`);
        if (!cancelled) {
          const loadedExam = response.data.data.exam;
          setExam(loadedExam);
          reset(toFormValues(loadedExam));
        }
      } catch (err) {
        if (!cancelled) setServerError('Exam not found');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchExam();
    return () => {
      cancelled = true;
    };
  }, [examId, reset]);

  const watchedOrg = watch('organization');
  const watchedName = watch('exam_name');

  // Only warn once we actually have the original values to compare
  // against — otherwise this would flash true for a beat while the
  // form is still empty during load.
  const identityChanged =
    exam != null && (watchedOrg !== exam.organization || watchedName !== exam.exam_name);

  const onSubmit = async (formData) => {
    setIsSubmitting(true);
    setServerError(null);
    try {
      const payload = {
        organization: formData.organization,
        exam_name: formData.exam_name,
        description: formData.description,
        tags: formData.tags
          ? formData.tags.split(',').map((t) => t.trim()).filter(Boolean)
          : [],
        status: formData.status,
      };
      await apiClient.put(`/exams/${examId}`, payload);
      navigate('/admin/exams', { state: { toast: 'Exam updated successfully' } });
    } catch (err) {
      setServerError(handleApiError(err) || 'Failed to update exam');
    } finally {
      setIsSubmitting(false);
    }
  };

  const fieldClass =
    'w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
  const labelClass = 'text-sm font-medium text-gray-700';
  const errorClass = 'text-xs text-danger';

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  if (!exam) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{serverError || 'Exam not found'}</p>
        <Link to="/admin/exams" className="text-sm text-primary-600 hover:underline">
          Back to exam list
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">Edit Exam — {exam.exam_name}</h1>
          <p className="text-sm text-gray-500">Update this exam's details or status</p>
        </div>
        <Link to="/admin/exams" className="text-sm text-primary-600 hover:underline">
          Back to list
        </Link>
      </div>

      {serverError && (
        <div className="rounded-md border border-danger bg-red-50 px-3 py-2 text-sm text-danger">
          {serverError}
        </div>
      )}

      <form onSubmit={handleSubmit(onSubmit)} className="card space-y-5" noValidate>
        {/* Exam ID — read-only, frozen at creation */}
        <div className="space-y-1">
          <span className={labelClass}>Exam ID</span>
          <p className="font-mono text-sm rounded-md bg-gray-50 border border-surface-border px-3 py-2 text-gray-500">
            {exam.exam_id}
          </p>
          <p className="text-xs text-gray-400">Cannot be changed after creation.</p>
        </div>

        {identityChanged && (
          <div className="rounded-md border border-warning bg-warning-light px-3 py-2 text-sm text-warning-dark">
            Changing the name won't update the exam ID (<code className="font-mono">{exam.exam_id}</code>)
            used by existing blueprints and tests.
          </div>
        )}

        {/* Organization */}
        <div className="space-y-1">
          <label htmlFor="organization" className={labelClass}>
            Organization
          </label>
          <input id="organization" type="text" className={fieldClass} {...register('organization')} />
          {errors.organization && <p className={errorClass}>{errors.organization.message}</p>}
        </div>

        {/* Exam name */}
        <div className="space-y-1">
          <label htmlFor="exam_name" className={labelClass}>
            Exam name
          </label>
          <input id="exam_name" type="text" className={fieldClass} {...register('exam_name')} />
          {errors.exam_name && <p className={errorClass}>{errors.exam_name.message}</p>}
        </div>

        {/* Description */}
        <div className="space-y-1">
          <label htmlFor="description" className={labelClass}>
            Description <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <textarea
            id="description"
            rows={3}
            className={fieldClass}
            {...register('description')}
          />
        </div>

        {/* Tags */}
        <div className="space-y-1">
          <label htmlFor="tags" className={labelClass}>
            Tags <span className="text-gray-400 font-normal">(optional)</span>
          </label>
          <input id="tags" type="text" className={fieldClass} {...register('tags')} />
          <p className="text-xs text-gray-400">Comma-separated.</p>
        </div>

        {/* Status — same action ExamList.jsx's quick-toggle provides, exposed here too */}
        <div className="space-y-1">
          <label htmlFor="status" className={labelClass}>
            Status
          </label>
          <select id="status" className={fieldClass} {...register('status')}>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : 'Save changes'}
        </Button>
      </form>
    </div>
  );
}
