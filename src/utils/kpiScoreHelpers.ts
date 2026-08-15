import { Kpi } from './kpiHelpers';

/** Target achieved % for a KPI (0–100). */
export function kpiAchievedPct(kpi: Kpi): number {
  if (kpi.completion_status === 'completed') return 100;
  if (kpi.target_value > 0) {
    return Math.min(100, Math.max(0, Math.round((Number(kpi.current_value) / Number(kpi.target_value)) * 100)));
  }
  if (kpi.status === 'on_track') return 100;
  if (kpi.status === 'at_risk') return 50;
  return 0;
}

/**
 * Image formula: Score contribution = (achieved %) × (KPI weight %)
 * e.g. 80% achieved × 30% weight = 24 points
 */
export function kpiScoreContribution(kpi: Kpi): number {
  const achieved = kpiAchievedPct(kpi);
  const weight = Number(kpi.weight || 0);
  return Math.round((achieved / 100) * weight * 100) / 100;
}

/** Weighted KPI board score for an employee (sum of contributions across all assigned KPIs). */
export function employeeWeightedKpiScore(kpis: Kpi[]): number {
  if (kpis.length === 0) return 0;
  return Math.round(kpis.reduce((s, k) => s + kpiScoreContribution(k), 0));
}

/** Total contribution points earned from all assigned KPIs. */
export function employeeTotalKpiPoints(kpis: Kpi[]): number {
  if (kpis.length === 0) return 0;
  return Math.round(kpis.reduce((s, k) => s + kpiScoreContribution(k), 0) * 100) / 100;
}

export function statusTrafficLight(status: string): 'green' | 'yellow' | 'red' {
  if (status === 'on_track' || status === 'completed') return 'green';
  if (status === 'at_risk') return 'yellow';
  return 'red';
}

export function trafficLightLabel(light: 'green' | 'yellow' | 'red'): string {
  if (light === 'green') return 'On track';
  if (light === 'yellow') return 'At risk';
  return 'Off track';
}
