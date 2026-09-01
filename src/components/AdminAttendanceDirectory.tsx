import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  Building2,
  Calendar,
  ChevronRight,
  Download,
  History,
  Loader2,
  Users,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { TeamAttendanceHistoryRow, formatWorkDuration, describeAttendanceHistory } from '../utils/shiftHelpers';
import { APPROVAL_LABEL, approvalBadgeClass, ApprovalStatus, ATTENDANCE_STATUS_LABEL, attendanceStatusBadgeClass } from '../utils/attendanceHelpers';
import { downloadAttendanceCsv, downloadTeamAttendanceCsv } from '../utils/exportAttendance';
import { AttendanceBrowseView, attendanceYearOptions, historyMonthParam } from '../utils/attendancePeriod';
import AttendanceMonthWiseList from './AttendanceMonthWiseList';
import '../styles/admin-attendance.css';

interface AdminAttendanceDirectoryProps {
  departments: Department[];
  initialUserId?: string;
}

interface EmployeeGroup {
  user: Profile;
  rows: TeamAttendanceHistoryRow[];
}

type ViewStep = 'departments' | 'employees' | 'history';

const UNASSIGNED_KEY = '__unassigned__';

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() || '')
    .join('');
}

function roleLabel(role: string): string {
  if (role === 'manager') return 'Manager';
  if (role === 'admin') return 'Admin';
  if (role === 'hr') return 'HR';
  return 'Employee';
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

function resolveInitialNav(
  initialUserId: string | undefined,
  employees: Profile[],
): { step: ViewStep; deptId: string | null; userId: string | null } {
  if (!initialUserId) {
    return { step: 'departments', deptId: null, userId: null };
  }
  const user = employees.find((e) => e.id === initialUserId);
  if (!user) {
    return { step: 'departments', deptId: null, userId: null };
  }
  return {
    step: 'history',
    deptId: user.department_id || UNASSIGNED_KEY,
    userId: user.id,
  };
}

export default function AdminAttendanceDirectory({ departments, initialUserId }: AdminAttendanceDirectoryProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [browsePeriod, setBrowsePeriod] = useState<AttendanceBrowseView>('month');
  const [employees, setEmployees] = useState<Profile[]>([]);
  const [rows, setRows] = useState<TeamAttendanceHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [viewStep, setViewStep] = useState<ViewStep>('departments');
  const [selectedDeptId, setSelectedDeptId] = useState<string | null>(null);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  const yearOptions = attendanceYearOptions(null, now, 8);
  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const yearLabel = String(year);
  const periodLabel = browsePeriod === 'month' ? monthLabel : yearLabel;

  const load = useCallback(async () => {
    setLoading(true);
    const { data: users, error: usersErr } = await supabase.rpc('get_all_users_admin');
    if (usersErr) {
      setEmployees([]);
      setRows([]);
      setLoading(false);
      return;
    }

    const orgEmployees = ((users || []) as Profile[]).filter((u) => !u.is_demo && u.role !== 'admin');
    setEmployees(orgEmployees);

    const { data, error } = await supabase.rpc('get_team_attendance_history', {
      p_year: year,
      p_month: historyMonthParam(browsePeriod, month),
      p_user_id: null,
      p_department_id: null,
      p_scope: 'company',
    });

    const allRows = !error ? ((data || []) as TeamAttendanceHistoryRow[]) : [];
    const allowedIds = new Set(orgEmployees.map((u) => u.id));
    setRows(allRows.filter((r) => allowedIds.has(r.user_id)));
    setLoading(false);
  }, [year, month, browsePeriod]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (employees.length === 0) return;
    const nav = resolveInitialNav(initialUserId, employees);
    setViewStep(nav.step);
    setSelectedDeptId(nav.deptId);
    setSelectedUserId(nav.userId);
  }, [initialUserId, employees]);

  const departmentSections = useMemo(() => {
    const deptMap = new Map<string, { dept: Department | null; employees: Profile[] }>();

    for (const emp of employees) {
      const key = emp.department_id || UNASSIGNED_KEY;
      if (!deptMap.has(key)) {
        const dept = departments.find((d) => d.id === emp.department_id) || null;
        deptMap.set(key, { dept, employees: [] });
      }
      deptMap.get(key)!.employees.push(emp);
    }

    const sections: { deptId: string; deptName: string; groups: EmployeeGroup[] }[] = [];

    for (const [key, { dept, employees: emps }] of deptMap) {
      const sorted = [...emps].sort((a, b) => a.full_name.localeCompare(b.full_name));
      const groups: EmployeeGroup[] = sorted.map((user) => ({
        user,
        rows: rows
          .filter((r) => r.user_id === user.id)
          .sort((a, b) => b.attendance_date.localeCompare(a.attendance_date)),
      }));

      sections.push({
        deptId: key,
        deptName: dept?.name || (key === UNASSIGNED_KEY ? 'Unassigned' : 'Department'),
        groups,
      });
    }

    return sections.sort((a, b) => {
      if (a.deptName === 'Unassigned') return 1;
      if (b.deptName === 'Unassigned') return -1;
      return a.deptName.localeCompare(b.deptName);
    });
  }, [employees, departments, rows]);

  const selectedSection = useMemo(
    () => departmentSections.find((s) => s.deptId === selectedDeptId) || null,
    [departmentSections, selectedDeptId],
  );

  const selectedGroup = useMemo(() => {
    if (!selectedUserId || !selectedSection) return null;
    return selectedSection.groups.find((g) => g.user.id === selectedUserId) || null;
  }, [selectedSection, selectedUserId]);

  const totalEmployees = departmentSections.reduce((n, s) => n + s.groups.length, 0);
  const totalRecords = rows.length;
  const totalPresent = rows.filter((r) => r.clock_in_at).length;

  const exportEmployee = async (group: EmployeeGroup) => {
    setExporting(group.user.id);
    try {
      downloadAttendanceCsv(
        group.rows.map(mapRowToRecord),
        group.user.full_name,
        periodLabel,
      );
    } finally {
      setExporting(null);
    }
  };

  const exportDepartment = async (section: { deptName: string; groups: EmployeeGroup[] }) => {
    setExporting(section.deptName);
    try {
      const deptRows = section.groups.flatMap((g) => g.rows);
      downloadTeamAttendanceCsv(deptRows, `${section.deptName}-${periodLabel}`);
    } finally {
      setExporting(null);
    }
  };

  const exportAll = async () => {
    setExporting('__all__');
    try {
      downloadTeamAttendanceCsv(rows, periodLabel);
    } finally {
      setExporting(null);
    }
  };

  const openDepartment = (deptId: string) => {
    setSelectedDeptId(deptId);
    setSelectedUserId(null);
    setViewStep('employees');
  };

  const openEmployee = (userId: string) => {
    setSelectedUserId(userId);
    setViewStep('history');
  };

  const backToDepartments = () => {
    setViewStep('departments');
    setSelectedDeptId(null);
    setSelectedUserId(null);
  };

  const backToEmployees = () => {
    setViewStep('employees');
    setSelectedUserId(null);
  };

  const renderHistoryTable = (group: EmployeeGroup) => {
    if (browsePeriod === 'monthwise') {
      return <AttendanceMonthWiseList rows={group.rows} year={year} />;
    }
    if (group.rows.length === 0) {
      return (
        <p className="attendance-empty" style={{ padding: '1rem 0' }}>
          No attendance records for {periodLabel}.
        </p>
      );
    }
    return (
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
            {group.rows.map((r) => {
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
    );
  };

  const renderEmployeeRow = (group: EmployeeGroup, onSelect: () => void) => {
    const daysPresent = group.rows.filter((r) => r.clock_in_at).length;
    const totalMins = group.rows.reduce((s, r) => s + (r.work_minutes || 0), 0);

    return (
      <article key={group.user.id} className="admin-attendance-employee">
        <button
          type="button"
          className="admin-attendance-employee__toggle"
          onClick={onSelect}
        >
          <span className="admin-attendance-employee__avatar">{initials(group.user.full_name)}</span>
          <span className="admin-attendance-employee__info">
            <span className="admin-attendance-employee__name-row">
              <strong>{group.user.full_name}</strong>
              <span className={`admin-attendance-employee__role admin-attendance-employee__role--${group.user.role}`}>
                {roleLabel(group.user.role)}
              </span>
            </span>
            <span className="admin-attendance-employee__email">{group.user.email}</span>
            <span className="admin-attendance-employee__stats">
              <span className="admin-attendance-employee__stat">
                {daysPresent} day{daysPresent !== 1 ? 's' : ''}
              </span>
              <span className="admin-attendance-employee__stat">
                {formatWorkDuration(totalMins)} logged
              </span>
              <span className="admin-attendance-employee__stat">
                {group.rows.length} record{group.rows.length !== 1 ? 's' : ''}
              </span>
            </span>
          </span>
          <ChevronRight size={18} className="admin-attendance-employee__chev" />
        </button>
      </article>
    );
  };

  return (
    <section className="admin-attendance-card glass-panel">
      <h3>
        <History size={18} /> Attendance history
      </h3>
      <p>
        Choose a department, then an employee, to view their attendance day by day, month by month, or for the full year.
        Download records for one person, a department, or everyone.
      </p>

      <div className="admin-attendance-info">
        <Calendar size={16} />
        <span>Company employees only — demo sandbox accounts are excluded.</span>
      </div>

      <div className="admin-attendance-filters">
        <div className="form-group">
          <label htmlFor="att-browse">Show</label>
          <select
            id="att-browse"
            value={browsePeriod}
            onChange={(e) => setBrowsePeriod(e.target.value as AttendanceBrowseView)}
          >
            <option value="month">This month (daily)</option>
            <option value="monthwise">Month by month</option>
            <option value="year">Full year</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="att-year">Year</label>
          <select id="att-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {yearOptions.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
        {browsePeriod === 'month' && (
          <div className="form-group">
            <label htmlFor="att-month">Month</label>
            <select id="att-month" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(year, i, 1).toLocaleString('default', { month: 'long' })}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="admin-attendance-filters__actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={exporting !== null || rows.length === 0}
            onClick={() => void exportAll()}
          >
            {exporting === '__all__' ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
            Download all
          </button>
        </div>
      </div>

      {viewStep === 'departments' && (
        <div className="admin-attendance-stats" style={{ marginBottom: '1rem' }}>
          <div className="admin-attendance-stat">
            <Users size={16} />
            <span className="admin-attendance-stat__label">Employees</span>
            <strong>{totalEmployees}</strong>
          </div>
          <div className="admin-attendance-stat">
            <Calendar size={16} />
            <span className="admin-attendance-stat__label">Records ({periodLabel})</span>
            <strong>{totalRecords}</strong>
          </div>
          <div className="admin-attendance-stat">
            <History size={16} />
            <span className="admin-attendance-stat__label">Days with check-in</span>
            <strong>{totalPresent}</strong>
          </div>
        </div>
      )}

      {loading ? (
        <div className="admin-attendance-loading">
          <Loader2 size={28} className="spin-icon" />
          <span>Loading attendance history…</span>
        </div>
      ) : viewStep === 'departments' ? (
        departmentSections.length === 0 ? (
          <div className="admin-attendance-empty">
            <Users size={40} strokeWidth={1.25} />
            <h4>No employees found</h4>
            <p>Add employees under <strong>Users</strong> and assign them to departments.</p>
          </div>
        ) : (
          <div className="admin-attendance-dept-grid">
            {departmentSections.map((section) => {
              const deptRecords = section.groups.reduce((n, g) => n + g.rows.length, 0);
              const deptPresent = section.groups.reduce(
                (n, g) => n + g.rows.filter((r) => r.clock_in_at).length,
                0,
              );

              return (
                <button
                  key={section.deptId}
                  type="button"
                  className="admin-attendance-dept-card"
                  onClick={() => openDepartment(section.deptId)}
                >
                  <span className="admin-attendance-dept-card__icon">
                    <Building2 size={20} />
                  </span>
                  <span className="admin-attendance-dept-card__body">
                    <strong>{section.deptName}</strong>
                    <span className="admin-attendance-dept-card__meta">
                      {section.groups.length} employee{section.groups.length !== 1 ? 's' : ''}
                      {' · '}
                      {deptRecords} record{deptRecords !== 1 ? 's' : ''}
                      {' · '}
                      {deptPresent} check-in{deptPresent !== 1 ? 's' : ''}
                    </span>
                  </span>
                  <ChevronRight size={18} className="admin-attendance-dept-card__chev" />
                </button>
              );
            })}
          </div>
        )
      ) : viewStep === 'employees' && selectedSection ? (
        <>
          <div className="admin-attendance-nav">
            <button type="button" className="admin-attendance-back" onClick={backToDepartments}>
              <ArrowLeft size={16} />
              Back to departments
            </button>
          </div>

          <div className="admin-attendance-dept-section">
            <div className="admin-attendance-dept-section__head">
              <h4>
                <Building2 size={16} />
                {selectedSection.deptName}
                <span className="admin-attendance-dept-section__meta">
                  {selectedSection.groups.length} employee{selectedSection.groups.length !== 1 ? 's' : ''}
                </span>
              </h4>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={exporting !== null || selectedSection.groups.every((g) => g.rows.length === 0)}
                onClick={() => void exportDepartment(selectedSection)}
              >
                {exporting === selectedSection.deptName ? (
                  <Loader2 size={14} className="spin-icon" />
                ) : (
                  <Download size={14} />
                )}
                Download department
              </button>
            </div>

            <p className="admin-attendance-step-hint">Select an employee to view their attendance history.</p>

            <div className="admin-attendance-employee-list">
              {selectedSection.groups.map((group) =>
                renderEmployeeRow(group, () => openEmployee(group.user.id)),
              )}
            </div>
          </div>
        </>
      ) : viewStep === 'history' && selectedGroup && selectedSection ? (
        <>
          <div className="admin-attendance-nav">
            <button type="button" className="admin-attendance-back" onClick={backToEmployees}>
              <ArrowLeft size={16} />
              Back to {selectedSection.deptName}
            </button>
          </div>

          <div className="admin-attendance-employee admin-attendance-employee--detail">
            <div className="admin-attendance-employee__header">
              <span className="admin-attendance-employee__avatar admin-attendance-employee__avatar--lg">
                {initials(selectedGroup.user.full_name)}
              </span>
              <div className="admin-attendance-employee__info">
                <span className="admin-attendance-employee__name-row">
                  <strong>{selectedGroup.user.full_name}</strong>
                  <span className={`admin-attendance-employee__role admin-attendance-employee__role--${selectedGroup.user.role}`}>
                    {roleLabel(selectedGroup.user.role)}
                  </span>
                </span>
                <span className="admin-attendance-employee__email">{selectedGroup.user.email}</span>
                <span className="admin-attendance-employee__dept">
                  <Building2 size={14} />
                  {selectedSection.deptName}
                </span>
              </div>
            </div>

            <div className="admin-attendance-employee__body admin-attendance-employee__body--detail">
              <div className="admin-attendance-employee__toolbar">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  disabled={exporting !== null || selectedGroup.rows.length === 0}
                  onClick={() => void exportEmployee(selectedGroup)}
                >
                  {exporting === selectedGroup.user.id ? (
                    <Loader2 size={14} className="spin-icon" />
                  ) : (
                    <Download size={14} />
                  )}
                  Download CSV
                </button>
              </div>
              {renderHistoryTable(selectedGroup)}
            </div>
          </div>
        </>
      ) : (
        <div className="admin-attendance-empty">
          <Users size={40} strokeWidth={1.25} />
          <h4>Nothing to show</h4>
          <p>
            <button type="button" className="admin-attendance-back admin-attendance-back--inline" onClick={backToDepartments}>
              <ArrowLeft size={14} />
              Back to departments
            </button>
          </p>
        </div>
      )}
    </section>
  );
}
