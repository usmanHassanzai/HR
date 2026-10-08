import type { Kpi } from './kpiHelpers';
import { karachiYearMonth } from './kpiCategories';

const TZ = 'Asia/Karachi';

/** Calendar day parts in Asia/Karachi. */
export function karachiCalendarDay(now = new Date()): { year: number; monthIndex: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const year = Number(parts.find((p) => p.type === 'year')?.value) || now.getFullYear();
  const month = Number(parts.find((p) => p.type === 'month')?.value) || now.getMonth() + 1;
  const day = Number(parts.find((p) => p.type === 'day')?.value) || now.getDate();
  return { year, monthIndex: month - 1, day };
}

/** Last calendar day of a month (28 / 29 / 30 / 31). */
export function lastDayOfMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** True on the last day of the current Asia/Karachi month. */
export function isWeightageRevealDay(now = new Date()): boolean {
  const { year, monthIndex, day } = karachiCalendarDay(now);
  return day === lastDayOfMonth(year, monthIndex);
}

export function monthEndLabel(year: number, monthIndex: number): string {
  const last = lastDayOfMonth(year, monthIndex);
  const d = new Date(Date.UTC(year, monthIndex, last));
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

/** Which month an approved KPI's weightage belongs to (completed_at preferred). */
export function kpiAwardYearMonth(kpi: Pick<Kpi, 'completed_at' | 'end_date' | 'created_at'>): {
  year: number;
  monthIndex: number;
} {
  const raw = (kpi.completed_at || kpi.end_date || kpi.created_at || '').slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const year = Number(raw.slice(0, 4));
    const monthIndex = Number(raw.slice(5, 7)) - 1;
    if (Number.isFinite(year) && monthIndex >= 0 && monthIndex <= 11) {
      return { year, monthIndex };
    }
  }
  return karachiYearMonth();
}

/**
 * Whether awarded weightage for a given Asia/Karachi month is visible to
 * employees / managers on their own dashboards.
 * Past months: always. Current month: unlocks on the last calendar day.
 */
export function isMonthAwardedWeightageVisible(
  year: number,
  monthIndex: number,
  now = new Date(),
): boolean {
  const cur = karachiCalendarDay(now);
  if (year < cur.year) return true;
  if (year > cur.year) return true;
  if (monthIndex < cur.monthIndex) return true;
  if (monthIndex > cur.monthIndex) return true;
  return cur.day >= lastDayOfMonth(cur.year, cur.monthIndex);
}

/**
 * Employees/managers see awarded weightage only after that month has ended
 * (visible from the last calendar day: 28 / 29 / 30 / 31).
 * Past months are always visible. Current month unlocks on its last day.
 */
export function isKpiAwardedWeightageVisible(
  kpi: Pick<Kpi, 'completion_status' | 'completed_at' | 'end_date' | 'created_at'>,
  now = new Date(),
): boolean {
  if (kpi.completion_status !== 'completed') return false;
  const award = kpiAwardYearMonth(kpi);
  return isMonthAwardedWeightageVisible(award.year, award.monthIndex, now);
}

export function weightageRevealHint(now = new Date()): string {
  const { year, monthIndex } = karachiCalendarDay(now);
  const last = lastDayOfMonth(year, monthIndex);
  return `Awarded weightage posts on your dashboard on the last day of the month (${last} ${new Date(Date.UTC(year, monthIndex, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' })}).`;
}

/** Display value for achieved weightage; null means “not revealed yet”. */
export function displayedAwardedWeightage(
  kpi: Kpi,
  opts?: { deferUntilMonthEnd?: boolean; now?: Date },
): number | null {
  if (kpi.completion_status !== 'completed') return null;
  if (opts?.deferUntilMonthEnd && !isKpiAwardedWeightageVisible(kpi, opts.now)) return null;
  return Math.max(0, Number(kpi.assigned_score ?? kpi.weight ?? 0));
}

/**
 * Unused awarded weightage from closed months (before the current Karachi month).
 * Used as a client display fallback until server rollover deposits into Banked.
 */
export function estimateUnusedPriorWeightage(
  kpis: Pick<Kpi, 'completion_status' | 'completed_at' | 'end_date' | 'created_at' | 'assigned_score' | 'weight'>[],
  now = new Date(),
): number {
  const cur = karachiCalendarDay(now);
  let sum = 0;
  for (const kpi of kpis) {
    if (kpi.completion_status !== 'completed') continue;
    const award = kpiAwardYearMonth(kpi);
    const isPrior =
      award.year < cur.year
      || (award.year === cur.year && award.monthIndex < cur.monthIndex);
    if (!isPrior) continue;
    const weight = Math.max(0, Number(kpi.weight || 0));
    const awarded = Math.max(0, Number(kpi.assigned_score ?? kpi.weight ?? 0));
    sum += Math.min(awarded, weight);
  }
  return Math.round(Math.min(100, Math.max(0, sum)) * 100) / 100;
}
