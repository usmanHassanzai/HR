import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isKpiViewedByAssignee, kpiProgressBadge, Profile, Kpi } from '../utils/kpiHelpers';
import { hydrateKpiLastEdits } from '../utils/kpiAssignmentEdits';
import { markAssignedKpisViewed } from '../utils/kpiViewed';
import { formatKpiWeight, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import {
  completedKpisForPeriod,
  groupCompletedKpisByMonth,
  isKpiLatePenaltyApplied,
  kpisForPeriod,
  periodLabel,
  type KpiPeriodMode,
} from '../utils/kpiScoreHelpers';
import { displayedAwardedWeightage } from '../utils/weightageReveal';
import { emailKpiOverdue } from '../utils/kpiEmail';
import { runOverdueKpiCheckOnce } from '../utils/overdueKpiCheck';
import KpiAssignmentDetails from './KpiAssignmentDetails';
import KpiViewedBadge from './KpiViewedBadge';
import KpiEvaluationBlock from './KpiEvaluationBlock';
import KpiScoreboardSummary from './KpiScoreboardSummary';
import AssignedTaskHistory from './AssignedTaskHistory';
import { karachiYearMonth, kpiCategoryMeta } from '../utils/kpiCategories';
import { formatLatePenaltyLabel, kpiScoringRule } from '../utils/kpiScoringRules';
import { fetchRewardsSummary, type RewardsSummary } from '../utils/rewardsHelpers';
import {
  BarChart2,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  Search,
  Target,
} from 'lucide-react';
import '../styles/manager-personal.css';
import '../styles/employee-kpis.css';
import { scrollNavTarget } from '../utils/notificationDeepLink';

interface ManagerPersonalPanelProps {
  profile: Profile;
  focusKpiId?: string | null;
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function fmtFullDate(iso?: string | null): string {
  if (!iso) return '—';
  const raw = iso.includes('T') ? iso : `${iso.slice(0, 10)}T00:00:00`;
  return new Date(raw).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function dateRange(start?: string | null, end?: string | null): string {
  const a = fmtDate(start);
  const b = fmtDate(end);
  if (a === '—' && b === '—') return '—';
  if (a === b) return a;
  return `${a} – ${b}`;
}

export default function ManagerPersonalPanel({ profile, focusKpiId }: ManagerPersonalPanelProps) {
  const now = karachiYearMonth();
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [rewardsSummary, setRewardsSummary] = useState<RewardsSummary | null>(null);
  const [periodMode, setPeriodMode] = useState<KpiPeriodMode>('month');
  const [filterMonth, setFilterMonth] = useState(now.monthIndex);
  const [filterYear, setFilterYear] = useState(now.year);
  const [listMode, setListMode] = useState<'open' | 'history'>('open');
  const [kpiSearch, setKpiSearch] = useState('');

  useEffect(() => {
    if (!focusKpiId || !kpis.length) return;
    const hit = kpis.find((k) => k.id === focusKpiId);
    if (!hit) return;
    setListMode(hit.completion_status === 'completed' ? 'history' : 'open');
    setPeriodMode('overall');
    scrollNavTarget(focusKpiId);
  }, [focusKpiId, kpis]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [kpiRes, rewards] = await Promise.all([
        supabase.from('kpis').select('*').eq('user_id', profile.id).order('created_at', { ascending: false }),
        fetchRewardsSummary(profile.id).catch(() => null),
      ]);
      if (!kpiRes.error) setKpis(await hydrateKpiLastEdits((kpiRes.data as Kpi[]) || []));
      setRewardsSummary(rewards);
    } finally {
      setLoading(false);
    }
  }, [profile.id]);

  useEffect(() => {
    const ids = kpis.filter((k) => !isKpiViewedByAssignee(k)).map((k) => k.id);
    if (!ids.length) return;
    let cancelled = false;
    void markAssignedKpisViewed(ids).then(() => {
      if (cancelled) return;
      const nowIso = new Date().toISOString();
      setKpis((prev) => prev.map((k) => (
        ids.includes(k.id)
          ? {
              ...k,
              viewed_at: k.viewed_at || nowIso,
              viewed_by: k.viewed_by || profile.id,
              employee_progress: k.employee_progress === 'completed' || k.completion_status === 'completed'
                ? k.employee_progress
                : 'started',
            }
          : k
      )));
    });
    return () => { cancelled = true; };
  }, [kpis, profile.id]);

  useEffect(() => {
    void load();
    runOverdueKpiCheckOnce((rows) => {
      rows.forEach((row) => {
        if (row.emp_email) {
          emailKpiOverdue(row.emp_email, row.emp_name || profile.full_name, row.department || '', row.end_date || '', row.redo_count || 0);
        }
      });
    });

    const subscription = supabase
      .channel(`mgr-personal:kpis:${profile.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'kpis', filter: `user_id=eq.${profile.id}` },
        () => {
          void load({ silent: true });
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [load, profile.full_name, profile.id]);

  const periodKpis = useMemo(
    () => kpisForPeriod(kpis, periodMode, filterYear, filterMonth),
    [kpis, periodMode, filterYear, filterMonth],
  );
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
    () =>
      [...visibleKpis.filter((k) => k.completion_status !== 'completed')].sort((a, b) =>
        (b.created_at || '').localeCompare(a.created_at || ''),
      ),
    [visibleKpis],
  );
  const historyKpis = useMemo(() => {
    const q = kpiSearch.trim().toLowerCase();
    let list = completedKpisForPeriod(kpis, periodMode, filterYear, filterMonth);
    if (q) {
      list = list.filter((k) => {
        const hay = `${k.name} ${k.description || ''} ${kpiCategoryMeta(k.kpi_category).label}`.toLowerCase();
        return hay.includes(q);
      });
    }
    return [...list].sort((a, b) => {
      const aKey = a.completed_at || a.end_date || '';
      const bKey = b.completed_at || b.end_date || '';
      return bKey.localeCompare(aKey);
    });
  }, [kpis, periodMode, filterYear, filterMonth, kpiSearch]);
  const historyGroups = useMemo(() => groupCompletedKpisByMonth(historyKpis), [historyKpis]);
  const listedKpis = listMode === 'history' ? historyKpis : openKpis;
  const awaitingCount = openKpis.filter((k) => k.completion_status === 'pending_review').length;
  const firstName = profile.full_name.trim().split(/\s+/)[0] || 'there';

  if (loading && kpis.length === 0) {
    return (
      <div className="mgr-personal-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading your KPIs…</span>
      </div>
    );
  }

  return (
    <div className="mgr-personal-page">
      <header className="mgr-my-kpis-hero glass-panel">
        <div className="mgr-my-kpis-hero__main">
          <div className="mgr-my-kpis-hero__icon" aria-hidden="true">
            <BarChart2 size={22} strokeWidth={2.25} />
          </div>
          <div>
            <p className="mgr-my-kpis-hero__eyebrow">Personal workspace</p>
            <h2 className="mgr-my-kpis-hero__title">My KPIs</h2>
            <p className="mgr-my-kpis-hero__subtitle">
              Hello {firstName} — track tasks assigned to you, submit work for review, and see awarded weightage once approved.
            </p>
          </div>
        </div>
        <div className="mgr-my-kpis-hero__stats" role="list">
          <div className="mgr-my-kpis-stat" role="listitem">
            <span className="mgr-my-kpis-stat__icon mgr-my-kpis-stat__icon--open">
              <Target size={15} />
            </span>
            <div>
              <span className="mgr-my-kpis-stat__label">Open</span>
              <strong>{openKpis.length}</strong>
            </div>
          </div>
          <div className="mgr-my-kpis-stat" role="listitem">
            <span className="mgr-my-kpis-stat__icon mgr-my-kpis-stat__icon--review">
              <Clock3 size={15} />
            </span>
            <div>
              <span className="mgr-my-kpis-stat__label">Awaiting review</span>
              <strong>{awaitingCount}</strong>
            </div>
          </div>
          <div className="mgr-my-kpis-stat" role="listitem">
            <span className="mgr-my-kpis-stat__icon mgr-my-kpis-stat__icon--done">
              <CheckCircle2 size={15} />
            </span>
            <div>
              <span className="mgr-my-kpis-stat__label">Approved</span>
              <strong>{historyKpis.length}</strong>
            </div>
          </div>
        </div>
      </header>

      <KpiScoreboardSummary
        kpis={kpis}
        userId={profile.id}
        rewardsSummary={rewardsSummary}
        title="My KPI scoreboard"
        deferAchievedUntilMonthEnd
        period={{ mode: periodMode, month: filterMonth, year: filterYear }}
        onPeriodChange={(next) => {
          setPeriodMode(next.mode);
          setFilterMonth(next.month);
          setFilterYear(next.year);
        }}
        toolbar={(
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => void load()}
            title="Reload"
            aria-label="Reload KPIs"
          >
            <RefreshCw size={16} />
          </button>
        )}
        filterExtra={(
          <label className="emp-kpi-filter__search">
            <span>Search</span>
            <div className="emp-kpi-filter__search-box">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                value={kpiSearch}
                onChange={(e) => setKpiSearch(e.target.value)}
                placeholder="Search task name or category…"
                aria-label="Search KPIs"
              />
            </div>
          </label>
        )}
      />

      {kpis.length === 0 ? (
        <div className="mgr-personal-empty glass-panel">
          <Target size={36} strokeWidth={1.35} />
          <h4>No KPIs assigned to you yet</h4>
          <p>When an admin assigns you a task, it will appear here with weightage, dates, and progress controls.</p>
        </div>
      ) : listMode === 'open' && visibleKpis.length === 0 && historyKpis.length === 0 ? (
        <div className="mgr-personal-empty glass-panel">
          <Target size={36} strokeWidth={1.35} />
          <h4>No tasks in this view</h4>
          <p>Try another period, switch to Overall, or clear the search.</p>
        </div>
      ) : (
        <section className="mgr-my-kpis-list emp-kpi-list">
          <div className="emp-kpi-list__head">
            <div>
              <p className="emp-kpi-list__eyebrow">
                {listMode === 'history' ? 'Archive' : 'Active'}
              </p>
              <h3>
                {listMode === 'history'
                  ? periodMode === 'overall'
                    ? 'Assigned Task History'
                    : `History · ${selectedLabel}`
                  : 'Your assigned tasks'}
              </h3>
              <p>
                {listMode === 'history'
                  ? 'Your approved tasks only, grouped by month. Use Overall / Month / Year above to filter.'
                  : `Mark Complete to submit for review. Weightage (0–${KPI_WEIGHT_CAP}%) is awarded after admin, HR, or your manager approves.`}
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

          {listMode === 'history' ? (
            historyGroups.length === 0 ? (
              <div className="mgr-personal-empty glass-panel mgr-personal-empty--compact">
                <Target size={28} strokeWidth={1.35} />
                <h4>No approved tasks yet</h4>
                <p>
                  After your completed work is reviewed and approved, it will show here by month.
                  Try Overall or another month/year.
                </p>
              </div>
            ) : (
              <AssignedTaskHistory
                groups={historyGroups}
                renderTask={(kpi) => {
                  const badge = kpiProgressBadge(kpi);
                  const latePenalized = isKpiLatePenaltyApplied(kpi);
                  const penaltyLabel = formatLatePenaltyLabel(kpiScoringRule(kpi));
                  const historyDate = kpi.completed_at || kpi.end_date;
                  const revealed = displayedAwardedWeightage(kpi, { deferUntilMonthEnd: true });
                  return (
                    <article
                      key={kpi.id}
                      data-nav-id={kpi.id}
                      className={`emp-kpi-item mgr-my-kpi-card kpi-card--${badge.light} emp-kpi-item--history`}
                    >
                      <div className="emp-kpi-item__top">
                        <div className="emp-kpi-item__tags">
                          <span className="emp-kpi-item__cat">{kpiCategoryMeta(kpi.kpi_category).label}</span>
                          {penaltyLabel ? <span className="emp-kpi-item__rule">{penaltyLabel}</span> : null}
                        </div>
                        <span className={`kpi-traffic kpi-traffic--${badge.light}`}>{badge.label}</span>
                      </div>
                      <h3>{kpi.name}</h3>
                      <KpiViewedBadge kpi={kpi} />
                      <dl className="emp-kpi-facts">
                        <div>
                          <dt>KPI weightage</dt>
                          <dd>{formatKpiWeight(kpi.weight)}</dd>
                        </div>
                        <div>
                          <dt>Achieved</dt>
                          <dd>
                            {revealed != null
                              ? formatKpiWeight(revealed)
                              : 'Posts at month end'}
                          </dd>
                        </div>
                        <div>
                          <dt>Approved</dt>
                          <dd>{fmtFullDate(historyDate)}</dd>
                        </div>
                      </dl>
                      <p className="kpi-score-line">
                        {revealed != null
                          ? `Awarded ${formatKpiWeight(revealed)}${latePenalized ? ' (late)' : ''}`
                          : 'Approved — weightage posts on the last day of the month'}
                      </p>
                      <KpiAssignmentDetails kpi={kpi} />
                    </article>
                  );
                }}
              />
            )
          ) : listedKpis.length === 0 ? (
            <div className="mgr-personal-empty glass-panel mgr-personal-empty--compact">
              <Target size={28} strokeWidth={1.35} />
              <h4>No open tasks</h4>
              <p>
                {visibleKpis.length === 0
                  ? 'Try another period, switch to Overall, or clear the search.'
                  : 'All tasks in this period are approved — open History to review them.'}
              </p>
            </div>
          ) : (
            listedKpis.map((kpi) => {
              const badge = kpiProgressBadge(kpi);
              const awaitingReview = kpi.completion_status === 'pending_review';
              const penaltyLabel = formatLatePenaltyLabel(kpiScoringRule(kpi));
              return (
                <article
                  key={kpi.id}
                  data-nav-id={kpi.id}
                  className={`emp-kpi-item mgr-my-kpi-card kpi-card--${badge.light}${awaitingReview ? ' emp-kpi-item--review' : ''}`}
                >
                  <div className="emp-kpi-item__top">
                    <div className="emp-kpi-item__tags">
                      <span className="emp-kpi-item__cat">{kpiCategoryMeta(kpi.kpi_category).label}</span>
                      {penaltyLabel ? <span className="emp-kpi-item__rule">{penaltyLabel}</span> : null}
                      {awaitingReview ? <span className="emp-kpi-item__rule">Pending review</span> : null}
                    </div>
                    <span className={`kpi-traffic kpi-traffic--${badge.light}`}>{badge.label}</span>
                  </div>
                  <h3>{kpi.name}</h3>
                  <KpiViewedBadge kpi={kpi} />
                  <dl className="emp-kpi-facts">
                    <div>
                      <dt>KPI weightage</dt>
                      <dd>{formatKpiWeight(kpi.weight)}</dd>
                    </div>
                    <div>
                      <dt>Achieved</dt>
                      <dd>{awaitingReview ? 'Awaiting review' : '—'}</dd>
                    </div>
                    <div>
                      <dt>Dates</dt>
                      <dd>{dateRange(kpi.start_date, kpi.end_date)}</dd>
                    </div>
                  </dl>
                  <p className="kpi-score-line">
                    {awaitingReview
                      ? 'Submitted — waiting for review before weightage is awarded'
                      : 'Weightage is awarded after you mark Complete and a reviewer approves'}
                  </p>
                  <KpiAssignmentDetails kpi={kpi} />
                  <KpiEvaluationBlock
                    kpi={kpi}
                    mode="employee"
                    onUpdated={(patch) => {
                      setKpis((prev) => prev.map((k) => (k.id === kpi.id ? { ...k, ...patch } : k)));
                    }}
                  />
                </article>
              );
            })
          )}
        </section>
      )}
    </div>
  );
}
