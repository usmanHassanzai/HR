import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  Download,
  History,
  Loader2,
  User,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  AttendanceHistoryRow,
  TeamAttendanceHistoryRow,
  formatWorkDuration,
  describeAttendanceHistory,
} from '../utils/shiftHelpers';
import {
  APPROVAL_LABEL,
  approvalBadgeClass,
  ApprovalStatus,
  ATTENDANCE_STATUS_LABEL,
  attendanceStatusBadgeClass,
} from '../utils/attendanceHelpers';
import { downloadAttendanceCsv } from '../utils/exportAttendance';
import {
  AttendanceBrowseView,
  attendanceYearOptions,
  canViewYearlyAttendance,
  historyMonthParam,
} from '../utils/attendancePeriod';
import AttendanceMonthWiseList from './AttendanceMonthWiseList';
import '../styles/manager-attendance.css';

interface EmployeeAttendanceHistoryProps {
  profile: Profile;
  refreshKey?: number;
}

type BrowsePeriod = AttendanceBrowseView;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}

function mapHistoryRow(r: AttendanceHistoryRow, user: Profile): TeamAttendanceHistoryRow {
  return {
    id: r.id,
    user_id: user.id,
    employee_name: user.full_name,
    employee_role: user.role,
    department_name: null,
    attendance_date: r.attendance_date,
    status: r.status,
    approval_status: r.approval_status,
    clock_in_at: r.clock_in_at,
    clock_out_at: r.clock_out_at,
    attendance_source: r.attendance_source,
    work_minutes: r.work_minutes,
    shift_name: r.shift_name,
    notes: r.notes,
  };
}

function mapRowToRecord(r: TeamAttendanceHistoryRow) {
  return {
    id: r.id,
    user_id: r.user_id,
    attendance_date: r.attendance_date,
    status: r.status as 'present',
    approval_status: r.approval_status as 'approved',
    clock_in_at: r.clock_in_at,
    clock_out_at: r.clock_out_at,
    attendance_source: r.attendance_source || 'manual',
    notes: r.notes,
    marked_by: null,
    reviewed_by: null,
    reviewed_at: null,
    created_at: r.attendance_date,
  };
}

