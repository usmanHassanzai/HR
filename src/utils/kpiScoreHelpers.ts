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

/** Weighted KPI board score for an employee (max 100 when all KPIs at 100% achieved). */
export function employeeWeightedKpiScore(kpis: Kpi[]): number {
  const active = kpis.filter((k) => k.completion_status !== 'completed');
  const list = active.length > 0 ? active : kpis;
  if (list.length === 0) return 0;
  return Math.round(list.reduce((s, k) => s + kpiScoreContribution(k), 0));
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
