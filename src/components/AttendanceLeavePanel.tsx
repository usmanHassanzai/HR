import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  AttendanceRecord,
  LeaveBalance,
  LeaveRequest,
  AttendanceSummary,
  AttendanceStatus,
  LeaveType,
  ATTENDANCE_STATUS_LABEL,
  LEAVE_TYPE_LABEL,
  APPROVAL_LABEL,
  approvalBadgeClass,
} from '../utils/attendanceHelpers';
import {
  CalendarCheck, Clock, Loader2, CheckCircle, XCircle, Palmtree, Thermometer,
  UserCheck, Users,
} from 'lucide-react';

interface AttendanceLeavePanelProps {
  profile: Profile;
  mode: 'employee' | 'manager' | 'admin';
}

export default function AttendanceLeavePanel({ profile, mode }: AttendanceLeavePanelProps) {
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [summary, setSummary] = useState<AttendanceSummary | null>(null);
  const [myAttendance, setMyAttendance] = useState<AttendanceRecord[]>([]);
  const [myLeaves, setMyLeaves] = useState<LeaveRequest[]>([]);
  const [pendingAttendance, setPendingAttendance] = useState<AttendanceRecord[]>([]);
  const [pendingLeaves, setPendingLeaves] = useState<LeaveRequest[]>([]);
  const [teamMembers, setTeamMembers] = useState<Profile[]>([]);

  const [leaveType, setLeaveType] = useState<LeaveType>('annual');
  const [leaveStart, setLeaveStart] = useState('');
  const [leaveEnd, setLeaveEnd] = useState('');
  const [leaveReason, setLeaveReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [markUserId, setMarkUserId] = useState('');
  const [markDate, setMarkDate] = useState(new Date().toISOString().slice(0, 10));
  const [markStatus, setMarkStatus] = useState<AttendanceStatus>('present');

  const userId = profile.id;

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      const [balRes, sumRes, attRes, leaveRes] = await Promise.all([
        supabase.rpc('get_leave_balance', { p_user_id: userId }),
        supabase.rpc('get_my_attendance_summary'),
        supabase
          .from('attendance_records')
          .select('*')
          .eq('user_id', userId)
          .order('attendance_date', { ascending: false })
          .limit(30),
        supabase
          .from('leave_requests')
          .select('*')
          .eq('user_id', userId)
          .order('created_at', { ascending: false })
          .limit(20),
      ]);

      if (balRes.data?.[0]) setBalance(balRes.data[0] as LeaveBalance);
      if (sumRes.data?.[0]) setSummary(sumRes.data[0] as AttendanceSummary);
      setMyAttendance((attRes.data || []) as AttendanceRecord[]);
      setMyLeaves((leaveRes.data || []) as LeaveRequest[]);

      if (mode === 'manager') {
        const { data: reports } = await supabase.rpc('get_direct_reports', { p_manager_id: userId });
        setTeamMembers((reports || []) as Profile[]);
        if (reports?.[0] && !markUserId) setMarkUserId(reports[0].id);

        const ids = [userId, ...(reports || []).map((r: Profile) => r.id)];
        const { data: pAtt } = await supabase
          .from('attendance_records')
          .select('*, users(full_name, email)')
          .in('user_id', ids)
          .neq('user_id', userId)
          .eq('approval_status', 'pending')
          .order('attendance_date', { ascending: false });
        setPendingAttendance((pAtt || []) as AttendanceRecord[]);

        const { data: pLeave } = await supabase
          .from('leave_requests')
          .select('*, users(full_name, email, role)')
          .in('user_id', ids)
          .eq('status', 'pending')
          .order('created_at', { ascending: false });
        setPendingLeaves((pLeave || []) as LeaveRequest[]);
      }

      if (mode === 'admin') {
        const { data: allUsers } = await supabase.rpc('get_all_users_admin');
        const list = ((allUsers || []) as Profile[]).filter((u) => u.role !== 'admin');
        setTeamMembers(list);
        if (list[0] && !markUserId) setMarkUserId(list[0].id);

        const { data: pAtt } = await supabase
          .from('attendance_records')
          .select('*, users(full_name, email)')
          .eq('approval_status', 'pending')
          .order('attendance_date', { ascending: false });
        setPendingAttendance((pAtt || []) as AttendanceRecord[]);

        const { data: pLeave } = await supabase
          .from('leave_requests')
          .select('*, users(full_name, email, role)')
          .eq('status', 'pending')
          .order('created_at', { ascending: false });
        setPendingLeaves((pLeave || []) as LeaveRequest[]);
      }
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Failed to load attendance data');
    } finally {
      setLoading(false);
    }
  }, [userId, mode, markUserId]);

  useEffect(() => { load(); }, [load]);

  const checkInToday = async () => {
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('check_in_attendance', { p_date: new Date().toISOString().slice(0, 10) });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Check-in submitted — waiting for manager/admin approval.');
      load();
    }
  };

  const submitLeave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!leaveStart || !leaveEnd) return;
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('submit_leave_request', {
      p_leave_type: leaveType,
      p_start: leaveStart,
      p_end: leaveEnd,
      p_reason: leaveReason || null,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Leave request submitted.');
      setLeaveStart('');
      setLeaveEnd('');
      setLeaveReason('');
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
      setMsg('Attendance marked.');
      load();
    }
  };

  const reviewAtt = async (id: string, approve: boolean) => {
    const { error } = await supabase.rpc('review_attendance', { p_record_id: id, p_approve: approve });
    if (error) setMsg(error.message);
    else load();
  };

  const reviewLeave = async (id: string, approve: boolean) => {
    const { error } = await supabase.rpc('review_leave_request', { p_request_id: id, p_approve: approve });
    if (error) setMsg(error.message);
    else load();
  };

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const checkedInToday = myAttendance.some((a) => a.attendance_date === todayStr);

  return (
    <div className="rewards-page animate-fade-in">
      {msg && (
        <div className={`rewards-toast ${msg.includes('Failed') || msg.includes('Not enough') || msg.includes('error') ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      {/* Leave balance */}
      {balance && (
        <div className="rewards-stats-grid">
          <div className="stat-card stat-card--accent">
            <Palmtree size={20} />
            <div>
              <div className="stat-card-value">{balance.annual_remaining}</div>
              <div className="stat-card-label">Annual leave left (of {balance.annual_allowance})</div>
            </div>
          </div>
          <div className="stat-card stat-card--warning">
            <Thermometer size={20} />
            <div>
              <div className="stat-card-value">{balance.sick_remaining}</div>
              <div className="stat-card-label">Sick leave left (of {balance.sick_allowance})</div>
            </div>
          </div>
          {summary && (
            <div className="stat-card">
              <CalendarCheck size={20} />
              <div>
                <div className="stat-card-value">{summary.attendance_rate}%</div>
                <div className="stat-card-label">Attendance rate ({summary.present_approved} approved days)</div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Employee: daily check-in */}
      {(mode === 'employee' || mode === 'manager') && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title"><UserCheck size={20} /> Daily Attendance</h3>
          <p className="rewards-section-desc">
            Check in each working day. Your manager{mode === 'manager' ? ' or admin' : ''} approves attendance records.
          </p>
          <button
            className="btn btn-primary"
            disabled={submitting || checkedInToday}
            onClick={checkInToday}
          >
            {checkedInToday ? <><CheckCircle size={16} /> Checked in today</> : <><Clock size={16} /> Check in for today</>}
          </button>
        </div>
      )}

      {/* Request leave */}
      <div className="glass-panel rewards-section">
        <h3 className="rewards-section-title"><Palmtree size={20} /> Request Leave</h3>
        {mode === 'manager' && (
          <p className="rewards-section-desc">Manager leave requests are approved by <strong>Admin</strong> only.</p>
        )}
        <form onSubmit={submitLeave} className="responsive-grid-wide" style={{ gap: '1rem', marginTop: '0.75rem' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Leave type</label>
            <select value={leaveType} onChange={(e) => setLeaveType(e.target.value as LeaveType)}>
              <option value="annual">Annual leave</option>
              <option value="sick">Sick leave</option>
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Start date</label>
            <input type="date" value={leaveStart} onChange={(e) => setLeaveStart(e.target.value)} required />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>End date</label>
            <input type="date" value={leaveEnd} onChange={(e) => setLeaveEnd(e.target.value)} required />
          </div>
          <div className="form-group" style={{ margin: 0, gridColumn: '1 / -1' }}>
            <label>Reason (optional)</label>
            <input type="text" value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} placeholder="Brief reason" />
          </div>
          <button type="submit" className="btn btn-primary" disabled={submitting}>Submit request</button>
        </form>
      </div>

      {/* Manager/Admin: mark team attendance */}
      {(mode === 'manager' || mode === 'admin') && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title"><Users size={20} /> Mark Team Attendance</h3>
          <div className="responsive-grid-wide" style={{ gap: '1rem' }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Employee</label>
              <select value={markUserId} onChange={(e) => setMarkUserId(e.target.value)}>
                {teamMembers.map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name} ({m.role})</option>
                ))}
              </select>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Date</label>
              <input type="date" value={markDate} onChange={(e) => setMarkDate(e.target.value)} />
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Status</label>
              <select value={markStatus} onChange={(e) => setMarkStatus(e.target.value as AttendanceStatus)}>
                {(Object.keys(ATTENDANCE_STATUS_LABEL) as AttendanceStatus[]).map((s) => (
                  <option key={s} value={s}>{ATTENDANCE_STATUS_LABEL[s]}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button type="button" className="btn btn-primary" disabled={submitting} onClick={markTeamAttendance}>
                Save attendance
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pending approvals */}
      {(mode === 'manager' || mode === 'admin') && (pendingAttendance.length > 0 || pendingLeaves.length > 0) && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title">Pending approvals</h3>
          {pendingAttendance.map((r) => (
            <div key={r.id} className="redemption-row redemption-row--pending" style={{ marginBottom: '0.5rem' }}>
              <div className="redemption-info">
                <strong>{(r as AttendanceRecord & { users?: { full_name: string } }).users?.full_name || 'Employee'}</strong>
                <span>{r.attendance_date} · {ATTENDANCE_STATUS_LABEL[r.status]} · check-in</span>
              </div>
              <div className="redemption-actions">
                <button className="btn btn-primary btn-sm" onClick={() => reviewAtt(r.id, true)}><CheckCircle size={14} /> Approve</button>
                <button className="btn btn-secondary btn-sm" onClick={() => reviewAtt(r.id, false)}><XCircle size={14} /> Reject</button>
              </div>
            </div>
          ))}
          {pendingLeaves.map((r) => {
            const u = (r as LeaveRequest & { users?: { full_name: string; role: string } }).users;
            const managerLeave = u?.role === 'manager';
            if (mode === 'manager' && managerLeave) return null;
            return (
              <div key={r.id} className="redemption-row redemption-row--pending" style={{ marginBottom: '0.5rem' }}>
                <div className="redemption-info">
                  <strong>{u?.full_name}</strong>
                  <span>{LEAVE_TYPE_LABEL[r.leave_type]} · {r.start_date} → {r.end_date} ({r.days_count} days)</span>
                  {r.reason && <span style={{ display: 'block', fontSize: '0.75rem' }}>{r.reason}</span>}
                </div>
                <div className="redemption-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => reviewLeave(r.id, true)}>Approve</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => reviewLeave(r.id, false)}>Reject</button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* My attendance history */}
      <div className="glass-panel rewards-section">
        <h3 className="rewards-section-title"><CalendarCheck size={20} /> My attendance (recent)</h3>
        {myAttendance.length === 0 ? (
          <div className="rewards-empty">No attendance records yet.</div>
        ) : (
          <div className="team-points-table-wrap">
            <table className="team-points-table">
              <thead>
                <tr><th>Date</th><th>Status</th><th>Approval</th></tr>
              </thead>
              <tbody>
                {myAttendance.map((r) => (
                  <tr key={r.id}>
                    <td>{r.attendance_date}</td>
                    <td>{ATTENDANCE_STATUS_LABEL[r.status]}</td>
                    <td><span className={`badge ${approvalBadgeClass(r.approval_status)}`}>{APPROVAL_LABEL[r.approval_status]}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* My leave requests */}
      <div className="glass-panel rewards-section">
        <h3 className="rewards-section-title">My leave requests</h3>
        {myLeaves.length === 0 ? (
          <div className="rewards-empty">No leave requests yet.</div>
        ) : (
          <div className="redemption-list">
            {myLeaves.map((r) => (
              <div key={r.id} className={`redemption-row redemption-row--${r.status === 'approved' ? 'fulfilled' : r.status === 'pending' ? 'pending' : 'approved'}`}>
                <div className="redemption-info">
                  <strong>{LEAVE_TYPE_LABEL[r.leave_type]}</strong>
                  <span>{r.start_date} → {r.end_date} ({r.days_count} days)</span>
                </div>
                <span className={`badge ${approvalBadgeClass(r.status)}`}>{APPROVAL_LABEL[r.status]}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
