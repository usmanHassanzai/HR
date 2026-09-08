import { useState } from 'react';
import { ChevronDown, User } from 'lucide-react';
import { TeamAttendanceHistoryRow, describeAttendanceHistory } from '../utils/shiftHelpers';
import { groupAttendanceByMonth } from '../utils/attendancePeriod';
import {
  APPROVAL_LABEL,
  approvalBadgeClass,
  ApprovalStatus,
  ATTENDANCE_STATUS_LABEL,
  attendanceStatusBadgeClass,
} from '../utils/attendanceHelpers';
import '../styles/attendance.css';
import '../styles/employee-attendance.css';

export default function AttendanceMonthWiseList({
  rows,
  year,
  showEmployee = false,
}: {
  rows: TeamAttendanceHistoryRow[];
  year: number;
  showEmployee?: boolean;
}) {
  const buckets = groupAttendanceByMonth(rows, year);
  const currentKey = `${year}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const [openKey, setOpenKey] = useState(currentKey);

  return (
    <div className="emp-attendance-month-list">
      {buckets.map((bucket) => {
        const open = openKey === bucket.key;
        return (
          <article key={bucket.key} className="emp-attendance-month-block">
            <button
              type="button"
              className="emp-attendance-month-block__toggle"
              onClick={() => setOpenKey(open ? '' : bucket.key)}
              aria-expanded={open}
            >
              <span>
                <strong>{bucket.label}</strong>
                <span className="emp-attendance-month-block__meta">
                  {bucket.daysPresent} day{bucket.daysPresent !== 1 ? 's' : ''} present · {bucket.durationLabel} · {bucket.rows.length} record{bucket.rows.length !== 1 ? 's' : ''}
                </span>
              </span>
              <ChevronDown size={18} className={`emp-attendance-month-block__chev${open ? ' emp-attendance-month-block__chev--open' : ''}`} />
            </button>
            {open && (
              <div className="emp-attendance-month-block__body">
                {bucket.rows.length === 0 ? (
                  <p className="mgr-attendance-empty-inline">
                    <User size={16} />
                    No attendance this month.
                  </p>
                ) : (
                  <div className="team-points-table-wrap">
                    <table className="attendance-history-table attendance-history-table--detailed">
                      <thead>
                        <tr>
                          {showEmployee && <th>Name</th>}
                          <th>Date</th>
                          <th>Shift</th>
                          <th>Clock in</th>
                          <th>Clock out</th>
                          <th>Duration</th>
                          <th>Source</th>
                          <th>Attendance</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bucket.rows.map((r) => {
                          const timing = describeAttendanceHistory(r);
                          return (
                            <tr key={r.id}>
                              {showEmployee && <td><strong>{r.employee_name}</strong></td>}
                              <td><strong>{r.attendance_date}</strong></td>
                              <td className={timing.shiftEmpty ? 'att-cell-muted' : undefined}>{timing.shift}</td>
                              <td>{timing.clockIn}</td>
                              <td className={timing.stillPresent ? 'att-cell-present' : timing.clockOutEmpty ? 'att-cell-muted' : undefined}>{timing.clockOut}</td>
                              <td className={timing.durationEmpty ? 'att-cell-muted' : undefined}>{timing.duration}</td>
                              <td>{r.attendance_source === 'geo' ? 'GPS' : r.attendance_source || 'Manual'}</td>
                              <td>
                                <span className={`badge ${attendanceStatusBadgeClass(r.status)}`}>
                                  {ATTENDANCE_STATUS_LABEL[r.status as keyof typeof ATTENDANCE_STATUS_LABEL] || r.status}
                                </span>
                              </td>
                              <td>
                                <span className={`badge ${approvalBadgeClass(r.approval_status as ApprovalStatus)}`}>
                                  {APPROVAL_LABEL[r.approval_status as ApprovalStatus]}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
