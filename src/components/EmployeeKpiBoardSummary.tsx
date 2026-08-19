import { Kpi } from '../utils/kpiHelpers';
import {
  calculateOverallKpiScore,
  employeeKpiScoreSummary,
  formatKpiScore,
  kpiScoreRows,
  performanceRatingColor,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
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
            Weighted Score = Employee Score × Weight. Overall KPI Score is the sum of weighted scores.
          </p>
        </div>
        <div className="employee-kpi-board-summary__scores">
          <div className="employee-kpi-board-summary__total-pts">
            <span>Overall KPI Score</span>
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
              <th>Employee Score</th>
              <th>Weighted Score</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.kpi.id}>
                <td data-label="KPI"><strong>{row.name}</strong></td>
                <td data-label="Weight">{formatKpiWeight(row.weight)}</td>
                <td data-label="Employee Score">{row.employeeScore}%</td>
                <td data-label="Weighted Score">{formatKpiScore(row.weightedScore)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td>Overall KPI Score</td>
              <td>{formatKpiWeight(summary.totalWeight)}</td>
              <td />
              <td><strong>{formatKpiScore(overall)}%</strong></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
