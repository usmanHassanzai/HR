import { Kpi } from './kpiHelpers';

export const MAX_RANGE_DAYS = 92;

export function localYmd(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localYmd(d);
}

export function defaultWeekRange(at = new Date()): { from: string; to: string } {
  const to = localYmd(at);
  return { from: addDays(to, -6), to };
}

export function daysInclusive(from: string, to: string): number {
  const a = new Date(`${from}T12:00:00`).getTime();
  const b = new Date(`${to}T12:00:00`).getTime();
  return Math.floor((b - a) / 86400000) + 1;
}

export function validateDateRange(from: string, to: string): string | null {
  if (!from || !to) return 'Choose both dates.';
  if (from > to) return 'From must be on or before To.';
  if (daysInclusive(from, to) > MAX_RANGE_DAYS) return 'Choose a range of 3 months or less.';
  return null;
}

export function kpiOverlapsRange(kpi: Kpi, from: string, to: string): boolean {
  const start = (kpi.start_date || kpi.created_at || '').slice(0, 10) || from;
  const end = (kpi.end_date || kpi.updated_at || kpi.created_at || '').slice(0, 10) || to;
  return start <= to && end >= from;
}
