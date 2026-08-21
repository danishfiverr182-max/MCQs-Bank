import { useCallback, useEffect, useState } from 'react';
import { Database, CheckCircle, FileText, Briefcase, Clock, ClipboardList } from 'lucide-react';
import apiClient, { handleApiError } from '@/lib/axios';
import {
  getOverview,
  getSubjectStats,
  getDifficultyStats,
  getGenerationHistory,
} from '@/api/analyticsApi';
import StatCard from '@/components/analytics/StatCard';
import SkeletonCard from '@/components/common/SkeletonCard';
import SubjectBarChart from '@/components/analytics/SubjectBarChart';
import DifficultyPieChart from '@/components/analytics/DifficultyPieChart';
import MonthlyTrend from '@/components/analytics/MonthlyTrend';

// AnalyticsDashboard.jsx — Prompt 97 (stat card shell) + Prompt 98 (the
// four charts). No shared `PageHeader`/`Spinner` component exists
// anywhere in this codebase (checked against ExamList.jsx etc.), so this
// page keeps building its own header/spinner out of the same utility
// classes every other page already uses, rather than importing
// components that don't exist.
//
// Each of the four data sources below (overview, subject stats,
// difficulty stats, generation history) is fetched and rendered
// independently — a slow generation-history query never blocks the
// subject bar chart from showing up, and a failure in one section
// doesn't take down the others.

function InlineSpinner({ size = 'h-8 w-8' }) {
  return (
    <div
      className={`${size} rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin`}
    />
  );
}

