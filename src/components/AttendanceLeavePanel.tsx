import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  AttendanceRecord,
  LeaveBalance,
  LeaveRequest,
  PendingLeaveRequest,
  PendingAttendanceRecord,
  AttendanceSummary,
  LeaveSummary,
  AttendanceStatus,
  LeaveType,
  ATTENDANCE_STATUS_LABEL,
  LEAVE_TYPE_LABEL,
  APPROVAL_LABEL,
  approvalBadgeClass,
} from '../utils/attendanceHelpers';
import { emailLeaveRequestNotifications } from '../utils/attendanceEmail';
import { downloadAttendanceCsv } from '../utils/exportAttendance';
import GeoAttendancePanel from './GeoAttendancePanel';
import MyShiftCard from './MyShiftCard';
import ShiftManagementPanel from './ShiftManagementPanel';
import AttendanceHistoryPanel from './AttendanceHistoryPanel';
import { formatClockTime } from '../utils/geoAttendance';
import { formatWorkDuration } from '../utils/shiftHelpers';
import {
  Clock, Loader2, CheckCircle, XCircle, Palmtree,
  UserCheck, Users, Download, Inbox, History, ClipboardList, CalendarClock,
} from 'lucide-react';
import '../styles/attendance.css';

interface AttendanceLeavePanelProps {
  profile: Profile;
  mode: 'employee' | 'manager' | 'admin';
}

type EmployeeTab = 'today' | 'leave' | 'history';
type ManagerTab = 'approvals' | 'today' | 'team' | 'shifts';

