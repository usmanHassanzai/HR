import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarClock, Loader2, List, Plus, Trash2, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { emailShiftAssigned, emailShiftUpdated } from '../utils/kpiEmail';
import TimeZonePicker from './TimeZonePicker';
import { suggestBrowserTimeZone, zoneShortLabel } from '../utils/ianaTimezones';
import {
  convertOfficeTime,
  describeUpcomingDstChanges,
  formatShiftZonesLine,
  isOvernightHm,
  todayYmdInZone,
  validateSameMoment,
  type ShiftOfficeTime,
} from '../utils/shiftMultiZone';
import {
  DAY_LABELS,
  TeamShiftAssignment,
  WorkShift,
  formatShiftDays,
  formatShiftTimeRange,
  isOvernightShift,
} from '../utils/shiftHelpers';

type ExtraOfficeTime = ShiftOfficeTime & { key: string };

interface OrgShiftAssignment extends TeamShiftAssignment {
  employee_role?: string;
}

interface ShiftManagementPanelProps {
  teamMembers: Profile[];
  mode?: 'manager' | 'admin' | 'hr';
  onUpdate?: () => void;
}

const DEFAULT_DAYS = [1, 2, 3, 4, 5];

type ShiftPanelTab = 'list' | 'create' | 'status';
type ShiftNotifyTarget = { id: string; full_name: string; email: string };
type ShiftNotifyKind = 'assigned' | 'updated';

async function notifyShiftAssignees(
  people: ShiftNotifyTarget[],
  shift: { name: string; start_time: string; end_time: string; days_of_week: number[]; crosses_midnight?: boolean },
  assignerLabel: string,
  kind: ShiftNotifyKind = 'assigned',
) {
  if (!people.length) return;
  const hours = formatShiftTimeRange(shift.start_time, shift.end_time, shift.crosses_midnight);
  const days = formatShiftDays(shift.days_of_week);
  const title = kind === 'updated' ? 'Active shift updated' : 'Active shift assigned';
  const message = `Active shift: ${shift.name} · ${hours} · ${days}`;

  await Promise.allSettled(
    people.map(async (person) => {
      if (person.email) {
        const payload = {
          email: person.email,
          name: person.full_name,
          shiftName: shift.name,
          hours,
          days,
          assignerLabel,
        };
        if (kind === 'updated') await emailShiftUpdated(payload);
        else await emailShiftAssigned(payload);
      }
      await supabase.rpc('create_system_notification', {
        p_user_id: person.id,
        p_title: title,
        p_message: message,
        p_type: 'info',
        p_meta: { adminTab: 'shifts', openTab: 'attendance' },
      });
    }),
  );
}

