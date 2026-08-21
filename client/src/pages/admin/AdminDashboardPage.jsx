import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Database,
  CheckCircle,
  Clock,
  FileText,
  Briefcase,
  ClipboardList,
  Network,
  Upload,
  Sparkles,
  ShieldCheck,
  BarChart3,
  History,
  Gauge,
  ArrowRight,
  ScrollText,
} from 'lucide-react';
import useAuth from '@/hooks/useAuth';
import { getTrends, getActivityLogs } from '@/api/analyticsApi';
import StatCard from '@/components/analytics/StatCard';
import SkeletonCard from '@/components/common/SkeletonCard';
import MonthlyTrend from '@/components/analytics/MonthlyTrend';

// AdminDashboardPage.jsx — the admin home page.
//
// Previously a static placeholder. This is now a real landing page:
//   1. a greeting + at-a-glance stat cards (reusing getTrends, the
//      same one-round-trip overview+generationTrend endpoint the
//      Analytics page's "quick trends" comment describes),
//   2. a quick-access grid that surfaces every section of the sidebar
//      (AdminLayout.jsx's NAV_ITEMS, including the nested children)
//      as a clickable card, so nothing in the sidebar requires the
//      sidebar itself to reach,
//   3. a compact monthly generation trend chart (reusing the existing
//      MonthlyTrend component from Analytics), and
//   4. a recent activity feed (reusing the existing activity-logs
//      endpoint/api function), so the dashboard also doubles as a
//      "what changed recently" view.
//
// Mirrors AnalyticsDashboard.jsx's real conventions in this codebase:
// no shared PageHeader/Spinner component exists, each data source is
// fetched and rendered independently so one slow/failed request never
// blocks the rest of the page, and errors get an inline retry button
// rather than a full-page failure state.

function InlineSpinner({ size = 'h-6 w-6' }) {
  return (
    <div
      className={`${size} rounded-full border-2 border-gray-300 border-t-primary-600 animate-spin`}
    />
  );
}

// Mirrors AdminLayout.jsx's NAV_ITEMS (minus "Dashboard" itself, since
// that's this page) so every sidebar destination — including nested
// children like Import > History or Analytics > Exposure/Activity Log
// — has a matching card here too.
const QUICK_ACCESS = [
  {
    label: 'MCQ Bank',
    to: '/admin/mcqs',
    icon: Database,
    description: 'Browse, filter, and manage every question in the bank.',
  },
  {
    label: 'Taxonomy',
    to: '/admin/taxonomy',
    icon: Network,
    description: 'Manage the Subject → Topic → Subtopic tree and live counts.',
  },
  {
    label: 'Import',
    to: '/admin/import',
    icon: Upload,
    description: 'Bulk-import MCQs from a file or pasted JSON.',
    children: [{ label: 'Import History', to: '/admin/import/history' }],
  },
  {
    label: 'Blueprints',
    to: '/admin/exams',
    icon: ClipboardList,
    description: 'Pick an exam to view or build its blueprints.',
  },
  {
    label: 'Exams',
    to: '/admin/exams',
    icon: Briefcase,
    description: 'Create and manage exams that generated tests draw from.',
  },
  {
    label: 'Generator',
    to: '/admin/generator',
    icon: Sparkles,
    description: 'Generate a new test from an exam and its active blueprint.',
    children: [
      { label: 'Advanced Generator', to: '/admin/generator/advanced' },
      { label: 'Generation History', to: '/admin/generator/history' },
    ],
  },
  {
    label: 'Quality Assurance',
    to: '/admin/qa',
    icon: ShieldCheck,
    description: 'Run QA on a generated test or review a past result.',
  },
  {
    label: 'Analytics',
    to: '/admin/analytics',
    icon: BarChart3,
    description: 'Distribution, difficulty, coverage, and generation trends.',
    children: [
      { label: 'MCQ Exposure', to: '/admin/analytics/exposure' },
      { label: 'Activity Log', to: '/admin/analytics/activity-log' },
    ],
  },
];

// Lightweight local versions of ActivityLog.jsx's ACTION_LABELS /
// ENTITY_LINK_BUILDERS — the dashboard only ever shows a handful of
// rows, so it doesn't need that page's full filter-dropdown enum, just
// enough to render a readable label and (where possible) a link.
const prettifyAction = (action = '') =>
  action
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

const ENTITY_LINK_BUILDERS = {
  MCQ: (id) => `/admin/mcqs/${id}`,
  Blueprint: (id) => `/admin/blueprints/${id}`,
  Exam: (id) => `/admin/exams/${id}`,
};

