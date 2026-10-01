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
import { fetchMonthWeightageBalance } from '../utils/monthWeightageBalance';
import {
  estimateUnusedPriorWeightage,
  isWeightageRevealDay,
  weightageRevealHint,
} from '../utils/weightageReveal';
import '../styles/employee-kpis.css';

export interface KpiScoreboardPeriodState {
  mode: KpiPeriodMode;
  month: number;
  year: number;
}

interface KpiScoreboardSummaryProps {
  kpis: Kpi[];
  userId?: string;
  rewardsSummary?: RewardsSummary | null;
  /** Compact: hide long formula copy (manager embeds). */
  compact?: boolean;
  title?: string;
  /**
   * For employee/manager self dashboards: hide achieved weightage until the
   * last day of the month (28/29/30/31). Admins reviewing still see live awards.
   */
  deferAchievedUntilMonthEnd?: boolean;
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
  userId,
  rewardsSummary: _rewardsSummary = null,
  compact = false,
  title = 'KPI weightage',
  deferAchievedUntilMonthEnd = false,
  period,
  onPeriodChange,
  toolbar,
  filterExtra,
  footer,
}: KpiScoreboardSummaryProps) {
  const now = karachiYearMonth();
  const revealToday = isWeightageRevealDay();
  const [internalMode, setInternalMode] = useState<KpiPeriodMode>('month');
  const [internalMonth, setInternalMonth] = useState(now.monthIndex);
  const [internalYear, setInternalYear] = useState(now.year);
  const [giftUsed, setGiftUsed] = useState(0);
  const [giftAvailable, setGiftAvailable] = useState<number | null>(null);
  const [giftBanked, setGiftBanked] = useState(0);
  const [giftEarned, setGiftEarned] = useState<number | null>(null);

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

  const isCurrentMonthView =
    periodMode === 'month' && filterYear === now.year && filterMonth === now.monthIndex;
  const isPastMonthView =
    periodMode === 'month'
    && (filterYear < now.year || (filterYear === now.year && filterMonth < now.monthIndex));
  /** Only mask current-month awards mid-month — past months stay fully visible. */
  const deferActive =
    Boolean(deferAchievedUntilMonthEnd) && isCurrentMonthView && !revealToday;

  const estimatedPriorBanked = useMemo(
    () => estimateUnusedPriorWeightage(kpis),
    [kpis],
  );

  useEffect(() => {
    // Banked is cross-month — load whenever we know the user, for every period view.
    if (!userId) {
      setGiftUsed(0);
      setGiftAvailable(null);
      setGiftBanked(0);
      setGiftEarned(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const bal = await fetchMonthWeightageBalance(userId);
      if (cancelled) return;
      setGiftUsed(bal.deducted);
      setGiftAvailable(bal.available);
      // Prefer server banked; fall back to prior-month unused until rollover migrates.
      setGiftBanked(bal.banked > 0 ? bal.banked : estimatedPriorBanked);
      setGiftEarned(bal.earned);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, kpis, revealToday, estimatedPriorBanked]);

  const overallKpis = kpis;
  const overallSummary = useMemo(
    () => employeeKpiBoardBreakdown(overallKpis, { deferAchievedUntilMonthEnd }),
    [overallKpis, deferAchievedUntilMonthEnd],
  );
  const periodKpis = useMemo(
    () => kpisForPeriod(kpis, periodMode, filterYear, filterMonth),
    [kpis, periodMode, filterYear, filterMonth],
  );
  const periodSummary = useMemo(
    () => employeeKpiBoardBreakdown(periodKpis, {
      deferAchievedUntilMonthEnd:
        periodMode === 'overall'
          ? deferAchievedUntilMonthEnd
          : deferActive,
    }),
    [periodKpis, periodMode, deferAchievedUntilMonthEnd, deferActive],
  );
  const selectedLabel = periodLabel(periodMode, filterYear, filterMonth);

  const active = periodMode === 'overall' ? overallSummary : periodSummary;
  const activeEmpty = periodMode === 'overall' ? overallKpis.length === 0 : periodKpis.length === 0;
  const has = !activeEmpty && active.kpiCount > 0;
  const showLiveGiftLedger = Boolean(isCurrentMonthView && userId);
  const showBankedRow = Boolean(userId);

  const bankedWeightage = showBankedRow ? giftBanked : 0;
  const earnedWeightage = deferActive
    ? 0
    : showLiveGiftLedger && giftEarned != null
      ? giftEarned
      : active.weightAchieved;
  const usedWeightage = deferActive ? 0 : (showLiveGiftLedger ? giftUsed : 0);
  const monthRemaining = Math.max(0, earnedWeightage - usedWeightage);
  /** Current month: available + banked. Past month board: that month's unused (before/while banking). */
  const currentOnly =
    deferActive
      ? 0
      : showLiveGiftLedger && giftAvailable != null
        ? giftAvailable
        : isCurrentMonthView
          ? monthRemaining
          : 0;
  const currentWeightage = isPastMonthView
    ? monthRemaining
    : currentOnly + bankedWeightage;

  const rating = performanceRatingForScore(earnedWeightage);
  const ratingColor = performanceRatingColor(rating);

  return (
    <section className="emp-kpi-summary emp-kpi-summary--shared">
      {!compact && (
        <div className="emp-kpi-summary__head">
          <div>
            <span className="emp-kpi-summary__eyebrow">Your weightage at a glance</span>
            <h2 className="emp-kpi-summary__title">{title}</h2>
            <p className="emp-kpi-summary__formula">
              Finish tasks to earn weightage (up to {KPI_WEIGHT_CAP}% each month). This month&apos;s awards unlock on the last day.
              Unused weightage from earlier months stays saved and never expires until you redeem — leftovers after a gift stack with the next unlock.
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
              {periodMode === 'overall' ? 'Overall' : periodMode === 'year' ? 'Selected year' : 'This month'}
            </span>
            <strong>
              {periodMode === 'overall' ? 'All your tasks' : selectedLabel}
            </strong>
          </header>
          <p className="emp-kpi-month__scope">
            {periodMode === 'overall'
              ? `Everything you have been given · ${overallKpis.length} task${overallKpis.length === 1 ? '' : 's'}.`
              : periodMode === 'year'
                ? `Tasks in ${filterYear}. Switch to Month for gift balance details.`
                : `Tasks in ${selectedLabel}. Unused weightage from earlier months stays available until you redeem.`}
          </p>

          {deferActive ? (
            <p className="emp-kpi-month__reveal" role="status">
              {weightageRevealHint()} Prior unused weightage stays in Saved for later and Left to use until you redeem — it never expires.
            </p>
          ) : null}

          <section className="emp-kpi-block emp-kpi-block--weight" aria-label="Your weightage">
            <div className="emp-kpi-block__head">
              <h4 className="emp-kpi-block__title">Your weightage</h4>
              <span className="emp-kpi-block__badge">Max {KPI_WEIGHT_CAP}%</span>
            </div>
            <div className="emp-kpi-month__score">
              <div className="emp-kpi-month__score-main">
                <span className="emp-kpi-month__score-label">
                  {showBankedRow || periodMode === 'month' ? 'Left to use now' : 'You earned'}
                </span>
                <span
                  className="emp-kpi-month__pct"
                  style={{ color: currentWeightage > 0 || (has && !deferActive) ? ratingColor : undefined }}
                >
                  {formatKpiWeight(
                    showBankedRow || periodMode === 'month' ? currentWeightage : earnedWeightage,
                  )}
                </span>
                {deferActive ? (
                  <span className="emp-kpi-month__score-hint">
                    This month&apos;s awards unlock on the last day — banked leftover is usable now
                  </span>
                ) : has && (showBankedRow || periodMode === 'month') ? (
                  <span className="emp-kpi-month__score-hint">
                    Current remaining + saved from earlier months
                  </span>
                ) : null}
              </div>
              {has && !deferActive && earnedWeightage > 0 ? (
                <span className="emp-kpi-month__rating" style={{ color: ratingColor }}>
                  {rating}
                </span>
              ) : (
                <span className="emp-kpi-month__rating emp-kpi-month__rating--muted">
                  {deferActive
                    ? (bankedWeightage > 0 ? 'Banked available' : 'Month-end unlock')
                    : 'No tasks yet'}
                </span>
              )}
            </div>

            <dl className="emp-kpi-month__stats emp-kpi-month__stats--weight emp-kpi-month__stats--plain">
              <div>
                <dt>Month limit</dt>
                <dd>{formatKpiWeight(has ? active.totalWeight : KPI_WEIGHT_CAP)}</dd>
                <span className="emp-kpi-stat-note">Highest you can earn</span>
              </div>
              <div>
                <dt>Earned this month</dt>
                <dd>{formatKpiWeight(earnedWeightage)}</dd>
                <span className="emp-kpi-stat-note">
                  {deferActive ? 'Unlocks on last day' : 'From finished tasks'}
                </span>
              </div>
              <div>
                <dt>Used on gifts</dt>
                <dd>{formatKpiWeight(usedWeightage)}</dd>
                <span className="emp-kpi-stat-note">Already spent</span>
              </div>
              <div className="emp-kpi-stat--highlight">
                <dt>Left to use</dt>
                <dd>{formatKpiWeight(currentWeightage)}</dd>
                <span className="emp-kpi-stat-note">
                  {deferActive
                    ? 'Banked leftover (usable now)'
                    : isPastMonthView
                      ? 'Unused this month (moves to bank next month)'
                      : isCurrentMonthView
                        ? 'Current + banked'
                        : 'Banked account (usable any month)'}
                </span>
              </div>
              <div>
                <dt>Saved for later</dt>
                <dd>{formatKpiWeight(bankedWeightage)}</dd>
                <span className="emp-kpi-stat-note">Banked account — every month, never expires</span>
              </div>
              <div>
                <dt>In your tasks</dt>
                <dd>{formatKpiWeight(active.weightAssigned)}</dd>
                <span className="emp-kpi-stat-note">Total task weight</span>
              </div>
              <div>
                <dt>Still open</dt>
                <dd>{formatKpiWeight(active.weightPending)}</dd>
                <span className="emp-kpi-stat-note">Not finished yet</span>
              </div>
              <div>
                <dt>Finished tasks</dt>
                <dd>{`${active.completed} of ${active.kpiCount}`}</dd>
                <span className="emp-kpi-stat-note">Approved or done</span>
              </div>
              <div>
                <dt>Not given yet</dt>
                <dd>{formatKpiWeight(has ? active.weightUnassigned : KPI_WEIGHT_CAP)}</dd>
                <span className="emp-kpi-stat-note">Room left to assign</span>
              </div>
            </dl>

            {showBankedRow ? (
              <p className="emp-kpi-weight-guide">
                Simple rule: unused weightage from a closed month moves to <strong>Saved for later</strong> (banked) automatically.
                Then <strong>Earned</strong> (after month end) + <strong>Saved for later</strong> − <strong>Used on gifts</strong> = <strong>Left to use</strong>.
                Banked never expires and can be used any month for rewards.
              </p>
            ) : null}
          </section>
        </article>
      </div>

      {footer}
    </section>
  );
}
