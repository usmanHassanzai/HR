import { useState } from 'react';
import { ChevronDown, User } from 'lucide-react';
import { TeamAttendanceHistoryRow } from '../utils/shiftHelpers';
import { groupAttendanceByMonth } from '../utils/attendancePeriod';
import AttendanceHistoryRecords from './AttendanceHistoryRecords';
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
                  <AttendanceHistoryRecords
                    rows={bucket.rows}
                    showEmployee={showEmployee}
                    variant="detailed"
                  />
                )}
              </div>
            )}
          </article>
        );
      })}
    </div>
  );
}
