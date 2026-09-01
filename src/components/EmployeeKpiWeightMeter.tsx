import { formatKpiWeight, KPI_WEIGHT_CAP, sumEmployeeKpiWeights, weightBudgetStatus } from '../utils/kpiWeightHelpers';
import { Kpi } from '../utils/kpiHelpers';

interface EmployeeKpiWeightMeterProps {
  kpis: Kpi[];
  label?: string;
  compact?: boolean;
  pendingWeight?: number;
}

export default function EmployeeKpiWeightMeter({
  kpis,
  label = 'Weight in use',
  compact,
  pendingWeight = 0,
}: EmployeeKpiWeightMeterProps) {
  const assigned = sumEmployeeKpiWeights(kpis);
  const pending = Math.max(0, Number(pendingWeight) || 0);
  const total = assigned + pending;
  const status = weightBudgetStatus(total);
  const pct = Math.min(100, Math.max(0, total));
  const free = Math.max(0, KPI_WEIGHT_CAP - total);

  return (
    <div className={`mgr-kpi-weight-meter ${compact ? 'mgr-kpi-weight-meter--compact' : ''}`}>
      <div className="mgr-kpi-weight-meter__head">
        <span className="mgr-kpi-weight-meter__label">{label}</span>
        <strong className={`mgr-kpi-weight-meter__value mgr-kpi-weight-meter__value--${status}`}>
          {formatKpiWeight(assigned)}
          {pending > 0 ? ` + ${formatKpiWeight(pending)}` : ''}
          <span> of {KPI_WEIGHT_CAP}%</span>
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
          This would go over 100%. Uncheck a KPI or remove an existing task first.
        </p>
      )}
      {status === 'ok' && (
        <p className="mgr-kpi-weight-meter__hint mgr-kpi-weight-meter__hint--ok">
          Weight is full. Complete or remove a task before assigning more.
        </p>
      )}
      {status === 'warn' && (
        <p className="mgr-kpi-weight-meter__hint">{formatKpiWeight(free)} still available.</p>
      )}
      {status === 'idle' && pending === 0 && (
        <p className="mgr-kpi-weight-meter__hint">No open KPI weight on this person yet.</p>
      )}
    </div>
  );
}
