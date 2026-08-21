import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import apiClient, { handleApiError } from '@/lib/axios';
import { Button } from '@/components/ui/button';
import ExamStatusBadge from '@/components/exams/ExamStatusBadge';
import BlueprintList from '@/pages/blueprints/BlueprintList';

// The single place an admin manages both an exam's metadata and its
// blueprints together — header above (exam facts + Edit Exam), the
// scoped blueprint list below it.
export default function ExamDetail() {
  const { examId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();

  const [exam, setExam] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchExam = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await apiClient.get(`/exams/${examId}`);
      setExam(response.data.data.exam);
    } catch (err) {
      setError(handleApiError(err) || 'Exam not found');
    } finally {
      setIsLoading(false);
    }
  }, [examId]);

  useEffect(() => {
    fetchExam();
  }, [fetchExam]);

  // BlueprintBuilder.jsx (Prompt 59) navigates back here with a toast
  // message on successful create/edit — same pattern ExamList.jsx uses
  // for its own return-navigation toasts.
  useEffect(() => {
    if (location.state?.toast) {
      toast.success(location.state.toast);
      navigate(location.pathname, { replace: true, state: {} });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

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
        <p className="text-sm text-danger">{error || 'Exam not found'}</p>
        <Link to="/admin/exams" className="text-sm text-primary-600 hover:underline">
          Back to exam list
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Breadcrumb back-link — closes the navigation loop noted in
          Prompt 60: every page in the exam → blueprint flow needs a
          clear path back to its logical parent, and this one was
          previously only shown in the error state. */}
      <Link to="/admin/exams" className="text-sm text-primary-600 hover:underline">
        ← Back to exams
      </Link>

      <div className="card space-y-4">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="section-title">{exam.exam_name}</h1>
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
                {exam.organization}
              </span>
              <ExamStatusBadge status={exam.status} />
            </div>
            <p className="text-xs font-mono text-gray-400">{exam.exam_id}</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Link to="/admin/generator/history" state={{ examFilter: exam }}>
              <Button variant="outline">View Test History</Button>
            </Link>
            <Button
              type="button"
              onClick={() => navigate('/admin/generator', { state: { preselectedExam: exam } })}
            >
              Generate Test
            </Button>
            <Link to={`/admin/exams/${exam.exam_id}/edit`}>
              <Button variant="outline">Edit Exam</Button>
            </Link>
          </div>
        </div>

        {exam.description && <p className="text-sm text-gray-600">{exam.description}</p>}

        {Array.isArray(exam.tags) && exam.tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {exam.tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center rounded-full bg-primary-50 px-2.5 py-0.5 text-xs font-medium text-primary-700"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-gray-800">Blueprints</h2>
          <Link to={`/admin/exams/${exam.exam_id}/blueprints/new`}>
            <Button size="sm">+ New Blueprint</Button>
          </Link>
        </div>

        <BlueprintList examId={exam.exam_id} />
      </div>
    </div>
  );
}
