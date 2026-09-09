import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  ChevronDown,
  Download,
  History,
  Loader2,
  User,
  Users,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  AttendanceHistoryRow,
  TeamAttendanceHistoryRow,
  formatWorkDuration,
} from '../utils/shiftHelpers';
import { downloadAttendanceCsv, downloadTeamAttendanceCsv } from '../utils/exportAttendance';
import { reconcileEndedShiftAttendance } from '../utils/reconcileAttendance';
import {
  AttendanceBrowseView,
  attendanceYearOptions,
  canViewYearlyAttendance,
  historyMonthParam,
} from '../utils/attendancePeriod';
import AttendanceMonthWiseList from './AttendanceMonthWiseList';
import AttendanceHistoryRecords from './AttendanceHistoryRecords';
import '../styles/manager-attendance.css';

interface ManagerTeamAttendanceDirectoryProps {
  profile: Profile;
  teamMembers: Profile[];
  refreshKey?: number;
}

interface EmployeeGroup {
  user: Profile;
  rows: TeamAttendanceHistoryRow[];
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

export default function ManagerTeamAttendanceDirectory({
  profile,
  teamMembers,
  refreshKey = 0,
}: ManagerTeamAttendanceDirectoryProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [browsePeriod, setBrowsePeriod] = useState<BrowsePeriod>('month');
  const [rows, setRows] = useState<TeamAttendanceHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ [profile.id]: true });
  const [ownRows, setOwnRows] = useState<TeamAttendanceHistoryRow[]>([]);

  const yearOptions = attendanceYearOptions(profile.created_at);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const yearLabel = String(year);
  const periodLabel = browsePeriod === 'month' ? monthLabel : yearLabel;

  const directReports = useMemo(
    () => teamMembers.filter((m) => m.id !== profile.id && m.role === 'employee'),
    [teamMembers, profile.id],
  );

  const load = useCallback(async () => {
    setLoading(true);
    await reconcileEndedShiftAttendance();
    const [{ data, error }, { data: mine, error: mineErr }] = await Promise.all([
      supabase.rpc('get_team_attendance_history', {
        p_year: year,
        p_month: historyMonthParam(browsePeriod, month),
        p_user_id: null,
        p_department_id: null,
        p_scope: 'team',
      }),
      supabase.rpc('get_attendance_history', {
        p_year: year,
        p_month: historyMonthParam(browsePeriod, month),
        p_user_id: profile.id,
      }),
    ]);

    const allRows = !error ? ((data || []) as TeamAttendanceHistoryRow[]) : [];
    const reportIds = new Set(directReports.map((m) => m.id));
    setRows(allRows.filter((r) => reportIds.has(r.user_id)));
    setOwnRows(
      !mineErr && mine
        ? (mine as AttendanceHistoryRow[]).map((r) => mapHistoryRow(r, profile))
        : [],
    );
    setLoading(false);
  }, [year, month, browsePeriod, directReports, refreshKey, profile]);

  useEffect(() => {
    void load();
  }, [load]);

  const employeeGroups = useMemo(() => {
    const byUser = new Map<string, TeamAttendanceHistoryRow[]>();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r);
    }

    const mine: EmployeeGroup = {
      user: profile,
      rows: [...ownRows].sort((a, b) => b.attendance_date.localeCompare(a.attendance_date)),
    };

    const team: EmployeeGroup[] = directReports.map((user) => ({
      user,
      rows: (byUser.get(user.id) || []).sort((a, b) => b.attendance_date.localeCompare(a.attendance_date)),
    }));

    return [mine, ...team.sort((a, b) => a.user.full_name.localeCompare(b.user.full_name))];
  }, [directReports, rows, ownRows, profile]);

  const totalRecords = rows.length;
  const totalPresent = rows.filter((r) => r.clock_in_at).length;

  const toggleEmployee = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const fetchEmployeeRows = async (userId: string, period: BrowsePeriod): Promise<TeamAttendanceHistoryRow[]> => {
    const user = userId === profile.id ? profile : directReports.find((m) => m.id === userId);
    if (!user) return [];

    const { data, error } = await supabase.rpc('get_attendance_history', {
      p_year: year,
      p_month: historyMonthParam(period, month),
      p_user_id: userId,
    });

    if (error || !data) return [];
    return (data as AttendanceHistoryRow[]).map((r) => mapHistoryRow(r, user));
  };

  const exportEmployee = async (group: EmployeeGroup, period: BrowsePeriod) => {
    const key = `${group.user.id}-${period}`;
    setExporting(key);
    try {
      const exportRows =
        period === browsePeriod && group.rows.length > 0
          ? group.rows
          : await fetchEmployeeRows(group.user.id, period);

      const label = period === 'month' ? monthLabel : yearLabel;
      downloadAttendanceCsv(
        exportRows.map(mapRowToRecord),
        group.user.full_name,
        label,
      );
    } finally {
      setExporting(null);
    }
  };

  const exportAllTeam = async (period: BrowsePeriod) => {
    const key = period === 'month' ? '__team_month__' : '__team_year__';
    setExporting(key);
    try {
      if (period === browsePeriod && rows.length > 0) {
        downloadTeamAttendanceCsv(rows, period === 'month' ? monthLabel : yearLabel);
        return;
      }

      const { data, error } = await supabase.rpc('get_team_attendance_history', {
        p_year: year,
        p_month: historyMonthParam(period, month),
        p_user_id: null,
        p_department_id: null,
        p_scope: 'team',
      });

      const allRows = !error ? ((data || []) as TeamAttendanceHistoryRow[]) : [];
      const reportIds = new Set(directReports.map((m) => m.id));
      const filtered = allRows.filter((r) => reportIds.has(r.user_id));
      downloadTeamAttendanceCsv(filtered, period === 'month' ? monthLabel : yearLabel);
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
        Your records are first. Use this month (daily), month by month, or the full year. Full year for a person opens
        after they have been with the company for one year. Team members are listed below.
      </p>

      <div className="mgr-attendance-filters">
        <div className="form-group">
          <label htmlFor="mgr-att-period">Show</label>
          <select
            id="mgr-att-period"
            value={browsePeriod}
            onChange={(e) => setBrowsePeriod(e.target.value as BrowsePeriod)}
          >
            <option value="month">This month (daily)</option>
            <option value="monthwise">Month by month</option>
            <option value="year">Full year</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="mgr-att-year">Year</label>
          <select id="mgr-att-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        {browsePeriod === 'month' && (
          <div className="form-group">
            <label htmlFor="mgr-att-month">Month</label>
            <select id="mgr-att-month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(year, i, 1).toLocaleString('default', { month: 'long' })}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="mgr-attendance-filters__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={exporting !== null || directReports.length === 0}
            onClick={() => void exportAllTeam('month')}
          >
            {exporting === '__team_month__' ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
            All team · month
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={exporting !== null || directReports.length === 0}
            onClick={() => void exportAllTeam('year')}
          >
            {exporting === '__team_year__' ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
            All team · year
          </button>
        </div>
      </div>

      <div className="mgr-attendance-stats">
        <div className="mgr-attendance-stat">
          <User size={16} />
          <span className="mgr-attendance-stat__label">Your days present</span>
          <strong>{ownRows.filter((r) => r.clock_in_at).length}</strong>
        </div>
        <div className="mgr-attendance-stat">
          <Users size={16} />
          <span className="mgr-attendance-stat__label">Direct reports</span>
          <strong>{directReports.length}</strong>
        </div>
        <div className="mgr-attendance-stat">
          <Calendar size={16} />
          <span className="mgr-attendance-stat__label">Records ({periodLabel})</span>
          <strong>{totalRecords}</strong>
        </div>
        <div className="mgr-attendance-stat">
          <History size={16} />
          <span className="mgr-attendance-stat__label">Days with check-in</span>
          <strong>{totalPresent}</strong>
        </div>
      </div>

      {loading ? (
        <div className="mgr-attendance-loading">
          <Loader2 size={28} className="spin-icon" />
          <span>Loading attendance…</span>
        </div>
      ) : (
        <div className="mgr-attendance-employee-list">
          {employeeGroups.map((group) => {
            const isSelf = group.user.id === profile.id;
            const isOpen = expanded[group.user.id] ?? isSelf;
            const daysPresent = group.rows.filter((r) => r.clock_in_at).length;
            const totalMins = group.rows.reduce((s, r) => s + (r.work_minutes || 0), 0);
            const personCanYear = canViewYearlyAttendance(group.user.created_at);
            const firstName = isSelf ? 'my' : `${group.user.full_name.split(' ')[0]}'s`;

            return (
              <article key={group.user.id} className="mgr-attendance-employee">
                <button
                  type="button"
                  className="mgr-attendance-employee__toggle"
                  onClick={() => toggleEmployee(group.user.id)}
                  aria-expanded={isOpen}
                >
                  <span className="mgr-attendance-employee__avatar">{initials(group.user.full_name)}</span>
                  <span className="mgr-attendance-employee__info">
                    <span className="mgr-attendance-employee__name-row">
                      <strong>{isSelf ? `${group.user.full_name} (you)` : group.user.full_name}</strong>
                      {isSelf && <span className="mgr-attendance-you-badge">Your history</span>}
                    </span>
                    <span className="mgr-attendance-employee__email">{group.user.email}</span>
                    <span className="mgr-attendance-employee__stats">
                      <span className="mgr-attendance-employee__stat">
                        {daysPresent} day{daysPresent !== 1 ? 's' : ''} present
                      </span>
                      <span className="mgr-attendance-employee__stat">
                        {formatWorkDuration(totalMins)} logged
                      </span>
                      <span className="mgr-attendance-employee__stat">
                        {group.rows.length} record{group.rows.length !== 1 ? 's' : ''}
                      </span>
                    </span>
                  </span>
                  <ChevronDown
                    size={18}
                    className={`mgr-attendance-employee__chev${isOpen ? ' mgr-attendance-employee__chev--open' : ''}`}
                  />
                </button>

                {isOpen && (
                  <div className="mgr-attendance-employee__body">
                    <div className="mgr-attendance-employee__toolbar">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={exporting !== null}
                        onClick={() => void exportEmployee(group, 'month')}
                      >
                        {exporting === `${group.user.id}-month` ? (
                          <Loader2 size={14} className="spin-icon" />
                        ) : (
                          <Download size={14} />
                        )}
                        Download {isSelf ? 'my month' : `${firstName} month`}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={exporting !== null || !personCanYear}
                        onClick={() => void exportEmployee(group, 'year')}
                        title={personCanYear ? undefined : 'Full year opens after 1 year with the company'}
                      >
                        {exporting === `${group.user.id}-year` ? (
                          <Loader2 size={14} className="spin-icon" />
                        ) : (
                          <Download size={14} />
                        )}
                        Download {isSelf ? 'my year' : `${firstName} year`}
                      </button>
                    </div>

                    {browsePeriod === 'year' && !personCanYear ? (
                      <p className="mgr-attendance-empty-inline">
                        <User size={16} />
                        Full year attendance opens after 1 year with the company.
                      </p>
                    ) : browsePeriod === 'monthwise' ? (
                      <AttendanceMonthWiseList rows={group.rows} year={year} />
                    ) : group.rows.length === 0 ? (
                      <p className="mgr-attendance-empty-inline">
                        <User size={16} />
                        No attendance records for {periodLabel}.
                      </p>
                    ) : (
                      <AttendanceHistoryRecords rows={group.rows} variant="detailed" />
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