function periodBounds(year: number, month: number | null): { start: string; end: string } {
  if (month == null) {
    return { start: `${year}-01-01`, end: `${year}-12-31` };
  }
  const last = new Date(year, month, 0).getDate();
  return {
    start: `${year}-${String(month).padStart(2, '0')}-01`,
    end: `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
  };
}

export default function EmployeeAttendanceHistory({
  profile,
  refreshKey = 0,
}: EmployeeAttendanceHistoryProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [browsePeriod, setBrowsePeriod] = useState<BrowsePeriod>('month');
  const [rows, setRows] = useState<TeamAttendanceHistoryRow[]>([]);
  const [cardOpen, setCardOpen] = useState(true);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);

  const canYear = canViewYearlyAttendance(profile.created_at);
  const yearOptions = attendanceYearOptions(profile.created_at);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const yearLabel = String(year);
  const periodLabel = browsePeriod === 'month' ? monthLabel : yearLabel;
  const firstName = profile.full_name.split(' ')[0] || 'My';

  const loadHistoryRows = useCallback(
    async (period: BrowsePeriod): Promise<TeamAttendanceHistoryRow[]> => {
      const monthParam = historyMonthParam(period, month);
      const { data, error } = await supabase.rpc('get_attendance_history', {
        p_year: year,
        p_month: monthParam,
        p_user_id: profile.id,
      });

      if (!error && data && data.length > 0) {
        return (data as AttendanceHistoryRow[]).map((r) => mapHistoryRow(r, profile));
      }

      const { start, end } = periodBounds(year, monthParam);
      const { data: raw } = await supabase
        .from('attendance_records')
        .select(
          'id, attendance_date, status, approval_status, clock_in_at, clock_out_at, attendance_source, work_minutes, notes',
        )
        .eq('user_id', profile.id)
        .gte('attendance_date', start)
        .lte('attendance_date', end)
        .order('attendance_date', { ascending: false });

      return ((raw || []) as AttendanceHistoryRow[]).map((r) =>
        mapHistoryRow({ ...r, shift_name: r.shift_name ?? null }, profile),
      );
    },
    [year, month, profile],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const mapped = await loadHistoryRows(browsePeriod);
    setRows(mapped.sort((a, b) => String(b.attendance_date).localeCompare(String(a.attendance_date))));
    setLoading(false);
  }, [browsePeriod, loadHistoryRows, refreshKey]);

  useEffect(() => {
    if (browsePeriod === 'year' && !canYear) setBrowsePeriod('month');
  }, [browsePeriod, canYear]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalRecords = rows.length;
  const totalPresent = rows.filter((r) => r.clock_in_at).length;
  const totalMinutes = rows.reduce((s, r) => s + (r.work_minutes || 0), 0);

  const fetchRowsForExport = async (period: BrowsePeriod): Promise<TeamAttendanceHistoryRow[]> => {
    if (period === browsePeriod && rows.length > 0) return rows;
    return loadHistoryRows(period);
  };

  const exportPeriod = async (period: BrowsePeriod) => {
    const key = period === 'month' ? 'month' : 'year';
    setExporting(key);
    try {
      const exportRows = await fetchRowsForExport(period);
      const label = period === 'month' ? monthLabel : yearLabel;
      downloadAttendanceCsv(exportRows.map(mapRowToRecord), profile.full_name, label);
    } finally {
      setExporting(null);
    }
  };

  return (
    <section className="mgr-attendance-card">
      <h3>
        <History size={18} /> Attendance history
      </h3>
      <p>
        See this month day by day, or month by month for the year.
        {canYear
          ? ' You can also open the full year because you have been here for at least one year.'
          : ' Full year opens after you have been with the company for one year.'}
      </p>

      <div className="mgr-attendance-filters">
        <div className="form-group">
          <label htmlFor="emp-att-browse">Show</label>
          <select
            id="emp-att-browse"
            value={browsePeriod}
            onChange={(e) => setBrowsePeriod(e.target.value as BrowsePeriod)}
          >
            <option value="month">This month (daily)</option>
            <option value="monthwise">Month by month</option>
            <option value="year" disabled={!canYear}>
              Full year{canYear ? '' : ' (after 1 year)'}
            </option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="emp-att-year">Year</label>
          <select id="emp-att-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        {browsePeriod === 'month' && (
          <div className="form-group">
            <label htmlFor="emp-att-month">Month</label>
            <select id="emp-att-month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(year, i, 1).toLocaleString('default', { month: 'long' })}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {loading ? (
        <div className="mgr-attendance-loading">
          <Loader2 size={28} className="spin-icon" />
          <span>Loading attendance…</span>
        </div>
      ) : (
        <div className="mgr-attendance-employee-list">
          <article className="mgr-attendance-employee">
            <button
              type="button"
              className="mgr-attendance-employee__toggle"
              onClick={() => setCardOpen((open) => !open)}
              aria-expanded={cardOpen}
            >
              <span className="mgr-attendance-employee__avatar">{initials(profile.full_name)}</span>
              <span className="mgr-attendance-employee__info">
                <span className="mgr-attendance-employee__name-row">
                  <strong>{profile.full_name}</strong>
                </span>
                <span className="mgr-attendance-employee__email">{profile.email}</span>
                <span className="mgr-attendance-employee__stats">
                  <span className="mgr-attendance-employee__stat">
                    {totalPresent} day{totalPresent !== 1 ? 's' : ''} present
                  </span>
                  <span className="mgr-attendance-employee__stat">
                    {formatWorkDuration(totalMinutes)} logged
                  </span>
                  <span className="mgr-attendance-employee__stat">
                    {totalRecords} record{totalRecords !== 1 ? 's' : ''}
                  </span>
                </span>
              </span>
              <ChevronDown
                size={18}
                className={`mgr-attendance-employee__chev${cardOpen ? ' mgr-attendance-employee__chev--open' : ''}`}
              />
            </button>

            {cardOpen && (
              <div className="mgr-attendance-employee__body">
                <div className="mgr-attendance-employee__toolbar">
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={exporting !== null}
                    onClick={() => void exportPeriod('month')}
                  >
                    {exporting === 'month' ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
                    Download {firstName}&apos;s month
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={exporting !== null || !canYear}
                    onClick={() => void exportPeriod('year')}
                    title={canYear ? undefined : 'Full year is available after 1 year with the company'}
                  >
                    {exporting === 'year' ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
                    Download {firstName}&apos;s year
                  </button>
                </div>

                {rows.length === 0 && browsePeriod !== 'monthwise' ? (
                  <p className="mgr-attendance-empty-inline">
                    <User size={16} />
                    No attendance records for {periodLabel}.
                  </p>
                ) : browsePeriod === 'monthwise' ? (
                  <AttendanceMonthWiseList rows={rows} year={year} />
                ) : (
                  <div className="team-points-table-wrap">
                    <table className="attendance-history-table attendance-history-table--detailed">
                      <thead>
                        <tr>
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
                        {rows.map((r) => {
                          const timing = describeAttendanceHistory(r);
                          return (
                            <tr key={r.id}>
                              <td>
                                <strong>{r.attendance_date}</strong>
                              </td>
                              <td className={timing.shiftEmpty ? 'att-cell-muted' : undefined}>{timing.shift}</td>
                              <td>{timing.clockIn}</td>
                              <td className={timing.clockOutEmpty ? 'att-cell-muted' : undefined}>{timing.clockOut}</td>
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
        </div>
      )}
    </section>
  );
}
