import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  Trophy,
  Star,
  Gift,
  Loader2,
  CheckCircle,
  Clock,
  Users,
  AlertCircle,
  Sparkles,
  ArrowRight,
} from 'lucide-react';
import { REWARD_CATALOG_COST } from '../utils/rewardsTiers';
import '../styles/manager-rewards.css';

interface ManagerRewardsPanelProps {
  managerId: string;
  onGoToPersonal?: () => void;
}

interface TeamMemberPoints {
  id: string;
  full_name: string;
  email: string;
  totalEarned: number;
  totalUsed: number;
  balance: number;
  rewardsUnlocked: number;
}

interface TeamRedemption {
  id: string;
  employee_id: string;
  points_used: number;
  status: string;
  redeemed_at: string;
  users?: { full_name: string };
  rewards_catalog?: { name: string; icon: string };
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function redemptionStatusClass(status: string): string {
  if (status === 'pending') return 'mgr-rewards-status mgr-rewards-status--pending';
  if (status === 'approved') return 'mgr-rewards-status mgr-rewards-status--approved';
  return 'mgr-rewards-status mgr-rewards-status--fulfilled';
}

export default function ManagerRewardsPanel({ managerId, onGoToPersonal }: ManagerRewardsPanelProps) {
  const [team, setTeam] = useState<TeamMemberPoints[]>([]);
  const [redemptions, setRedemptions] = useState<TeamRedemption[]>([]);
  const [ownBalance, setOwnBalance] = useState(0);
  const [ownEarned, setOwnEarned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [msgError, setMsgError] = useState(false);

  useEffect(() => { void fetchAll(); }, [managerId]);

  const fetchAll = async () => {
    setLoading(true);

    const [reports, ownLedgerRes, ownRedemRes] = await Promise.all([
      supabase.rpc('get_direct_reports', { p_manager_id: managerId }),
      supabase.from('points_ledger').select('points_earned').eq('employee_id', managerId),
      supabase.from('reward_redemptions').select('points_used').eq('employee_id', managerId),
    ]);

    const ownE = (ownLedgerRes.data || []).reduce((s, r) => s + r.points_earned, 0);
    const ownU = (ownRedemRes.data || []).reduce((s, r) => s + r.points_used, 0);
    setOwnEarned(ownE);
    setOwnBalance(ownE - ownU);

    const members: Profile[] = reports.data || [];
    if (!members.length) {
      setTeam([]);
      setRedemptions([]);
      setLoading(false);
      return;
    }

    const ids = members.map((m) => m.id);
    const [ledgerRes, redemRes] = await Promise.all([
      supabase.from('points_ledger').select('employee_id, points_earned').in('employee_id', ids),
      supabase.from('reward_redemptions')
        .select('*, users(full_name), rewards_catalog(name, icon)')
        .in('employee_id', ids)
        .order('redeemed_at', { ascending: false }),
    ]);

    const earnedMap = new Map<string, number>();
    (ledgerRes.data || []).forEach((r) => {
      earnedMap.set(r.employee_id, (earnedMap.get(r.employee_id) || 0) + r.points_earned);
    });

    const usedMap = new Map<string, number>();
    (redemRes.data || []).forEach((r) => {
      usedMap.set(r.employee_id, (usedMap.get(r.employee_id) || 0) + r.points_used);
    });

    setTeam(
      members.map((m) => {
        const earned = earnedMap.get(m.id) || 0;
        const used = usedMap.get(m.id) || 0;
        return {
          id: m.id,
          full_name: m.full_name,
          email: m.email,
          totalEarned: earned,
          totalUsed: used,
          balance: earned - used,
          rewardsUnlocked: Math.floor(earned / REWARD_CATALOG_COST),
        };
      }).sort((a, b) => b.balance - a.balance),
    );

    setRedemptions(redemRes.data || []);
    setLoading(false);
  };

  const updateStatus = async (id: string, status: string) => {
    setMsg('');
    setMsgError(false);
    const { error } = await supabase.from('reward_redemptions').update({ status }).eq('id', id);
    if (error) {
      setMsgError(true);
      setMsg(error.message);
    } else {
      setMsg(status === 'fulfilled' ? 'Reward marked as fulfilled.' : 'Redemption approved.');
      void fetchAll();
    }
  };

  const pending = redemptions.filter((r) => r.status === 'pending');
  const approved = redemptions.filter((r) => r.status === 'approved');
  const fulfilled = redemptions.filter((r) => r.status === 'fulfilled');
  const openQueue = [...pending, ...approved];
  const teamTotalBalance = team.reduce((s, m) => s + m.balance, 0);
  const eligibleCount = team.filter((t) => t.balance >= REWARD_CATALOG_COST).length;

  if (loading) {
    return (
      <div className="mgr-rewards-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading team rewards…</span>
      </div>
    );
  }

  return (
    <div className="mgr-rewards-page animate-fade-in">
      <header className="mgr-rewards-header glass-panel">
        <div className="mgr-rewards-header__main">
          <div className="mgr-rewards-header__icon">
            <Trophy size={22} />
          </div>
          <div>
            <h2 className="mgr-rewards-header__title">Team Rewards</h2>
            <p className="mgr-rewards-header__subtitle">
              Approve and fulfill your team&apos;s reward redemptions, track points balances, and manage the redemption workflow for direct reports.
            </p>
          </div>
        </div>
        <div className="mgr-rewards-stats">
          <div className="mgr-rewards-stat mgr-rewards-stat--accent">
            <span className="mgr-rewards-stat__label">Direct reports</span>
            <strong>{team.length}</strong>
          </div>
          <div className="mgr-rewards-stat mgr-rewards-stat--warning">
            <span className="mgr-rewards-stat__label">Pending action</span>
            <strong>{pending.length}</strong>
          </div>
          <div className="mgr-rewards-stat mgr-rewards-stat--gold">
            <span className="mgr-rewards-stat__label">Can redeem</span>
            <strong>{eligibleCount}</strong>
          </div>
          <div className="mgr-rewards-stat">
            <span className="mgr-rewards-stat__label">Team balance</span>
            <strong>{teamTotalBalance.toLocaleString()}</strong>
          </div>
        </div>
      </header>

      {msg && (
        <div className={`mgr-rewards-alert ${msgError ? 'mgr-rewards-alert--error' : 'mgr-rewards-alert--success'}`}>
          {msgError ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
          <span>{msg}</span>
        </div>
      )}

      <div className="mgr-rewards-layout">
        <section className="mgr-rewards-card">
          <h3>
            <Gift size={18} /> Redemption queue
            {openQueue.length > 0 && (
              <span className="mgr-rewards-count-badge">{openQueue.length} open</span>
            )}
          </h3>
          <p>When an employee redeems a reward, approve it here and mark fulfilled once delivered.</p>

          {openQueue.length === 0 ? (
            <div className="mgr-rewards-empty">
              <Gift size={40} strokeWidth={1.25} />
              <h4>Queue is clear</h4>
              <p>No open redemptions — your team hasn&apos;t claimed any rewards yet.</p>
            </div>
          ) : (
            <div className="mgr-rewards-queue">
              {openQueue.map((r) => (
                <article
                  key={r.id}
                  className={`mgr-rewards-queue-item mgr-rewards-queue-item--${r.status}`}
                >
                  <span className="mgr-rewards-queue-item__icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                  <div className="mgr-rewards-queue-item__body">
                    <strong>{r.users?.full_name}</strong>
                    <span>
                      {r.rewards_catalog?.name} · {new Date(r.redeemed_at).toLocaleDateString()}
                    </span>
                  </div>
                  <span className="mgr-rewards-queue-item__pts">−{r.points_used.toLocaleString()} pts</span>
                  <div className="mgr-rewards-queue-item__actions">
                    {r.status === 'pending' && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => void updateStatus(r.id, 'approved')}
                      >
                        Approve
                      </button>
                    )}
                    {r.status !== 'fulfilled' && (
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => void updateStatus(r.id, 'fulfilled')}
                      >
                        <CheckCircle size={13} /> Fulfil
                      </button>
                    )}
                    <span className={redemptionStatusClass(r.status)}>{r.status}</span>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>

        <aside className="mgr-rewards-own">
          <span className="mgr-rewards-own__eyebrow"><Sparkles size={12} /> Your points</span>
          <div className="mgr-rewards-own__balance">{ownBalance.toLocaleString()}</div>
          <p className="mgr-rewards-own__meta">
            {ownEarned.toLocaleString()} pts earned lifetime · Managers earn tiered monthly points (up to +1,000 at ≥90%).
          </p>
          <div className="mgr-rewards-workflow-compact">
            <strong>Your role:</strong> Approve team redemptions → mark fulfilled when delivered.
            Admins manage the catalog and monthly point calculations.
          </div>
          {onGoToPersonal && (
            <button type="button" className="btn btn-primary" onClick={onGoToPersonal}>
              <Star size={15} /> My KPIs &amp; Points
              <ArrowRight size={14} />
            </button>
          )}
        </aside>
      </div>

      <section className="mgr-rewards-card">
        <h3><Users size={18} /> Team points overview</h3>
        <p>Points balances and redemption eligibility for each direct report ({REWARD_CATALOG_COST.toLocaleString()} pts to redeem).</p>

        {team.length === 0 ? (
          <div className="mgr-rewards-empty">
            <Users size={40} strokeWidth={1.25} />
            <h4>No direct reports</h4>
            <p>No employees assigned to your team yet.</p>
          </div>
        ) : (
          <div className="mgr-rewards-table-wrap">
            <table className="mgr-rewards-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Balance</th>
                  <th>Earned</th>
                  <th>Used</th>
                  <th>Rewards</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {team.map((m, i) => {
                  const ptsToGo = REWARD_CATALOG_COST - (m.balance % REWARD_CATALOG_COST || REWARD_CATALOG_COST);
                  return (
                    <tr key={m.id} className={i === 0 && m.balance > 0 ? 'mgr-rewards-table__top' : ''}>
                      <td>
                        <div className="mgr-rewards-table__member">
                          <div className="mgr-rewards-table__avatar" aria-hidden>{initials(m.full_name)}</div>
                          <div>
                            <strong>{m.full_name}</strong>
                            <span>{m.email}</span>
                          </div>
                        </div>
                      </td>
                      <td><span className="mgr-rewards-table__pts">{m.balance.toLocaleString()}</span></td>
                      <td>{m.totalEarned.toLocaleString()}</td>
                      <td>{m.totalUsed.toLocaleString()}</td>
                      <td>{m.rewardsUnlocked}</td>
                      <td>
                        {m.balance >= REWARD_CATALOG_COST ? (
                          <span className="badge badge-on-track">Can redeem</span>
                        ) : m.balance > 0 ? (
                          <span className="badge badge-at-risk">{ptsToGo.toLocaleString()} pts to go</span>
                        ) : (
                          <span className="badge badge-off-track">Building</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {fulfilled.length > 0 && (
        <section className="mgr-rewards-card">
          <h3><CheckCircle size={18} /> Recently fulfilled</h3>
          <p>Last {Math.min(5, fulfilled.length)} completed redemptions.</p>
          <div className="mgr-rewards-queue">
            {fulfilled.slice(0, 5).map((r) => (
              <article key={r.id} className="mgr-rewards-queue-item mgr-rewards-queue-item--fulfilled">
                <span className="mgr-rewards-queue-item__icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                <div className="mgr-rewards-queue-item__body">
                  <strong>{r.users?.full_name}</strong>
                  <span>{r.rewards_catalog?.name}</span>
                </div>
                <Clock size={14} style={{ color: 'var(--color-success)', flexShrink: 0 }} />
                <span className={redemptionStatusClass('fulfilled')}>fulfilled</span>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
