import { useCallback, useEffect, useState } from 'react';
import { CalendarClock, Loader2, Plus, Trash2, UserPlus } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import {
  DAY_LABELS,
  TeamShiftAssignment,
  WorkShift,
  formatShiftDays,
  formatShiftTime,
} from '../utils/shiftHelpers';

interface ShiftManagementPanelProps {
  teamMembers: Profile[];
  onUpdate?: () => void;
}

const DEFAULT_DAYS = [1, 2, 3, 4, 5];

export default function ShiftManagementPanel({ teamMembers, onUpdate }: ShiftManagementPanelProps) {
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [assignments, setAssignments] = useState<TeamShiftAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [grace, setGrace] = useState(30);
  const [days, setDays] = useState<number[]>(DEFAULT_DAYS);
  const [editId, setEditId] = useState<string | null>(null);

  const [assignUserId, setAssignUserId] = useState('');
  const [assignShiftId, setAssignShiftId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    const [shRes, asRes] = await Promise.all([
      supabase.rpc('get_manager_shifts'),
      supabase.rpc('get_team_shift_assignments'),
    ]);
    if (shRes.error) setMsg(shRes.error.message);
    else setShifts((shRes.data || []) as WorkShift[]);
    if (asRes.error && !shRes.error) setMsg(asRes.error.message);
    else setAssignments((asRes.data || []) as TeamShiftAssignment[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const employees = teamMembers.filter((m) => m.role === 'employee');
    if (employees[0] && !assignUserId) setAssignUserId(employees[0].id);
    if (shifts[0] && !assignShiftId) setAssignShiftId(shifts[0].id);
  }, [teamMembers, shifts, assignUserId, assignShiftId]);

  const toggleDay = (d: number) => {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  };

  const resetForm = () => {
    setEditId(null);
    setName('');
    setStartTime('09:00');
    setEndTime('18:00');
    setGrace(30);
    setDays(DEFAULT_DAYS);
  };

  const saveShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || days.length === 0) return;
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('upsert_work_shift', {
      p_name: name.trim(),
      p_start_time: startTime,
      p_end_time: endTime,
      p_days_of_week: days,
      p_grace_minutes: grace,
      p_shift_id: editId,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg(editId ? 'Shift updated.' : 'Shift created.');
      resetForm();
      await load();
      onUpdate?.();
    }
  };

  const removeShift = async (id: string) => {
    if (!confirm('Delete this shift? Assigned employees will need a new shift.')) return;
    setSubmitting(true);
    const { error } = await supabase.rpc('delete_work_shift', { p_shift_id: id });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Shift deleted.');
      await load();
    }
  };

  const assignShift = async () => {
    if (!assignUserId || !assignShiftId) return;
    setSubmitting(true);
    setMsg('');
    const { error } = await supabase.rpc('assign_employee_shift', {
      p_user_id: assignUserId,
      p_shift_id: assignShiftId,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Shift assigned to employee.');
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
        <div className={`rewards-toast ${/failed|error|not/i.test(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="attendance-card">
        <h3 className="attendance-card__title">
          <CalendarClock size={18} /> {editId ? 'Edit shift' : 'Create shift'}
        </h3>
        <p className="attendance-card__subtitle">
          Define when your team should be at the office. GPS attendance auto-starts when they enter the radius during shift hours.
        </p>
        <form onSubmit={saveShift} className="attendance-form-grid attendance-form-grid--wide">
          <div className="form-group">
            <label>Shift name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Morning Shift" required />
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
              {submitting ? <Loader2 size={16} className="spin-icon" /> : editId ? 'Save changes' : <><Plus size={16} /> Create shift</>}
            </button>
            {editId && (
              <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
            )}
          </div>
        </form>
      </div>

      {shifts.length > 0 && (
        <div className="attendance-card">
          <h3 className="attendance-card__title">Your shifts</h3>
          <div className="shift-list">
            {shifts.map((s) => (
              <div key={s.id} className="shift-list__item">
                <div>
                  <strong>{s.name}</strong>
                  <span className="shift-list__meta">
                    {formatShiftTime(s.start_time)} – {formatShiftTime(s.end_time)} · {formatShiftDays(s.days_of_week)}
                    {s.assigned_count != null && s.assigned_count > 0 && ` · ${s.assigned_count} assigned`}
                  </span>
                </div>
                <div className="shift-list__actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(s)}>Edit</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={submitting} onClick={() => void removeShift(s.id)}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="attendance-card">
        <h3 className="attendance-card__title"><UserPlus size={18} /> Assign shift to employee</h3>
        {teamMembers.filter((m) => m.role === 'employee').length === 0 ? (
          <p className="attendance-empty">No employees on your team yet.</p>
        ) : shifts.length === 0 ? (
          <p className="attendance-empty">Create a shift first, then assign it.</p>
        ) : (
          <div className="attendance-form-grid">
            <div className="form-group">
              <label>Employee</label>
              <select value={assignUserId} onChange={(e) => setAssignUserId(e.target.value)}>
                {teamMembers.filter((m) => m.role === 'employee').map((m) => (
                  <option key={m.id} value={m.id}>{m.full_name}</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Shift</label>
              <select value={assignShiftId} onChange={(e) => setAssignShiftId(e.target.value)}>
                {shifts.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} ({formatShiftTime(s.start_time)}–{formatShiftTime(s.end_time)})</option>
                ))}
              </select>
            </div>
            <button type="button" className="btn btn-primary" disabled={submitting} onClick={() => void assignShift()}>
              Assign shift
            </button>
          </div>
        )}

        {assignments.length > 0 && (
          <>
            <h4 className="shift-section-label">Current team assignments</h4>
            <div className="team-points-table-wrap">
              <table className="attendance-history-table">
                <thead>
                  <tr><th>Employee</th><th>Shift</th><th>Hours</th><th>Since</th></tr>
                </thead>
                <tbody>
                  {assignments.map((a) => (
                    <tr key={a.user_id}>
                      <td>{a.full_name}</td>
                      <td>{a.shift_name || '—'}</td>
                      <td>{a.start_time ? `${formatShiftTime(a.start_time)} – ${formatShiftTime(a.end_time)}` : '—'}</td>
                      <td>{a.effective_from || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
