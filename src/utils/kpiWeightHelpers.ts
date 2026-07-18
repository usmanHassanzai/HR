import { Kpi } from './kpiHelpers';
import { DepartmentKpiIndicator, sumIndicatorWeights } from './departmentHelpers';

export const KPI_WEIGHT_CAP = 100;
export const KPI_WEIGHT_TOLERANCE = 0.05;

/** Sum pending KPI weights for one employee (must total 100%). */
export function sumEmployeeKpiWeights(kpis: Kpi[]): number {
  return kpis
    .filter((k) => k.completion_status !== 'completed')
    .reduce((s, k) => s + Number(k.weight || 0), 0);
}

export function employeeKpiWeightsValid(kpis: Kpi[]): boolean {
  const pending = kpis.filter((k) => k.completion_status !== 'completed');
  if (pending.length === 0) return true;
  return Math.abs(sumEmployeeKpiWeights(kpis) - KPI_WEIGHT_CAP) <= KPI_WEIGHT_TOLERANCE;
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
 * After assign, server replaces same-dept pending KPIs then rebalances all pending to 100%.
 * Returns whether the employee board is already over cap (data fix needed).
 */
export function employeeKpiWeightsOverCap(kpis: Kpi[]): boolean {
  return sumEmployeeKpiWeights(kpis) > KPI_WEIGHT_CAP + KPI_WEIGHT_TOLERANCE;
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