function Toast({ msg }: { msg: string }) {
  if (!msg) return null;
  const isError = /failed|error|not enough/i.test(msg);
  return (
    <div className={`rewards-toast ${isError ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
      {msg}
    </div>
  );
}

function ApprovalActions({
  onApprove,
  onReject,
  disabled,
}: {
  onApprove: () => void;
  onReject: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="attendance-approval-item__actions">
      <button type="button" className="btn btn-primary btn-sm" disabled={disabled} onClick={onApprove}>
        <CheckCircle size={14} /> Approve
      </button>
      <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} onClick={onReject}>
        <XCircle size={14} /> Reject
      </button>
    </div>
  );
}

export default function AttendanceLeavePanel({ profile, mode }: AttendanceLeavePanelProps) {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);
  const [monthlySummary, setMonthlySummary] = useState<AttendanceSummary | null>(null);
  const [yearLeaveSummary, setYearLeaveSummary] = useState<LeaveSummary | null>(null);
  const [monthLeaveSummary, setMonthLeaveSummary] = useState<LeaveSummary | null>(null);
  const [myAttendance, setMyAttendance] = useState<AttendanceRecord[]>([]);
  const [myLeaves, setMyLeaves] = useState<LeaveRequest[]>([]);
  const [pendingAttendance, setPendingAttendance] = useState<PendingAttendanceRecord[]>([]);
  const [pendingLeaves, setPendingLeaves] = useState<PendingLeaveRequest[]>([]);
  const [teamMembers, setTeamMembers] = useState<Profile[]>([]);

  const [employeeTab, setEmployeeTab] = useState<EmployeeTab>('today');
  const [managerTab, setManagerTab] = useState<ManagerTab>('approvals');

  const [leaveType, setLeaveType] = useState<LeaveType>('annual');
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [leaveReason, setLeaveReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [markUserId, setMarkUserId] = useState('');
  const [markDate, setMarkDate] = useState(new Date().toISOString().slice(0, 10));
  const [markStatus, setMarkStatus] = useState<AttendanceStatus>('present');

  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [exporting, setExporting] = useState(false);

  const userId = profile.id;
  const monthLabel = new Date(selectedYear, selectedMonth - 1, 1).toLocaleString('default', { month: 'long', year: 'numeric' });
  const todayStr = new Date().toISOString().slice(0, 10);
  const checkedInToday = myAttendance.some((a) => a.attendance_date === todayStr);
  const pendingCount = pendingLeaves.length + pendingAttendance.length;

  const mapLeaveRows = (rows: LeaveRequest[], members: Profile[]): PendingLeaveRequest[] => {
    const info = new Map(members.map((m) => [m.id, m]));
    return rows.map((lr) => {
      const person = info.get(lr.user_id);
      return {
        id: lr.id,
        user_id: lr.user_id,
        leave_type: lr.leave_type,
        start_date: lr.start_date,
        end_date: lr.end_date,
        days_count: lr.days_count,
        reason: lr.reason,
        status: lr.status,
        created_at: lr.created_at,
        employee_name: person?.full_name || 'Employee',
        employee_email: person?.email || '',
        employee_role: person?.role || 'employee',
      };
    });
  };

  const loadPendingLeavesForManager = async (reports: Profile[]): Promise<PendingLeaveRequest[]> => {
    const employeeReports = reports.filter((r) => r.role === 'employee');
    const reportIds = employeeReports.map((r) => r.id);
    if (reportIds.length === 0) return [];

    const { data, error } = await supabase
      .from('leave_requests')
      .select('*')
      .in('user_id', reportIds)
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_pending_leave_requests');
      if (rpcError) throw new Error(rpcError.message);
      return (rpcData || []) as PendingLeaveRequest[];
    }
    return mapLeaveRows((data || []) as LeaveRequest[], employeeReports);
  };

  const loadPendingLeavesForAdmin = async (): Promise<PendingLeaveRequest[]> => {
    const { data: users, error: usersErr } = await supabase.rpc('get_all_users_admin');
    if (usersErr) throw new Error(usersErr.message);
    const members = ((users || []) as Profile[]).filter((u) => u.role !== 'admin');

    const { data, error } = await supabase
      .from('leave_requests')
      .select('*')
      .eq('status', 'pending')
      .order('created_at', { ascending: false });

    if (error) {
      const { data: rpcData, error: rpcError } = await supabase.rpc('get_pending_leave_requests');
      if (rpcError) throw new Error(rpcError.message);
      return (rpcData || []) as PendingLeaveRequest[];
    }

    const allowedIds = new Set(members.map((m) => m.id));
    return mapLeaveRows(
      ((data || []) as LeaveRequest[]).filter((lr) => allowedIds.has(lr.user_id)),
      members
    );
  };

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      if (mode === 'admin') {
        setPendingLeaves(await loadPendingLeavesForAdmin());
        setPendingAttendance([]);
        return;
      }

      const [balRes, yearSumRes, monthSumRes, yearLeaveRes, monthLeaveRes, attRes, leaveRes] = await Promise.all([
        supabase.rpc('get_leave_balance', { p_user_id: userId }),
        supabase.rpc('get_my_attendance_summary', { p_year: selectedYear }),
        supabase.rpc('get_my_attendance_summary', { p_year: selectedYear, p_month: selectedMonth }),
        supabase.rpc('get_my_leave_summary', { p_year: selectedYear }),
        supabase.rpc('get_my_leave_summary', { p_year: selectedYear, p_month: selectedMonth }),
        supabase
          .from('attendance_records')
          .select('*')
          .eq('user_id', userId)
          .gte('attendance_date', `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`)
          .lte('attendance_date', `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${new Date(selectedYear, selectedMonth, 0).getDate()}`)
          .order('attendance_date', { ascending: false }),
        supabase
          .from('leave_requests')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      const rpcError =
        balRes.error?.message ||
        yearSumRes.error?.message ||
        monthSumRes.error?.message ||
        yearLeaveRes.error?.message ||
        monthLeaveRes.error?.message;
      if (rpcError) throw new Error(rpcError);
      if (attRes.error) throw new Error(attRes.error.message);
      if (leaveRes.error) throw new Error(leaveRes.error.message);

      if (balRes.data?.[0]) setBalance(balRes.data[0] as LeaveBalance);
      if (yearSumRes.data?.[0]) setSummary(yearSumRes.data[0] as AttendanceSummary);
      if (monthSumRes.data?.[0]) setMonthlySummary(monthSumRes.data[0] as AttendanceSummary);
      if (yearLeaveRes.data?.[0]) setYearLeaveSummary(yearLeaveRes.data[0] as LeaveSummary);
      if (monthLeaveRes.data?.[0]) setMonthLeaveSummary(monthLeaveRes.data[0] as LeaveSummary);
      setMyAttendance((attRes.data || []) as AttendanceRecord[]);
      setMyLeaves((leaveRes.data || []) as LeaveRequest[]);

      if (mode === 'manager') {
        const { data: reports, error: reportsErr } = await supabase.rpc('get_direct_reports', { p_manager_id: userId });
        if (reportsErr) throw new Error(reportsErr.message);

        const team = (reports || []) as Profile[];
        setTeamMembers(team);
        if (team[0] && !markUserId) setMarkUserId(team[0].id);

        const { data: pAtt } = await supabase.rpc('get_pending_attendance_for_manager');
        setPendingAttendance((pAtt || []) as PendingAttendanceRecord[]);
        setPendingLeaves(await loadPendingLeavesForManager(team));
      }
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Failed to load attendance data');
    } finally {
      setLoading(false);
    }
  }, [userId, mode, markUserId, selectedYear, selectedMonth]);

  useEffect(() => { load(); }, [load]);

  const checkInToday = async () => {
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('check_in_attendance', { p_date: todayStr });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Checked in! Waiting for approval.');
      load();
    }
  };

  const submitLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveStart || !leaveEnd) return;
    setSubmitting(true);
    setMsg('');
    const { data, error } = await supabase.rpc('submit_leave_request', {
      p_leave_type: leaveType,
      p_start: leaveStart,
      p_end: leaveEnd,
      p_reason: leaveReason || null,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      if (data) await emailLeaveRequestNotifications(data);
      setMsg(
        profile.role === 'manager'
          ? 'Leave request sent. Admin will review it.'
          : 'Leave request sent. Your manager will review it.'
      );
      setLeaveStart('');
      setLeaveEnd('');
      setLeaveReason('');
      setEmployeeTab('history');
      setManagerTab('today');
      load();
    }
  };

  const markTeamAttendance = async () => {
    if (!markUserId) return;
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('mark_attendance', {
      p_user_id: markUserId,
      p_date: markDate,
      p_status: markStatus,
      p_notes: null,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Team attendance saved.');
      load();
    }
  };

  const reviewAtt = async (id: string, approve: boolean) => {
    const { error } = await supabase.rpc('review_attendance', { p_record_id: id, p_approve: approve });
    if (error) setMsg(error.message);
    else {
      setMsg(approve ? 'Attendance approved.' : 'Attendance rejected.');
      load();
    }
  };

  const reviewLeave = async (id: string, approve: boolean) => {
    setSubmitting(true);
    const { error } = await supabase.rpc('review_leave_request', { p_request_id: id, p_approve: approve });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg(approve ? 'Leave approved.' : 'Leave rejected.');
      load();
    }
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      const lastDay = new Date(selectedYear, selectedMonth, 0).getDate();
      const start = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-01`;
      const end = `${selectedYear}-${String(selectedMonth).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
      const { data, error } = await supabase
        .from('attendance_records')
        .select('*')
        .eq('user_id', userId)
        .gte('attendance_date', start)
        .lte('attendance_date', end)
        .order('attendance_date', { ascending: true });
      if (error) throw error;
      downloadAttendanceCsv((data || []) as AttendanceRecord[], profile.full_name, monthLabel);
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'CSV export failed');
    } finally {
      setExporting(false);
    }
  };

  const renderQuickStats = () => (
    <div className="attendance-quick-stats">
      {balance && (
        <>
          <div className="attendance-stat-pill">
            <div className="attendance-stat-pill__value">{balance.annual_remaining}</div>
            <div className="attendance-stat-pill__label">Annual leave left</div>
          </div>
          <div className="attendance-stat-pill">
            <div className="attendance-stat-pill__value">{balance.sick_remaining}</div>
            <div className="attendance-stat-pill__label">Sick leave left</div>
          </div>
        </>
      )}
      {monthlySummary && (
        <div className="attendance-stat-pill">
          <div className="attendance-stat-pill__value">{monthlySummary.attendance_rate}%</div>
          <div className="attendance-stat-pill__label">Attendance this month</div>
        </div>
      )}
      {monthLeaveSummary && (
        <div className="attendance-stat-pill">
          <div className="attendance-stat-pill__value">{monthLeaveSummary.total_days_taken}</div>
          <div className="attendance-stat-pill__label">Leave days this month</div>
        </div>
      )}
    </div>
  );

  const renderCheckInHero = (approverLabel: string) => (
    <div className="attendance-hero">
      <h3 className="attendance-hero__title">Today — {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
      <p className="attendance-hero__hint">
        Tap check-in once per working day. {approverLabel} will approve your record.
      </p>
      <button
        type="button"
        className="btn btn-primary attendance-hero__btn"
        disabled={submitting || checkedInToday}
        onClick={checkInToday}
      >
        {checkedInToday ? (
          <><CheckCircle size={18} /> Checked in today</>
        ) : (
          <><Clock size={18} /> Check in now</>
        )}
      </button>
    </div>
  );

  const renderLeaveForm = (hint: string) => (
    <div className="attendance-card">
      <h3 className="attendance-card__title"><Palmtree size={18} /> Request time off</h3>
      <p className="attendance-card__subtitle">{hint}</p>
      <form onSubmit={submitLeave} className="attendance-form-grid attendance-form-grid--wide">
        <div className="form-group">
          <label>Type</label>
          <select value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveType)}>
            <option value="annual">Annual leave</option>
            <option value="sick">Sick leave</option>
          </select>
        </div>
        <div className="form-group">
          <label>From</label>
          <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} required />
        </div>
        <div className="form-group">
          <label>To</label>
          <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} required />
        </div>
        <div className="form-group attendance-form-span-full">
          <label>Reason (optional)</label>
          <input type="text" value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} placeholder="e.g. Family trip" />
        </div>
        <button type="submit" className="btn btn-primary" disabled={submitting}>
          {submitting ? <Loader2 size={16} className="spin-icon" /> : 'Submit request'}
        </button>
      </form>
    </div>
  );

  const renderPeriodBar = (showExport = true) => (
    <div className="attendance-period-bar">
      <div className="form-group">
        <label>Month</label>
        <select value={selectedMonth} onChange={(e) => setSelectedMonth(Number(e.target.value))}>
          {Array.from({ length: 12 }, (_, i) => (
            <option key={i + 1} value={i + 1}>
              {new Date(selectedYear, i, 1).toLocaleString('default', { month: 'long' })}
            </option>
          ))}
        </select>
      </div>
      <div className="form-group">
        <label>Year</label>
        <select value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
          {[selectedYear - 1, selectedYear, selectedYear + 1].map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>
      {showExport && (
        <button type="button" className="btn btn-secondary" disabled={exporting} onClick={exportCsv}>
          {exporting ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
          Export CSV
        </button>
      )}
    </div>
  );

  const renderHistory = () => (
    <div className="attendance-card">
      <h3 className="attendance-card__title"><History size={18} /> History — {monthLabel}</h3>
      {renderPeriodBar()}
      <h4 style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 0.75rem' }}>Attendance</h4>
      {myAttendance.length === 0 ? (
        <p className="attendance-empty">No attendance records for this month.</p>
      ) : (
        <div className="team-points-table-wrap" style={{ marginBottom: '1.25rem' }}>
          <table className="attendance-history-table">
            <thead>
              <tr><th>Date</th><th>Status</th><th>Clock in</th><th>Clock out</th><th>Duration</th><th>Approval</th></tr>
            </thead>
            <tbody>
              {myAttendance.map((r) => (
                <tr key={r.id}>
                  <td>{r.attendance_date}</td>
                  <td>{ATTENDANCE_STATUS_LABEL[r.status]}</td>
                  <td>{formatClockTime(r.clock_in_at)}{r.attendance_source === 'geo' && r.clock_in_at ? ' · GPS' : ''}</td>
                  <td>{formatClockTime(r.clock_out_at)}</td>
                  <td>{formatWorkDuration(r.work_minutes)}</td>
                  <td><span className={`badge ${approvalBadgeClass(r.approval_status)}`}>{APPROVAL_LABEL[r.approval_status]}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h4 style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', margin: '0 0 0.75rem' }}>Leave requests</h4>
      {myLeaves.length === 0 ? (
        <p className="attendance-empty">No leave requests yet.</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          {myLeaves.map((r) => (
            <div key={r.id} className="attendance-leave-chip">
              <div className="attendance-leave-chip__info">
                <strong>{LEAVE_TYPE_LABEL[r.leave_type]}</strong>
                <span>{r.start_date} → {r.end_date} · {r.days_count} day{r.days_count !== 1 ? 's' : ''}</span>
              </div>
              <span className={`badge ${approvalBadgeClass(r.status)}`}>{APPROVAL_LABEL[r.status]}</span>
            </div>
          ))}
        </div>
      )}
      {yearLeaveSummary && (
        <p style={{ marginTop: '1rem', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Year total: {yearLeaveSummary.total_days_taken} days ({yearLeaveSummary.annual_days_taken} annual, {yearLeaveSummary.sick_days_taken} sick)
        </p>
      )}
    </div>
  );

  const renderLeaveApprovals = (emptyText: string) => (
    pendingLeaves.length === 0 ? (
      <div className="attendance-empty">
        <Inbox size={32} />
        {emptyText}
      </div>
    ) : (
      <div className="attendance-approval-list">
        {pendingLeaves.map((r) => (
          <div key={r.id} className="attendance-approval-item">
            <div className="attendance-approval-item__main">
              <span className="attendance-approval-item__name">
                {r.employee_name}
                {r.employee_role && <span className="attendance-role-tag">{r.employee_role}</span>}
              </span>
              <span className="attendance-approval-item__meta">
                {LEAVE_TYPE_LABEL[r.leave_type]} · {r.start_date} to {r.end_date} · {r.days_count} day{r.days_count !== 1 ? 's' : ''}
              </span>
              {r.reason && <span className="attendance-approval-item__reason">"{r.reason}"</span>}
            </div>
            <ApprovalActions
              disabled={submitting}
              onApprove={() => reviewLeave(r.id, true)}
              onReject={() => reviewLeave(r.id, false)}
            />
          </div>
        ))}
      </div>
    )
  );

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  /* ── Admin: leave approvals only ── */
  if (mode === 'admin') {
    return (
      <div className="attendance-page animate-fade-in">
        <Toast msg={msg} />
        <div className="attendance-admin-header">
          <h3>Leave approvals</h3>
          <p>Review requests from employees and managers. One tap to approve or reject.</p>
        </div>
        <div className="attendance-card">
          <h3 className="attendance-card__title">
            <Inbox size={18} /> Pending requests
            {pendingLeaves.length > 0 && (
              <span className="badge badge-at-risk" style={{ marginLeft: '0.5rem', fontSize: '0.75rem' }}>
                {pendingLeaves.length}
              </span>
            )}
          </h3>
          {renderLeaveApprovals('All caught up — no pending leave requests.')}
        </div>
      </div>
    );
  }

  /* ── Manager ── */
  if (mode === 'manager') {
    return (
      <div className="attendance-page animate-fade-in">
        <Toast msg={msg} />

        <div className="attendance-tabs">
          <button
            type="button"
            className={`attendance-tab ${managerTab === 'approvals' ? 'attendance-tab--active' : ''}`}
            onClick={() => setManagerTab('approvals')}
          >
            <ClipboardList size={16} /> Approvals
            {pendingCount > 0 && <span className="attendance-tab__count">{pendingCount}</span>}
          </button>
          <button
            type="button"
            className={`attendance-tab ${managerTab === 'today' ? 'attendance-tab--active' : ''}`}
            onClick={() => setManagerTab('today')}
          >
            <UserCheck size={16} /> My day
          </button>
          <button
            type="button"
            className={`attendance-tab ${managerTab === 'team' ? 'attendance-tab--active' : ''}`}
            onClick={() => setManagerTab('team')}
          >
            <Users size={16} /> Team
          </button>
          <button
            type="button"
            className={`attendance-tab ${managerTab === 'shifts' ? 'attendance-tab--active' : ''}`}
            onClick={() => setManagerTab('shifts')}
          >
            <CalendarClock size={16} /> Shifts
          </button>
        </div>

        {managerTab === 'approvals' && (
          <div className="attendance-card">
            <h3 className="attendance-card__title">Needs your action</h3>
            <p className="attendance-card__subtitle">Approve leave and check-ins from your team.</p>

            {pendingLeaves.length === 0 && pendingAttendance.length === 0 ? (
              <div className="attendance-empty"><Inbox size={32} />Nothing waiting for approval.</div>
            ) : (
              <div className="attendance-approval-list">
                {pendingLeaves.map((r) => (
                  <div key={r.id} className="attendance-approval-item">
                    <div className="attendance-approval-item__main">
                      <span className="attendance-approval-item__name">Leave · {r.employee_name}</span>
                      <span className="attendance-approval-item__meta">
                        {LEAVE_TYPE_LABEL[r.leave_type]} · {r.start_date} to {r.end_date} · {r.days_count} days
                      </span>
                      {r.reason && <span className="attendance-approval-item__reason">"{r.reason}"</span>}
                    </div>
                    <ApprovalActions disabled={submitting} onApprove={() => reviewLeave(r.id, true)} onReject={() => reviewLeave(r.id, false)} />
                  </div>
                ))}
                {pendingAttendance.map((r) => (
                  <div key={r.id} className="attendance-approval-item attendance-approval-item--attendance">
                    <div className="attendance-approval-item__main">
                      <span className="attendance-approval-item__name">Check-in · {r.employee_name || 'Employee'}</span>
                      <span className="attendance-approval-item__meta">
                        {r.attendance_date} · {ATTENDANCE_STATUS_LABEL[r.status]}
                      </span>
                    </div>
                    <ApprovalActions disabled={submitting} onApprove={() => reviewAtt(r.id, true)} onReject={() => reviewAtt(r.id, false)} />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {managerTab === 'today' && (
          <>
            <MyShiftCard />
            <GeoAttendancePanel onClockUpdate={load} />
            {renderCheckInHero('Admin')}
            {renderQuickStats()}
            {renderLeaveForm('Your leave goes to admin for approval.')}
          </>
        )}

        {managerTab === 'shifts' && (
          <ShiftManagementPanel teamMembers={teamMembers} onUpdate={load} />
        )}

        {managerTab === 'team' && (
          <>
            <div className="attendance-card">
              <h3 className="attendance-card__title"><Users size={18} /> Mark team attendance</h3>
              <p className="attendance-card__subtitle">Record attendance for a team member on a specific date.</p>
              {teamMembers.length === 0 ? (
                <p className="attendance-empty">No team members assigned yet.</p>
              ) : (
                <div className="attendance-form-grid">
                  <div className="form-group">
                    <label>Team member</label>
                    <select value={markUserId} onChange={(e) => setMarkUserId(e.target.value)}>
                      {teamMembers.map((m) => (
                        <option key={m.id} value={m.id}>{m.full_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={markDate} onChange={(e) => setMarkDate(e.target.value)} />
                  </div>
                  <div className="form-group">
                    <label>Status</label>
                    <select value={markStatus} onChange={(e) => setMarkStatus(e.target.value as AttendanceStatus)}>
                      {(Object.keys(ATTENDANCE_STATUS_LABEL) as AttendanceStatus[]).map((s) => (
                        <option key={s} value={s}>{ATTENDANCE_STATUS_LABEL[s]}</option>
                      ))}
                    </select>
                  </div>
                  <button type="button" className="btn btn-primary" disabled={submitting} onClick={markTeamAttendance}>
                    Save
                  </button>
                </div>
              )}
            </div>
            <AttendanceHistoryPanel profile={profile} mode="manager" teamMembers={teamMembers} />
          </>
        )}
      </div>
    );
  }

  /* ── Employee ── */
  return (
    <div className="attendance-page animate-fade-in">
      <Toast msg={msg} />

      <div className="attendance-tabs">
        <button
          type="button"
          className={`attendance-tab ${employeeTab === 'today' ? 'attendance-tab--active' : ''}`}
          onClick={() => setEmployeeTab('today')}
        >
          <UserCheck size={16} /> Today
        </button>
        <button
          type="button"
          className={`attendance-tab ${employeeTab === 'leave' ? 'attendance-tab--active' : ''}`}
          onClick={() => setEmployeeTab('leave')}
        >
          <Palmtree size={16} /> Request leave
        </button>
        <button
          type="button"
          className={`attendance-tab ${employeeTab === 'history' ? 'attendance-tab--active' : ''}`}
          onClick={() => setEmployeeTab('history')}
        >
          <History size={16} /> History
        </button>
      </div>

      {employeeTab === 'today' && (
        <>
          <MyShiftCard />
          <GeoAttendancePanel onClockUpdate={load} />
          {renderCheckInHero('Your manager')}
          {renderQuickStats()}
          {summary && (
            <p style={{ fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
              Year-to-date attendance: {summary.attendance_rate}% ({summary.present_approved} approved days)
            </p>
          )}
        </>
      )}

      {employeeTab === 'leave' && renderLeaveForm('Your manager will be notified and can approve the request.')}

      {employeeTab === 'history' && (
        <>
          {renderHistory()}
          <AttendanceHistoryPanel profile={profile} mode="employee" />
        </>
      )}
    </div>
  );
}
