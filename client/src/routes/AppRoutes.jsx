import { lazy, Suspense } from 'react';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import AdminLayout from '@/layouts/AdminLayout';
import HealthPage from '@/pages/health/HealthPage';
import NotFound from '@/pages/NotFound';
import PageLoadingFallback from '@/components/common/PageLoadingFallback';

// Lazy-loaded: kept out of the initial bundle since later phases will
// add heavier admin pages (blueprint builders, exam pages, etc.)
const AdminDashboardPage = lazy(() => import('@/pages/admin/AdminDashboardPage'));
const MCQList = lazy(() => import('@/pages/mcq/MCQList'));
const AddMCQ = lazy(() => import('@/pages/mcq/AddMCQ'));
const EditMCQ = lazy(() => import('@/pages/mcq/EditMCQ'));
const MCQDetail = lazy(() => import('@/pages/mcq/MCQDetail'));
const TaxonomyManager = lazy(() => import('@/pages/taxonomy/TaxonomyManager'));
const BulkImport = lazy(() => import('@/pages/import/BulkImport'));
const ImportReport = lazy(() => import('@/pages/import/ImportReport'));
const ImportHistory = lazy(() => import('@/pages/import/ImportHistory'));
const ExamList = lazy(() => import('@/pages/exams/ExamList'));
const AddExam = lazy(() => import('@/pages/exams/AddExam'));
const EditExam = lazy(() => import('@/pages/exams/EditExam'));
const ExamDetail = lazy(() => import('@/pages/exams/ExamDetail'));
const BlueprintBuilder = lazy(() => import('@/pages/blueprints/BlueprintBuilder'));
const BlueprintDetail = lazy(() => import('@/pages/blueprints/BlueprintDetail'));
// Prompt 58 dev-only harness for the blueprint input primitives —
// remove this import + route once BlueprintBuilder.jsx (now wired in
// below) fully covers exercising them in situ.
const BlueprintComponentPlayground = lazy(() => import('@/pages/blueprints/ComponentPlayground'));
const GeneratorForm = lazy(() => import('@/pages/generator/GeneratorForm'));
const AdvancedGenerator = lazy(() => import('@/pages/generator/AdvancedGenerator'));
const GeneratedTest = lazy(() => import('@/pages/generator/GeneratedTest'));
const TestHistory = lazy(() => import('@/pages/generator/TestHistory'));
const QADashboard = lazy(() => import('@/pages/qa/QADashboard'));
const QAReport = lazy(() => import('@/pages/qa/QAReport'));
const SimilarityReview = lazy(() => import('@/pages/qa/SimilarityReview'));
const AnalyticsDashboard = lazy(() => import('@/pages/analytics/AnalyticsDashboard'));
const MCQExposure = lazy(() => import('@/pages/analytics/MCQExposure'));
const ActivityLog = lazy(() => import('@/pages/analytics/ActivityLog'));

const withSuspense = (element) => (
  <Suspense fallback={<PageLoadingFallback />}>{element}</Suspense>
);

// Phase 8 (Prompts 88-90): QA dashboard, per-test report, and the
// similarity resolution workspace. /qa/similarity intentionally has
// no :param — it reads either route state (a known pair, carried by
// QAReport.jsx's "Review & Resolve" link) or a `?question_id=` query
// param (the standalone on-demand entry point), never a URL param.

const router = createBrowserRouter([
  {
    path: '/',
    element: <Navigate to="/admin" replace />,
  },
  {
    path: '/health',
    element: <HealthPage />,
  },
  {
    path: '/admin',
    element: <ProtectedRoute />,
    children: [
      {
        element: <AdminLayout />,
        children: [
          { index: true, element: withSuspense(<AdminDashboardPage />) },
          { path: 'mcqs', element: withSuspense(<MCQList />) },
          { path: 'mcqs/new', element: withSuspense(<AddMCQ />) },
          { path: 'mcqs/:id/edit', element: withSuspense(<EditMCQ />) },
          { path: 'mcqs/:id', element: withSuspense(<MCQDetail />) },
          // Prompt 109: Subject -> Topic -> Subtopic tree with live
          // counts + bulk rename.
          { path: 'taxonomy', element: withSuspense(<TaxonomyManager />) },
          { path: 'import', element: withSuspense(<BulkImport />) },
          { path: 'import/report', element: withSuspense(<ImportReport />) },
          { path: 'import/history', element: withSuspense(<ImportHistory />) },
          { path: 'exams', element: withSuspense(<ExamList />) },
          { path: 'exams/new', element: withSuspense(<AddExam />) },
          { path: 'exams/:examId/edit', element: withSuspense(<EditExam />) },
          { path: 'exams/:examId', element: withSuspense(<ExamDetail />) },
          {
            path: 'exams/:examId/blueprints/new',
            element: withSuspense(<BlueprintBuilder />),
          },
          {
            path: 'blueprints/:blueprintId/edit',
            element: withSuspense(<BlueprintBuilder />),
          },
          {
            path: 'blueprints/:blueprintId',
            element: withSuspense(<BlueprintDetail />),
          },
          {
            path: 'dev/blueprint-components',
            element: withSuspense(<BlueprintComponentPlayground />),
          },
          // Prompt 70: closes Phase 6's loop — history list, plus the
          // exam ↔ generator cross-links added to ExamDetail.jsx.
          { path: 'generator/history', element: withSuspense(<TestHistory />) },
          // Prompts 67–69: exam picker → blueprint preview → generate →
          // full test view, all in one flow.
          { path: 'generator', element: withSuspense(<GeneratorForm />) },
          // Prompt 80: Phase 7's full override flow — same starting
          // point as GeneratorForm.jsx (an exam + its active
          // blueprint), but with OverridePanel/GenerationSummary/
          // InsufficientWarning layered on top and live feasibility
          // checking wired in.
          { path: 'generator/advanced', element: withSuspense(<AdvancedGenerator />) },
          { path: 'generator/tests/:testId', element: withSuspense(<GeneratedTest />) },
          // Phase 8: QA landing page, per-test report, and similarity
          // resolution workspace.
          { path: 'qa', element: withSuspense(<QADashboard />) },
          { path: 'qa/report/:testId', element: withSuspense(<QAReport />) },
          { path: 'qa/similarity', element: withSuspense(<SimilarityReview />) },
          // Prompt 97: Analytics dashboard shell (stat cards live now,
          // charts land in Prompt 98 without any route changes needed).
          { path: 'analytics', element: withSuspense(<AnalyticsDashboard />) },
          // Prompt 99: MCQ exposure (overused / least-used / never-used).
          { path: 'analytics/exposure', element: withSuspense(<MCQExposure />) },
          // Prompt 100: global filterable activity/audit log.
          { path: 'analytics/activity-log', element: withSuspense(<ActivityLog />) },
        ],
      },
    ],
  },
  {
    path: '*',
    element: <NotFound />,
  },
]);

export default function AppRoutes() {
  return <RouterProvider router={router} />;
}