export default function ShiftManagementPanel({
  teamMembers,
  mode = 'manager',
  onUpdate,
}: ShiftManagementPanelProps) {
  const isOrgWide = mode === 'admin' || mode === 'hr';
  const [panelTab, setPanelTab] = useState<ShiftPanelTab>('list');
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [assignments, setAssignments] = useState<OrgShiftAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [assignerLabel, setAssignerLabel] = useState(
    mode === 'admin' ? 'Admin' : mode === 'hr' ? 'HR' : 'Manager',
  );

  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('09:00');
  const [endTime, setEndTime] = useState('18:00');
  const [mainTimezone, setMainTimezone] = useState(() => suggestBrowserTimeZone() || '');
  const [extraTimes, setExtraTimes] = useState<ExtraOfficeTime[]>([]);
  const [overnight, setOvernight] = useState(false);
  const [days, setDays] = useState<number[]>(DEFAULT_DAYS);
  const [applyToAll, setApplyToAll] = useState(true);
  const [applyAllTouched, setApplyAllTouched] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [selectedUserIds, setSelectedUserIds] = useState<string[]>([]);
  const [assignShiftId, setAssignShiftId] = useState('');
  const [zoneSyncError, setZoneSyncError] = useState('');
  const [dstNotices, setDstNotices] = useState<string[]>([]);
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

  const teamEmployees = useMemo(
    () => teamMembers.filter((m) => m.role === 'employee'),
    [teamMembers],
  );

  const employeeCount = teamEmployees.length;

  useEffect(() => {
    void (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.id) return;
      const { data } = await supabase.from('users').select('full_name, role').eq('id', user.id).maybeSingle();
      const roleLabel = data?.role === 'admin' ? 'Admin' : data?.role === 'hr' ? 'HR' : 'Manager';
      const who = data?.full_name?.trim();
      setAssignerLabel(who ? `${who} (${roleLabel})` : roleLabel);
    })();
  }, []);

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

  const mainOffice: ShiftOfficeTime = useMemo(
    () => ({ timezone: mainTimezone, start: startTime, end: endTime }),
    [mainTimezone, startTime, endTime],
  );

  const refYmd = useMemo(
    () => (mainTimezone ? todayYmdInZone(mainTimezone) : todayYmdInZone(suggestBrowserTimeZone() || 'UTC')),
    [mainTimezone],
  );

  const syncExtrasFromMain = (main: ShiftOfficeTime, ymd: string) => {
    setExtraTimes((prev) =>
      prev.map((row) => {
        if (!row.timezone) return row;
        const c = convertOfficeTime(main, row.timezone, ymd);
        return { ...row, start: c.start, end: c.end };
      }),
    );
  };

  const onMainStartChange = (v: string) => {
    setStartTime(v);
    if (mainTimezone) syncExtrasFromMain({ timezone: mainTimezone, start: v, end: endTime }, refYmd);
  };
  const onMainEndChange = (v: string) => {
    setEndTime(v);
    if (mainTimezone) syncExtrasFromMain({ timezone: mainTimezone, start: startTime, end: v }, refYmd);
  };
  const onMainTzChange = (tz: string) => {
    if (!tz || tz === mainTimezone) return;
    if (extraTimes.length > 0 && mainTimezone) {
      if (
        !confirm(
          `Attendance will follow ${zoneShortLabel(tz)} instead of ${zoneShortLabel(mainTimezone)}. Continue?`,
        )
      ) {
        return;
      }
    }
    const prevMain = mainOffice;
    const promoted = extraTimes.find((e) => e.timezone === tz);
    setMainTimezone(tz);
    if (promoted) {
      setStartTime(promoted.start);
      setEndTime(promoted.end);
      setOvernight(isOvernightHm(promoted.start, promoted.end));
      setExtraTimes((prev) => {
        const without = prev.filter((e) => e.timezone !== tz);
        // old main becomes a display zone
        if (prevMain.timezone) {
          return [
            {
              key: `was-main-${Date.now()}`,
              timezone: prevMain.timezone,
              start: prevMain.start,
              end: prevMain.end,
            },
            ...without,
          ];
        }
        return without;
      });
      return;
    }
    if (prevMain.timezone && tz) {
      const converted = convertOfficeTime(prevMain, tz, todayYmdInZone(prevMain.timezone));
      setStartTime(converted.start);
      setEndTime(converted.end);
      setOvernight(isOvernightHm(converted.start, converted.end));
      syncExtrasFromMain({ timezone: tz, start: converted.start, end: converted.end }, todayYmdInZone(tz));
    }
  };

  const onExtraChange = (index: number, patch: Partial<ShiftOfficeTime>) => {
    setExtraTimes((prev) => {
      const next = prev.map((row, i) => (i === index ? { ...row, ...patch } : row));
      const row = next[index];
      if (!row?.timezone || !mainTimezone) return next;
      // Editing extra times → update main + other extras to the same UTC moment
      if (patch.start != null || patch.end != null) {
        const asMain = convertOfficeTime(row, mainTimezone, refYmd);
        setStartTime(asMain.start);
        setEndTime(asMain.end);
        setOvernight(isOvernightHm(asMain.start, asMain.end));
        return next.map((r, i) => {
          if (i === index || !r.timezone) return r;
          const c = convertOfficeTime(row, r.timezone, refYmd);
          return { ...r, start: c.start, end: c.end };
        });
      }
      if (patch.timezone) {
        const c = convertOfficeTime(mainOffice, patch.timezone, refYmd);
        return next.map((r, i) => (i === index ? { ...r, timezone: patch.timezone!, start: c.start, end: c.end } : r));
      }
      return next;
    });
  };

  useEffect(() => {
    if (!mainTimezone || extraTimes.length === 0) {
      setZoneSyncError('');
      setDstNotices([]);
      return;
    }
    const others = extraTimes.filter((e) => e.timezone);
    const v = validateSameMoment(mainOffice, others, refYmd);
    setZoneSyncError(v.ok ? '' : v.message);
    setDstNotices(describeUpcomingDstChanges(mainOffice, others, refYmd));
  }, [mainOffice, extraTimes, refYmd, mainTimezone]);

  const previewLine = useMemo(() => {
    if (!mainTimezone) return '';
    return formatShiftZonesLine(
      mainOffice,
      extraTimes.filter((e) => e.timezone).map((e) => ({ timezone: e.timezone })),
      refYmd,
      suggestBrowserTimeZone(),
    );
  }, [mainOffice, extraTimes, refYmd, mainTimezone]);

  const peopleByIds = (ids: string[]): ShiftNotifyTarget[] => {
    const wanted = new Set(ids);
    const fromTeam = teamMembers
      .filter((m) => wanted.has(m.id) && m.email)
      .map((m) => ({ id: m.id, full_name: m.full_name, email: m.email }));
    if (fromTeam.length > 0) return fromTeam;
    return assignments
      .filter((a) => wanted.has(a.user_id) && a.email)
      .map((a) => ({ id: a.user_id, full_name: a.full_name, email: a.email }));
  };

  const peopleOnShift = (shiftId: string): ShiftNotifyTarget[] =>
    assignments
      .filter((a) => a.shift_id === shiftId && a.email)
      .map((a) => ({ id: a.user_id, full_name: a.full_name, email: a.email }));

  const shiftPayloadFromForm = () => ({
    name: name.trim(),
    start_time: startTime,
    end_time: endTime,
    days_of_week: days,
    crosses_midnight: overnight,
  });

  const shiftPayloadFromSaved = (shiftId: string) => {
    const s = shifts.find((x) => x.id === shiftId);
    if (!s) return null;
    return {
      name: s.name,
      start_time: String(s.start_time).slice(0, 5),
      end_time: String(s.end_time).slice(0, 5),
      days_of_week: Array.isArray(s.days_of_week) ? s.days_of_week.map(Number) : DEFAULT_DAYS,
      crosses_midnight: Boolean(s.crosses_midnight ?? isOvernightShift(s.start_time, s.end_time)),
    };
  };

  const toggleDay = (d: number) => {
    setDays((prev) => (prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d].sort()));
  };

  const toggleUser = (id: string) => {
    setSelectedUserIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const assignmentByUser = useMemo(() => {
    const map = new Map<string, OrgShiftAssignment>();
    for (const row of assignments) {
      if (row.user_id) map.set(row.user_id, row);
    }
    return map;
  }, [assignments]);

  const assignedMembers = useMemo(
    () => assignablePeople.filter((p) => Boolean(assignmentByUser.get(p.id)?.shift_id)),
    [assignablePeople, assignmentByUser],
  );

  const unassignedMembers = useMemo(
    () => assignablePeople.filter((p) => !assignmentByUser.get(p.id)?.shift_id),
    [assignablePeople, assignmentByUser],
  );

  const selectedUnassignedIds = selectedUserIds.filter((id) => unassignedMembers.some((p) => p.id === id));

  const toggleAllUnassigned = () => {
    const unassignedIds = unassignedMembers.map((p) => p.id);
    const allChecked = unassignedIds.length > 0 && unassignedIds.every((id) => selectedUserIds.includes(id));
    setSelectedUserIds((prev) =>
      allChecked
        ? prev.filter((id) => !unassignedIds.includes(id))
        : [...new Set([...prev, ...unassignedIds])],
    );
  };

  const resetForm = () => {
    setEditId(null);
    setName('');
    setStartTime('09:00');
    setEndTime('18:00');
    setMainTimezone(suggestBrowserTimeZone() || '');
    setExtraTimes([]);
    setZoneSyncError('');
    setDstNotices([]);
    setDays(DEFAULT_DAYS);
    setOvernight(false);
    setApplyToAll(true);
    setApplyAllTouched(false);
  };

  const usePhoneAndLaptopClocks = () => {
    const mobile: ShiftOfficeTime = { timezone: 'Asia/Karachi', start: '18:00', end: '03:00' };
    const ymd = todayYmdInZone('Asia/Karachi');
    const desktop = convertOfficeTime(mobile, 'America/Chicago', ymd);
    setMainTimezone('Asia/Karachi');
    setStartTime('18:00');
    setEndTime('03:00');
    setOvernight(true);
    setExtraTimes([
      {
        key: `desktop-${Date.now()}`,
        timezone: 'America/Chicago',
        start: desktop.start,
        end: desktop.end,
      },
    ]);
    setZoneSyncError('');
  };

  const saveShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || days.length === 0) return;
    if (!mainTimezone) {
      setMsg('Choose a time zone for mobile time.');
      return;
    }
    if (!overnight && endTime <= startTime) {
      setMsg('End time must be after start time, or enable overnight shift.');
      return;
    }
    if (extraTimes.length > 0) {
      const v = validateSameMoment(
        mainOffice,
        extraTimes.filter((x) => x.timezone),
        refYmd,
      );
      if (!v.ok) {
        setMsg(v.message);
        return;
      }
    }
    setSubmitting(true);
    setMsg('');
    const wasEdit = Boolean(editId);
    const editingShiftId = editId;
    const payload: Record<string, unknown> = {
      p_name: name.trim(),
      p_start_time: startTime,
      p_end_time: endTime,
      p_days_of_week: days,
      p_grace_minutes: 60,
      p_crosses_midnight: overnight,
      p_apply_to_all: wasEdit && !applyAllTouched
        ? Boolean(shifts.find((s) => s.id === editingShiftId)?.apply_to_all)
        : applyToAll,
      p_timezone: mainTimezone,
      p_display_zones: extraTimes
        .filter((x) => x.timezone)
        .map((x, i) => ({
          timezone: x.timezone,
          start: x.start,
          end: x.end,
          sort_order: i,
        })),
    };
    if (editId) payload.p_shift_id = editId;

    const formShift = shiftPayloadFromForm();
    const existingOnShift = editingShiftId ? peopleOnShift(editingShiftId) : [];
    const { data, error } = await supabase.rpc('upsert_work_shift', payload);
    setSubmitting(false);
    if (error || !data) {
      setMsg(error?.message || 'Unknown error saving shift');
      return;
    }

    const shiftId = data as string;
    let notifiedIds: string[] = [];
    let notifyKind: ShiftNotifyKind = 'assigned';

    if (!isOrgWide && applyToAll && employeeCount > 0) {
      const { error: assignErr } = await supabase.rpc('assign_shift_to_all_team', { p_shift_id: shiftId });
      if (assignErr && !/does not exist/i.test(assignErr.message)) {
        setMsg(`Shift saved but team assign failed: ${assignErr.message}`);
        await load();
        onUpdate?.();
        return;
      }
      notifiedIds = teamEmployees.map((p) => p.id);
      notifyKind = wasEdit ? 'updated' : 'assigned';
    }

    const assignEveryone = isOrgWide && applyToAll && (!wasEdit || applyAllTouched);
    const assignChecked = isOrgWide && !assignEveryone && selectedUserIds.length > 0;
    const idsToAssign = assignEveryone
      ? assignablePeople.map((p) => p.id)
      : assignChecked
        ? selectedUserIds
        : [];

    if (idsToAssign.length > 0) {
      const { data: assigned, error: assignErr } = await supabase.rpc('admin_assign_shift', {
        p_shift_id: shiftId,
        p_user_ids: idsToAssign,
      });
      if (assignErr) {
        setMsg(`Shift saved but assign failed: ${assignErr.message}`);
        await load();
        onUpdate?.();
        return;
      }
      notifiedIds = [...idsToAssign];
      notifyKind = wasEdit && !assignChecked ? 'updated' : 'assigned';
      const count = assigned ?? idsToAssign.length;
      setMsg(
        assignEveryone
          ? `Shift saved and assigned to ${count} people. Emails sent.`
          : `Shift saved. ${count} ${count === 1 ? 'person is' : 'people are'} on this shift. Emails sent.`,
      );
      setAssignShiftId(shiftId);
    } else if (wasEdit && existingOnShift.length > 0) {
      notifiedIds = existingOnShift.map((p) => p.id);
      notifyKind = 'updated';
      setMsg(`Shift updated. Email sent to ${existingOnShift.length} assigned people.`);
    } else {
      setMsg(
        wasEdit
          ? `Shift updated${!isOrgWide && applyToAll ? ` and applied to ${employeeCount} employee(s).` : '.'}`
          : `Shift saved${!isOrgWide && applyToAll ? ` and applied to all ${employeeCount} team member(s).` : '.'}`,
      );
      if (!isOrgWide && applyToAll && notifiedIds.length > 0) {
        setMsg(`Shift saved and applied to ${employeeCount} employee(s). Emails sent.`);
      }
    }

    if (notifiedIds.length > 0) {
      const targets = peopleByIds(notifiedIds);
      const merged = targets.length > 0 ? targets : existingOnShift.filter((p) => notifiedIds.includes(p.id));
      void notifyShiftAssignees(merged, formShift, assignerLabel, notifyKind);
    }

    resetForm();
    setPanelTab('list');
    await load();
    onUpdate?.();
  };

  const removeShift = async (id: string) => {
    const shift = shifts.find((s) => s.id === id);
    if (!confirm(`Delete shift “${shift?.name || 'this shift'}”? Assigned people will need a new Active shift.`)) return;
    setSubmitting(true);
    const { error } = await supabase.rpc('delete_work_shift', { p_shift_id: id });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      if (editId === id) resetForm();
      if (assignShiftId === id) setAssignShiftId('');
      setMsg('Shift deleted.');
      await load();
      onUpdate?.();
    }
  };

  const reapplyToAll = async (shiftId: string) => {
    setSubmitting(true);
    setMsg('');
    const { data, error } = await supabase.rpc('assign_shift_to_all_team', { p_shift_id: shiftId });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      const details = shiftPayloadFromSaved(shiftId) || shiftPayloadFromForm();
      void notifyShiftAssignees(
        teamEmployees.map((p) => ({ id: p.id, full_name: p.full_name, email: p.email })),
        details,
        assignerLabel,
        'assigned',
      );
      setMsg(`Shift applied to ${data ?? employeeCount} employee(s). Emails sent.`);
      await load();
      onUpdate?.();
    }
  };

  const assignSelected = async () => {
    if (!assignShiftId) {
      setMsg('Select a saved shift to assign.');
      return;
    }
    const ids = selectedUserIds.filter((id) => unassignedMembers.some((p) => p.id === id));
    if (ids.length === 0) {
      setMsg('Select at least one person who does not have a shift yet.');
      return;
    }
    setSubmitting(true);
    setMsg('');
    const { data, error } = await supabase.rpc('admin_assign_shift', {
      p_shift_id: assignShiftId,
      p_user_ids: ids,
    });
    setSubmitting(false);
    if (error) setMsg(error.message);
    else {
      const details = shiftPayloadFromSaved(assignShiftId);
      if (details) {
        void notifyShiftAssignees(peopleByIds(ids), details, assignerLabel, 'assigned');
      }
      setSelectedUserIds((prev) => prev.filter((id) => !ids.includes(id)));
      setMsg(`Assigned the shift. ${data ?? ids.length} ${ids.length === 1 ? 'person is' : 'people are'} now in Assigned members.`);
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
    setMainTimezone(s.timezone || suggestBrowserTimeZone() || '');
    setDays(nextDays.length > 0 ? nextDays : DEFAULT_DAYS);
    setOvernight(Boolean(s.crosses_midnight ?? isOvernightShift(s.start_time, s.end_time)));
    setApplyToAll(false);
    setApplyAllTouched(false);
    setSelectedUserIds(assignments.filter((a) => a.shift_id === s.id).map((a) => a.user_id));
    setAssignShiftId(s.id);
    setPanelTab('create');
    setMsg(`Editing “${s.name}”. Update the fields, then Save shift. Assigned people will get an email.`);
    void (async () => {
      const { data } = await supabase.rpc('list_shift_display_zones', { p_shift_id: s.id });
      const rows = (data || []) as {
        timezone: string;
        entered_start_time: string;
        entered_end_time: string;
        sort_order: number;
      }[];
      setExtraTimes(
        rows.map((r, i) => ({
          key: `dz-${i}-${r.timezone}`,
          timezone: r.timezone,
          start: String(r.entered_start_time).slice(0, 5),
          end: String(r.entered_end_time).slice(0, 5),
        })),
      );
    })();
    window.requestAnimationFrame(() => {
      formCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      const nameInput = formCardRef.current?.querySelector<HTMLInputElement>('input:not([type="time"]):not([type="checkbox"])');
      nameInput?.focus({ preventScroll: true });
    });
  };

  const startAssign = (s: WorkShift) => {
    setAssignShiftId(s.id);
    setPanelTab('create');
    setMsg(`Assigning “${s.name}”. Select people below, then Assign to selected.`);
    window.requestAnimationFrame(() => {
      assignCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const startCreate = () => {
    resetForm();
    setPanelTab('create');
    setMsg('');
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

      <div className="shift-panel-tabs tab-bar tab-bar--inline-mobile" role="tablist" aria-label="Shift management">
        <button
          type="button"
          className={`tab-btn ${panelTab === 'list' ? 'tab-btn--active' : ''}`}
          onClick={() => setPanelTab('list')}
        >
          <List size={16} /> All shifts
          {shifts.length > 0 && <span className="shift-panel-tabs__count">{shifts.length}</span>}
        </button>
        <button
          type="button"
          className={`tab-btn ${panelTab === 'create' ? 'tab-btn--active' : ''}`}
          onClick={() => setPanelTab('create')}
        >
          <Plus size={16} /> {editId ? 'Edit shift' : 'Create / Assign'}
        </button>
        <button
          type="button"
          className={`tab-btn ${panelTab === 'status' ? 'tab-btn--active' : ''}`}
          onClick={() => setPanelTab('status')}
        >
          <Users size={16} /> Who is on which
        </button>
      </div>

      {panelTab === 'list' && (
        <div className="attendance-card">
          <div className="shift-list-header">
            <div>
              <h3 className="attendance-card__title">
                <List size={18} /> All shifts
              </h3>
              <p className="attendance-card__subtitle">
                Every saved schedule. Edit hours/days, assign to people, or delete. Changing a shift emails everyone on it.
              </p>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={startCreate}>
              <Plus size={16} /> New shift
            </button>
          </div>

          {shifts.length === 0 ? (
            <div className="shift-list-empty">
              <CalendarClock size={32} strokeWidth={1.25} />
              <h4>No shifts yet</h4>
              <p>Create a shift, then assign it to employees and managers. They will get an email with Active shift details.</p>
              <button type="button" className="btn btn-primary" onClick={startCreate}>
                <Plus size={16} /> Create first shift
              </button>
            </div>
          ) : (
            <div className="shift-list">
              {shifts.map((s) => {
                const onCount = assignments.filter((a) => a.shift_id === s.id).length;
                return (
                  <div
                    key={s.id}
                    className={`shift-list__item${editId === s.id ? ' shift-list__item--editing' : ''}${assignShiftId === s.id ? ' shift-list__item--assigning' : ''}`}
                  >
                    <div className="shift-list__info">
                      <strong>{s.name}</strong>
                      <span className="shift-list__meta">
                        {formatShiftTimeRange(s.start_time, s.end_time, s.crosses_midnight)}
                        {s.timezone ? ` · ${s.timezone}` : ''}
                        {' · '}{formatShiftDays(s.days_of_week)}
                        {!isOrgWide && s.apply_to_all && ' · All team'}
                        {(s.assigned_count != null ? s.assigned_count : onCount) > 0
                          && ` · ${s.assigned_count ?? onCount} assigned`}
                      </span>
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
                          title="Assign to people"
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
                );
              })}
            </div>
          )}
        </div>
      )}

      {panelTab === 'create' && (
        <>
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
                People already on this Active shift will get an email.
              </p>
            ) : (
              <p className="attendance-card__subtitle">
                {isOrgWide
                  ? 'Create any schedule (including overnight), then assign it to employees and managers. They receive an email with Active shift details.'
                  : 'Set any shift schedule — including overnight. When saved and applied, your team gets an email with Active shift details.'}
              </p>
            )}
            <form onSubmit={(e) => void saveShift(e)} className="attendance-form-grid attendance-form-grid--wide">
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Shift name</label>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Night Shift" required />
              </div>

              <div className="form-group attendance-form-span-full">
                <p className="attendance-card__subtitle" style={{ margin: 0 }}>
                  One shift can store both clocks. The phone uses mobile time (Pakistan, 6:00 PM–3:00 AM).
                  The laptop uses desktop time (United States, about 8:00 AM–5:00 PM). They are the same shift.
                  A check-in on the phone stays checked in when you press Test now on the laptop.
                </p>
                <button type="button" className="btn btn-secondary btn-sm" onClick={usePhoneAndLaptopClocks}>
                  Use Pakistan phone + US laptop times
                </button>
              </div>

              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Mobile time (phone)</label>
                <TimeZonePicker value={mainTimezone} onChange={onMainTzChange} />
              </div>
              <div className="form-group">
                <label>Phone start</label>
                <input type="time" value={startTime} onChange={(e) => onMainStartChange(e.target.value)} required />
              </div>
              <div className="form-group">
                <label>Phone end</label>
                <input type="time" value={endTime} onChange={(e) => onMainEndChange(e.target.value)} required />
              </div>

              {extraTimes.map((row, idx) => (
                <div
                  key={row.key}
                  style={{
                    gridColumn: '1 / -1',
                    display: 'grid',
                    gap: '0.65rem',
                    padding: '0.75rem',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <strong>{idx === 0 ? 'Desktop time (laptop)' : `Extra time ${idx + 2}`}</strong>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setExtraTimes((prev) => prev.filter((_, i) => i !== idx))}
                    >
                      Remove
                    </button>
                  </div>
                  <TimeZonePicker
                    value={row.timezone}
                    onChange={(tz) => onExtraChange(idx, { timezone: tz })}
                  />
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.65rem' }}>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{idx === 0 ? 'Laptop start' : 'Start'}</label>
                      <input
                        type="time"
                        value={row.start}
                        onChange={(e) => onExtraChange(idx, { start: e.target.value })}
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label>{idx === 0 ? 'Laptop end' : 'End'}</label>
                      <input
                        type="time"
                        value={row.end}
                        onChange={(e) => onExtraChange(idx, { end: e.target.value })}
                      />
                    </div>
                  </div>
                </div>
              ))}

              {extraTimes.length < 3 && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <button
                    type="button"
                    className="btn btn-secondary"
                    onClick={() => {
                      const desktopTz = mainTimezone.startsWith('America/') ? 'Asia/Karachi' : 'America/Chicago';
                      const converted = mainTimezone
                        ? convertOfficeTime(mainOffice, desktopTz, refYmd)
                        : { start: startTime, end: endTime };
                      setExtraTimes((prev) => [
                        ...prev,
                        {
                          key: `extra-${Date.now()}`,
                          timezone: desktopTz,
                          start: converted.start,
                          end: converted.end,
                        },
                      ]);
                    }}
                  >
                    <Plus size={14} /> {extraTimes.length === 0 ? 'Add desktop time (laptop)' : 'Add another time'}
                  </button>
                </div>
              )}

              {extraTimes.length > 0 && (
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <label>Primary clock</label>
                  <select
                    value={mainTimezone}
                    onChange={(e) => onMainTzChange(e.target.value)}
                  >
                    <option value={mainTimezone}>{mainTimezone} (main)</option>
                    {extraTimes
                      .filter((e) => e.timezone)
                      .map((e) => (
                        <option key={e.timezone} value={e.timezone}>
                          {e.timezone}
                        </option>
                      ))}
                  </select>
                  <p style={{ margin: '0.35rem 0 0', fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                    Both clocks are saved on this shift. Check-in stays open while either the phone hours or the laptop hours are in progress.
                  </p>
                </div>
              )}

              {zoneSyncError && (
                <p style={{ gridColumn: '1 / -1', color: 'var(--color-danger, #b91c1c)', margin: 0 }}>
                  {zoneSyncError}
                </p>
              )}
              {dstNotices.map((n) => (
                <p key={n} style={{ gridColumn: '1 / -1', margin: 0, fontSize: '0.88rem', color: 'var(--color-warning, #a16207)' }}>
                  {n}
                </p>
              ))}
              {previewLine && (
                <p style={{ gridColumn: '1 / -1', margin: 0, fontSize: '0.9rem' }}>
                  <strong>Preview:</strong> {previewLine}
                </p>
              )}

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
                    onChange={(e) => {
                      const on = e.target.checked;
                      setApplyToAll(on);
                      setApplyAllTouched(true);
                      if (on) setSelectedUserIds(assignablePeople.map((p) => p.id));
                    }}
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
                  <button type="button" className="btn btn-secondary" onClick={resetForm}>Cancel edit</button>
                )}
                <button type="button" className="btn btn-secondary" onClick={() => setPanelTab('list')}>
                  Back to all shifts
                </button>
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
                <Users size={18} /> Shift members
              </h3>
              <p className="attendance-card__subtitle">
                People without a shift stay in Not assigned. Choose a shift, select them, and assign. They move to Assigned members.
              </p>
              <div className="shift-member-blocks">
                <section className="shift-member-block">
                  <div className="shift-member-block__head">
                    <h4>Assigned members</h4>
                    <span>{assignedMembers.length}</span>
                  </div>
                  <div className="shift-assign-list">
                    {assignedMembers.length === 0 ? (
                      <p className="attendance-card__subtitle">No one is on a shift yet.</p>
                    ) : (
                      assignedMembers.map((p) => {
                        const row = assignmentByUser.get(p.id);
                        return (
                          <div key={p.id} className="shift-assign-row">
                            <span>
                              <strong>{p.full_name}</strong>
                              <span className="shift-assign-meta"> · {p.role}</span>
                              <span className="shift-assign-shift">{row?.shift_name || 'Shift'}</span>
                            </span>
                          </div>
                        );
                      })
                    )}
                  </div>
                </section>

                <section className="shift-member-block">
                  <div className="shift-member-block__head">
                    <h4>Not assigned</h4>
                    <span>{unassignedMembers.length}</span>
                  </div>
                  <div className="form-group">
                    <label htmlFor="assign-shift-pick">Shift</label>
                    <select id="assign-shift-pick" value={assignShiftId} onChange={(e) => setAssignShiftId(e.target.value)}>
                      <option value="">— Select shift —</option>
                      {shifts.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} ({formatShiftTimeRange(s.start_time, s.end_time, s.crosses_midnight)})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'flex-end', margin: '0.45rem 0' }}>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={toggleAllUnassigned} disabled={unassignedMembers.length === 0}>
                      {selectedUnassignedIds.length === unassignedMembers.length && unassignedMembers.length > 0 ? 'Clear all' : 'Select all'}
                    </button>
                  </div>
                  <div className="shift-assign-list">
                    {unassignedMembers.length === 0 ? (
                      <p className="attendance-card__subtitle">Everyone has a shift.</p>
                    ) : (
                      unassignedMembers.map((p) => (
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
                  <button
                    type="button"
                    className="btn btn-primary"
                    style={{ marginTop: '0.85rem' }}
                    disabled={submitting || !assignShiftId || selectedUnassignedIds.length === 0}
                    onClick={() => void assignSelected()}
                  >
                    {submitting ? <Loader2 size={16} className="spin-icon" /> : <Users size={16} />}
                    Assign shift
                  </button>
                </section>
              </div>
            </div>
          )}
        </>
      )}

      {panelTab === 'status' && (
        <div className="attendance-card">
          <h3 className="attendance-card__title">
            <Users size={18} /> {isOrgWide ? 'Organization shift status' : 'Team shift status'}
          </h3>
          <p className="attendance-card__subtitle">
            Who has which Active shift right now.
          </p>
          {assignments.length === 0 ? (
            <div className="shift-list-empty">
              <Users size={32} strokeWidth={1.25} />
              <h4>No assignments yet</h4>
              <p>Create a shift and assign it to employees or managers to see status here.</p>
              <button type="button" className="btn btn-primary" onClick={startCreate}>
                <Plus size={16} /> Create / Assign
              </button>
            </div>
          ) : (
            <>
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
                      const hasActive = Boolean(a.shift_id && a.shift_name);
                      const since = a.effective_from
                        ? new Date(`${a.effective_from}T12:00:00`).toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })
                        : hasActive
                          ? 'Active shift'
                          : 'Company default';
                      return (
                        <tr key={a.user_id}>
                          <td>{a.full_name}</td>
                          {isOrgWide && <td style={{ textTransform: 'capitalize' }}>{a.employee_role || '—'}</td>}
                          <td>
                            {hasActive ? (
                              <span className="shift-active-label">
                                <span className="shift-active-pill">Active shift</span>
                                {a.shift_name}
                              </span>
                            ) : (
                              a.shift_name || '—'
                            )}
                          </td>
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
                  const hasActive = Boolean(a.shift_id && a.shift_name);
                  const since = a.effective_from
                    ? new Date(`${a.effective_from}T12:00:00`).toLocaleDateString(undefined, {
                        year: 'numeric',
                        month: 'short',
                        day: 'numeric',
                      })
                    : hasActive
                      ? 'Active shift'
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
                          <dd>
                            {hasActive ? (
                              <span className="shift-active-label">
                                <span className="shift-active-pill">Active shift</span>
                                {a.shift_name}
                              </span>
                            ) : (
                              a.shift_name || '—'
                            )}
                          </dd>
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
            </>
          )}
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
