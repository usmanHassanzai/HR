import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  ChevronDown,
  Download,
  History,
  Loader2,
  Clock,
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
import { downloadAttendanceCsv } from '../utils/exportAttendance';
import '../styles/employee-attendance.css';

interface EmployeeAttendanceHistoryProps {
  profile: Profile;
}

type BrowsePeriod = 'month' | 'year';
type ViewMode = 'daily' | 'monthly';

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

export default function EmployeeAttendanceHistory({ profile }: EmployeeAttendanceHistoryProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [browsePeriod, setBrowsePeriod] = useState<BrowsePeriod>('month');
  const [viewMode, setViewMode] = useState<ViewMode>('daily');
  const [rows, setRows] = useState<TeamAttendanceHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<string | null>(null);
  const [expandedMonths, setExpandedMonths] = useState<Record<string, boolean>>({});

  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const yearLabel = String(year);
  const periodLabel = browsePeriod === 'month' ? monthLabel : yearLabel;

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_attendance_history', {
      p_year: year,
      p_month: browsePeriod === 'month' ? month : null,
      p_user_id: null,
    });

    const mapped = !error
      ? ((data || []) as AttendanceHistoryRow[]).map((r) => mapHistoryRow(r, profile))
      : [];
    setRows(mapped.sort((a, b) => b.attendance_date.localeCompare(a.attendance_date)));
    setLoading(false);
  }, [year, month, browsePeriod, profile]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalRecords = rows.length;
  const totalPresent = rows.filter((r) => r.clock_in_at).length;
  const totalMinutes = rows.reduce((s, r) => s + (r.work_minutes || 0), 0);

  const monthlyGroups = useMemo(() => {
    const map = new Map<string, TeamAttendanceHistoryRow[]>();
    for (const r of rows) {
      const key = r.attendance_date.slice(0, 7);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(r);
    }
    return [...map.entries()]
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([ym, monthRows]) => {
        const [y, m] = ym.split('-').map(Number);
        const label = new Date(y, m - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
        const mins = monthRows.reduce((s, r) => s + (r.work_minutes || 0), 0);
        const present = monthRows.filter((r) => r.clock_in_at).length;
        return { ym, label, monthRows, mins, present };
      });
  }, [rows]);

  const fetchRowsForExport = async (period: BrowsePeriod): Promise<TeamAttendanceHistoryRow[]> => {
    if (period === browsePeriod && rows.length > 0) return rows;

    const { data, error } = await supabase.rpc('get_attendance_history', {
      p_year: year,
      p_month: period === 'month' ? month : null,
      p_user_id: null,
    });

    if (error || !data) return [];
    return (data as AttendanceHistoryRow[]).map((r) => mapHistoryRow(r, profile));
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

  const toggleMonth = (ym: string) => {
    setExpandedMonths((prev) => ({ ...prev, [ym]: !prev[ym] }));
  };

  const currentMonthKey = `${year}-${String(month).padStart(2, '0')}`;

  return (
    <section className="emp-attendance-card">
      <h3>
        <History size={18} /> My attendance history
      </h3>
      <p>
        Review every check-in by day or month. Download your records as a CSV for any month or the full year.
      </p>

      <div className="emp-attendance-filters">
        <div className="form-group">
          <label htmlFor="emp-att-browse">Browse</label>
          <select
            id="emp-att-browse"
            value={browsePeriod}
            onChange={(e) => setBrowsePeriod(e.target.value as BrowsePeriod)}
          >
            <option value="month">Monthly (daily records)</option>
            <option value="year">Yearly overview</option>
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="emp-att-year">Year</label>
          <select id="emp-att-year" value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {[year - 1, year, year + 1].map((y) => (
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
        <div className="emp-attendance-filters__actions">
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={exporting !== null}
            onClick={() => void exportPeriod('month')}
          >
            {exporting === 'month' ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
            Download month
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={exporting !== null}
            onClick={() => void exportPeriod('year')}
          >
            {exporting === 'year' ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
            Download year
          </button>
        </div>
      </div>

      {browsePeriod === 'month' && (
        <div className="emp-attendance-view-tabs">
          <button
            type="button"
            className={`emp-attendance-view-tab ${viewMode === 'daily' ? 'emp-attendance-view-tab--active' : ''}`}
            onClick={() => setViewMode('daily')}
          >
            <Calendar size={14} /> Daily list
          </button>
          <button
            type="button"
            className={`emp-attendance-view-tab ${viewMode === 'monthly' ? 'emp-attendance-view-tab--active' : ''}`}
            onClick={() => setViewMode('monthly')}
          >
            <Clock size={14} /> Month summary
          </button>
        </div>
      )}

      <div className="emp-attendance-stats">
        <div className="emp-attendance-stat">
          <Calendar size={16} />
          <span className="emp-attendance-stat__label">Records ({periodLabel})</span>
          <strong>{totalRecords}</strong>
        </div>
        <div className="emp-attendance-stat">
          <History size={16} />
          <span className="emp-attendance-stat__label">Days with check-in</span>
          <strong>{totalPresent}</strong>
        </div>
        <div className="emp-attendance-stat">
          <Clock size={16} />
          <span className="emp-attendance-stat__label">Time logged</span>
          <strong>{formatWorkDuration(totalMinutes)}</strong>
        </div>
      </div>

      {loading ? (
        <div className="emp-attendance-loading">
          <Loader2 size={28} className="spin-icon" />
          <span>Loading attendance…</span>
        </div>
      ) : rows.length === 0 ? (
        <div className="emp-attendance-empty">
          <Calendar size={40} strokeWidth={1.25} />
          <h4>No records yet</h4>
          <p>No attendance entries for {periodLabel}. Clock in from the Today tab when you arrive.</p>
        </div>
      ) : browsePeriod === 'year' ? (
        <div className="emp-attendance-month-list">
          {monthlyGroups.map((group) => {
            const isOpen = expandedMonths[group.ym] ?? group.ym === currentMonthKey;
            return (
              <article key={group.ym} className="emp-attendance-month-block">
                <button
                  type="button"
                  className="emp-attendance-month-block__toggle"
                  onClick={() => toggleMonth(group.ym)}
                  aria-expanded={isOpen}
                >
                  <span>
                    <strong>{group.label}</strong>
                    <span className="emp-attendance-month-block__meta">
                      {group.present} day{group.present !== 1 ? 's' : ''} · {formatWorkDuration(group.mins)} ·{' '}
                      {group.monthRows.length} record{group.monthRows.length !== 1 ? 's' : ''}
                    </span>
                  </span>
                  <ChevronDown
                    size={18}
                    className={`emp-attendance-month-block__chev${isOpen ? ' emp-attendance-month-block__chev--open' : ''}`}
                  />
                </button>
                {isOpen && (
                  <div className="emp-attendance-month-block__body">
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
                          {group.monthRows.map((r) => (
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
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ) : viewMode === 'daily' ? (
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
              {rows.map((r) => (
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
        <div className="emp-attendance-summary-card">
          <div className="emp-attendance-summary-card__head">
            <strong>{monthLabel}</strong>
            <span>{totalPresent} days present · {formatWorkDuration(totalMinutes)} total</span>
          </div>
          <div className="emp-attendance-summary-grid">
            <div>
              <span>Total records</span>
              <strong>{totalRecords}</strong>
            </div>
            <div>
              <span>Approved days</span>
              <strong>{rows.filter((r) => r.approval_status === 'approved').length}</strong>
            </div>
            <div>
              <span>Pending review</span>
              <strong>{rows.filter((r) => r.approval_status === 'pending').length}</strong>
            </div>
            <div>
              <span>GPS check-ins</span>
              <strong>{rows.filter((r) => r.attendance_source === 'geo').length}</strong>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
