import { useEffect, useState } from 'react';
import { Loader2, Sparkles, Star, Trophy } from 'lucide-react';
import { fetchRewardsSummary, RewardsSummary } from '../utils/rewardsHelpers';
import { REWARD_CATALOG_COST, tierColorForScore } from '../utils/rewardsTiers';

interface RewardsPointsCardProps {
  userId: string;
  onViewRewards?: () => void;
  showViewLink?: boolean;
}

export default function RewardsPointsCard({ userId, onViewRewards, showViewLink = true }: RewardsPointsCardProps) {
  const [summary, setSummary] = useState<RewardsSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const data = await fetchRewardsSummary(userId);
        if (!cancelled) setSummary(data);
      } catch {
        if (!cancelled) setSummary(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) {
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
        <span className="dash-eyebrow"><Trophy size={14} /> Rewards points</span>
        {summary.canRedeem && <span className="dash-points-card__badge">Redeem available</span>}
      </div>

      <div className="dash-points-card__balance">{summary.balance.toLocaleString()}</div>
      <p className="dash-points-card__meta">
        {summary.totalEarned.toLocaleString()} earned · {summary.usedPoints.toLocaleString()} redeemed
      </p>

      <div className="dash-points-card__stats">
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
