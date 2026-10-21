import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

/** Draft row for one office Wi-Fi network (SSID required when BSSID/IP set). */
type WifiNetworkDraft = {
  key: string;
  id?: string | null;
  ssid: string;
  bssid: string;
  public_ip: string;
};

function newWifiDraft(partial?: Partial<WifiNetworkDraft>): WifiNetworkDraft {
  return {
    key: partial?.key || `wifi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    id: partial?.id ?? null,
    ssid: partial?.ssid ?? '',
    bssid: partial?.bssid ?? '',
    public_ip: partial?.public_ip ?? '',
  };
}

function draftsFromLocationAggregates(loc: OfficeLocation): WifiNetworkDraft[] {
  const ssids = loc.wifi_ssids || [];
  if (ssids.length === 0) return [newWifiDraft()];
  const bssids = loc.wifi_bssids || [];
  const ips = loc.public_ip_cidrs || [];
  // Legacy flat arrays: one SSID per row; optional BSSID/IP only on first when lengths differ.
  return ssids.map((ssid, i) =>
    newWifiDraft({
      ssid,
      bssid: bssids[i] || '',
      public_ip: ips[i] || '',
    }),
  );
}

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
  /** True while list_office_wifi_networks is loading for the open location edit. */
  const [wifiListLoading, setWifiListLoading] = useState(false);
  const wifiLoadGenRef = useRef(0);
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
    wifi_networks: [newWifiDraft()] as WifiNetworkDraft[],
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
    wifiLoadGenRef.current += 1;
    setWifiListLoading(false);
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
      wifi_networks: [newWifiDraft()],
    });
  };

  const updateWifiDraft = (key: string, patch: Partial<WifiNetworkDraft>) => {
    setForm((f) => ({
      ...f,
      wifi_networks: f.wifi_networks.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
  };

  const addWifiDraft = () => {
    setForm((f) => ({ ...f, wifi_networks: [...f.wifi_networks, newWifiDraft()] }));
  };

  const removeWifiDraft = (key: string) => {
    setForm((f) => {
      const next = f.wifi_networks.filter((row) => row.key !== key);
      // Keep one empty draft so the form stays usable; empty rows are dropped on save
      // and replace_office_wifi_networks deletes any DB rows not in the payload.
      return { ...f, wifi_networks: next.length > 0 ? next : [newWifiDraft()] };
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
    const fallbackWifi = draftsFromLocationAggregates(loc);
    const loadGen = ++wifiLoadGenRef.current;
    setWifiListLoading(true);
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
      wifi_networks: fallbackWifi,
    });
    setActiveTab('location');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // Prefer multi-network table rows (with ids) so Update/replace can delete removed SSIDs.
    // Inputs stay disabled until this finishes so the load cannot wipe in-progress edits.
    void (async () => {
      try {
        const { data, error } = await supabase.rpc('list_office_wifi_networks', { p_office_id: loc.id });
        if (wifiLoadGenRef.current !== loadGen) return;
        if (error) {
          if (!isMissingRpc(error.message)) {
            showMsg(`Could not load saved Wi-Fi networks: ${error.message}`);
          }
          return;
        }
        const rows = (data || []) as Array<{
          id?: string;
          ssids?: string[];
          wifi_bssids?: string[];
          public_ip_cidrs?: string[];
          active?: boolean;
        }>;
        const activeRows = rows.filter((r) => r.active !== false);
        const source = activeRows.length > 0 ? activeRows : rows;
        setForm((f) => {
          if (f.id !== loc.id) return f;
          if (source.length === 0) {
            // DB has no network rows — keep aggregate drafts (or one empty row).
            return f;
          }
          return {
            ...f,
            wifi_networks: source.map((r) =>
              newWifiDraft({
                id: r.id || null,
                ssid: (r.ssids && r.ssids[0]) || '',
                bssid: (r.wifi_bssids || []).filter(Boolean).join(', '),
                public_ip: (r.public_ip_cidrs && r.public_ip_cidrs[0]) || '',
              }),
            ),
          };
        });
      } finally {
        if (wifiLoadGenRef.current === loadGen) setWifiListLoading(false);
      }
    })();
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
      p_wifi_ssids: existing?.wifi_ssids || [],
      p_wifi_bssids: existing?.wifi_bssids || [],
      p_public_ip_cidrs: existing?.public_ip_cidrs || [],
      // GPS present → Wi-Fi then radius; no GPS yet → Wi-Fi only until location is set.
      p_detection_mode: hasGps ? 'gps_or_wifi' : 'wifi_only',
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
        wifi_networks: existing ? draftsFromLocationAggregates(existing) : [newWifiDraft()],
      });
      setActiveTab('location');
      showMsg(
        hasGps
          ? `"${name}" updated. Adjust GPS, Wi-Fi, or radius below if needed.`
          : `"${name}" saved as a location site (inactive until you set GPS). Capture live GPS and office Wi-Fi below, then Update location.`,
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
    if (wifiListLoading && form.id) {
      showMsg('Still loading saved Wi-Fi networks — wait a moment, then save.');
      return;
    }
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
    const parseBssids = (raw: string): string[] =>
      raw
        .split(/[,;\s]+/)
        .map((b) => b.trim().toLowerCase().replace(/-/g, ':'))
        .filter(Boolean);

    const wifiRows = form.wifi_networks
      .map((row) => ({
        id: row.id || null,
        ssid: row.ssid.trim(),
        bssids: parseBssids(row.bssid),
        public_ip: row.public_ip.trim(),
      }))
      .filter((row) => row.ssid || row.bssids.length > 0 || row.public_ip);

    for (const row of wifiRows) {
      if (!row.ssid) {
        showMsg('Each Wi-Fi row needs a network name (SSID). Remove empty optional BSSID/IP-only rows or add the SSID.');
        return;
      }
    }

    const seenSsids = new Set<string>();
    for (const row of wifiRows) {
      const key = row.ssid.toLowerCase();
      if (seenSsids.has(key)) {
        showMsg(`Duplicate Wi-Fi name “${row.ssid}”. Each network should appear once (add multiple BSSIDs in one row if needed).`);
        return;
      }
      seenSsids.add(key);
    }

    setSaving(true);
    setMsg('');
    const savedName = form.name.trim();
    const wasNew = !form.id;
    const wifiSsids = wifiRows.map((r) => r.ssid);
    const wifiBssids = wifiRows.flatMap((r) => r.bssids);
    const publicIps = wifiRows.map((r) => r.public_ip).filter(Boolean);
    const networkPayload = wifiRows.map((row) => ({
      ...(row.id ? { id: row.id } : {}),
      label: row.ssid,
      ssids: [row.ssid],
      wifi_bssids: row.bssids,
      public_ip_cidrs: row.public_ip ? [row.public_ip] : [],
      active: true,
    }));
    const payload: UpsertLocationArgs = {
      p_id: form.id || null,
      p_name: form.name.trim(),
      p_address: form.address.trim() || null,
      p_latitude: lat,
      p_longitude: lng,
      p_radius_meters: parseInt(form.radius_meters, 10) || 150,
      p_active: form.active,
      p_wifi_ssids: wifiSsids,
      p_wifi_bssids: wifiBssids,
      p_public_ip_cidrs: publicIps,
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
    if (!resolvedId) {
      setSaving(false);
      showMsg('Location save did not return an id — Wi-Fi was not updated. Try again.');
      await load();
      return;
    }

    // Full replace for this location: payload rows are kept/upserted; any DB network
    // not in the payload (removed in the UI) is deleted so it stops matching check-in.
    const { data: wifiResult, error: wifiErr } = await supabase.rpc('replace_office_wifi_networks', {
      p_office_id: resolvedId,
      p_networks: networkPayload,
    });
    if (wifiErr) {
      setSaving(false);
      showMsg(
        isMissingRpc(wifiErr.message)
          ? `Location pin saved, but Wi-Fi was not updated (${wifiErr.message}). Apply wifi_auto_checkin_2026-10-13.sql so replace_office_wifi_networks exists — until then deleted/added SSIDs may not match correctly.`
          : `Location pin saved, but Wi-Fi save failed: ${wifiErr.message}. Retry Update location so the Wi-Fi list fully replaces the previous set.`,
      );
      await load();
      return;
    }
    const wifiWarnings = Array.isArray((wifiResult as { warnings?: unknown })?.warnings)
      ? ((wifiResult as { warnings: string[] }).warnings || []).filter(Boolean)
      : [];

    setSaving(false);
    if (form.default_timezone) {
      await supabase.rpc('update_office_default_timezones', {
        p_office_id: resolvedId,
        p_default_timezone: form.default_timezone,
        p_default_display_timezones: [],
      });
    }
    const parentLabel = form.office_id ? officeNameById.get(form.office_id) : null;
    const radiusM = parseInt(form.radius_meters, 10) || 150;
    const pathNote =
      wifiSsids.length > 0
        ? `the saved office network (${wifiSsids.join(', ')}) or entering ${radiusM}m`
        : `GPS radius only (${radiusM}m) — no Wi-Fi SSIDs saved (removed networks no longer check in)`;
    const warnNote = wifiWarnings.length > 0 ? ` Note: ${wifiWarnings.join(' ')}` : '';
    showMsg(
      wasNew
        ? parentLabel
          ? `"${savedName}" saved under ${parentLabel}. Assigned people auto check in via ${pathNote}.${warnNote}`
          : `"${savedName}" saved. Assigned people auto check in via ${pathNote}.${warnNote}`
        : `"${savedName}" updated. Assigned people auto check in via ${pathNote} during the shift window.${warnNote}`,
    );
    resetLocationForm(form.office_id);
    await load();
    if (wasNew) startAssign(resolvedId);
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
                        Wi-Fi:{' '}
                        {loc.wifi_ssids && loc.wifi_ssids.length > 0
                          ? loc.wifi_ssids.join(', ')
                          : 'not configured'}
                      </p>
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
                                Wi-Fi:{' '}
                                {loc.wifi_ssids && loc.wifi_ssids.length > 0
                                  ? loc.wifi_ssids.join(', ')
                                  : 'not configured'}
                              </p>
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
              ? 'Update GPS center, radius, and the saved office network. The saved office network is used for automatic check-in.'
              : parentOfficesOk
                ? 'Pick the parent office, capture live GPS, set the radius, and save the office network. The saved office network is used for automatic check-in.'
                : 'Capture live GPS, set the radius, and save the office network. The saved office network is used for automatic check-in.'}
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
                      With mobile location on, entering this radius during the check-in window auto checks in
                      assigned people (Android + desktop). Same window as Wi-Fi: 1 hour before shift start until
                      shift end.
                    </p>
                  </div>

                  <div className="form-group admin-office-span-full">
                    <p className="admin-office-form-section__title" style={{ marginBottom: '0.5rem' }}>
                      This location’s Wi-Fi networks (optional auto check-in path)
                    </p>
                    <p className="admin-office-form-help" style={{ marginBottom: '0.75rem' }}>
                      Networks saved here apply only to this location pin — not sibling locations under the same
                      office. The saved office network is used for automatic check-in. Public or unsaved Wi-Fi does
                      not check people in. Browser does not auto check in (manual Clock in can still use GPS or a
                      saved public IP). Native iOS auto check-in is off.
                    </p>
                    {wifiListLoading && form.id ? (
                      <p className="admin-office-form-help" style={{ marginBottom: '0.75rem' }}>
                        Loading saved Wi-Fi networks…
                      </p>
                    ) : null}
                    <div className={`admin-office-wifi-list${wifiListLoading && form.id ? ' is-loading' : ''}`}>
                      {form.wifi_networks.map((row, index) => (
                        <div key={row.key} className="admin-office-wifi-row">
                          <div className="admin-office-wifi-row__head">
                            <span className="admin-office-wifi-row__label">Network {index + 1}</span>
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              onClick={() => removeWifiDraft(row.key)}
                              aria-label={`Remove Wi-Fi network ${index + 1}`}
                              disabled={
                                (wifiListLoading && !!form.id) ||
                                (form.wifi_networks.length === 1 &&
                                  !row.ssid.trim() &&
                                  !row.bssid.trim() &&
                                  !row.public_ip.trim())
                              }
                            >
                              <Trash2 size={14} /> Remove
                            </button>
                          </div>
                          <div className="admin-office-wifi-row__grid">
                            <div className="form-group">
                              <label htmlFor={`location-wifi-ssid-${row.key}`}>Wi-Fi network name (SSID)</label>
                              <input
                                id={`location-wifi-ssid-${row.key}`}
                                value={row.ssid}
                                onChange={(e) => updateWifiDraft(row.key, { ssid: e.target.value })}
                                placeholder="e.g. Office-Staff"
                                autoComplete="off"
                                disabled={wifiListLoading && !!form.id}
                              />
                            </div>
                            <div className="form-group">
                              <label htmlFor={`location-wifi-bssid-${row.key}`}>BSSID / MAC (optional)</label>
                              <input
                                id={`location-wifi-bssid-${row.key}`}
                                value={row.bssid}
                                onChange={(e) => updateWifiDraft(row.key, { bssid: e.target.value })}
                                placeholder="aa:bb:cc:dd:ee:ff (comma-separate for mesh APs)"
                                autoComplete="off"
                                disabled={wifiListLoading && !!form.id}
                              />
                            </div>
                            <div className="form-group">
                              <label htmlFor={`location-wifi-ip-${row.key}`}>Public IP or CIDR (optional)</label>
                              <input
                                id={`location-wifi-ip-${row.key}`}
                                value={row.public_ip}
                                onChange={(e) => updateWifiDraft(row.key, { public_ip: e.target.value })}
                                placeholder="e.g. 203.0.113.10 or 203.0.113.0/24"
                                autoComplete="off"
                                disabled={wifiListLoading && !!form.id}
                              />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={addWifiDraft}
                      disabled={wifiListLoading && !!form.id}
                    >
                      <Plus size={14} /> Add another Wi-Fi
                    </button>
                    <p className="admin-office-form-help" style={{ marginTop: '0.5rem' }}>
                      Add or remove networks anytime, then Save/Update location — the saved list fully replaces the
                      previous one. The saved office network is used for automatic check-in. Optional public IP/CIDR
                      is an alternate match for browser / IP-only setups.
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
                      disabled={
                        saving ||
                        (wifiListLoading && !!form.id) ||
                        (parentOfficesOk && !form.office_id)
                      }
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
