import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { KpiAwardProgress } from '../utils/kpiAwardHelpers';
import KpiAwardProgressList from './KpiAwardProgressList';
import { Gift, Loader2, Trophy, TrendingUp } from 'lucide-react';
import { tierColorForScore } from '../utils/rewardsTiers';
import '../styles/employee-rewards.css';

interface EmployeeRewardsPanelProps {
  userId: string;
  kpiPoints?: number | null;
}

interface MilestoneRow {
  id: string;
  rule_key: string;
  reward_name: string;
  status: string;
  period_end: string;
}

function milestoneStatusLabel(status: string): string {
  if (status === 'approved') return 'Approved — being arranged';
  if (status === 'issued' || status === 'fulfilled') return 'Delivered';
  return 'Pending approval';
}

function statusClass(status: string): string {
  if (status === 'pending' || status === 'pending_fulfillment') return 'emp-rewards-status emp-rewards-status--pending';
  if (status === 'approved') return 'emp-rewards-status emp-rewards-status--approved';
  return 'emp-rewards-status emp-rewards-status--fulfilled';
}

export default function EmployeeRewardsPanel({ userId }: EmployeeRewardsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [awardProgress, setAwardProgress] = useState<KpiAwardProgress[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const [thisMonthScore, setThisMonthScore] = useState<number | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const thisMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    const [awardRes, mileRes, ledgerRes] = await Promise.all([
      supabase.rpc('get_kpi_award_progress', { p_user_id: userId }),
      supabase
        .from('kpi_award_qualifications')
        .select('id, rule_key, reward_name, status, period_end')
        .eq('employee_id', userId)
        .order('created_at', { ascending: false }),
      supabase
        .from('points_ledger')
        .select('month, kpi_score')
        .eq('employee_id', userId)
        .order('month', { ascending: false })
        .limit(12),
    ]);
    if (awardRes.data) setAwardProgress(awardRes.data as KpiAwardProgress[]);
    if (mileRes.data) setMilestones(mileRes.data as MilestoneRow[]);
    const monthRow = (ledgerRes.data || []).find((r: { month: string }) => String(r.month).startsWith(thisMonthKey));
    setThisMonthScore(monthRow ? Number(monthRow.kpi_score) : null);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  if (loading && awardProgress.length === 0 && milestones.length === 0) {
    return (
      <div className="emp-rewards-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading rewards…</span>
      </div>
    );
  }

  return (
    <div className="emp-rewards-page animate-fade-in">
      <header className="emp-rewards-header">
        <div className="emp-rewards-header__main">
          <div className="emp-rewards-header__icon">
            <Trophy size={22} />
          </div>
          <div>
            <h2 className="emp-rewards-header__title">Company rewards</h2>
            <p className="emp-rewards-header__subtitle">
              Hit the KPI score below and the company gives you the gift. No catalog, no points to spend.
            </p>
          </div>
        </div>
        <div className="emp-rewards-stats">
          <div className="emp-rewards-stat emp-rewards-stat--accent">
            <TrendingUp size={16} />
            <span className="emp-rewards-stat__label">This month&apos;s KPI Score</span>
            <strong style={{ color: thisMonthScore != null ? tierColorForScore(thisMonthScore) : undefined }}>
              {thisMonthScore != null ? `${Math.round(thisMonthScore)}%` : '—'}
            </strong>
          </div>
        </div>
      </header>

      <KpiAwardProgressList rows={awardProgress} />

      {milestones.length > 0 && (
        <section className="emp-rewards-card">
          <h3>
            <Gift size={18} /> Your gifts
          </h3>
          <p>When you qualify, your manager or admin approves and arranges delivery.</p>
          <div className="emp-rewards-redemption-list">
            {milestones.map((m) => (
              <article key={m.id} className="emp-rewards-redemption">
                <div className="emp-rewards-redemption__body">
                  <strong>{m.reward_name}</strong>
                  <span>
                    {new Date(m.period_end).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}
                  </span>
                </div>
                <span className={statusClass(m.status)}>{milestoneStatusLabel(m.status)}</span>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