const formatRelative = (timestamp) => {
  if (!timestamp) return '—';
  const diffMs = Date.now() - new Date(timestamp).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
};

export default function AdminDashboardPage() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // ─── Overview stats + monthly trend (one round trip) ───────────────
  const [overview, setOverview] = useState(null);
  const [totalsByMonth, setTotalsByMonth] = useState([]);
  const [trendsLoading, setTrendsLoading] = useState(true);
  const [trendsError, setTrendsError] = useState(null);

  const fetchTrends = useCallback(async () => {
    setTrendsLoading(true);
    setTrendsError(null);
    try {
      const data = await getTrends();
      setOverview(data.overview || {});
      setTotalsByMonth(data.generationTrend?.totalsByMonth || []);
    } catch (err) {
      setTrendsError(err.message || 'Failed to load dashboard stats');
    } finally {
      setTrendsLoading(false);
    }
  }, []);

  // ─── Recent activity ─────────────────────────────────────────────
  const [recentActivity, setRecentActivity] = useState([]);
  const [activityLoading, setActivityLoading] = useState(true);
  const [activityError, setActivityError] = useState(null);

  const fetchActivity = useCallback(async () => {
    setActivityLoading(true);
    setActivityError(null);
    try {
      // getActivityLogs unwraps response.data.data, which — per
      // pagination.js's buildPaginatedResponse — is { data, pagination },
      // not { logs, total } (see ActivityLog.jsx's own comment on that
      // mismatch). Read the real shape directly here.
      const result = await getActivityLogs({ page: 1, limit: 6 });
      setRecentActivity(result?.data || []);
    } catch (err) {
      setActivityError(err.message || 'Failed to load recent activity');
    } finally {
      setActivityLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTrends();
    fetchActivity();
  }, [fetchTrends, fetchActivity]);

  const stats = overview || {};
  const greetingName = user?.email ? user.email.split('@')[0] : 'there';

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="section-title">Welcome back, {greetingName}</h1>
          <p className="text-sm text-gray-500 mt-0.5">
            Here's what's happening across your exam bank today.
          </p>
        </div>
        {user?.role && (
          <span className="badge bg-primary-light text-primary capitalize">{user.role}</span>
        )}
      </div>

      {/* ── Stat cards ──────────────────────────────────────────── */}
      {trendsLoading && !overview ? (
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
            icon={Clock}
            value={(stats.pendingMCQs ?? 0).toLocaleString()}
            label="Pending Review"
          />
          <StatCard
            icon={FileText}
            value={(stats.totalTestsGenerated ?? 0).toLocaleString()}
            label="Tests Generated"
          />
          <StatCard
            icon={Briefcase}
            value={(stats.totalExams ?? 0).toLocaleString()}
            label="Total Exams"
          />
          <StatCard
            icon={ClipboardList}
            value={(stats.totalBlueprints ?? 0).toLocaleString()}
            label="Total Blueprints"
          />
        </div>
      )}

      {trendsError && (
        <div className="card border-danger bg-red-50 flex items-center justify-between">
          <p className="text-sm text-danger">{trendsError}</p>
          <button
            type="button"
            onClick={fetchTrends}
            className="px-3 py-1.5 rounded-md text-sm bg-danger text-white hover:opacity-90"
          >
            Retry
          </button>
        </div>
      )}

      {/* ── Needs attention ─────────────────────────────────────── */}
      {!trendsLoading && (stats.pendingMCQs ?? 0) > 0 && (
        <button
          type="button"
          onClick={() => navigate('/admin/mcqs?status=pending')}
          className="w-full card flex items-center justify-between gap-3 border-warning/40 bg-medium-light/40 hover:bg-medium-light/70 transition-colors text-left"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="shrink-0 h-9 w-9 rounded-lg bg-warning/15 text-warning flex items-center justify-center">
              <Gauge size={18} strokeWidth={2} />
            </div>
            <p className="text-sm text-gray-700 truncate">
              <span className="font-semibold text-gray-900">
                {stats.pendingMCQs.toLocaleString()} MCQ{stats.pendingMCQs === 1 ? '' : 's'}
              </span>{' '}
              waiting for review
            </p>
          </div>
          <ArrowRight size={16} className="shrink-0 text-gray-400" />
        </button>
      )}

      {/* ── Quick access ────────────────────────────────────────── */}
      <div>
        <h2 className="text-sm font-semibold text-gray-800 mb-3">Quick Access</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {QUICK_ACCESS.map((item) => (
            <Link
              key={item.label}
              to={item.to}
              className="card flex flex-col gap-3 hover:shadow-md hover:border-primary/30 transition-all group"
            >
              <div className="flex items-center justify-between">
                <div className="h-10 w-10 rounded-lg bg-primary-light text-primary flex items-center justify-center">
                  <item.icon size={20} strokeWidth={2} />
                </div>
                <ArrowRight
                  size={16}
                  className="text-gray-300 group-hover:text-primary group-hover:translate-x-0.5 transition-all"
                />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-900">{item.label}</p>
                <p className="text-xs text-gray-500 mt-0.5 leading-snug">{item.description}</p>
              </div>
              {item.children && (
                <div className="pt-2 mt-auto border-t border-surface-border flex flex-wrap gap-x-3 gap-y-1">
                  {item.children.map((child) => (
                    <span
                      key={child.to}
                      role="link"
                      tabIndex={0}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        navigate(child.to);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          e.stopPropagation();
                          navigate(child.to);
                        }
                      }}
                      className="text-xs text-primary hover:underline"
                    >
                      {child.label}
                    </span>
                  ))}
                </div>
              )}
            </Link>
          ))}
        </div>
      </div>

      {/* ── Trend chart + recent activity ──────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card h-80 flex flex-col">
          <div className="flex items-center justify-between mb-2">
            <p className="text-sm font-semibold text-gray-700">
              Monthly Test Generation (last 12 months)
            </p>
            <Link
              to="/admin/analytics"
              className="text-xs font-medium text-primary hover:underline shrink-0"
            >
              Full analytics
            </Link>
          </div>
          <div className="flex-1 min-h-0">
            {trendsLoading && !totalsByMonth.length ? (
              <div className="h-full flex items-center justify-center">
                <InlineSpinner />
              </div>
            ) : (
              <MonthlyTrend data={totalsByMonth} />
            )}
          </div>
        </div>

        <div className="card p-0 overflow-hidden flex flex-col h-80">
          <div className="px-6 pt-6 pb-2 flex items-center justify-between shrink-0">
            <p className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
              <ScrollText size={15} /> Recent Activity
            </p>
            <Link
              to="/admin/analytics/activity-log"
              className="text-xs font-medium text-primary hover:underline shrink-0"
            >
              View all
            </Link>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
            {activityLoading ? (
              <div className="h-full flex items-center justify-center">
                <InlineSpinner />
              </div>
            ) : activityError ? (
              <div className="h-full flex flex-col items-center justify-center gap-2">
                <p className="text-sm text-danger">{activityError}</p>
                <button
                  type="button"
                  onClick={fetchActivity}
                  className="px-3 py-1 rounded-md text-xs bg-danger text-white hover:opacity-90"
                >
                  Retry
                </button>
              </div>
            ) : recentActivity.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <p className="text-sm text-gray-400">No activity recorded yet.</p>
              </div>
            ) : (
              <ul className="divide-y divide-surface-border">
                {recentActivity.map((log) => {
                  const linkBuilder = ENTITY_LINK_BUILDERS[log.entity_type];
                  const href = linkBuilder && log.entity_id ? linkBuilder(log.entity_id) : null;

                  const Row = (
                    <div className="flex items-start justify-between gap-3 py-2.5">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-800 truncate">
                          {prettifyAction(log.action)}
                        </p>
                        <p className="text-xs text-gray-400 truncate">{log.actor_name}</p>
                      </div>
                      <span
                        className="text-xs text-gray-400 shrink-0"
                        title={new Date(log.timestamp).toLocaleString()}
                      >
                        {formatRelative(log.timestamp)}
                      </span>
                    </div>
                  );

                  return (
                    <li key={log._id}>
                      {href ? (
                        <Link to={href} className="block hover:bg-gray-50 -mx-2 px-2 rounded-md">
                          {Row}
                        </Link>
                      ) : (
                        Row
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {/* ── Second-tier quick links ─────────────────────────────── */}
      <div className="card flex items-center gap-3 flex-wrap">
        <History size={16} className="text-gray-400 shrink-0" />
        <span className="text-xs text-gray-500 shrink-0">Jump back in:</span>
        <Link to="/admin/generator/history" className="text-xs text-primary hover:underline">
          Generation History
        </Link>
        <span className="text-gray-300">·</span>
        <Link to="/admin/import/history" className="text-xs text-primary hover:underline">
          Import History
        </Link>
        <span className="text-gray-300">·</span>
        <Link to="/admin/analytics/exposure" className="text-xs text-primary hover:underline">
          MCQ Exposure
        </Link>
        <span className="text-gray-300">·</span>
        <Link to="/admin/analytics/activity-log" className="text-xs text-primary hover:underline">
          Full Activity Log
        </Link>
      </div>
    </div>
  );
}
