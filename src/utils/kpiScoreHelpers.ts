import type { Kpi } from './kpiHelpers';

/** Round to two decimal places (49.50, 12.75, 90.75). */
export function roundKpiScore(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function formatKpiScore(value: number): string {
  return roundKpiScore(value).toFixed(2);
}

/** Target achieved % for a KPI (0–100). This is the Employee Score. */
export function kpiAchievedPct(kpi: Kpi): number {
  if (kpi.completion_status === 'completed') return 100;
  if (kpi.target_value > 0) {
    return Math.min(100, Math.max(0, Math.round((Number(kpi.current_value) / Number(kpi.target_value)) * 100)));
  }
  if (kpi.status === 'on_track') return 100;
  if (kpi.status === 'at_risk') return 50;
  return 0;
}

export const kpiEmployeeScore = kpiAchievedPct;

/**
 * Weighted KPI Score = Employee Score % × KPI Weight
 * Example: 90% × 55 = 49.50
 */
export function calculateWeightedKpiScore(employeeScore: number, weight: number): number {
  return roundKpiScore((Number(employeeScore) / 100) * Number(weight || 0));
}

export function kpiScoreContribution(kpi: Kpi): number {
  return calculateWeightedKpiScore(kpiAchievedPct(kpi), Number(kpi.weight || 0));
}

/** Overall KPI Score = SUM(weighted KPI scores). Do not normalize unused weight. */
export function calculateOverallKpiScore(kpis: Kpi[]): number {
  if (!kpis.length) return 0;
  return roundKpiScore(kpis.reduce((s, k) => s + kpiScoreContribution(k), 0));
}

export const employeeWeightedKpiScore = calculateOverallKpiScore;
export const employeeTotalKpiPoints = calculateOverallKpiScore;

export type PerformanceRating =
  | 'Outstanding'
  | 'Excellent'
  | 'Good'
  | 'Needs Improvement'
  | 'Unsatisfactory';

/** Screenshot ranges: 95–100 Outstanding, 90–94 Excellent, 80–89 Good, 70–79 Needs Improvement, <70 Unsatisfactory. */
export function performanceRatingForScore(overallScore: number): PerformanceRating {
  const n = Number(overallScore) || 0;
  if (n >= 95) return 'Outstanding';
  if (n >= 90) return 'Excellent';
  if (n >= 80) return 'Good';
  if (n >= 70) return 'Needs Improvement';
  return 'Unsatisfactory';
}

export function performanceRatingColor(rating: PerformanceRating): string {
  if (rating === 'Outstanding' || rating === 'Excellent') return 'var(--color-success)';
  if (rating === 'Good') return 'var(--accent-primary)';
  if (rating === 'Needs Improvement') return 'var(--color-warning)';
  return 'var(--color-danger)';
}

export type KpiScoreRow = {
  kpi: Kpi;
  name: string;
  weight: number;
  employeeScore: number;
  weightedScore: number;
};

export function kpiScoreRows(kpis: Kpi[]): KpiScoreRow[] {
  return kpis.map((kpi) => {
    const employeeScore = kpiAchievedPct(kpi);
    const weight = Number(kpi.weight || 0);
    return {
      kpi,
      name: kpi.name,
      weight,
      employeeScore,
      weightedScore: calculateWeightedKpiScore(employeeScore, weight),
    };
  });
}

export function employeeKpiScoreSummary(kpis: Kpi[]) {
  const overallScore = calculateOverallKpiScore(kpis);
  const completed = kpis.filter((k) => k.completion_status === 'completed').length;
  const totalWeight = roundKpiScore(kpis.reduce((s, k) => s + Number(k.weight || 0), 0));
  return {
    overallScore,
    performanceRating: performanceRatingForScore(overallScore),
    totalWeight,
    kpiCount: kpis.length,
    completed,
    pending: kpis.length - completed,
  };
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
