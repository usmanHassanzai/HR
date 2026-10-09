import { AttendanceRecord, ATTENDANCE_STATUS_LABEL, APPROVAL_LABEL } from './attendanceHelpers';
import { resolveEffectiveClockOut, TeamAttendanceHistoryRow } from './shiftHelpers';
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
    const outAt = resolveEffectiveClockOut(r);
    const zoneCells = zones.flatMap((z) => [
      escapeCsv(clockInZone(r.clock_in_at, z)),
      escapeCsv(clockInZone(outAt, z)),
    ]);
    return [
      escapeCsv(employeeName),
      r.attendance_date,
      ATTENDANCE_STATUS_LABEL[r.status],
      ...zoneCells,
      exportSourceLabel(r.attendance_source),
      APPROVAL_LABEL[r.approval_status],
      escapeCsv(r.notes || ''),
    ].join(',');
  });
  triggerCsvDownload(
    [header, ...rows].join('\n'),
    `attendance-${employeeName.replace(/\s+/g, '-').toLowerCase()}-${periodLabel.replace(/\s+/g, '-').toLowerCase()}.csv`,
  );
}

function exportSourceLabel(source: string | null | undefined): string {
  if (source === 'auto_wifi_no_gps' || source === 'manual_wifi_no_gps') return 'No location - Wi-Fi only';
  if (source === 'auto_wifi') return 'Wi-Fi + GPS';
  if (source === 'auto_laptop') return 'Laptop';
  if (source === 'auto_gps' || source === 'geo') return 'GPS';
  return source || 'manual';
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
    'Visits',
    'Source',
    'Approval',
    'Notes',
  ].join(',');
  const csvRows = rows.map((r) => {
    const outAt = resolveEffectiveClockOut(r);
    const zoneCells = zones.flatMap((z) => [
      escapeCsv(clockInZone(r.clock_in_at, z)),
      escapeCsv(clockInZone(outAt, z)),
    ]);
    const visitCount = (r as { visit_count?: number | null }).visit_count;
    return [
      escapeCsv(r.employee_name),
      r.employee_role,
      escapeCsv(r.department_name || ''),
      r.attendance_date,
      ATTENDANCE_STATUS_LABEL[r.status as keyof typeof ATTENDANCE_STATUS_LABEL] || r.status,
      ...zoneCells,
      String(r.work_minutes ?? ''),
      visitCount != null && visitCount > 0 ? String(visitCount) : '',
      exportSourceLabel(r.attendance_source),
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
