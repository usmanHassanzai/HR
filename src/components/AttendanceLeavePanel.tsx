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
import {
  CalendarCheck, Clock, Loader2, CheckCircle, XCircle, Palmtree, Thermometer,
  UserCheck, Users, Download, Mail,
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
  const [monthlySummary, setMonthlySummary] = useState<AttendanceSummary | null>(null);
  const [yearLeaveSummary, setYearLeaveSummary] = useState<LeaveSummary | null>(null);
  const [monthLeaveSummary, setMonthLeaveSummary] = useState<LeaveSummary | null>(null);
  const [myAttendance, setMyAttendance] = useState<AttendanceRecord[]>([]);
  const [myLeaves, setMyLeaves] = useState<LeaveRequest[]>([]);
  const [pendingAttendance, setPendingAttendance] = useState<PendingAttendanceRecord[]>([]);
  const [pendingLeaves, setPendingLeaves] = useState<PendingLeaveRequest[]>([]);
  const [teamMembers, setTeamMembers] = useState<Profile[]>([]);

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
  const canExportCsv = mode === 'employee' || mode === 'manager';

  const fetchPendingLeaves = async (): Promise<PendingLeaveRequest[]> => {
    const { data, error } = await supabase.rpc('get_pending_leave_requests');
    if (error) {
      console.warn('Pending leaves load failed:', error.message);
      return [];
    }
    return (data || []) as PendingLeaveRequest[];
  };

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    try {
      if (mode === 'admin') {
        setPendingLeaves(await fetchPendingLeaves());
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
        const { data: reports } = await supabase.rpc('get_direct_reports', { p_manager_id: userId });
        setTeamMembers((reports || []) as Profile[]);
        if (reports?.[0] && !markUserId) setMarkUserId(reports[0].id);

        const { data: pAtt } = await supabase.rpc('get_pending_attendance_for_manager');
        setPendingAttendance((pAtt || []) as PendingAttendanceRecord[]);
        setPendingLeaves(await fetchPendingLeaves());
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
    const { error } = await supabase.rpc('check_in_attendance', { p_date: new Date().toISOString().slice(0, 10) });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Check-in submitted — waiting for manager approval.');
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
          ? 'Leave request submitted — admins have been notified by email.'
          : 'Leave request submitted — your manager has been notified by email.'
      );
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
    else {
      setMsg(approve ? 'Leave request approved.' : 'Leave request rejected.');
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

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const checkedInToday = myAttendance.some((a) => a.attendance_date === todayStr);

  if (mode === 'admin') {
    return (
      <div className="rewards-page animate-fade-in">
        {msg && (
          <div className={`rewards-toast ${msg.includes('Failed') || msg.includes('error') ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
            {msg}
          </div>
        )}
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title">Leave request approvals</h3>
          <p className="rewards-section-desc">
            Approve or reject leave requests from employees and managers. Employee leave approved by a manager does not require admin approval.
          </p>
          {pendingLeaves.length === 0 ? (
            <div className="rewards-empty">No pending leave requests.</div>
          ) : (
            pendingLeaves.map((r) => (
              <div key={r.id} className="redemption-row redemption-row--pending" style={{ marginBottom: '0.5rem' }}>
                <div className="redemption-info">
                  <strong>{r.employee_name}</strong>
                  <span style={{ marginLeft: '0.5rem', fontSize: '0.75rem', textTransform: 'capitalize' }}>({r.employee_role})</span>
                  <span>{LEAVE_TYPE_LABEL[r.leave_type]} · {r.start_date} → {r.end_date} ({r.days_count} days)</span>
                  {r.reason && <span style={{ display: 'block', fontSize: '0.75rem' }}>{r.reason}</span>}
                </div>
                <div className="redemption-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => reviewLeave(r.id, true)}><CheckCircle size={14} /> Approve</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => reviewLeave(r.id, false)}><XCircle size={14} /> Reject</button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rewards-page animate-fade-in">
      {msg && (
        <div className={`rewards-toast ${msg.includes('Failed') || msg.includes('Not enough') || msg.includes('error') ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      {/* Period selector */}
      <div className="glass-panel rewards-section" style={{ padding: '1rem 1.25rem' }}>
        <div className="responsive-grid-wide" style={{ gap: '1rem', alignItems: 'end' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Month</label>
            <select value={selectedMonth} onChange={(e) => setSelectedMonth(Number(e.target.value))}>
              {Array.from({ length: 12 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {new Date(selectedYear, i, 1).toLocaleString('default', { month: 'long' })}
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Year</label>
            <select value={selectedYear} onChange={(e) => setSelectedYear(Number(e.target.value))}>
              {[selectedYear - 1, selectedYear, selectedYear + 1].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          {canExportCsv && (
            <button type="button" className="btn btn-secondary" disabled={exporting} onClick={exportCsv}>
              {exporting ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
              Download CSV ({monthLabel})
            </button>
          )}
        </div>
      </div>

      {/* Monthly & yearly stats */}
      {(monthlySummary || yearLeaveSummary) && (
        <div className="rewards-stats-grid">
          {monthlySummary && (
            <>
              <div className="stat-card stat-card--accent">
                <CalendarCheck size={20} />
                <div>
                  <div className="stat-card-value">{monthlySummary.present_approved}</div>
                  <div className="stat-card-label">Present days this month ({monthLabel})</div>
                </div>
              </div>
              <div className="stat-card">
                <CalendarCheck size={20} />
                <div>
                  <div className="stat-card-value">{monthlySummary.attendance_rate}%</div>
                  <div className="stat-card-label">Monthly attendance rate</div>
                </div>
              </div>
            </>
          )}
          {monthLeaveSummary && (
            <div className="stat-card stat-card--warning">
              <Palmtree size={20} />
              <div>
                <div className="stat-card-value">{monthLeaveSummary.total_days_taken}</div>
                <div className="stat-card-label">Leave days taken this month</div>
              </div>
            </div>
          )}
          {yearLeaveSummary && (
            <div className="stat-card">
              <Thermometer size={20} />
              <div>
                <div className="stat-card-value">{yearLeaveSummary.total_days_taken}</div>
                <div className="stat-card-label">Total leave days this year ({yearLeaveSummary.annual_days_taken} annual, {yearLeaveSummary.sick_days_taken} sick)</div>
              </div>
            </div>
          )}
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
            Check in each working day. Your {mode === 'manager' ? 'admin' : 'manager'} approves attendance records.
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
        {mode === 'manager' ? (
          <p className="rewards-section-desc">
            <Mail size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Manager leave requests are sent to <strong>admin email</strong> and approved in the admin dashboard.
          </p>
        ) : mode === 'employee' ? (
          <p className="rewards-section-desc">
            <Mail size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            Your manager will receive an <strong>email notification</strong> and can approve from their dashboard. Manager approval is final — you do not need admin approval.
          </p>
        ) : null}
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

      {/* Manager: mark team attendance & approve employee leave */}
      {mode === 'manager' && (
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

      {mode === 'manager' && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title">Employee leave approvals</h3>
          <p className="rewards-section-desc">Review and approve leave requests from your team. Your approval is sufficient — employees do not need admin approval.</p>
          {pendingLeaves.length === 0 ? (
            <div className="rewards-empty">No pending employee leave requests.</div>
          ) : (
            pendingLeaves.map((r) => (
              <div key={r.id} className="redemption-row redemption-row--pending" style={{ marginBottom: '0.5rem' }}>
                <div className="redemption-info">
                  <strong>{r.employee_name}</strong>
                  <span>{LEAVE_TYPE_LABEL[r.leave_type]} · {r.start_date} → {r.end_date} ({r.days_count} days)</span>
                  {r.reason && <span style={{ display: 'block', fontSize: '0.75rem' }}>{r.reason}</span>}
                </div>
                <div className="redemption-actions">
                  <button className="btn btn-primary btn-sm" onClick={() => reviewLeave(r.id, true)}><CheckCircle size={14} /> Approve</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => reviewLeave(r.id, false)}><XCircle size={14} /> Reject</button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {mode === 'manager' && pendingAttendance.length > 0 && (
        <div className="glass-panel rewards-section">
          <h3 className="rewards-section-title">Employee attendance approvals</h3>
          {pendingAttendance.map((r) => (
            <div key={r.id} className="redemption-row redemption-row--pending" style={{ marginBottom: '0.5rem' }}>
              <div className="redemption-info">
                <strong>{r.employee_name || 'Employee'}</strong>
                <span>{r.attendance_date} · {ATTENDANCE_STATUS_LABEL[r.status]} · check-in</span>
              </div>
              <div className="redemption-actions">
                <button className="btn btn-primary btn-sm" onClick={() => reviewAtt(r.id, true)}><CheckCircle size={14} /> Approve</button>
                <button className="btn btn-secondary btn-sm" onClick={() => reviewAtt(r.id, false)}><XCircle size={14} /> Reject</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* My attendance history */}
      <div className="glass-panel rewards-section">
        <h3 className="rewards-section-title"><CalendarCheck size={20} /> My attendance — {monthLabel}</h3>
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
