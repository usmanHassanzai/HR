import { AttendanceRecord, ATTENDANCE_STATUS_LABEL, APPROVAL_LABEL } from './attendanceHelpers';
import { TeamAttendanceHistoryRow } from './shiftHelpers';
import { formatClockTime } from './geoAttendance';
import { suggestBrowserTimeZone } from './ianaTimezones';
import { utcToZonedWall } from './shiftMultiZone';

function escapeCsv(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function clockInZone(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const wall = utcToZonedWall(new Date(iso), timeZone);
  return `${wall.hm} ${timeZone}`;
}

/**
 * Export with one clock-in/out column pair per zone (R79).
 * `zoneColumns` should list main first, then display zones.
 */
export function downloadAttendanceCsv(
  records: AttendanceRecord[],
  employeeName: string,
  periodLabel: string,
  zoneColumns?: string[],
) {
  const zones =
    zoneColumns && zoneColumns.length > 0
      ? zoneColumns
      : [suggestBrowserTimeZone() || 'UTC'];
  const zoneHeaders = zones.flatMap((z) => [`Clock In (${z})`, `Clock Out (${z})`]);
  const header = ['Employee', 'Date', 'Status', ...zoneHeaders, 'Source', 'Approval', 'Notes'].join(',');
  const rows = records.map((r) => {
    const zoneCells = zones.flatMap((z) => [
      escapeCsv(clockInZone(r.clock_in_at, z)),
      escapeCsv(clockInZone(r.clock_out_at, z)),
    ]);
    return [
      escapeCsv(employeeName),
      r.attendance_date,
      ATTENDANCE_STATUS_LABEL[r.status],
      ...zoneCells,
      r.attendance_source || 'manual',
      APPROVAL_LABEL[r.approval_status],
      escapeCsv(r.notes || ''),
    ].join(',');
  });
  triggerCsvDownload(
    [header, ...rows].join('\n'),
    `attendance-${employeeName.replace(/\s+/g, '-').toLowerCase()}-${periodLabel.replace(/\s+/g, '-').toLowerCase()}.csv`,
  );
}

export function downloadTeamAttendanceCsv(
  rows: TeamAttendanceHistoryRow[],
  periodLabel: string,
  zoneColumns?: string[],
) {
  const zones =
    zoneColumns && zoneColumns.length > 0
      ? zoneColumns
      : [suggestBrowserTimeZone() || 'UTC'];
  const zoneHeaders = zones.flatMap((z) => [`Clock In (${z})`, `Clock Out (${z})`]);
  const header = [
    'Employee',
    'Role',
    'Department',
    'Date',
    'Status',
    ...zoneHeaders,
    'Duration (min)',
    'Source',
    'Approval',
    'Notes',
  ].join(',');
  const csvRows = rows.map((r) => {
    const zoneCells = zones.flatMap((z) => [
      escapeCsv(clockInZone(r.clock_in_at, z)),
      escapeCsv(clockInZone(r.clock_out_at, z)),
    ]);
    return [
      escapeCsv(r.employee_name),
      r.employee_role,
      escapeCsv(r.department_name || ''),
      r.attendance_date,
      ATTENDANCE_STATUS_LABEL[r.status as keyof typeof ATTENDANCE_STATUS_LABEL] || r.status,
      ...zoneCells,
      String(r.work_minutes ?? ''),
      r.attendance_source || 'manual',
      APPROVAL_LABEL[r.approval_status as keyof typeof APPROVAL_LABEL] || r.approval_status,
      escapeCsv(r.notes || ''),
    ].join(',');
  });
  triggerCsvDownload(
    [header, ...csvRows].join('\n'),
    `attendance-${periodLabel.replace(/\s+/g, '-').toLowerCase()}.csv`,
  );
}

function triggerCsvDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

/** Legacy single-locale clock helper */
export function formatLegacyClock(iso: string | null | undefined): string {
  return formatClockTime(iso);
}
