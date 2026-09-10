import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  mode?: 'manager' | 'admin' | 'hr';
  onUpdate?: () => void;
}

const DEFAULT_DAYS = [1, 2, 3, 4, 5];

export default function ShiftManagementPanel({
  teamMembers,
  mode = 'manager',
  onUpdate,
}: ShiftManagementPanelProps) {
  const isOrgWide = mode === 'admin' || mode === 'hr';
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [assignments, setAssignments] = useState<OrgShiftAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [overnight, setOvernight] = useState(false);
  const [days, setDays] = useState<number[]>(DEFAULT_DAYS);
  const [applyToAll, setApplyToAll] = useState(true);
  const [editId, setEditId] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [assignShiftId, setAssignShiftId] = useState('');
  const formCardRef = useRef<HTMLDivElement | null>(null);
  const assignCardRef = useRef<HTMLDivElement | null>(null);

  const assignablePeople = useMemo(
    () =>
      teamMembers
        .filter((m) => m.role === 'employee' || m.role === 'manager' || m.role === 'hr')
        .slice()
        .sort((a, b) => a.full_name.localeCompare(b.full_name)),
    [teamMembers],
  );

  const employeeCount = teamMembers.filter((m) => m.role === 'employee').length;

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    const assignmentRpc = isOrgWide ? 'get_org_shift_assignments' : 'get_team_shift_assignments';
    const [shRes, asRes] = await Promise.all([
      supabase.rpc('get_manager_shifts'),
      supabase.rpc(assignmentRpc),
    ]);
    if (shRes.error) setMsg(`Could not load shifts: ${shRes.error.message}`);
    else setShifts((shRes.data || []) as WorkShift[]);
    if (asRes.error && !shRes.error) setMsg(asRes.error.message);
    else setAssignments((asRes.data || []) as OrgShiftAssignment[]);
    setLoading(false);
  }, [isOrgWide]);

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
      p_grace_minutes: 60,
      p_crosses_midnight: overnight,
      p_apply_to_all: applyToAll,
    };
    if (editId) payload.p_shift_id = editId;

    const { data, error } = await supabase.rpc('upsert_work_shift', payload);
    setSubmitting(false);
    if (error || !data) {
      setMsg(error?.message || 'Unknown error saving shift');
      return;
    }

    const shiftId = data as string;

    if (!isOrgWide && applyToAll && employeeCount > 0) {
      const { error: assignErr } = await supabase.rpc('assign_shift_to_all_team', { p_shift_id: shiftId });
      if (assignErr && !/does not exist/i.test(assignErr.message)) {
        setMsg(`Shift saved but team assign failed: ${assignErr.message}`);
        await load();
        onUpdate?.();
        return;
      }
    }

    if (isOrgWide && applyToAll && assignablePeople.length > 0) {
      const { data: assigned, error: assignErr } = await supabase.rpc('admin_assign_shift', {
        p_shift_id: shiftId,
        p_user_ids: assignablePeople.map((p) => p.id),
      });
      if (assignErr) {
        setMsg(`Shift saved but assign failed: ${assignErr.message}`);
        await load();
        onUpdate?.();
        return;
      }
      setMsg(`Shift saved and assigned to ${assigned ?? assignablePeople.length} people.`);
      setSelectedUserIds([]);
      setAssignShiftId(shiftId);
    } else if (isOrgWide && selectedUserIds.length > 0) {
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
          ? `Shift updated${!isOrgWide && applyToAll ? ` and applied to ${employeeCount} employee(s).` : '.'}`
          : `Shift saved${!isOrgWide && applyToAll ? ` and applied to all ${employeeCount} team member(s).` : '.'}`,
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
    const daysRaw = Array.isArray(s.days_of_week) ? s.days_of_week : [];
    const nextDays = daysRaw.map((d) => Number(d)).filter((d) => d >= 1 && d <= 7);
    setEditId(s.id);
    setName(s.name || '');
    setStartTime(String(s.start_time || '09:00').slice(0, 5));
    setEndTime(String(s.end_time || '18:00').slice(0, 5));
    setDays(nextDays.length > 0 ? nextDays : DEFAULT_DAYS);
    setOvernight(Boolean(s.crosses_midnight ?? isOvernightShift(s.start_time, s.end_time)));
    setApplyToAll(s.apply_to_all ?? true);
    setAssignShiftId(s.id);
    setMsg(`Editing “${s.name}”. Change the fields above, then Save shift.`);
    window.requestAnimationFrame(() => {
      formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const nameInput = formCardRef.current?.querySelector<HTMLInputElement>('input:not([type="time"]):not([type="checkbox"])');
      nameInput?.focus({ preventScroll: true });
    });
  };

  const startAssign = (s: WorkShift) => {
    setAssignShiftId(s.id);
    setMsg(`Assigning “${s.name}”. Select people below, then Assign to selected.`);
    window.requestAnimationFrame(() => {
      assignCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
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

      <div
        ref={formCardRef}
        className={`attendance-card${editId ? ' attendance-card--editing' : ''}`}
        id="shift-editor"
      >
        <h3 className="attendance-card__title">
          <CalendarClock size={18} /> {editId ? 'Edit shift' : 'Create shift'}
        </h3>
        {editId ? (
          <p className="attendance-card__subtitle attendance-card__subtitle--edit">
            You are editing <strong>{name || 'this shift'}</strong>. Update times or days, then tap Save shift.
          </p>
        ) : (
          <p className="attendance-card__subtitle">
            {isOrgWide
              ? 'Create any schedule (including overnight), then assign it directly to any person in your organization. No extra approval is required.'
              : 'Set any shift schedule — including overnight (e.g. 8:00 PM today to 8:00 AM tomorrow). When saved, it can be applied to all employees on your team.'}
          </p>
        )}
        <form onSubmit={(e) => void saveShift(e)} className="attendance-form-grid attendance-form-grid--wide">
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
          <div className="form-group attendance-form-span-full">
            <p className="attendance-card__subtitle" style={{ margin: 0 }}>
              Everyone can clock in from 1 hour before this start time. After the end time they have 1 hour to clock out — that extra time is counted if they do it themselves. If Scorr is closed, they are checked out at end time. If they stay logged in, checkout waits that extra hour.
            </p>
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
              <span>
                {isOrgWide
                  ? `Apply to everyone in the organization (${assignablePeople.length}) when saved`
                  : `Apply to all team employees (${employeeCount}) when saved`}
              </span>
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
              {submitting ? <Loader2 size={16} className="spin-icon" /> : editId ? 'Save shift' : <><Plus size={16} /> Save shift</>}
            </button>
            {editId && (
              <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel</button>
            )}
          </div>
        </form>
      </div>

      {isOrgWide && (
        <div
          ref={assignCardRef}
          className={`attendance-card${assignShiftId ? ' attendance-card--assigning' : ''}`}
          id="shift-assigner"
        >
          <h3 className="attendance-card__title">
            <Users size={18} /> Assign shift to people (one or many)
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
          <p className="attendance-card__subtitle">
            Tap Edit to change a shift, or Assign to put it on people.
          </p>
          <div className="shift-list">
            {shifts.map((s) => (
              <div
                key={s.id}
                className={`shift-list__item${editId === s.id ? ' shift-list__item--editing' : ''}${assignShiftId === s.id ? ' shift-list__item--assigning' : ''}`}
              >
                <div className="shift-list__info">
                  <strong>{s.name}</strong>
                  <span className="shift-list__meta">
                    {formatShiftTimeRange(s.start_time, s.end_time, s.crosses_midnight)}
                    {' · '}{formatShiftDays(s.days_of_week)}
                    {!isOrgWide && s.apply_to_all && ' · All team'}
                    {s.assigned_count != null && s.assigned_count > 0 && ` · ${s.assigned_count} assigned`}
                  </span>
                  {editId === s.id && (
                    <span className="shift-list__badge">Editing above</span>
                  )}
                </div>
                <div className="shift-list__actions">
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm shift-list__action-btn"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      startEdit(s);
                    }}
                  >
                    Edit
                  </button>
                  {!isOrgWide && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm shift-list__action-btn"
                      disabled={submitting}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        void reapplyToAll(s.id);
                      }}
                      title="Apply to all team"
                    >
                      <Users size={14} />
                      <span>Apply all</span>
                    </button>
                  )}
                  {isOrgWide && (
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm shift-list__action-btn"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        startAssign(s);
                      }}
                      title="Use for assignment"
                    >
                      Assign
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm shift-list__action-btn shift-list__action-btn--danger"
                    disabled={submitting}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void removeShift(s.id);
                    }}
                    aria-label={`Delete ${s.name}`}
                    title="Delete shift"
                  >
                    <Trash2 size={14} />
                    <span>Delete</span>
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
            <Users size={18} /> {isOrgWide ? 'Organization shift status' : 'Team shift status'}
          </h3>
          <div className="team-points-table-wrap shift-status-scroll">
            <table className="attendance-history-table">
              <thead>
                <tr>
                  <th>{isOrgWide ? 'Person' : 'Employee'}</th>
                  {isOrgWide && <th>Role</th>}
                  <th>Shift</th>
                  <th>Hours</th>
                  <th>Since</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((a) => {
                  const hours =
                    a.start_time && a.end_time
                      ? formatShiftTimeRange(String(a.start_time).slice(0, 5), String(a.end_time).slice(0, 5))
                      : '—';
                  const since = a.effective_from
                    ? new Date(`${a.effective_from}T12:00:00`).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })
                    : a.shift_id
                      ? 'Active'
                      : 'Company default';
                  return (
                    <tr key={a.user_id}>
                      <td>{a.full_name}</td>
                      {isOrgWide && <td style={{ textTransform: 'capitalize' }}>{a.employee_role || '—'}</td>}
                      <td>{a.shift_name || '—'}</td>
                      <td>{hours}</td>
                      <td>{since}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="shift-status-cards" aria-label={isOrgWide ? 'Organization shift status' : 'Team shift status'}>
            {assignments.map((a) => {
              const hours =
                a.start_time && a.end_time
                  ? formatShiftTimeRange(String(a.start_time).slice(0, 5), String(a.end_time).slice(0, 5))
                  : '—';
              const since = a.effective_from
                ? new Date(`${a.effective_from}T12:00:00`).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })
                : a.shift_id
                  ? 'Active'
                  : 'Company default';
              return (
                <article key={`card-${a.user_id}`} className="shift-status-card">
                  <header className="shift-status-card__head">
                    <strong>{a.full_name}</strong>
                    {isOrgWide ? (
                      <span className="shift-status-card__role">{a.employee_role || '—'}</span>
                    ) : null}
                  </header>
                  <dl className="shift-status-card__grid">
                    <div>
                      <dt>Shift</dt>
                      <dd>{a.shift_name || '—'}</dd>
                    </div>
                    <div>
                      <dt>Hours</dt>
                      <dd>{hours}</dd>
                    </div>
                    <div className="shift-status-card__since">
                      <dt>Since</dt>
                      <dd>{since}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function timeValue(t: string | null | undefined): string {
  return (t || '17:30').toString().slice(0, 5);
}

export function CompanyLocationWindowCard() {
  const [start, setStart] = useState('17:30');
  const [end, setEnd] = useState('04:00');
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState('');

  useEffect(() => {
    void (async () => {
      const { data } = await supabase.rpc('get_company_location_window');
      const row = (data as { start_time?: string; end_time?: string }[] | null)?.[0];
      if (row?.start_time) setStart(timeValue(row.start_time));
      if (row?.end_time) setEnd(timeValue(row.end_time));
    })();
  }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNote('');
    const { error } = await supabase.rpc('upsert_company_location_window', {
      p_start: start,
      p_end: end,
    });
    setSaving(false);
    setNote(error ? error.message : 'Company location window saved. People without an assigned shift use these hours.');
  };

  return (
    <div className="attendance-card" style={{ marginBottom: '1rem' }}>
      <h3 className="attendance-card__title">
        <CalendarClock size={18} /> Company location window
      </h3>
      <p className="attendance-card__subtitle">
        GPS is used only at clock-in and clock-out, and only inside this window (default 5:30 PM–4:00 AM).
        Assigned shifts override these hours for that person.
      </p>
      <form onSubmit={(e) => void save(e)} className="attendance-form-grid">
        <div className="form-group">
          <label>Window start</label>
          <input type="time" value={start} onChange={(e) => setStart(e.target.value)} required />
        </div>
        <div className="form-group">
          <label>Window end</label>
          <input type="time" value={end} onChange={(e) => setEnd(e.target.value)} required />
        </div>
        <div className="form-group" style={{ alignSelf: 'end' }}>
          <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
            {saving ? <Loader2 size={14} className="spin-icon" /> : null}
            Save window
          </button>
        </div>
      </form>
      {note && <p className="geo-hint">{note}</p>}
    </div>
  );
}
