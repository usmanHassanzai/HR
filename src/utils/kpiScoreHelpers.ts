import type { Kpi } from './kpiHelpers';
import {
  karachiYearMonth,
  kpiOverlapsCurrentMonth,
  kpiOverlapsMonth,
  kpiOverlapsYear,
} from './kpiCategories';
import { kpiScoringRule } from './kpiScoringRules';
import { KPI_WEIGHT_CAP } from './kpiWeightHelpers';

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

function addDaysYmd(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

/** True when the KPI end date is before today (Asia/Karachi). */
export function isKpiPastDeadline(kpi: Pick<Kpi, 'end_date' | 'completion_status'>): boolean {
  if (!kpi.end_date || kpi.completion_status === 'completed') return false;
  return todayKarachiYmd() > karachiYmd(kpi.end_date);
}

/** Completed after due date (+ optional grace) — may earn a reduced score when penalty is enabled. */
export function isKpiLateCompletion(
  kpi: Pick<
    Kpi,
    | 'completion_status'
    | 'end_date'
    | 'completed_at'
    | 'updated_at'
    | 'late_penalty_enabled'
    | 'late_penalty_grace_days'
  >,
): boolean {
  if (kpi.completion_status !== 'completed' || !kpi.end_date) return false;
  const done = kpi.completed_at || kpi.updated_at;
  if (!done) return false;
  const grace = Math.max(0, Math.floor(Number(kpi.late_penalty_grace_days ?? 0)));
  return karachiYmd(done) > addDaysYmd(karachiYmd(kpi.end_date), grace);
}

/** True when a late completion actually reduces awarded points. */
export function isKpiLatePenaltyApplied(kpi: Kpi): boolean {
  return Boolean(kpiScoringRule(kpi).penaltyEnabled) && isKpiLateCompletion(kpi);
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

/** Points awarded from Score + optional late scoring rule. Open → 0. */
export function kpiScoreContribution(kpi: Kpi): number {
  if (kpi.completion_status !== 'completed') return 0;
  const score = kpiAssignedScore(kpi);
  const rule = kpiScoringRule(kpi);
  if (!rule.penaltyEnabled || !isKpiLateCompletion(kpi)) return score;
  if (rule.penaltyType === 'percentage_cut') {
    return roundKpiScore(score * (rule.penaltyValue / 100));
  }
  return score;
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

export function previousMonthKpis(kpis: Kpi[], now = new Date()): Kpi[] {
  const { year, monthIndex } = karachiYearMonth(now);
  const prev = new Date(year, monthIndex - 1, 1);
  return kpis.filter((k) => kpiOverlapsMonth(k, prev.getFullYear(), prev.getMonth()));
}

export function monthLabel(year: number, monthIndex: number): string {
  return new Date(year, monthIndex, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
}

export function thisAndPreviousMonthLabels(now = new Date()): { thisMonth: string; previousMonth: string } {
  const { year, monthIndex } = karachiYearMonth(now);
  const prev = new Date(year, monthIndex - 1, 1);
  return {
    thisMonth: monthLabel(year, monthIndex),
    previousMonth: monthLabel(prev.getFullYear(), prev.getMonth()),
  };
}

export function thisMonthKpiScore(kpis: Kpi[]): number {
  return calculateOverallKpiScore(thisMonthKpis(kpis));
}

export function previousMonthKpiScore(kpis: Kpi[]): number {
  return calculateOverallKpiScore(previousMonthKpis(kpis));
}

export type KpiPeriodMode = 'overall' | 'month' | 'year';

export function kpisForPeriod(
  kpis: Kpi[],
  mode: KpiPeriodMode,
  year: number,
  monthIndex = 0,
): Kpi[] {
  if (mode === 'overall') return kpis;
  if (mode === 'year') return kpis.filter((k) => kpiOverlapsYear(k, year));
  return kpis.filter((k) => kpiOverlapsMonth(k, year, monthIndex));
}

export function periodLabel(mode: KpiPeriodMode, year: number, monthIndex = 0): string {
  if (mode === 'overall') return 'Overall';
  if (mode === 'year') return String(year);
  return monthLabel(year, monthIndex);
}

/** Years available from KPI dates plus the current Karachi year. */
export function availableKpiYears(kpis: Kpi[], now = new Date()): number[] {
  const { year: current } = karachiYearMonth(now);
  const years = new Set<number>([current, current - 1]);
  for (const kpi of kpis) {
    for (const raw of [kpi.start_date, kpi.end_date, kpi.created_at]) {
      if (!raw) continue;
      const y = Number(String(raw).slice(0, 4));
      if (Number.isFinite(y) && y >= 2000 && y <= current + 1) years.add(y);
    }
  }
  return Array.from(years).sort((a, b) => b - a);
}

export const MONTH_OPTIONS = [
  { value: 0, label: 'January' },
  { value: 1, label: 'February' },
  { value: 2, label: 'March' },
  { value: 3, label: 'April' },
  { value: 4, label: 'May' },
  { value: 5, label: 'June' },
  { value: 6, label: 'July' },
  { value: 7, label: 'August' },
  { value: 8, label: 'September' },
  { value: 9, label: 'October' },
  { value: 10, label: 'November' },
  { value: 11, label: 'December' },
] as const;

/** Points awarded (completed scores) and weight totals for a KPI set. */
export function employeeKpiMonthBreakdown(kpis: Kpi[]) {
  const summary = employeeKpiScoreSummary(kpis);
  const pointsAwarded = employeePerformancePoints(kpis);
  const openWeight = roundKpiScore(
    kpis
      .filter((k) => k.completion_status !== 'completed')
      .reduce((s, k) => s + Number(k.weight || 0), 0),
  );
  return {
    ...summary,
    pointsAwarded,
    openWeight,
  };
}

/** Cap weightage display values at the 100% pool (never show > 100% for weight fields). */
function clampWeightPct(value: number): number {
  return roundKpiScore(Math.min(KPI_WEIGHT_CAP, Math.max(0, Number(value) || 0)));
}

/**
 * Scoreboard breakdown for a KPI set (month filter or all-time).
 * Weightage block is capped at 100%. Score uses raw assigned weight and may exceed 100%.
 */
export function employeeKpiBoardBreakdown(kpis: Kpi[]) {
  const weightAssignedRaw = roundKpiScore(
    kpis.reduce((s, k) => s + Number(k.weight || 0), 0),
  );
  const weightAchievedRaw = roundKpiScore(
    kpis
      .filter((k) => k.completion_status === 'completed')
      .reduce((s, k) => s + Number(k.weight || 0), 0),
  );
  const weightPendingRaw = roundKpiScore(
    kpis
      .filter((k) => k.completion_status !== 'completed')
      .reduce((s, k) => s + Number(k.weight || 0), 0),
  );
  const pointsAwarded = employeePerformancePoints(kpis);
  const score = weightAssignedRaw > 0
    ? roundKpiScore((pointsAwarded / weightAssignedRaw) * 100)
    : 0;
  const completed = kpis.filter((k) => k.completion_status === 'completed').length;

  return {
    kpiCount: kpis.length,
    completed,
    pending: kpis.length - completed,
    // Block A — Weightage (≤ 100%)
    totalWeight: KPI_WEIGHT_CAP,
    weightAssigned: clampWeightPct(weightAssignedRaw),
    weightAchieved: clampWeightPct(weightAchievedRaw),
    weightPending: clampWeightPct(weightPendingRaw),
    weightUnassigned: clampWeightPct(KPI_WEIGHT_CAP - weightAssignedRaw),
    weightAssignedRaw,
    // Block B — Score (may exceed 100%)
    score,
    pointsAwarded,
    performanceRating: performanceRatingForScore(score),
  };
}

export type KpiBoardBreakdown = ReturnType<typeof employeeKpiBoardBreakdown>;

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