function ChartCard({ title, loading, error, onRetry, children }) {
  return (
    <div className="card h-80 flex flex-col">
      <p className="text-sm font-semibold text-gray-700 mb-2">{title}</p>
      <div className="flex-1 min-h-0">
        {loading ? (
          <div className="h-full flex items-center justify-center">
            <InlineSpinner size="h-6 w-6" />
          </div>
        ) : error ? (
          <div className="h-full flex flex-col items-center justify-center gap-2">
            <p className="text-sm text-danger">{error}</p>
            <button
              type="button"
              onClick={onRetry}
              className="px-3 py-1 rounded-md text-xs bg-danger text-white hover:opacity-90"
            >
              Retry
            </button>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

export default function AnalyticsDashboard() {
  // ─── Overview / stat cards ──────────────────────────────────────
  const [overview, setOverview] = useState(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [overviewError, setOverviewError] = useState(null);

  const fetchOverview = useCallback(async () => {
    setOverviewLoading(true);
    setOverviewError(null);
    try {
      setOverview(await getOverview());
    } catch (err) {
      setOverviewError(err.message || 'Failed to load analytics overview');
    } finally {
      setOverviewLoading(false);
    }
  }, []);

  // ─── Subject distribution (count mode) ──────────────────────────
  const [subjectStats, setSubjectStats] = useState([]);
  const [subjectLoading, setSubjectLoading] = useState(true);
  const [subjectError, setSubjectError] = useState(null);

  const fetchSubjectStats = useCallback(async () => {
    setSubjectLoading(true);
    setSubjectError(null);
    try {
      const data = await getSubjectStats();
      setSubjectStats(data.subjects || []);
    } catch (err) {
      setSubjectError(err.message || 'Failed to load subject distribution');
    } finally {
      setSubjectLoading(false);
    }
  }, []);

  // ─── Difficulty distribution ─────────────────────────────────────
  const [difficultyStats, setDifficultyStats] = useState([]);
  const [difficultyLoading, setDifficultyLoading] = useState(true);
  const [difficultyError, setDifficultyError] = useState(null);

  const fetchDifficultyStats = useCallback(async () => {
    setDifficultyLoading(true);
    setDifficultyError(null);
    try {
      const data = await getDifficultyStats();
      setDifficultyStats(data.difficulty || []);
    } catch (err) {
      setDifficultyError(err.message || 'Failed to load difficulty distribution');
    } finally {
      setDifficultyLoading(false);
    }
  }, []);

  // ─── Monthly generation trend ────────────────────────────────────
  const [totalsByMonth, setTotalsByMonth] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState(null);

  const fetchGenerationHistory = useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const data = await getGenerationHistory({ months: 12 });
      setTotalsByMonth(data.totalsByMonth || []);
    } catch (err) {
      setHistoryError(err.message || 'Failed to load generation history');
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  // ─── Subject coverage (blueprint-scoped) ─────────────────────────
  // Fires only once a blueprint is picked below. There's no "list every
  // blueprint across every exam" endpoint in this codebase (Phase 5
  // only ever scopes blueprints to a single exam via
  // GET /blueprints/exam/:examId) — so the picker is a two-step exam ->
  // blueprint select, reusing those two existing endpoints exactly as
  // they are rather than adding a new backend route just for this
  // dropdown.
  const [exams, setExams] = useState([]);
  const [examsLoading, setExamsLoading] = useState(true);
  const [selectedExamId, setSelectedExamId] = useState('');

  const [blueprints, setBlueprints] = useState([]);
  const [blueprintsLoading, setBlueprintsLoading] = useState(false);
  const [selectedBlueprintId, setSelectedBlueprintId] = useState('');

  const [coverageStats, setCoverageStats] = useState([]);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageError, setCoverageError] = useState(null);

  const fetchExams = useCallback(async () => {
    setExamsLoading(true);
    try {
      const response = await apiClient.get('/exams');
      const grouped = response.data.data || {};
      setExams(Object.values(grouped).flat());
    } catch {
      setExams([]); // non-fatal — the coverage picker just stays empty
    } finally {
      setExamsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedExamId) {
      setBlueprints([]);
      setSelectedBlueprintId('');
      return;
    }

    let cancelled = false;
    setBlueprintsLoading(true);
    setSelectedBlueprintId('');
    apiClient
      .get(`/blueprints/exam/${selectedExamId}`)
      .then((response) => {
        if (!cancelled) setBlueprints(response.data.data?.blueprints || []);
      })
      .catch(() => {
        if (!cancelled) setBlueprints([]);
      })
      .finally(() => {
        if (!cancelled) setBlueprintsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedExamId]);

  const fetchCoverage = useCallback(async (blueprintId) => {
    setCoverageLoading(true);
    setCoverageError(null);
    try {
      const data = await getSubjectStats(blueprintId);
      // Only keep entries the blueprint actually requires — a subject
      // with approved MCQs but no `required` field here isn't part of
      // this blueprint and would just clutter the grouped bar chart.
      const covered = (data.subjects || []).filter((s) => s.required !== undefined);
      setCoverageStats(covered);
    } catch (err) {
      setCoverageError(err.message || 'Failed to load subject coverage');
    } finally {
      setCoverageLoading(false);
    }
  }, []);

  useEffect(() => {
    if (selectedBlueprintId) fetchCoverage(selectedBlueprintId);
    else setCoverageStats([]);
  }, [selectedBlueprintId, fetchCoverage]);

  useEffect(() => {
    fetchOverview();
    fetchSubjectStats();
    fetchDifficultyStats();
    fetchGenerationHistory();
    fetchExams();
  }, [fetchOverview, fetchSubjectStats, fetchDifficultyStats, fetchGenerationHistory, fetchExams]);

  // The stat grid shows a SkeletonCard fill in its own position during the
  // very first overview load, rather than blocking the whole page (including
  // the header and charts, which fetch and render independently) behind a
  // full-page spinner.
  if (overviewError && !overview) {
    return (
      <div className="space-y-4">
        <div>
          <h1 className="section-title">Analytics</h1>
          <p className="text-sm text-gray-500">
            Live insight into your MCQ database and test generation activity
          </p>
        </div>

        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{overviewError}</p>
          <button
            type="button"
            onClick={fetchOverview}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const stats = overview || {};

  return (
    <div className="space-y-6">
      <div>
        <h1 className="section-title">Analytics</h1>
        <p className="text-sm text-gray-500">
          Live insight into your MCQ database and test generation activity
        </p>
      </div>

      {/* Stat card grid: 1 col mobile / 2 col tablet / 4 col desktop */}
      {overviewLoading && !overview ? (
        <SkeletonCard count={6} />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <StatCard
            icon={Database}
            value={(stats.totalMCQs ?? 0).toLocaleString()}
            label="Total MCQs"
          />
          <StatCard
            icon={CheckCircle}
            value={(stats.approvedMCQs ?? 0).toLocaleString()}
            label="Approved MCQs"
          />
          <StatCard
            icon={FileText}
            value={(stats.totalTestsGenerated ?? 0).toLocaleString()}
            label="Total Tests Generated"
          />
          <StatCard
            icon={Briefcase}
            value={(stats.totalExams ?? 0).toLocaleString()}
            label="Total Exams"
          />
          <StatCard
            icon={Clock}
            value={(stats.pendingMCQs ?? 0).toLocaleString()}
            label="Pending MCQs"
          />
          <StatCard
            icon={ClipboardList}
            value={(stats.totalBlueprints ?? 0).toLocaleString()}
            label="Total Blueprints"
          />
        </div>
      )}

      {overviewError && overview && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{overviewError}</p>
          <button
            type="button"
            onClick={fetchOverview}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="MCQs by Subject"
          loading={subjectLoading}
          error={subjectError}
          onRetry={fetchSubjectStats}
        >
          <SubjectBarChart data={subjectStats} mode="count" />
        </ChartCard>

        <ChartCard
          title="Difficulty Distribution"
          loading={difficultyLoading}
          error={difficultyError}
          onRetry={fetchDifficultyStats}
        >
          <DifficultyPieChart data={difficultyStats} />
        </ChartCard>

        <ChartCard
          title="Monthly Test Generation (last 12 months)"
          loading={historyLoading}
          error={historyError}
          onRetry={fetchGenerationHistory}
        >
          <MonthlyTrend data={totalsByMonth} />
        </ChartCard>

        <div className="card h-80 flex flex-col">
          <div className="flex items-center justify-between gap-3 mb-2 flex-wrap">
            <p className="text-sm font-semibold text-gray-700">Subject Coverage</p>

            <div className="flex items-center gap-2">
              <select
                value={selectedExamId}
                onChange={(e) => setSelectedExamId(e.target.value)}
                disabled={examsLoading}
                className="text-xs border border-surface-border rounded-md px-2 py-1 bg-white"
              >
                <option value="">{examsLoading ? 'Loading exams…' : 'Select an exam'}</option>
                {exams.map((exam) => (
                  <option key={exam.exam_id} value={exam.exam_id}>
                    {exam.exam_name}
                  </option>
                ))}
              </select>

              <select
                value={selectedBlueprintId}
                onChange={(e) => setSelectedBlueprintId(e.target.value)}
                disabled={!selectedExamId || blueprintsLoading}
                className="text-xs border border-surface-border rounded-md px-2 py-1 bg-white disabled:opacity-50"
              >
                <option value="">
                  {blueprintsLoading ? 'Loading blueprints…' : 'Select a blueprint'}
                </option>
                {blueprints.map((bp) => (
                  <option key={bp.blueprint_id} value={bp.blueprint_id}>
                    {bp.blueprint_id} {bp.is_active ? '(active)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex-1 min-h-0">
            {!selectedBlueprintId ? (
              <div className="h-full flex items-center justify-center text-sm text-gray-400 text-center px-4">
                Select a blueprint to see subject coverage
              </div>
            ) : coverageLoading ? (
              <div className="h-full flex items-center justify-center">
                <InlineSpinner size="h-6 w-6" />
              </div>
            ) : coverageError ? (
              <div className="h-full flex flex-col items-center justify-center gap-2">
                <p className="text-sm text-danger">{coverageError}</p>
                <button
                  type="button"
                  onClick={() => fetchCoverage(selectedBlueprintId)}
                  className="px-3 py-1 rounded-md text-xs bg-danger text-white hover:opacity-90"
                >
                  Retry
                </button>
              </div>
            ) : (
              <SubjectBarChart data={coverageStats} mode="coverage" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
