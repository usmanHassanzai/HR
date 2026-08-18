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

export function keptPendingWeightAfterDeptReplace(kpis: Kpi[], departmentId: string): number {
  return Math.max(0, sumEmployeeKpiWeights(kpis) - sumEmployeeDeptKpiWeights(kpis, departmentId));
}

export type EmployeeAssignmentPreview = {
  ok: boolean;
  currentWeight: number;
  keptWeight: number;
  selectedWeight: number;
  newTotal: number;
  remainingBefore: number;
  remainingAfter: number;
  message?: string;
  successMessage: string;
};

/**
 * Per-employee capacity only. Other employees are never included in these totals.
 * Same-department pending assignments are replaced; other pending assignments are kept.
 */
export function previewEmployeeAssignment(
  kpis: Kpi[],
  departmentId: string,
  selected: DepartmentKpiIndicator[],
  employeeName = 'This employee',
): EmployeeAssignmentPreview {
  const currentWeight = sumEmployeeKpiWeights(kpis);
  const keptWeight = keptPendingWeightAfterDeptReplace(kpis, departmentId);
  const selectedWeight = sumIndicatorWeights(selected);
  const newTotal = keptWeight + selectedWeight;
  const remainingBefore = Math.max(0, KPI_WEIGHT_CAP - keptWeight);
  const remainingAfter = Math.max(0, KPI_WEIGHT_CAP - newTotal);
  const fmt = (n: number) => formatKpiWeight(n);
  const successMessage =
    Math.abs(newTotal - KPI_WEIGHT_CAP) <= KPI_WEIGHT_TOLERANCE
      ? `KPI successfully assigned.\n\nEmployee KPI Weight: ${fmt(newTotal)}\nRemaining Capacity: ${fmt(0)}`
      : `KPI successfully assigned to ${employeeName}.\n\nAssigned Weight: ${fmt(selectedWeight)}\nEmployee Total: ${fmt(newTotal)}\nRemaining Capacity: ${fmt(remainingAfter)}`;

  if (selected.length === 0) {
    return {
      ok: false,
      currentWeight,
      keptWeight,
      selectedWeight,
      newTotal: keptWeight,
      remainingBefore,
      remainingAfter: remainingBefore,
      message: 'Select at least one KPI to assign.',
      successMessage,
    };
  }
  if (!selectedIndicatorWeightsInRange(selected)) {
    return {
      ok: false,
      currentWeight,
      keptWeight,
      selectedWeight,
      newTotal,
      remainingBefore,
      remainingAfter,
      message: 'Each selected KPI weight must be between 1% and 100%. Assigned weight stays the KPI template weight.',
      successMessage,
    };
  }
  if (selectedWeight > KPI_WEIGHT_CAP + KPI_WEIGHT_TOLERANCE) {
    return {
      ok: false,
      currentWeight,
      keptWeight,
      selectedWeight,
      newTotal,
      remainingBefore,
      remainingAfter,
      message: `Selected KPI weights cannot exceed ${KPI_WEIGHT_CAP}% (currently ${fmt(selectedWeight)}).`,
      successMessage,
    };
  }
  if (newTotal > KPI_WEIGHT_CAP + KPI_WEIGHT_TOLERANCE) {
    return {
      ok: false,
      currentWeight,
      keptWeight,
      selectedWeight,
      newTotal,
      remainingBefore,
      remainingAfter,
      message:
        `KPI cannot be assigned.\n\n${employeeName} currently has ${fmt(keptWeight)} assigned KPI weight.\nThis KPI is worth ${fmt(selectedWeight)}.\n\nNew total would be ${fmt(newTotal)}.\nMaximum allowed for one employee is ${KPI_WEIGHT_CAP}%.\nRemaining Capacity: ${fmt(remainingBefore)}`,
      successMessage,
    };
  }
  return {
    ok: true,
    currentWeight,
    keptWeight,
    selectedWeight,
    newTotal,
    remainingBefore,
    remainingAfter,
    successMessage,
  };
}

export function canAssignSelectedKpiWeights(
  kpis: Kpi[],
  departmentId: string,
  selected: DepartmentKpiIndicator[],
  employeeName?: string,
): { ok: boolean; message?: string } {
  const preview = previewEmployeeAssignment(kpis, departmentId, selected, employeeName);
  return { ok: preview.ok, message: preview.message };
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
