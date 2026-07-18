import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Trophy, Star, Gift, Loader2, CheckCircle, Clock, Sparkles } from 'lucide-react';
import RewardsWorkflowBanner from './RewardsWorkflowBanner';
import { MONTHLY_POINTS_TIERS, REWARD_CATALOG_COST, tierColorForScore } from '../utils/rewardsTiers';

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

interface RewardsTabProps {
  userId: string;
  isReadOnly?: boolean;
  viewerRole?: 'employee' | 'manager';
  /** Hide top balance hero when parent already shows summary stats */
  embedded?: boolean;
}

const POINTS_PER_REWARD = REWARD_CATALOG_COST;

export default function RewardsTab({ userId, isReadOnly, viewerRole = 'employee', embedded = false }: RewardsTabProps) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeeming, setRedeeming] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => { fetchAll(); }, [userId]);

  const fetchAll = async () => {
    setLoading(true);
    const [catRes, ledgerRes, redemRes] = await Promise.all([
      supabase.from('rewards_catalog').select('*').eq('active', true).order('point_cost'),
      supabase.from('points_ledger').select('*').eq('employee_id', userId).order('month', { ascending: false }),
      supabase.from('reward_redemptions').select('*, rewards_catalog(name, icon)').eq('employee_id', userId).order('redeemed_at', { ascending: false }),
    ]);
    if (catRes.data) setCatalog(catRes.data);
    if (ledgerRes.data) setLedger(ledgerRes.data);
    if (redemRes.data) setRedemptions(redemRes.data);
    setLoading(false);
  };

  const totalPoints = ledger.reduce((s, r) => s + r.points_earned, 0);
  const usedPoints = redemptions.reduce((s, r) => s + r.points_used, 0);
  const balance = totalPoints - usedPoints;
  const rewardsEarned = Math.floor(totalPoints / POINTS_PER_REWARD);
  const tierProgress = balance % POINTS_PER_REWARD;
  const pointsToNext = tierProgress === 0 && balance >= POINTS_PER_REWARD ? 0 : POINTS_PER_REWARD - tierProgress;
  const progressPct = (tierProgress / POINTS_PER_REWARD) * 100;
  const canRedeemAny = balance >= POINTS_PER_REWARD;

  const thisMonthKey = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const thisMonthEntry = ledger.find((r) => r.month.startsWith(thisMonthKey));

  const handleRedeem = async (item: CatalogItem) => {
    if (balance < item.point_cost) return;
    setRedeeming(item.id);
    setMsg('');
    const { error } = await supabase.from('reward_redemptions').insert({
      employee_id: userId,
      reward_id: item.id,
      points_used: item.point_cost,
      status: 'pending',
    });
    if (error) {
      setMsg('Redemption failed: ' + error.message);
    } else {
      setMsg(`${item.icon} "${item.name}" claimed! Your manager will approve and arrange delivery.`);
      fetchAll();
    }
    setRedeeming(null);
  };

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  return (
    <div className={`rewards-page animate-fade-in${embedded ? ' rewards-page--embedded' : ''}`}>
      {!isReadOnly && !embedded && <RewardsWorkflowBanner variant={viewerRole === 'manager' ? 'manager' : 'employee'} />}

      {!embedded && (
      <>
      {/* Hero balance */}
      <div className="rewards-hero">
        <div className="rewards-hero-glow" />
        <div className="rewards-hero-content">
          <div className="rewards-hero-left">
            <span className="rewards-hero-label"><Sparkles size={16} /> Your Points Balance</span>
            <div className="rewards-hero-balance">{balance.toLocaleString()}</div>
            <p className="rewards-hero-meta">
              {rewardsEarned} lifetime reward{rewardsEarned !== 1 ? 's' : ''} earned
              {canRedeemAny && <span className="rewards-hero-badge"> · Reward available!</span>}
              <span style={{ display: 'block', marginTop: '0.35rem', fontSize: '0.78rem', opacity: 0.85 }}>Points never expire</span>
            </p>
          </div>
          <div className="rewards-hero-progress">
            <div className="rewards-hero-progress-head">
              <Trophy size={16} />
              <span>Next reward at 1,000 pts</span>
              <strong>{canRedeemAny && tierProgress === 0 ? 'Unlocked!' : `${pointsToNext} to go`}</strong>
            </div>
            <div className="progress-bar">
              <div className="progress-bar-fill" style={{ width: `${progressPct}%` }} />
            </div>
            <span className="progress-bar-label">{tierProgress} / {POINTS_PER_REWARD}</span>
          </div>
        </div>
      </div>
      </>
      )}

      {msg && <div className="rewards-toast rewards-toast--success">{msg}</div>}

      {/* Monthly tier rules */}
      <div className="glass-panel rewards-tier-panel">
        <h3 className="rewards-section-title" style={{ marginBottom: '0.75rem' }}>Monthly Performance Rewards</h3>
        <p className="rewards-section-desc" style={{ marginBottom: '0.85rem' }}>
          Points are awarded each month based on your KPI score. They <strong>never expire</strong> and accumulate until you redeem.
        </p>
        <div className="rewards-tier-grid">
          {MONTHLY_POINTS_TIERS.map((tier) => (
            <div key={tier.label} className="rewards-tier-row">
              <span className="rewards-tier-label">{tier.label}</span>
              <strong className="rewards-tier-points">{tier.points > 0 ? `+${tier.points} pts` : '0 pts'}</strong>
            </div>
          ))}
        </div>
      </div>

      {/* Mini stats */}
      <div className="rewards-stats-grid">
        <div className="stat-card stat-card--accent">
          <Star size={20} />
          <div>
            <div className="stat-card-value">
              {thisMonthEntry?.points_earned ? `+${thisMonthEntry.points_earned}` : '—'}
            </div>
            <div className="stat-card-label">This Month&apos;s Bonus</div>
          </div>
        </div>
        <div className="stat-card">
          <Trophy size={20} />
          <div>
            <div className="stat-card-value" style={{ color: thisMonthEntry ? tierColorForScore(thisMonthEntry.kpi_score) : undefined }}>
              {thisMonthEntry ? `${Math.round(thisMonthEntry.kpi_score)}%` : '—'}
            </div>
            <div className="stat-card-label">Monthly KPI Score</div>
          </div>
        </div>
        <div className="stat-card stat-card--gold">
          <Gift size={20} />
          <div>
            <div className="stat-card-value">{redemptions.filter((r) => r.status === 'pending').length}</div>
            <div className="stat-card-label">Pending Redemptions</div>
          </div>
        </div>
      </div>

      {/* Catalog */}
      {!isReadOnly && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title"><Gift size={20} /> Reward Catalog</h3>
          <div className="reward-catalog-grid">
            {catalog.map((item) => {
              const canRedeem = balance >= item.point_cost;
              return (
                <div key={item.id} className={`reward-card ${canRedeem ? 'reward-card--unlocked' : ''}`}>
                  <div className="reward-card-icon">{item.icon}</div>
                  <h4>{item.name}</h4>
                  <p>{item.description}</p>
                  <div className="reward-card-footer">
                    <span className="reward-card-cost">{item.point_cost.toLocaleString()} pts</span>
                    <button
                      className={`btn btn-sm ${canRedeem ? 'btn-primary' : 'btn-secondary'}`}
                      disabled={!canRedeem || redeeming === item.id}
                      onClick={() => handleRedeem(item)}
                    >
                      {redeeming === item.id ? <Loader2 size={13} className="spin-icon" /> : canRedeem ? 'Redeem' : 'Locked'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Redemption history */}
      {redemptions.length > 0 && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title">My Redemptions</h3>
          <div className="redemption-list">
            {redemptions.map((r) => (
              <div key={r.id} className={`redemption-row redemption-row--${r.status}`}>
                <span className="redemption-icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                <div className="redemption-info">
                  <strong>{r.rewards_catalog?.name ?? 'Reward'}</strong>
                  <span>{new Date(r.redeemed_at).toLocaleDateString()}</span>
                </div>
                <span className="redemption-pts">-{r.points_used} pts</span>
                {r.status === 'fulfilled' ? <CheckCircle size={15} style={{ color: 'var(--color-success)' }} /> : <Clock size={15} style={{ color: 'var(--color-warning)' }} />}
                <span className={`redemption-status redemption-status--${r.status}`}>{r.status}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewerRole === 'employee' && !isReadOnly && (
        <div className="glass-panel rewards-section">
          <p className="rewards-section-desc" style={{ margin: 0 }}>
            You can only view your own points balance. Contact your manager for team rewards questions.
          </p>
        </div>
      )}
    </div>
  );
}
