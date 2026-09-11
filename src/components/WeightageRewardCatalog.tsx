import { useCallback, useEffect, useMemo, useState } from 'react';
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
  monthGiftClaimed = false,
  title = 'Reward catalog',
  intro = 'One monthly catalog gift per month (not with dinner). Movie/surprise streaks can be redeemed in the same month.',
  onRedeemed,
}: {
  userId: string;
  monthWeightage: number | null;
  /** True if this person already claimed a monthly gift (dinner or catalog) this month. */
  monthGiftClaimed?: boolean;
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

  const anyCatalogThisMonth = useMemo(() => {
    const key = new Date().toISOString().slice(0, 7);
    return mine.some((r) => String(r.redeemed_at).slice(0, 7) === key);
  }, [mine]);

  const blockedForMonth = monthGiftClaimed || anyCatalogThisMonth;

  const openOrPending = (rewardId: string) =>
    mine.find((r) => r.reward_id === rewardId && (r.status === 'pending' || r.status === 'approved'));

  const redeemedThisMonth = (rewardId: string) => {
    const key = new Date().toISOString().slice(0, 7);
    return mine.find(
      (r) => r.reward_id === rewardId && String(r.redeemed_at).slice(0, 7) === key,
    );
  };

  const handleRedeem = async (item: WeightageCatalogItem) => {
    setRedeemingId(item.id);
    setMsg(null);
    const { error } = await supabase.rpc('redeem_catalog_reward', { p_reward_id: item.id });
    if (error) {
      setMsg({ type: 'err', text: error.message || 'Could not redeem this reward.' });
      setRedeemingId(null);
      return;
    }
    setMsg({ type: 'ok', text: `Requested “${item.name}” — waiting for approval.` });
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
          const have = monthWeightage;
          const meets = have != null && have >= need;
          const pending = openOrPending(item.id);
          const doneMonth = redeemedThisMonth(item.id);
          const locked = !meets || Boolean(pending) || Boolean(doneMonth) || (blockedForMonth && !pending && !doneMonth);
          const busy = redeemingId === item.id;
          return (
            <article
              key={item.id}
              className={`emp-rewards-catalog-item${meets && !pending && !doneMonth && !blockedForMonth ? ' emp-rewards-catalog-item--ready' : ''}${locked && !pending && !doneMonth ? ' emp-rewards-catalog-item--locked' : ''}`}
            >
              <div className="emp-rewards-catalog-item__icon">
                <RewardCatalogIcon icon={item.icon} size={32} />
              </div>
              <div className="emp-rewards-catalog-item__body">
                <strong>{item.name}</strong>
                <span>{item.description || 'Company catalog reward'}</span>
                {!meets && !blockedForMonth && (
                  <span className="emp-rewards-catalog-item__need">
                    Need {formatAwardWeightage(need)} available
                    {have != null ? ` · you have ${formatAwardWeightage(have)}` : ''}
                  </span>
                )}
                {blockedForMonth && !pending && !doneMonth && (
                  <span className="emp-rewards-catalog-item__need">
                    You already redeemed a monthly gift this month
                  </span>
                )}
                {pending && (
                  <span className="emp-rewards-catalog-item__need">
                    Requested — {pending.status === 'approved' ? 'approved, arranging' : 'pending approval'}
                  </span>
                )}
                {doneMonth && !pending && (
                  <span className="emp-rewards-catalog-item__need">Already redeemed this month</span>
                )}
              </div>
              <div className="emp-rewards-catalog-item__foot">
                <span className="emp-rewards-catalog-item__cost">Uses {formatAwardWeightage(need)}</span>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={locked || busy}
                  onClick={() => void handleRedeem(item)}
                >
                  {busy ? (
                    <>
                      <Loader2 size={14} className="spin-icon" />
                      …
                    </>
                  ) : pending ? (
                    'Requested'
                  ) : doneMonth || blockedForMonth ? (
                    'Unavailable'
                  ) : (
                    'Redeem'
                  )}
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
