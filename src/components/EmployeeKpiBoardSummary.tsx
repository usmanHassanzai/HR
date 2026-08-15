import { Kpi } from '../utils/kpiHelpers';
import {
  employeeWeightedKpiScore,
  kpiAchievedPct,
  kpiScoreContribution,
  statusTrafficLight,
  trafficLightLabel,
} from '../utils/kpiScoreHelpers';
import { employeeKpiWeightsValid, formatKpiWeight, sumEmployeeKpiWeights } from '../utils/kpiWeightHelpers';

interface EmployeeKpiBoardSummaryProps {
  kpis: Kpi[];
  employeeName?: string;
}

export default function EmployeeKpiBoardSummary({ kpis, employeeName }: EmployeeKpiBoardSummaryProps) {
  if (kpis.length === 0) return null;

  const completed = kpis.filter((k) => k.completion_status === 'completed');
  const pending = kpis.filter((k) => k.completion_status !== 'completed');
  const totalWeight = sumEmployeeKpiWeights(kpis);
  const valid = employeeKpiWeightsValid(kpis);
  const totalPoints = Math.round(kpis.reduce((s, k) => s + kpiScoreContribution(k), 0) * 100) / 100;
  const weightedScore = employeeWeightedKpiScore(kpis);
  const rows = [...completed, ...pending];

  return (
    <div className="glass-panel employee-kpi-board-summary">
      <div className="employee-kpi-board-summary__head">
        <div>
          <span className="dash-eyebrow">
            {employeeName ? `${employeeName}'s KPI board` : 'Your monthly KPI board'}
          </span>
          <p className="employee-kpi-board-summary__desc" style={{ margin: '0.35rem 0 0' }}>
            Points from each KPI = % achieved × weight. Completed tasks count at 100%.
          </p>
        </div>
        <div className="employee-kpi-board-summary__scores">
          <div className="employee-kpi-board-summary__total-pts">
            <span>Total points</span>
            <strong>{totalPoints}</strong>
          </div>
          <strong className={valid ? 'employee-kpi-board-summary__total--ok' : 'employee-kpi-board-summary__total--warn'}>
            {formatKpiWeight(totalWeight)} weight
          </strong>
          <span className="employee-kpi-board-summary__weighted">Score: {weightedScore}/100</span>
        </div>
      </div>

      <div className="employee-kpi-board-summary__meta">
        <span>{completed.length} completed</span>
        <span>{pending.length} remaining</span>
      </div>

      <div className="employee-kpi-board-summary__bars">
        {rows.map((k) => {
          const done = k.completion_status === 'completed';
          const light = statusTrafficLight(done ? 'completed' : k.status);
          const achieved = kpiAchievedPct(k);
          const contribution = kpiScoreContribution(k);
          return (
            <div key={k.id} className={`employee-kpi-board-summary__row employee-kpi-board-summary__row--${light}`}>
              <div className="employee-kpi-board-summary__metric-head">
                <span className={`kpi-traffic kpi-traffic--${light}`}>{trafficLightLabel(light)}</span>
                <span className="employee-kpi-board-summary__name">
                  {k.name}
                  {done ? ' · Done' : ''}
                </span>
              </div>
              <div className="employee-kpi-board-summary__bar-wrap">
                <div
                  className={`employee-kpi-board-summary__bar employee-kpi-board-summary__bar--${light}`}
                  style={{ width: `${Math.min(100, achieved)}%` }}
                />
              </div>
              <div className="employee-kpi-board-summary__stats">
                <span>{formatKpiWeight(k.weight)} wt</span>
                <span>{achieved}% achieved</span>
                <span><strong>{contribution} pts</strong></span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
