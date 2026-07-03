import { useCallback, useEffect, useState } from 'react';
import { Calendar, Download, History, Loader2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  AttendanceHistoryRow,
  formatDateTime,
  formatWorkDuration,
} from '../utils/shiftHelpers';
import { APPROVAL_LABEL, approvalBadgeClass, ApprovalStatus } from '../utils/attendanceHelpers';
import { downloadAttendanceCsv } from '../utils/exportAttendance';
import { formatClockTime } from '../utils/geoAttendance';

interface AttendanceHistoryPanelProps {
  profile: Profile;
  mode: 'employee' | 'manager';
  teamMembers?: Profile[];
}

type ViewMode = 'daily' | 'monthly';

export default function AttendanceHistoryPanel({ profile, mode, teamMembers = [] }: AttendanceHistoryPanelProps) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [view, setView] = useState<ViewMode>('daily');
  const [userId, setUserId] = useState(profile.id);
  const [rows, setRows] = useState<AttendanceHistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);

  const monthLabel = new Date(year, month - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });

  const load = useCallback(async () => {
    setLoading(true);
    const { data, error } = await supabase.rpc('get_attendance_history', {
      p_year: year,
      p_month: view === 'daily' ? month : null,
      p_user_id: userId !== profile.id ? userId : null,
    });
    if (!error) setRows((data || []) as AttendanceHistoryRow[]);
    else setRows([]);
    setLoading(false);
  }, [year, month, view, userId, profile.id]);

  useEffect(() => { void load(); }, [load]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const mapped = rows.map((r) => ({
        id: r.id,
        user_id: userId,
        attendance_date: r.attendance_date,
        status: r.status as 'present',
        approval_status: r.approval_status as 'approved',
        clock_in_at: r.clock_in_at,
        clock_out_at: r.clock_out_at,
        attendance_source: r.attendance_source || 'geo',
        notes: r.notes,
        marked_by: null,
        reviewed_by: null,
        reviewed_at: null,
        created_at: r.attendance_date,
      }));
      const name = mode === 'manager' && userId !== profile.id
        ? teamMembers.find((m) => m.id === userId)?.full_name || profile.full_name
        : profile.full_name;
      downloadAttendanceCsv(mapped, name, view === 'daily' ? monthLabel : `${year}`);
    } finally {
      setExporting(false);
    }
  };

  const monthlyGroups = rows.reduce<Record<string, AttendanceHistoryRow[]>>((acc, r) => {
    const key = r.attendance_date.slice(0, 7);
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  const totalMinutes = rows.reduce((s, r) => s + (r.work_minutes || 0), 0);
  const daysPresent = rows.filter((r) => r.clock_in_at).length;

  return (
    <div className="attendance-card">
      <h3 className="attendance-card__title"><History size={18} /> Attendance history</h3>

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

        {mode === 'manager' && teamMembers.length > 0 && (
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

        <button type="button" className="btn btn-secondary" disabled={exporting} onClick={() => void exportCsv()}>
          {exporting ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
          Export
        </button>
      </div>

      <div className="attendance-quick-stats" style={{ marginTop: '0.75rem' }}>
        <div className="attendance-stat-pill">
          <div className="attendance-stat-pill__value">{daysPresent}</div>
          <div className="attendance-stat-pill__label">{view === 'daily' ? 'Days this month' : 'Days this year'}</div>
        </div>
        <div className="attendance-stat-pill">
          <div className="attendance-stat-pill__value">{formatWorkDuration(totalMinutes)}</div>
          <div className="attendance-stat-pill__label">Total time logged</div>
        </div>
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
                    <span className="attendance-history-sub">{formatDateTime(r.clock_in_at).split(',').slice(1).join(',')}</span>
                  </td>
                  <td>{r.shift_name || '—'}</td>
                  <td>{formatDateTime(r.clock_in_at)}</td>
                  <td>{formatDateTime(r.clock_out_at)}</td>
                  <td>{formatWorkDuration(r.work_minutes)}</td>
                  <td>{r.attendance_source === 'geo' ? 'GPS auto' : r.attendance_source || '—'}</td>
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
              return (
                <details key={ym} className="attendance-month-block" open={ym === `${year}-${String(month).padStart(2, '0')}`}>
                  <summary>
                    <strong>{label}</strong>
                    <span>{present} days · {formatWorkDuration(mins)} total</span>
                  </summary>
                  <table className="attendance-history-table">
                    <thead>
                      <tr><th>Date</th><th>In</th><th>Out</th><th>Duration</th></tr>
                    </thead>
                    <tbody>
                      {monthRows.map((r) => (
                        <tr key={r.id}>
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
