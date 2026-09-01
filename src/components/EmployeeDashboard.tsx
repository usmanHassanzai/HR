import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { supabase } from '../lib/supabase';
import { isKpiViewedByAssignee, kpiProgressBadge, Profile, Kpi } from '../utils/kpiHelpers';
import { hydrateKpiLastEdits } from '../utils/kpiAssignmentEdits';
import { markAssignedKpisViewed } from '../utils/kpiViewed';
import { RefreshCw, BarChart2, Trophy, KeyRound, CalendarCheck, Settings, Target } from 'lucide-react';
import ExportButton from './ExportButton';
import ChangePasswordModal from './ChangePasswordModal';
import { emailKpiOverdue } from '../utils/kpiEmail';
import KpiAssignmentDetails from './KpiAssignmentDetails';
import TabFallback from './TabFallback';
import AdminSidebarNav, { findAdminNavIcon, type AdminNavGroup } from './AdminSidebarNav';
import AdminHamburgerButton from './AdminHamburgerButton';
import '../styles/admin-dashboard.css';
import '../styles/manager-personal.css';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import {
  employeeKpiScoreSummary,
  formatKpiScore,
  performanceRatingColor,
  thisMonthKpis,
  formatKpiTaskPoints,
  kpiAssignedScore,
} from '../utils/kpiScoreHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import KpiEvaluationBlock from './KpiEvaluationBlock';
import '../styles/employee-mobile.css';
import '../styles/employee-kpis.css';

const EmployeeRewardsPanel = lazy(() => import('./EmployeeRewardsPanel'));
const AttendanceLeavePanel = lazy(() => import('./AttendanceLeavePanel'));
const DailyWorkReportPanel = lazy(() => import('./DailyWorkReportPanel'));

interface EmployeeDashboardProps {
  profile: Profile;
  readOnlyUser?: Profile | null; // For manager view-only mode
  onBackToLeaderboard?: () => void;
  hideChangePassword?: boolean; // Manager dashboard already shows it in the parent tab bar
}

