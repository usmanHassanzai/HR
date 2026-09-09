import {
  TeamAttendanceHistoryRow,
  describeAttendanceHistory,
} from '../utils/shiftHelpers';
import {
  APPROVAL_LABEL,
  approvalBadgeClass,
  ApprovalStatus,
  ATTENDANCE_STATUS_LABEL,
  attendanceStatusBadgeClass,
} from '../utils/attendanceHelpers';
import '../styles/attendance.css';

type AttendanceRecord = Pick<
  TeamAttendanceHistoryRow,
  | 'id'
  | 'attendance_date'
  | 'shift_name'
  | 'clock_in_at'
  | 'clock_out_at'
  | 'work_minutes'
  | 'attendance_source'
  | 'status'
  | 'approval_status'
> & {
  employee_name?: string;
  department_name?: string | null;
};

interface AttendanceHistoryRecordsProps {
  rows: AttendanceRecord[];
  showEmployee?: boolean;
  showDepartment?: boolean;
  /** detailed = full columns; simple = date/in/out/duration */
  variant?: 'detailed' | 'simple';
}

function sourceLabel(source: string | null | undefined): string {
  if (source === 'geo') return 'GPS';
  return source || 'Manual';
}

function attendanceLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return ATTENDANCE_STATUS_LABEL[status as keyof typeof ATTENDANCE_STATUS_LABEL] || status;
}

export default function AttendanceHistoryRecords({
  rows,
  showEmployee = false,
  showDepartment = false,
  variant = 'detailed',
}: AttendanceHistoryRecordsProps) {
  if (rows.length === 0) return null;

  return (
    <>
      <div className="team-points-table-wrap attendance-records-scroll">
        <table className={`attendance-history-table${variant === 'detailed' ? ' attendance-history-table--detailed' : ''}`}>
          <thead>
            <tr>
              {showEmployee && <th>Employee</th>}
              <th>Date</th>
              {showDepartment && <th>Department</th>}
              {variant === 'detailed' && <th>Shift</th>}
              <th>{variant === 'detailed' ? 'Clock in' : 'In'}</th>
              <th>{variant === 'detailed' ? 'Clock out' : 'Out'}</th>
              <th>Duration</th>
              {variant === 'detailed' && <th>Source</th>}
              {variant === 'detailed' && <th>Attendance</th>}
              {variant === 'detailed' && <th>Status</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const timing = describeAttendanceHistory(r);
              return (
                <tr key={r.id}>
                  {showEmployee && (
                    <td>
                      <strong>{r.employee_name || '—'}</strong>
                    </td>
                  )}
                  <td>
                    <strong>{r.attendance_date}</strong>
                  </td>
                  {showDepartment && <td>{r.department_name || '—'}</td>}
                  {variant === 'detailed' && (
                    <td className={timing.shiftEmpty ? 'att-cell-muted' : undefined}>{timing.shift}</td>
                  )}
                  <td>{timing.clockIn}</td>
                  <td
                    className={
                      timing.stillPresent
                        ? 'att-cell-present'
                        : timing.clockOutEmpty
                          ? 'att-cell-muted'
                          : undefined
                    }
                  >
                    {timing.clockOut}
                  </td>
                  <td
                    className={
                      timing.stillPresent
                        ? 'att-cell-present'
                        : timing.durationEmpty
                          ? 'att-cell-muted'
                          : undefined
                    }
                  >
                    {timing.duration}
                  </td>
                  {variant === 'detailed' && <td>{sourceLabel(r.attendance_source)}</td>}
                  {variant === 'detailed' && (
                    <td>
                      <span className={`badge ${attendanceStatusBadgeClass(r.status)}`}>
                        {attendanceLabel(r.status)}
                      </span>
                    </td>
                  )}
                  {variant === 'detailed' && (
                    <td>
                      <span className={`badge ${approvalBadgeClass(r.approval_status as ApprovalStatus)}`}>
                        {APPROVAL_LABEL[r.approval_status as ApprovalStatus]}
                      </span>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="attendance-record-cards" aria-label="Attendance records">
        {rows.map((r) => {
          const timing = describeAttendanceHistory(r);
          return (
            <article key={`card-${r.id}`} className="attendance-record-card">
              <header className="attendance-record-card__head">
                <div className="attendance-record-card__title">
                  {showEmployee && r.employee_name ? (
                    <strong className="attendance-record-card__name">{r.employee_name}</strong>
                  ) : null}
                  <strong className="attendance-record-card__date">{r.attendance_date}</strong>
                  {showDepartment && r.department_name ? (
                    <span className="attendance-record-card__dept">{r.department_name}</span>
                  ) : null}
                </div>
                {variant === 'detailed' ? (
                  <div className="attendance-record-card__badges">
                    <span className={`badge ${attendanceStatusBadgeClass(r.status)}`}>
                      {attendanceLabel(r.status)}
                    </span>
                    <span className={`badge ${approvalBadgeClass(r.approval_status as ApprovalStatus)}`}>
                      {APPROVAL_LABEL[r.approval_status as ApprovalStatus]}
                    </span>
                  </div>
                ) : null}
              </header>

              <dl className="attendance-record-card__grid">
                {variant === 'detailed' ? (
                  <div>
                    <dt>Shift</dt>
                    <dd className={timing.shiftEmpty ? 'att-cell-muted' : undefined}>{timing.shift}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>Clock in</dt>
                  <dd>{timing.clockIn}</dd>
                </div>
                <div>
                  <dt>Clock out</dt>
                  <dd
                    className={
                      timing.stillPresent
                        ? 'att-cell-present'
                        : timing.clockOutEmpty
                          ? 'att-cell-muted'
                          : undefined
                    }
                  >
                    {timing.clockOut}
                  </dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd
                    className={
                      timing.stillPresent
                        ? 'att-cell-present'
                        : timing.durationEmpty
                          ? 'att-cell-muted'
                          : undefined
                    }
                  >
                    {timing.duration}
                  </dd>
                </div>
                {variant === 'detailed' ? (
                  <div>
                    <dt>Source</dt>
                    <dd>{sourceLabel(r.attendance_source)}</dd>
                  </div>
                ) : null}
              </dl>
            </article>
          );
        })}
      </div>
    </>
  );
}
