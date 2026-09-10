import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import type { Kpi } from '../utils/kpiHelpers';
import type { KpiAwardProgress, KpiAwardRuleKey } from '../utils/kpiAwardHelpers';
import {
  coerceAwardWeightage,
  formatAwardWeightage,
} from '../utils/kpiAwardHelpers';
import {
  employeeKpiBoardBreakdown,
  kpisForPeriod,
} from '../utils/kpiScoreHelpers';
import { karachiYearMonth } from '../utils/kpiCategories';
import KpiAwardProgressList from './KpiAwardProgressList';
import WeightageRewardCatalog from './WeightageRewardCatalog';
import { Gift, Loader2, Trophy, TrendingUp } from 'lucide-react';
import '../styles/employee-rewards.css';

interface EmployeeRewardsPanelProps {
  userId: string;
  kpis?: Kpi[];
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

function periodEndMonthKey(periodEnd: string): string {
  return String(periodEnd).slice(0, 7);
}

export default function EmployeeRewardsPanel({ userId, kpis = [] }: EmployeeRewardsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [awardProgress, setAwardProgress] = useState<KpiAwardProgress[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const [thisMonthWeightage, setThisMonthWeightage] = useState<number | null>(null);
  const [redeemingKey, setRedeemingKey] = useState<KpiAwardRuleKey | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const clientMonthWeightage = useMemo(() => {
    if (!kpis.length) return null;
    const { year, monthIndex } = karachiYearMonth();
    const monthKpis = kpisForPeriod(kpis, 'month', year, monthIndex);
    if (!monthKpis.length) return null;
    return employeeKpiBoardBreakdown(monthKpis).weightAchieved;
  }, [kpis]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [awardRes, mileRes] = await Promise.all([
      supabase.rpc('get_kpi_award_progress', { p_user_id: userId }),
      supabase
        .from('kpi_award_qualifications')
        .select('id, rule_key, reward_name, status, period_end')
        .eq('employee_id', userId)
        .order('created_at', { ascending: false }),
    ]);
    const progress = (awardRes.data || []) as KpiAwardProgress[];
    if (awardRes.data) setAwardProgress(progress);
    if (mileRes.data) setMilestones(mileRes.data as MilestoneRow[]);
    const fromProgress = progress.find((r) => r.latest_score != null)?.latest_score;
    setThisMonthWeightage(coerceAwardWeightage(fromProgress, clientMonthWeightage));
    setLoading(false);
  }, [userId, clientMonthWeightage]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (clientMonthWeightage != null) {
      setThisMonthWeightage((prev) => coerceAwardWeightage(prev, clientMonthWeightage));
    }
  }, [clientMonthWeightage]);

  const displayWeightage = coerceAwardWeightage(thisMonthWeightage, clientMonthWeightage);

  const claimedKeys = useMemo(() => {
    const { year, monthIndex } = karachiYearMonth();
    const thisKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const keys = new Set<string>();
    for (const m of milestones) {
      if (m.status === 'dismissed') continue;
      if (periodEndMonthKey(m.period_end) === thisKey) keys.add(m.rule_key);
    }
    return keys;
  }, [milestones]);

  const handleRedeem = useCallback(async (ruleKey: KpiAwardRuleKey) => {
    setRedeemingKey(ruleKey);
    setActionMsg(null);
    const { error } = await supabase.rpc('claim_my_kpi_award', { p_rule_key: ruleKey });
    if (error) {
      setActionMsg({ type: 'err', text: error.message || 'Could not redeem this gift.' });
      setRedeemingKey(null);
      return;
    }
    setActionMsg({ type: 'ok', text: 'Gift requested — your manager or admin will arrange it.' });
    await fetchAll();
    setRedeemingKey(null);
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
              Earn company gifts from weightage streaks, and redeem admin catalog rewards with this month&apos;s weightage.
            </p>
          </div>
        </div>
        <div className="emp-rewards-stats">
          <div className="emp-rewards-stat emp-rewards-stat--accent">
            <TrendingUp size={16} />
            <span className="emp-rewards-stat__label">This month&apos;s weightage</span>
            <strong>
              {formatAwardWeightage(displayWeightage)}
            </strong>
          </div>
        </div>
      </header>

      {actionMsg ? (
        <div className={`emp-rewards-alert emp-rewards-alert--${actionMsg.type === 'ok' ? 'success' : 'error'}`}>
          {actionMsg.text}
        </div>
      ) : null}

      <KpiAwardProgressList
        rows={awardProgress}
        monthWeightage={displayWeightage}
        claimedKeys={claimedKeys}
        onRedeem={handleRedeem}
        redeemingKey={redeemingKey}
      />

      <WeightageRewardCatalog userId={userId} monthWeightage={displayWeightage} />

      {milestones.length > 0 && (
        <section className="emp-rewards-card">
          <h3>
            <Gift size={18} /> Your gifts
          </h3>
          <p>When you redeem, your manager or admin approves and arranges delivery.</p>
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
