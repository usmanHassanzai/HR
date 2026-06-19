import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Trophy, Star, Gift, Loader2, CheckCircle, Clock, Users, AlertCircle } from 'lucide-react';
import RewardsWorkflowBanner from './RewardsWorkflowBanner';

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

export default function ManagerRewardsPanel({ managerId, onGoToPersonal }: ManagerRewardsPanelProps) {
  const [team, setTeam] = useState<TeamMemberPoints[]>([]);
  const [redemptions, setRedemptions] = useState<TeamRedemption[]>([]);
  const [ownBalance, setOwnBalance] = useState(0);
  const [ownEarned, setOwnEarned] = useState(0);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');

  useEffect(() => { fetchAll(); }, [managerId]);

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
          rewardsUnlocked: Math.floor(earned / 1000),
        };
      }).sort((a, b) => b.balance - a.balance)
    );

    setRedemptions(redemRes.data || []);
    setLoading(false);
  };

  const updateStatus = async (id: string, status: string) => {
    setMsg('');
    const { error } = await supabase.from('reward_redemptions').update({ status }).eq('id', id);
    if (error) {
      setMsg('Error: ' + error.message);
    } else {
      setMsg(status === 'fulfilled' ? '✅ Reward marked as fulfilled.' : '✅ Redemption approved.');
      fetchAll();
    }
  };

  const pending = redemptions.filter((r) => r.status === 'pending');
  const approved = redemptions.filter((r) => r.status === 'approved');

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  return (
    <div className="rewards-page animate-fade-in">
      <RewardsWorkflowBanner variant="manager" />

      {/* Manager's own points — managers earn points too */}
      <div className="manager-own-points">
        <div>
          <span className="rewards-workflow-label">Your Points (Manager)</span>
          <div><strong>{ownBalance.toLocaleString()}</strong> <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>pts available · {ownEarned.toLocaleString()} earned lifetime</span></div>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
            Managers earn tiered monthly points (up to +1,000 at ≥90%). Points never expire. Redeem on the <em>My KPIs &amp; Points</em> tab.
          </p>
        </div>
        {onGoToPersonal && (
          <button className="btn btn-primary btn-sm" onClick={onGoToPersonal}>
            <Star size={14} /> My KPIs &amp; Points
          </button>
        )}
      </div>

      {msg && <div className="rewards-toast rewards-toast--success">{msg}</div>}

      {/* Summary stats */}
      <div className="rewards-stats-grid">
        <div className="stat-card stat-card--accent">
          <Users size={20} />
          <div>
            <div className="stat-card-value">{team.length}</div>
            <div className="stat-card-label">Direct Reports</div>
          </div>
        </div>
        <div className="stat-card stat-card--warning">
          <AlertCircle size={20} />
          <div>
            <div className="stat-card-value">{pending.length}</div>
            <div className="stat-card-label">Pending Your Action</div>
          </div>
        </div>
        <div className="stat-card stat-card--gold">
          <Trophy size={20} />
          <div>
            <div className="stat-card-value">{team.filter((t) => t.balance >= 1000).length}</div>
            <div className="stat-card-label">Eligible for Reward</div>
          </div>
        </div>
      </div>

      {/* Redemption queue — manager's main job */}
      <div className="glass-panel rewards-section">
        <h3 className="rewards-section-title">
          <Gift size={20} /> Team Redemption Queue
          <span className="rewards-badge">{pending.length + approved.length} open</span>
        </h3>
        <p className="rewards-section-desc">When an employee redeems a reward, approve it here and mark fulfilled once delivered.</p>

        {pending.length === 0 && approved.length === 0 ? (
          <div className="rewards-empty">No open redemptions — your team hasn&apos;t claimed any rewards yet.</div>
        ) : (
          <div className="redemption-list">
            {[...pending, ...approved].map((r) => (
              <div key={r.id} className={`redemption-row redemption-row--${r.status}`}>
                <span className="redemption-icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                <div className="redemption-info">
                  <strong>{r.users?.full_name}</strong>
                  <span>{r.rewards_catalog?.name} · {new Date(r.redeemed_at).toLocaleDateString()}</span>
                </div>
                <span className="redemption-pts">-{r.points_used} pts</span>
                <div className="redemption-actions">
                  {r.status === 'pending' && (
                    <button className="btn btn-secondary btn-sm" onClick={() => updateStatus(r.id, 'approved')}>Approve</button>
                  )}
                  {r.status !== 'fulfilled' && (
                    <button className="btn btn-primary btn-sm" onClick={() => updateStatus(r.id, 'fulfilled')}>
                      <CheckCircle size={13} /> Fulfil
                    </button>
                  )}
                  <span className={`redemption-status redemption-status--${r.status}`}>{r.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Team points table */}
      <div className="glass-panel rewards-section">
        <h3 className="rewards-section-title">
          <Star size={20} /> Team Points Overview
        </h3>
        {team.length === 0 ? (
          <div className="rewards-empty">No direct reports assigned yet.</div>
        ) : (
          <div className="team-points-table-wrap">
            <table className="team-points-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Balance</th>
                  <th>Earned</th>
                  <th>Rewards Unlocked</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {team.map((m, i) => (
                  <tr key={m.id} className={i === 0 && m.balance > 0 ? 'team-points-table__top' : ''}>
                    <td>
                      <strong>{m.full_name}</strong>
                      <span className="team-email">{m.email}</span>
                    </td>
                    <td><span className="pts-value">{m.balance.toLocaleString()}</span></td>
                    <td>{m.totalEarned.toLocaleString()}</td>
                    <td>{m.rewardsUnlocked}</td>
                    <td>
                      {m.balance >= 1000 ? (
                        <span className="badge badge-on-track">Can Redeem</span>
                      ) : m.balance > 0 ? (
                        <span className="badge badge-at-risk">{1000 - (m.balance % 1000 || 1000)} pts to go</span>
                      ) : (
                        <span className="badge badge-off-track">Building</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Fulfilled history */}
      {redemptions.filter((r) => r.status === 'fulfilled').length > 0 && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title"><CheckCircle size={20} /> Recently Fulfilled</h3>
          <div className="redemption-list">
            {redemptions.filter((r) => r.status === 'fulfilled').slice(0, 5).map((r) => (
              <div key={r.id} className="redemption-row redemption-row--fulfilled">
                <span className="redemption-icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                <div className="redemption-info">
                  <strong>{r.users?.full_name}</strong>
                  <span>{r.rewards_catalog?.name}</span>
                </div>
                <Clock size={14} style={{ color: 'var(--color-success)' }} />
                <span className="redemption-status redemption-status--fulfilled">fulfilled</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
