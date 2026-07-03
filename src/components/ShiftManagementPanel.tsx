import { useCallback, useEffect, useState } from 'react';
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
  const [overnight, setOvernight] = useState(false);
  const [applyToAll, setApplyToAll] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);

  const employeeCount = teamMembers.filter((m) => m.role === 'employee').length;

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    const [shRes, asRes] = await Promise.all([
      supabase.rpc('get_manager_shifts'),
      supabase.rpc('get_team_shift_assignments'),
    ]);
    if (shRes.error) setMsg(`Could not load shifts: ${shRes.error.message}`);
    else setShifts((shRes.data || []) as WorkShift[]);
    if (asRes.error && !shRes.error) setMsg(asRes.error.message);
    else setAssignments((asRes.data || []) as TeamShiftAssignment[]);
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!overnight && isOvernightShift(startTime, endTime)) {
      setOvernight(true);
    }
  }, [startTime, endTime, overnight]);

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
    setOvernight(false);
    setApplyToAll(true);
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
      p_apply_to_all: applyToAll,
    };
    if (editId) payload.p_shift_id = editId;

    let shiftId: string | null = null;
    let errorMsg = '';

    const v2 = await supabase.rpc('upsert_work_shift', payload);
    if (v2.error) {
      errorMsg = v2.error.message;
      // Fallback for DB that only has v1 migration applied
      if (/does not exist|Could not find|apply_to_all|crosses_midnight/i.test(v2.error.message)) {
        if (overnight) {
          setSubmitting(false);
          setMsg('Overnight shifts require database migration. Run: cd ~/walfia.ai && node scripts/shift-attendance-migration.mjs');
          return;
        }
        const v1Payload: Record<string, unknown> = {
          p_name: name.trim(),
          p_start_time: startTime,
          p_end_time: endTime,
          p_days_of_week: days,
          p_grace_minutes: grace,
        };
        if (editId) v1Payload.p_shift_id = editId;
        const v1 = await supabase.rpc('upsert_work_shift', v1Payload);
        if (v1.error) errorMsg = v1.error.message;
        else shiftId = v1.data as string;
      }
    } else {
      shiftId = v2.data as string;
    }

    setSubmitting(false);
    if (!shiftId) {
      const hint = /does not exist/i.test(errorMsg)
        ? `${errorMsg} — Run migration: cd ~/walfia.ai && node scripts/shift-attendance-migration.mjs`
        : errorMsg || 'Unknown error saving shift';
      setMsg(hint);
      return;
    }

    if (applyToAll && employeeCount > 0) {
      const { error: assignErr } = await supabase.rpc('assign_shift_to_all_team', { p_shift_id: shiftId });
      if (assignErr && !/does not exist/i.test(assignErr.message)) {
        setMsg(`Shift saved but team assign failed: ${assignErr.message}`);
        await load();
        onUpdate?.();
        return;
      }
    }
    setMsg(
      editId
        ? `Shift updated${applyToAll ? ` and applied to ${employeeCount} employee(s).` : '.'}`
        : `Shift saved${applyToAll ? ` and applied to all ${employeeCount} team member(s).` : '.'}`,
    );
    resetForm();
    await load();
    onUpdate?.();
  };

  const removeShift = async (id: string) => {
    if (!confirm('Delete this shift? Team members will need a new shift.')) return;
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

  const startEdit = (s: WorkShift) => {
    setEditId(s.id);
    setName(s.name);
    setStartTime(s.start_time.slice(0, 5));
    setEndTime(s.end_time.slice(0, 5));
    setGrace(s.grace_minutes);
    setDays(s.days_of_week);
    setOvernight(s.crosses_midnight ?? isOvernightShift(s.start_time, s.end_time));
    setApplyToAll(s.apply_to_all ?? true);
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
        <div className={`rewards-toast ${/failed|error|must/i.test(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="attendance-card">
        <h3 className="attendance-card__title">
          <CalendarClock size={18} /> {editId ? 'Edit shift' : 'Create shift'}
        </h3>
        <p className="attendance-card__subtitle">
          Set any shift schedule — including overnight (e.g. 8:00 PM today to 8:00 AM tomorrow).
          When saved, it is automatically applied to all employees on your team.
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
              {submitting ? <Loader2 size={16} className="spin-icon" /> : editId ? 'Save & apply' : <><Plus size={16} /> Save shift</>}
            </button>
            {editId && (
              <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
            )}
          </div>
        </form>
      </div>

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
                    {s.apply_to_all && ' · All team'}
                    {s.assigned_count != null && s.assigned_count > 0 && ` · ${s.assigned_count} assigned`}
                  </span>
                </div>
                <div className="shift-list__actions">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(s)}>Edit</button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={submitting} onClick={() => void reapplyToAll(s.id)} title="Apply to all team">
                    <Users size={14} />
                  </button>
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
          <h3 className="attendance-card__title"><Users size={18} /> Team shift status</h3>
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
