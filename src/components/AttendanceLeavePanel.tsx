import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  AttendanceRecord,
  LeaveBalance,
  LeaveRequest,
  PendingLeaveRequest,
  AttendanceSummary,
  LeaveSummary,
  AttendanceStatus,
  LeaveType,
  ATTENDANCE_STATUS_LABEL,
  formatLeaveType,
  APPROVAL_LABEL,
  approvalBadgeClass,
} from '../utils/attendanceHelpers';
import { emailLeaveRequestNotifications } from '../utils/attendanceEmail';
import GeoAttendancePanel from './GeoAttendancePanel';
import MyShiftCard from './MyShiftCard';
import ShiftManagementPanel, { CompanyLocationWindowCard } from './ShiftManagementPanel';
import AdminAttendanceDirectory from './AdminAttendanceDirectory';
import ManagerTeamAttendanceDirectory from './ManagerTeamAttendanceDirectory';
import EmployeeAttendanceHistory from './EmployeeAttendanceHistory';
import { Department } from '../utils/departmentHelpers';
import { canMarkRemoteAttendance, workModeLabel } from '../utils/workModeHelpers';
import { GEO_CLOCK_EVENT, localYmd } from '../utils/geoAttendance';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import {
  Loader2, CheckCircle, XCircle, Palmtree, LogOut,
  UserCheck, Users, Inbox, History, ClipboardList, CalendarClock,
  CalendarCheck, Building2, AlertCircle, CheckCircle2,
} from 'lucide-react';
import '../styles/attendance.css';
import '../styles/admin-attendance.css';
import '../styles/manager-attendance.css';
import '../styles/employee-attendance.css';

interface AttendanceLeavePanelProps {
  profile: Profile;
  mode: 'employee' | 'manager' | 'admin' | 'hr';
  initialAdminTab?: AdminTab;
  initialUserId?: string;
}

type EmployeeTab = 'today' | 'leave' | 'history';
type ManagerTab = 'approvals' | 'today' | 'team' | 'shifts' | 'history';
type AdminTab = 'leave' | 'remote' | 'shifts' | 'history';

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

