import { DepartmentKpiIndicator } from '../utils/departmentHelpers';
import { Kpi } from '../utils/kpiHelpers';
import {
  formatKpiWeight,
  KPI_WEIGHT_CAP,
  previewEmployeeAssignment,
} from '../utils/kpiWeightHelpers';

type Props = {
  kpis: Kpi[];
  departmentId: string;
  selected: DepartmentKpiIndicator[];
  employeeName?: string;
  employeeDepartment?: string;
};

export default function AssignmentCapacityPreview({
  kpis,
  departmentId,
  selected,
  employeeName,
  employeeDepartment,
}: Props) {
  const preview = previewEmployeeAssignment(kpis, departmentId, selected, employeeName);
  const usedPct = Math.min(100, Math.max(0, preview.newTotal));
  const over = !preview.ok && selected.length > 0 && preview.newTotal > KPI_WEIGHT_CAP;

  return (
    <div className={`assign-capacity ${over ? 'assign-capacity--over' : ''}`}>
      <p className="assign-capacity__title">Employee KPI Capacity</p>
      {employeeName && (
        <p className="assign-capacity__who">
          {employeeName}
          {employeeDepartment ? ` · ${employeeDepartment}` : ''}
        </p>
      )}
      <dl className="assign-capacity__stats">
        <div>
          <dt>Current assigned</dt>
          <dd>{formatKpiWeight(preview.currentWeight)}</dd>
        </div>
        <div>
          <dt>Selected KPI weight</dt>
          <dd>{formatKpiWeight(preview.selectedWeight)}</dd>
        </div>
        <div>
          <dt>New total</dt>
          <dd>{formatKpiWeight(preview.newTotal)}</dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>{formatKpiWeight(over ? 0 : preview.remainingAfter)}</dd>
        </div>
      </dl>
      <div className="assign-capacity__track" aria-hidden>
        <div
          className={`assign-capacity__fill ${over ? 'assign-capacity__fill--over' : ''}`}
          style={{ width: `${Math.min(100, usedPct)}%` }}
        />
      </div>
      <p className="assign-capacity__hint">
        {over
          ? preview.message
          : `${formatKpiWeight(preview.newTotal)} used · ${formatKpiWeight(preview.remainingAfter)} remaining. Each employee has an independent ${KPI_WEIGHT_CAP}% limit.`}
      </p>
    </div>
  );
}
