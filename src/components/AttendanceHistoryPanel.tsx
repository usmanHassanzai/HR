import { useCallback, useEffect, useState } from 'react';
import { Calendar, Download, FileText, History, Loader2, RefreshCw } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import {
  AttendanceHistoryRow,
  TeamAttendanceHistoryRow,
  MonthlyAttendanceReport,
  formatDateTime,
  formatWorkDuration,
} from '../utils/shiftHelpers';
import { APPROVAL_LABEL, approvalBadgeClass, ApprovalStatus } from '../utils/attendanceHelpers';
import { downloadAttendanceCsv, downloadTeamAttendanceCsv } from '../utils/exportAttendance';
import { formatClockTime } from '../utils/geoAttendance';

interface AttendanceHistoryPanelProps {
  profile: Profile;
  mode: 'employee' | 'manager' | 'admin';
  teamMembers?: Profile[];
  departments?: Department[];
}

type ViewMode = 'daily' | 'monthly';
type HistoryScope = 'self' | 'team' | 'department' | 'company';

export default function AttendanceHistoryPanel({
  profile,
  mode,
  teamMembers = [],
  departments = [],
}: AttendanceHistoryPanelProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [view, setView] = useState<ViewMode>('daily');
  const [scope, setScope] = useState<HistoryScope>(mode === 'employee' ? 'self' : mode === 'manager' ? 'team' : 'company');
  const [departmentId, setDepartmentId] = useState('');
  const [userId, setUserId] = useState(profile.id);
  const [rows, setRows] = useState<TeamAttendanceHistoryRow[]>([]);
  const [monthlyReports, setMonthlyReports] = useState<MonthlyAttendanceReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [generating, setGenerating] = useState(false);

  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const showEmployeeColumn = scope !== 'self' || (mode === 'manager' && userId !== profile.id);
  const isTeamView = scope === 'team' || scope === 'department' || scope === 'company';

  const load = useCallback(async () => {
    setLoading(true);
    const activeScope = mode === 'employee' ? 'self' : scope;
    const monthParam = view === 'daily' ? month : null;

    if (activeScope !== 'self' && mode !== 'employee') {
      const deptFilter =
        activeScope === 'department'
          ? departmentId || profile.department_id || null
          : activeScope === 'company' && departmentId
            ? departmentId
            : null;

      const { data, error } = await supabase.rpc('get_team_attendance_history', {
        p_year: year,
        p_month: monthParam,
        p_user_id: null,
        p_department_id: deptFilter,
        p_scope: activeScope,
      });
      setRows(!error ? (data || []) as TeamAttendanceHistoryRow[] : []);
    } else if (userId !== profile.id && mode === 'manager') {
      const { data, error } = await supabase.rpc('get_attendance_history', {
        p_year: year,
        p_month: monthParam,
        p_user_id: userId,
      });
      const mapped = ((data || []) as AttendanceHistoryRow[]).map((r) => ({
        ...r,
        user_id: userId,
        employee_name: teamMembers.find((m) => m.id === userId)?.full_name || 'Employee',
        employee_role: 'employee',
        department_name: null,
      }));
      setRows(!error ? mapped : []);
    } else {
      const { data, error } = await supabase.rpc('get_attendance_history', {
        p_year: year,
        p_month: monthParam,
        p_user_id: null,
      });
      const mapped = ((data || []) as AttendanceHistoryRow[]).map((r) => ({
        ...r,
        user_id: profile.id,
        employee_name: profile.full_name,
        employee_role: profile.role,
        department_name: null,
      }));
      setRows(!error ? mapped : []);
    }

    if (mode !== 'employee') {
      const { data: reports } = await supabase.rpc('get_monthly_attendance_reports', { p_year: year });
      setMonthlyReports((reports || []) as MonthlyAttendanceReport[]);
    }

    setLoading(false);
  }, [year, month, view, userId, profile, mode, scope, departmentId, teamMembers]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (mode === 'manager' && profile.department_id && !departmentId) {
      setDepartmentId(profile.department_id);
    }
    if (mode === 'admin' && departments[0] && !departmentId && scope === 'company') {
      setDepartmentId('');
    }
  }, [mode, profile.department_id, departments, departmentId, scope]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      if (isTeamView && rows.length > 0) {
        downloadTeamAttendanceCsv(rows, monthLabel);
      } else {
        const name = mode === 'manager' && userId !== profile.id
          ? teamMembers.find((m) => m.id === userId)?.full_name || profile.full_name
          : profile.full_name;
        downloadAttendanceCsv(
          rows.map((r) => ({
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
          })),
          name,
          view === 'daily' ? monthLabel : `${year}`,
        );
      }
    } finally {
      setExporting(false);
    }
  };

  const generateMonthlyReport = async () => {
    setGenerating(true);
    try {
      const dept = scope === 'department' ? (departmentId || profile.department_id || null) : departmentId || null;
      await supabase.rpc('generate_monthly_attendance_report', {
        p_year: year,
        p_month: month,
        p_department_id: dept || null,
      });
      await load();
    } finally {
      setGenerating(false);
    }
  };

  const monthlyGroups = rows.reduce<Record<string, TeamAttendanceHistoryRow[]>>((acc, r) => {
    const key = r.attendance_date.slice(0, 7);
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  const totalMinutes = rows.reduce((s, r) => s + (r.work_minutes || 0), 0);
  const daysPresent = rows.filter((r) => r.clock_in_at).length;
  const currentMonthReport = monthlyReports.find(
    (r) => r.report_month === month && (scope === 'company' ? !r.department_id : r.department_id === (departmentId || profile.department_id)),
  );

  return (
    <div className="attendance-card">
      <h3 className="attendance-card__title"><History size={18} /> Attendance history</h3>
      <p className="attendance-card__subtitle">
        All check-ins are saved with date and time in Supabase. Download a full month report anytime.
      </p>

      <div className="attendance-history-controls">
        <div className="attendance-history-view-toggle">
          <button
            type="button"
            className={`attendance-tab ${view === 'daily' ? 'attendance-tab--active' : ''}`}
            onClick={() => setView('daily')}
          >
            <Calendar size={14} /> Daily
          </button>
          <button
            type="button"
            className={`attendance-tab ${view === 'monthly' ? 'attendance-tab--active' : ''}`}
            onClick={() => setView('monthly')}
          >
            Monthly
          </button>
        </div>

        {mode === 'manager' && (
          <div className="form-group">
            <label>View</label>
            <select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as HistoryScope);
                if (e.target.value === 'self') setUserId(profile.id);
              }}
            >
              <option value="self">My attendance</option>
              <option value="team">My team (all)</option>
              {profile.department_id && <option value="department">My department</option>}
            </select>
          </div>
        )}

        {mode === 'admin' && (
          <>
            <div className="form-group">
              <label>View</label>
              <select value={scope} onChange={(e) => setScope(e.target.value as HistoryScope)}>
                <option value="company">All departments</option>
                <option value="department">Single department</option>
              </select>
            </div>
            {(scope === 'department' || scope === 'company') && departments.length > 0 && (
              <div className="form-group">
                <label>Department</label>
                <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
                  {scope === 'company' && <option value="">All departments</option>}
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}

        {mode === 'manager' && scope === 'self' && teamMembers.length > 0 && (
          <div className="form-group">
            <label>Employee</label>
            <select value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value={profile.id}>Me ({profile.full_name})</option>
              {teamMembers.filter((m) => m.role === 'employee').map((m) => (
                <option key={m.id} value={m.id}>{m.full_name}</option>
              ))}
            </select>
          </div>
        )}

        <div className="form-group">
          <label>Year</label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year - 1, year, year + 1].map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        {view === 'daily' && (
          <div className="form-group">
            <label>Month</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(year, i, 1).toLocaleString('default', { month: 'long' })}
                </option>
              ))}
            </select>
          </div>
        )}

        <button type="button" className="btn btn-secondary" disabled={exporting || rows.length === 0} onClick={() => void exportCsv()}>
          {exporting ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
          Download {view === 'daily' ? 'month' : 'year'}
        </button>

        {mode !== 'employee' && view === 'daily' && (
          <button type="button" className="btn btn-secondary" disabled={generating} onClick={() => void generateMonthlyReport()}>
            {generating ? <Loader2 size={16} className="spin-icon" /> : <RefreshCw size={16} />}
            Save monthly report
          </button>
        )}
      </div>

      {currentMonthReport && view === 'daily' && (
        <div className="attendance-month-report-badge">
          <FileText size={14} />
          Monthly report saved — {currentMonthReport.record_count} records, {currentMonthReport.employee_count} people
          · {new Date(currentMonthReport.generated_at).toLocaleString()}
        </div>
      )}

      {mode !== 'employee' && monthlyReports.length > 0 && view === 'monthly' && (
        <div className="attendance-monthly-reports-list">
          <h4>Saved monthly reports ({year})</h4>
          <ul>
            {monthlyReports.map((r) => (
              <li key={r.report_id}>
                {new Date(r.report_year, r.report_month - 1, 1).toLocaleString('default', { month: 'long' })}
                {r.department_name ? ` · ${r.department_name}` : ' · All departments'}
                {' — '}{r.record_count} records, {r.employee_count} people
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="attendance-quick-stats" style={{ marginTop: '0.75rem' }}>
        <div className="attendance-stat-pill">
          <div className="attendance-stat-pill__value">{daysPresent}</div>
          <div className="attendance-stat-pill__label">{view === 'daily' ? 'Days this month' : 'Days this year'}</div>
        </div>
        <div className="attendance-stat-pill">
          <div className="attendance-stat-pill__value">{formatWorkDuration(totalMinutes)}</div>
          <div className="attendance-stat-pill__label">Total time logged</div>
        </div>
        {isTeamView && (
          <div className="attendance-stat-pill">
            <div className="attendance-stat-pill__value">{new Set(rows.map((r) => r.user_id)).size}</div>
            <div className="attendance-stat-pill__label">People</div>
          </div>
        )}
      </div>

      {loading ? (
        <div className="rewards-loading"><Loader2 size={24} className="spin-icon" /></div>
      ) : rows.length === 0 ? (
        <p className="attendance-empty">No attendance records for this period.</p>
      ) : view === 'daily' ? (
        <div className="team-points-table-wrap">
          <table className="attendance-history-table attendance-history-table--detailed">
            <thead>
              <tr>
                {showEmployeeColumn && <th>Employee</th>}
                <th>Date</th>
                {showEmployeeColumn && <th>Department</th>}
                <th>Shift</th>
                <th>Clock in</th>
                <th>Clock out</th>
                <th>Duration</th>
                <th>Source</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  {showEmployeeColumn && <td><strong>{r.employee_name}</strong></td>}
                  <td>
                    <strong>{r.attendance_date}</strong>
                  </td>
                  {showEmployeeColumn && <td>{r.department_name || '—'}</td>}
                  <td>{r.shift_name || '—'}</td>
                  <td>{formatDateTime(r.clock_in_at)}</td>
                  <td>{formatDateTime(r.clock_out_at)}</td>
                  <td>{formatWorkDuration(r.work_minutes)}</td>
                  <td>{r.attendance_source === 'geo' ? 'GPS auto' : r.attendance_source || 'Manual'}</td>
                  <td>
                    <span className={`badge ${approvalBadgeClass(r.approval_status as ApprovalStatus)}`}>
                      {APPROVAL_LABEL[r.approval_status as ApprovalStatus]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="attendance-monthly-list">
          {Object.entries(monthlyGroups)
            .sort(([a], [b]) => b.localeCompare(a))
            .map(([ym, monthRows]) => {
              const [y, m] = ym.split('-').map(Number);
              const label = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
              const mins = monthRows.reduce((s, r) => s + (r.work_minutes || 0), 0);
              const present = monthRows.filter((r) => r.clock_in_at).length;
              const report = monthlyReports.find((rep) => rep.report_month === m && rep.report_year === y);
              return (
                <details key={ym} className="attendance-month-block" open={ym === `${year}-${String(month).padStart(2, '0')}`}>
                  <summary>
                    <strong>{label}</strong>
                    <span>{present} days · {formatWorkDuration(mins)} total</span>
                    {report && <span className="attendance-month-report-tag">Report saved</span>}
                  </summary>
                  <table className="attendance-history-table">
                    <thead>
                      <tr>
                        {showEmployeeColumn && <th>Employee</th>}
                        <th>Date</th>
                        <th>In</th>
                        <th>Out</th>
                        <th>Duration</th>
                      </tr>
                    </thead>
                    <tbody>
                      {monthRows.map((r) => (
                        <tr key={r.id}>
                          {showEmployeeColumn && <td>{r.employee_name}</td>}
                          <td>{r.attendance_date}</td>
                          <td>{formatClockTime(r.clock_in_at)}</td>
                          <td>{formatClockTime(r.clock_out_at)}</td>
                          <td>{formatWorkDuration(r.work_minutes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              );
            })}
        </div>
      )}
    </div>
  );
}
