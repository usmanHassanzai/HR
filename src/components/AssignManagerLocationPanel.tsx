import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { OfficeGroup, OfficeLocation } from '../utils/geoAttendance';
import { MapPin, Loader2, Trash2, UserCheck, Users, UserPlus } from 'lucide-react';
import LiveGpsCapture from './LiveGpsCapture';
import '../styles/attendance.css';

export interface ManagerSiteRow {
  site_id: string;
  manager_id: string;
  manager_name: string;
  manager_email: string;
  team_count: number;
  site_name: string;
  site_address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  tracking_enabled: boolean;
}

export interface EmployeeSiteRow {
  site_id: string;
  user_id: string;
  user_name: string;
  user_email: string;
  user_role: 'employee' | 'manager' | 'admin' | 'hr';
  site_name: string;
  site_address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  tracking_enabled: boolean;
  office_location_id?: string | null;
  office_id?: string | null;
  office_name?: string | null;
}

interface AssignManagerLocationPanelProps {
  /** Pre-select this location when opened from a location row */
  initialOfficeId?: string;
  onAssigned?: () => void;
  /** Hide duplicate headings when nested in OfficeLocationSettings */
  embedded?: boolean;
}

function isErrorMsg(message: string): boolean {
  return /please|fail|only|required|not found|error|cannot|denied/i.test(message);
}

function locationLabel(loc: OfficeLocation, officeName?: string | null): string {
  const parent = officeName?.trim();
  if (parent && parent !== loc.name) return `${parent} · ${loc.name}`;
  return loc.name;
}

