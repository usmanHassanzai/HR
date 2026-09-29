import { Fragment, type ReactNode } from 'react';
import { formatKpiAssignmentChange, type Kpi } from '../utils/kpiHelpers';
import {
  employeeKpiBoardBreakdown,
  kpiScoreRows,
  type CompletedKpiMonthGroup,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import '../styles/departments.css';
import '../styles/employee-kpis.css';

function CompletedKpiScoreTable({ kpis }: { kpis: Kpi[] }) {
  const rows = kpiScoreRows(kpis);
  const summary = employeeKpiBoardBreakdown(kpis);

  return (
    <div className="kpi-score-list emp-kpi-history__scoreboard">
      <div className="kpi-score-list__head">
        <h4>Month scoreboard</h4>
        <span>{rows.length} completed</span>
      </div>

      <div className="kpi-score-cards" aria-label="Completed KPI breakdown">
        {rows.map((row) => {
          const editNote = formatKpiAssignmentChange(row.kpi);
          return (
            <article key={row.kpi.id} className="kpi-score-card">
              <div className="kpi-score-card__main">
                <strong className="kpi-score-card__name">{row.name}</strong>
                <span className="kpi-score-card__cat">{kpiCategoryMeta(row.kpi.kpi_category).label}</span>
                {editNote ? <p className="kpi-assignment-edit-note">{editNote}</p> : null}
              </div>
              <div className="kpi-score-card__metrics">
                <div>
                  <span>Weightage</span>
                  <strong>{formatKpiWeight(row.weight)}</strong>
                </div>
                <div>
                  <span>Achieved</span>
                  <strong>{formatKpiWeight(Number(row.kpi.assigned_score ?? row.weight))}</strong>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="kpi-score-list__total">
        <div>
          <span>Total weightage</span>
          <strong>{formatKpiWeight(Math.min(KPI_WEIGHT_CAP, summary.weightAssigned))}</strong>
        </div>
        <div>
          <span>Achieved weightage</span>
          <strong>{formatKpiWeight(summary.weightAchieved)}</strong>
        </div>
      </div>

      <div className="kpi-score-table-wrap kpi-score-table-wrap--desktop">
        <table className="kpi-score-table">
          <thead>
            <tr>
              <th>KPI</th>
              <th>Weightage</th>
              <th>Achieved</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.kpi.id}>
                <td>
                  <strong>{row.name}</strong>
                  <span className="kpi-score-table__cat">{kpiCategoryMeta(row.kpi.kpi_category).label}</span>
                  {formatKpiAssignmentChange(row.kpi) ? (
                    <p className="kpi-assignment-edit-note">{formatKpiAssignmentChange(row.kpi)}</p>
                  ) : null}
                </td>
                <td>{formatKpiWeight(row.weight)}</td>
                <td>{formatKpiWeight(Number(row.kpi.assigned_score ?? row.weight))}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td>{formatKpiWeight(Math.min(KPI_WEIGHT_CAP, summary.weightAssigned))}</td>
              <td>
                <strong>{formatKpiWeight(summary.weightAchieved)}</strong>
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

interface AssignedTaskHistoryProps {
  groups: CompletedKpiMonthGroup[];
  renderTask: (kpi: Kpi) => ReactNode;
}

/** Monthly completed/approved assigned KPIs with scoreboard + detail cards. */
export default function AssignedTaskHistory({ groups, renderTask }: AssignedTaskHistoryProps) {
  return (
    <div className="emp-kpi-history">
      {groups.map((group) => (
        <section key={group.key} className="emp-kpi-history__month" aria-label={group.label}>
          <header className="emp-kpi-history__month-head">
            <div>
              <p className="emp-kpi-history__eyebrow">Approved history</p>
              <h4>{group.label}</h4>
            </div>
            <span className="emp-kpi-history__count">
              {group.kpis.length} task{group.kpis.length === 1 ? '' : 's'}
            </span>
          </header>
          <CompletedKpiScoreTable kpis={group.kpis} />
          <div className="emp-kpi-history__cards">
            {group.kpis.map((kpi) => (
              <Fragment key={kpi.id}>{renderTask(kpi)}</Fragment>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
