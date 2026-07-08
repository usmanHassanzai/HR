import { supabase } from '../lib/supabase';
import { REWARD_CATALOG_COST } from './rewardsTiers';

export interface RewardsSummary {
  balance: number;
  totalEarned: number;
  usedPoints: number;
  thisMonthPoints: number | null;
  thisMonthScore: number | null;
  pointsToNextReward: number;
  progressPct: number;
  canRedeem: boolean;
}

export function computeRewardsSummary(
  ledger: { month: string; kpi_score: number; points_earned: number }[],
  redemptions: { points_used: number }[],
): RewardsSummary {
  const totalEarned = ledger.reduce((s, r) => s + r.points_earned, 0);
  const usedPoints = redemptions.reduce((s, r) => s + r.points_used, 0);
  const balance = totalEarned - usedPoints;
  const tierProgress = balance % REWARD_CATALOG_COST;
  const canRedeem = balance >= REWARD_CATALOG_COST;
  const pointsToNextReward = canRedeem && tierProgress === 0 ? 0 : REWARD_CATALOG_COST - tierProgress;
  const progressPct = (tierProgress / REWARD_CATALOG_COST) * 100;

  const thisMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const thisMonthEntry = ledger.find((r) => r.month.startsWith(thisMonthKey));

  return {
    balance,
    totalEarned,
    usedPoints,
    thisMonthPoints: thisMonthEntry?.points_earned ?? null,
    thisMonthScore: thisMonthEntry?.kpi_score ?? null,
    pointsToNextReward,
    progressPct,
    canRedeem,
  };
}

export async function fetchRewardsSummary(userId: string): Promise<RewardsSummary> {
  const [ledgerRes, redemRes] = await Promise.all([
    supabase
      .from('points_ledger')
      .select('month, kpi_score, points_earned')
      .eq('employee_id', userId)
      .order('month', { ascending: false }),
    supabase.from('reward_redemptions').select('points_used').eq('employee_id', userId),
  ]);

  return computeRewardsSummary(ledgerRes.data || [], redemRes.data || []);
}