export default function EmployeeDashboard({ profile, readOnlyUser, onBackToLeaderboard, hideChangePassword }: EmployeeDashboardProps) {
  const activeUser = readOnlyUser || profile;
  const isReadOnly = !!readOnlyUser;

  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'kpis' | 'attendance' | 'rewards' | 'settings'>('kpis');
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  const fetchKpis = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const { data, error } = await supabase
        .from('kpis')
        .select('*')
        .eq('user_id', activeUser.id)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Error fetching KPIs:', error);
      } else {
        setKpis(await hydrateKpiLastEdits((data as Kpi[]) || []));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKpis();
    if (!isReadOnly) {
      supabase.rpc('check_overdue_kpis').then(({ data }) => {
        (data || []).forEach((row: any) => {
          if (row.emp_email) emailKpiOverdue(row.emp_email, row.emp_name, row.department, row.end_date, row.redo_count);
        });
      });
    }

    // Subscribe to KPI changes for this user
    const subscription = supabase
      .channel(`public:kpis:user=${activeUser.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kpis',
          filter: `user_id=eq.${activeUser.id}`,
        },
        () => {
          fetchKpis({ silent: true });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [activeUser.id]);

  useEffect(() => {
    if (isReadOnly || activeTab !== 'kpis') return;
    const ids = kpis.filter((k) => !isKpiViewedByAssignee(k)).map((k) => k.id);
    if (!ids.length) return;
    let cancelled = false;
    void markAssignedKpisViewed(ids).then(() => {
      if (cancelled) return;
      const now = new Date().toISOString();
      setKpis((prev) => prev.map((k) => (
        ids.includes(k.id)
          ? {
              ...k,
              viewed_at: k.viewed_at || now,
              viewed_by: k.viewed_by || activeUser.id,
              employee_progress: k.employee_progress === 'completed' || k.completion_status === 'completed'
                ? k.employee_progress
                : 'started',
            }
          : k
      )));
    });
    return () => { cancelled = true; };
  }, [isReadOnly, activeTab, kpis]);

  const monthKpis = useMemo(() => thisMonthKpis(kpis), [kpis]);
  const summary = employeeKpiScoreSummary(monthKpis);
  const ratingColor = performanceRatingColor(summary.performanceRating);

  const patchKpi = (id: string, patch: Partial<Kpi>) => {
    setKpis((prev) => prev.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  };

  const fmtDate = (d?: string | null) => {
    if (!d) return '—';
    return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  const dateRange = (start?: string | null, end?: string | null) => {
    const a = fmtDate(start);
    const b = fmtDate(end);
    if (a === '—' && b === '—') return '—';
    if (a === b) return a;
    return `${a} – ${b}`;
  };

  const navGroups = useMemo<AdminNavGroup[]>(() => [{
    label: 'Menu',
    items: [
      { id: 'kpis', label: 'My KPIs', icon: <BarChart2 size={16} /> },
      { id: 'attendance', label: 'Attendance', icon: <CalendarCheck size={16} /> },
      { id: 'rewards', label: 'Rewards', icon: <Trophy size={16} /> },
      { id: 'settings', label: 'Settings', icon: <Settings size={16} /> },
    ],
  }], []);

  const pageIcon = findAdminNavIcon(navGroups, activeTab);
  const pageTitle = { kpis: 'My KPIs', attendance: 'Attendance', rewards: 'Rewards', settings: 'Settings' }[activeTab];

  const kpiBoard = (
      <div className="emp-kpi-board">
      <section className="emp-kpi-summary">
        <div className="emp-kpi-summary__hero">
          <div className="emp-kpi-summary__hero-copy">
            <span>This month</span>
            <strong>{formatKpiScore(summary.overallScore)}%</strong>
          </div>
          <span className="emp-kpi-summary__band" style={{ color: ratingColor }}>
            {summary.performanceRating}
          </span>
        </div>
        <div className="emp-kpi-summary__meta">
          <div className="emp-kpi-summary__chip">
            <span>Done</span>
            <strong>{summary.completed} / {monthKpis.length || 0}</strong>
          </div>
          <div className="emp-kpi-summary__chip">
            <span>Tasks</span>
            <strong>{kpis.length}</strong>
          </div>
        </div>
        <div className="emp-kpi-toolbar">
          <ExportButton kpis={kpis} userName={activeUser.full_name} />
          <button type="button" className="btn btn-secondary" onClick={() => void fetchKpis()} title="Reload" aria-label="Reload KPIs">
            <RefreshCw size={16} />
          </button>
        </div>
      </section>

      {loading && kpis.length === 0 ? (
        <div className="dash-loading">
          <RefreshCw size={36} className="animate-spin" style={{ animation: 'spin 1.5s linear infinite' }} />
        </div>
      ) : kpis.length === 0 ? (
        <div className="emp-kpi-empty glass-panel">
          <Target size={32} strokeWidth={1.5} />
          <h3>No KPIs assigned yet</h3>
          <p>When your manager assigns a task, it will show up here with weight, score, and dates.</p>
        </div>
      ) : (
        <div className="emp-kpi-list">
          {kpis.map((kpi) => {
            const badge = kpiProgressBadge(kpi);
            const points = formatKpiTaskPoints(kpi);
            const paused = Boolean(kpi.paused_at) && kpi.completion_status !== 'completed';
            return (
              <article key={kpi.id} className={`emp-kpi-item kpi-card--${badge.light}${paused ? ' emp-kpi-item--paused' : ''}`}>
                <div className="emp-kpi-item__top">
                  <span className="emp-kpi-item__cat">{kpiCategoryMeta(kpi.kpi_category).label}</span>
                  <span className={`kpi-traffic kpi-traffic--${badge.light}`}>{badge.label}</span>
                </div>
                <h3>{kpi.name}</h3>
                <dl className="emp-kpi-facts">
                  <div>
                    <dt>Weight</dt>
                    <dd>{formatKpiWeight(kpi.weight)}</dd>
                  </div>
                  <div>
                    <dt>Score</dt>
                    <dd>{formatKpiScore(kpiAssignedScore(kpi))}</dd>
                  </div>
                  <div>
                    <dt>Dates</dt>
                    <dd>{dateRange(kpi.start_date, kpi.end_date)}</dd>
                  </div>
                </dl>
                <KpiAssignmentDetails kpi={kpi} compact />
                <p className="kpi-score-line">
                  {points == null ? 'Points after you mark Complete' : `${points} pts awarded`}
                </p>
                <KpiEvaluationBlock
                  kpi={kpi}
                  compact
                  mode={isReadOnly ? 'manager' : 'employee'}
                  onUpdated={(patch) => {
                    patchKpi(kpi.id, patch);
                  }}
                />
              </article>
            );
          })}
        </div>
      )}
      </div>
  );

  if (isReadOnly) {
    return (
      <div className="dashboard-with-mobile-nav emp-dash dashboard-with-mobile-nav--nested">
        <div className="glass-panel dash-view-banner mobile-banner-row">
          <div>
            <span className="dash-eyebrow" style={{ color: 'var(--color-warning)' }}>Manager View Mode</span>
            <h3>Viewing <strong>{activeUser.full_name}</strong></h3>
          </div>
          <button className="btn btn-secondary" onClick={onBackToLeaderboard}>
            Back to Leaderboard
          </button>
        </div>
        {kpiBoard}
      </div>
    );
  }

  return (
    <div className="admin-shell emp-dash">
      {!hideChangePassword && showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}

      <AdminSidebarNav
        groups={navGroups}
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as typeof activeTab)}
        navOpen={navOpen}
        onNavOpenChange={setNavOpen}
        organizationName={activeUser.full_name}
        brandTitle="Scorr"
        brandSubtitle="Employee workspace"
        ariaLabel="Employee navigation"
        sidebarId="employee-sidebar"
      />

      {navOpen && (
        <div
          className="admin-shell__backdrop admin-shell__backdrop--visible"
          onClick={() => setNavOpen(false)}
          aria-hidden={false}
        />
      )}

      <div className="admin-shell__main">
        <header className="admin-shell__topbar">
          <AdminHamburgerButton
            open={navOpen}
            onClick={() => setNavOpen(!navOpen)}
            controlsId="employee-sidebar"
          />
          <div className="admin-shell__page-head">
            {pageIcon && <div className="admin-shell__page-icon">{pageIcon}</div>}
            <div>
              <p className="admin-shell__page-eyebrow">Employee</p>
              <h1 className="admin-shell__page-title">{pageTitle}</h1>
            </div>
          </div>
        </header>

        <div className="admin-shell__content">
          <div className="admin-shell__panel">
      {activeTab === 'rewards' ? (
        <Suspense fallback={<TabFallback />}>
          <EmployeeRewardsPanel userId={activeUser.id} />
        </Suspense>
      ) : activeTab === 'attendance' ? (
        <Suspense fallback={<TabFallback />}>
        <AttendanceLeavePanel profile={profile} mode={profile.role === 'manager' ? 'manager' : 'employee'} />
        </Suspense>
      ) : activeTab === 'settings' ? (
        <div className="app-settings-stack">
          {!hideChangePassword && (
            <div className="app-settings-block">
              <button type="button" className="btn btn-secondary" onClick={() => setShowChangePassword(true)}>
                <KeyRound size={16} /> Change password
              </button>
            </div>
          )}
          <details className="app-settings-block" open>
            <summary>Daily report</summary>
            <Suspense fallback={<TabFallback />}>
              <DailyWorkReportPanel profile={profile} />
            </Suspense>
          </details>
        </div>
      ) : activeTab === 'kpis' ? (
        kpiBoard
      ) : null}

          </div>
        </div>
      </div>
    </div>
  );
}
