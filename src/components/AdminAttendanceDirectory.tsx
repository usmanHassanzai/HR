import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Calendar,
  ChevronDown,
  Download,
  History,
  Loader2,
  Users,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { TeamAttendanceHistoryRow, formatDateTime, formatWorkDuration } from '../utils/shiftHelpers';
import { APPROVAL_LABEL, approvalBadgeClass, ApprovalStatus } from '../utils/attendanceHelpers';
import { downloadAttendanceCsv, downloadTeamAttendanceCsv } from '../utils/exportAttendance';
import '../styles/admin-attendance.css';

interface AdminAttendanceDirectoryProps {
  departments: Department[];
}

interface EmployeeGroup {
  user: Profile;
  rows: TeamAttendanceHistoryRow[];
}

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

export default function AdminAttendanceDirectory({ departments }: AdminAttendanceDirectoryProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [departmentId, setDepartmentId] = useState('');
  const [employees, setEmployees] = useState<Profile[]>([]);
  const [rows, setRows] = useState<TeamAttendanceHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

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

    const deptFilter = departmentId || null;
    const { data, error } = await supabase.rpc('get_team_attendance_history', {
      p_year: year,
      p_month: month,
      p_user_id: null,
      p_department_id: deptFilter,
      p_scope: deptFilter ? 'department' : 'company',
    });

    const allRows = !error ? ((data || []) as TeamAttendanceHistoryRow[]) : [];
    const allowedIds = new Set(orgEmployees.map((u) => u.id));
    setRows(allRows.filter((r) => allowedIds.has(r.user_id)));
    setLoading(false);
  }, [year, month, departmentId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (departments[0] && !departmentId) {
      setDepartmentId('');
    }
  }, [departments, departmentId]);

  const departmentSections = useMemo(() => {
    const deptMap = new Map<string, { dept: Department | null; employees: Profile[] }>();

    const relevantEmployees = departmentId
      ? employees.filter((e) => e.department_id === departmentId)
      : employees;

    for (const emp of relevantEmployees) {
      const key = emp.department_id || '__unassigned__';
      if (!deptMap.has(key)) {
        const dept = departments.find((d) => d.id === emp.department_id) || null;
        deptMap.set(key, { dept, employees: [] });
      }
      deptMap.get(key)!.employees.push(emp);
    }

    if (departmentId) {
      const dept = departments.find((d) => d.id === departmentId);
      const key = departmentId;
      if (!deptMap.has(key)) {
        deptMap.set(key, { dept: dept || null, employees: [] });
      }
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
        deptName: dept?.name || (key === '__unassigned__' ? 'Unassigned' : 'Department'),
        groups,
      });
    }

    return sections.sort((a, b) => {
      if (a.deptName === 'Unassigned') return 1;
      if (b.deptName === 'Unassigned') return -1;
      return a.deptName.localeCompare(b.deptName);
    });
  }, [employees, departments, departmentId, rows]);

  const totalEmployees = departmentSections.reduce((n, s) => n + s.groups.length, 0);
  const totalRecords = rows.length;
  const totalPresent = rows.filter((r) => r.clock_in_at).length;

  const exportEmployee = async (group: EmployeeGroup) => {
    setExporting(group.user.id);
    try {
      downloadAttendanceCsv(
        group.rows.map(mapRowToRecord),
        group.user.full_name,
        monthLabel,
      );
    } finally {
      setExporting(null);
    }
  };

  const exportDepartment = async (section: { deptName: string; groups: EmployeeGroup[] }) => {
    setExporting(section.deptName);
    try {
      const deptRows = section.groups.flatMap((g) => g.rows);
      downloadTeamAttendanceCsv(deptRows, `${section.deptName}-${monthLabel}`);
    } finally {
      setExporting(null);
    }
  };

  const exportAll = async () => {
    setExporting('__all__');
    try {
      downloadTeamAttendanceCsv(rows, monthLabel);
    } finally {
      setExporting(null);
    }
  };

  const toggleEmployee = (id: string) => {
    setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  return (
    <section className="admin-attendance-card glass-panel">
      <h3>
        <History size={18} /> Attendance by employee
      </h3>
      <p>
        Browse each employee&apos;s check-in history inside their department. Every record includes date, clock-in
        time, and approval status — download individually or by department.
      </p>

      <div className="admin-attendance-info">
        <Calendar size={16} />
        <span>Company employees only — demo sandbox accounts are excluded.</span>
      </div>

      <div className="admin-attendance-filters">
        <div className="form-group">
          <label htmlFor="att-dept-filter">Department</label>
          <select id="att-dept-filter" value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}>
            <option value="">All departments</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="att-year">Year</label>
          <select id="att-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year - 1, year, year + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
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

      <div className="admin-attendance-stats" style={{ marginBottom: '1rem' }}>
        <div className="admin-attendance-stat">
          <Users size={16} />
          <span className="admin-attendance-stat__label">Employees</span>
          <strong>{totalEmployees}</strong>
        </div>
        <div className="admin-attendance-stat">
          <Calendar size={16} />
          <span className="admin-attendance-stat__label">Records ({monthLabel})</span>
          <strong>{totalRecords}</strong>
        </div>
        <div className="admin-attendance-stat">
          <History size={16} />
          <span className="admin-attendance-stat__label">Days with check-in</span>
          <strong>{totalPresent}</strong>
        </div>
      </div>

      {loading ? (
        <div className="admin-attendance-loading">
          <Loader2 size={28} className="spin-icon" />
          <span>Loading attendance history…</span>
        </div>
      ) : departmentSections.length === 0 ? (
        <div className="admin-attendance-empty">
          <Users size={40} strokeWidth={1.25} />
          <h4>No employees found</h4>
          <p>Add employees under <strong>Users</strong> and assign them to departments.</p>
        </div>
      ) : (
        departmentSections.map((section) => (
          <div key={section.deptId} className="admin-attendance-dept-section">
            <div className="admin-attendance-dept-section__head">
              <h4>
                <Building2 size={16} />
                {section.deptName}
                <span className="admin-attendance-dept-section__meta">
                  {section.groups.length} employee{section.groups.length !== 1 ? 's' : ''}
                </span>
              </h4>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={exporting !== null || section.groups.every((g) => g.rows.length === 0)}
                onClick={() => void exportDepartment(section)}
              >
                {exporting === section.deptName ? (
                  <Loader2 size={14} className="spin-icon" />
                ) : (
                  <Download size={14} />
                )}
                Download department
              </button>
            </div>

            <div className="admin-attendance-employee-list">
              {section.groups.map((group) => {
                const isOpen = expanded[group.user.id] ?? false;
                const daysPresent = group.rows.filter((r) => r.clock_in_at).length;
                const totalMins = group.rows.reduce((s, r) => s + (r.work_minutes || 0), 0);

                return (
                  <article key={group.user.id} className="admin-attendance-employee">
                    <button
                      type="button"
                      className="admin-attendance-employee__toggle"
                      onClick={() => toggleEmployee(group.user.id)}
                      aria-expanded={isOpen}
                    >
                      <span className="admin-attendance-employee__avatar">{initials(group.user.full_name)}</span>
                      <span className="admin-attendance-employee__info">
                        <strong>{group.user.full_name}</strong>
                        <span>{group.user.role} · {group.user.email}</span>
                      </span>
                      <span className="admin-attendance-employee__stats">
                        <span>{daysPresent} day{daysPresent !== 1 ? 's' : ''}</span>
                        <span>{formatWorkDuration(totalMins)} logged</span>
                        <span>{group.rows.length} record{group.rows.length !== 1 ? 's' : ''}</span>
                      </span>
                      <ChevronDown
                        size={18}
                        className={`admin-attendance-employee__chev${isOpen ? ' admin-attendance-employee__chev--open' : ''}`}
                      />
                    </button>

                    {isOpen && (
                      <div className="admin-attendance-employee__body">
                        <div className="admin-attendance-employee__toolbar">
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            disabled={exporting !== null || group.rows.length === 0}
                            onClick={() => void exportEmployee(group)}
                          >
                            {exporting === group.user.id ? (
                              <Loader2 size={14} className="spin-icon" />
                            ) : (
                              <Download size={14} />
                            )}
                            Download {group.user.full_name.split(' ')[0]}&apos;s CSV
                          </button>
                        </div>

                        {group.rows.length === 0 ? (
                          <p className="attendance-empty" style={{ padding: '1rem 0' }}>
                            No attendance records for {monthLabel}.
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
          </div>
        ))
      )}
    </section>
  );
}
