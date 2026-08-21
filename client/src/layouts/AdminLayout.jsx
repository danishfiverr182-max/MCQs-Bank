import { NavLink, Outlet } from 'react-router-dom';
import useAuth from '@/hooks/useAuth';

const NAV_ITEMS = [
  { label: 'Dashboard', to: '/admin', enabled: true },
  { label: 'MCQ Bank', to: '/admin/mcqs', enabled: true },
  // Prompt 109: a view/management tool over the same underlying MCQ
  // data as MCQ Bank, so it sits directly after it rather than off in
  // Analytics.
  { label: 'Taxonomy', to: '/admin/taxonomy', enabled: true },
  {
    label: 'Import',
    to: '/admin/import',
    enabled: true,
    // Previously Import History (a fully working page at
    // /admin/import/history) was only reachable via a link that
    // appeared on the Import Report page — i.e. only after completing
    // an upload. Exposed here directly, same pattern as Analytics'
    // children below, so admins can review or clean up past import
    // batches without uploading a file first.
    children: [{ label: 'History', to: '/admin/import/history' }],
  },
  {
    label: 'Blueprints',
    // Blueprints are always scoped to an exam (Blueprint.exam_id is
    // required, and blueprint.service.js has no "list every blueprint
    // across every exam" query — every blueprint page in this app,
    // including this one's own BlueprintList.jsx, takes an examId prop
    // and is reached via ExamDetail.jsx). There's no standalone
    // /admin/blueprints page to route to, so this points at the real
    // entry point instead of a dead '#' — pick an exam, then its
    // Blueprints tab. Previously left disabled with a "Coming soon"
    // tooltip even though the feature has been fully built since
    // Phase 5; that was just a stale placeholder, not an actual gap.
    to: '/admin/exams',
    enabled: true,
  },
  { label: 'Exams', to: '/admin/exams', enabled: true },
  { label: 'Generator', to: '/admin/generator', enabled: true },
  { label: 'Quality Assurance', to: '/admin/qa', enabled: true },
  {
    label: 'Analytics',
    to: '/admin/analytics',
    enabled: true,
    // Prompt 100: Analytics grew a real sub-section (MCQExposure +
    // ActivityLog land alongside the Prompt 97/98 dashboard) — same
    // flat NAV_ITEMS array, just with an optional `children` list
    // rendered as indented sub-links directly under the parent, rather
    // than reworking this into a full nested-menu component for one
    // section.
    children: [
      { label: 'Exposure', to: '/admin/analytics/exposure' },
      { label: 'Activity Log', to: '/admin/analytics/activity-log' },
    ],
  },
];

export default function AdminLayout() {
  const { user } = useAuth();

  return (
    <div className="min-h-screen flex bg-surface">
      {/* Sidebar */}
      <aside className="w-sidebar shrink-0 bg-sidebar-bg text-sidebar-text flex flex-col">
        <div className="h-topbar flex items-center px-6 text-white font-semibold">
          🔧 ExamEngine
        </div>
        <nav className="flex-1 px-3 space-y-1">
          {NAV_ITEMS.map((item) =>
            item.enabled ? (
              <div key={item.label}>
                <NavLink
                  to={item.to}
                  end
                  className={({ isActive }) =>
                    `block rounded-md px-3 py-2 text-sm transition-colors ${
                      isActive
                        ? 'bg-sidebar-hover text-sidebar-text-active'
                        : 'hover:bg-sidebar-hover hover:text-sidebar-text-active'
                    }`
                  }
                >
                  {item.label}
                </NavLink>
                {item.children && (
                  <div className="ml-3 mt-0.5 space-y-0.5 border-l border-sidebar-hover pl-3">
                    {item.children.map((child) => (
                      <NavLink
                        key={child.label}
                        to={child.to}
                        className={({ isActive }) =>
                          `block rounded-md px-2 py-1.5 text-xs transition-colors ${
                            isActive
                              ? 'bg-sidebar-hover text-sidebar-text-active'
                              : 'text-sidebar-text/70 hover:bg-sidebar-hover hover:text-sidebar-text-active'
                          }`
                        }
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span
                key={item.label}
                className="block rounded-md px-3 py-2 text-sm text-sidebar-text/40 cursor-not-allowed select-none"
                title="Coming soon"
              >
                {item.label}
              </span>
            )
          )}
        </nav>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topbar */}
        <header className="h-topbar bg-topbar-bg border-b border-topbar-border flex items-center justify-end px-6 gap-4">
          <span className="text-sm text-gray-600">{user?.email}</span>
        </header>

        {/* Content */}
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
