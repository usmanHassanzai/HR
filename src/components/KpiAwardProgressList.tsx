import { Film, Gift, Loader2, UtensilsCrossed } from 'lucide-react';
import type { KpiAwardProgress, KpiAwardRuleKey } from '../utils/kpiAwardHelpers';
import {
  awardProgressHint,
  formatAwardWeightage,
  formatAwardWeightageBand,
  isAwardRedeemable,
  withAwardWeightage,
} from '../utils/kpiAwardHelpers';
import '../styles/employee-rewards.css';

const RULES: {
  key: KpiAwardProgress['rule_key'];
  title: string;
  how: (row?: KpiAwardProgress) => string;
}[] = [
  {
    key: 'movie_tickets',
    title: '2 movie tickets',
    how: (row) => {
      const min = Number(row?.min_pct ?? 85);
      const max = Number(row?.max_pct ?? 90);
      const months = Number(row?.required_months ?? 3);
      return `Keep weightage of ${formatAwardWeightageBand(min, max)} for ${months} months in a row.`;
    },
  },
  {
    key: 'dinner_voucher',
    title: 'Dinner voucher for 2',
    how: (row) => {
      const min = Number(row?.min_pct ?? 95);
      const max = Number(row?.max_pct ?? 100);
      return `Reach weightage of ${formatAwardWeightageBand(min, max)} in any 1 month, or redeem with banked when you have enough.`;
    },
  },
  {
    key: 'surprise_gift',
    title: 'Surprise gift from the company',
    how: (row) => {
      const min = Number(row?.min_pct ?? 95);
      const max = Number(row?.max_pct ?? 100);
      const months = Number(row?.required_months ?? 6);
      return `Keep weightage of ${formatAwardWeightageBand(min, max)} for ${months} months in a row.`;
    },
  },
];

function RuleIcon({ rule }: { rule: string }) {
  if (rule === 'movie_tickets') return <Film size={20} />;
  if (rule === 'dinner_voucher') return <UtensilsCrossed size={20} />;
  return <Gift size={20} />;
}

export default function KpiAwardProgressList({
  rows,
  title = 'How you earn rewards',
  intro = 'These gifts come from your monthly weightage (completed KPI weight out of 100%).',
  monthWeightage = null,
  bankedWeightage = 0,
  monthGiftClaimed = false,
  claimedKeys,
  onRedeem,
  redeemingKey = null,
}: {
  rows: KpiAwardProgress[];
  title?: string;
  intro?: string;
  /** Client-computed this-month weightage (0–100); used when RPC still returns score points. */
  monthWeightage?: number | null;
  bankedWeightage?: number;
  /** True when dinner or catalog already claimed this month. */
  monthGiftClaimed?: boolean;
  claimedKeys?: Set<string> | ReadonlySet<string>;
  onRedeem?: (ruleKey: KpiAwardRuleKey, opts?: { useBanked?: boolean }) => void | Promise<void>;
  redeemingKey?: KpiAwardRuleKey | null;
}) {
  const byKey = new Map(rows.map((r) => [r.rule_key, r]));
  const banked = Number(bankedWeightage) || 0;

  return (
    <section className="kpi-award-progress" aria-label="How company rewards work">
      <h3 className="kpi-award-progress__title">{title}</h3>
      <p className="kpi-award-progress__intro">{intro}</p>
      <div className="kpi-award-progress__list">
        {RULES.map((rule) => {
          const row = withAwardWeightage(byKey.get(rule.key), monthWeightage ?? null);
          const current = Number(row?.current_months || 0);
          const needed = Number(row?.required_months || (rule.key === 'dinner_voucher' ? 1 : rule.key === 'movie_tickets' ? 3 : 6));
          const claimed = Boolean(claimedKeys?.has(rule.key));
          const canRedeemCurrent =
            isAwardRedeemable(row, monthWeightage ?? null) && !claimed && !monthGiftClaimed && Boolean(onRedeem);
          const dinnerCost = Number(row?.min_pct ?? 95);
          const canBanked =
            rule.key === 'dinner_voucher' &&
            banked >= dinnerCost &&
            !claimed &&
            !monthGiftClaimed &&
            Boolean(onRedeem);
          const canRedeem = canRedeemCurrent || canBanked;
          const ready = canRedeem || claimed;
          const barPct = Math.min(100, needed > 0 ? (current / needed) * 100 : 0);
          const busy = redeemingKey === rule.key;
          return (
            <article key={rule.key} className={`kpi-award-card${ready ? ' kpi-award-card--ready' : ''}`}>
              <div className="kpi-award-card__head">
                <span className="kpi-award-card__icon" aria-hidden>
                  <RuleIcon rule={rule.key} />
                </span>
                <div>
                  <strong>{row?.reward_name || rule.title}</strong>
                  <span>{rule.how(row)}</span>
                </div>
              </div>
              <div className="kpi-award-bar" role="progressbar" aria-valuenow={Math.round(barPct)} aria-valuemin={0} aria-valuemax={100}>
                <span className="kpi-award-bar__fill" style={{ width: `${barPct}%` }} />
              </div>
              <p className="kpi-award-card__hint">
                {awardProgressHint(row, `${current} of ${needed} months`, { claimed, canRedeem: canRedeemCurrent })}
                {rule.key === 'dinner_voucher' && canBanked && !canRedeemCurrent ? (
                  <> · Banked {formatAwardWeightage(banked)} can cover this gift.</>
                ) : null}
              </p>
              {(canRedeemCurrent || canBanked) && !claimed ? (
                <div className="kpi-award-card__actions">
                  {canRedeemCurrent ? (
                    <button
                      type="button"
                      className="btn btn-primary kpi-award-card__redeem"
                      disabled={busy}
                      onClick={() => void onRedeem?.(rule.key, { useBanked: false })}
                    >
                      {busy ? (
                        <>
                          <Loader2 size={16} className="spin-icon" />
                          Requesting…
                        </>
                      ) : (
                        'Redeem'
                      )}
                    </button>
                  ) : null}
                  {canBanked ? (
                    <button
                      type="button"
                      className="btn btn-secondary kpi-award-card__redeem"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Use ${formatAwardWeightage(dinnerCost)} from banked weightage for this dinner gift?`,
                          )
                        ) {
                          void onRedeem?.(rule.key, { useBanked: true });
                        }
                      }}
                    >
                      {busy ? (
                        <>
                          <Loader2 size={16} className="spin-icon" />
                          Requesting…
                        </>
                      ) : (
                        'Redeem with Banked'
                      )}
                    </button>
                  ) : null}
                </div>
              ) : null}
              {claimed ? (
                <span className="kpi-award-card__claimed">Requested</span>
              ) : null}
            </article>
          );
        })}
      </div>
    </section>
  );
}
