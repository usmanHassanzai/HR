import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { supabase } from '../lib/supabase';
import { isKpiViewedByAssignee, kpiProgressBadge, Profile, Kpi } from '../utils/kpiHelpers';
import { hydrateKpiLastEdits } from '../utils/kpiAssignmentEdits';
import { markAssignedKpisViewed } from '../utils/kpiViewed';
import { RefreshCw, BarChart2, Trophy, KeyRound, CalendarCheck, Settings, Target, Search } from 'lucide-react';
import ExportButton from './ExportButton';
import ChangePasswordModal from './ChangePasswordModal';
import { emailKpiOverdue } from '../utils/kpiEmail';
import KpiAssignmentDetails from './KpiAssignmentDetails';
import TabFallback from './TabFallback';
import AdminSidebarNav, { findAdminNavIcon, type AdminNavGroup } from './AdminSidebarNav';
import AdminHamburgerButton from './AdminHamburgerButton';
import '../styles/admin-dashboard.css';
import '../styles/manager-personal.css';
import { formatKpiWeight, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import {
  availableKpiYears,
  employeeKpiMonthBreakdown,
  formatKpiScore,
  formatKpiTaskPoints,
  isKpiLatePenaltyApplied,
  kpiAssignedScore,
  kpiScoreContribution,
  kpisForPeriod,
  MONTH_OPTIONS,
  performanceRatingColor,
  periodLabel,
  type KpiPeriodMode,
} from '../utils/kpiScoreHelpers';
import { karachiYearMonth, kpiCategoryMeta } from '../utils/kpiCategories';
import { formatLatePenaltyLabel, kpiScoringRule } from '../utils/kpiScoringRules';
import { fetchRewardsSummary, type RewardsSummary } from '../utils/rewardsHelpers';
import KpiEvaluationBlock from './KpiEvaluationBlock';
import '../styles/employee-mobile.css';
import '../styles/employee-kpis.css';

const EmployeeRewardsPanel = lazy(() => import('./EmployeeRewardsPanel'));
const AttendanceLeavePanel = lazy(() => import('./AttendanceLeavePanel'));
const DailyWorkReportPanel = lazy(() => import('./DailyWorkReportPanel'));
const AccountSecurityPanel = lazy(() => import('./AccountSecurityPanel'));
const BackupCodesLowBanner = lazy(() => import('./BackupCodesLowBanner'));

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
  const initialYm = useMemo(() => karachiYearMonth(), []);
  const [periodMode, setPeriodMode] = useState<KpiPeriodMode>('month');
  const [filterYear, setFilterYear] = useState(initialYm.year);
  const [filterMonth, setFilterMonth] = useState(initialYm.monthIndex);
  const [kpiSearch, setKpiSearch] = useState('');
  const [listMode, setListMode] = useState<'open' | 'history'>('open');
  const [rewardsSummary, setRewardsSummary] = useState<RewardsSummary | null>(null);
  const [redemptions, setRedemptions] = useState<{
    id: string;
    points_used: number;
    status: string;
    redeemed_at: string;
    rewards_catalog?: { name: string } | null;
  }[]>([]);

  const fetchRewardsMeta = async () => {
    try {
      const [summary, redemRes] = await Promise.all([
        fetchRewardsSummary(activeUser.id),
        supabase
          .from('reward_redemptions')
          .select('id, points_used, status, redeemed_at, rewards_catalog(name)')
          .eq('employee_id', activeUser.id)
          .order('redeemed_at', { ascending: false })
          .limit(24),
      ]);
      setRewardsSummary(summary);
      setRedemptions((redemRes.data || []) as typeof redemptions);
    } catch (err) {
      console.error(err);
    }
  };

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
      await fetchRewardsMeta();
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

  const years = useMemo(() => availableKpiYears(kpis), [kpis]);

  useEffect(() => {
    if (!years.length) return;
    if (!years.includes(filterYear)) setFilterYear(years[0]);
  }, [years, filterYear]);

  const overallSummary = useMemo(() => employeeKpiMonthBreakdown(kpis), [kpis]);
  const periodKpis = useMemo(
    () => kpisForPeriod(kpis, periodMode, filterYear, filterMonth),
    [kpis, periodMode, filterYear, filterMonth],
  );
  const periodSummary = useMemo(() => employeeKpiMonthBreakdown(periodKpis), [periodKpis]);
  const periodRatingColor = performanceRatingColor(periodSummary.performanceRating);
  const overallRatingColor = performanceRatingColor(overallSummary.performanceRating);
  const selectedLabel = periodLabel(periodMode, filterYear, filterMonth);

  const visibleKpis = useMemo(() => {
    const q = kpiSearch.trim().toLowerCase();
    if (!q) return periodKpis;
    return periodKpis.filter((k) => {
      const hay = `${k.name} ${k.description || ''} ${kpiCategoryMeta(k.kpi_category).label}`.toLowerCase();
      return hay.includes(q);
    });
  }, [periodKpis, kpiSearch]);

  const openKpis = useMemo(
    () => visibleKpis.filter((k) => k.completion_status !== 'completed'),
    [visibleKpis],
  );
  const historyKpis = useMemo(
    () => [...visibleKpis.filter((k) => k.completion_status === 'completed')].sort((a, b) => {
      const aKey = a.completed_at || a.end_date || '';
      const bKey = b.completed_at || b.end_date || '';
      return bKey.localeCompare(aKey);
    }),
    [visibleKpis],
  );
  const listedKpis = listMode === 'history' ? historyKpis : openKpis;

  const patchKpi = (id: string, patch: Partial<Kpi>) => {
    setKpis((prev) => prev.map((k) => (k.id === id ? { ...k, ...patch } : k)));
  };

  const fmtDate = (d?: string | null) => {
    if (!d) return '—';
    return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };

  const fmtFullDate = (iso?: string | null) => {
    if (!iso) return '—';
    const raw = iso.includes('T') ? iso : `${iso.slice(0, 10)}T00:00:00`;
    return new Date(raw).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
  };

  const fmtMonthYear = (iso?: string | null) => {
    if (!iso) return '—';
    const raw = iso.includes('T') ? iso : `${iso.slice(0, 10)}T00:00:00`;
    return new Date(raw).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  };

  const dateRange = (start?: string | null, end?: string | null) => {
    const a = fmtDate(start);
    const b = fmtDate(end);
    if (a === '—' && b === '—') return '—';
    if (a === b) return a;
    return `${a} – ${b}`;
  };

  const monthlyWeightLabel = periodMode === 'month'
    ? 'Monthly KPI weightage'
    : periodMode === 'year'
      ? 'Year KPI weightage'
      : 'Period weightage';
  const periodWeightText = periodKpis.length
    ? `${formatKpiWeight(periodSummary.totalWeight)} of ${KPI_WEIGHT_CAP}%`
    : '—';
  const overallWeightText = kpis.length
    ? `${formatKpiWeight(overallSummary.totalWeight)} of ${KPI_WEIGHT_CAP}%`
    : '—';
  const notRedeemedText = rewardsSummary
    ? rewardsSummary.balance.toLocaleString()
    : '—';
  const redeemedText = rewardsSummary
    ? rewardsSummary.usedPoints.toLocaleString()
    : '—';

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
        <div className="emp-kpi-summary__head">
          <div>
            <span className="emp-kpi-summary__eyebrow">Performance overview</span>
            <h2 className="emp-kpi-summary__title">KPI scoreboard</h2>
            <p className="emp-kpi-summary__formula">
              Score = points awarded ÷ total weight × 100. Each task shows its own scoring rule (for example a late penalty) on the card.
            </p>
          </div>
          <div className="emp-kpi-toolbar">
            <ExportButton kpis={visibleKpis} userName={activeUser.full_name} />
            <button type="button" className="btn btn-secondary" onClick={() => void fetchKpis()} title="Reload" aria-label="Reload KPIs">
              <RefreshCw size={16} />
            </button>
          </div>
        </div>

        <div className="emp-kpi-filter" role="search" aria-label="Filter KPIs by period">
          <div className="emp-kpi-filter__modes" role="tablist" aria-label="Period type">
            <button
              type="button"
              role="tab"
              className={`emp-kpi-filter__mode${periodMode === 'overall' ? ' emp-kpi-filter__mode--active' : ''}`}
              aria-selected={periodMode === 'overall'}
              onClick={() => setPeriodMode('overall')}
            >
              Overall
            </button>
            <button
              type="button"
              role="tab"
              className={`emp-kpi-filter__mode${periodMode === 'month' ? ' emp-kpi-filter__mode--active' : ''}`}
              aria-selected={periodMode === 'month'}
              onClick={() => setPeriodMode('month')}
            >
              Month
            </button>
            <button
              type="button"
              role="tab"
              className={`emp-kpi-filter__mode${periodMode === 'year' ? ' emp-kpi-filter__mode--active' : ''}`}
              aria-selected={periodMode === 'year'}
              onClick={() => setPeriodMode('year')}
            >
              Year
            </button>
          </div>

          {periodMode !== 'overall' && (
            <div className="emp-kpi-filter__selects">
              {periodMode === 'month' && (
                <label className="emp-kpi-filter__field">
                  <span>Month</span>
                  <select
                    value={filterMonth}
                    onChange={(e) => setFilterMonth(Number(e.target.value))}
                    aria-label="Select month"
                  >
                    {MONTH_OPTIONS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="emp-kpi-filter__field">
                <span>Year</span>
                <select
                  value={filterYear}
                  onChange={(e) => setFilterYear(Number(e.target.value))}
                  aria-label="Select year"
                >
                  {years.map((y) => (
                    <option key={y} value={y}>{y}</option>
                  ))}
                </select>
              </label>
            </div>
          )}

          <label className="emp-kpi-filter__search">
            <span>Search</span>
            <div className="emp-kpi-filter__search-box">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={kpiSearch}
                onChange={(e) => setKpiSearch(e.target.value)}
                placeholder="Search KPI name or description…"
                aria-label="Search KPIs"
              />
            </div>
          </label>
        </div>

        <div className="emp-kpi-months">
          <article className="emp-kpi-month emp-kpi-month--current">
            <header>
              <span>Selected period</span>
              <strong>{selectedLabel}</strong>
            </header>
            <div className="emp-kpi-month__score">
              <span className="emp-kpi-month__pct" style={{ color: periodKpis.length ? periodRatingColor : undefined }}>
                {periodKpis.length ? `${formatKpiScore(periodSummary.overallScore)}%` : '—'}
              </span>
              <span className="emp-kpi-month__rating" style={{ color: periodKpis.length ? periodRatingColor : undefined }}>
                {periodKpis.length ? periodSummary.performanceRating : 'No tasks'}
              </span>
            </div>
            <dl className="emp-kpi-month__stats">
              <div>
                <dt>{monthlyWeightLabel}</dt>
                <dd>{periodWeightText}</dd>
              </div>
              <div>
                <dt>Points awarded</dt>
                <dd>{periodKpis.length ? formatKpiScore(periodSummary.pointsAwarded) : '—'}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{periodKpis.length ? `${periodSummary.completed}/${periodSummary.kpiCount}` : '—'}</dd>
              </div>
              <div>
                <dt>Open weightage</dt>
                <dd>{periodKpis.length ? formatKpiWeight(periodSummary.openWeight) : '—'}</dd>
              </div>
            </dl>
          </article>

          <article className="emp-kpi-month">
            <header>
              <span>Overall</span>
              <strong>All assigned KPIs</strong>
            </header>
            <div className="emp-kpi-month__score">
              <span className="emp-kpi-month__pct" style={{ color: kpis.length ? overallRatingColor : undefined }}>
                {kpis.length ? `${formatKpiScore(overallSummary.overallScore)}%` : '—'}
              </span>
              <span className="emp-kpi-month__rating" style={{ color: kpis.length ? overallRatingColor : undefined }}>
                {kpis.length ? overallSummary.performanceRating : 'No tasks'}
              </span>
            </div>
            <dl className="emp-kpi-month__stats">
              <div>
                <dt>Overall KPI weightage</dt>
                <dd>{overallWeightText}</dd>
              </div>
              <div>
                <dt>Points awarded</dt>
                <dd>{kpis.length ? formatKpiScore(overallSummary.pointsAwarded) : '—'}</dd>
              </div>
              <div>
                <dt>Points not redeemed</dt>
                <dd>{notRedeemedText}</dd>
              </div>
              <div>
                <dt>Points redeemed</dt>
                <dd>{redeemedText}</dd>
              </div>
            </dl>
            {rewardsSummary && (
              <p className="emp-kpi-month__note">
                Reward points stay available until you redeem them
                {rewardsSummary.totalEarned > 0
                  ? ` · ${rewardsSummary.totalEarned.toLocaleString()} earned lifetime`
                  : ''}
                .
              </p>
            )}
          </article>
        </div>

        <div className="emp-kpi-summary__meta">
          <div className="emp-kpi-summary__chip">
            <span>Period tasks</span>
            <strong>{periodKpis.length}</strong>
          </div>
          <div className="emp-kpi-summary__chip">
            <span>Open</span>
            <strong>{openKpis.length}</strong>
          </div>
          <div className="emp-kpi-summary__chip">
            <span>In history</span>
            <strong>{historyKpis.length}</strong>
          </div>
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
      ) : visibleKpis.length === 0 ? (
        <div className="emp-kpi-empty glass-panel">
          <Target size={32} strokeWidth={1.5} />
          <h3>No KPIs in this period</h3>
          <p>Try another month or year, switch to Overall, or clear the search.</p>
        </div>
      ) : (
        <div className="emp-kpi-list">
          <div className="emp-kpi-list__head">
            <div>
              <h3>{periodMode === 'overall' ? 'All assigned tasks' : `Tasks · ${selectedLabel}`}</h3>
              <p>
                Each card shows that task&apos;s KPI weightage. Monthly weightage is the sum for the selected period (cap {KPI_WEIGHT_CAP}%).
                Completed tasks move to History with month, year, and date.
              </p>
            </div>
            <div className="emp-kpi-list__modes" role="tablist" aria-label="Open or history">
              <button
                type="button"
                role="tab"
                className={`emp-kpi-list__mode${listMode === 'open' ? ' emp-kpi-list__mode--active' : ''}`}
                aria-selected={listMode === 'open'}
                onClick={() => setListMode('open')}
              >
                Open ({openKpis.length})
              </button>
              <button
                type="button"
                role="tab"
                className={`emp-kpi-list__mode${listMode === 'history' ? ' emp-kpi-list__mode--active' : ''}`}
                aria-selected={listMode === 'history'}
                onClick={() => setListMode('history')}
              >
                History ({historyKpis.length})
              </button>
            </div>
          </div>

          {listedKpis.length === 0 ? (
            <div className="emp-kpi-empty glass-panel emp-kpi-empty--compact">
              <Target size={28} strokeWidth={1.5} />
              <h3>{listMode === 'history' ? 'No completed KPIs yet' : 'No open KPIs'}</h3>
              <p>
                {listMode === 'history'
                  ? 'When you mark tasks Complete, they appear here with month, year, and date. After you redeem reward points, redemptions are listed below.'
                  : 'All tasks in this period are complete — open History to review them.'}
              </p>
            </div>
          ) : (
            listedKpis.map((kpi) => {
            const badge = kpiProgressBadge(kpi);
            const points = formatKpiTaskPoints(kpi);
            const assigned = kpiAssignedScore(kpi);
            const awarded = kpiScoreContribution(kpi);
            const paused = Boolean(kpi.paused_at) && kpi.completion_status !== 'completed';
            const complete = kpi.completion_status === 'completed';
            const latePenalized = isKpiLatePenaltyApplied(kpi);
            const penaltyLabel = formatLatePenaltyLabel(kpiScoringRule(kpi));
            const historyDate = kpi.completed_at || kpi.end_date;
            return (
              <article key={kpi.id} className={`emp-kpi-item kpi-card--${badge.light}${paused ? ' emp-kpi-item--paused' : ''}${complete ? ' emp-kpi-item--history' : ''}`}>
                <div className="emp-kpi-item__top">
                  <div className="emp-kpi-item__tags">
                    <span className="emp-kpi-item__cat">{kpiCategoryMeta(kpi.kpi_category).label}</span>
                    {penaltyLabel ? <span className="emp-kpi-item__rule">{penaltyLabel}</span> : null}
                    {periodMode !== 'overall' && (
                      <span className="emp-kpi-item__scope">{selectedLabel}</span>
                    )}
                    {complete && (
                      <span className="emp-kpi-item__scope">{fmtMonthYear(historyDate)}</span>
                    )}
                  </div>
                  <span className={`kpi-traffic kpi-traffic--${badge.light}`}>{badge.label}</span>
                </div>
                <h3>{kpi.name}</h3>
                <dl className="emp-kpi-facts">
                  <div>
                    <dt>KPI weightage</dt>
                    <dd>{formatKpiWeight(kpi.weight)}</dd>
                  </div>
                  <div>
                    <dt>Score</dt>
                    <dd>{formatKpiScore(assigned)}</dd>
                  </div>
                  <div>
                    <dt>Awarded</dt>
                    <dd>{complete ? formatKpiScore(awarded) : '—'}</dd>
                  </div>
                  <div>
                    <dt>{complete ? 'Completed' : 'Dates'}</dt>
                    <dd>{complete ? fmtFullDate(historyDate) : dateRange(kpi.start_date, kpi.end_date)}</dd>
                  </div>
                </dl>
                {complete && (
                  <div className="emp-kpi-history-meta">
                    <span>Month / year</span>
                    <strong>{fmtMonthYear(historyDate)}</strong>
                    <span>Date</span>
                    <strong>{fmtFullDate(historyDate)}</strong>
                  </div>
                )}
                <div className="emp-kpi-detail">
                  <div className="emp-kpi-detail__row">
                    <span>Timing</span>
                    <strong>
                      {!complete
                        ? 'Open — mark Complete to earn points'
                        : latePenalized
                          ? 'Completed after due date (late penalty applied)'
                          : 'Completed on time (full score)'}
                    </strong>
                  </div>
                  <div className="emp-kpi-detail__row">
                    <span>Contribution</span>
                    <strong>
                      {complete
                        ? `${formatKpiScore(awarded)} pts of ${formatKpiWeight(kpi.weight)} weightage`
                        : `0 pts until Complete (weightage ${formatKpiWeight(kpi.weight)} still counts)`}
                    </strong>
                  </div>
                </div>
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
          })
          )}

          {listMode === 'history' && redemptions.length > 0 && (
            <section className="emp-kpi-redeem-history">
              <h3>Redeemed rewards</h3>
              <p>Points you already redeemed. Open tasks and unredeemed balance stay on the Overview and Open tabs.</p>
              <ul>
                {redemptions.map((r) => (
                  <li key={r.id}>
                    <div>
                      <strong>{r.rewards_catalog?.name || 'Reward'}</strong>
                      <span>{fmtFullDate(r.redeemed_at)} · {fmtMonthYear(r.redeemed_at)}</span>
                    </div>
                    <em>−{Number(r.points_used).toLocaleString()} pts · {r.status}</em>
                  </li>
                ))}
              </ul>
            </section>
          )}
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
        <Suspense fallback={<TabFallback />}>
        <div className="app-settings-stack">
          <BackupCodesLowBanner />
          {!hideChangePassword && (
            <div className="app-settings-block">
              <button type="button" className="btn btn-secondary" onClick={() => setShowChangePassword(true)}>
                <KeyRound size={16} /> Change password
              </button>
            </div>
          )}
          <details className="app-settings-block" open>
            <summary>Account security (2FA recovery)</summary>
            <AccountSecurityPanel fullName={activeUser.full_name} />
          </details>
          <details className="app-settings-block" open>
            <summary>Daily report</summary>
            <DailyWorkReportPanel profile={profile} />
          </details>
        </div>
        </Suspense>
      ) : activeTab === 'kpis' ? (
        kpiBoard
      ) : null}

          </div>
        </div>
      </div>
    </div>
  );
}
