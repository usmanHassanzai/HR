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

      <div className="kpi-score-table-wrap" style={{ marginTop: '1rem' }}>
        <table className="kpi-score-table">
          <thead>
            <tr>
              <th>KPI</th>
              <th>Weightage</th>
              <th>Score pts</th>
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
                <td data-label="Weightage">{formatKpiWeight(row.weight)}</td>
                <td data-label="Score pts">
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
  );
}
