import { useEffect, useState } from 'react';
import { BarChart2, Loader2, Sparkles, Star, Trophy } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Kpi } from '../utils/kpiHelpers';
import { employeeTotalKpiPoints } from '../utils/kpiScoreHelpers';
import { fetchRewardsSummary, RewardsSummary } from '../utils/rewardsHelpers';
import { REWARD_CATALOG_COST, tierColorForScore } from '../utils/rewardsTiers';

interface RewardsPointsCardProps {
  userId: string;
  title?: string;
  onViewRewards?: () => void;
  showViewLink?: boolean;
  /** Live KPI board points. When omitted, loaded from the user's KPIs. */
  kpiPoints?: number | null;
  /** Bump after completing tasks so balance refreshes. */
  refreshKey?: number | string;
}

export default function RewardsPointsCard({
  userId,
  title = 'Your rewards points',
  onViewRewards,
  showViewLink = true,
  kpiPoints: kpiPointsProp,
  refreshKey = 0,
}: RewardsPointsCardProps) {
  const [summary, setSummary] = useState<RewardsSummary | null>(null);
  const [kpiPoints, setKpiPoints] = useState<number | null>(kpiPointsProp ?? null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (kpiPointsProp != null) setKpiPoints(kpiPointsProp);
  }, [kpiPointsProp]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (kpiPointsProp == null && refreshKey === 0) setLoading(true);
      try {
        const [data, kpiRes] = await Promise.all([
          fetchRewardsSummary(userId),
          kpiPointsProp != null
            ? Promise.resolve(null)
            : supabase.from('kpis').select('*').eq('user_id', userId),
        ]);
        if (cancelled) return;
        setSummary(data);
        if (kpiPointsProp != null) {
          setKpiPoints(kpiPointsProp);
        } else if (kpiRes && !kpiRes.error) {
          setKpiPoints(employeeTotalKpiPoints((kpiRes.data || []) as Kpi[]));
        }
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId, refreshKey, kpiPointsProp]);

  if (loading && !summary) {
    return (
      <div className="glass-panel dash-points-card dash-points-card--loading">
        <Loader2 size={22} className="spin-icon" />
      </div>
    );
  }

  if (!summary) return null;

  return (
    <div className="glass-panel dash-points-card">
      <div className="dash-points-card__head">
        <span className="dash-eyebrow"><Trophy size={14} /> {title}</span>
        {summary.canRedeem && <span className="dash-points-card__badge">Redeem available</span>}
      </div>

      <div className="dash-points-card__balance">{summary.balance.toLocaleString()}</div>
      <p className="dash-points-card__meta">
        {summary.totalEarned.toLocaleString()} earned · {summary.usedPoints.toLocaleString()} redeemed
      </p>

      <div className="dash-points-card__stats">
        {kpiPoints != null && (
          <div className="dash-points-card__stat">
            <BarChart2 size={15} />
            <div>
              <strong>{kpiPoints.toLocaleString()}</strong>
              <span>KPI points</span>
            </div>
          </div>
        )}
        <div className="dash-points-card__stat">
          <Star size={15} />
          <div>
            <strong>{summary.thisMonthPoints != null ? `+${summary.thisMonthPoints}` : '—'}</strong>
            <span>This month</span>
          </div>
        </div>
        <div className="dash-points-card__stat">
          <Sparkles size={15} />
          <div>
            <strong style={{ color: summary.thisMonthScore != null ? tierColorForScore(summary.thisMonthScore) : undefined }}>
              {summary.thisMonthScore != null ? `${Math.round(summary.thisMonthScore)}%` : '—'}
            </strong>
            <span>Monthly KPI</span>
          </div>
        </div>
      </div>

      <div className="dash-points-card__progress">
        <div className="dash-points-card__progress-head">
          <span>Next reward at {REWARD_CATALOG_COST.toLocaleString()} pts</span>
          <strong>{summary.canRedeem && summary.pointsToNextReward === 0 ? 'Ready!' : `${summary.pointsToNextReward} to go`}</strong>
        </div>
        <div className="progress-bar">
          <div className="progress-bar-fill" style={{ width: `${summary.progressPct}%` }} />
        </div>
      </div>

      {showViewLink && onViewRewards && (
        <button type="button" className="btn btn-secondary btn-sm dash-points-card__link" onClick={onViewRewards}>
          View rewards & redeem
        </button>
      )}
    </div>
  );
}
