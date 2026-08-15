import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { OfficeLocation } from '../utils/geoAttendance';
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
  user_role: 'employee' | 'manager' | 'admin';
  site_name: string;
  site_address: string | null;
  latitude: number;
  longitude: number;
  radius_meters: number;
  tracking_enabled: boolean;
}

interface AssignManagerLocationPanelProps {
  /** Pre-select this office when opened from an office row */
  initialOfficeId?: string;
  onAssigned?: () => void;
  /** Hide duplicate headings when nested in OfficeLocationSettings */
  embedded?: boolean;
}

function isErrorMsg(message: string): boolean {
  return /please|fail|only|required|not found|error|cannot|denied/i.test(message);
}

export default function AssignManagerLocationPanel({
  initialOfficeId,
  onAssigned,
  embedded = false,
}: AssignManagerLocationPanelProps) {
  const [managers, setManagers] = useState<Profile[]>([]);
  const [employees, setEmployees] = useState<Profile[]>([]);
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [assignments, setAssignments] = useState<ManagerSiteRow[]>([]);
  const [employeeAssignments, setEmployeeAssignments] = useState<EmployeeSiteRow[]>([]);
  const [managerId, setManagerId] = useState('');
  const [employeeId, setEmployeeId] = useState('');
  const [officeId, setOfficeId] = useState(initialOfficeId || '');
  const [empOfficeId, setEmpOfficeId] = useState(initialOfficeId || '');
  const [saving, setSaving] = useState(false);
  const [savingEmp, setSavingEmp] = useState(false);
  const [assigningAll, setAssigningAll] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [quickOffice, setQuickOffice] = useState({ name: '', latitude: '', longitude: '', radius_meters: '150' });
  const [quickSaving, setQuickSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [usersRes, officesRes, sitesRes, empSitesRes] = await Promise.all([
      supabase.rpc('get_all_users_admin'),
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_manager_work_sites'),
      supabase.rpc('get_employee_work_sites'),
    ]);
    const users = ((usersRes.data || []) as Profile[]).filter((u) => !u.is_demo);
    setManagers(users.filter((u) => u.role === 'manager'));
    setEmployees(users.filter((u) => u.role === 'employee' || u.role === 'manager'));
    setOffices((officesRes.data || []) as OfficeLocation[]);
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
      setEmpOfficeId(initialOfficeId);
    }
  }, [initialOfficeId]);

  const selectedOffice = offices.find((o) => o.id === officeId);
  const selectedEmpOffice = offices.find((o) => o.id === empOfficeId);
  const activeOffices = offices.filter((o) => o.active);
  const unassignedEmployees = employees.filter(
    (e) => !employeeAssignments.some((a) => a.user_id === e.id),
  );

  const assignEmployee = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!employeeId) {
      setMsg('Please select an employee.');
      return;
    }
    if (!selectedEmpOffice) {
      setMsg('Please select an office location first.');
      return;
    }
    setSavingEmp(true);
    setMsg('');
    const { error } = await supabase.rpc('assign_employee_work_site', {
      p_user_id: employeeId,
      p_office_location_id: selectedEmpOffice.id,
      p_name: selectedEmpOffice.name,
      p_address: selectedEmpOffice.address || null,
      p_latitude: selectedEmpOffice.latitude,
      p_longitude: selectedEmpOffice.longitude,
      p_radius_meters: selectedEmpOffice.radius_meters,
      p_tracking_enabled: true,
    });
    setSavingEmp(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    const emp = employees.find((u) => u.id === employeeId);
    setMsg(`Assigned "${selectedEmpOffice.name}" to ${emp?.full_name || 'employee'}.`);
    setEmployeeId('');
    await load();
    onAssigned?.();
  };

  const assignAllEmployees = async () => {
    if (!selectedEmpOffice) {
      setMsg('Please select an office location first.');
      return;
    }
    const empOnlyCount = employees.filter((u) => u.role === 'employee').length;
    if (empOnlyCount === 0) {
      setMsg('No employees found in your organization.');
      return;
    }
    if (
      !confirm(
        `Assign "${selectedEmpOffice.name}" to all ${empOnlyCount} employee${empOnlyCount === 1 ? '' : 's'}? Existing employee assignments will be updated.`,
      )
    ) {
      return;
    }
    setAssigningAll(true);
    setMsg('');
    const { data, error } = await supabase.rpc('assign_office_to_all_employees', {
      p_office_location_id: selectedEmpOffice.id,
    });
    setAssigningAll(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setMsg(`Assigned "${selectedEmpOffice.name}" to ${data ?? empOnlyCount} employee${(data ?? empOnlyCount) === 1 ? '' : 's'}.`);
    await load();
    onAssigned?.();
  };

  const removeEmployee = async (id: string, name: string) => {
    if (!confirm(`Remove office GPS assignment for ${name}?`)) return;
    const { error } = await supabase.rpc('remove_employee_work_site', { p_user_id: id });
    if (error) setMsg(error.message);
    else {
      setMsg('Employee assignment removed.');
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
      setMsg(`Assigned "${selectedOffice.name}" to ${mgr?.full_name || 'manager'}. Their team uses this GPS zone unless an employee has a personal assignment.`);
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
    setMsg('Office saved from live GPS. Select it below to assign.');
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
            <UserCheck size={18} /> Step 2 — Assign office GPS
          </h3>
          <p className="attendance-card__subtitle">
            Assign an office zone to all employees at once, or to any individual. You can also assign by manager so
            their team inherits the same zone.
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
      ) : activeOffices.length === 0 ? (
        <div>
          <p className="attendance-empty" style={{ marginBottom: '1rem' }}>
            No office locations yet. Capture your live GPS below, name the office, and save — then assign it.
          </p>
          <LiveGpsCapture
            latitude={quickOffice.latitude}
            longitude={quickOffice.longitude}
            onCapture={(lat, lng) => setQuickOffice((o) => ({ ...o, latitude: lat, longitude: lng }))}
          />
          <form onSubmit={saveQuickOffice} className="attendance-form-grid attendance-form-grid--wide" style={{ marginTop: '1rem' }}>
            <div className="form-group">
              <label>Office name *</label>
              <input
                value={quickOffice.name}
                onChange={(e) => setQuickOffice({ ...quickOffice, name: e.target.value })}
                placeholder="e.g. Karachi HQ"
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
                {quickSaving ? <Loader2 size={16} className="spin-icon" /> : <><MapPin size={16} /> Save office at live location</>}
              </button>
            </div>
          </form>
        </div>
      ) : (
        <>
          <section className="admin-office-assign-block">
            <h4 className="attendance-card__title" style={{ fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              <Users size={16} /> Assign to employees
            </h4>
            <p className="attendance-card__subtitle" style={{ marginBottom: '1rem' }}>
              Personal assignment overrides the manager team zone for that person.
            </p>

            <form onSubmit={assignEmployee} className="attendance-form-grid attendance-form-grid--wide">
              <div className="form-group">
                <label>Office location</label>
                <select value={empOfficeId} onChange={(e) => setEmpOfficeId(e.target.value)} required>
                  <option value="">— Select office —</option>
                  {activeOffices.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name} ({o.radius_meters}m)
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Employee</label>
                <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
                  <option value="">— Select employee —</option>
                  {employees.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.full_name}
                      {u.role === 'manager' ? ' (manager)' : ''}
                      {employeeAssignments.some((a) => a.user_id === u.id) ? ' · assigned' : ''}
                    </option>
                  ))}
                </select>
              </div>
              {selectedEmpOffice && (
                <div className="form-group" style={{ gridColumn: '1 / -1' }}>
                  <div className="geo-assign-preview">
                    <MapPin size={16} />
                    <span>
                      <strong>{selectedEmpOffice.name}</strong>
                      {' · '}
                      {selectedEmpOffice.latitude.toFixed(5)}, {selectedEmpOffice.longitude.toFixed(5)}
                      {' · '}
                      {selectedEmpOffice.radius_meters}m radius
                    </span>
                  </div>
                </div>
              )}
              <div className="admin-office-assign-actions">
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={savingEmp || !employeeId || !empOfficeId}
                >
                  {savingEmp ? <Loader2 size={16} className="spin-icon" /> : <><UserPlus size={16} /> Assign to employee</>}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={assigningAll || !empOfficeId}
                  onClick={() => void assignAllEmployees()}
                >
                  {assigningAll ? <Loader2 size={16} className="spin-icon" /> : <><Users size={16} /> Assign to all employees</>}
                </button>
              </div>
            </form>

            {unassignedEmployees.filter((u) => u.role === 'employee').length > 0 && (
              <p className="geo-hint" style={{ marginTop: '0.75rem' }}>
                {unassignedEmployees.filter((u) => u.role === 'employee').length} employee
                {unassignedEmployees.filter((u) => u.role === 'employee').length === 1 ? '' : 's'} without a personal
                office assignment
                {assignments.length > 0 ? ' (may still inherit from their manager).' : '.'}
              </p>
            )}

            <div style={{ marginTop: '1.25rem' }}>
              <h4 className="attendance-card__title" style={{ fontSize: '0.9rem', marginBottom: '0.75rem' }}>
                Employee assignments ({employeeAssignments.length})
              </h4>
              {employeeAssignments.length === 0 ? (
                <p className="attendance-empty" style={{ margin: 0 }}>
                  No employees assigned yet. Use Assign to employee or Assign to all employees.
                </p>
              ) : (
                <div className="attendance-approval-list">
                  {employeeAssignments.map((a) => (
                    <div
                      key={a.site_id}
                      className="attendance-approval-item"
                      style={{ borderLeftColor: 'var(--color-success)' }}
                    >
                      <div className="attendance-approval-item__main">
                        <span className="attendance-approval-item__name">
                          {a.user_name}
                          <span className="badge badge-on-track" style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
                            {a.user_role === 'manager' ? 'Manager' : 'Employee'}
                          </span>
                        </span>
                        <span className="attendance-approval-item__meta">Office: {a.site_name}</span>
                        <span className="attendance-approval-item__reason">
                          {a.latitude.toFixed(5)}, {a.longitude.toFixed(5)} · {a.radius_meters}m
                        </span>
                      </div>
                      <div className="attendance-approval-item__actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => void removeEmployee(a.user_id, a.user_name)}
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

          <section className="admin-office-assign-block admin-office-assign-block--managers">
            <h4 className="attendance-card__title" style={{ fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              <UserCheck size={16} /> Assign by manager (whole team)
            </h4>
            <p className="attendance-card__subtitle" style={{ marginBottom: '1rem' }}>
              Optional. Team members without a personal assignment use their manager&apos;s GPS zone.
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
                  <label>Office location</label>
                  <select value={officeId} onChange={(e) => setOfficeId(e.target.value)} required>
                    <option value="">— Select office —</option>
                    {activeOffices.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name} ({o.radius_meters}m)
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
                          Office: {a.site_name} · {a.team_count} employee{a.team_count !== 1 ? 's' : ''} on team
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
