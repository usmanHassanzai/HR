import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  formatKpiAssignmentChange,
  type Kpi,
} from '../utils/kpiHelpers';
import {
  availableKpiYears,
  employeeKpiBoardBreakdown,
  groupCompletedKpisByMonth,
  historyKpisForPeriod,
  kpiScoreRows,
  MONTH_OPTIONS,
  nestCompletedMonthGroupsByYear,
  periodLabel,
  type CompletedKpiMonthGroup,
  type KpiPeriodMode,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import { kpiCategoryMeta, karachiYearMonth } from '../utils/kpiCategories';
import {
  displayedAwardedWeightage,
  isMonthAwardedWeightageVisible,
} from '../utils/weightageReveal';
import '../styles/departments.css';
import '../styles/employee-kpis.css';

/** Same scoreboard on mobile and desktop — table scrolls horizontally on narrow screens. */
function CompletedKpiScoreTable({
  kpis,
  year,
  monthIndex,
  deferAwardedUntilMonthEnd,
}: {
  kpis: Kpi[];
  year: number;
  monthIndex: number;
  deferAwardedUntilMonthEnd: boolean;
}) {
  const rows = kpiScoreRows(kpis);
  const showAwarded =
    !deferAwardedUntilMonthEnd || isMonthAwardedWeightageVisible(year, monthIndex);
  const summary = employeeKpiBoardBreakdown(kpis, {
    deferAchievedUntilMonthEnd: deferAwardedUntilMonthEnd && !showAwarded,
  });

  return (
    <div className="kpi-score-list emp-kpi-history__scoreboard">
      <div className="kpi-score-list__head">
        <h4>Month scoreboard</h4>
        <span>{rows.length} completed</span>
      </div>

      <div className="kpi-score-list__total kpi-score-list__total--always">
        <div>
          <span>Total weightage</span>
          <strong>{formatKpiWeight(Math.min(KPI_WEIGHT_CAP, summary.weightAssigned))}</strong>
        </div>
        {showAwarded ? (
          <div>
            <span>Awarded</span>
            <strong>{formatKpiWeight(Math.min(KPI_WEIGHT_CAP, summary.weightAchieved))}</strong>
          </div>
        ) : null}
      </div>

      <div className="kpi-score-table-wrap kpi-score-table-wrap--responsive">
        <table className="kpi-score-table">
          <thead>
            <tr>
              <th>KPI</th>
              <th>Weightage</th>
              {showAwarded ? <th>Awarded</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const editNote = formatKpiAssignmentChange(row.kpi);
              const awarded = showAwarded
                ? displayedAwardedWeightage(row.kpi, { deferUntilMonthEnd: false })
                : null;
              return (
                <tr key={row.kpi.id}>
                  <td>
                    <strong>{row.name}</strong>
                    <span className="kpi-score-table__cat">{kpiCategoryMeta(row.kpi.kpi_category).label}</span>
                    {editNote ? <p className="kpi-assignment-edit-note">{editNote}</p> : null}
                  </td>
                  <td>{formatKpiWeight(row.weight)}</td>
                  {showAwarded ? (
                    <td>{awarded != null ? formatKpiWeight(awarded) : '—'}</td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{formatKpiWeight(Math.min(KPI_WEIGHT_CAP, summary.weightAssigned))}</td>
              {showAwarded ? (
                <td>{formatKpiWeight(Math.min(KPI_WEIGHT_CAP, summary.weightAchieved))}</td>
              ) : null}
            </tr>
          </tfoot>
        </table>
      </div>
      {!showAwarded ? (
        <p className="emp-kpi-history__reveal-hint" role="status">
          Awarded weightage posts on the last day of the month.
        </p>
      ) : null}
    </div>
  );
}

function MonthHistorySection({
  group,
  renderTask,
  deferAwardedUntilMonthEnd,
}: {
  group: CompletedKpiMonthGroup;
  renderTask: (kpi: Kpi) => ReactNode;
  deferAwardedUntilMonthEnd: boolean;
}) {
  return (
    <section className="emp-kpi-history__month" aria-label={group.label}>
      <header className="emp-kpi-history__month-head">
        <div>
          <p className="emp-kpi-history__eyebrow">Approved history</p>
          <h4>{group.label}</h4>
        </div>
        <span className="emp-kpi-history__count">
          {group.kpis.length} task{group.kpis.length === 1 ? '' : 's'}
        </span>
      </header>

      <CompletedKpiScoreTable
        kpis={group.kpis}
        year={group.year}
        monthIndex={group.monthIndex}
        deferAwardedUntilMonthEnd={deferAwardedUntilMonthEnd}
      />

      <div className="emp-kpi-history__cards">
        <header className="emp-kpi-history__cards-head">
          <h5>Task details</h5>
        </header>
        {group.kpis.map((kpi) => (
          <Fragment key={kpi.id}>{renderTask(kpi)}</Fragment>
        ))}
      </div>
    </section>
  );
}

interface AssignedTaskHistoryProps {
  groups?: CompletedKpiMonthGroup[];
  /**
   * All completed KPIs for this board. When set with periodBrowse, the component
   * filters by Overall / Month / Year before grouping.
   */
  completedKpis?: Kpi[];
  /**
   * Assigner boards (Admin / HR / Manager): browse completed work by month and year.
   * Employee/manager self-views keep parent-level period filters and pass `groups`.
   */
  periodBrowse?: boolean;
  renderTask: (kpi: Kpi) => ReactNode;
  /** Employee/manager self view: hide awarded until month-end unlock. Default true. */
  deferAwardedUntilMonthEnd?: boolean;
}

/** Monthly completed/approved assigned KPIs — same scoreboard + detail cards on every device. */
export default function AssignedTaskHistory({
  groups: groupsProp,
  completedKpis,
  periodBrowse = false,
  renderTask,
  deferAwardedUntilMonthEnd = true,
}: AssignedTaskHistoryProps) {
  const initialYm = useMemo(() => karachiYearMonth(), []);
  const [periodMode, setPeriodMode] = useState<KpiPeriodMode>('overall');
  const [filterYear, setFilterYear] = useState(initialYm.year);
  const [filterMonth, setFilterMonth] = useState(initialYm.monthIndex);

  const sourceKpis = completedKpis ?? groupsProp?.flatMap((g) => g.kpis) ?? [];
  const years = useMemo(() => availableKpiYears(sourceKpis), [sourceKpis]);

  useEffect(() => {
    if (!years.length) return;
    if (!years.includes(filterYear)) setFilterYear(years[0]);
  }, [years, filterYear]);

  const groups = useMemo(() => {
    if (periodBrowse && completedKpis) {
      const filtered = historyKpisForPeriod(completedKpis, periodMode, filterYear, filterMonth);
      return groupCompletedKpisByMonth(filtered);
    }
    return groupsProp ?? [];
  }, [periodBrowse, completedKpis, periodMode, filterYear, filterMonth, groupsProp]);

  const yearGroups = useMemo(() => nestCompletedMonthGroupsByYear(groups), [groups]);
  const nestYears =
    periodBrowse
      ? periodMode !== 'month' && yearGroups.length > 0
      : yearGroups.length > 1;
  const selectedLabel = periodLabel(periodMode, filterYear, filterMonth);
  const visibleTaskCount = groups.reduce((n, g) => n + g.kpis.length, 0);

  return (
    <div className="emp-kpi-history">
      {periodBrowse ? (
        <div className="emp-kpi-filter emp-kpi-history__period" role="search" aria-label="Filter completed tasks by period">
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

          {periodMode !== 'overall' ? (
            <div className="emp-kpi-filter__selects">
              {periodMode === 'month' ? (
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
              ) : null}
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
          ) : null}

          <p className="emp-kpi-history__period-hint" role="status">
            {groups.length === 0
              ? `No completed tasks for ${selectedLabel}.`
              : periodMode === 'overall'
                ? `Showing all completed months · ${sourceKpis.length} task${sourceKpis.length === 1 ? '' : 's'}.`
                : `Showing ${selectedLabel} · ${visibleTaskCount} task${visibleTaskCount === 1 ? '' : 's'}.`}
          </p>
        </div>
      ) : null}

      {groups.length === 0 ? null : nestYears ? (
        yearGroups.map((yearGroup) => (
          <section key={yearGroup.key} className="emp-kpi-history__year" aria-label={`Completed ${yearGroup.label}`}>
            <header className="emp-kpi-history__year-head">
              <div>
                <p className="emp-kpi-history__eyebrow">Year</p>
                <h3>{yearGroup.label}</h3>
              </div>
              <span className="emp-kpi-history__count">
                {yearGroup.taskCount} task{yearGroup.taskCount === 1 ? '' : 's'} · {yearGroup.months.length} month{yearGroup.months.length === 1 ? '' : 's'}
              </span>
            </header>
            <div className="emp-kpi-history__year-months">
              {yearGroup.months.map((group) => (
                <MonthHistorySection
                  key={group.key}
                  group={group}
                  renderTask={renderTask}
                  deferAwardedUntilMonthEnd={deferAwardedUntilMonthEnd}
                />
              ))}
            </div>
          </section>
        ))
      ) : (
        groups.map((group) => (
          <MonthHistorySection
            key={group.key}
            group={group}
            renderTask={renderTask}
            deferAwardedUntilMonthEnd={deferAwardedUntilMonthEnd}
          />
        ))
      )}
    </div>
  );
}
