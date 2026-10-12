import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { OfficeGroup, OfficeLocation } from '../utils/geoAttendance';
import { MapPin, Loader2, Trash2, UserCheck, Users, UserPlus, Search, X } from 'lucide-react';
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

function roleLabel(role: string): string {
  if (role === 'manager') return 'Manager';
  if (role === 'hr') return 'HR';
  return 'Employee';
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
  const [personQuery, setPersonQuery] = useState('');
  const [rosterQuery, setRosterQuery] = useState('');
  const [showManagerSection, setShowManagerSection] = useState(false);

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
    for (const loc of locations) {
      if (loc.office_id && !map.has(loc.office_id)) map.set(loc.office_id, loc.name);
    }
    return map;
  }, [officeGroups, locations]);

  const activeLocations = useMemo(() => locations.filter((o) => o.active), [locations]);
  const selectedOffice = locations.find((o) => o.id === officeId);
  const locationById = useMemo(() => new Map(locations.map((l) => [l.id, l])), [locations]);

  const locationsByOffice = useMemo(() => {
    const groups: { key: string; label: string; locs: OfficeLocation[] }[] = [];
    const index = new Map<string, number>();
    for (const loc of activeLocations) {
      const oid = loc.office_id || '_none';
      const label = officeNameById.get(loc.office_id || '') || 'Other locations';
      let i = index.get(oid);
      if (i === undefined) {
        i = groups.length;
        index.set(oid, i);
        groups.push({ key: oid, label, locs: [] });
      }
      groups[i].locs.push(loc);
    }
    return groups;
  }, [activeLocations, officeNameById]);

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

  const filteredEmployees = useMemo(() => {
    const q = personQuery.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter(
      (u) =>
        u.full_name.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        u.role.toLowerCase().includes(q),
    );
  }, [employees, personQuery]);

  const rosterEntries = useMemo(() => {
    const entries = [...assignmentsByUser.entries()].sort((a, b) =>
      (a[1][0]?.user_name || '').localeCompare(b[1][0]?.user_name || ''),
    );
    const q = rosterQuery.trim().toLowerCase();
    if (!q) return entries;
    return entries.filter(([, rows]) => {
      const first = rows[0];
      return (
        first.user_name.toLowerCase().includes(q) ||
        first.user_email.toLowerCase().includes(q) ||
        rows.some((r) => r.site_name.toLowerCase().includes(q) || (r.office_name || '').toLowerCase().includes(q))
      );
    });
  }, [assignmentsByUser, rosterQuery]);

  const selectedPerson = employees.find((u) => u.id === employeeId);
  const selectedLocLabels = selectedLocationIds
    .map((id) => {
      const loc = locationById.get(id);
      return loc ? locationLabel(loc, officeNameById.get(loc.office_id || '') || null) : null;
    })
    .filter(Boolean) as string[];

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
    } else {
      setSelectedLocationIds([]);
    }
  }, [employeeId, assignmentsByUser, initialOfficeId]);

  const toggleLocation = (id: string) => {
    setSelectedLocationIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const assignEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) {
      setMsg('Please select a person.');
      return;
    }
    if (selectedLocationIds.length === 0) {
      setMsg('Select at least one location, or use Clear all on their row to remove assignments.');
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
    setMsg(
      `Saved ${selectedLocLabels.length} location${selectedLocLabels.length === 1 ? '' : 's'} for ${emp?.full_name || 'user'}: ${selectedLocLabels.join(', ')}.`,
    );
    setEmployeeId('');
    setPersonQuery('');
    await load();
    onAssigned?.();
  };

  const assignAllEmployees = async () => {
    const targetId = selectedLocationIds[0] || selectedOffice?.id;
    if (!targetId) {
      setMsg('Select at least one location first.');
      return;
    }
    const target = locationById.get(targetId);
    if (!target) {
      setMsg('Selected location not found.');
      return;
    }
    const staffCount = employees.length;
    if (staffCount === 0) {
      setMsg('No employees, managers, or HR found in your organization.');
      return;
    }
    const label = locationLabel(target, officeNameById.get(target.office_id || '') || null);
    if (
      !confirm(
        `Add "${label}" to all ${staffCount} staff? Existing other location assignments are kept; this location is added for everyone.`,
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
    setMsg(`Added "${target.name}" to ${data ?? staffCount} staff. Other assigned locations were not removed.`);
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
      setMsg('Please select a location.');
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
        `Assigned "${selectedOffice.name}" as team zone for ${mgr?.full_name || 'manager'}. Team members without a personal assignment inherit this zone.`,
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
            <UserCheck size={18} /> Assign people
          </h3>
          <p className="attendance-card__subtitle">
            Choose a person, then the location pins that count for their presence.
          </p>
        </>
      )}

      {msg && (
        <div
          className={`admin-office-alert ${isErrorMsg(msg) ? 'admin-office-alert--error' : 'admin-office-alert--success'} admin-office-alert--tight`}
          role="status"
        >
          <span>{msg}</span>
          <button type="button" className="admin-office-alert__dismiss" onClick={() => setMsg('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {loading ? (
        <div className="admin-office-loading" style={{ padding: '2rem 1rem' }}>
          <Loader2 size={24} className="spin-icon" />
          <span>Loading assignments…</span>
        </div>
      ) : activeLocations.length === 0 ? (
        <div className="admin-office-empty">
          <MapPin size={40} strokeWidth={1.25} />
          <h4>No locations yet</h4>
          <p>Capture live GPS below, name the location, and save — then assign people to it.</p>
          <LiveGpsCapture
            latitude={quickOffice.latitude}
            longitude={quickOffice.longitude}
            onCapture={(lat, lng) => setQuickOffice((o) => ({ ...o, latitude: lat, longitude: lng }))}
          />
          <form onSubmit={saveQuickOffice} className="attendance-form-grid attendance-form-grid--wide admin-office-assign-quick">
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
                {quickSaving ? <Loader2 size={16} className="spin-icon" /> : <><MapPin size={16} /> Save location</>}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <section className="admin-office-assign-block" aria-label="Assign locations">
            {!embedded && (
              <div className="admin-office-assign-intro">
                <h4>Assign locations</h4>
                <p>Pick a person, then toggle the locations that apply. Saving replaces their current set.</p>
              </div>
            )}

            <form onSubmit={assignEmployee} className="admin-office-assign-form">
              <div className="admin-office-assign-step">
                <span className="admin-office-assign-step__num" aria-hidden>
                  1
                </span>
                <div className="admin-office-assign-step__body">
                  <label htmlFor="assign-person-search">Person</label>
                  <div className="admin-office-assign-search">
                    <Search size={15} aria-hidden />
                    <input
                      id="assign-person-search"
                      type="search"
                      value={personQuery}
                      onChange={(e) => setPersonQuery(e.target.value)}
                      placeholder="Search by name…"
                      autoComplete="off"
                    />
                  </div>
                  <select
                    id="assign-person-select"
                    value={employeeId}
                    onChange={(e) => setEmployeeId(e.target.value)}
                    aria-label="Select person"
                  >
                    <option value="">— Select person —</option>
                    {filteredEmployees.map((u) => {
                      const count = assignmentsByUser.get(u.id)?.length || 0;
                      return (
                        <option key={u.id} value={u.id}>
                          {u.full_name}
                          {u.role === 'manager' ? ' · Manager' : u.role === 'hr' ? ' · HR' : ''}
                          {count > 0 ? ` · ${count} location${count === 1 ? '' : 's'}` : ' · none yet'}
                        </option>
                      );
                    })}
                  </select>
                  {selectedPerson && (
                    <p className="admin-office-assign-step__hint">
                      Editing <strong>{selectedPerson.full_name}</strong>
                      {(assignmentsByUser.get(employeeId)?.length || 0) > 0
                        ? ` — currently ${assignmentsByUser.get(employeeId)!.length} location${assignmentsByUser.get(employeeId)!.length === 1 ? '' : 's'}`
                        : ' — no locations yet'}
                    </p>
                  )}
                  {!selectedPerson && unassignedEmployees.length > 0 && (
                    <p className="admin-office-assign-step__hint">
                      {unassignedEmployees.length} person{unassignedEmployees.length === 1 ? '' : 's'} with no personal
                      locations yet
                      {assignments.length > 0 ? ' (may still inherit a manager zone).' : '.'}
                    </p>
                  )}
                </div>
              </div>

              <div className="admin-office-assign-step">
                <span className="admin-office-assign-step__num" aria-hidden>
                  2
                </span>
                <div className="admin-office-assign-step__body">
                  <div className="admin-office-assign-step__label-row">
                    <label>Locations</label>
                    {selectedLocationIds.length > 0 && (
                      <button
                        type="button"
                        className="admin-office-inline-link"
                        onClick={() => setSelectedLocationIds([])}
                      >
                        Clear selection
                      </button>
                    )}
                  </div>
                  <p className="admin-office-assign-step__hint admin-office-assign-step__hint--tight">
                    Toggle one or more. Only selected pins count for presence.
                  </p>
                  <div className="admin-office-loc-picks">
                    {locationsByOffice.map((group) => (
                      <div key={group.key} className="admin-office-loc-picks__group">
                        {locationsByOffice.length > 1 && (
                          <span className="admin-office-loc-picks__office">{group.label}</span>
                        )}
                        <div className="admin-office-loc-picks__chips" role="group" aria-label={`${group.label} locations`}>
                          {group.locs.map((loc) => {
                            const checked = selectedLocationIds.includes(loc.id);
                            return (
                              <button
                                key={loc.id}
                                type="button"
                                className={`admin-office-loc-chip${checked ? ' is-on' : ''}`}
                                aria-pressed={checked}
                                onClick={() => toggleLocation(loc.id)}
                              >
                                <MapPin size={13} aria-hidden />
                                <span className="admin-office-loc-chip__name">{loc.name}</span>
                                <span className="admin-office-loc-chip__meta">{loc.radius_meters}m</span>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ))}
                  </div>

                  {selectedLocLabels.length > 0 && (
                    <div className="admin-office-assign-summary" aria-live="polite">
                      <span className="admin-office-assign-summary__count">
                        {selectedLocLabels.length} selected
                      </span>
                      <span className="admin-office-assign-summary__names">{selectedLocLabels.join(' · ')}</span>
                    </div>
                  )}
                </div>
              </div>

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
                      <UserPlus size={16} /> Save for {selectedPerson?.full_name?.split(' ')[0] || 'person'}
                    </>
                  )}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={assigningAll || selectedLocationIds.length === 0}
                  title="Adds the first selected location to everyone; keeps their other locations"
                  onClick={() => {
                    if (selectedLocationIds[0]) setOfficeId(selectedLocationIds[0]);
                    void assignAllEmployees();
                  }}
                >
                  {assigningAll ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : (
                    <>
                      <Users size={16} /> Add to everyone
                    </>
                  )}
                </button>
              </div>
            </form>
          </section>

          <section className="admin-office-roster" aria-labelledby="assign-roster-heading">
            <div className="admin-office-roster__head">
              <div>
                <h4 id="assign-roster-heading">Current assignments</h4>
                <p>
                  {assignmentsByUser.size === 0
                    ? 'No one assigned yet'
                    : `${assignmentsByUser.size} person${assignmentsByUser.size === 1 ? '' : 's'} · ${employeeAssignments.length} location link${employeeAssignments.length === 1 ? '' : 's'}`}
                </p>
              </div>
              {assignmentsByUser.size > 0 && (
                <div className="admin-office-assign-search admin-office-assign-search--compact">
                  <Search size={14} aria-hidden />
                  <input
                    type="search"
                    value={rosterQuery}
                    onChange={(e) => setRosterQuery(e.target.value)}
                    placeholder="Filter…"
                    aria-label="Filter assignments"
                    autoComplete="off"
                  />
                </div>
              )}
            </div>

            {assignmentsByUser.size === 0 ? (
              <div className="admin-office-empty admin-office-empty--compact">
                <Users size={32} strokeWidth={1.25} />
                <h4>No assignments yet</h4>
                <p>Select a person above, toggle locations, and save.</p>
              </div>
            ) : rosterEntries.length === 0 ? (
              <p className="admin-office-assign-empty-filter">No matches for “{rosterQuery}”.</p>
            ) : (
              <ul className="admin-office-roster__list">
                {rosterEntries.map(([userId, rows]) => {
                  const first = rows[0];
                  return (
                    <li key={userId} className="admin-office-roster__row">
                      <div className="admin-office-roster__person">
                        <span className="admin-office-roster__name">{first.user_name}</span>
                        <span className="admin-office-roster__role">{roleLabel(first.user_role)}</span>
                      </div>
                      <div className="admin-office-roster__locs">
                        {rows.map((a) => {
                          const label =
                            a.office_name && a.office_name !== a.site_name
                              ? `${a.office_name} · ${a.site_name}`
                              : a.site_name;
                          return (
                            <span key={a.site_id} className="admin-office-roster__chip" title={`${label} · ${a.radius_meters}m`}>
                              <MapPin size={12} aria-hidden />
                              <span>{a.site_name}</span>
                              <button
                                type="button"
                                className="admin-office-roster__chip-remove"
                                aria-label={`Remove ${a.site_name} from ${a.user_name}`}
                                onClick={() => void removeEmployeeAssignment(a.site_id, a.user_name, a.site_name)}
                              >
                                <X size={12} />
                              </button>
                            </span>
                          );
                        })}
                      </div>
                      {rows.length > 1 && (
                        <button
                          type="button"
                          className="admin-office-inline-link admin-office-roster__clear"
                          onClick={() => void clearAllForPerson(userId, first.user_name)}
                        >
                          Clear all
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          <section className="admin-office-assign-block admin-office-assign-block--managers">
            <button
              type="button"
              className="admin-office-assign-toggle"
              aria-expanded={showManagerSection}
              onClick={() => setShowManagerSection((v) => !v)}
            >
              <UserCheck size={16} />
              <span>
                <strong>Team zone by manager</strong>
                <span className="admin-office-assign-toggle__sub">
                  Optional — unassigned team members inherit their manager&apos;s single location
                  {assignments.length > 0 ? ` · ${assignments.length} active` : ''}
                </span>
              </span>
              <span className="admin-office-assign-toggle__chev">{showManagerSection ? 'Hide' : 'Show'}</span>
            </button>

            {showManagerSection && (
              <div className="admin-office-assign-manager-body">
                {managers.length === 0 ? (
                  <p className="admin-office-assign-step__hint">
                    No managers found. Create a manager account under Users if you need team-level assignment.
                  </p>
                ) : (
                  <form onSubmit={assign} className="attendance-form-grid attendance-form-grid--wide">
                    <div className="form-group">
                      <label htmlFor="assign-manager-select">Manager</label>
                      <select
                        id="assign-manager-select"
                        value={managerId}
                        onChange={(e) => setManagerId(e.target.value)}
                        required
                      >
                        <option value="">— Select manager —</option>
                        {managers.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.full_name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="form-group">
                      <label htmlFor="assign-manager-loc">Location</label>
                      <select
                        id="assign-manager-loc"
                        value={officeId}
                        onChange={(e) => setOfficeId(e.target.value)}
                        required
                      >
                        <option value="">— Select location —</option>
                        {activeLocations.map((o) => (
                          <option key={o.id} value={o.id}>
                            {locationLabel(o, officeNameById.get(o.office_id || '') || null)} ({o.radius_meters}m)
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="admin-office-assign-actions">
                      <button type="submit" className="btn btn-primary" disabled={saving || !managerId || !officeId}>
                        {saving ? (
                          <Loader2 size={16} className="spin-icon" />
                        ) : (
                          <>
                            <UserCheck size={16} /> Assign team zone
                          </>
                        )}
                      </button>
                    </div>
                  </form>
                )}

                {assignments.length > 0 && (
                  <ul className="admin-office-roster__list admin-office-roster__list--managers">
                    {assignments.map((a) => (
                      <li key={a.site_id} className="admin-office-roster__row">
                        <div className="admin-office-roster__person">
                          <span className="admin-office-roster__name">{a.manager_name}</span>
                          <span className="admin-office-roster__role">Team zone</span>
                        </div>
                        <div className="admin-office-roster__locs">
                          <span className="admin-office-roster__chip admin-office-roster__chip--static">
                            <MapPin size={12} aria-hidden />
                            <span>
                              {a.site_name}
                              {a.team_count > 0
                                ? ` · ${a.team_count} on team`
                                : ''}
                            </span>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="admin-office-inline-link admin-office-roster__clear"
                          onClick={() => void remove(a.manager_id, a.manager_name)}
                        >
                          <Trash2 size={13} /> Remove
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
