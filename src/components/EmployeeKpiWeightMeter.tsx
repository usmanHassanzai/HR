import { formatKpiWeight, KPI_WEIGHT_CAP, sumEmployeeKpiWeights, weightBudgetStatus } from '../utils/kpiWeightHelpers';
import { Kpi } from '../utils/kpiHelpers';

interface EmployeeKpiWeightMeterProps {
  kpis: Kpi[];
  label?: string;
  compact?: boolean;
}

export default function EmployeeKpiWeightMeter({ kpis, label = 'KPI weight budget', compact }: EmployeeKpiWeightMeterProps) {
  const total = sumEmployeeKpiWeights(kpis);
  const status = weightBudgetStatus(total);
  const pct = Math.min(100, Math.max(0, total));

  return (
    <div className={`mgr-kpi-weight-meter ${compact ? 'mgr-kpi-weight-meter--compact' : ''}`}>
      <div className="mgr-kpi-weight-meter__head">
        <span className="mgr-kpi-weight-meter__label">{label}</span>
        <strong className={`mgr-kpi-weight-meter__value mgr-kpi-weight-meter__value--${status}`}>
          {formatKpiWeight(total)} / {KPI_WEIGHT_CAP}%
        </strong>
      </div>
      <div className="mgr-kpi-weight-meter__track" aria-hidden>
        <div
          className={`mgr-kpi-weight-meter__fill mgr-kpi-weight-meter__fill--${status}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {status === 'over' && (
        <p className="mgr-kpi-weight-meter__hint mgr-kpi-weight-meter__hint--error">
          Total exceeds 100%. Remove tasks or reassign — weights are capped at 100%.
        </p>
      )}
      {status === 'warn' && total > 0 && (
        <p className="mgr-kpi-weight-meter__hint">
          {formatKpiWeight(KPI_WEIGHT_CAP - total)} remaining. You can assign any department KPI from 1% to 100% within this budget.
        </p>
      )}
      {status === 'ok' && total > 0 && (
        <p className="mgr-kpi-weight-meter__hint mgr-kpi-weight-meter__hint--ok">
          Weight budget is full (100%). Complete or remove a task before assigning more.
        </p>
      )}
    </div>
  );
}
