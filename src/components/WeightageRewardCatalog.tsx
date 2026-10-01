import { useCallback, useEffect, useState } from 'react';
import { Gift, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { formatAwardWeightage } from '../utils/kpiAwardHelpers';
import RewardCatalogIcon from './RewardCatalogIcon';
import '../styles/employee-rewards.css';

export interface WeightageCatalogItem {
  id: string;
  name: string;
  description: string | null;
  icon: string;
  weightage_required: number;
  active: boolean;
}

interface CatalogRedemption {
  id: string;
  reward_id: string;
  status: string;
  redeemed_at: string;
}

export default function WeightageRewardCatalog({
  userId,
  monthWeightage,
  bankedWeightage = 0,
  title = 'Reward catalog',
  intro = 'Current month + banked weightage are added together for every gift. Example: 60% current + 30% banked = 90%. Banked never expires. Leftover after a redeem stays banked.',
  onRedeemed,
}: {
  userId: string;
  monthWeightage: number | null;
  /** Cross-month banked leftover weightage. */
  bankedWeightage?: number;
  title?: string;
  intro?: string;
  onRedeemed?: () => void;
}) {
  const [items, setItems] = useState<WeightageCatalogItem[]>([]);
  const [mine, setMine] = useState<CatalogRedemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ type: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [catRes, redRes] = await Promise.all([
      supabase
        .from('rewards_catalog')
        .select('id, name, description, icon, weightage_required, active')
        .eq('active', true)
        .order('weightage_required', { ascending: true }),
      supabase
        .from('reward_redemptions')
        .select('id, reward_id, status, redeemed_at')
        .eq('employee_id', userId)
        .order('redeemed_at', { ascending: false }),
    ]);
    setItems(((catRes.data || []) as WeightageCatalogItem[]).map((r) => ({
      ...r,
      weightage_required: Number(r.weightage_required) || 0,
    })));
    setMine((redRes.data || []) as CatalogRedemption[]);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openOrPending = (rewardId: string) =>
    mine.find((r) => r.reward_id === rewardId && (r.status === 'pending' || r.status === 'approved'));

  const handleRedeem = async (item: WeightageCatalogItem, _useBanked?: boolean) => {
    setRedeemingId(item.id);
    setMsg(null);
    const { error } = await supabase.rpc('redeem_catalog_reward', {
      p_reward_id: item.id,
      p_use_banked: false,
    });
    if (error) {
      setMsg({ type: 'err', text: error.message || 'Could not redeem this reward.' });
      setRedeemingId(null);
      return;
    }
    setMsg({
      type: 'ok',
      text: `Requested “${item.name}” using current + banked weightage — waiting for approval.`,
    });
    await load();
    onRedeemed?.();
    setRedeemingId(null);
  };

  if (loading && items.length === 0) {
    return (
      <section className="emp-rewards-card">
        <h3><Gift size={18} /> {title}</h3>
        <div className="emp-rewards-loading" style={{ padding: '1.5rem' }}>
          <Loader2 size={22} className="spin-icon" />
          <span>Loading catalog…</span>
        </div>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section className="emp-rewards-card">
        <h3><Gift size={18} /> {title}</h3>
        <p>{intro}</p>
        <div className="emp-rewards-empty">
          <Gift size={36} strokeWidth={1.25} />
          <h4>No catalog rewards yet</h4>
          <p>When your admin adds rewards, they appear here.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="emp-rewards-card">
      <h3><Gift size={18} /> {title}</h3>
      <p>{intro}</p>
      {msg ? (
        <div className={`emp-rewards-alert emp-rewards-alert--${msg.type === 'ok' ? 'success' : 'error'}`}>
          {msg.text}
        </div>
      ) : null}
      <div className="emp-rewards-catalog">
        {items.map((item) => {
          const need = Number(item.weightage_required) || 0;
          const have = Number(monthWeightage) || 0;
          const banked = Number(bankedWeightage) || 0;
          const total = have + banked;
          const meetsTotal = total >= need;
          const pending = openOrPending(item.id);
          const busy = redeemingId === item.id;
          const canRedeem = meetsTotal && !pending;
          const ready = canRedeem || Boolean(pending);
          return (
            <article
              key={item.id}
              className={`emp-rewards-catalog-item${ready ? ' emp-rewards-catalog-item--ready' : ''}${!ready && !pending ? ' emp-rewards-catalog-item--locked' : ''}`}
            >
              <div className="emp-rewards-catalog-item__icon">
                <RewardCatalogIcon icon={item.icon} size={32} />
              </div>
              <div className="emp-rewards-catalog-item__body">
                <strong>{item.name}</strong>
                <span>{item.description || 'Company catalog reward'}</span>
                {!meetsTotal && !pending && (
                  <span className="emp-rewards-catalog-item__need">
                    Need {formatAwardWeightage(need)}
                    {' · '}
                    total {formatAwardWeightage(total)}
                    {' '}(current {formatAwardWeightage(have)} + banked {formatAwardWeightage(banked)})
                  </span>
                )}
                {meetsTotal && !pending && (
                  <span className="emp-rewards-catalog-item__need">
                    Total {formatAwardWeightage(total)} covers this gift
                    {' '}(current {formatAwardWeightage(have)} + banked {formatAwardWeightage(banked)})
                  </span>
                )}
                {pending && (
                  <span className="emp-rewards-catalog-item__need">
                    Requested — {pending.status === 'approved' ? 'approved, arranging' : 'pending approval'}
                  </span>
                )}
              </div>
              <div className="emp-rewards-catalog-item__foot">
                <span className="emp-rewards-catalog-item__cost">Uses {formatAwardWeightage(need)}</span>
                <div className="emp-rewards-catalog-item__actions">
                  {canRedeem ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={busy}
                      onClick={() => void handleRedeem(item)}
                    >
                      {busy ? <Loader2 size={14} className="spin-icon" /> : null}
                      Redeem
                    </button>
                  ) : (
                    <button type="button" className="btn btn-primary btn-sm" disabled>
                      {pending ? 'Requested' : 'Redeem'}
                    </button>
                  )}
                </div>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