export default function AttendanceLeavePanel({ profile, mode, initialAdminTab, initialUserId }: AttendanceLeavePanelProps) {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);
  const [monthlySummary, setMonthlySummary] = useState<AttendanceSummary | null>(null);
  const [yearLeaveSummary, setYearLeaveSummary] = useState<LeaveSummary | null>(null);
  const [monthLeaveSummary, setMonthLeaveSummary] = useState<LeaveSummary | null>(null);
  const [myAttendance, setMyAttendance] = useState<AttendanceRecord[]>([]);
  const [myLeaves, setMyLeaves] = useState<LeaveRequest[]>([]);
  const [pendingLeaves, setPendingLeaves] = useState<PendingLeaveRequest[]>([]);
  const [teamMembers, setTeamMembers] = useState<Profile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);

  const [managerTab, setManagerTab] = useState<ManagerTab>('approvals');
  const [adminTab, setAdminTab] = useState<AdminTab>(initialAdminTab || (mode === 'hr' ? 'history' : 'leave'));

  useEffect(() => {
    if (initialAdminTab) setAdminTab(initialAdminTab);
  }, [initialAdminTab]);
  const [employeeTab, setEmployeeTab] = useState<EmployeeTab>('today');

  const [leaveType, setLeaveType] = useState<LeaveType>('annual');
  const [leaveCustomType, setLeaveCustomType] = useState('');
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [leaveReason, setLeaveReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [markUserId, setMarkUserId] = useState('');
  const [markDate, setMarkDate] = useState(new Date().toISOString().slice(0, 10));
  const [markStatus, setMarkStatus] = useState<AttendanceStatus>('present');
  const [markingId, setMarkingId] = useState<string | null>(null);
  const [historyRefreshKey, setHistoryRefreshKey] = useState(0);
  const [remoteMarks, setRemoteMarks] = useState<Record<string, AttendanceStatus>>({});

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  const [shiftDate, setShiftDate] = useState<string | null>(null);

  const userId = profile.id;
  const todayStr = localYmd();
  const activeAttendance = myAttendance.find((a) => a.clock_in_at && !a.clock_out_at)
    ?? myAttendance.find((a) => a.attendance_date === (shiftDate ?? todayStr));
  const todayRecord = activeAttendance ?? myAttendance.find((a) => a.attendance_date === todayStr);
  const checkedInToday = !!todayRecord && todayRecord.status !== 'absent' && !!todayRecord.clock_in_at;
  const stillOnSiteToday = checkedInToday && !todayRecord?.clock_out_at;
  const checkedOutToday = checkedInToday && !!todayRecord?.clock_out_at;
  const isRemoteWorker = profile.work_mode === 'remote';
  const isHybridWorker = profile.work_mode === 'hybrid';
  const pendingCount = pendingLeaves.length;

  const mapLeaveRows = (rows: LeaveRequest[], members: Profile[]): PendingLeaveRequest[] => {
    const info = new Map(members.map((m) => [m.id, m]));
    return rows.map((lr) => {
      const person = info.get(lr.user_id);
      return {
        id: lr.id,
        user_id: lr.user_id,
        leave_type: lr.leave_type,
        leave_custom_type: lr.leave_custom_type,
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
    const members = ((users || []) as Profile[]).filter((u) => u.role !== 'admin' && !u.is_demo);

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

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    if (!opts?.silent) setMsg('');
    try {
      if (mode === 'admin' || mode === 'hr') {
        const [{ data: deptData }, { data: usersData, error: usersErr }, pending] = await Promise.all([
          supabase.rpc('get_departments'),
          supabase.rpc('get_all_users_admin'),
          mode === 'admin' ? loadPendingLeavesForAdmin() : Promise.resolve([] as PendingLeaveRequest[]),
        ]);
        if (usersErr) throw new Error(usersErr.message);
        setDepartments((deptData || []) as Department[]);
        setTeamMembers(
          ((usersData || []) as Profile[]).filter(
            (u) => (u.role === 'employee' || u.role === 'manager' || u.role === 'hr') && !u.is_demo,
          ),
        );
        setPendingLeaves(pending);
        const { data: ownAtt } = await supabase
          .from('attendance_records')
          .select('*')
          .eq('user_id', userId)
          .gte('attendance_date', `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`)
          .lte('attendance_date', `${currentYear}-${String(currentMonth).padStart(2, '0')}-${new Date(currentYear, currentMonth, 0).getDate()}`)
          .order('attendance_date', { ascending: false });
        setMyAttendance((ownAtt || []) as AttendanceRecord[]);
        return;
      }

      const [balRes, yearSumRes, monthSumRes, yearLeaveRes, monthLeaveRes, attRes, leaveRes, shiftDateRes] = await Promise.all([
        supabase.rpc('get_leave_balance', { p_user_id: userId }),
        supabase.rpc('get_my_attendance_summary', { p_year: currentYear }),
        supabase.rpc('get_my_attendance_summary', { p_year: currentYear, p_month: currentMonth }),
        supabase.rpc('get_my_leave_summary', { p_year: currentYear }),
        supabase.rpc('get_my_leave_summary', { p_year: currentYear, p_month: currentMonth }),
        supabase
          .from('attendance_records')
          .select('*')
          .eq('user_id', userId)
          .gte('attendance_date', `${currentYear}-${String(currentMonth).padStart(2, '0')}-01`)
          .lte('attendance_date', `${currentYear}-${String(currentMonth).padStart(2, '0')}-${new Date(currentYear, currentMonth, 0).getDate()}`)
          .order('attendance_date', { ascending: false }),
        supabase
          .from('leave_requests')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(20),
        mode === 'employee' ? supabase.rpc('get_my_shift_attendance_date') : Promise.resolve({ data: null, error: null }),
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
      if (mode === 'employee') {
        const rawShiftDate = shiftDateRes.data;
        setShiftDate(typeof rawShiftDate === 'string' ? rawShiftDate.slice(0, 10) : localYmd());
      }

      if (mode === 'manager') {
        const { data: reports, error: reportsErr } = await supabase.rpc('get_direct_reports', { p_manager_id: userId });
        if (reportsErr) throw new Error(reportsErr.message);

        const team = (reports || []) as Profile[];
        setTeamMembers(team);
        if (team[0] && !markUserId) setMarkUserId(team[0].id);

        setPendingLeaves(await loadPendingLeavesForManager(team));

        const { data: deptData } = await supabase.rpc('get_departments');
        setDepartments((deptData || []) as Department[]);
      }
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Failed to load attendance data');
    } finally {
      setLoading(false);
    }
  }, [userId, mode, markUserId, currentYear, currentMonth]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onClock = () => {
      void load({ silent: true });
      setHistoryRefreshKey((k) => k + 1);
    };
    window.addEventListener(GEO_CLOCK_EVENT, onClock);
    return () => window.removeEventListener(GEO_CLOCK_EVENT, onClock);
  }, [load]);

  const onClockUpdate = useCallback(() => {
    void load();
    setHistoryRefreshKey((k) => k + 1);
  }, [load]);

  useSupabaseRealtime(
    `attendance-sync-${userId}`,
    mode === 'employee'
      ? [
          { table: 'attendance_records', filter: `user_id=eq.${userId}` },
          { table: 'leave_requests', filter: `user_id=eq.${userId}` },
        ]
      : [
          { table: 'attendance_records' },
          { table: 'leave_requests' },
        ],
    () => { void load({ silent: true }); },
  );

  const checkInToday = async () => {
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('check_in_attendance');
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Checked in successfully — approved automatically.');
      load();
      setHistoryRefreshKey((k) => k + 1);
      window.dispatchEvent(new CustomEvent(GEO_CLOCK_EVENT));
    }
  };

  const checkOutToday = async (opts?: { thenRequestLeave?: boolean }) => {
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('check_out_attendance');
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg(
        opts?.thenRequestLeave
          ? 'Checked out for the rest of your shift. Submit your leave request on the next tab.'
          : 'Checked out. Duration saved to your attendance history.',
      );
      load();
      setHistoryRefreshKey((k) => k + 1);
      window.dispatchEvent(new CustomEvent(GEO_CLOCK_EVENT));
      if (opts?.thenRequestLeave) {
        setLeaveStart(todayStr);
        setLeaveEnd(todayStr);
        setLeaveType('other');
        setLeaveCustomType('Urgent leave');
        setLeaveReason((prev) => prev || 'Leaving shift early');
        setEmployeeTab('leave');
      }
    }
  };

  const submitLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveStart || !leaveEnd) return;
    if (leaveType === 'other' && !leaveCustomType.trim()) {
      setMsg('Please write the type of leave.');
      return;
    }
    setSubmitting(true);
    setMsg('');
    const { data, error } = await supabase.rpc('submit_leave_request', {
      p_leave_type: leaveType,
      p_start: leaveStart,
      p_end: leaveEnd,
      p_reason: leaveReason || null,
      p_custom_type: leaveType === 'other' ? leaveCustomType.trim() : null,
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
      setLeaveCustomType('');
      setLeaveType('annual');
      setEmployeeTab('leave');
      setManagerTab('today');
      load();
    }
  };

  const markTeamAttendance = async (userIdOverride?: string, statusOverride?: AttendanceStatus) => {
    const targetId = userIdOverride || markUserId;
    const status = statusOverride || markStatus;
    if (!targetId) return;
    const previous = remoteMarks[targetId];
    setRemoteMarks((prev) => ({ ...prev, [targetId]: status }));
    setSubmitting(true);
    setMarkingId(`${targetId}:${status}`);
    setMsg('');
    const { error } = await supabase.rpc('mark_attendance', {
      p_user_id: targetId,
      p_date: markDate,
      p_status: status,
      p_notes: null,
    });
    setSubmitting(false);
    setMarkingId(null);
    if (error) {
      setRemoteMarks((prev) => {
        const next = { ...prev };
        if (previous) next[targetId] = previous;
        else delete next[targetId];
        return next;
      });
      setMsg(error.message);
    } else {
      const name = teamMembers.find((m) => m.id === targetId)?.full_name || 'Employee';
      setMsg(`${name} marked ${ATTENDANCE_STATUS_LABEL[status].toLowerCase()} for ${markDate}. Saved to their attendance history.`);
      setHistoryRefreshKey((k) => k + 1);
      load();
    }
  };

  const markHybridRemoteDay = async (status: AttendanceStatus) => {
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('mark_hybrid_remote_day', {
      p_date: todayStr,
      p_status: status,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg(status === 'present' ? 'Remote day marked present and saved to your history.' : 'Remote day marked absent.');
      load();
    }
  };

  const remoteStaff = teamMembers.filter(
    (m) => canMarkRemoteAttendance(m.work_mode) && m.id !== userId && (m.role === 'employee' || m.role === 'manager'),
  );
  const remoteStaffKey = remoteStaff.map((m) => m.id).sort().join(',');

  useEffect(() => {
    const ids = remoteStaffKey ? remoteStaffKey.split(',') : [];
    if (ids.length === 0) {
      setRemoteMarks({});
      return;
    }
    let cancelled = false;
    void supabase
      .from('attendance_records')
      .select('user_id, status')
      .eq('attendance_date', markDate)
      .in('user_id', ids)
      .then(({ data }) => {
        if (cancelled) return;
        const next: Record<string, AttendanceStatus> = {};
        for (const row of data || []) {
          next[row.user_id] = row.status as AttendanceStatus;
        }
        setRemoteMarks(next);
      });
    return () => { cancelled = true; };
  }, [markDate, remoteStaffKey]);

  const renderRemoteMarkList = () => (
    <>
      <div className="form-group" style={{ maxWidth: 220, marginBottom: '1rem' }}>
        <label htmlFor="remote-mark-date">Date</label>
        <input
          id="remote-mark-date"
          type="date"
          value={markDate}
          max={todayStr}
          onChange={(e) => setMarkDate(e.target.value)}
        />
      </div>
      {remoteStaff.length === 0 ? (
        <p className="mgr-attendance-card__subtitle">
          No remote or hybrid staff yet. Set Work location to Remote or Hybrid in Users, then mark them here.
        </p>
      ) : (
        <div className="mgr-remote-mark-list">
          {remoteStaff.map((m) => {
            const marked = remoteMarks[m.id];
            return (
            <div key={m.id} className="mgr-remote-mark-row">
              <div>
                <strong>{m.full_name}</strong>
                <span>
                  {workModeLabel(m.work_mode)} {m.role === 'manager' ? 'manager' : 'employee'} · {m.email}
                </span>
              </div>
              <div className="mgr-remote-mark-row__actions">
                <button
                  type="button"
                  className={`btn btn-sm mgr-mark-btn mgr-mark-btn--present${marked === 'present' ? ' is-active' : ''}`}
                  disabled={submitting}
                  onClick={() => void markTeamAttendance(m.id, 'present')}
                >
                  {markingId === `${m.id}:present` ? <Loader2 size={14} className="spin-icon" /> : <CheckCircle size={14} />}
                  Present
                </button>
                <button
                  type="button"
                  className={`btn btn-sm mgr-mark-btn mgr-mark-btn--absent${marked === 'absent' ? ' is-active' : ''}`}
                  disabled={submitting}
                  onClick={() => void markTeamAttendance(m.id, 'absent')}
                >
                  {markingId === `${m.id}:absent` ? <Loader2 size={14} className="spin-icon" /> : <XCircle size={14} />}
                  Absent
                </button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </>
  );

  const renderRemoteSelfCard = () => (
    <section className={mode === 'employee' ? 'emp-attendance-card' : 'mgr-attendance-card'}>
      <h3>
        <UserCheck size={18} /> Remote attendance
      </h3>
      <p>
        You work remotely. Your supervisor marks you present or absent. That record is saved automatically in your
        history.
      </p>
      {todayRecord ? (
        <p style={{ marginBottom: 0 }}>
          Today: <strong>{ATTENDANCE_STATUS_LABEL[todayRecord.status]}</strong>
          {todayRecord.notes ? ` · ${todayRecord.notes}` : ''}
        </p>
      ) : (
        <p style={{ marginBottom: 0 }}>Not marked yet for today.</p>
      )}
    </section>
  );

  const renderHybridTodayCard = () => (
    <section className={mode === 'employee' ? 'emp-attendance-card' : 'mgr-attendance-card'}>
      <h3>
        <UserCheck size={18} /> Hybrid — remote day
      </h3>
      <p>
        In the office today? Use GPS check-in. Working from home? Mark present or absent here. Your supervisor can also
        mark a remote day for you.
      </p>
      {todayRecord ? (
        <p style={{ marginBottom: '0.75rem' }}>
          Today: <strong>{ATTENDANCE_STATUS_LABEL[todayRecord.status]}</strong>
          {todayRecord.attendance_source === 'geo' ? ' · Office GPS' : ''}
          {todayRecord.notes ? ` · ${todayRecord.notes}` : ''}
        </p>
      ) : (
        <p style={{ marginBottom: '0.75rem' }}>No office check-in or remote mark yet today.</p>
      )}
      <div className="mgr-remote-mark-row__actions">
        <button
          type="button"
          className={`btn btn-sm mgr-mark-btn mgr-mark-btn--present${todayRecord?.status === 'present' && todayRecord.attendance_source !== 'geo' ? ' is-active' : ''}`}
          disabled={submitting || (todayRecord?.attendance_source === 'geo' && !!todayRecord.clock_in_at)}
          onClick={() => void markHybridRemoteDay('present')}
        >
          {submitting ? <Loader2 size={14} className="spin-icon" /> : <CheckCircle size={14} />}
          Working from home
        </button>
        <button
          type="button"
          className={`btn btn-sm mgr-mark-btn mgr-mark-btn--absent${todayRecord?.status === 'absent' ? ' is-active' : ''}`}
          disabled={submitting || (todayRecord?.attendance_source === 'geo' && !!todayRecord.clock_in_at)}
          onClick={() => void markHybridRemoteDay('absent')}
        >
          <XCircle size={14} /> Absent today
        </button>
      </div>
    </section>
  );

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

  const renderCheckInHero = (_approverLabel?: string) => (
    <div className="attendance-hero">
      <h3 className="attendance-hero__title">Today — {new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
      <p className="attendance-hero__hint">
        Check in when you arrive and check out when you leave — even in the middle of your shift (for example urgent leave).
        Each visit is saved separately and added to your hours.
      </p>
      <div className="attendance-hero__actions">
        <button
          type="button"
          className={`btn attendance-hero__btn att-toggle att-toggle--in${stillOnSiteToday ? ' is-active' : ''}`}
          disabled={submitting}
          onClick={() => { if (!stillOnSiteToday) void checkInToday(); }}
        >
          {submitting && !stillOnSiteToday ? <Loader2 size={18} className="spin-icon" /> : <CheckCircle size={18} />}
          Check in
        </button>
        <button
          type="button"
          className={`btn attendance-hero__btn att-toggle att-toggle--out${checkedOutToday ? ' is-active' : ''}`}
          disabled={submitting || !stillOnSiteToday}
          onClick={() => { if (stillOnSiteToday) void checkOutToday(); }}
        >
          {submitting && stillOnSiteToday ? <Loader2 size={18} className="spin-icon" /> : <LogOut size={18} />}
          Check out
        </button>
        {stillOnSiteToday && mode === 'employee' && (
          <button
            type="button"
            className="btn btn-secondary attendance-hero__btn attendance-hero__btn--leave-early"
            disabled={submitting}
            onClick={() => void checkOutToday({ thenRequestLeave: true })}
          >
            {submitting ? <Loader2 size={18} className="spin-icon" /> : <Palmtree size={18} />}
            Check out &amp; request leave
          </button>
        )}
      </div>
      {stillOnSiteToday ? (
        <p className="attendance-present-banner" role="status">
          You are still present in the office and working. This stays visible after every check-in until you check out.
        </p>
      ) : checkedOutToday ? (
        <p className="attendance-present-banner attendance-present-banner--out" role="status">
          You checked out. Check in again during your shift if you return — the present message will show again.
        </p>
      ) : null}
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
            <option value="other">Other</option>
          </select>
        </div>
        {leaveType === 'other' && (
          <div className="form-group">
            <label>Write the type of leave</label>
            <input
              type="text"
              value={leaveCustomType}
              onChange={(e) => setLeaveCustomType(e.target.value)}
              placeholder="e.g. Maternity, Hajj, unpaid"
              maxLength={80}
              required
            />
          </div>
        )}
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
                {formatLeaveType(r.leave_type, r.leave_custom_type)} · {r.start_date} to {r.end_date} · {r.days_count} day{r.days_count !== 1 ? 's' : ''}
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

  if (loading && !balance && teamMembers.length === 0 && myAttendance.length === 0) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  if (mode === 'hr') {
    return (
      <div className="admin-attendance-page">
        {msg && (
          <div
            className={`admin-attendance-alert ${/failed|error|not enough/i.test(msg) ? 'admin-attendance-alert--error' : 'admin-attendance-alert--success'}`}
            role="alert"
          >
            {/failed|error|not enough/i.test(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>{msg}</span>
          </div>
        )}

        <div className="attendance-section-tabs admin-attendance-tabs tab-bar tab-bar--inline-mobile" role="tablist" aria-label="HR attendance sections">
          <button
            type="button"
            className={`tab-btn ${adminTab === 'history' ? 'tab-btn--active' : ''}`}
            onClick={() => setAdminTab('history')}
            aria-label="Employee attendance history"
          >
            <History size={16} />
            <span>History</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${adminTab === 'shifts' ? 'tab-btn--active' : ''}`}
            onClick={() => setAdminTab('shifts')}
            aria-label="Shifts"
          >
            <CalendarClock size={16} />
            <span>Shifts</span>
          </button>
        </div>

        {adminTab === 'history' && (
          <AdminAttendanceDirectory departments={departments} initialUserId={initialUserId} />
        )}

        {adminTab === 'shifts' && (
          <section className="admin-attendance-card glass-panel">
            <h3>
              <CalendarClock size={18} /> Create &amp; assign shifts
            </h3>
            <p>
              Choose hours and working days, then assign to one person or several at once.
              Admins can still view and change the same schedules.
            </p>
            <ShiftManagementPanel mode="hr" teamMembers={teamMembers} onUpdate={load} />
          </section>
        )}
      </div>
    );
  }

  /* ── Admin: leave + company attendance ── */
  if (mode === 'admin') {
    return (
      <div className="admin-attendance-page">
        <header className="admin-attendance-header glass-panel">
          <div className="admin-attendance-header__main">
            <div className="admin-attendance-header__icon">
              <CalendarCheck size={22} />
            </div>
            <div>
              <h2 className="admin-attendance-header__title">Attendance &amp; Leave</h2>
              <p className="admin-attendance-header__subtitle">
                Review leave requests and browse every employee&apos;s attendance history by department.
                Check-ins are approved automatically and stored with date and time — download reports anytime.
              </p>
            </div>
          </div>

          <div className="admin-attendance-stats">
            <div className="admin-attendance-stat">
              <Inbox size={16} />
              <span className="admin-attendance-stat__label">Pending leave</span>
              <strong>{pendingLeaves.length}</strong>
            </div>
            <div className="admin-attendance-stat">
              <Building2 size={16} />
              <span className="admin-attendance-stat__label">Departments</span>
              <strong>{departments.length}</strong>
            </div>
            <div className="admin-attendance-stat">
              <Users size={16} />
              <span className="admin-attendance-stat__label">Scope</span>
              <strong style={{ fontSize: '0.88rem' }}>Company</strong>
            </div>
          </div>
        </header>

        {msg && (
          <div
            className={`admin-attendance-alert ${/failed|error|not enough/i.test(msg) ? 'admin-attendance-alert--error' : 'admin-attendance-alert--success'}`}
            role="alert"
          >
            {/failed|error|not enough/i.test(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>{msg}</span>
          </div>
        )}

        <CompanyLocationWindowCard />

        <div className="attendance-section-tabs admin-attendance-tabs tab-bar tab-bar--inline-mobile" role="tablist" aria-label="Attendance sections">
          <button
            type="button"
            className={`tab-btn ${adminTab === 'leave' ? 'tab-btn--active' : ''}`}
            onClick={() => setAdminTab('leave')}
            aria-label="Leave approvals"
          >
            <Inbox size={16} />
            <span>Leave</span>
            {pendingLeaves.length > 0 && <span className="admin-attendance-count-badge">{pendingLeaves.length}</span>}
          </button>
          <button
            type="button"
            className={`tab-btn ${adminTab === 'remote' ? 'tab-btn--active' : ''}`}
            onClick={() => setAdminTab('remote')}
            aria-label="Remote and hybrid attendance"
          >
            <UserCheck size={16} />
            <span>Remote</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${adminTab === 'shifts' ? 'tab-btn--active' : ''}`}
            onClick={() => setAdminTab('shifts')}
            aria-label="Shifts"
          >
            <CalendarClock size={16} />
            <span>Shifts</span>
          </button>
          <button
            type="button"
            className={`tab-btn ${adminTab === 'history' ? 'tab-btn--active' : ''}`}
            onClick={() => setAdminTab('history')}
            aria-label="Attendance history"
          >
            <History size={16} />
            <span>History</span>
          </button>
        </div>

        {adminTab === 'remote' && (
          <section className="admin-attendance-card glass-panel">
            <h3>
              <UserCheck size={18} /> Mark remote &amp; hybrid staff
            </h3>
            <p>
              Mark remote and hybrid employees and managers present or absent for work-from-home days. Office-only
              staff still use GPS. Records are saved in their attendance history.
            </p>
            {renderRemoteMarkList()}
          </section>
        )}

        {adminTab === 'leave' && (
          <section className="admin-attendance-card glass-panel">
            <h3>
              <Inbox size={18} /> Pending leave requests
            </h3>
            <p>Review time-off requests from employees and managers across all departments.</p>
            {renderLeaveApprovals('All caught up — no pending leave requests.')}
          </section>
        )}

        {adminTab === 'shifts' && (
          <section className="admin-attendance-card glass-panel">
            <h3>
              <CalendarClock size={18} /> Create &amp; assign shifts
            </h3>
            <p>Create schedules and assign them directly to any manager or employee in your organization.</p>
            <ShiftManagementPanel mode="admin" teamMembers={teamMembers} onUpdate={load} />
          </section>
        )}

        {adminTab === 'history' && <AdminAttendanceDirectory departments={departments} initialUserId={initialUserId} />}
      </div>
    );
  }

  /* ── Manager ── */
  if (mode === 'manager') {
    return (
      <div className="mgr-attendance-page">
        <header className="mgr-attendance-header">
          <div className="mgr-attendance-header__main">
            <div className="mgr-attendance-header__icon">
              <CalendarCheck size={22} />
            </div>
            <div>
              <h2 className="mgr-attendance-header__title">Attendance &amp; Leave</h2>
              <p className="mgr-attendance-header__subtitle">
                Approve team leave, mark attendance, manage shifts, and download your own or each employee&apos;s
                history as a monthly or yearly report. Check-ins are approved automatically.
              </p>
            </div>
          </div>

          <div className="mgr-attendance-stats">
            <div className={`mgr-attendance-stat${pendingCount > 0 ? ' mgr-attendance-stat--warn' : ''}`}>
              <Inbox size={16} />
              <span className="mgr-attendance-stat__label">Pending approvals</span>
              <strong>{pendingCount}</strong>
            </div>
            <div className="mgr-attendance-stat">
              <Users size={16} />
              <span className="mgr-attendance-stat__label">Team members</span>
              <strong>{teamMembers.length}</strong>
            </div>
            <div className="mgr-attendance-stat">
              <ClipboardList size={16} />
              <span className="mgr-attendance-stat__label">Leave requests</span>
              <strong>{pendingLeaves.length}</strong>
            </div>
            <div className="mgr-attendance-stat">
              <CheckCircle size={16} />
              <span className="mgr-attendance-stat__label">Check-ins</span>
              <strong>Auto-approved</strong>
            </div>
          </div>
        </header>

        {msg && (
          <div
            className={`mgr-attendance-alert ${/failed|error|not enough/i.test(msg) ? 'mgr-attendance-alert--error' : 'mgr-attendance-alert--success'}`}
            role="alert"
          >
            {/failed|error|not enough/i.test(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>{msg}</span>
          </div>
        )}

        <div className="attendance-section-tabs mgr-attendance-tabs tab-bar tab-bar--inline-mobile" role="tablist" aria-label="Attendance sections">
          <button
            type="button"
            className={`tab-btn ${managerTab === 'approvals' ? 'tab-btn--active' : ''}`}
            onClick={() => setManagerTab('approvals')}
          >
            <ClipboardList size={16} /> Approvals
            {pendingCount > 0 && <span className="mgr-attendance-count-badge">{pendingCount}</span>}
          </button>
          <button
            type="button"
            className={`tab-btn ${managerTab === 'today' ? 'tab-btn--active' : ''}`}
            onClick={() => setManagerTab('today')}
          >
            <UserCheck size={16} /> My day
          </button>
          <button
            type="button"
            className={`tab-btn ${managerTab === 'team' ? 'tab-btn--active' : ''}`}
            onClick={() => setManagerTab('team')}
          >
            <Users size={16} /> Team
          </button>
          <button
            type="button"
            className={`tab-btn ${managerTab === 'shifts' ? 'tab-btn--active' : ''}`}
            onClick={() => setManagerTab('shifts')}
          >
            <CalendarClock size={16} /> Shifts
          </button>
          <button
            type="button"
            className={`tab-btn ${managerTab === 'history' ? 'tab-btn--active' : ''}`}
            onClick={() => setManagerTab('history')}
          >
            <History size={16} /> History
          </button>
        </div>

        {managerTab === 'approvals' && (
          <section className="mgr-attendance-card">
            <h3>
              <Inbox size={18} /> Needs your action
            </h3>
            <p className="mgr-attendance-card__subtitle">Approve leave requests from your direct reports. Check-ins are approved automatically.</p>

            {pendingLeaves.length === 0 ? (
              <div className="mgr-attendance-empty">
                <Inbox size={32} strokeWidth={1.25} />
                <h4>All caught up</h4>
                <p>No leave requests waiting for your approval.</p>
              </div>
            ) : (
              <div className="mgr-attendance-approval-list">
                {pendingLeaves.map((r) => (
                  <div key={r.id} className="attendance-approval-item">
                    <div className="attendance-approval-item__main">
                      <span className="attendance-approval-item__name">Leave · {r.employee_name}</span>
                      <span className="attendance-approval-item__meta">
                        {formatLeaveType(r.leave_type, r.leave_custom_type)} · {r.start_date} to {r.end_date} · {r.days_count} days
                      </span>
                      {r.reason && <span className="attendance-approval-item__reason">&ldquo;{r.reason}&rdquo;</span>}
                    </div>
                    <ApprovalActions disabled={submitting} onApprove={() => reviewLeave(r.id, true)} onReject={() => reviewLeave(r.id, false)} />
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {managerTab === 'today' && (
          <>
            <MyShiftCard />
            {isRemoteWorker ? (
              renderRemoteSelfCard()
            ) : (
              <>
                <GeoAttendancePanel onClockUpdate={onClockUpdate} />
                {isHybridWorker && renderHybridTodayCard()}
                {renderCheckInHero('Admin')}
              </>
            )}
            {renderQuickStats()}
            {renderLeaveForm('Your leave goes to admin for approval.')}
          </>
        )}

        {managerTab === 'shifts' && (
          <section className="mgr-attendance-card">
            <ShiftManagementPanel teamMembers={teamMembers} onUpdate={load} />
          </section>
        )}

        {managerTab === 'team' && (
          <section className="mgr-attendance-card">
            <h3>
              <Users size={18} /> Mark team attendance
            </h3>
            <p className="mgr-attendance-card__subtitle">
              For remote and hybrid people, mark <strong>Present</strong> or <strong>Absent</strong> on work-from-home
              days. Office days for hybrid staff still use GPS.
            </p>
            {teamMembers.filter((m) => m.role === 'employee').length === 0 ? (
              <div className="mgr-attendance-empty">
                <Users size={32} strokeWidth={1.25} />
                <h4>No team members</h4>
                <p>Assign employees to your team to mark their attendance here.</p>
              </div>
            ) : (
              <>
                {renderRemoteMarkList()}

                <h4 className="mgr-attendance-subhead">Any team member</h4>
                <div className="attendance-form-grid">
                  <div className="form-group">
                    <label>Team member</label>
                    <select value={markUserId} onChange={(e) => setMarkUserId(e.target.value)}>
                      {teamMembers.filter((m) => m.role === 'employee').map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.full_name}
                          {canMarkRemoteAttendance(m.work_mode) ? ` (${workModeLabel(m.work_mode)})` : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Status</label>
                    <select value={markStatus} onChange={(e) => setMarkStatus(e.target.value as AttendanceStatus)}>
                      <option value="present">Present</option>
                      <option value="absent">Absent</option>
                    </select>
                  </div>
                  <button type="button" className="btn btn-primary" disabled={submitting || !markUserId} onClick={() => void markTeamAttendance()}>
                    Save to history
                  </button>
                </div>
              </>
            )}
          </section>
        )}

        {managerTab === 'history' && (
          <ManagerTeamAttendanceDirectory profile={profile} teamMembers={teamMembers} refreshKey={historyRefreshKey} />
        )}
      </div>
    );
  }

  /* ── Employee ── */
  return (
    <div className="emp-attendance-page">
      <header className="emp-attendance-header">
        <div className="emp-attendance-header__main">
          <div className="emp-attendance-header__icon">
            <CalendarCheck size={22} />
          </div>
          <div>
            <h2 className="emp-attendance-header__title">Attendance &amp; Leave</h2>
            <p className="emp-attendance-header__subtitle">
              Clock in with GPS, request time off, and review your full attendance history — download daily or monthly
              records anytime.
            </p>
          </div>
        </div>

        <div className="emp-attendance-stats">
          <div className="emp-attendance-stat emp-attendance-stat--accent">
            <UserCheck size={16} />
            <span className="emp-attendance-stat__label">Today</span>
            <strong>
              {isRemoteWorker
                ? (todayRecord ? ATTENDANCE_STATUS_LABEL[todayRecord.status] : 'Waiting on manager')
                : isHybridWorker
                  ? (todayRecord ? ATTENDANCE_STATUS_LABEL[todayRecord.status] : 'Office GPS or WFH')
                : checkedInToday ? 'Checked in' : 'Not yet'}
            </strong>
          </div>
          <div className="emp-attendance-stat">
            <CalendarCheck size={16} />
            <span className="emp-attendance-stat__label">YTD attendance</span>
            <strong>{summary ? `${summary.attendance_rate}%` : '—'}</strong>
          </div>
          <div className="emp-attendance-stat">
            <Palmtree size={16} />
            <span className="emp-attendance-stat__label">Annual leave left</span>
            <strong>{balance ? balance.annual_remaining : '—'}</strong>
          </div>
          <div className="emp-attendance-stat">
            <Inbox size={16} />
            <span className="emp-attendance-stat__label">Leave requests</span>
            <strong>{myLeaves.length}</strong>
          </div>
        </div>
      </header>

      {msg && (
        <div
          className={`emp-attendance-alert ${/failed|error|not enough/i.test(msg) ? 'emp-attendance-alert--error' : 'emp-attendance-alert--success'}`}
          role="alert"
        >
          {/failed|error|not enough/i.test(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{msg}</span>
        </div>
      )}

      <div
        className="attendance-section-tabs emp-attendance-tabs tab-bar tab-bar--inline-mobile"
        role="tablist"
        aria-label="Attendance sections"
      >
        <button
          type="button"
          role="tab"
          aria-selected={employeeTab === 'today'}
          className={`tab-btn ${employeeTab === 'today' ? 'tab-btn--active' : ''}`}
          onClick={() => setEmployeeTab('today')}
        >
          <UserCheck size={16} />
          <span>Mark attendance</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={employeeTab === 'leave'}
          className={`tab-btn ${employeeTab === 'leave' ? 'tab-btn--active' : ''}`}
          onClick={() => setEmployeeTab('leave')}
        >
          <Palmtree size={16} />
          <span>Request leave</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={employeeTab === 'history'}
          className={`tab-btn ${employeeTab === 'history' ? 'tab-btn--active' : ''}`}
          onClick={() => setEmployeeTab('history')}
        >
          <History size={16} />
          <span>Attendance history</span>
        </button>
      </div>

      {employeeTab === 'today' && (
        <>
          <MyShiftCard />
          {isRemoteWorker ? (
            renderRemoteSelfCard()
          ) : (
            <>
              <GeoAttendancePanel onClockUpdate={onClockUpdate} />
              {isHybridWorker && renderHybridTodayCard()}
              {renderCheckInHero('Your manager')}
            </>
          )}
          {renderQuickStats()}
          {summary && (
            <section className="emp-attendance-card">
              <p style={{ margin: 0, fontSize: '0.875rem', color: 'var(--text-secondary)' }}>
                Year-to-date attendance: <strong>{summary.attendance_rate}%</strong> ({summary.present_approved} approved days)
              </p>
            </section>
          )}
        </>
      )}

      {employeeTab === 'leave' && (
        <>
          {renderLeaveForm('Your manager will be notified and can approve the request.')}
          {myLeaves.length > 0 && (
            <section className="emp-attendance-card">
              <h3>
                <Palmtree size={18} /> My leave requests
              </h3>
              <p className="emp-attendance-card__subtitle">Track the status of your time-off requests.</p>
              <div className="emp-attendance-leave-list">
                {myLeaves.map((r) => (
                  <div key={r.id} className="emp-attendance-leave-item">
                    <div>
                      <strong>{formatLeaveType(r.leave_type, r.leave_custom_type)}</strong>
                      <span>
                        {r.start_date} → {r.end_date} · {r.days_count} day{r.days_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                    <span className={`badge ${approvalBadgeClass(r.status)}`}>{APPROVAL_LABEL[r.status]}</span>
                  </div>
                ))}
              </div>
              {yearLeaveSummary && (
                <p style={{ marginTop: '1rem', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                  Year total: {yearLeaveSummary.total_days_taken} days ({yearLeaveSummary.annual_days_taken} annual,{' '}
                  {yearLeaveSummary.sick_days_taken} sick)
                </p>
              )}
            </section>
          )}
        </>
      )}

      {employeeTab === 'history' && (
        <EmployeeAttendanceHistory profile={profile} refreshKey={historyRefreshKey} />
      )}
    </div>
  );
}
