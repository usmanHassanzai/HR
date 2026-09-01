import type { TeamAttendanceHistoryRow } from './shiftHelpers';
import { formatWorkDuration } from './shiftHelpers';

export type AttendanceBrowseView = 'month' | 'monthwise' | 'year';

const MS_DAY = 24 * 60 * 60 * 1000;

export function canViewYearlyAttendance(createdAt?: string | null, now = new Date()): boolean {
  if (!createdAt) return false;
  const joined = new Date(createdAt);
  if (Number.isNaN(joined.getTime())) return false;
  return now.getTime() - joined.getTime() >= 365 * MS_DAY;
}

export function attendanceYearOptions(
  createdAt?: string | null,
  now = new Date(),
  maxPastYears = 8,
): number[] {
  const thisYear = now.getFullYear();
  const joined = createdAt ? new Date(createdAt) : null;
  const joinedYear = joined && !Number.isNaN(joined.getTime()) ? joined.getFullYear() : thisYear - maxPastYears;
  const minYear = Math.max(thisYear - maxPastYears, joinedYear);
  const years: number[] = [];
  for (let y = thisYear; y >= minYear; y -= 1) years.push(y);
  return years.length ? years : [thisYear];
}

export function monthKey(date: string): string {
  return String(date).slice(0, 7);
}

export function monthLabelFromKey(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
}

export function monthsOfYear(year: number): string[] {
  return Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
}

export type MonthAttendanceBucket = {
  key: string;
  label: string;
  rows: TeamAttendanceHistoryRow[];
  daysPresent: number;
  totalMinutes: number;
  durationLabel: string;
};

export function groupAttendanceByMonth(
  rows: TeamAttendanceHistoryRow[],
  year: number,
): MonthAttendanceBucket[] {
  const byKey = new Map<string, TeamAttendanceHistoryRow[]>();
  for (const row of rows) {
    const key = monthKey(row.attendance_date);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(row);
  }
  return monthsOfYear(year)
    .map((key) => {
      const monthRows = (byKey.get(key) || []).sort((a, b) =>
        String(b.attendance_date).localeCompare(String(a.attendance_date)),
      );
      const totalMinutes = monthRows.reduce((sum, r) => sum + (r.work_minutes || 0), 0);
      return {
        key,
        label: monthLabelFromKey(key),
        rows: monthRows,
        daysPresent: monthRows.filter((r) => r.clock_in_at).length,
        totalMinutes,
        durationLabel: formatWorkDuration(totalMinutes),
      };
    })
    .reverse();
}

export function historyMonthParam(view: AttendanceBrowseView, month: number): number | null {
  return view === 'month' ? month : null;
}
