import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  Trophy,
  Gift,
  Loader2,
  CheckCircle,
  AlertCircle,
  Users,
  ArrowLeft,
  ChevronRight,
} from 'lucide-react';
import type { KpiAwardPipelineRow, KpiAwardProgress, KpiAwardRuleKey } from '../utils/kpiAwardHelpers';
import { awardGiftLine, coerceAwardWeightage, formatAwardWeightage } from '../utils/kpiAwardHelpers';
import KpiAwardProgressList from './KpiAwardProgressList';
import WeightageRewardCatalog from './WeightageRewardCatalog';
import AdminRewardHistoryPanel from './AdminRewardHistoryPanel';
import {
  fetchMonthWeightageBalance,
  type MonthWeightageBalance,
} from '../utils/monthWeightageBalance';
import '../styles/manager-rewards.css';
import '../styles/employee-rewards.css';
import '../styles/admin-rewards.css';

interface ManagerRewardsPanelProps {
  managerId: string;
}

type TeamGiftRow = {
  id: string;
  full_name: string;
  email: string;
  isSelf: boolean;
  progress: KpiAwardProgress[];
};

function statusLabel(status: string): string {
  if (status === 'approved') return 'Approved';
  if (status === 'issued' || status === 'fulfilled') return 'Delivered';
  if (status === 'dismissed' || status === 'rejected') return 'Rejected';
  return 'Pending';
}

