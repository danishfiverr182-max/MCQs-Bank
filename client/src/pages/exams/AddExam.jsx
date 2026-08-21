import { useEffect, useMemo, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';

// ─── Client-side mirror of the server's createExamSchema body ──────
// (server/src/validators/exam.validator.js). Kept in sync manually —
// the server remains the source of truth and re-validates on submit.
const addExamSchema = z.object({
  organization: z.string().trim().min(2, 'organization must be at least 2 characters'),
  exam_name: z.string().trim().min(3, 'exam_name must be at least 3 characters'),
  description: z.string().trim().optional().default(''),
  tags: z.string().optional().default(''), // comma-separated text input; parsed to array on submit
});

// Mirrors server/src/services/exam.service.js's slugifyPart + join —
// preview ONLY. The real exam_id is always server-generated on submit
// (including the _2, _3... collision suffix this preview can't predict),
// so it's labeled "Suggested ID" in the UI, never presented as final.
const slugifyPart = (value) =>
  value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^_+|_+$/g, '');

const previewExamId = (organization, examName) => {
  const org = slugifyPart(organization || '');
  const name = slugifyPart(examName || '');
  if (!org && !name) return '';
  return `${org}_${name}`.replace(/^_|_$/g, '');
};

export default function AddExam() {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);
  const [knownOrgs, setKnownOrgs] = useState([]);
  const [showOrgSuggestions, setShowOrgSuggestions] = useState(false);

  // Existing organizations, fetched once, purely to power the combobox
  // suggestion list below — so typing "Mod" nudges toward the existing
  // "MOD" group instead of silently fragmenting it into a new one.
  useEffect(() => {
    let cancelled = false;
    apiClient
      .get('/exams')
      .then((response) => {
        if (!cancelled) setKnownOrgs(Object.keys(response.data.data || {}));
      })
      .catch(() => {
        // Non-critical — the combobox just won't have suggestions.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const {
    register,
    handleSubmit,
    watch,
    setValue,
    formState: { errors },
  } = useForm({
    resolver: zodResolver(addExamSchema),
    defaultValues: { organization: '', exam_name: '', description: '', tags: '' },
  });

  const watchedOrg = watch('organization');
  const watchedName = watch('exam_name');

  const suggestedId = useMemo(
    () => previewExamId(watchedOrg, watchedName),
    [watchedOrg, watchedName]
  );

  const orgSuggestions = useMemo(() => {
    const query = (watchedOrg || '').trim().toLowerCase();
    if (!query) return knownOrgs;
    return knownOrgs.filter((org) => org.toLowerCase().includes(query));
  }, [knownOrgs, watchedOrg]);

  const handleSelectOrg = (org) => {
    setValue('organization', org, { shouldValidate: true });
    setShowOrgSuggestions(false);
  };

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
      };
      const response = await apiClient.post('/exams', payload);
      const exam = response.data.data.exam;
      navigate(`/admin/exams/${exam.exam_id}`, {
        state: { toast: `Exam "${exam.exam_name}" created successfully` },
      });
    } catch (err) {
      setServerError(handleApiError(err) || 'Failed to create exam');
    } finally {
      setIsSubmitting(false);
    }
  };

  const fieldClass =
    'w-full rounded-md border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring';
  const labelClass = 'text-sm font-medium text-gray-700';
  const errorClass = 'text-xs text-danger';

  return (
    <div className="space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">Add New Exam</h1>
          <p className="text-sm text-gray-500">Register a new exam profile</p>
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
        {/* Organization combobox */}
        <div className="space-y-1 relative">
          <label htmlFor="organization" className={labelClass}>
            Organization
          </label>
          <input
            id="organization"
            type="text"
            autoComplete="off"
            className={fieldClass}
            placeholder="e.g. MOD, KPPSC, FPSC"
            {...register('organization')}
            onFocus={() => setShowOrgSuggestions(true)}
            onBlur={() => {
              // Small delay so a suggestion click registers before the
              // list unmounts.
              setTimeout(() => setShowOrgSuggestions(false), 150);
            }}
          />
          {showOrgSuggestions && orgSuggestions.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full rounded-md border border-surface-border bg-white shadow-md max-h-40 overflow-y-auto">
              {orgSuggestions.map((org) => (
                <li key={org}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()} // keep focus so onBlur doesn't fire first
                    onClick={() => handleSelectOrg(org)}
                    className="w-full text-left px-3 py-1.5 text-sm hover:bg-primary-50"
                  >
                    {org}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {errors.organization && <p className={errorClass}>{errors.organization.message}</p>}
          <p className="text-xs text-gray-400">
            Matches an existing group where possible, to keep exam listings tidy.
          </p>
        </div>

        {/* Exam name */}
        <div className="space-y-1">
          <label htmlFor="exam_name" className={labelClass}>
            Exam name
          </label>
          <input
            id="exam_name"
            type="text"
            className={fieldClass}
            placeholder="e.g. Sub Inspector"
            {...register('exam_name')}
          />
          {errors.exam_name && <p className={errorClass}>{errors.exam_name.message}</p>}
        </div>

        {/* Suggested ID preview */}
        <div className="space-y-1">
          <span className={labelClass}>Suggested ID</span>
          <p className="font-mono text-sm rounded-md bg-gray-50 border border-surface-border px-3 py-2 text-gray-600">
            {suggestedId || '—'}
          </p>
          <p className="text-xs text-gray-400">
            The final exam ID is generated by the server on save (and may get a numeric suffix
            if this ID is already taken) — this is a preview, not a guarantee.
          </p>
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
          <input
            id="tags"
            type="text"
            placeholder="e.g. federal, security, entry-level"
            className={fieldClass}
            {...register('tags')}
          />
          <p className="text-xs text-gray-400">Comma-separated.</p>
        </div>

        <Button type="submit" className="w-full" disabled={isSubmitting}>
          {isSubmitting ? 'Creating…' : 'Create Exam'}
        </Button>
      </form>
    </div>
  );
}
