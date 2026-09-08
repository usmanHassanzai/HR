import { useEffect, useMemo, useState } from 'react';
import type { Kpi } from '../utils/kpiHelpers';
import { formatKpiWeight, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import {
  availableKpiYears,
  employeeKpiBoardBreakdown,
  formatKpiScore,
  kpisForPeriod,
  MONTH_OPTIONS,
  performanceRatingColor,
  periodLabel,
  type KpiPeriodMode,
} from '../utils/kpiScoreHelpers';
import { karachiYearMonth } from '../utils/kpiCategories';
import type { RewardsSummary } from '../utils/rewardsHelpers';
import '../styles/employee-kpis.css';

interface KpiScoreboardSummaryProps {
  kpis: Kpi[];
  rewardsSummary?: RewardsSummary | null;
  /** Compact: hide long formula copy (manager embeds). */
  compact?: boolean;
  title?: string;
}

/**
 * Shared Overall / Month / Year KPI scoreboard for employees and managers.
 * Weightage ≤ 100%; Score is a points index (no % sign).
 */
export default function KpiScoreboardSummary({
  kpis,
  rewardsSummary = null,
  compact = false,
  title = 'KPI scoreboard',
}: KpiScoreboardSummaryProps) {
  const now = karachiYearMonth();
  const [periodMode, setPeriodMode] = useState<KpiPeriodMode>('month');
  const [filterMonth, setFilterMonth] = useState(now.monthIndex);
  const [filterYear, setFilterYear] = useState(now.year);

  const years = useMemo(() => availableKpiYears(kpis), [kpis]);

  useEffect(() => {
    if (!years.length) return;
    if (!years.includes(filterYear)) setFilterYear(years[0]);
  }, [years, filterYear]);

  const overallKpis = kpis;
  const overallSummary = useMemo(() => employeeKpiBoardBreakdown(overallKpis), [overallKpis]);
  const periodKpis = useMemo(
    () => kpisForPeriod(kpis, periodMode, filterYear, filterMonth),
    [kpis, periodMode, filterYear, filterMonth],
  );
  const periodSummary = useMemo(() => employeeKpiBoardBreakdown(periodKpis), [periodKpis]);
  const selectedLabel = periodLabel(periodMode, filterYear, filterMonth);

  const active = periodMode === 'overall' ? overallSummary : periodSummary;
  const activeEmpty = periodMode === 'overall' ? overallKpis.length === 0 : periodKpis.length === 0;
  const ratingColor = performanceRatingColor(active.performanceRating);
  const has = !activeEmpty && active.kpiCount > 0;

  const notRedeemedText = rewardsSummary ? rewardsSummary.balance.toLocaleString() : '—';
  const redeemedText = rewardsSummary ? rewardsSummary.usedPoints.toLocaleString() : '—';

  return (
    <section className="emp-kpi-summary emp-kpi-summary--shared">
      {!compact && (
        <div className="emp-kpi-summary__head">
          <div>
            <span className="emp-kpi-summary__eyebrow">Performance overview</span>
            <h2 className="emp-kpi-summary__title">{title}</h2>
            <p className="emp-kpi-summary__formula">
              Use Overall, Month, or Year to switch views. Weightage stays within 0–{KPI_WEIGHT_CAP}%.
              Score is a points index (no % sign).
            </p>
          </div>
        </div>
      )}

      <div className="emp-kpi-filter" role="search" aria-label="Filter KPIs by period">
        <div className="emp-kpi-filter__modes" role="tablist" aria-label="Period type">
          {([
            ['overall', 'Overall'],
            ['month', 'Month'],
            ['year', 'Year'],
          ] as const).map(([mode, label]) => (
            <button
              key={mode}
              type="button"
              role="tab"
              className={`emp-kpi-filter__mode${periodMode === mode ? ' emp-kpi-filter__mode--active' : ''}`}
              aria-selected={periodMode === mode}
              onClick={() => setPeriodMode(mode)}
            >
              {label}
            </button>
          ))}
        </div>

        {periodMode !== 'overall' && (
          <div className="emp-kpi-filter__selects">
            {periodMode === 'month' && (
              <label className="emp-kpi-filter__field">
                <span>Month</span>
                <select
                  value={filterMonth}
                  onChange={(e) => setFilterMonth(Number(e.target.value))}
                  aria-label="Select month"
                >
                  {MONTH_OPTIONS.map((m) => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="emp-kpi-filter__field">
              <span>Year</span>
              <select
                value={filterYear}
                onChange={(e) => setFilterYear(Number(e.target.value))}
                aria-label="Select year"
              >
                {(years.length ? years : [filterYear]).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
          </div>
        )}
      </div>

      <div className="emp-kpi-months emp-kpi-months--single">
        <article className="emp-kpi-month emp-kpi-month--current">
          <header>
            <span>
              {periodMode === 'overall' ? 'Overall' : periodMode === 'year' ? 'Selected year' : 'Selected month'}
            </span>
            <strong>
              {periodMode === 'overall' ? 'All assigned KPIs' : selectedLabel}
            </strong>
          </header>
          <p className="emp-kpi-month__scope">
            {periodMode === 'overall'
              ? `All-time · ${overallKpis.length} task${overallKpis.length === 1 ? '' : 's'} across every month.`
              : periodMode === 'year'
                ? `Only KPIs that overlap ${filterYear}. Switch to Overall for all-time results.`
                : `Only KPIs that overlap ${selectedLabel}. Switch to Overall for all-time results.`}
          </p>

          <section className="emp-kpi-block emp-kpi-block--weight" aria-label="Weightage">
            <div className="emp-kpi-block__head">
              <h4 className="emp-kpi-block__title">Weightage</h4>
              <span className="emp-kpi-block__badge">0–{KPI_WEIGHT_CAP}%</span>
            </div>
            <dl className="emp-kpi-month__stats">
              <div>
                <dt>Total weight</dt>
                <dd>{has ? formatKpiWeight(active.totalWeight) : '—'}</dd>
              </div>
              <div>
                <dt>Weight assigned</dt>
                <dd>{has ? formatKpiWeight(active.weightAssigned) : '—'}</dd>
              </div>
              <div>
                <dt>Weight achieved</dt>
                <dd>{has ? formatKpiWeight(active.weightAchieved) : '—'}</dd>
              </div>
              <div>
                <dt>Weight unassigned</dt>
                <dd>{has ? formatKpiWeight(active.weightUnassigned) : '—'}</dd>
              </div>
              <div>
                <dt>Weight pending</dt>
                <dd>{has ? formatKpiWeight(active.weightPending) : '—'}</dd>
              </div>
              <div>
                <dt>Completed</dt>
                <dd>{has ? `${active.completed}/${active.kpiCount}` : '—'}</dd>
              </div>
            </dl>
          </section>

          <section className="emp-kpi-block emp-kpi-block--score" aria-label="Score">
            <div className="emp-kpi-block__head">
              <h4 className="emp-kpi-block__title">Score</h4>
              <span className="emp-kpi-block__badge">Points index</span>
            </div>
            <div className="emp-kpi-month__score">
              <div className="emp-kpi-month__score-main">
                <span className="emp-kpi-month__score-label">Score</span>
                <span className="emp-kpi-month__pct" style={{ color: has ? ratingColor : undefined }}>
                  {has ? formatKpiScore(active.score) : '—'}
                </span>
              </div>
              {has ? (
                <span className="emp-kpi-month__rating" style={{ color: ratingColor }}>
                  {active.performanceRating}
                </span>
              ) : (
                <span className="emp-kpi-month__rating emp-kpi-month__rating--muted">No tasks</span>
              )}
            </div>
            <dl className="emp-kpi-month__stats">
              <div>
                <dt>Points awarded</dt>
                <dd>{has ? formatKpiScore(active.pointsAwarded) : '—'}</dd>
              </div>
              <div>
                <dt>Points not redeemed</dt>
                <dd>{notRedeemedText}</dd>
              </div>
              <div>
                <dt>Points redeemed</dt>
                <dd>{redeemedText}</dd>
              </div>
              <div>
                <dt>Tasks in scope</dt>
                <dd>{has ? String(active.kpiCount) : '—'}</dd>
              </div>
            </dl>
            {rewardsSummary && rewardsSummary.totalEarned > 0 && (
              <p className="emp-kpi-month__note">
                Reward points stay available until you redeem them · {rewardsSummary.totalEarned.toLocaleString()} earned lifetime.
              </p>
            )}
          </section>
        </article>
      </div>
    </section>
  );
}
