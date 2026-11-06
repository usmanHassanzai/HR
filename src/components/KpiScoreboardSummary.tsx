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
  fetchUserMonthScore,
  formatPoints,
  monthStartIso,
  type MyScoreWeightage,
} from '../utils/scoreWeightage';
import {
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
  const [giftEarned, setGiftEarned] = useState<number | null>(null);
  const [monthScore, setMonthScore] = useState<MyScoreWeightage | null>(null);
  const [monthScoreState, setMonthScoreState] = useState<'loading' | 'ready' | 'empty' | 'unavailable'>('loading');

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

  useEffect(() => {
    if (!userId || !isCurrentMonthView) {
      setGiftUsed(0);
      setGiftAvailable(null);
      setGiftEarned(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const bal = await fetchMonthWeightageBalance(userId);
      if (cancelled) return;
      setGiftUsed(bal.deducted);
      setGiftAvailable(bal.available);
      setGiftEarned(bal.earned);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, kpis, revealToday, isCurrentMonthView]);

  useEffect(() => {
    if (periodMode !== 'month' || !userId) {
      setMonthScore(null);
      setMonthScoreState('empty');
      return;
    }
    let cancelled = false;
    setMonthScoreState('loading');
    void fetchUserMonthScore(userId, monthStartIso(filterYear, filterMonth))
      .then((row) => {
        if (cancelled) return;
        setMonthScore(row);
        setMonthScoreState(
          row.department_id && row.individual_weight != null && row.team_weight != null
            ? 'ready'
            : 'empty',
        );
      })
      .catch(() => {
        if (cancelled) return;
        setMonthScore(null);
        setMonthScoreState('unavailable');
      });
    return () => {
      cancelled = true;
    };
  }, [userId, periodMode, filterYear, filterMonth]);

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

  const taskEarned = deferActive
    ? 0
    : showLiveGiftLedger && giftEarned != null
      ? giftEarned
      : active.weightAchieved;
  /** Team points count once the month is visible. Hidden until the last day when deferred. */
  const teamGained = !deferActive && periodMode === 'month' && monthScoreState === 'ready'
    ? Math.max(0, Number(monthScore?.team_points) || 0)
    : 0;
  const earnedWeightage = taskEarned + teamGained;
  const usedWeightage = deferActive ? 0 : (showLiveGiftLedger ? giftUsed : 0);
  const kpiLeft = deferActive
    ? 0
    : isPastMonthView
      ? Math.max(0, taskEarned - usedWeightage)
      : showLiveGiftLedger && giftAvailable != null
        ? giftAvailable
        : Math.max(0, taskEarned - usedWeightage);
  const currentWeightage = periodMode === 'month'
    ? kpiLeft + teamGained
    : taskEarned;

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
              Each month shows only the weightage from that month. Individual tasks use the individual share; the rest is team work.
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
                : `Tasks in ${selectedLabel}. Only this month's weightage is shown.`}
          </p>

          {deferActive ? (
            <p className="emp-kpi-month__reveal" role="status">
              {weightageRevealHint()}
            </p>
          ) : null}

          {deferActive ? (
            <section className="emp-kpi-block emp-kpi-block--weight" aria-label="Your weightage">
              <div className="emp-kpi-block__head">
                <h4 className="emp-kpi-block__title">Your weightage</h4>
                <span className="emp-kpi-block__badge">Last day</span>
              </div>
              <p className="emp-kpi-month__reveal" role="status">
                {weightageRevealHint()} Task weightage, team points, and your score stay hidden until then.
              </p>
            </section>
          ) : (
          <section className="emp-kpi-block emp-kpi-block--weight" aria-label="Your weightage">
            <div className="emp-kpi-block__head">
              <h4 className="emp-kpi-block__title">Your weightage</h4>
              <span className="emp-kpi-block__badge">Max {KPI_WEIGHT_CAP}%</span>
            </div>
            <div className="emp-kpi-month__score">
              <div className="emp-kpi-month__score-main">
                <span className="emp-kpi-month__score-label">
                  {periodMode === 'month' ? 'Left to use now' : 'You earned'}
                </span>
                <span
                  className="emp-kpi-month__pct"
                  style={{ color: currentWeightage > 0 || (has && !deferActive) ? ratingColor : undefined }}
                >
                  {formatKpiWeight(
                    periodMode === 'month' ? currentWeightage : earnedWeightage,
                  )}
                </span>
                {deferActive ? (
                  <span className="emp-kpi-month__score-hint">
                    This month&apos;s awards unlock on the last day.
                  </span>
                ) : periodMode === 'month' ? (
                  <span className="emp-kpi-month__score-hint">
                    {teamGained > 0 ? 'Tasks plus team points this month' : 'This month only'}
                  </span>
                ) : null}
              </div>
              {has && !deferActive && taskEarned > 0 ? (
                <span className="emp-kpi-month__rating" style={{ color: ratingColor }}>
                  {rating}
                </span>
              ) : teamGained > 0 ? (
                <span className="emp-kpi-month__rating" style={{ color: ratingColor }}>
                  Team points
                </span>
              ) : (
                <span className="emp-kpi-month__rating emp-kpi-month__rating--muted">
                  {deferActive ? 'Month-end unlock' : 'No tasks yet'}
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
                  {teamGained > 0
                    ? 'Finished tasks plus team points'
                    : deferActive
                      ? 'Unlocks on last day'
                      : 'From this month\'s finished tasks'}
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
                  {isPastMonthView ? 'Unused this month' : 'This month only'}
                </span>
              </div>
              <div>
                <dt>In your tasks</dt>
                <dd>{formatKpiWeight(active.weightAssigned)}</dd>
                <span className="emp-kpi-stat-note">Individual tasks this month</span>
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
            </dl>

            {periodMode === 'month' ? (
              <p className="emp-kpi-weight-guide">
                <strong>Left to use</strong> is what you gained this month, including team points, minus gifts already used. Earlier months stay on their own month.
              </p>
            ) : null}
          </section>
          )}

          {periodMode === 'month' && userId ? (
            deferActive ? (
              <section className="emp-kpi-mix" aria-label={`${selectedLabel} total out of 100`}>
                <div className="emp-kpi-mix__head">
                  <div>
                    <h4>From 100 this month</h4>
                    <p>Your score and points appear on the last day of the month.</p>
                  </div>
                </div>
              </section>
            ) : (
            <MonthOutOfHundred
              state={monthScoreState}
              score={monthScore}
              label={selectedLabel}
            />
            )
          ) : null}
        </article>
      </div>

      {footer}
    </section>
  );
}

function shareWidth(points: number | null, weight: number | null): number {
  const value = points == null || !Number.isFinite(points) ? 0 : Math.max(0, points);
  const cap = weight != null && Number.isFinite(weight) ? Math.max(0, weight) : value;
  return Math.min(value, cap > 0 ? cap : value);
}

function MonthOutOfHundred({
  state,
  score,
  label,
}: {
  state: 'loading' | 'ready' | 'empty' | 'unavailable';
  score: MyScoreWeightage | null;
  label: string;
}) {
  const ownWeight = score?.individual_weight ?? 0;
  const teamWeight = score?.team_weight ?? 0;
  const ownPoints = shareWidth(score?.individual_points ?? 0, ownWeight);
  const teamPoints = shareWidth(score?.team_points ?? 0, teamWeight);
  const gained = (score?.individual_points ?? 0) + (score?.team_points ?? 0);
  const shown = score?.score != null ? score.score : gained;
  const ready = state === 'ready' && score != null;

  return (
    <section className="emp-kpi-mix" aria-label={`${label} total out of 100`}>
      <div className="emp-kpi-mix__head">
        <div>
          <h4>From 100 this month</h4>
          <p>
            KPI weightage and team points add up to 100.
            {score?.department_name ? ` ${score.department_name}.` : ''}
          </p>
        </div>
        <div className="emp-kpi-mix__total">
          <span>Gained</span>
          <strong>{ready ? formatPoints(shown) : '—'}</strong>
          <em>of 100</em>
        </div>
      </div>

      {state === 'loading' ? (
        <p className="emp-kpi-mix__note">Loading this month…</p>
      ) : state === 'unavailable' ? (
        <p className="emp-kpi-mix__note">
          The month total is not available yet. Run the latest score update, then refresh.
        </p>
      ) : !ready ? (
        <p className="emp-kpi-mix__note">
          This total appears once the person is in a department for {label}.
        </p>
      ) : (
        <>
          <div
            className="emp-kpi-mix__bar"
            role="img"
            aria-label={`Obtained ${formatPoints(score.individual_points)} of ${formatPoints(ownWeight)} KPI weightage, and gained ${formatPoints(score.team_points)} of ${formatPoints(teamWeight)} team points. Total ${formatPoints(shown)} of 100.`}
          >
            <span className="emp-kpi-mix__own" style={{ width: `${ownPoints}%` }} />
            <span className="emp-kpi-mix__team" style={{ width: `${teamPoints}%` }} />
          </div>
          <ul className="emp-kpi-mix__legend">
            <li><i className="emp-kpi-mix__own" /> Obtained from KPIs</li>
            <li><i className="emp-kpi-mix__team" /> Gained from the team</li>
            <li><i className="emp-kpi-mix__rest" /> Not gained yet</li>
          </ul>
          <dl className="emp-kpi-mix__stats">
            <div>
              <dt>KPI weightage</dt>
              <dd>{formatPoints(ownWeight)}</dd>
              <span>Share of the month’s 100</span>
            </div>
            <div>
              <dt>Obtained</dt>
              <dd>{formatPoints(score.individual_points)}</dd>
              <span>Awarded from this month’s tasks</span>
            </div>
            <div>
              <dt>Team points</dt>
              <dd>{formatPoints(teamWeight)}</dd>
              <span>Share of the month’s 100</span>
            </div>
            <div>
              <dt>Gained</dt>
              <dd>{formatPoints(score.team_points)}</dd>
              <span>Points given to the team</span>
            </div>
          </dl>
        </>
      )}
    </section>
  );
}
