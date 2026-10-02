import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Search,
  Users,
  Briefcase,
  FileText,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Clock,
  RefreshCw,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import {
  AdminDailyWorkReport,
  DailyReportDeptSummary,
  fetchAdminDailyReportDateCounts,
  fetchAdminDailyReportDeptSummary,
  fetchAdminDailyWorkReports,
  formatReportDate,
  formatReportTime,
  parseIsoDate,
  todayIsoDate,
} from '../utils/dailyWorkReportHelpers';
import ReportDateCalendar from './ReportDateCalendar';
import '../styles/daily-work-reports.css';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';

type RoleTab = 'managers' | 'employees' | 'hr' | 'both';
type DeptSelection = 'all' | 'unassigned' | 'hr' | string;

const HR_DEPT_LABEL = 'Human Resources';
const NO_DEPT_LABEL = 'No department';

interface StaffRow {
  user_id: string;
  full_name: string;
  email: string;
  role: 'manager' | 'employee' | 'hr';
  department_id: string | null;
  department_name: string;
  report: AdminDailyWorkReport | null;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

interface AdminDailyWorkReportsProps {
  initialSearch?: string;
  initialDeptId?: string;
  /** HR organization review: softer chrome, no duplicate page title. */
  variant?: 'admin' | 'hr';
}

export default function AdminDailyWorkReports({
  initialSearch = '',
  initialDeptId = 'all',
  variant = 'admin',
}: AdminDailyWorkReportsProps = {}) {
  const today = todayIsoDate();
  const [reportDate, setReportDate] = useState(today);
  const [selectedDeptId, setSelectedDeptId] = useState<DeptSelection>(initialDeptId || 'all');
  const [roleTab, setRoleTab] = useState<RoleTab>('both');
  const [search, setSearch] = useState(initialSearch || '');
  const [searchDebounced, setSearchDebounced] = useState(() => (initialSearch || '').trim().toLowerCase());
  const [summary, setSummary] = useState<DailyReportDeptSummary[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [reports, setReports] = useState<AdminDailyWorkReport[]>([]);
  const [reportCountsByDate, setReportCountsByDate] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    if (initialSearch) {
      setSearch(initialSearch);
      setSearchDebounced(initialSearch.trim().toLowerCase());
    }
  }, [initialSearch]);

