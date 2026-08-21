import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import apiClient, { handleApiError } from '@/lib/axios';
import MCQForm from '@/components/mcq/MCQForm';

export default function AddMCQ() {
  const navigate = useNavigate();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState(null);

  const handleSubmit = async (formData) => {
    setIsSubmitting(true);
    setServerError(null);
    try {
      await apiClient.post('/mcqs', formData);
      navigate('/admin/mcqs', { state: { toast: 'MCQ created successfully' } });
    } catch (err) {
      setServerError(handleApiError(err) || 'Failed to create MCQ');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-title">Add New MCQ</h1>
          <p className="text-sm text-gray-500">Create a new question for the MCQ bank</p>
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

      <MCQForm initialValues={null} onSubmit={handleSubmit} isSubmitting={isSubmitting} />
    </div>
  );
}
