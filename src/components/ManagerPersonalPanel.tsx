import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi, calculateHealthScore } from '../utils/kpiHelpers';
import { fetchRewardsSummary, RewardsSummary } from '../utils/rewardsHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { kpiAchievedPct, kpiScoreContribution, statusTrafficLight, trafficLightLabel } from '../utils/kpiScoreHelpers';
import { emailKpiCompleted, emailKpiOverdue } from '../utils/kpiEmail';
import EmployeeKpiBoardSummary from './EmployeeKpiBoardSummary';
import TaskList from './TaskList';
import ExportButton from './ExportButton';
import RewardsTab from './RewardsTab';
import {
  BarChart3,
  BarChart2,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Sparkles,
  Target,
  Trophy,
  TrendingUp,
} from 'lucide-react';
import '../styles/manager-personal.css';

interface ManagerPersonalPanelProps {
  profile: Profile;
}

type PersonalTab = 'kpis' | 'rewards';

function healthStatusText(score: number): string {
  if (score >= 80) return 'Excellent';
  if (score >= 50) return 'Needs improvement';
  return 'Critical attention';
}

function healthStatusColor(score: number): string {
  if (score >= 80) return 'var(--color-success)';
  if (score >= 50) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

function fmtDate(d?: string | null): string {
  return d ? new Date(`${d}T00:00:00`).toLocaleDateString() : '—';
}

export default function ManagerPersonalPanel({ profile }: ManagerPersonalPanelProps) {
  const [activeTab, setActiveTab] = useState<PersonalTab>('kpis');
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [persistedHealthScore, setPersistedHealthScore] = useState<number | null>(null);
  const [rewards, setRewards] = useState<RewardsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [completingId, setCompletingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [kpiRes, userRes, rewardsSummary] = await Promise.all([
        supabase.from('kpis').select('*').eq('user_id', profile.id).order('created_at', { ascending: true }),
        supabase.from('users').select('health_score').eq('id', profile.id).single(),
        fetchRewardsSummary(profile.id),
      ]);

      if (!kpiRes.error) setKpis(kpiRes.data || []);
      if (userRes.data?.health_score != null) setPersistedHealthScore(Number(userRes.data.health_score));
      setRewards(rewardsSummary);
    } finally {
      setLoading(false);
    }
  }, [profile.id]);

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
        void load();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [load, profile.full_name, profile.id]);

  const healthScore = persistedHealthScore ?? calculateHealthScore(kpis);
  const completedCount = kpis.filter((k) => k.completion_status === 'completed').length;
  const onTrackCount = kpis.filter((k) => k.status === 'on_track').length;
  const atRiskCount = kpis.filter((k) => k.status === 'at_risk').length;
  const offTrackCount = kpis.filter((k) => k.status === 'off_track').length;

  const handleCompleteKpi = async (kpiId: string) => {
    setCompletingId(kpiId);
    try {
      const { data, error } = await supabase.rpc('complete_kpi_employee', { p_kpi_id: kpiId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.manager_email) {
        await emailKpiCompleted(row.manager_email, row.manager_name, profile.full_name, row.department);
      }
      await load();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : 'Could not mark complete.';
      alert(message);
    } finally {
      setCompletingId(null);
    }
  };

  if (loading && kpis.length === 0 && !rewards) {
    return (
      <div className="mgr-personal-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading your KPIs &amp; points…</span>
      </div>
    );
  }

  return (
    <div className="mgr-personal-page animate-fade-in">
      <header className="mgr-personal-header">
        <div className="mgr-personal-header__main">
          <div className="mgr-personal-header__icon">
            <BarChart3 size={22} />
          </div>
          <div>
            <h2 className="mgr-personal-header__title">My KPIs &amp; Points</h2>
            <p className="mgr-personal-header__subtitle">
              Track your own performance tasks, health score, and rewards balance — separate from your team
              management views.
            </p>
          </div>
        </div>

        <div className="mgr-personal-stats">
          <div className="mgr-personal-stat mgr-personal-stat--accent">
            <TrendingUp size={16} />
            <span className="mgr-personal-stat__label">Performance index</span>
            <strong style={{ color: healthStatusColor(healthScore) }}>{healthScore}%</strong>
          </div>
          <div className="mgr-personal-stat">
            <Target size={16} />
            <span className="mgr-personal-stat__label">Active KPIs</span>
            <strong>{kpis.length}</strong>
          </div>
          <div className="mgr-personal-stat mgr-personal-stat--success">
            <CheckCircle2 size={16} />
            <span className="mgr-personal-stat__label">Completed</span>
            <strong>{completedCount}</strong>
          </div>
          <div className="mgr-personal-stat mgr-personal-stat--gold">
            <Trophy size={16} />
            <span className="mgr-personal-stat__label">Points balance</span>
            <strong>{rewards?.balance.toLocaleString() ?? '—'}</strong>
          </div>
        </div>
      </header>

      <div className="mgr-personal-tabs tab-bar tab-bar--inline-mobile">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'kpis' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('kpis')}
        >
          <BarChart2 size={16} /> My KPIs
          {kpis.length > 0 && <span className="mgr-personal-tab-badge">{kpis.length}</span>}
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'rewards' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('rewards')}
        >
          <Trophy size={16} /> Rewards &amp; Points
          {rewards?.canRedeem && <span className="mgr-personal-tab-badge mgr-personal-tab-badge--gold">Redeem</span>}
        </button>
      </div>

      {activeTab === 'kpis' ? (
        <>
          <div className="mgr-personal-overview">
            <section className="mgr-personal-card mgr-personal-health">
              <div
                className="mgr-personal-health__ring"
                style={{
                  borderColor: healthStatusColor(healthScore),
                  boxShadow: `0 0 24px color-mix(in srgb, ${healthStatusColor(healthScore)} 30%, transparent)`,
                }}
              >
                <span className="mgr-personal-health__value">{healthScore}%</span>
              </div>
              <div>
                <span className="mgr-personal-health__eyebrow">Overall performance</span>
                <h3>{healthStatusText(healthScore)}</h3>
                <p>
                  Based on {kpis.length} assigned KPI{kpis.length !== 1 ? 's' : ''}. Complete each task before its
                  deadline to protect your score and earn monthly points.
                </p>
              </div>
            </section>

            <section className="mgr-personal-card mgr-personal-metrics">
              <div className="mgr-personal-metric">
                <span>Completed</span>
                <strong className="mgr-personal-metric--accent">
                  {completedCount} / {kpis.length}
                </strong>
              </div>
              <div className="mgr-personal-metric">
                <span>On track</span>
                <strong className="mgr-personal-metric--success">{onTrackCount}</strong>
              </div>
              <div className="mgr-personal-metric">
                <span>At risk</span>
                <strong className="mgr-personal-metric--warn">{atRiskCount}</strong>
              </div>
              <div className="mgr-personal-metric">
                <span>Off track</span>
                <strong className="mgr-personal-metric--danger">{offTrackCount}</strong>
              </div>
            </section>

            <section className="mgr-personal-card mgr-personal-points-mini">
              <span className="mgr-personal-points-mini__eyebrow">
                <Trophy size={14} /> Rewards balance
              </span>
              <div className="mgr-personal-points-mini__balance">{rewards?.balance.toLocaleString() ?? '0'}</div>
              <p>
                {rewards?.thisMonthPoints != null ? `+${rewards.thisMonthPoints} pts this month` : 'No points this month yet'}
                {rewards?.canRedeem && <span className="mgr-personal-points-mini__badge"> · Redeem available</span>}
              </p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => setActiveTab('rewards')}>
                View rewards catalog
              </button>
            </section>
          </div>

          <EmployeeKpiBoardSummary kpis={kpis} />

          <section className="mgr-personal-card">
            <div className="mgr-personal-card__head">
              <h3>
                <BarChart2 size={18} /> My KPI tasks
              </h3>
              <div className="mgr-personal-card__actions">
                <ExportButton kpis={kpis} userName={profile.full_name} />
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} title="Reload">
                  <RefreshCw size={14} />
                </button>
              </div>
            </div>

            {loading ? (
              <div className="mgr-personal-loading mgr-personal-loading--inline">
                <Loader2 size={24} className="spin-icon" />
              </div>
            ) : kpis.length === 0 ? (
              <div className="mgr-personal-empty">
                <Target size={36} strokeWidth={1.25} />
                <h4>No KPIs assigned yet</h4>
                <p>When your admin assigns you personal KPI tasks, they will appear here.</p>
              </div>
            ) : (
              <div className="mgr-personal-kpi-grid">
                {kpis.map((kpi) => {
                  const light = statusTrafficLight(kpi.completion_status === 'completed' ? 'completed' : kpi.status);
                  const achieved = kpiAchievedPct(kpi);
                  const contribution = kpiScoreContribution(kpi);
                  return (
                    <article key={kpi.id} className={`mgr-personal-kpi-card mgr-personal-kpi-card--${light}`}>
                      <div className="mgr-personal-kpi-card__head">
                        <span className="mgr-personal-kpi-card__dept">{kpi.department || kpi.category || 'General'}</span>
                        <span className={`kpi-traffic kpi-traffic--${light}`}>{trafficLightLabel(light)}</span>
                      </div>
                      <h4>{kpi.name}</h4>
                      <span className="dept-weight-badge">{formatKpiWeight(kpi.weight)} weight</span>
                      {kpi.ai_narrative ? (
                        <p className="mgr-personal-kpi-card__note">
                          <Sparkles size={12} />
                          <span>{kpi.ai_narrative}</span>
                        </p>
                      ) : kpi.description ? (
                        <p className="mgr-personal-kpi-card__desc">{kpi.description}</p>
                      ) : null}
                      <p className="mgr-personal-kpi-card__score">
                        {achieved}% achieved × {formatKpiWeight(kpi.weight)} = <strong>{contribution} pts</strong>
                      </p>
                      <div className="mgr-personal-kpi-card__foot">
                        <div>
                          <span className="kpi-date-label">Start → End</span>
                          <div className="kpi-dates">
                            {fmtDate(kpi.start_date)} → {fmtDate(kpi.end_date)}
                          </div>
                          {(kpi.redo_count ?? 0) > 0 && (
                            <span className="mgr-personal-kpi-card__redo">Missed deadlines: {kpi.redo_count}/3</span>
                          )}
                        </div>
                        {kpi.completion_status !== 'completed' && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={completingId === kpi.id}
                            onClick={() => void handleCompleteKpi(kpi.id)}
                          >
                            <CheckCircle2 size={14} />
                            {completingId === kpi.id ? 'Saving…' : 'Mark complete'}
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <div className="mgr-personal-bottom-grid">
            <section className="mgr-personal-card">
              <TaskList userId={profile.id} />
            </section>
            <section className="mgr-personal-card mgr-personal-guide">
              <h3>KPI status guide</h3>
              <p>
                KPIs are assigned with start and end dates. Complete before the deadline — three missed deadlines
                deduct 300 points from your rewards balance.
              </p>
              <ul>
                <li>
                  <span className="badge badge-on-track">ON TRACK</span>
                  <span>Completed on time or progressing well.</span>
                </li>
                <li>
                  <span className="badge badge-at-risk">AT RISK</span>
                  <span>In progress with an approaching deadline.</span>
                </li>
                <li>
                  <span className="badge badge-off-track">OFF TRACK</span>
                  <span>Past end date without completion.</span>
                </li>
              </ul>
            </section>
          </div>
        </>
      ) : (
        <section className="mgr-personal-rewards-wrap">
          <RewardsTab userId={profile.id} viewerRole="manager" embedded />
        </section>
      )}
    </div>
  );
}
