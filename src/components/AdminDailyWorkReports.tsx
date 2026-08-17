import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Calendar,
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
  fetchAdminDailyReportDeptSummary,
  fetchAdminDailyWorkReports,
  formatReportDate,
  formatReportTime,
  todayIsoDate,
} from '../utils/dailyWorkReportHelpers';
import '../styles/daily-work-reports.css';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';

type RoleTab = 'managers' | 'employees' | 'both';
type DeptSelection = 'all' | 'unassigned' | string;

interface StaffRow {
  user_id: string;
  full_name: string;
  email: string;
  role: 'manager' | 'employee';
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

export default function AdminDailyWorkReports() {
  const today = todayIsoDate();
  const [reportDate, setReportDate] = useState(today);
  const [selectedDeptId, setSelectedDeptId] = useState<DeptSelection>('all');
  const [roleTab, setRoleTab] = useState<RoleTab>('both');
  const [search, setSearch] = useState('');
  const [searchDebounced, setSearchDebounced] = useState('');
  const [summary, setSummary] = useState<DailyReportDeptSummary[]>([]);
  const [users, setUsers] = useState<Profile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [reports, setReports] = useState<AdminDailyWorkReport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim().toLowerCase()), 280);
    return () => clearTimeout(t);
  }, [search]);

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
        (u) => u.role === 'manager' || u.role === 'employee',
      ));
      setDepartments((deptsRes.data as Department[]) || []);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Failed to load daily reports');
    } finally {
      setLoading(false);
    }
  }, [reportDate]);

  useEffect(() => {
    void load();
  }, [load]);

  useSupabaseRealtime(
    'admin-daily-work-reports',
    [{ table: 'daily_work_reports' }, { table: 'notifications' }],
    () => { void load({ silent: true }); },
  );

  const deptName = useCallback(
    (id: string | null | undefined) => {
      if (!id) return 'Unassigned';
      return departments.find((d) => d.id === id)?.name
        ?? summary.find((s) => s.department_id === id)?.department_name
        ?? 'Unassigned';
    },
    [departments, summary],
  );

  const hasUnassignedStaff = useMemo(
    () => users.some((u) => !u.department_id),
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
      role: u.role as 'manager' | 'employee',
      department_id: u.department_id ?? null,
      department_name: deptName(u.department_id),
      report: reportByUser.get(u.id) ?? null,
    }));
  }, [users, reportByUser, deptName]);

  const scopedRows = useMemo(() => {
    let rows = staffRows;

    if (selectedDeptId === 'unassigned') {
      rows = rows.filter((r) => !r.department_id);
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
      if (a.role !== b.role) return a.role === 'manager' ? -1 : 1;
      return a.full_name.localeCompare(b.full_name);
    });
  }, [staffRows, selectedDeptId, searchDebounced]);

  const managers = scopedRows.filter((r) => r.role === 'manager');
  const employees = scopedRows.filter((r) => r.role === 'employee');
  const visibleManagers = roleTab === 'employees' ? [] : managers;
  const visibleEmployees = roleTab === 'managers' ? [] : employees;

  const totals = useMemo(() => {
    const submitted = scopedRows.filter((r) => r.report).length;
    return {
      staff: scopedRows.length,
      submitted,
      missing: Math.max(scopedRows.length - submitted, 0),
      managers: managers.length,
      employees: employees.length,
    };
  }, [scopedRows, managers.length, employees.length]);

  const selectedDeptLabel = useMemo(() => {
    if (selectedDeptId === 'all') return 'All departments';
    if (selectedDeptId === 'unassigned') return 'Unassigned';
    return deptName(selectedDeptId);
  }, [selectedDeptId, deptName]);

  const deptOptionMeta = useCallback(
    (deptId: string | null) => {
      const row = summary.find((s) =>
        deptId === null ? !s.department_id : s.department_id === deptId,
      );
      if (!row) return '';
      return ` — ${row.submitted_count}/${row.total_staff} submitted`;
    },
    [summary],
  );

  return (
    <div className="dwr-admin animate-fade-in">
      <div className="dwr-admin__hero">
        <div>
          <span className="dash-eyebrow">Saved daily in database</span>
          <h2>Daily work reports</h2>
          <p>
            Choose a department from the dropdown to review that team’s managers and employees.
            Select <strong>All departments</strong> to see every daily report for the date.
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
            <strong>{totals.managers}/{totals.employees}</strong>
            <span>Mgr / Emp</span>
          </div>
        </div>
      </div>

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
            {hasUnassignedStaff && (
              <option value="unassigned">Unassigned{deptOptionMeta(null)}</option>
            )}
          </select>
        </label>

        <label className="dwr-toolbar-field">
          <Calendar size={14} />
          <span>Report date</span>
          <input type="date" value={reportDate} max={today} onChange={(e) => setReportDate(e.target.value)} />
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
          Managers &amp; Employees
        </button>
        <button
          type="button"
          className={`dwr-role-tabs__btn ${roleTab === 'managers' ? 'dwr-role-tabs__btn--active' : ''}`}
          onClick={() => setRoleTab('managers')}
        >
          <Briefcase size={14} /> Managers only
        </button>
        <button
          type="button"
          className={`dwr-role-tabs__btn ${roleTab === 'employees' ? 'dwr-role-tabs__btn--active' : ''}`}
          onClick={() => setRoleTab('employees')}
        >
          <Users size={14} /> Employees only
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
            {roleTab !== 'employees' && (
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

            {roleTab !== 'managers' && (
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
          </div>
        )}
      </section>
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
      className={`dwr-report-card ${row.role === 'manager' ? 'dwr-report-card--manager' : ''} ${
        submitted ? '' : 'dwr-report-card--missing'
      }`}
    >
      <header className="dwr-report-card__head">
        <div className={`dwr-avatar ${row.role === 'manager' ? 'dwr-avatar--manager' : ''}`}>
          {initials(row.full_name)}
        </div>
        <div className="dwr-report-card__who">
          <strong>{row.full_name}</strong>
          <span>{row.email}</span>
        </div>
        <span className={`dwr-badge ${row.role === 'manager' ? 'dwr-badge--manager' : 'dwr-badge--employee'}`}>
          {row.role}
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
