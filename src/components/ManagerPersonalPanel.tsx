import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isKpiViewedByAssignee, kpiProgressBadge, Profile, Kpi } from '../utils/kpiHelpers';
import { hydrateKpiLastEdits } from '../utils/kpiAssignmentEdits';
import { markAssignedKpisViewed } from '../utils/kpiViewed';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { isKpiLatePenaltyApplied } from '../utils/kpiScoreHelpers';
import { emailKpiOverdue } from '../utils/kpiEmail';
import { runOverdueKpiCheckOnce } from '../utils/overdueKpiCheck';
import KpiAssignmentDetails from './KpiAssignmentDetails';
import KpiViewedBadge from './KpiViewedBadge';
import KpiEvaluationBlock from './KpiEvaluationBlock';
import KpiScoreboardSummary from './KpiScoreboardSummary';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import { formatLatePenaltyLabel, kpiScoringRule } from '../utils/kpiScoringRules';
import { fetchRewardsSummary, type RewardsSummary } from '../utils/rewardsHelpers';
import { Loader2, Target } from 'lucide-react';
import '../styles/manager-personal.css';
import '../styles/employee-kpis.css';

interface ManagerPersonalPanelProps {
  profile: Profile;
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function dateRange(start?: string | null, end?: string | null): string {
  const a = fmtDate(start);
  const b = fmtDate(end);
  if (a === '—' && b === '—') return '—';
  if (a === b) return a;
  return `${a} – ${b}`;
}

export default function ManagerPersonalPanel({ profile }: ManagerPersonalPanelProps) {
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [rewardsSummary, setRewardsSummary] = useState<RewardsSummary | null>(null);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [kpiRes, rewards] = await Promise.all([
        supabase.from('kpis').select('*').eq('user_id', profile.id).order('created_at', { ascending: true }),
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
      const now = new Date().toISOString();
      setKpis((prev) => prev.map((k) => (
        ids.includes(k.id)
          ? {
              ...k,
              viewed_at: k.viewed_at || now,
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
      <KpiScoreboardSummary
        kpis={kpis}
        userId={profile.id}
        rewardsSummary={rewardsSummary}
        title="My KPI scoreboard"
      />

      {kpis.length === 0 ? (
        <div className="mgr-personal-empty">
          <Target size={36} strokeWidth={1.25} />
          <h4>No KPIs assigned to you</h4>
          <p>When an admin assigns you a KPI, it will show here.</p>
        </div>
      ) : (
        <div className="mgr-personal-kpi-grid emp-kpi-list">
          <div className="emp-kpi-list__head" style={{ marginBottom: '0.75rem' }}>
            <div>
              <h3>Your assigned tasks</h3>
              <p>Each card shows KPI weightage (0–100%). Complete tasks to achieve weightage toward rewards.</p>
            </div>
          </div>
          {kpis.map((kpi) => {
            const badge = kpiProgressBadge(kpi);
            const complete = kpi.completion_status === 'completed';
            const latePenalized = isKpiLatePenaltyApplied(kpi);
            const penaltyLabel = formatLatePenaltyLabel(kpiScoringRule(kpi));
            return (
              <article key={kpi.id} className={`emp-kpi-item kpi-card--${badge.light}`}>
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
                    <dd>{complete ? formatKpiWeight(kpi.weight) : '—'}</dd>
                  </div>
                  <div>
                    <dt>Dates</dt>
                    <dd>{dateRange(kpi.start_date, kpi.end_date)}</dd>
                  </div>
                </dl>
                <p className="kpi-score-line">
                  {complete
                    ? `Weightage achieved ${formatKpiWeight(kpi.weight)}${latePenalized ? ' (late)' : ''}`
                    : 'Weightage after you mark Complete'}
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
          })}
        </div>
      )}
    </div>
  );
}
