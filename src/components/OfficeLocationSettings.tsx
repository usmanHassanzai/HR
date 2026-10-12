import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  MapPin,
  Loader2,
  Trash2,
  Plus,
  Pencil,
  UserCheck,
  Navigation,
  AlertCircle,
  CheckCircle2,
  Users,
  Building2,
} from 'lucide-react';
import { OfficeGroup, OfficeLocation } from '../utils/geoAttendance';
import AssignManagerLocationPanel, { ManagerSiteRow, EmployeeSiteRow } from './AssignManagerLocationPanel';
import LiveGpsCapture from './LiveGpsCapture';
import TimeZonePicker from './TimeZonePicker';
import '../styles/attendance.css';
import '../styles/admin-office.css';

const MapLocationPicker = lazy(() => import('./MapLocationPicker'));

type OfficeTab = 'offices' | 'location' | 'assign';

function isMissingRpc(message: string): boolean {
  return /function|does not exist|schema cache|could not find the function|PGRST202/i.test(message);
}

function isAlertError(message: string): boolean {
  return /fail|denied|required|please|error|must|cannot|warn|not exist|schema cache|could not find|PGRST|permission|exception|missing|apply migration/i.test(
    message,
  );
}

type UpsertLocationArgs = {
  p_id: string | null;
  p_name: string;
  p_address: string | null;
  p_latitude: number;
  p_longitude: number;
  p_radius_meters: number;
  p_active: boolean;
  p_wifi_ssids: string[];
  p_wifi_bssids: string[];
  p_public_ip_cidrs: string[];
  p_detection_mode: string;
  p_office_id?: string | null;
};

/** Prefer parent-office overload; fall back to flat upsert when p_office_id is unsupported. */
async function upsertOfficeLocationRpc(args: UpsertLocationArgs) {
  const withOffice = await supabase.rpc('upsert_office_location', args);
  if (
    !withOffice.error ||
    args.p_office_id == null ||
    args.p_office_id === undefined ||
    !isMissingRpc(withOffice.error.message)
  ) {
    return withOffice;
  }
  const { p_office_id: _omit, ...flatArgs } = args;
  return supabase.rpc('upsert_office_location', flatArgs);
}

