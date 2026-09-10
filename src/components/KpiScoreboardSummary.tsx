import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Kpi } from '../utils/kpiHelpers';
import { formatKpiWeight, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import {
  availableKpiYears,
  employeeKpiBoardBreakdown,
  kpisForPeriod,
  MONTH_OPTIONS,
  performanceRatingColor,
  performanceRatingForScore,
  periodLabel,
  type KpiPeriodMode,
} from '../utils/kpiScoreHelpers';
import { karachiYearMonth } from '../utils/kpiCategories';
import type { RewardsSummary } from '../utils/rewardsHelpers';
import '../styles/employee-kpis.css';

export interface KpiScoreboardPeriodState {
  mode: KpiPeriodMode;
  month: number;
  year: number;
}

interface KpiScoreboardSummaryProps {
  kpis: Kpi[];
  rewardsSummary?: RewardsSummary | null;
  /** Compact: hide long formula copy (manager embeds). */
  compact?: boolean;
  title?: string;
  /** Controlled period (keeps parent task lists in sync). */
  period?: KpiScoreboardPeriodState;
  onPeriodChange?: (next: KpiScoreboardPeriodState) => void;
  toolbar?: ReactNode;
  filterExtra?: ReactNode;
  footer?: ReactNode;
}

/**
 * Shared Overall / Month / Year KPI board — weightage only (0–100%).
 */
export default function KpiScoreboardSummary({
  kpis,
  rewardsSummary: _rewardsSummary = null,
  compact = false,
  title = 'KPI weightage',
  period,
  onPeriodChange,
  toolbar,
  filterExtra,
  footer,
}: KpiScoreboardSummaryProps) {
  const now = karachiYearMonth();
  const [internalMode, setInternalMode] = useState<KpiPeriodMode>('month');
  const [internalMonth, setInternalMonth] = useState(now.monthIndex);
  const [internalYear, setInternalYear] = useState(now.year);

  const controlled = period != null;
  const periodMode = controlled ? period.mode : internalMode;
  const filterMonth = controlled ? period.month : internalMonth;
  const filterYear = controlled ? period.year : internalYear;

  const setPeriod = (next: KpiScoreboardPeriodState) => {
    if (onPeriodChange) onPeriodChange(next);
    if (!controlled) {
      setInternalMode(next.mode);
      setInternalMonth(next.month);
      setInternalYear(next.year);
    }
  };

  const years = useMemo(() => availableKpiYears(kpis), [kpis]);

  useEffect(() => {
    if (!years.length) return;
    if (!years.includes(filterYear)) {
      setPeriod({ mode: periodMode, month: filterMonth, year: years[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only sync when year list changes
  }, [years]);

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
  const rating = performanceRatingForScore(active.weightAchieved);
  const ratingColor = performanceRatingColor(rating);
  const has = !activeEmpty && active.kpiCount > 0;

  return (
    <section className="emp-kpi-summary emp-kpi-summary--shared">
      {!compact && (
        <div className="emp-kpi-summary__head">
          <div>
            <span className="emp-kpi-summary__eyebrow">Performance overview</span>
            <h2 className="emp-kpi-summary__title">{title}</h2>
            <p className="emp-kpi-summary__formula">
              Use Overall, Month, or Year to switch views. Each view shows completed KPI weightage (0–{KPI_WEIGHT_CAP}%).
              Company gifts and catalog rewards use this weightage.
            </p>
          </div>
          {toolbar ? <div className="emp-kpi-toolbar">{toolbar}</div> : null}
        </div>
      )}

      {compact && (title || toolbar) ? (
        <div className="emp-kpi-summary__head emp-kpi-summary__head--compact">
          {title ? <h3 className="emp-kpi-summary__title emp-kpi-summary__title--compact">{title}</h3> : <span />}
          {toolbar ? <div className="emp-kpi-toolbar">{toolbar}</div> : null}
        </div>
      ) : null}

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
              onClick={() => setPeriod({ mode, month: filterMonth, year: filterYear })}
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
                  onChange={(e) => setPeriod({ mode: periodMode, month: Number(e.target.value), year: filterYear })}
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
                onChange={(e) => setPeriod({ mode: periodMode, month: filterMonth, year: Number(e.target.value) })}
                aria-label="Select year"
              >
                {(years.length ? years : [filterYear]).map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
          </div>
        )}

        {filterExtra}
      </div>

      <div className="emp-kpi-months emp-kpi-months--single">
        <article className="emp-kpi-month emp-kpi-month--current">
          <header className="emp-kpi-month__header">
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
            <div className="emp-kpi-month__score">
              <div className="emp-kpi-month__score-main">
                <span className="emp-kpi-month__score-label">Achieved</span>
                <span className="emp-kpi-month__pct" style={{ color: has ? ratingColor : undefined }}>
                  {has ? formatKpiWeight(active.weightAchieved) : '—'}
                </span>
              </div>
              {has ? (
                <span className="emp-kpi-month__rating" style={{ color: ratingColor }}>
                  {rating}
                </span>
              ) : (
                <span className="emp-kpi-month__rating emp-kpi-month__rating--muted">No tasks</span>
              )}
            </div>
            <dl className="emp-kpi-month__stats emp-kpi-month__stats--weight">
              <div>
                <dt>Total</dt>
                <dd>{has ? formatKpiWeight(active.totalWeight) : '—'}</dd>
              </div>
              <div>
                <dt>Assigned</dt>
                <dd>{has ? formatKpiWeight(active.weightAssigned) : '—'}</dd>
              </div>
              <div>
                <dt>Achieved</dt>
                <dd>{has ? formatKpiWeight(active.weightAchieved) : '—'}</dd>
              </div>
              <div>
                <dt>Unassigned</dt>
                <dd>{has ? formatKpiWeight(active.weightUnassigned) : '—'}</dd>
              </div>
              <div>
                <dt>Pending</dt>
                <dd>{has ? formatKpiWeight(active.weightPending) : '—'}</dd>
              </div>
              <div>
                <dt>Done</dt>
                <dd>{has ? `${active.completed}/${active.kpiCount}` : '—'}</dd>
              </div>
            </dl>
          </section>
        </article>
      </div>

      {footer}
    </section>
  );
}
