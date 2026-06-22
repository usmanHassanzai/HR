import { AttendanceRecord, ATTENDANCE_STATUS_LABEL, APPROVAL_LABEL } from './attendanceHelpers';

function escapeCsv(value: string) {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export function downloadAttendanceCsv(records: AttendanceRecord[], employeeName: string, periodLabel: string) {
  const header = 'Employee,Date,Status,Approval,Notes';
  const rows = records.map((r) =>
    [
      escapeCsv(employeeName),
      r.attendance_date,
      ATTENDANCE_STATUS_LABEL[r.status],
      APPROVAL_LABEL[r.approval_status],
      escapeCsv(r.notes || ''),
    ].join(',')
  );
  const csv = [header, ...rows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attendance-${employeeName.replace(/\s+/g, '-').toLowerCase()}-${periodLabel.replace(/\s+/g, '-').toLowerCase()}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
