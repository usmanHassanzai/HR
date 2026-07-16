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
  const pending = kpis.filter((k) => k.completion_status !== 'completed');
  const total = sumEmployeeKpiWeights(kpis);
  const valid = employeeKpiWeightsValid(kpis);
  const weightedScore = employeeWeightedKpiScore(kpis);

  if (pending.length === 0) return null;

  return (
    <div className="glass-panel employee-kpi-board-summary">
      <div className="employee-kpi-board-summary__head">
        <span className="dash-eyebrow">
          {employeeName ? `${employeeName}'s KPI board` : 'Your monthly KPI board'}
        </span>
        <div className="employee-kpi-board-summary__scores">
          <strong className={valid ? 'employee-kpi-board-summary__total--ok' : 'employee-kpi-board-summary__total--warn'}>
            {formatKpiWeight(total)} weight
          </strong>
          <span className="employee-kpi-board-summary__weighted">Score: {weightedScore}/100</span>
        </div>
      </div>
      <p className="employee-kpi-board-summary__desc">
        Score = (target achieved %) × KPI weight. Status: green / yellow / red.
      </p>
      <div className="employee-kpi-board-summary__bars">
        {pending.map((k) => {
          const light = statusTrafficLight(k.completion_status === 'completed' ? 'completed' : k.status);
          const achieved = kpiAchievedPct(k);
          const contribution = kpiScoreContribution(k);
          return (
            <div key={k.id} className={`employee-kpi-board-summary__row employee-kpi-board-summary__row--${light}`}>
              <div className="employee-kpi-board-summary__metric-head">
                <span className={`kpi-traffic kpi-traffic--${light}`}>{trafficLightLabel(light)}</span>
                <span className="employee-kpi-board-summary__name">{k.name}</span>
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
                <span>{contribution} pts</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
