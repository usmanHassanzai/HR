import { Kpi } from './kpiHelpers';
import { DepartmentKpiIndicator, sumIndicatorWeights } from './departmentHelpers';

export const KPI_WEIGHT_CAP = 100;
export const KPI_WEIGHT_MIN = 1;
export const KPI_WEIGHT_TOLERANCE = 0.05;

/** Sum pending KPI weights for one employee (must not exceed 100%). */
export function sumEmployeeKpiWeights(kpis: Kpi[]): number {
  return kpis
    .filter((k) => k.completion_status !== 'completed')
    .reduce((s, k) => s + Number(k.weight || 0), 0);
}

export function remainingKpiWeightBudget(kpis: Kpi[]): number {
  return Math.max(0, KPI_WEIGHT_CAP - sumEmployeeKpiWeights(kpis));
}

export function selectedIndicatorsWeightSum(
  indicators: DepartmentKpiIndicator[],
  selectedIds: string[],
): number {
  return sumIndicatorWeights(indicators.filter((i) => selectedIds.includes(i.id)));
}

/** Weight of pending KPIs for one department on an employee board. */
export function sumEmployeeDeptKpiWeights(kpis: Kpi[], departmentId: string): number {
  return kpis
    .filter((k) => k.completion_status !== 'completed' && k.department_id === departmentId)
    .reduce((s, k) => s + Number(k.weight || 0), 0);
}

/**
 * After assign, same-department pending KPIs are replaced; other departments keep their weight.
 * A single KPI of 1–100% (e.g. 10%) is valid as long as the employee total stays ≤ 100%.
 */
export function employeeKpiWeightsOverCap(kpis: Kpi[]): boolean {
  return sumEmployeeKpiWeights(kpis) > KPI_WEIGHT_CAP + KPI_WEIGHT_TOLERANCE;
}

export function employeeKpiWeightsValid(kpis: Kpi[]): boolean {
  return !employeeKpiWeightsOverCap(kpis);
}

export function selectedIndicatorWeightsInRange(indicators: DepartmentKpiIndicator[]): boolean {
  if (indicators.length === 0) return false;
  return indicators.every((i) => {
    const w = Number(i.weight_pct);
    return w >= KPI_WEIGHT_MIN && w <= KPI_WEIGHT_CAP;
  });
}

/** Remaining weight after replacing this department's pending tasks. */
export function remainingWeightAfterDeptReplace(kpis: Kpi[], departmentId: string): number {
  return Math.max(0, KPI_WEIGHT_CAP - (sumEmployeeKpiWeights(kpis) - sumEmployeeDeptKpiWeights(kpis, departmentId)));
}

export function canAssignSelectedKpiWeights(
  kpis: Kpi[],
  departmentId: string,
  selected: DepartmentKpiIndicator[],
): { ok: boolean; message?: string } {
  if (selected.length === 0) return { ok: false, message: 'Select at least one KPI to assign.' };
  if (!selectedIndicatorWeightsInRange(selected)) {
    return { ok: false, message: 'Each selected KPI weight must be between 1% and 100%.' };
  }
  const selectedSum = sumIndicatorWeights(selected);
  if (selectedSum > KPI_WEIGHT_CAP + KPI_WEIGHT_TOLERANCE) {
    return { ok: false, message: `Selected KPI weights cannot exceed ${KPI_WEIGHT_CAP}% (currently ${selectedSum.toFixed(1)}%).` };
  }
  const remaining = remainingWeightAfterDeptReplace(kpis, departmentId);
  if (selectedSum > remaining + KPI_WEIGHT_TOLERANCE) {
    return {
      ok: false,
      message: `This assignment is ${selectedSum.toFixed(1)}% but only ${remaining.toFixed(1)}% weight remains for this employee.`,
    };
  }
  return { ok: true };
}

export function formatKpiWeight(weight: number): string {
  const n = Number(weight);
  if (n <= KPI_WEIGHT_CAP) return `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
  return String(n);
}

export function weightBudgetStatus(total: number): 'ok' | 'warn' | 'over' {
  if (total > KPI_WEIGHT_CAP + KPI_WEIGHT_TOLERANCE) return 'over';
  if (Math.abs(total - KPI_WEIGHT_CAP) <= KPI_WEIGHT_TOLERANCE) return 'ok';
  return 'warn';
}
