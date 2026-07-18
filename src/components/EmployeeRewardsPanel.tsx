import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  Trophy,
  Star,
  Gift,
  Loader2,
  CheckCircle,
  Clock,
  Sparkles,
  TrendingUp,
  Info,
} from 'lucide-react';
import { MONTHLY_POINTS_TIERS, REWARD_CATALOG_COST, tierColorForScore } from '../utils/rewardsTiers';
import '../styles/employee-rewards.css';

interface EmployeeRewardsPanelProps {
  userId: string;
}

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  point_cost: number;
}

interface LedgerRow {
  id: string;
  month: string;
  kpi_score: number;
  points_earned: number;
}

interface Redemption {
  id: string;
  reward_id: string;
  points_used: number;
  status: string;
  redeemed_at: string;
  rewards_catalog?: { name: string; icon: string };
}

const POINTS_PER_REWARD = REWARD_CATALOG_COST;

function redemptionStatusClass(status: string): string {
  if (status === 'pending') return 'emp-rewards-status emp-rewards-status--pending';
  if (status === 'approved') return 'emp-rewards-status emp-rewards-status--approved';
  return 'emp-rewards-status emp-rewards-status--fulfilled';
}

export default function EmployeeRewardsPanel({ userId }: EmployeeRewardsPanelProps) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const [msgError, setMsgError] = useState(false);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const [catRes, ledgerRes, redemRes] = await Promise.all([
      supabase.from('rewards_catalog').select('*').eq('active', true).order('point_cost'),
      supabase.from('points_ledger').select('*').eq('employee_id', userId).order('month', { ascending: false }),
      supabase
        .from('reward_redemptions')
        .select('*, rewards_catalog(name, icon)')
        .eq('employee_id', userId)
        .order('redeemed_at', { ascending: false }),
    ]);
    if (catRes.data) setCatalog(catRes.data);
    if (ledgerRes.data) setLedger(ledgerRes.data);
    if (redemRes.data) setRedemptions(redemRes.data);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const totalPoints = ledger.reduce((s, r) => s + r.points_earned, 0);
  const usedPoints = redemptions.reduce((s, r) => s + r.points_used, 0);
  const balance = totalPoints - usedPoints;
  const rewardsEarned = Math.floor(totalPoints / POINTS_PER_REWARD);
  const tierProgress = balance % POINTS_PER_REWARD;
  const pointsToNext =
    tierProgress === 0 && balance >= POINTS_PER_REWARD ? 0 : POINTS_PER_REWARD - tierProgress;
  const progressPct = (tierProgress / POINTS_PER_REWARD) * 100;
  const canRedeemAny = balance >= POINTS_PER_REWARD;
  const pendingCount = redemptions.filter((r) => r.status === 'pending').length;

  const thisMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const thisMonthEntry = ledger.find((r) => r.month.startsWith(thisMonthKey));

  const handleRedeem = async (item: CatalogItem) => {
    if (balance < item.point_cost) return;
    setRedeeming(item.id);
    setMsg('');
    setMsgError(false);
    const { error } = await supabase.from('reward_redemptions').insert({
      employee_id: userId,
      reward_id: item.id,
      points_used: item.point_cost,
      status: 'pending',
    });
    if (error) {
      setMsg(`Redemption failed: ${error.message}`);
      setMsgError(true);
    } else {
      setMsg(`${item.icon} "${item.name}" claimed! Your manager will approve and arrange delivery.`);
      setMsgError(false);
      await fetchAll();
    }
    setRedeeming(null);
  };

  if (loading) {
    return (
      <div className="emp-rewards-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading rewards &amp; points…</span>
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
            <h2 className="emp-rewards-header__title">Rewards &amp; Points</h2>
            <p className="emp-rewards-header__subtitle">
              Earn points from your monthly KPI score, save them over time, and redeem rewards when you reach{' '}
              {POINTS_PER_REWARD.toLocaleString()} points. Your manager approves each redemption.
            </p>
          </div>
        </div>

        <div className="emp-rewards-stats">
          <div className="emp-rewards-stat emp-rewards-stat--gold">
            <Sparkles size={16} />
            <span className="emp-rewards-stat__label">Points balance</span>
            <strong>{balance.toLocaleString()}</strong>
          </div>
          <div className="emp-rewards-stat emp-rewards-stat--accent">
            <Star size={16} />
            <span className="emp-rewards-stat__label">This month</span>
            <strong>{thisMonthEntry?.points_earned ? `+${thisMonthEntry.points_earned}` : '—'}</strong>
          </div>
          <div className="emp-rewards-stat">
            <TrendingUp size={16} />
            <span className="emp-rewards-stat__label">Monthly KPI</span>
            <strong style={{ color: thisMonthEntry ? tierColorForScore(thisMonthEntry.kpi_score) : undefined }}>
              {thisMonthEntry ? `${Math.round(thisMonthEntry.kpi_score)}%` : '—'}
            </strong>
          </div>
          <div className="emp-rewards-stat emp-rewards-stat--warn">
            <Gift size={16} />
            <span className="emp-rewards-stat__label">Pending</span>
            <strong>{pendingCount}</strong>
          </div>
        </div>
      </header>

      <div className="emp-rewards-info">
        <Info size={16} />
        <span>
          Points <strong>never expire</strong>. {rewardsEarned} lifetime reward{rewardsEarned !== 1 ? 's' : ''} earned
          · {usedPoints.toLocaleString()} pts redeemed so far.
        </span>
      </div>

      {msg && (
        <div className={`emp-rewards-alert ${msgError ? 'emp-rewards-alert--error' : 'emp-rewards-alert--success'}`}>
          {msg}
        </div>
      )}

      <div className="emp-rewards-layout">
        <section className="emp-rewards-card emp-rewards-balance-card">
          <span className="emp-rewards-balance-card__eyebrow">
            <Trophy size={14} /> Your balance
          </span>
          <div className="emp-rewards-balance-card__value">{balance.toLocaleString()}</div>
          <p className="emp-rewards-balance-card__meta">
            {canRedeemAny && pointsToNext === 0 ? (
              <span className="emp-rewards-balance-card__badge">Reward unlocked — pick from the catalog</span>
            ) : (
              <>
                <strong>{pointsToNext.toLocaleString()}</strong> pts until your next {POINTS_PER_REWARD.toLocaleString()}{' '}
                pt reward
              </>
            )}
          </p>
          <div className="emp-rewards-progress">
            <div className="emp-rewards-progress__head">
              <span>Progress to next reward</span>
              <strong>{tierProgress.toLocaleString()} / {POINTS_PER_REWARD.toLocaleString()}</strong>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </section>

        <section className="emp-rewards-card">
          <h3>
            <Star size={18} /> Monthly performance tiers
          </h3>
          <p>Points are added automatically each month based on your KPI score.</p>
          <div className="emp-rewards-tier-list">
            {MONTHLY_POINTS_TIERS.map((tier) => (
              <div key={tier.label} className="emp-rewards-tier-row">
                <span>{tier.label}</span>
                <strong>{tier.points > 0 ? `+${tier.points} pts` : '0 pts'}</strong>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="emp-rewards-card">
        <h3>
          <Gift size={18} /> Reward catalog
          {canRedeemAny && <span className="emp-rewards-count-badge">Ready to redeem</span>}
        </h3>
        <p>Browse available rewards and claim when you have enough points.</p>

        {catalog.length === 0 ? (
          <div className="emp-rewards-empty">
            <Gift size={36} strokeWidth={1.25} />
            <h4>No rewards in catalog yet</h4>
            <p>Your admin will add rewards here. Keep earning points from your KPIs.</p>
          </div>
        ) : (
          <div className="emp-rewards-catalog">
            {catalog.map((item) => {
              const canRedeem = balance >= item.point_cost;
              return (
                <article key={item.id} className={`emp-rewards-catalog-item${canRedeem ? ' emp-rewards-catalog-item--ready' : ''}`}>
                  <span className="emp-rewards-catalog-item__icon">{item.icon}</span>
                  <div className="emp-rewards-catalog-item__body">
                    <strong>{item.name}</strong>
                    <span>{item.description}</span>
                  </div>
                  <div className="emp-rewards-catalog-item__foot">
                    <span className="emp-rewards-catalog-item__cost">{item.point_cost.toLocaleString()} pts</span>
                    <button
                      type="button"
                      className={`btn btn-sm ${canRedeem ? 'btn-primary' : 'btn-secondary'}`}
                      disabled={!canRedeem || redeeming === item.id}
                      onClick={() => void handleRedeem(item)}
                    >
                      {redeeming === item.id ? (
                        <Loader2 size={13} className="spin-icon" />
                      ) : canRedeem ? (
                        'Redeem'
                      ) : (
                        'Locked'
                      )}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {redemptions.length > 0 && (
        <section className="emp-rewards-card">
          <h3>
            <Clock size={18} /> My redemptions
          </h3>
          <p>Track pending and fulfilled reward requests.</p>
          <div className="emp-rewards-redemption-list">
            {redemptions.map((r) => (
              <article key={r.id} className={`emp-rewards-redemption emp-rewards-redemption--${r.status}`}>
                <span className="emp-rewards-redemption__icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                <div className="emp-rewards-redemption__body">
                  <strong>{r.rewards_catalog?.name ?? 'Reward'}</strong>
                  <span>{new Date(r.redeemed_at).toLocaleDateString()}</span>
                </div>
                <span className="emp-rewards-redemption__pts">−{r.points_used.toLocaleString()} pts</span>
                {r.status === 'fulfilled' ? (
                  <CheckCircle size={16} className="emp-rewards-redemption__icon-status emp-rewards-redemption__icon-status--ok" />
                ) : (
                  <Clock size={16} className="emp-rewards-redemption__icon-status emp-rewards-redemption__icon-status--pending" />
                )}
                <span className={redemptionStatusClass(r.status)}>{r.status}</span>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
