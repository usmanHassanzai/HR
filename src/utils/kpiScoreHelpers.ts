import type { Kpi } from './kpiHelpers';
import { kpiOverlapsCurrentMonth } from './kpiCategories';

/** Round to two decimal places (49.50, 12.75, 90.75). */
export function roundKpiScore(value: number): number {
  return Math.round((Number(value) || 0) * 100) / 100;
}

export function formatKpiScore(value: number): string {
  return roundKpiScore(value).toFixed(2);
}

function karachiYmd(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value.slice(0, 10);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!y || !m || !day) return value.slice(0, 10);
  return `${y}-${m}-${day}`;
}

function todayKarachiYmd(): string {
  return karachiYmd(new Date().toISOString());
}

/** True when the KPI end date is before today (Asia/Karachi). */
export function isKpiPastDeadline(kpi: Pick<Kpi, 'end_date' | 'completion_status'>): boolean {
  if (!kpi.end_date || kpi.completion_status === 'completed') return false;
  return todayKarachiYmd() > karachiYmd(kpi.end_date);
}

/** Completed after the assigned end date — earns half points. */
export function isKpiLateCompletion(kpi: Pick<Kpi, 'completion_status' | 'end_date' | 'completed_at' | 'updated_at'>): boolean {
  if (kpi.completion_status !== 'completed' || !kpi.end_date) return false;
  const done = kpi.completed_at || kpi.updated_at;
  if (!done) return false;
  return karachiYmd(done) > karachiYmd(kpi.end_date);
}

/** Assigned Score (points if completed on time). May exceed Weight. Defaults to Weight. */
export function kpiAssignedScore(kpi: Kpi): number {
  const weight = Number(kpi.weight || 0);
  if (kpi.assigned_score != null && Number.isFinite(Number(kpi.assigned_score))) {
    return roundKpiScore(Math.max(0, Number(kpi.assigned_score)));
  }
  return roundKpiScore(weight);
}

/** Contribution % of weight when completed (null if still open). */
export function kpiManagerScorePct(kpi: Kpi): number | null {
  if (kpi.completion_status !== 'completed') return null;
  const weight = Number(kpi.weight || 0);
  if (weight <= 0) return 0;
  return roundKpiScore((kpiScoreContribution(kpi) / weight) * 100);
}

/** Target achieved % for a KPI. Open tasks are 0 for contribution tables. */
export function kpiAchievedPct(kpi: Kpi): number {
  return kpiManagerScorePct(kpi) ?? 0;
}

export const kpiEmployeeScore = kpiAchievedPct;

export function calculateWeightedKpiScore(employeeScore: number, weight: number): number {
  return roundKpiScore((Number(employeeScore) / 100) * Number(weight || 0));
}

/** Points awarded from Score + due date: full on time, half if late, 0 if still open. */
export function kpiScoreContribution(kpi: Kpi): number {
  if (kpi.completion_status !== 'completed') return 0;
  const score = kpiAssignedScore(kpi);
  return isKpiLateCompletion(kpi) ? roundKpiScore(score * 0.5) : score;
}

/**
 * Monthly score = sum of Scores awarded ÷ sum of Weights × 100.
 * Open tasks count in weight and contribute 0 until marked Complete.
 */
export function calculateOverallKpiScore(kpis: Kpi[]): number {
  const totalWeight = kpis.reduce((sum, kpi) => sum + Number(kpi.weight || 0), 0);
  if (totalWeight <= 0) return 0;
  const points = kpis.reduce((sum, kpi) => sum + kpiScoreContribution(kpi), 0);
  return roundKpiScore((points / totalWeight) * 100);
}

export function thisMonthKpis(kpis: Kpi[]): Kpi[] {
  return kpis.filter((k) => kpiOverlapsCurrentMonth(k));
}

export function thisMonthKpiScore(kpis: Kpi[]): number {
  return calculateOverallKpiScore(thisMonthKpis(kpis));
}

export const employeeWeightedKpiScore = calculateOverallKpiScore;
export const employeeTotalKpiPoints = calculateOverallKpiScore;

/** Sum of Scores awarded (completed tasks). Not Reward Points. */
export function employeePerformancePoints(kpis: Kpi[]): number {
  return roundKpiScore(kpis.reduce((sum, kpi) => sum + kpiScoreContribution(kpi), 0));
}

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

export function formatKpiTaskPoints(kpi: Kpi): string | null {
  if (kpiManagerScorePct(kpi) == null) return null;
  return formatKpiScore(kpiScoreContribution(kpi));
}

export function kpiScoreRows(kpis: Kpi[]): KpiScoreRow[] {
  return kpis.map((kpi) => {
    const employeeScore = kpiAchievedPct(kpi);
    const weight = Number(kpi.weight || 0);
    return {
      kpi,
      name: kpi.name,
      weight,
      employeeScore,
      weightedScore: kpiScoreContribution(kpi),
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

export function trafficLightLabel(light: 'green' | 'yellow' | 'red' | 'gray'): string {
  if (light === 'gray') return 'Not started';
  if (light === 'green') return 'Going well';
  if (light === 'yellow') return 'Needs attention';
  return 'Behind';
}
