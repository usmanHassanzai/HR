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
import {
  fetchMonthWeightageBalance,
  type MonthWeightageBalance,
} from '../utils/monthWeightageBalance';
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
  if (status === 'dismissed' || status === 'rejected') return 'Rejected';
  return 'Pending approval';
}

function statusClass(status: string): string {
  if (status === 'pending' || status === 'pending_fulfillment') return 'emp-rewards-status emp-rewards-status--pending';
  if (status === 'approved') return 'emp-rewards-status emp-rewards-status--approved';
  if (status === 'dismissed' || status === 'rejected') return 'emp-rewards-status emp-rewards-status--rejected';
  return 'emp-rewards-status emp-rewards-status--fulfilled';
}

function periodEndMonthKey(periodEnd: string): string {
  return String(periodEnd).slice(0, 7);
}

export default function EmployeeRewardsPanel({ userId, kpis = [] }: EmployeeRewardsPanelProps) {
  const [loading, setLoading] = useState(true);
  const [awardProgress, setAwardProgress] = useState<KpiAwardProgress[]>([]);
  const [milestones, setMilestones] = useState<MilestoneRow[]>([]);
  const [balance, setBalance] = useState<MonthWeightageBalance>({
    earned: null,
    deducted: 0,
    available: null,
    banked: 0,
  });
  const [redeemingKey, setRedeemingKey] = useState<KpiAwardRuleKey | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);
  const [catalogClaimedThisMonth, setCatalogClaimedThisMonth] = useState(false);

  const clientMonthWeightage = useMemo(() => {
    if (!kpis.length) return null;
    const { year, monthIndex } = karachiYearMonth();
    const monthKpis = kpisForPeriod(kpis, 'month', year, monthIndex);
    if (!monthKpis.length) return null;
    return employeeKpiBoardBreakdown(monthKpis).weightAchieved;
  }, [kpis]);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [awardRes, mileRes, bal, catRes] = await Promise.all([
      supabase.rpc('get_kpi_award_progress', { p_user_id: userId }),
      supabase
        .from('kpi_award_qualifications')
        .select('id, rule_key, reward_name, status, period_end')
        .eq('employee_id', userId)
        .order('created_at', { ascending: false }),
      fetchMonthWeightageBalance(userId),
      supabase
        .from('reward_redemptions')
        .select('redeemed_at, status')
        .eq('employee_id', userId)
        .order('redeemed_at', { ascending: false })
        .limit(20),
    ]);
    const progress = (awardRes.data || []) as KpiAwardProgress[];
    if (awardRes.data) setAwardProgress(progress);
    if (mileRes.data) setMilestones(mileRes.data as MilestoneRow[]);
    setBalance(bal);
    const { year, monthIndex } = karachiYearMonth();
    const thisKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const cats = (catRes.data || []) as { redeemed_at: string; status: string }[];
    setCatalogClaimedThisMonth(
      cats.some(
        (r) =>
          String(r.redeemed_at).slice(0, 7) === thisKey &&
          r.status !== 'rejected',
      ),
    );
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const earnedWeightage = coerceAwardWeightage(balance.earned, clientMonthWeightage);
  const availableWeightage = coerceAwardWeightage(
    balance.available,
    balance.earned != null ? Math.max(0, Number(balance.earned) - Number(balance.deducted || 0)) : null,
  );

  const claimedKeys = useMemo(() => {
    const { year, monthIndex } = karachiYearMonth();
    const thisKey = `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
    const keys = new Set<string>();
    for (const m of milestones) {
      if (m.status === 'dismissed' || m.status === 'rejected') continue;
      if (periodEndMonthKey(m.period_end) === thisKey) keys.add(m.rule_key);
    }
    return keys;
  }, [milestones]);

  const monthMonthlyGiftClaimed = claimedKeys.has('dinner_voucher') || catalogClaimedThisMonth;

  const handleRedeem = useCallback(async (ruleKey: KpiAwardRuleKey, opts?: { useBanked?: boolean }) => {
    setRedeemingKey(ruleKey);
    setActionMsg(null);
    const { error } = await supabase.rpc('claim_my_kpi_award', {
      p_rule_key: ruleKey,
      p_use_banked: Boolean(opts?.useBanked),
    });
    if (error) {
      setActionMsg({ type: 'err', text: error.message || 'Could not redeem this gift.' });
      setRedeemingKey(null);
      return;
    }
    setActionMsg({
      type: 'ok',
      text: opts?.useBanked
        ? 'Gift requested using banked weightage — your manager or admin will arrange it.'
        : 'Gift requested — your manager or admin will arrange it.',
    });
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
              Complete tasks to earn weightage. One monthly gift (dinner or catalog) per month uses the gift cost;
              leftover goes to Banked. When Banked covers a gift&apos;s cost, use Redeem with Banked.
              Movie needs 90–95% for 3 months in a row; surprise needs 90–95% for 6 months in a row.
            </p>
          </div>
        </div>
        <div className="emp-rewards-stats">
          <div className="emp-rewards-stat">
            <TrendingUp size={16} />
            <span className="emp-rewards-stat__label">Earned this month</span>
            <strong>{formatAwardWeightage(earnedWeightage)}</strong>
          </div>
          <div className="emp-rewards-stat emp-rewards-stat--accent">
            <Gift size={16} />
            <span className="emp-rewards-stat__label">Current</span>
            <strong>{formatAwardWeightage(availableWeightage)}</strong>
          </div>
          <div className="emp-rewards-stat">
            <span className="emp-rewards-stat__label">Used on gifts</span>
            <strong>{formatAwardWeightage(balance.deducted)}</strong>
          </div>
          <div className="emp-rewards-stat">
            <span className="emp-rewards-stat__label">Banked</span>
            <strong>{formatAwardWeightage(balance.banked)}</strong>
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
        monthWeightage={availableWeightage}
        bankedWeightage={balance.banked}
        monthGiftClaimed={monthMonthlyGiftClaimed}
        claimedKeys={claimedKeys}
        onRedeem={handleRedeem}
        redeemingKey={redeemingKey}
      />

      <WeightageRewardCatalog
        userId={userId}
        monthWeightage={availableWeightage}
        bankedWeightage={balance.banked}
        monthGiftClaimed={monthMonthlyGiftClaimed}
        onRedeemed={() => void fetchAll()}
        intro="One monthly catalog or dinner gift per month. Redeem with Current when you qualify this month, or Redeem with Banked when banked covers the cost."
      />

      {milestones.length > 0 && (
        <section className="emp-rewards-card">
          <h3>
            <Gift size={18} /> Your gifts
          </h3>
          <p>When you redeem a monthly gift, its weightage moves to Used immediately. Your manager or admin then arranges delivery.</p>
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