export default function AssignManagerLocationPanel({
  initialOfficeId,
  onAssigned,
  embedded = false,
}: AssignManagerLocationPanelProps) {
  const [managers, setManagers] = useState<Profile[]>([]);
  const [employees, setEmployees] = useState<Profile[]>([]);
  const [officeGroups, setOfficeGroups] = useState<OfficeGroup[]>([]);
  const [locations, setLocations] = useState<OfficeLocation[]>([]);
  const [assignments, setAssignments] = useState<ManagerSiteRow[]>([]);
  const [employeeAssignments, setEmployeeAssignments] = useState<EmployeeSiteRow[]>([]);
  const [managerId, setManagerId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [officeId, setOfficeId] = useState(initialOfficeId || '');
  const [selectedLocationIds, setSelectedLocationIds] = useState<string[]>(
    initialOfficeId ? [initialOfficeId] : [],
  );
  const [saving, setSaving] = useState(false);
  const [savingEmp, setSavingEmp] = useState(false);
  const [assigningAll, setAssigningAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [quickOffice, setQuickOffice] = useState({ name: '', latitude: '', longitude: '', radius_meters: '150' });
  const [quickSaving, setQuickSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [usersRes, officesRes, locsRes, sitesRes, empSitesRes] = await Promise.all([
      supabase.rpc('get_all_users_admin'),
      supabase.rpc('get_offices'),
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_manager_work_sites'),
      supabase.rpc('get_employee_work_sites'),
    ]);
    const users = ((usersRes.data || []) as Profile[]).filter((u) => !u.is_demo);
    setManagers(users.filter((u) => u.role === 'manager'));
    setEmployees(users.filter((u) => u.role === 'employee' || u.role === 'manager' || u.role === 'hr'));
    if (!officesRes.error) setOfficeGroups((officesRes.data || []) as OfficeGroup[]);
    setLocations((locsRes.data || []) as OfficeLocation[]);
    if (sitesRes.error) setMsg(sitesRes.error.message);
    else setAssignments((sitesRes.data || []) as ManagerSiteRow[]);
    if (empSitesRes.error && !/function|does not exist|schema cache/i.test(empSitesRes.error.message)) {
      setMsg(empSitesRes.error.message);
    } else {
      setEmployeeAssignments((empSitesRes.data || []) as EmployeeSiteRow[]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (initialOfficeId) {
      setOfficeId(initialOfficeId);
      setSelectedLocationIds((prev) => (prev.includes(initialOfficeId) ? prev : [initialOfficeId]));
    }
  }, [initialOfficeId]);

  const officeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of officeGroups) map.set(o.id, o.name);
    // Fallback: locations that still carry their own name as parent
    for (const loc of locations) {
      if (loc.office_id && !map.has(loc.office_id)) map.set(loc.office_id, loc.name);
    }
    return map;
  }, [officeGroups, locations]);

  const activeLocations = useMemo(() => locations.filter((o) => o.active), [locations]);
  const selectedOffice = locations.find((o) => o.id === officeId);
  const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

  const assignmentsByUser = useMemo(() => {
    const map = new Map<string, EmployeeSiteRow[]>();
    for (const a of employeeAssignments) {
      const list = map.get(a.user_id) || [];
      list.push(a);
      map.set(a.user_id, list);
    }
    return map;
  }, [employeeAssignments]);

  const unassignedEmployees = employees.filter((e) => !assignmentsByUser.has(e.id));

  // When person selected, prefill multi-select from their current assignments
  useEffect(() => {
    if (!employeeId) return;
    const existing = (assignmentsByUser.get(employeeId) || [])
      .map((a) => a.office_location_id)
      .filter((id): id is string => Boolean(id));
    if (existing.length > 0) {
      setSelectedLocationIds(existing);
    } else if (initialOfficeId) {
      setSelectedLocationIds([initialOfficeId]);
    }
  }, [employeeId, assignmentsByUser, initialOfficeId]);

  const toggleLocation = (id: string) => {
    setSelectedLocationIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const assignEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) {
      setMsg('Please select an employee.');
      return;
    }
    if (selectedLocationIds.length === 0) {
      setMsg('Select at least one location (or clear all with Save empty set after confirming).');
      return;
    }
    setSavingEmp(true);
    setMsg('');
    const { error } = await supabase.rpc('set_employee_work_sites', {
      p_user_id: employeeId,
      p_office_location_ids: selectedLocationIds,
    });
    setSavingEmp(false);
    if (error) {
      // Fallback if migration not applied yet: assign first location only via legacy RPC
      if (/function|does not exist|schema cache/i.test(error.message) && selectedLocationIds[0]) {
        const loc = locationById.get(selectedLocationIds[0]);
        if (!loc) {
          setMsg(error.message);
          return;
        }
        const { error: legacyErr } = await supabase.rpc('assign_employee_work_site', {
          p_user_id: employeeId,
          p_office_location_id: loc.id,
          p_name: loc.name,
          p_address: loc.address || null,
          p_latitude: loc.latitude,
          p_longitude: loc.longitude,
          p_radius_meters: loc.radius_meters,
          p_tracking_enabled: true,
        });
        if (legacyErr) {
          setMsg(legacyErr.message);
          return;
        }
      } else {
        setMsg(error.message);
        return;
      }
    }
    const emp = employees.find((u) => u.id === employeeId);
    const names = selectedLocationIds
      .map((id) => {
        const loc = locationById.get(id);
        return loc ? locationLabel(loc, officeNameById.get(loc.office_id || '') || null) : null;
      })
      .filter(Boolean);
    setMsg(
      `Assigned ${names.length} location${names.length === 1 ? '' : 's'} to ${emp?.full_name || 'user'}: ${names.join(', ')}. Other locations do not apply.`,
    );
    setEmployeeId('');
    await load();
    onAssigned?.();
  };

  const assignAllEmployees = async () => {
    if (!selectedOffice) {
      setMsg('Please select a location in the manager section, or pick one location checkbox first.');
      return;
    }
    const targetId = selectedLocationIds[0] || selectedOffice.id;
    const target = locationById.get(targetId) || selectedOffice;
    const staffCount = employees.length;
    if (staffCount === 0) {
      setMsg('No employees, managers, or HR found in your organization.');
      return;
    }
    if (
      !confirm(
        `Add "${locationLabel(target, officeNameById.get(target.office_id || '') || null)}" to all ${staffCount} staff? Existing other location assignments are kept; this location is added for everyone.`,
      )
    ) {
      return;
    }
    setAssigningAll(true);
    setMsg('');
    const { data, error } = await supabase.rpc('assign_office_to_all_employees', {
      p_office_location_id: target.id,
    });
    setAssigningAll(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg(
      `Added "${target.name}" to ${data ?? staffCount} staff. Other assigned locations were not removed.`,
    );
    await load();
    onAssigned?.();
  };

  const removeEmployeeAssignment = async (siteId: string, userName: string, siteName: string) => {
    if (!confirm(`Remove "${siteName}" from ${userName}? Their other assigned locations stay.`)) return;
    const { error } = await supabase.rpc('remove_employee_work_site_by_id', { p_site_id: siteId });
    if (error) {
      if (/function|does not exist|schema cache/i.test(error.message)) {
        const row = employeeAssignments.find((a) => a.site_id === siteId);
        if (row) {
          const { error: legacyErr } = await supabase.rpc('remove_employee_work_site', { p_user_id: row.user_id });
          if (legacyErr) setMsg(legacyErr.message);
          else {
            setMsg('Assignment removed (cleared all for this person — apply multi-location migration for per-location remove).');
            await load();
            onAssigned?.();
          }
          return;
        }
      }
      setMsg(error.message);
    } else {
      setMsg(`Removed "${siteName}" from ${userName}.`);
      await load();
      onAssigned?.();
    }
  };

  const clearAllForPerson = async (userId: string, name: string) => {
    if (!confirm(`Remove ALL location assignments for ${name}?`)) return;
    const { error } = await supabase.rpc('remove_employee_work_site', { p_user_id: userId });
    if (error) setMsg(error.message);
    else {
      setMsg(`Cleared all locations for ${name}.`);
      await load();
      onAssigned?.();
    }
  };

  const assign = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!managerId) {
      setMsg('Please select a manager.');
      return;
    }
    if (!selectedOffice) {
      setMsg('Please select an office location first. Add one above if the list is empty.');
      return;
    }
    setSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('assign_manager_work_site', {
      p_manager_id: managerId,
      p_office_location_id: selectedOffice.id,
      p_name: selectedOffice.name,
      p_address: selectedOffice.address || null,
      p_latitude: selectedOffice.latitude,
      p_longitude: selectedOffice.longitude,
      p_radius_meters: selectedOffice.radius_meters,
      p_tracking_enabled: true,
    });
    setSaving(false);
    if (error) {
      setMsg(error.message);
    } else {
      const mgr = managers.find((m) => m.id === managerId);
      setMsg(
        `Assigned "${selectedOffice.name}" as team zone for ${mgr?.full_name || 'manager'}. Team members without a personal assignment inherit this one location.`,
      );
      setManagerId('');
      await load();
      onAssigned?.();
    }
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Remove work location for ${name}? Their team will no longer inherit this GPS zone.`)) return;
    const { error } = await supabase.rpc('remove_manager_work_site', { p_manager_id: id });
    if (error) setMsg(error.message);
    else {
      setMsg('Manager assignment removed.');
      await load();
      onAssigned?.();
    }
  };

  const saveQuickOffice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickOffice.name.trim()) {
      setMsg('Office name is required.');
      return;
    }
    if (!quickOffice.latitude || !quickOffice.longitude) {
      setMsg('Tap “Add my live location now” above to capture GPS first.');
      return;
    }
    setQuickSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('upsert_office_location', {
      p_id: null,
      p_name: quickOffice.name.trim(),
      p_address: null,
      p_latitude: parseFloat(quickOffice.latitude),
      p_longitude: parseFloat(quickOffice.longitude),
      p_radius_meters: parseInt(quickOffice.radius_meters, 10) || 150,
      p_active: true,
    });
    setQuickSaving(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg('Location saved from live GPS. Select it below to assign.');
    setQuickOffice({ name: '', latitude: '', longitude: '', radius_meters: '150' });
    await load();
  };

  return (
    <div
      className={`attendance-card geo-attendance-panel${embedded ? ' admin-office-assign-embed' : ''}`}
      id="assign-manager-location"
    >
      {!embedded && (
        <>
          <h3 className="attendance-card__title">
            <UserCheck size={18} /> Step 3 — Assign locations
          </h3>
          <p className="attendance-card__subtitle">
            Assign one or more location pins to each person. Only those pins count for radius/presence.
          </p>
        </>
      )}

      {msg && (
        <div
          className={`rewards-toast ${isErrorMsg(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}
          style={{ marginBottom: '1rem' }}
        >
          {msg}
        </div>
      )}

      {loading ? (
        <div className="dash-loading">
          <Loader2 size={24} className="spin-icon" />
        </div>
      ) : activeLocations.length === 0 ? (
        <div>
          <p className="attendance-empty" style={{ marginBottom: '1rem' }}>
            No locations yet. Capture live GPS below, name the location, and save — then assign it.
          </p>
          <LiveGpsCapture
            latitude={quickOffice.latitude}
            longitude={quickOffice.longitude}
            onCapture={(lat, lng) => setQuickOffice((o) => ({ ...o, latitude: lat, longitude: lng }))}
          />
          <form onSubmit={saveQuickOffice} className="attendance-form-grid attendance-form-grid--wide" style={{ marginTop: '1rem' }}>
            <div className="form-group">
              <label>Location name *</label>
              <input
                value={quickOffice.name}
                onChange={(e) => setQuickOffice({ ...quickOffice, name: e.target.value })}
                placeholder="e.g. Main entrance"
                required
              />
            </div>
            <div className="form-group">
              <label>Radius (meters)</label>
              <input
                type="number"
                min={30}
                max={2000}
                value={quickOffice.radius_meters}
                onChange={(e) => setQuickOffice({ ...quickOffice, radius_meters: e.target.value })}
              />
            </div>
            <div>
              <button type="submit" className="btn btn-primary" disabled={quickSaving || !quickOffice.latitude}>
                {quickSaving ? <Loader2 size={16} className="spin-icon" /> : <><MapPin size={16} /> Save location at live GPS</>}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <section className="admin-office-assign-block">
            <h4 className="attendance-card__title" style={{ fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              <Users size={16} /> Assign locations to a person
            </h4>
            <p className="attendance-card__subtitle" style={{ marginBottom: '1rem' }}>
              Multi-select locations. Saving replaces that person&apos;s location set. Only selected pins apply; others do
              not.
            </p>

            <form onSubmit={assignEmployee} className="attendance-form-grid attendance-form-grid--wide">
              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Employee, manager, or HR</label>
                <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                  <option value="">— Select person —</option>
                  {employees.map((u) => {
                    const count = assignmentsByUser.get(u.id)?.length || 0;
                    return (
                      <option key={u.id} value={u.id}>
                        {u.full_name}
                        {u.role === 'manager' ? ' (manager)' : u.role === 'hr' ? ' (HR)' : ''}
                        {count > 0 ? ` · ${count} location${count === 1 ? '' : 's'}` : ''}
                      </option>
                    );
                  })}
                </select>
              </div>

              <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                <label>Locations (select one or more)</label>
                <div className="admin-office-location-checks">
                  {activeLocations.map((loc) => {
                    const parent = officeNameById.get(loc.office_id || '') || null;
                    const checked = selectedLocationIds.includes(loc.id);
                    return (
                      <label key={loc.id} className={`admin-office-location-check ${checked ? 'is-checked' : ''}`}>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleLocation(loc.id)}
                        />
                        <span>
                          <strong>{locationLabel(loc, parent)}</strong>
                          <span className="admin-office-location-check__meta">
                            {loc.radius_meters}m · {loc.latitude.toFixed(4)}, {loc.longitude.toFixed(4)}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>

              {selectedLocationIds.length > 0 && (
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <div className="geo-assign-preview">
                    <MapPin size={16} />
                    <span>
                      {selectedLocationIds.length} location{selectedLocationIds.length === 1 ? '' : 's'} selected — only
                      these apply for presence
                    </span>
                  </div>
                </div>
              )}

              <div className="admin-office-assign-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={savingEmp || !employeeId || selectedLocationIds.length === 0}
                >
                  {savingEmp ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : (
                    <>
                      <UserPlus size={16} /> Save location set
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={assigningAll || selectedLocationIds.length === 0}
                  onClick={() => {
                    if (selectedLocationIds[0]) setOfficeId(selectedLocationIds[0]);
                    void assignAllEmployees();
                  }}
                >
                  {assigningAll ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : (
                    <>
                      <Users size={16} /> Add first selected to all staff
                    </>
                  )}
                </button>
              </div>
            </form>

            {unassignedEmployees.length > 0 && (
              <p className="geo-hint" style={{ marginTop: '0.75rem' }}>
                {unassignedEmployees.length} person
                {unassignedEmployees.length === 1 ? '' : 's'} without a personal location assignment
                {assignments.length > 0 ? ' (may still inherit from their manager).' : '.'}
              </p>
            )}

            <div style={{ marginTop: '1.25rem' }}>
              <h4 className="attendance-card__title" style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
                Assignments ({employeeAssignments.length} location rows · {assignmentsByUser.size} people)
              </h4>
              {employeeAssignments.length === 0 ? (
                <p className="attendance-empty" style={{ margin: 0 }}>
                  No one assigned yet. Select a person, check locations, and Save location set.
                </p>
              ) : (
                <div className="attendance-approval-list">
                  {[...assignmentsByUser.entries()].map(([userId, rows]) => {
                    const first = rows[0];
                    return (
                      <div
                        key={userId}
                        className="attendance-approval-item"
                        style={{ borderLeftColor: 'var(--color-success)', flexDirection: 'column', alignItems: 'stretch' }}
                      >
                        <div className="attendance-approval-item__main" style={{ width: '100%' }}>
                          <span className="attendance-approval-item__name">
                            {first.user_name}
                            <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
                              {first.user_role === 'manager' ? 'Manager' : first.user_role === 'hr' ? 'HR' : 'Employee'}
                            </span>
                          </span>
                          <span className="attendance-approval-item__meta">
                            {rows.length} location{rows.length === 1 ? '' : 's'} · only these apply
                          </span>
                        </div>
                        <ul className="admin-office-assign-loc-list">
                          {rows.map((a) => (
                            <li key={a.site_id}>
                              <span>
                                {a.office_name && a.office_name !== a.site_name
                                  ? `${a.office_name} · ${a.site_name}`
                                  : a.site_name}
                                {' · '}
                                {a.radius_meters}m
                              </span>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => void removeEmployeeAssignment(a.site_id, a.user_name, a.site_name)}
                                style={{ color: 'var(--color-danger)' }}
                              >
                                <Trash2 size={14} /> Remove
                              </button>
                            </li>
                          ))}
                        </ul>
                        {rows.length > 1 && (
                          <div className="attendance-approval-item__actions" style={{ marginTop: '0.35rem' }}>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => void clearAllForPerson(userId, first.user_name)}
                              style={{ color: 'var(--color-danger)' }}
                            >
                              Clear all
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </section>

          <section className="admin-office-assign-block admin-office-assign-block--managers">
            <h4 className="attendance-card__title" style={{ fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              <UserCheck size={16} /> Assign by manager (whole team)
            </h4>
            <p className="attendance-card__subtitle" style={{ marginBottom: '1rem' }}>
              Optional. Team members without a personal assignment inherit their manager&apos;s single GPS zone.
            </p>

            {managers.length === 0 ? (
              <p className="attendance-empty" style={{ margin: 0 }}>
                No managers found. Create a manager account under Users if you need team-level assignment.
              </p>
            ) : (
              <form onSubmit={assign} className="attendance-form-grid attendance-form-grid--wide">
                <div className="form-group">
                  <label>Manager</label>
                  <select value={managerId} onChange={(e) => setManagerId(e.target.value)} required>
                    <option value="">— Select manager —</option>
                    {managers.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.full_name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="form-group">
                  <label>Location</label>
                  <select value={officeId} onChange={(e) => setOfficeId(e.target.value)} required>
                    <option value="">— Select location —</option>
                    {activeLocations.map((o) => (
                      <option key={o.id} value={o.id}>
                        {locationLabel(o, officeNameById.get(o.office_id || '') || null)} ({o.radius_meters}m)
                      </option>
                    ))}
                  </select>
                </div>
                {selectedOffice && (
                  <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                    <div className="geo-assign-preview">
                      <MapPin size={16} />
                      <span>
                        <strong>{selectedOffice.name}</strong>
                        {' · '}
                        {selectedOffice.latitude.toFixed(5)}, {selectedOffice.longitude.toFixed(5)}
                        {' · '}
                        {selectedOffice.radius_meters}m radius
                        {selectedOffice.address && <> · {selectedOffice.address}</>}
                      </span>
                    </div>
                  </div>
                )}
                <div>
                  <button type="submit" className="btn btn-primary" disabled={saving || !managerId || !officeId}>
                    {saving ? <Loader2 size={16} className="spin-icon" /> : <><UserCheck size={16} /> Assign to manager</>}
                  </button>
                </div>
              </form>
            )}

            <div style={{ marginTop: '1.5rem' }}>
              <h4 className="attendance-card__title" style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
                Manager assignments ({assignments.length})
              </h4>
              {assignments.length === 0 ? (
                <p className="attendance-empty" style={{ margin: 0 }}>
                  No managers assigned yet.
                </p>
              ) : (
                <div className="attendance-approval-list">
                  {assignments.map((a) => (
                    <div
                      key={a.site_id}
                      className="attendance-approval-item"
                      style={{ borderLeftColor: 'var(--color-success)' }}
                    >
                      <div className="attendance-approval-item__main">
                        <span className="attendance-approval-item__name">
                          {a.manager_name}
                          <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
                            Team zone
                          </span>
                        </span>
                        <span className="attendance-approval-item__meta">
                          Location: {a.site_name} · {a.team_count} employee{a.team_count !== 1 ? 's' : ''} on team
                        </span>
                        <span className="attendance-approval-item__reason">
                          {a.latitude.toFixed(5)}, {a.longitude.toFixed(5)} · {a.radius_meters}m
                        </span>
                      </div>
                      <div className="attendance-approval-item__actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void remove(a.manager_id, a.manager_name)}
                          style={{ color: 'var(--color-danger)' }}
                        >
                          <Trash2 size={14} /> Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
