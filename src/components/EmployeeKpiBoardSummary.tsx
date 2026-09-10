import { formatKpiAssignmentChange, Kpi } from '../utils/kpiHelpers';
import {
  employeeKpiBoardBreakdown,
  formatKpiScore,
  kpiManagerScorePct,
  kpiScoreRows,
  performanceRatingColor,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import KpiScoreboardSummary from './KpiScoreboardSummary';
import '../styles/departments.css';
import '../styles/employee-kpis.css';

interface EmployeeKpiBoardSummaryProps {
  kpis: Kpi[];
  employeeName?: string;
}

export default function EmployeeKpiBoardSummary({ kpis, employeeName }: EmployeeKpiBoardSummaryProps) {
  if (kpis.length === 0) return null;

  const rows = kpiScoreRows(kpis);
  const summary = employeeKpiBoardBreakdown(kpis);

  return (
    <div className="glass-panel employee-kpi-board-summary">
      <KpiScoreboardSummary
        kpis={kpis}
        compact
        title={employeeName ? `${employeeName}'s KPI scoreboard` : 'KPI scoreboard'}
      />

      <div className="kpi-score-list">
        <div className="kpi-score-list__head">
          <h4>Assigned tasks</h4>
          <span>{rows.length} task{rows.length === 1 ? '' : 's'}</span>
        </div>

        <div className="kpi-score-cards" aria-label="KPI task breakdown">
          {rows.map((row) => {
            const scorePts = kpiManagerScorePct(row.kpi) == null
              ? null
              : formatKpiScore(row.weightedScore);
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
                    <span>Score</span>
                    <strong>{scorePts ?? '—'}</strong>
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
            <span>Overall score</span>
            <strong style={{ color: performanceRatingColor(summary.performanceRating) }}>
              {formatKpiScore(summary.score)} · {summary.performanceRating}
            </strong>
          </div>
        </div>

        {/* Desktop table fallback for wide screens */}
        <div className="kpi-score-table-wrap kpi-score-table-wrap--desktop">
          <table className="kpi-score-table">
            <thead>
              <tr>
                <th>KPI</th>
                <th>Weightage</th>
                <th>Score</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.kpi.id}>
                  <td>
                    <strong>{row.name}</strong>
                    <span className="kpi-score-table__cat">{kpiCategoryMeta(row.kpi.kpi_category).label}</span>
                    {formatKpiAssignmentChange(row.kpi) && (
                      <p className="kpi-assignment-edit-note">{formatKpiAssignmentChange(row.kpi)}</p>
                    )}
                  </td>
                  <td>{formatKpiWeight(row.weight)}</td>
                  <td>
                    {kpiManagerScorePct(row.kpi) == null ? '—' : formatKpiScore(row.weightedScore)}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td>Total</td>
                <td>{formatKpiWeight(Math.min(KPI_WEIGHT_CAP, summary.weightAssigned))}</td>
                <td>
                  <strong style={{ color: performanceRatingColor(summary.performanceRating) }}>
                    Score {formatKpiScore(summary.score)} · {summary.performanceRating}
                  </strong>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>
    </div>
  );
}
