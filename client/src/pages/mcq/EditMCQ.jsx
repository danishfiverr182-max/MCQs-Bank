import { useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import apiClient, { handleApiError } from '@/lib/axios';
import MCQForm from '@/components/mcq/MCQForm';

export default function EditMCQ() {
  const { id } = useParams();
  const navigate = useNavigate();

  const [mcq, setMcq] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const fetchMcq = async () => {
      setIsLoading(true);
      try {
        const response = await apiClient.get(`/mcqs/${id}`);
        if (!cancelled) setMcq(response.data.data.mcq);
      } catch (err) {
        if (!cancelled) setServerError('MCQ not found');
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    fetchMcq();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const handleSubmit = async (formData) => {
    setIsSubmitting(true);
    setServerError(null);
    try {
      await apiClient.patch(`/mcqs/${id}`, formData);
      navigate('/admin/mcqs', { state: { toast: 'MCQ updated successfully' } });
    } catch (err) {
      setServerError(handleApiError(err) || 'Failed to update MCQ');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin" />
      </div>
    );
  }

  if (!mcq) {
    return (
      <div className="card text-center space-y-3 py-10">
        <p className="text-sm text-danger">{serverError || 'MCQ not found'}</p>
        <Link to="/admin/mcqs" className="text-sm text-primary-600 hover:underline">
          Back to MCQ list
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">Edit MCQ — {mcq.question_id}</h1>
          <p className="text-sm text-gray-500">Update this question's content or status</p>
        </div>
        <Link to="/admin/mcqs" className="text-sm text-primary-600 hover:underline">
          Back to list
        </Link>
      </div>

      {serverError && (
        <div className="rounded-md border border-danger bg-red-50 px-3 py-2 text-sm text-danger">
          {serverError}
        </div>
      )}

      <MCQForm initialValues={mcq} onSubmit={handleSubmit} isSubmitting={isSubmitting} />
    </div>
  );
}
