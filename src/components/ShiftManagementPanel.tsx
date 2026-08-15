import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, Loader2, Plus, Trash2, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  DAY_LABELS,
  TeamShiftAssignment,
  WorkShift,
  formatShiftDays,
  formatShiftTimeRange,
  isOvernightShift,
} from '../utils/shiftHelpers';

interface OrgShiftAssignment extends TeamShiftAssignment {
  employee_role?: string;
}

interface ShiftManagementPanelProps {
  teamMembers: Profile[];
  mode?: 'manager' | 'admin';
  onUpdate?: () => void;
}

const DEFAULT_DAYS = [1, 2, 3, 4, 5];

export default function ShiftManagementPanel({
  teamMembers,
  mode = 'manager',
  onUpdate,
}: ShiftManagementPanelProps) {
  const isAdmin = mode === 'admin';
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [assignments, setAssignments] = useState<OrgShiftAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [grace, setGrace] = useState(30);
  const [days, setDays] = useState<number[]>(DEFAULT_DAYS);
  const [overnight, setOvernight] = useState(false);
  const [applyToAll, setApplyToAll] = useState(!isAdmin);
  const [editId, setEditId] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [assignShiftId, setAssignShiftId] = useState('');

  const assignablePeople = useMemo(
    () =>
      teamMembers
        .filter((m) => m.role === 'employee' || m.role === 'manager')
        .slice()
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [teamMembers],
  );

  const employeeCount = teamMembers.filter((m) => m.role === 'employee').length;

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    const assignmentRpc = isAdmin ? 'get_org_shift_assignments' : 'get_team_shift_assignments';
    const [shRes, asRes] = await Promise.all([
      supabase.rpc('get_manager_shifts'),
      supabase.rpc(assignmentRpc),
    ]);
    if (shRes.error) setMsg(`Could not load shifts: ${shRes.error.message}`);
    else setShifts((shRes.data || []) as WorkShift[]);
    if (asRes.error && !shRes.error) setMsg(asRes.error.message);
    else setAssignments((asRes.data || []) as OrgShiftAssignment[]);
    setLoading(false);
  }, [isAdmin]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!overnight && isOvernightShift(startTime, endTime)) {
      setOvernight(true);
    }
  }, [startTime, endTime, overnight]);

  const toggleDay = (d: number) => {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  };

  const toggleUser = (id: string) => {
    setSelectedUserIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const toggleAllUsers = () => {
    if (selectedUserIds.length === assignablePeople.length) {
      setSelectedUserIds([]);
      return;
    }
    setSelectedUserIds(assignablePeople.map((p) => p.id));
  };

  const resetForm = () => {
    setEditId(null);
    setName('');
    setStartTime('09:00');
    setEndTime('18:00');
    setGrace(30);
    setDays(DEFAULT_DAYS);
    setOvernight(false);
    setApplyToAll(!isAdmin);
  };

  const saveShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || days.length === 0) return;
    if (!overnight && endTime <= startTime) {
      setMsg('End time must be after start time, or enable overnight shift.');
      return;
    }
    setSubmitting(true);
    setMsg('');
    const payload: Record<string, unknown> = {
      p_name: name.trim(),
      p_start_time: startTime,
      p_end_time: endTime,
      p_days_of_week: days,
      p_grace_minutes: grace,
      p_crosses_midnight: overnight,
      p_apply_to_all: isAdmin ? false : applyToAll,
    };
    if (editId) payload.p_shift_id = editId;

    const { data, error } = await supabase.rpc('upsert_work_shift', payload);
    setSubmitting(false);
    if (error || !data) {
      setMsg(error?.message || 'Unknown error saving shift');
      return;
    }

    const shiftId = data as string;

    if (!isAdmin && applyToAll && employeeCount > 0) {
      const { error: assignErr } = await supabase.rpc('assign_shift_to_all_team', { p_shift_id: shiftId });
      if (assignErr && !/does not exist/i.test(assignErr.message)) {
        setMsg(`Shift saved but team assign failed: ${assignErr.message}`);
        await load();
        onUpdate?.();
        return;
      }
    }

    if (isAdmin && selectedUserIds.length > 0) {
      const { data: assigned, error: assignErr } = await supabase.rpc('admin_assign_shift', {
        p_shift_id: shiftId,
        p_user_ids: selectedUserIds,
      });
      if (assignErr) {
        setMsg(`Shift saved but assign failed: ${assignErr.message}`);
        await load();
        onUpdate?.();
        return;
      }
      setMsg(`Shift saved and assigned to ${assigned ?? selectedUserIds.length} people.`);
      setSelectedUserIds([]);
      setAssignShiftId(shiftId);
    } else {
      setMsg(
        editId
          ? `Shift updated${!isAdmin && applyToAll ? ` and applied to ${employeeCount} employee(s).` : '.'}`
          : `Shift saved${!isAdmin && applyToAll ? ` and applied to all ${employeeCount} team member(s).` : '.'}`,
      );
    }

    resetForm();
    await load();
    onUpdate?.();
  };

  const removeShift = async (id: string) => {
    if (!confirm('Delete this shift? Assigned people will need a new shift.')) return;
    setSubmitting(true);
    const { error } = await supabase.rpc('delete_work_shift', { p_shift_id: id });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Shift deleted.');
      await load();
    }
  };

  const reapplyToAll = async (shiftId: string) => {
    setSubmitting(true);
    setMsg('');
    const { data, error } = await supabase.rpc('assign_shift_to_all_team', { p_shift_id: shiftId });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg(`Shift applied to ${data ?? employeeCount} employee(s).`);
      await load();
    }
  };

  const assignSelected = async () => {
    if (!assignShiftId) {
      setMsg('Select a saved shift to assign.');
      return;
    }
    if (selectedUserIds.length === 0) {
      setMsg('Select at least one manager or employee.');
      return;
    }
    setSubmitting(true);
    setMsg('');
    const { data, error } = await supabase.rpc('admin_assign_shift', {
      p_shift_id: assignShiftId,
      p_user_ids: selectedUserIds,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg(`Assigned shift to ${data ?? selectedUserIds.length} people.`);
      await load();
      onUpdate?.();
    }
  };

  const startEdit = (s: WorkShift) => {
    setEditId(s.id);
    setName(s.name);
    setStartTime(s.start_time.slice(0, 5));
    setEndTime(s.end_time.slice(0, 5));
    setGrace(s.grace_minutes);
    setDays(s.days_of_week);
    setOvernight(s.crosses_midnight ?? isOvernightShift(s.start_time, s.end_time));
    setApplyToAll(isAdmin ? false : (s.apply_to_all ?? true));
    setAssignShiftId(s.id);
  };

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  return (
    <div className="shift-management">
      {msg && (
        <div className={`rewards-toast ${/failed|error|must|select/i.test(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="attendance-card">
        <h3 className="attendance-card__title">
          <CalendarClock size={18} /> {editId ? 'Edit shift' : 'Create shift'}
        </h3>
        <p className="attendance-card__subtitle">
          {isAdmin
            ? 'Create any schedule (including overnight), then assign it directly to managers and employees in your organization.'
            : 'Set any shift schedule — including overnight (e.g. 8:00 PM today to 8:00 AM tomorrow). When saved, it can be applied to all employees on your team.'}
        </p>
        <form onSubmit={saveShift} className="attendance-form-grid attendance-form-grid--wide">
          <div className="form-group">
            <label>Shift name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Night Shift" required />
          </div>
          <div className="form-group">
            <label>Start time</label>
            <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>End time</label>
            <input type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Early check-in (minutes)</label>
            <input type="number" min={0} max={120} value={grace} onChange={(e) => setGrace(Number(e.target.value))} />
          </div>
          <div className="form-group attendance-form-span-full">
            <label className="geo-toggle-row" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={overnight}
                onChange={(e) => setOvernight(e.target.checked)}
              />
              <span>Overnight shift — end time is on the <strong>next day</strong> (e.g. 8 PM → 8 AM)</span>
            </label>
          </div>
          {!isAdmin && (
            <div className="form-group attendance-form-span-full">
              <label className="geo-toggle-row" style={{ margin: 0 }}>
                <input
                  type="checkbox"
                  checked={applyToAll}
                  onChange={(e) => setApplyToAll(e.target.checked)}
                />
                <span>Apply to all team employees ({employeeCount}) when saved</span>
              </label>
            </div>
          )}
          <div className="form-group attendance-form-span-full">
            <label>Work days</label>
            <div className="shift-day-picker">
              {DAY_LABELS.map((label, i) => {
                const d = i + 1;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`shift-day-btn ${days.includes(d) ? 'shift-day-btn--active' : ''}`}
                    onClick={() => toggleDay(d)}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="attendance-form-span-full" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="submit" className="btn btn-primary" disabled={submitting || days.length === 0}>
              {submitting ? <Loader2 size={16} className="spin-icon" /> : editId ? 'Save shift' : <><Plus size={16} /> Save shift</>}
            </button>
            {editId && (
              <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
            )}
          </div>
        </form>
      </div>

      {isAdmin && (
        <div className="attendance-card">
          <h3 className="attendance-card__title">
            <Users size={18} /> Assign shift to managers &amp; employees
          </h3>
          <p className="attendance-card__subtitle">
            Choose a saved shift, select people, then assign in one click.
          </p>
          <div className="form-group">
            <label>Shift</label>
            <select value={assignShiftId} onChange={(e) => setAssignShiftId(e.target.value)}>
              <option value="">— Select shift —</option>
              {shifts.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({formatShiftTimeRange(s.start_time, s.end_time, s.crosses_midnight)})
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ marginTop: '0.75rem' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.4rem' }}>
              <label style={{ margin: 0 }}>People ({selectedUserIds.length} selected)</label>
              <button type="button" className="btn btn-secondary btn-sm" onClick={toggleAllUsers}>
                {selectedUserIds.length === assignablePeople.length ? 'Clear all' : 'Select all'}
              </button>
            </div>
            <div className="shift-assign-list">
              {assignablePeople.length === 0 ? (
                <p className="attendance-card__subtitle">No managers or employees yet. Add users first.</p>
              ) : (
                assignablePeople.map((p) => (
                  <label key={p.id} className="shift-assign-row">
                    <input
                      type="checkbox"
                      checked={selectedUserIds.includes(p.id)}
                      onChange={() => toggleUser(p.id)}
                    />
                    <span>
                      <strong>{p.full_name}</strong>
                      <span className="shift-assign-meta"> · {p.role} · {p.email}</span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
          <button
            type="button"
            className="btn btn-primary"
            style={{ marginTop: '0.85rem' }}
            disabled={submitting || !assignShiftId || selectedUserIds.length === 0}
            onClick={() => void assignSelected()}
          >
            {submitting ? <Loader2 size={16} className="spin-icon" /> : <Users size={16} />}
            Assign to selected
          </button>
        </div>
      )}

      {shifts.length > 0 && (
        <div className="attendance-card">
          <h3 className="attendance-card__title">Saved shifts</h3>
          <div className="shift-list">
            {shifts.map((s) => (
              <div key={s.id} className="shift-list__item">
                <div>
                  <strong>{s.name}</strong>
                  <span className="shift-list__meta">
                    {formatShiftTimeRange(s.start_time, s.end_time, s.crosses_midnight)}
                    {' · '}{formatShiftDays(s.days_of_week)}
                    {!isAdmin && s.apply_to_all && ' · All team'}
                    {s.assigned_count != null && s.assigned_count > 0 && ` · ${s.assigned_count} assigned`}
                  </span>
                </div>
                <div className="shift-list__actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(s)}>Edit</button>
                  {!isAdmin && (
                    <button type="button" className="btn btn-secondary btn-sm" disabled={submitting} onClick={() => void reapplyToAll(s.id)} title="Apply to all team">
                      <Users size={14} />
                    </button>
                  )}
                  {isAdmin && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setAssignShiftId(s.id)}
                      title="Use for assignment"
                    >
                      Assign
                    </button>
                  )}
                  <button type="button" className="btn btn-secondary btn-sm" disabled={submitting} onClick={() => void removeShift(s.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {assignments.length > 0 && (
        <div className="attendance-card">
          <h3 className="attendance-card__title">
            <Users size={18} /> {isAdmin ? 'Organization shift status' : 'Team shift status'}
          </h3>
          <div className="team-points-table-wrap">
            <table className="attendance-history-table">
              <thead>
                <tr>
                  <th>{isAdmin ? 'Person' : 'Employee'}</th>
                  {isAdmin && <th>Role</th>}
                  <th>Shift</th>
                  <th>Hours</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => (
                  <tr key={a.user_id}>
                    <td>{a.full_name}</td>
                    {isAdmin && <td style={{ textTransform: 'capitalize' }}>{a.employee_role || '—'}</td>}
                    <td>{a.shift_name || '—'}</td>
                    <td>{a.start_time && a.end_time ? formatShiftTimeRange(a.start_time, a.end_time) : '—'}</td>
                    <td>{a.effective_from || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
