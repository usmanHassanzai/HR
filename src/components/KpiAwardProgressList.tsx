import { Film, Gift, UtensilsCrossed } from 'lucide-react';
import type { KpiAwardProgress } from '../utils/kpiAwardHelpers';
import '../styles/employee-rewards.css';

const RULES: {
  key: KpiAwardProgress['rule_key'];
  title: string;
  how: string;
}[] = [
  {
    key: 'movie_tickets',
    title: '2 movie tickets',
    how: 'Get 85–90% KPI score for 3 months in a row.',
  },
  {
    key: 'dinner_voucher',
    title: 'Dinner voucher for 2',
    how: 'Get 95–100% KPI score in any 1 month.',
  },
  {
    key: 'surprise_gift',
    title: 'Surprise gift from the company',
    how: 'Get 95–100% KPI score for 6 months in a row.',
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
  intro = 'The company gives these gifts from your monthly KPI score. You do not spend points and you do not redeem from a catalog.',
}: {
  rows: KpiAwardProgress[];
  title?: string;
  intro?: string;
}) {
  const byKey = new Map(rows.map((r) => [r.rule_key, r]));

  return (
    <section className="kpi-award-progress" aria-label="How company rewards work">
      <h3 className="kpi-award-progress__title">{title}</h3>
      <p className="kpi-award-progress__intro">{intro}</p>
      <div className="kpi-award-progress__list">
        {RULES.map((rule) => {
          const row = byKey.get(rule.key);
          const current = Number(row?.current_months || 0);
          const needed = Number(row?.required_months || (rule.key === 'dinner_voucher' ? 1 : rule.key === 'movie_tickets' ? 3 : 6));
          const ready = Boolean(row?.qualified);
          return (
            <article key={rule.key} className={`kpi-award-card${ready ? ' kpi-award-card--ready' : ''}`}>
              <div className="kpi-award-card__head">
                <span className="kpi-award-card__icon" aria-hidden>
                  <RuleIcon rule={rule.key} />
                </span>
                <div>
                  <strong>{row?.reward_name || rule.title}</strong>
                  <span>{rule.how}</span>
                </div>
              </div>
              <div className="kpi-award-bar" role="progressbar" aria-valuenow={Math.round((current / needed) * 100)} aria-valuemin={0} aria-valuemax={100}>
                <span className="kpi-award-bar__fill" style={{ width: `${Math.min(100, (current / needed) * 100)}%` }} />
              </div>
              <p className="kpi-award-card__hint">
                {ready
                  ? 'You qualified — waiting for your manager or admin to arrange this gift.'
                  : rule.key === 'dinner_voucher'
                    ? (row?.latest_score != null
                      ? `This month: ${Number(row.latest_score).toFixed(0)}% (need 95–100%).`
                      : 'Hit 95–100% this month to earn dinner for 2.')
                    : `${current} of ${needed} months`}
              </p>
            </article>
          );
        })}
      </div>
    </section>
  );
}
