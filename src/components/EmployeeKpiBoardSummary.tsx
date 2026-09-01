import { formatKpiAssignmentChange, Kpi } from '../utils/kpiHelpers';
import {
  calculateOverallKpiScore,
  employeeKpiScoreSummary,
  formatKpiScore,
  kpiManagerScorePct,
  kpiScoreRows,
  performanceRatingColor,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import '../styles/departments.css';

interface EmployeeKpiBoardSummaryProps {
  kpis: Kpi[];
  employeeName?: string;
}

export default function EmployeeKpiBoardSummary({ kpis, employeeName }: EmployeeKpiBoardSummaryProps) {
  if (kpis.length === 0) return null;

  const rows = kpiScoreRows(kpis);
  const overall = calculateOverallKpiScore(kpis);
  const summary = employeeKpiScoreSummary(kpis);

  return (
    <div className="glass-panel employee-kpi-board-summary">
      <div className="employee-kpi-board-summary__head">
        <div>
          <span className="dash-eyebrow">
            {employeeName ? `${employeeName}'s KPI score` : 'KPI score report'}
          </span>
          <p className="employee-kpi-board-summary__desc" style={{ margin: '0.35rem 0 0' }}>
            This month&apos;s KPI Score is Scores awarded ÷ Weights assigned × 100. Completing on time awards the assigned Score. Completing after the due date awards half. Open tasks award 0.
          </p>
        </div>
        <div className="employee-kpi-board-summary__scores">
          <div className="employee-kpi-board-summary__total-pts">
            <span>This Month&apos;s KPI Score</span>
            <strong>{formatKpiScore(overall)}%</strong>
          </div>
          <strong
            className="employee-kpi-board-summary__total--ok"
            style={{ color: performanceRatingColor(summary.performanceRating) }}
          >
            {summary.performanceRating}
          </strong>
        </div>
      </div>

      <div className="kpi-score-table-wrap">
        <table className="kpi-score-table">
          <thead>
            <tr>
              <th>KPI</th>
              <th>Weight</th>
              <th>Performance Points</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.kpi.id}>
                <td data-label="KPI">
                  <strong>{row.name}</strong>
                  <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                    {kpiCategoryMeta(row.kpi.kpi_category).label}
                  </span>
                  {formatKpiAssignmentChange(row.kpi) && (
                    <p className="kpi-assignment-edit-note">{formatKpiAssignmentChange(row.kpi)}</p>
                  )}
                </td>
                <td data-label="Weight">{formatKpiWeight(row.weight)}</td>
                <td data-label="Performance Points">{kpiManagerScorePct(row.kpi) == null ? '—' : formatKpiScore(row.weightedScore)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>This Month&apos;s KPI Score</td>
              <td>{formatKpiWeight(summary.totalWeight)}</td>
              <td><strong>{formatKpiScore(overall)}%</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
