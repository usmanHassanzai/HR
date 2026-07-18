import { AttendanceRecord, ATTENDANCE_STATUS_LABEL, APPROVAL_LABEL } from './attendanceHelpers';
import { TeamAttendanceHistoryRow } from './shiftHelpers';
import { formatClockTime } from './geoAttendance';

function escapeCsv(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function rowToCsvCells(employeeName: string, r: AttendanceRecord) {
  return [
    escapeCsv(employeeName),
    r.attendance_date,
    ATTENDANCE_STATUS_LABEL[r.status],
    formatClockTime(r.clock_in_at),
    formatClockTime(r.clock_out_at),
    r.attendance_source || 'manual',
    APPROVAL_LABEL[r.approval_status],
    escapeCsv(r.notes || ''),
  ].join(',');
}

export function downloadAttendanceCsv(records: AttendanceRecord[], employeeName: string, periodLabel: string) {
  const header = 'Employee,Date,Status,Clock In,Clock Out,Source,Approval,Notes';
  const rows = records.map((r) => rowToCsvCells(employeeName, r));
  triggerCsvDownload([header, ...rows].join('\n'), `attendance-${employeeName.replace(/\s+/g, '-').toLowerCase()}-${periodLabel.replace(/\s+/g, '-').toLowerCase()}.csv`);
}

export function downloadTeamAttendanceCsv(rows: TeamAttendanceHistoryRow[], periodLabel: string) {
  const header = 'Employee,Role,Department,Date,Status,Clock In,Clock Out,Duration (min),Source,Approval,Notes';
  const csvRows = rows.map((r) =>
    [
      escapeCsv(r.employee_name),
      r.employee_role,
      escapeCsv(r.department_name || ''),
      r.attendance_date,
      ATTENDANCE_STATUS_LABEL[r.status as keyof typeof ATTENDANCE_STATUS_LABEL] || r.status,
      formatClockTime(r.clock_in_at),
      formatClockTime(r.clock_out_at),
      String(r.work_minutes ?? ''),
      r.attendance_source || 'manual',
      APPROVAL_LABEL[r.approval_status as keyof typeof APPROVAL_LABEL] || r.approval_status,
      escapeCsv(r.notes || ''),
    ].join(',')
  );
  triggerCsvDownload([header, ...csvRows].join('\n'), `attendance-${periodLabel.replace(/\s+/g, '-').toLowerCase()}.csv`);
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
