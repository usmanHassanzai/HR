import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { isKpiViewedByAssignee, kpiProgressBadge, Profile, Kpi } from '../utils/kpiHelpers';
import { hydrateKpiLastEdits } from '../utils/kpiAssignmentEdits';
import { markAssignedKpisViewed } from '../utils/kpiViewed';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import {
  employeeKpiScoreSummary,
  formatKpiScore,
  performanceRatingColor,
  formatKpiTaskPoints,
  thisMonthKpis,
} from '../utils/kpiScoreHelpers';
import { emailKpiOverdue } from '../utils/kpiEmail';
import KpiAssignmentDetails from './KpiAssignmentDetails';
import KpiViewedBadge from './KpiViewedBadge';
import KpiEvaluationBlock from './KpiEvaluationBlock';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import { Loader2, Target } from 'lucide-react';
import '../styles/manager-personal.css';

interface ManagerPersonalPanelProps {
  profile: Profile;
}

function fmtDate(d?: string | null): string {
  return d ? new Date(`${d}T00:00:00`).toLocaleDateString() : '—';
}

export default function ManagerPersonalPanel({ profile }: ManagerPersonalPanelProps) {
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const kpiRes = await supabase.from('kpis').select('*').eq('user_id', profile.id).order('created_at', { ascending: true });
      if (!kpiRes.error) setKpis(await hydrateKpiLastEdits((kpiRes.data as Kpi[]) || []));
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
    supabase.rpc('check_overdue_kpis').then(({ data }) => {
      (data || []).forEach((row: { emp_email?: string; emp_name?: string; department?: string; end_date?: string; redo_count?: number }) => {
        if (row.emp_email) {
          emailKpiOverdue(row.emp_email, row.emp_name || profile.full_name, row.department || '', row.end_date || '', row.redo_count || 0);
        }
      });
    });

    const subscription = supabase
      .channel(`mgr-personal:kpis:${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'kpis' }, () => {
        void load({ silent: true });
      })
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [load, profile.full_name, profile.id]);

  const monthKpis = thisMonthKpis(kpis);
  const summary = employeeKpiScoreSummary(monthKpis);
  const ratingColor = performanceRatingColor(summary.performanceRating);

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
      <div className="mgr-personal-stats">
        <div className="mgr-personal-stat mgr-personal-stat--accent">
          <span className="mgr-personal-stat__label">This month</span>
          <strong>{formatKpiScore(summary.overallScore)}%</strong>
        </div>
        <div className="mgr-personal-stat">
          <span className="mgr-personal-stat__label">Band</span>
          <strong style={{ color: ratingColor }}>{summary.performanceRating}</strong>
        </div>
        <div className="mgr-personal-stat">
          <span className="mgr-personal-stat__label">Done</span>
          <strong>{summary.completed} / {monthKpis.length || 0}</strong>
        </div>
      </div>

      {kpis.length === 0 ? (
        <div className="mgr-personal-empty">
          <Target size={36} strokeWidth={1.25} />
          <h4>No KPIs assigned to you</h4>
          <p>When an admin assigns you a KPI, it will show here.</p>
        </div>
      ) : (
        <div className="mgr-personal-kpi-grid">
          {kpis.map((kpi) => {
            const badge = kpiProgressBadge(kpi);
            const points = formatKpiTaskPoints(kpi);
            return (
              <article key={kpi.id} className={`mgr-personal-kpi-card mgr-personal-kpi-card--${badge.light}`}>
                <div className="mgr-personal-kpi-card__head">
                  <span className="mgr-personal-kpi-card__dept">{kpiCategoryMeta(kpi.kpi_category).label}</span>
                  <span className={`kpi-traffic kpi-traffic--${badge.light}`}>{badge.label}</span>
                </div>
                <h4>{kpi.name}</h4>
                <span className="dept-weight-badge">{formatKpiWeight(kpi.weight)}</span>
                <KpiViewedBadge kpi={kpi} />
                <KpiAssignmentDetails kpi={kpi} />
                <p className="mgr-personal-kpi-card__score">
                  {points == null ? 'Not complete yet' : `${points} performance pts`}
                  {' · '}
                  {fmtDate(kpi.start_date)} → {fmtDate(kpi.end_date)}
                </p>
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