export default function ManagerRewardsPanel({ managerId }: ManagerRewardsPanelProps) {
  const [myProgress, setMyProgress] = useState<KpiAwardProgress[]>([]);
  const [team, setTeam] = useState<TeamGiftRow[]>([]);
  const [queue, setQueue] = useState<KpiAwardPipelineRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [msgError, setMsgError] = useState(false);
  const [selected, setSelected] = useState<TeamGiftRow | null>(null);
  const [redeemingKey, setRedeemingKey] = useState<KpiAwardRuleKey | null>(null);
  const [catalogQueue, setCatalogQueue] = useState<{
    id: string;
    status: string;
    redeemed_at: string;
    users?: { full_name: string } | null;
    rewards_catalog?: { name: string } | null;
  }[]>([]);
  const [myBalance, setMyBalance] = useState<MonthWeightageBalance>({
    earned: null,
    deducted: 0,
    available: null,
    banked: 0,
  });

  const load = useCallback(async () => {
    setLoading(true);
    const [mineRes, reportsRes, pipeRes, catRedRes, bal] = await Promise.all([
      supabase.rpc('get_kpi_award_progress', { p_user_id: managerId }),
      supabase.rpc('get_direct_reports', { p_manager_id: managerId }),
      supabase.rpc('get_kpi_award_pipeline'),
      supabase
        .from('reward_redemptions')
        .select('id, employee_id, status, redeemed_at, users(full_name), rewards_catalog(name)')
        .in('status', ['pending', 'approved'])
        .order('redeemed_at', { ascending: false })
        .limit(40),
      fetchMonthWeightageBalance(managerId),
    ]);

    if (mineRes.data) setMyProgress(mineRes.data as KpiAwardProgress[]);
    setMyBalance(bal);

    const members = ((reportsRes.data || []) as Profile[]).filter((u) => !u.is_demo);
    const memberIds = new Set(members.map((m) => m.id));
    memberIds.add(managerId);

    const progressLists = await Promise.all(
      members.map((m) => supabase.rpc('get_kpi_award_progress', { p_user_id: m.id })),
    );

    const nextTeam: TeamGiftRow[] = [
      {
        id: managerId,
        full_name: 'You',
        email: '',
        isSelf: true,
        progress: (mineRes.data || []) as KpiAwardProgress[],
      },
      ...members.map((m, i) => ({
        id: m.id,
        full_name: m.full_name,
        email: m.email,
        isSelf: false,
        progress: (progressLists[i]?.data || []) as KpiAwardProgress[],
      })),
    ];
    setTeam(nextTeam);
    setSelected((prev) => (prev ? nextTeam.find((t) => t.id === prev.id) ?? null : null));

    if (pipeRes.error) {
      setQueue([]);
    } else {
      setQueue(
        ((pipeRes.data || []) as KpiAwardPipelineRow[]).filter(
          (r) =>
            r.bucket === 'eligible' &&
            r.status !== 'dismissed' &&
            r.status !== 'rejected' &&
            r.status !== 'issued' &&
            r.status !== 'fulfilled',
        ),
      );
    }

    type CatRow = {
      id: string;
      employee_id: string;
      status: string;
      redeemed_at: string;
      users?: { full_name: string } | { full_name: string }[] | null;
      rewards_catalog?: { name: string } | { name: string }[] | null;
    };
    const catRows = (catRedRes.data || []) as CatRow[];
    setCatalogQueue(
      catRows
        .filter((r) => memberIds.has(r.employee_id))
        .map((r) => {
          const user = Array.isArray(r.users) ? r.users[0] : r.users;
          const catalog = Array.isArray(r.rewards_catalog) ? r.rewards_catalog[0] : r.rewards_catalog;
          return {
            id: r.id,
            status: r.status,
            redeemed_at: r.redeemed_at,
            users: user ?? null,
            rewards_catalog: catalog ?? null,
          };
        }),
    );
    setLoading(false);
  }, [managerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateGift = async (id: string, status: string) => {
    setMsg('');
    setMsgError(false);
    const { error } = await supabase.rpc('set_kpi_award_status', { p_id: id, p_status: status });
    if (error) {
      setMsgError(true);
      setMsg(error.message);
    } else {
      setMsg(
        status === 'rejected' || status === 'dismissed'
          ? 'Request rejected — weightage returned.'
          : status === 'fulfilled' || status === 'issued'
            ? 'Gift marked delivered.'
            : 'Gift approved.',
      );
      void load();
    }
  };

  const updateCatalogRedemption = async (id: string, status: string) => {
    setMsg('');
    setMsgError(false);
    const { error } = await supabase.rpc('set_catalog_redemption_status', {
      p_id: id,
      p_status: status,
    });
    if (error) {
      setMsgError(true);
      setMsg(error.message);
      return;
    }
    setMsg(
      status === 'rejected'
        ? 'Catalog request rejected — weightage returned.'
        : status === 'fulfilled'
          ? 'Catalog reward delivered.'
          : 'Catalog reward approved.',
    );
    void load();
  };

  const claimMyGift = async (ruleKey: KpiAwardRuleKey, opts?: { useBanked?: boolean }) => {
    setRedeemingKey(ruleKey);
    setMsg('');
    setMsgError(false);
    const { error } = await supabase.rpc('claim_my_kpi_award', {
      p_rule_key: ruleKey,
      p_use_banked: Boolean(opts?.useBanked),
    });
    if (error) {
      setMsgError(true);
      setMsg(error.message);
    } else {
      setMsg(
        opts?.useBanked
          ? 'Gift requested using banked weightage.'
          : 'Gift request submitted.',
      );
      void load();
    }
    setRedeemingKey(null);
  };

  const myWeightage = coerceAwardWeightage(
    myBalance.available,
    myProgress.find((r) => r.latest_score != null)?.latest_score ?? null,
  );
  const arrangeCount = queue.length + catalogQueue.length;

  if (loading && myProgress.length === 0 && team.length === 0) {
    return (
      <div className="mgr-rewards-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading rewards…</span>
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
            <h2 className="mgr-rewards-header__title">Company rewards</h2>
            <p className="mgr-rewards-header__subtitle">
              One monthly gift per person uses the gift cost; leftover goes to Banked. Movie and surprise can be redeemed in the same month and do not spend weightage.
            </p>
          </div>
        </div>
        <div className="mgr-rewards-stats">
          <div className="mgr-rewards-stat">
            <span className="mgr-rewards-stat__label">Earned</span>
            <strong>{formatAwardWeightage(myBalance.earned ?? myWeightage)}</strong>
          </div>
          <div className="mgr-rewards-stat mgr-rewards-stat--accent">
            <span className="mgr-rewards-stat__label">Current</span>
            <strong>{formatAwardWeightage(myWeightage)}</strong>
          </div>
          <div className="mgr-rewards-stat">
            <span className="mgr-rewards-stat__label">Used</span>
            <strong>{formatAwardWeightage(myBalance.deducted)}</strong>
          </div>
          <div className="mgr-rewards-stat">
            <span className="mgr-rewards-stat__label">Banked</span>
            <strong>{formatAwardWeightage(myBalance.banked)}</strong>
          </div>
          <div className="mgr-rewards-stat mgr-rewards-stat--gold">
            <span className="mgr-rewards-stat__label">Gifts to arrange</span>
            <strong>{arrangeCount}</strong>
          </div>
        </div>
      </header>

      {msg && (
        <div className={`mgr-rewards-alert ${msgError ? 'mgr-rewards-alert--error' : 'mgr-rewards-alert--success'}`}>
          {msgError ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
          <span>{msg}</span>
        </div>
      )}

      <KpiAwardProgressList
        rows={myProgress}
        title="Your company gifts"
        intro="Monthly gifts use the gift cost; leftover banks. You can also redeem dinner or catalog with Banked when it covers the cost."
        monthWeightage={myWeightage}
        bankedWeightage={myBalance.banked}
        onRedeem={claimMyGift}
        redeemingKey={redeemingKey}
      />

      <WeightageRewardCatalog
        userId={managerId}
        monthWeightage={myWeightage}
        bankedWeightage={myBalance.banked}
        title="Reward catalog"
        intro="One monthly catalog gift per month. Redeem with Current or with Banked when banked covers the cost."
        onRedeemed={() => void load()}
      />

      <section className="mgr-rewards-card">
        <h3>
          <Gift size={18} /> Gifts to arrange
          {arrangeCount > 0 && <span className="mgr-rewards-count-badge">{arrangeCount}</span>}
        </h3>
        <p>Approve, reject, or mark delivered. Rejecting returns the employee&apos;s used weightage.</p>
        {arrangeCount === 0 ? (
          <div className="mgr-rewards-empty">
            <CheckCircle size={36} strokeWidth={1.25} />
            <h4>Nothing waiting</h4>
            <p>No pending company gifts or catalog redemptions right now.</p>
          </div>
        ) : (
          <div className="mgr-rewards-queue">
            {queue.map((r) => (
              <article key={r.qualification_id || `${r.employee_id}-${r.rule_key}`} className="mgr-rewards-queue-item">
                <div className="mgr-rewards-queue-item__body">
                  <strong>{r.full_name}</strong>
                  <span>{r.reward_name} · {statusLabel(r.status || 'pending')}</span>
                </div>
                <div className="mgr-rewards-queue-item__actions">
                  {r.qualification_id && (r.status === 'pending' || r.status === 'pending_fulfillment') && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void updateGift(r.qualification_id!, 'approved')}>
                      Approve
                    </button>
                  )}
                  {r.qualification_id && r.status !== 'issued' && r.status !== 'fulfilled' && r.status !== 'dismissed' && (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void updateGift(r.qualification_id!, 'fulfilled')}>
                        Delivered
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          if (window.confirm(`Reject ${r.full_name}'s request for ${r.reward_name}? Weightage will be returned.`)) {
                            void updateGift(r.qualification_id!, 'rejected');
                          }
                        }}
                      >
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
            {catalogQueue.map((r) => (
              <article key={r.id} className="mgr-rewards-queue-item">
                <div className="mgr-rewards-queue-item__body">
                  <strong>{r.users?.full_name || 'Team member'}</strong>
                  <span>{r.rewards_catalog?.name || 'Catalog reward'} · {statusLabel(r.status)}</span>
                </div>
                <div className="mgr-rewards-queue-item__actions">
                  {r.status === 'pending' && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void updateCatalogRedemption(r.id, 'approved')}>
                      Approve
                    </button>
                  )}
                  {r.status !== 'fulfilled' && r.status !== 'rejected' && (
                    <>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => void updateCatalogRedemption(r.id, 'fulfilled')}>
                        Delivered
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => {
                          if (window.confirm(`Reject this catalog request? Weightage will be returned.`)) {
                            void updateCatalogRedemption(r.id, 'rejected');
                          }
                        }}
                      >
                        Reject
                      </button>
                    </>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      <AdminRewardHistoryPanel scope="manager" managerId={managerId} />

      <section className="mgr-rewards-card">
        <h3>
          <Users size={18} /> Each person
        </h3>
        <p>Progress toward each company gift. Tap a person for details.</p>
        {team.length === 0 ? (
          <p className="mgr-rewards-empty" style={{ padding: '1rem' }}>No team members to show yet.</p>
        ) : (
          <div className="mgr-rewards-table-wrap">
            <table className="mgr-rewards-table">
              <thead>
                <tr>
                  <th>Person</th>
                  <th>2 movie tickets</th>
                  <th>Dinner for 2</th>
                  <th>Surprise gift</th>
                  <th className="mgr-rewards-table__chevron-col" aria-hidden />
                </tr>
              </thead>
              <tbody>
                {team.map((m) => (
                  <tr
                    key={m.id}
                    className="mgr-rewards-table__row--clickable"
                    tabIndex={0}
                    role="button"
                    aria-label={`View gift progress for ${m.full_name}`}
                    onClick={() => setSelected(m)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setSelected(m);
                      }
                    }}
                  >
                    <td>
                      <strong>{m.full_name}</strong>
                      {m.email ? <div className="mgr-rewards-table__email">{m.email}</div> : null}
                    </td>
                    <td>{awardGiftLine(m.progress.find((r) => r.rule_key === 'movie_tickets'), '0/3 months')}</td>
                    <td>{awardGiftLine(m.progress.find((r) => r.rule_key === 'dinner_voucher'), '0/1 month')}</td>
                    <td>{awardGiftLine(m.progress.find((r) => r.rule_key === 'surprise_gift'), '0/6 months')}</td>
                    <td className="mgr-rewards-table__chevron-col">
                      <ChevronRight size={16} aria-hidden />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {selected && (
        <div className="mgr-rewards-person-overlay" onClick={() => setSelected(null)} role="presentation">
          <div
            className="mgr-rewards-person-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mgr-rewards-person-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mgr-rewards-person-dialog__top">
              <button type="button" className="mgr-rewards-person-back" onClick={() => setSelected(null)}>
                <ArrowLeft size={18} />
                Back
              </button>
            </div>
            <header className="mgr-rewards-person-dialog__header">
              <h2 id="mgr-rewards-person-title">{selected.full_name}</h2>
              {selected.email ? <p>{selected.email}</p> : null}
            </header>
            <KpiAwardProgressList
              rows={selected.progress}
              title={selected.isSelf ? 'Your gift progress' : `${selected.full_name}'s gift progress`}
              intro="Months at the required weightage count toward each gift. Dinner needs one qualifying month; movie tickets and surprise gifts need a streak."
            />
          </div>
        </div>
      )}
    </div>
  );
}
