import { useMemo } from 'react';
import type { Kpi } from '../utils/kpiHelpers';
import { karachiYearMonth } from '../utils/kpiCategories';
import {
  completedKpisForPeriod,
  kpiCompletionTimestamp,
  kpisForPeriod,
  monthLabel,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import {
  displayedAwardedWeightage,
  isMonthAwardedWeightageVisible,
} from '../utils/weightageReveal';
import { CheckCircle2, ListTodo } from 'lucide-react';
import '../styles/employee-kpis.css';

interface CurrentMonthCompletedTasksProps {
  kpis: Kpi[];
}

function mergeById(lists: Kpi[][]): Kpi[] {
  const byId = new Map<string, Kpi>();
  for (const list of lists) {
    for (const k of list) byId.set(k.id, k);
  }
  return Array.from(byId.values());
}

/**
 * Always-visible list of the logged-in user's current Asia/Karachi month tasks:
 * open = date-span overlap with this month; completed = completed this calendar month
 * only (same rule as Active → History). Awarded weightage after month-end unlock.
 */
export default function CurrentMonthCompletedTasks({ kpis }: CurrentMonthCompletedTasksProps) {
  const { year, monthIndex } = useMemo(() => karachiYearMonth(), []);
  const label = monthLabel(year, monthIndex);
  const showAwarded = isMonthAwardedWeightageVisible(year, monthIndex);

  const { open, completed, totalWeight } = useMemo(() => {
    const board = kpisForPeriod(kpis, 'month', year, monthIndex);
    const openList = board
      .filter((k) => k.completion_status !== 'completed')
      .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));

    // Strict completion calendar month — do not pull in prior-month approvals
    // that still overlap this month via start/end dates.
    const completedList = completedKpisForPeriod(kpis, 'month', year, monthIndex).sort(
      (a, b) => {
        const aKey = kpiCompletionTimestamp(a) || '';
        const bKey = kpiCompletionTimestamp(b) || '';
        return bKey.localeCompare(aKey);
      },
    );

    const all = mergeById([openList, completedList]);
    const weight = all.reduce((sum, k) => sum + (Number(k.weight) || 0), 0);
    return { open: openList, completed: completedList, totalWeight: weight };
  }, [kpis, year, monthIndex]);

  const totalCount = open.length + completed.length;

  return (
    <section
      className="emp-month-completed glass-panel"
      aria-label={`Current month tasks · ${label}`}
    >
      <header className="emp-month-completed__head">
        <div className="emp-month-completed__title-row">
          <span className="emp-month-completed__icon" aria-hidden="true">
            <ListTodo size={18} strokeWidth={2.25} />
          </span>
          <div>
            <p className="emp-month-completed__eyebrow">This calendar month</p>
            <h3 className="emp-month-completed__title">Current month tasks</h3>
            <p className="emp-month-completed__sub">
              {label} — open tasks overlapping this month, plus tasks completed this calendar month
              {showAwarded
                ? ', with total and awarded weightage.'
                : ', with each task’s total weightage. Awarded amounts post on the last day of the month.'}
            </p>
          </div>
        </div>
        <div className="emp-month-completed__stats">
          <span>
            <strong>{totalCount}</strong> task{totalCount === 1 ? '' : 's'}
          </span>
          {totalCount > 0 ? (
            <span>
              Total <strong>{formatKpiWeight(totalWeight)}</strong>
            </span>
          ) : null}
        </div>
      </header>

      {totalCount === 0 ? (
        <p className="emp-month-completed__empty">
          No tasks assigned for {label} yet. When a task is assigned (or completed this month),
          it appears here with its total weightage.
        </p>
      ) : (
        <div className="emp-month-completed__sections">
          <div className="emp-month-completed__section">
            <h4 className="emp-month-completed__section-title">
              Assigned / open
              <span>{open.length}</span>
            </h4>
            {open.length === 0 ? (
              <p className="emp-month-completed__empty emp-month-completed__empty--nested">
                No open assigned tasks for {label}.
              </p>
            ) : (
              <ul className="emp-month-completed__list">
                {open.map((kpi) => (
                  <li key={kpi.id} className="emp-month-completed__row">
                    <span className="emp-month-completed__name">{kpi.name}</span>
                    <span className="emp-month-completed__weight" title="Task total weightage">
                      {formatKpiWeight(kpi.weight)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="emp-month-completed__section">
            <h4 className="emp-month-completed__section-title">
              <CheckCircle2 size={14} strokeWidth={2.25} aria-hidden="true" />
              Completed
              <span>{completed.length}</span>
            </h4>
            {completed.length === 0 ? (
              <p className="emp-month-completed__empty emp-month-completed__empty--nested">
                No approved tasks completed in {label} yet.
              </p>
            ) : (
              <ul className="emp-month-completed__list">
                {completed.map((kpi) => {
                  const awarded = showAwarded
                    ? displayedAwardedWeightage(kpi, { deferUntilMonthEnd: false })
                    : null;
                  return (
                    <li key={kpi.id} className="emp-month-completed__row emp-month-completed__row--done">
                      <span className="emp-month-completed__name">{kpi.name}</span>
                      <span className="emp-month-completed__weight" title="Task total weightage">
                        {formatKpiWeight(kpi.weight)}
                        {awarded != null ? (
                          <em className="emp-month-completed__awarded" title="Awarded weightage">
                            {' '}· awarded {formatKpiWeight(awarded)}
                          </em>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