export default function OfficeLocationSettings() {
  const [officeGroups, setOfficeGroups] = useState<OfficeGroup[]>([]);
  const [locations, setLocations] = useState<OfficeLocation[]>([]);
  const [assignments, setAssignments] = useState<ManagerSiteRow[]>([]);
  const [employeeAssignments, setEmployeeAssignments] = useState<EmployeeSiteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savingOffice, setSavingOffice] = useState(false);
  const [msg, setMsg] = useState('');
  /** False when get_offices / upsert_office are not on the live DB — use flat office_locations. */
  const [parentOfficesOk, setParentOfficesOk] = useState(true);
  const [activeTab, setActiveTab] = useState<OfficeTab>('offices');
  const [assignLocationId, setAssignLocationId] = useState('');
  const [assignKey, setAssignKey] = useState(0);
  const [officeForm, setOfficeForm] = useState({ id: '' as string | null, name: '', active: true });
  const [form, setForm] = useState({
    id: '' as string | null,
    office_id: '',
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radius_meters: '150',
    active: true,
    default_timezone: '',
  });

  const showMsg = useCallback((text: string) => {
    setMsg(text);
    if (text && !isAlertError(text)) {
      setTimeout(() => setMsg(''), 6000);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [officesRes, locsRes, sitesRes, empSitesRes] = await Promise.all([
      supabase.rpc('get_offices'),
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_manager_work_sites'),
      supabase.rpc('get_employee_work_sites'),
    ]);

    if (officesRes.error) {
      if (isMissingRpc(officesRes.error.message)) {
        setParentOfficesOk(false);
        setOfficeGroups([]);
      } else {
        showMsg(officesRes.error.message);
        setOfficeGroups([]);
      }
    } else {
      setParentOfficesOk(true);
      setOfficeGroups((officesRes.data || []) as OfficeGroup[]);
    }

    if (locsRes.error) showMsg(locsRes.error.message);
    else setLocations((locsRes.data || []) as OfficeLocation[]);
    if (!sitesRes.error) setAssignments((sitesRes.data || []) as ManagerSiteRow[]);
    if (!empSitesRes.error) {
      setEmployeeAssignments((empSitesRes.data || []) as EmployeeSiteRow[]);
    }
    setLoading(false);
  }, [showMsg]);

  useEffect(() => {
    void load();
  }, [load]);

  const officeNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const o of officeGroups) map.set(o.id, o.name);
    return map;
  }, [officeGroups]);

  const locationsByOffice = useMemo(() => {
    const map = new Map<string, OfficeLocation[]>();
    for (const loc of locations) {
      const key = loc.office_id || '_ungrouped';
      const list = map.get(key) || [];
      list.push(loc);
      map.set(key, list);
    }
    return map;
  }, [locations]);

  const assignedPeopleCount = useMemo(
    () => new Set(employeeAssignments.map((a) => a.user_id)).size,
    [employeeAssignments],
  );

  const resetLocationForm = (officeId = '') => {
    setForm({
      id: null,
      office_id: officeId,
      name: '',
      address: '',
      latitude: '',
      longitude: '',
      radius_meters: '150',
      active: true,
      default_timezone: '',
    });
  };

  const resetOfficeForm = () => {
    setOfficeForm({ id: null, name: '', active: true });
  };

  const startAddOffice = () => {
    resetOfficeForm();
    setMsg('');
    setActiveTab('offices');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const startAddLocation = (officeId?: string) => {
    const preferred =
      officeId ||
      form.office_id ||
      officeGroups.find((o) => o.active)?.id ||
      officeGroups[0]?.id ||
      '';
    resetLocationForm(preferred);
    setMsg('');
    setActiveTab('location');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const editOfficeGroup = (o: OfficeGroup) => {
    setOfficeForm({ id: o.id, name: o.name, active: o.active });
    setActiveTab('offices');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const editLocation = (loc: OfficeLocation) => {
    setForm({
      id: loc.id,
      office_id: loc.office_id || '',
      name: loc.name,
      address: loc.address || '',
      latitude: String(loc.latitude),
      longitude: String(loc.longitude),
      radius_meters: String(loc.radius_meters),
      active: loc.active,
      default_timezone: loc.default_timezone || '',
    });
    setActiveTab('location');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const setCoords = (lat: string, lng: string, _accuracy?: number | null) => {
    setForm((f) => ({ ...f, latitude: lat, longitude: lng }));
    showMsg('Current location captured — this exact spot will be the check-in center when you save.');
  };

  const startAssign = (locationId: string) => {
    setAssignLocationId(locationId);
    setAssignKey((k) => k + 1);
    setActiveTab('assign');
    setTimeout(() => {
      document.getElementById('assign-manager-location')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  /** Flat-mode create/update via office_locations so Save works before parent-office migration. */
  const saveOfficeAsFlatLocation = async (name: string, active: boolean, existingId: string | null) => {
    const existing = existingId ? locations.find((l) => l.id === existingId) : undefined;
    const hasGps =
      existing != null &&
      Number.isFinite(existing.latitude) &&
      Number.isFinite(existing.longitude) &&
      !(existing.latitude === 0 && existing.longitude === 0);
    const { data, error } = await upsertOfficeLocationRpc({
      p_id: existingId,
      p_name: name,
      p_address: existing?.address ?? null,
      p_latitude: hasGps ? existing!.latitude : 0,
      p_longitude: hasGps ? existing!.longitude : 0,
      p_radius_meters: existing?.radius_meters || 150,
      // New / no-GPS sites stay inactive so 0,0 is never used for check-in
      p_active: hasGps ? active : false,
      p_wifi_ssids: [],
      p_wifi_bssids: [],
      p_public_ip_cidrs: [],
      p_detection_mode: 'gps_or_wifi',
    });
    if (error) {
      showMsg(
        isMissingRpc(error.message)
          ? `Cannot save: ${error.message}. Apply migration office_multi_locations_assign_2026-10-12.sql (or ensure upsert_office_location exists).`
          : error.message,
      );
      return null;
    }
    const id = (data as string) || existingId;
    resetOfficeForm();
    await load();
    if (id) {
      setForm({
        id,
        office_id: '',
        name,
        address: existing?.address || '',
        latitude: hasGps ? String(existing!.latitude) : '',
        longitude: hasGps ? String(existing!.longitude) : '',
        radius_meters: String(existing?.radius_meters || 150),
        active: hasGps ? active : false,
        default_timezone: existing?.default_timezone || '',
      });
      setActiveTab('location');
      showMsg(
        hasGps
          ? `"${name}" updated. Adjust GPS or radius below if needed.`
          : `"${name}" saved as a location site (inactive until you set GPS). Capture live GPS below, then Update location.`,
      );
    }
    return id;
  };

  const saveOffice = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!officeForm.name.trim()) {
      showMsg('Office name is required.');
      return;
    }
    setSavingOffice(true);
    setMsg('');
    const wasNew = !officeForm.id;
    const name = officeForm.name.trim();

    if (parentOfficesOk) {
      const { data, error } = await supabase.rpc('upsert_office', {
        p_id: officeForm.id || null,
        p_name: name,
        p_active: officeForm.active,
      });
      if (error) {
        if (isMissingRpc(error.message)) {
          setParentOfficesOk(false);
          await saveOfficeAsFlatLocation(name, officeForm.active, null);
          setSavingOffice(false);
          return;
        }
        setSavingOffice(false);
        showMsg(error.message);
        return;
      }
      setSavingOffice(false);
      const newId = (data as string) || officeForm.id || '';
      showMsg(wasNew ? `"${name}" office created. Add a location pin next.` : 'Office updated.');
      resetOfficeForm();
      await load();
      if (wasNew && newId) startAddLocation(newId);
      return;
    }

    // Parent RPCs missing: create/update via flat office_locations
    await saveOfficeAsFlatLocation(name, officeForm.active, officeForm.id);
    setSavingOffice(false);
  };

  const removeOffice = async (id: string, name: string) => {
    // Flat mode: parent offices table missing — treat id as office_locations row
    if (!parentOfficesOk) {
      const peopleCount = employeeAssignments.filter((a) => a.office_location_id === id).length;
      if (
        !confirm(
          [
            `Delete site "${name}"?`,
            peopleCount
              ? `${peopleCount} assignment${peopleCount !== 1 ? 's' : ''} will be cleared.`
              : 'No one is assigned.',
            'This cannot be undone.',
          ].join('\n\n'),
        )
      ) {
        return;
      }
      const { error } = await supabase.rpc('delete_office_location', { p_id: id });
      if (error) {
        showMsg(error.message);
        return;
      }
      if (officeForm.id === id) resetOfficeForm();
      if (form.id === id) resetLocationForm();
      showMsg(`"${name}" deleted.`);
      void load();
      return;
    }

    const locs = locationsByOffice.get(id) || [];
    const locCount = locs.length;
    const locIds = new Set(locs.map((l) => l.id));
    const peopleCount = employeeAssignments.filter((a) => a.office_location_id && locIds.has(a.office_location_id)).length;
    const parts = [
      `Delete office "${name}"?`,
      locCount ? `This removes ${locCount} location pin${locCount !== 1 ? 's' : ''} under it.` : 'It has no location pins.',
      peopleCount
        ? `${peopleCount} people assignment${peopleCount !== 1 ? 's' : ''} to those pins will be cleared.`
        : 'No people are assigned to its locations.',
      'This cannot be undone.',
    ];
    if (!confirm(parts.join('\n\n'))) return;
    const { error } = await supabase.rpc('delete_office', { p_id: id });
    if (error) {
      showMsg(
        isMissingRpc(error.message)
          ? `Delete failed: ${error.message}. Apply office_multi_locations_assign_2026-10-12.sql for delete_office.`
          : error.message,
      );
      return;
    }
    if (officeForm.id === id) resetOfficeForm();
    showMsg(`Office "${name}" deleted.`);
    void load();
  };

  const saveLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    if (parentOfficesOk && !form.office_id) {
      showMsg('Select a parent office first (or create one under Offices).');
      return;
    }
    if (!form.name.trim()) {
      showMsg('Location name is required.');
      return;
    }
    if (!form.latitude || !form.longitude) {
      showMsg('Please capture live GPS first or enter latitude and longitude.');
      return;
    }
    const lat = parseFloat(form.latitude);
    const lng = parseFloat(form.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      showMsg('Latitude and longitude must be valid numbers.');
      return;
    }
    setSaving(true);
    setMsg('');
    const savedName = form.name.trim();
    const wasNew = !form.id;
    const payload: UpsertLocationArgs = {
      p_id: form.id || null,
      p_name: form.name.trim(),
      p_address: form.address.trim() || null,
      p_latitude: lat,
      p_longitude: lng,
      p_radius_meters: parseInt(form.radius_meters, 10) || 150,
      p_active: form.active,
      p_wifi_ssids: [],
      p_wifi_bssids: [],
      p_public_ip_cidrs: [],
      p_detection_mode: 'gps_or_wifi',
    };
    if (parentOfficesOk && form.office_id) {
      payload.p_office_id = form.office_id;
    }
    const { data: locationId, error } = await upsertOfficeLocationRpc(payload);
    if (error) {
      setSaving(false);
      showMsg(
        isMissingRpc(error.message)
          ? `Save failed: ${error.message}. Ensure upsert_office_location is applied on Supabase.`
          : error.message,
      );
      return;
    }
    const resolvedId = (locationId as string) || form.id;
    setSaving(false);
    if (resolvedId && form.default_timezone) {
      await supabase.rpc('update_office_default_timezones', {
        p_office_id: resolvedId,
        p_default_timezone: form.default_timezone,
        p_default_display_timezones: [],
      });
    }
    const parentLabel = form.office_id ? officeNameById.get(form.office_id) : null;
    showMsg(
      wasNew
        ? parentLabel
          ? `"${savedName}" saved under ${parentLabel}. Assign people to this location — other locations do not apply to them.`
          : `"${savedName}" saved. Assign people to this location — other locations do not apply to them.`
        : `"${savedName}" updated. Only people assigned here use this pin and radius.`,
    );
    resetLocationForm(form.office_id);
    await load();
    if (wasNew && resolvedId) startAssign(resolvedId);
  };

  const removeLocation = async (id: string, name: string) => {
    const peopleCount = employeeAssignments.filter((a) => a.office_location_id === id).length;
    const parts = [
      `Delete location "${name}"?`,
      peopleCount
        ? `${peopleCount} people assignment${peopleCount !== 1 ? 's' : ''} to this pin will be cleared — they will lose this GPS check-in area.`
        : 'No one is assigned to this pin.',
      'Other locations under the office stay. This cannot be undone.',
    ];
    if (!confirm(parts.join('\n\n'))) return;
    const { error } = await supabase.rpc('delete_office_location', { p_id: id });
    if (error) {
      showMsg(error.message);
      return;
    }
    if (form.id === id) resetLocationForm(form.office_id);
    showMsg(`Location "${name}" deleted.`);
    void load();
  };

  const activeLocations = locations.filter((o) => o.active);

  if (loading) {
    return (
      <div className="admin-office-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading office &amp; attendance settings…</span>
      </div>
    );
  }

  return (
    <div className="admin-office-page animate-fade-in">
      <header className="admin-office-header glass-panel">
        <div className="admin-office-header__main">
          <div className="admin-office-header__icon">
            <MapPin size={22} />
          </div>
          <div>
            <h2 className="admin-office-header__title">Office &amp; Attendance</h2>
            <p className="admin-office-header__subtitle">
              Create an office, add multiple location pins under it, then assign each person to one or more locations.
              Only their assigned pin(s) and radius count for presence — other locations do not apply.
            </p>
          </div>
          {(parentOfficesOk ? officeGroups.length > 0 : locations.length >= 0) && (
            <button type="button" className="btn btn-primary admin-office-header__add" onClick={() => startAddLocation()}>
              <Plus size={16} /> Add location
            </button>
          )}
        </div>

        <div className="admin-office-stats">
          <div className="admin-office-stat">
            <Building2 size={16} />
            <span className="admin-office-stat__label">{parentOfficesOk ? 'Offices' : 'Sites'}</span>
            <strong>{parentOfficesOk ? officeGroups.length : locations.length}</strong>
          </div>
          <div className="admin-office-stat">
            <MapPin size={16} />
            <span className="admin-office-stat__label">Active locations</span>
            <strong>{activeLocations.length}</strong>
          </div>
          <div className="admin-office-stat">
            <Users size={16} />
            <span className="admin-office-stat__label">People assigned</span>
            <strong>{assignedPeopleCount}</strong>
          </div>
          <div className="admin-office-stat">
            <UserCheck size={16} />
            <span className="admin-office-stat__label">Manager team zones</span>
            <strong>{assignments.length}</strong>
          </div>
        </div>
      </header>

      <div className="admin-office-steps">
        <span className={`admin-office-step ${activeTab === 'offices' ? 'admin-office-step--active' : ''}`}>
          1 · Office
        </span>
        <span className={`admin-office-step ${activeTab === 'location' ? 'admin-office-step--active' : ''}`}>
          2 · Locations
        </span>
        <span className={`admin-office-step ${activeTab === 'assign' ? 'admin-office-step--active' : ''}`}>
          3 · Assign people
        </span>
      </div>

      <div className="admin-office-tabs tab-bar tab-bar--inline-mobile">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'offices' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('offices')}
        >
          <Building2 size={16} />{' '}
          {officeForm.id
            ? parentOfficesOk
              ? 'Edit office'
              : 'Edit site'
            : parentOfficesOk
              ? `Offices (${officeGroups.length})`
              : `Sites (${locations.length})`}
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'location' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('location')}
        >
          {form.id ? <Pencil size={16} /> : <Plus size={16} />} {form.id ? 'Edit location' : 'Add location'}
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'assign' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('assign')}
        >
          <UserCheck size={16} /> Assign people
        </button>
      </div>

      {msg && (
        <div
          className={`admin-office-alert ${isAlertError(msg) ? 'admin-office-alert--error' : 'admin-office-alert--success'}`}
          role="alert"
        >
          {isAlertError(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{msg}</span>
          <button type="button" className="admin-office-alert__dismiss" onClick={() => setMsg('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!parentOfficesOk && (
        <div className="admin-office-alert admin-office-alert--error" role="status">
          <AlertCircle size={18} />
          <span>
            Parent office RPCs (<code>get_offices</code> / <code>upsert_office</code>) are not on this database yet.
            Create/Save still works via location sites. For multi-pin offices, apply{' '}
            <code>office_multi_locations_assign_2026-10-12.sql</code> in Supabase, then refresh.
          </span>
        </div>
      )}

      {activeTab === 'offices' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <Building2 size={18} />{' '}
            {officeForm.id
              ? parentOfficesOk
                ? 'Edit office'
                : 'Edit site'
              : parentOfficesOk
                ? 'Create office'
                : 'Create site'}
          </h3>
          <p>
            {parentOfficesOk
              ? 'An office is the parent (e.g. Headquarters). Add multiple location pins under it afterward — each with its own address, GPS, and radius.'
              : 'Saves as a location site today. After save, capture live GPS on the Locations tab and set Active before assigning people.'}
          </p>

          <form onSubmit={saveOffice} className="attendance-form-grid attendance-form-grid--wide">
            <div className="form-group">
              <label htmlFor="office-group-name">Office name *</label>
              <input
                id="office-group-name"
                value={officeForm.name}
                onChange={(e) => setOfficeForm({ ...officeForm, name: e.target.value })}
                placeholder="e.g. Headquarters"
                required
              />
            </div>
            <div className="form-group admin-office-checkbox-end">
              <label>
                <input
                  type="checkbox"
                  checked={officeForm.active}
                  onChange={(e) => setOfficeForm({ ...officeForm, active: e.target.checked })}
                />
                Active office
              </label>
            </div>
            <div className="admin-office-form-actions">
              <button type="submit" className="btn btn-primary" disabled={savingOffice}>
                {savingOffice ? (
                  <Loader2 size={16} className="spin-icon" />
                ) : officeForm.id ? (
                  <>
                    <Pencil size={16} /> Update office
                  </>
                ) : (
                  <>
                    <Plus size={16} /> Save office
                  </>
                )}
              </button>
              {officeForm.id && (
                <>
                  <button type="button" className="btn btn-secondary" onClick={startAddOffice}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger"
                    onClick={() => void removeOffice(officeForm.id!, officeForm.name.trim() || 'office')}
                  >
                    <Trash2 size={16} /> Delete office
                  </button>
                </>
              )}
            </div>
          </form>

          <div className="admin-office-card__toolbar" style={{ marginTop: '1.5rem' }}>
            <div>
              <h3>
                <MapPin size={18} /> {parentOfficesOk ? 'Offices & locations' : 'Location sites'}
              </h3>
              <p>
                Assign people to specific location pins. Someone on Location A is not covered by Location B unless you
                also assign B.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => startAddLocation()}
              disabled={parentOfficesOk && officeGroups.length === 0}
            >
              <Plus size={16} /> Add location
            </button>
          </div>

          {!parentOfficesOk ? (
            locations.length === 0 ? (
              <div className="admin-office-empty">
                <Building2 size={40} strokeWidth={1.25} />
                <h4>No sites yet</h4>
                <p>Enter a name above and click Save — then capture GPS on the Locations tab.</p>
              </div>
            ) : (
              <div className="admin-office-grid">
                {locations.map((loc) => {
                  const assignedPeople = employeeAssignments.filter((a) => a.office_location_id === loc.id);
                  return (
                    <article
                      key={loc.id}
                      className={`admin-office-item ${loc.active ? '' : 'admin-office-item--inactive'}`}
                    >
                      <div className="admin-office-item__head">
                        <h4>{loc.name}</h4>
                        <span
                          className={`admin-office-item__badge ${loc.active ? '' : 'admin-office-item__badge--inactive'}`}
                        >
                          {loc.active ? 'Active' : 'Inactive'}
                        </span>
                      </div>
                      {loc.address && <p className="admin-office-item__meta">{loc.address}</p>}
                      <div className="admin-office-item__coords">
                        {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)} · {loc.radius_meters}m
                      </div>
                      <p className="admin-office-item__meta">
                        <Users size={12} className="admin-office-item__meta-icon" />
                        {assignedPeople.length > 0
                          ? `${assignedPeople.length} assignment${assignedPeople.length !== 1 ? 's' : ''}`
                          : 'No one assigned'}
                      </p>
                      <div className="admin-office-item__actions">
                        {loc.active && (
                          <button
                            type="button"
                            className="btn btn-primary btn-sm"
                            onClick={() => startAssign(loc.id)}
                          >
                            <UserCheck size={14} /> Assign
                          </button>
                        )}
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => editLocation(loc)}
                          title={`Edit ${loc.name}`}
                        >
                          <Pencil size={14} /> Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => void removeLocation(loc.id, loc.name)}
                          title={`Delete ${loc.name}`}
                          aria-label={`Delete ${loc.name}`}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )
          ) : officeGroups.length === 0 ? (
            <div className="admin-office-empty">
              <Building2 size={40} strokeWidth={1.25} />
              <h4>No offices yet</h4>
              <p>Create an office above, then add one or more location pins under it.</p>
            </div>
          ) : (
            <div className="admin-office-groups">
              {officeGroups.map((group) => {
                const locs = locationsByOffice.get(group.id) || [];
                return (
                  <article key={group.id} className="admin-office-group glass-panel">
                    <div className="admin-office-group__head">
                      <div>
                        <h4>{group.name}</h4>
                        <p className="admin-office-item__meta">
                          {locs.length} location{locs.length !== 1 ? 's' : ''}
                          {!group.active ? ' · Inactive' : ''}
                        </p>
                      </div>
                      <div className="admin-office-item__actions">
                        <button type="button" className="btn btn-secondary btn-sm" onClick={() => startAddLocation(group.id)}>
                          <Plus size={14} /> Location
                        </button>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => editOfficeGroup(group)}
                          title={`Edit office ${group.name}`}
                        >
                          <Pencil size={14} /> Edit office
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          onClick={() => void removeOffice(group.id, group.name)}
                          title={`Delete office ${group.name}`}
                          aria-label={`Delete office ${group.name}`}
                        >
                          <Trash2 size={14} /> Delete
                        </button>
                      </div>
                    </div>

                    {locs.length === 0 ? (
                      <p className="admin-office-item__meta">No locations yet — add a pin for this office.</p>
                    ) : (
                      <div className="admin-office-grid">
                        {locs.map((loc) => {
                          const assignedPeople = employeeAssignments.filter((a) => a.office_location_id === loc.id);
                          const assignedManagers = assignments.filter(
                            (a) => a.site_name === loc.name || a.latitude === loc.latitude,
                          );
                          return (
                            <article
                              key={loc.id}
                              className={`admin-office-item ${loc.active ? '' : 'admin-office-item--inactive'}`}
                            >
                              <div className="admin-office-item__head">
                                <h4>{loc.name}</h4>
                                <span
                                  className={`admin-office-item__badge ${loc.active ? '' : 'admin-office-item__badge--inactive'}`}
                                >
                                  {loc.active ? 'Active' : 'Inactive'}
                                </span>
                              </div>
                              {loc.address && <p className="admin-office-item__meta">{loc.address}</p>}
                              <div className="admin-office-item__coords">
                                {loc.latitude.toFixed(5)}, {loc.longitude.toFixed(5)} · {loc.radius_meters}m
                              </div>
                              <p className="admin-office-item__meta">
                                <Users size={12} className="admin-office-item__meta-icon" />
                                {assignedPeople.length > 0
                                  ? `${assignedPeople.length} assignment${assignedPeople.length !== 1 ? 's' : ''}`
                                  : 'No one assigned'}
                                {assignedManagers.length > 0
                                  ? ` · ${assignedManagers.length} manager team zone${assignedManagers.length !== 1 ? 's' : ''}`
                                  : ''}
                              </p>
                              <div className="admin-office-item__actions">
                                {loc.active && (
                                  <button
                                    type="button"
                                    className="btn btn-primary btn-sm"
                                    onClick={() => startAssign(loc.id)}
                                  >
                                    <UserCheck size={14} /> Assign
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-sm"
                                  onClick={() => editLocation(loc)}
                                  title={`Edit location ${loc.name}`}
                                >
                                  <Pencil size={14} /> Edit location
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger btn-sm"
                                  onClick={() => void removeLocation(loc.id, loc.name)}
                                  title={`Delete location ${loc.name}`}
                                  aria-label={`Delete location ${loc.name}`}
                                >
                                  <Trash2 size={14} /> Delete
                                </button>
                              </div>
                            </article>
                          );
                        })}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === 'location' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <Navigation size={18} /> {form.id ? 'Edit location' : 'Add location'}
          </h3>
          <p>
            {form.id
              ? 'Update this pin’s GPS, radius, or label. Only people assigned to this location use it — other pins do not apply to them.'
              : parentOfficesOk
                ? 'Pick the parent office, stand at the entrance, capture live GPS, set the radius, then save.'
                : 'Stand at the entrance, capture live GPS, set the radius, then save.'}
          </p>

          {parentOfficesOk && officeGroups.length === 0 ? (
            <div className="admin-office-empty">
              <Building2 size={40} strokeWidth={1.25} />
              <h4>Create an office first</h4>
              <p>Locations belong under an office. Create the office, then add pins here.</p>
              <button type="button" className="btn btn-primary" onClick={startAddOffice}>
                <Plus size={16} /> Create office
              </button>
            </div>
          ) : (
            <>
              {parentOfficesOk && (
                <div className="admin-office-form-section">
                  <p className="admin-office-form-section__title">Step 1 · Parent office</p>
                  <div className="form-group">
                    <label htmlFor="location-office">Office *</label>
                    <select
                      id="location-office"
                      value={form.office_id}
                      onChange={(e) => setForm({ ...form, office_id: e.target.value })}
                      required
                    >
                      <option value="">— Select office —</option>
                      {officeGroups.map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              <div className="admin-office-form-section">
                <p className="admin-office-form-section__title">
                  {parentOfficesOk ? 'Step 2' : 'Step 1'} · Stand at location &amp; capture live GPS
                </p>
                <p className="admin-office-form-help">
                  The spot where you stand becomes the center of this location’s check-in zone.
                </p>
                <LiveGpsCapture latitude={form.latitude} longitude={form.longitude} onCapture={setCoords} />
              </div>

              <div className="admin-office-form-section">
                <p className="admin-office-form-section__title">
                  {parentOfficesOk ? 'Step 3' : 'Step 2'} · Map &amp; radius
                </p>
                <div className="admin-office-map-wrap">
                  <Suspense
                    fallback={
                      <div className="dash-loading admin-office-map-fallback">
                        <Loader2 size={24} className="spin-icon" /> Loading map…
                      </div>
                    }
                  >
                    <MapLocationPicker
                      latitude={form.latitude}
                      longitude={form.longitude}
                      radiusMeters={parseInt(form.radius_meters, 10) || 150}
                      onLocationChange={setCoords}
                    />
                  </Suspense>
                </div>
              </div>

              <div className="admin-office-form-section">
                <p className="admin-office-form-section__title">
                  {parentOfficesOk ? 'Step 4' : 'Step 3'} · Location details
                </p>
                <form onSubmit={saveLocation} className="attendance-form-grid attendance-form-grid--wide">
                  <div className="form-group">
                    <label htmlFor="location-name">Location name *</label>
                    <input
                      id="location-name"
                      value={form.name}
                      onChange={(e) => setForm({ ...form, name: e.target.value })}
                      placeholder="e.g. Main entrance"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="location-address">Address (optional)</label>
                    <input
                      id="location-address"
                      value={form.address}
                      onChange={(e) => setForm({ ...form, address: e.target.value })}
                      placeholder="Street, city, country"
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="location-lat">Latitude *</label>
                    <input
                      id="location-lat"
                      type="number"
                      step="any"
                      value={form.latitude}
                      onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                      placeholder="From live GPS"
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="location-lng">Longitude *</label>
                    <input
                      id="location-lng"
                      type="number"
                      step="any"
                      value={form.longitude}
                      onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                      placeholder="From live GPS"
                      required
                    />
                  </div>
                  <div className="form-group admin-office-span-full">
                    <label>Default shift time zone (pre-fill when creating shifts)</label>
                    <TimeZonePicker
                      value={form.default_timezone}
                      onChange={(tz) => setForm({ ...form, default_timezone: tz })}
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="location-radius">Radius for people assigned here (meters)</label>
                    <input
                      id="location-radius"
                      type="number"
                      min={30}
                      max={2000}
                      value={form.radius_meters}
                      onChange={(e) => setForm({ ...form, radius_meters: e.target.value })}
                    />
                    <p className="admin-office-form-help" style={{ marginTop: '0.35rem' }}>
                      Applies only to people assigned to this location. Unassigned locations never count for them.
                    </p>
                  </div>
                  <div className="form-group admin-office-checkbox-end">
                    <label>
                      <input
                        type="checkbox"
                        checked={form.active}
                        onChange={(e) => setForm({ ...form, active: e.target.checked })}
                      />
                      Active location
                    </label>
                  </div>
                  <div className="admin-office-form-actions">
                    <button
                      type="submit"
                      className="btn btn-primary"
                      disabled={saving || (parentOfficesOk && !form.office_id)}
                    >
                      {saving ? (
                        <Loader2 size={16} className="spin-icon" />
                      ) : form.id ? (
                        <>
                          <Pencil size={16} /> Update location
                        </>
                      ) : (
                        <>
                          <Plus size={16} /> Save location
                        </>
                      )}
                    </button>
                    {form.id ? (
                      <>
                        <button type="button" className="btn btn-secondary" onClick={() => startAddLocation(form.office_id)}>
                          Cancel · add another
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger"
                          onClick={() => void removeLocation(form.id!, form.name.trim() || 'location')}
                        >
                          <Trash2 size={16} /> Delete location
                        </button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-secondary" onClick={() => setActiveTab('offices')}>
                        {parentOfficesOk ? 'View offices' : 'View sites'}
                      </button>
                    )}
                  </div>
                </form>
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === 'assign' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <UserCheck size={18} /> Assign people
          </h3>
          <p>
            Choose who needs office presence, then the location pin(s) that count for them. Unassigned pins never apply.
          </p>
          <AssignManagerLocationPanel
            key={assignKey}
            initialOfficeId={assignLocationId}
            embedded
            onAssigned={() => void load()}
          />
        </section>
      )}
    </div>
  );
}
