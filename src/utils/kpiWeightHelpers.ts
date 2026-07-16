import { Kpi } from './kpiHelpers';

/** Sum pending KPI weights for one employee (should total 100%). */
export function sumEmployeeKpiWeights(kpis: Kpi[]): number {
  return kpis
    .filter((k) => k.completion_status !== 'completed')
    .reduce((s, k) => s + Number(k.weight || 0), 0);
}

export function employeeKpiWeightsValid(kpis: Kpi[]): boolean {
  const pending = kpis.filter((k) => k.completion_status !== 'completed');
  if (pending.length === 0) return true;
  return Math.abs(sumEmployeeKpiWeights(kpis) - 100) <= 0.05;
}

export function formatKpiWeight(weight: number): string {
  const n = Number(weight);
  if (n <= 100) return `${n.toFixed(n % 1 === 0 ? 0 : 1)}%`;
  return String(n);
}