  useEffect(() => {
    if (initialDeptId) {
      setSelectedDeptId(initialDeptId);
    }
  }, [initialDeptId]);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim().toLowerCase()), 280);
    return () => clearTimeout(t);
  }, [search]);

  const calendarMonth = useMemo(() => {
    const d = parseIsoDate(reportDate);
    return { year: d.getFullYear(), month: d.getMonth() };
  }, [reportDate]);

  const loadCalendarCounts = useCallback(async (year: number, month: number) => {
    try {
      const counts = await fetchAdminDailyReportDateCounts(year, month);
      setReportCountsByDate(counts);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    void loadCalendarCounts(calendarMonth.year, calendarMonth.month);
  }, [calendarMonth.year, calendarMonth.month, loadCalendarCounts]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [summaryRows, reportRows, usersRes, deptsRes] = await Promise.all([
        fetchAdminDailyReportDeptSummary(reportDate),
        fetchAdminDailyWorkReports({ reportDate }),
        supabase.rpc('get_all_users_admin'),
        supabase.rpc('get_departments'),
      ]);

      if (usersRes.error) throw usersRes.error;
      if (deptsRes.error) throw deptsRes.error;

      setSummary(summaryRows);
      setReports(reportRows);
      setUsers(((usersRes.data as Profile[]) || []).filter(
        (u) => u.role === 'manager' || u.role === 'employee' || u.role === 'hr',
      ));
      setDepartments((deptsRes.data as Department[]) || []);
      void loadCalendarCounts(calendarMonth.year, calendarMonth.month);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to load daily reports');
    } finally {
      setLoading(false);
    }
  }, [reportDate, calendarMonth.year, calendarMonth.month, loadCalendarCounts]);

  useEffect(() => {
    void load();
  }, [load]);

  useSupabaseRealtime(
    'admin-daily-work-reports',
    [{ table: 'daily_work_reports' }, { table: 'notifications' }],
    () => { void load({ silent: true }); },
  );

  const deptName = useCallback(
    (id: string | null | undefined, role?: string) => {
      if (role === 'hr' && !id) return HR_DEPT_LABEL;
      if (!id) return NO_DEPT_LABEL;
      return departments.find((d) => d.id === id)?.name
        ?? summary.find((s) => s.department_id === id)?.department_name
        ?? NO_DEPT_LABEL;
    },
    [departments, summary],
  );

  const hasUnassignedStaff = useMemo(
    () => users.some((u) => !u.department_id && u.role !== 'hr'),
    [users],
  );
  const hasHrStaff = useMemo(
    () => users.some((u) => u.role === 'hr'),
    [users],
  );

  const reportByUser = useMemo(() => {
    const map = new Map<string, AdminDailyWorkReport>();
    for (const r of reports) map.set(r.user_id, r);
    return map;
  }, [reports]);

  const staffRows: StaffRow[] = useMemo(() => {
    return users.map((u) => ({
      user_id: u.id,
      full_name: u.full_name,
      email: u.email,
      role: u.role as 'manager' | 'employee' | 'hr',
      department_id: u.department_id ?? null,
      department_name: deptName(u.department_id, u.role),
      report: reportByUser.get(u.id) ?? null,
    }));
  }, [users, reportByUser, deptName]);

  const scopedRows = useMemo(() => {
    let rows = staffRows;

    if (selectedDeptId === 'hr') {
      rows = rows.filter((r) => r.role === 'hr');
    } else if (selectedDeptId === 'unassigned') {
      rows = rows.filter((r) => !r.department_id && r.role !== 'hr');
    } else if (selectedDeptId !== 'all') {
      rows = rows.filter((r) => r.department_id === selectedDeptId);
    }

    if (searchDebounced) {
      rows = rows.filter((r) => {
        const hay = `${r.full_name} ${r.email} ${r.department_name} ${r.report?.content ?? ''}`.toLowerCase();
        return hay.includes(searchDebounced);
      });
    }

    return rows.sort((a, b) => {
      const rank = (r: StaffRow['role']) => (r === 'manager' ? 0 : r === 'hr' ? 1 : 2);
      if (a.role !== b.role) return rank(a.role) - rank(b.role);
      return a.full_name.localeCompare(b.full_name);
    });
  }, [staffRows, selectedDeptId, searchDebounced]);

  const managers = scopedRows.filter((r) => r.role === 'manager');
  const employees = scopedRows.filter((r) => r.role === 'employee');
  const hrStaff = scopedRows.filter((r) => r.role === 'hr');
  const visibleManagers = roleTab === 'employees' || roleTab === 'hr' ? [] : managers;
  const visibleEmployees = roleTab === 'managers' || roleTab === 'hr' ? [] : employees;
  const visibleHr = roleTab === 'managers' || roleTab === 'employees' ? [] : hrStaff;

  const totals = useMemo(() => {
    const submitted = scopedRows.filter((r) => r.report).length;
    return {
      staff: scopedRows.length,
      submitted,
      missing: Math.max(scopedRows.length - submitted, 0),
      managers: managers.length,
      employees: employees.length,
      hr: hrStaff.length,
    };
  }, [scopedRows, managers.length, employees.length, hrStaff.length]);

  const selectedDeptLabel = useMemo(() => {
    if (selectedDeptId === 'all') return 'All departments';
    if (selectedDeptId === 'unassigned') return NO_DEPT_LABEL;
    if (selectedDeptId === 'hr') return HR_DEPT_LABEL;
    return deptName(selectedDeptId);
  }, [selectedDeptId, deptName]);

  const deptOptionMeta = useCallback(
    (deptId: string | null | 'hr') => {
      if (deptId === 'hr') {
        const hrUsers = users.filter((u) => u.role === 'hr');
        const submitted = hrUsers.filter((u) => reportByUser.has(u.id)).length;
        return ` — ${submitted}/${hrUsers.length} submitted`;
      }
      const row = summary.find((s) =>
        deptId === null ? !s.department_id : s.department_id === deptId,
      );
      if (!row) return '';
      return ` — ${row.submitted_count}/${row.total_staff} submitted`;
    },
    [summary, users, reportByUser],
  );

  return (
    <div className={`dwr-admin animate-fade-in${variant === 'hr' ? ' dwr-admin--hr' : ''}`}>
      <div className="dwr-admin__hero">
        <div>
          <span className="dash-eyebrow">
            {variant === 'hr' ? 'Company-wide review' : 'Saved daily in database'}
          </span>
          <h2>{variant === 'hr' ? 'Manager & employee reports' : 'Daily work reports'}</h2>
          <p>
            {variant === 'hr'
              ? 'Pick a date and department to review submitted work logs from managers and employees. Your own report is under My report.'
              : 'Select a date on the calendar, then filter by department to review every manager and employee daily report for that day. HR submissions appear under Human Resources.'}
          </p>
        </div>
        <button type="button" className="btn btn-secondary" onClick={() => void load()}>
          <RefreshCw size={15} /> Refresh
        </button>
      </div>

      <div className="dwr-admin__stats">
        <div className="dwr-stat-card">
          <Users size={18} />
          <div>
            <strong>{totals.staff}</strong>
            <span>Staff listed</span>
          </div>
        </div>
        <div className="dwr-stat-card dwr-stat-card--ok">
          <CheckCircle2 size={18} />
          <div>
            <strong>{totals.submitted}</strong>
            <span>Submitted</span>
          </div>
        </div>
        <div className="dwr-stat-card dwr-stat-card--warn">
          <AlertCircle size={18} />
          <div>
            <strong>{totals.missing}</strong>
            <span>Not submitted</span>
          </div>
        </div>
        <div className="dwr-stat-card">
          <Briefcase size={18} />
          <div>
            <strong>{totals.managers}/{totals.employees}{totals.hr > 0 ? `/${totals.hr}` : ''}</strong>
            <span>Mgr / Emp{totals.hr > 0 ? ' / HR' : ''}</span>
          </div>
        </div>
      </div>

      <div className="dwr-admin__layout">
        <aside className="dwr-cal-rail">
          <ReportDateCalendar
            selectedDate={reportDate}
            maxDate={today}
            reportCountsByDate={reportCountsByDate}
            onSelectDate={setReportDate}
          />
        </aside>

        <div className="dwr-admin__content">
      <div className="dwr-admin__toolbar glass-panel">
        <label className="dwr-toolbar-field dwr-toolbar-field--dept">
          <Building2 size={14} />
          <span>Department</span>
          <select
            value={selectedDeptId}
            onChange={(e) => setSelectedDeptId(e.target.value as DeptSelection)}
            aria-label="Select department"
          >
            <option value="all">All departments</option>
            {departments
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((dept) => (
                <option key={dept.id} value={dept.id}>
                  {dept.name}{deptOptionMeta(dept.id)}
                </option>
              ))}
            {hasHrStaff && (
              <option value="hr">{HR_DEPT_LABEL}{deptOptionMeta('hr')}</option>
            )}
            {hasUnassignedStaff && (
              <option value="unassigned">{NO_DEPT_LABEL}{deptOptionMeta(null)}</option>
            )}
          </select>
        </label>

        <label className="dwr-toolbar-field dwr-toolbar-field--grow">
          <Search size={14} />
          <span>Search</span>
          <input
            type="search"
            placeholder="Name, email, or report text…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
      </div>

      <div className="dwr-role-tabs" role="tablist" aria-label="Role filter">
        <button
          type="button"
          className={`dwr-role-tabs__btn ${roleTab === 'both' ? 'dwr-role-tabs__btn--active' : ''}`}
          onClick={() => setRoleTab('both')}
        >
          All roles
        </button>
        <button
          type="button"
          className={`dwr-role-tabs__btn ${roleTab === 'managers' ? 'dwr-role-tabs__btn--active' : ''}`}
          onClick={() => setRoleTab('managers')}
        >
          <Briefcase size={14} /> Managers
        </button>
        <button
          type="button"
          className={`dwr-role-tabs__btn ${roleTab === 'employees' ? 'dwr-role-tabs__btn--active' : ''}`}
          onClick={() => setRoleTab('employees')}
        >
          <Users size={14} /> Employees
        </button>
        <button
          type="button"
          className={`dwr-role-tabs__btn ${roleTab === 'hr' ? 'dwr-role-tabs__btn--active' : ''}`}
          onClick={() => setRoleTab('hr')}
        >
          <FileText size={14} /> HR
        </button>
      </div>

      {error && (
        <div className="dwr-alert dwr-alert--error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <section className="dwr-admin__main glass-panel">
        <div className="dwr-admin__main-head">
          <div>
            <h3>{selectedDeptLabel} — daily report</h3>
            <p>
              {formatReportDate(reportDate)} · {totals.submitted} submitted / {totals.staff} staff
              {selectedDeptId !== 'all' ? ' in this department' : ' across all departments'}
            </p>
          </div>
        </div>

        {loading ? (
          <div className="dwr-empty">
            <Loader2 size={22} className="spin-icon" /> Loading reports…
          </div>
        ) : scopedRows.length === 0 ? (
          <div className="dwr-empty">
            <FileText size={32} />
            <p>No staff found for this department</p>
            <span>Pick another department from the dropdown, or clear search.</span>
          </div>
        ) : (
          <div className="dwr-admin__sections">
            {(roleTab === 'both' || roleTab === 'managers') && (
              <div className="dwr-role-section">
                <div className="dwr-role-section__label dwr-role-section__label--manager">
                  <Briefcase size={14} /> Managers ({visibleManagers.length})
                  <span className="dwr-role-section__hint">
                    {visibleManagers.filter((r) => r.report).length} submitted
                  </span>
                </div>
                {visibleManagers.length === 0 ? (
                  <div className="dwr-empty dwr-empty--compact">
                    <p>No managers in this department.</p>
                  </div>
                ) : (
                  <div className="dwr-report-grid">
                    {visibleManagers.map((row) => (
                      <StaffReportCard
                        key={row.user_id}
                        row={row}
                        expanded={expandedId === row.user_id}
                        onToggle={() =>
                          setExpandedId((id) => (id === row.user_id ? null : row.user_id))
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {(roleTab === 'both' || roleTab === 'employees') && (
              <div className="dwr-role-section">
                <div className="dwr-role-section__label dwr-role-section__label--employee">
                  <Users size={14} /> Employees ({visibleEmployees.length})
                  <span className="dwr-role-section__hint">
                    {visibleEmployees.filter((r) => r.report).length} submitted
                  </span>
                </div>
                {visibleEmployees.length === 0 ? (
                  <div className="dwr-empty dwr-empty--compact">
                    <p>No employees in this department.</p>
                  </div>
                ) : (
                  <div className="dwr-report-grid">
                    {visibleEmployees.map((row) => (
                      <StaffReportCard
                        key={row.user_id}
                        row={row}
                        expanded={expandedId === row.user_id}
                        onToggle={() =>
                          setExpandedId((id) => (id === row.user_id ? null : row.user_id))
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            )}

            {(roleTab === 'both' || roleTab === 'hr') && (
              <div className="dwr-role-section">
                <div className="dwr-role-section__label dwr-role-section__label--hr">
                  <FileText size={14} /> HR ({visibleHr.length})
                  <span className="dwr-role-section__hint">
                    {visibleHr.filter((r) => r.report).length} submitted
                  </span>
                </div>
                {visibleHr.length === 0 ? (
                  <div className="dwr-empty dwr-empty--compact">
                    <p>No HR in this filter.</p>
                  </div>
                ) : (
                  <div className="dwr-report-grid">
                    {visibleHr.map((row) => (
                      <StaffReportCard
                        key={row.user_id}
                        row={row}
                        expanded={expandedId === row.user_id}
                        onToggle={() =>
                          setExpandedId((id) => (id === row.user_id ? null : row.user_id))
                        }
                      />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </section>
        </div>
      </div>
    </div>
  );
}

function StaffReportCard({
  row,
  expanded,
  onToggle,
}: {
  row: StaffRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const submitted = !!row.report;
  const content = row.report?.content ?? '';
  const preview =
    content.length > 220 && !expanded ? `${content.slice(0, 220).trim()}…` : content;

  return (
    <article
      className={`dwr-report-card ${
        row.role === 'manager' ? 'dwr-report-card--manager' : row.role === 'hr' ? 'dwr-report-card--hr' : ''
      } ${submitted ? '' : 'dwr-report-card--missing'}`}
    >
      <header className="dwr-report-card__head">
        <div
          className={`dwr-avatar ${
            row.role === 'manager' ? 'dwr-avatar--manager' : row.role === 'hr' ? 'dwr-avatar--hr' : ''
          }`}
        >
          {initials(row.full_name)}
        </div>
        <div className="dwr-report-card__who">
          <strong>{row.full_name}</strong>
          <span>{row.email}</span>
        </div>
        <span
          className={`dwr-badge ${
            row.role === 'manager'
              ? 'dwr-badge--manager'
              : row.role === 'hr'
                ? 'dwr-badge--hr'
                : 'dwr-badge--employee'
          }`}
        >
          {row.role === 'hr' ? 'HR' : row.role}
        </span>
      </header>

      <div className="dwr-report-card__meta">
        <span>
          <Building2 size={12} /> {row.department_name}
        </span>
        {submitted ? (
          <span className="dwr-status dwr-status--ok">
            <CheckCircle2 size={12} /> Submitted · {formatReportTime(row.report!.submitted_at)}
          </span>
        ) : (
          <span className="dwr-status dwr-status--miss">
            <AlertCircle size={12} /> Not submitted
          </span>
        )}
      </div>

      {submitted ? (
        <>
          <p className="dwr-report-card__body">{preview}</p>
          {content.length > 220 && (
            <button type="button" className="dwr-link-btn" onClick={onToggle}>
              {expanded ? 'Show less' : 'Read full report'}
            </button>
          )}
          <div className="dwr-report-card__db">
            <Clock size={11} /> Saved in database for {formatReportDate(row.report!.report_date)}
          </div>
        </>
      ) : (
        <p className="dwr-report-card__body dwr-report-card__body--muted">
          No daily work report has been saved for this person on the selected date.
        </p>
      )}
    </article>
  );
}
