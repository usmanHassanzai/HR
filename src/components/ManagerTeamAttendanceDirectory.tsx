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
  formatDateTime,
  formatWorkDuration,
} from '../utils/shiftHelpers';
import { APPROVAL_LABEL, approvalBadgeClass, ApprovalStatus } from '../utils/attendanceHelpers';
import { downloadAttendanceCsv, downloadTeamAttendanceCsv } from '../utils/exportAttendance';
import '../styles/manager-attendance.css';

interface ManagerTeamAttendanceDirectoryProps {
  profile: Profile;
  teamMembers: Profile[];
}

interface EmployeeGroup {
  user: Profile;
  rows: TeamAttendanceHistoryRow[];
}

type BrowsePeriod = 'month' | 'year';

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
}: ManagerTeamAttendanceDirectoryProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [browsePeriod, setBrowsePeriod] = useState<BrowsePeriod>('month');
  const [rows, setRows] = useState<TeamAttendanceHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const yearLabel = String(year);
  const periodLabel = browsePeriod === 'month' ? monthLabel : yearLabel;

  const directReports = useMemo(
    () => teamMembers.filter((m) => m.id !== profile.id && m.role === 'employee'),
    [teamMembers, profile.id],
  );

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_team_attendance_history', {
      p_year: year,
      p_month: browsePeriod === 'month' ? month : null,
      p_user_id: null,
      p_department_id: null,
      p_scope: 'team',
    });

    const allRows = !error ? ((data || []) as TeamAttendanceHistoryRow[]) : [];
    const reportIds = new Set(directReports.map((m) => m.id));
    setRows(allRows.filter((r) => reportIds.has(r.user_id)));
    setLoading(false);
  }, [year, month, browsePeriod, directReports]);

  useEffect(() => {
    void load();
  }, [load]);

  const employeeGroups = useMemo(() => {
    const byUser = new Map<string, TeamAttendanceHistoryRow[]>();
    for (const r of rows) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id)!.push(r);
    }

    const groups: EmployeeGroup[] = directReports.map((user) => ({
      user,
      rows: (byUser.get(user.id) || []).sort((a, b) => b.attendance_date.localeCompare(a.attendance_date)),
    }));

    return groups.sort((a, b) => a.user.full_name.localeCompare(b.user.full_name));
  }, [directReports, rows]);

  const totalRecords = rows.length;
  const totalPresent = rows.filter((r) => r.clock_in_at).length;

  const toggleEmployee = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const fetchEmployeeRows = async (userId: string, period: BrowsePeriod): Promise<TeamAttendanceHistoryRow[]> => {
    const user = directReports.find((m) => m.id === userId);
    if (!user) return [];

    const { data, error } = await supabase.rpc('get_attendance_history', {
      p_year: year,
      p_month: period === 'month' ? month : null,
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
        p_month: period === 'month' ? month : null,
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
        <History size={18} /> Team attendance history
      </h3>
      <p>
        Each direct report has their own attendance record. Expand an employee to review check-ins, then download
        their history as a monthly or yearly CSV report.
      </p>

      <div className="mgr-attendance-filters">
        <div className="form-group">
          <label htmlFor="mgr-att-period">Browse</label>
          <select
            id="mgr-att-period"
            value={browsePeriod}
            onChange={(e) => setBrowsePeriod(e.target.value as BrowsePeriod)}
          >
            <option value="month">Monthly view</option>
            <option value="year">Yearly view</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="mgr-att-year">Year</label>
          <select id="mgr-att-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year - 1, year, year + 1].map((y) => (
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
          <span>Loading team attendance…</span>
        </div>
      ) : directReports.length === 0 ? (
        <div className="mgr-attendance-empty">
          <Users size={40} strokeWidth={1.25} />
          <h4>No direct reports yet</h4>
          <p>Assign employees to your team to track and export their attendance history.</p>
        </div>
      ) : (
        <div className="mgr-attendance-employee-list">
          {employeeGroups.map((group) => {
            const isOpen = expanded[group.user.id] ?? false;
            const daysPresent = group.rows.filter((r) => r.clock_in_at).length;
            const totalMins = group.rows.reduce((s, r) => s + (r.work_minutes || 0), 0);
            const firstName = group.user.full_name.split(' ')[0];

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
                    <strong>{group.user.full_name}</strong>
                    <span>{group.user.email}</span>
                  </span>
                  <span className="mgr-attendance-employee__stats">
                    <span>
                      {daysPresent} day{daysPresent !== 1 ? 's' : ''} present
                    </span>
                    <span>{formatWorkDuration(totalMins)} logged</span>
                    <span>
                      {group.rows.length} record{group.rows.length !== 1 ? 's' : ''}
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
                        Download {firstName}&apos;s month
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={exporting !== null}
                        onClick={() => void exportEmployee(group, 'year')}
                      >
                        {exporting === `${group.user.id}-year` ? (
                          <Loader2 size={14} className="spin-icon" />
                        ) : (
                          <Download size={14} />
                        )}
                        Download {firstName}&apos;s year
                      </button>
                    </div>

                    {group.rows.length === 0 ? (
                      <p className="mgr-attendance-empty-inline">
                        <User size={16} />
                        No attendance records for {periodLabel}.
                      </p>
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
                              <th>Status</th>
                            </tr>
                          </thead>
                          <tbody>
                            {group.rows.map((r) => (
                              <tr key={r.id}>
                                <td>
                                  <strong>{r.attendance_date}</strong>
                                </td>
                                <td>{r.shift_name || '—'}</td>
                                <td>{formatDateTime(r.clock_in_at)}</td>
                                <td>{formatDateTime(r.clock_out_at)}</td>
                                <td>{formatWorkDuration(r.work_minutes)}</td>
                                <td>{r.attendance_source === 'geo' ? 'GPS' : r.attendance_source || 'Manual'}</td>
                                <td>
                                  <span
                                    className={`badge ${approvalBadgeClass(r.approval_status as ApprovalStatus)}`}
                                  >
                                    {APPROVAL_LABEL[r.approval_status as ApprovalStatus]}
                                  </span>
                                </td>
                              </tr>
                            ))}
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
      )}
    </section>
  );
}
