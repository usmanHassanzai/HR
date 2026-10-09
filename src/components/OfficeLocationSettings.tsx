import { Suspense, lazy, useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  MapPin,
  Loader2,
  Trash2,
  Plus,
  UserCheck,
  Navigation,
  AlertCircle,
  CheckCircle2,
  Radio,
  Users,
  Building2,
  Info,
  Wifi,
} from 'lucide-react';
import { OfficeLocation, OfficeWifiNetwork } from '../utils/geoAttendance';
import AssignManagerLocationPanel, { ManagerSiteRow } from './AssignManagerLocationPanel';
import LiveGpsCapture from './LiveGpsCapture';
import TimeZonePicker from './TimeZonePicker';
import AutoAttendanceSettings from './AutoAttendanceSettings';
import '../styles/attendance.css';
import '../styles/admin-office.css';

const MapLocationPicker = lazy(() => import('./MapLocationPicker'));

type OfficeTab = 'create' | 'assign' | 'offices';

function isAlertError(message: string): boolean {
  // Successful save (with or without a Wi-Fi note) must stay green — never red.
  if (/saved|updated|succeed/i.test(message)) return false;
  return /fail|denied|required|please|error|must|cannot/i.test(message);
}

function emptyWifiNetwork(label = ''): OfficeWifiNetwork {
  return { id: null, label, ssid: '', wifi_bssids: '', public_ip_cidrs: '', active: true };
}

function splitList(s: string): string[] {
  return s
    .split(/[\n,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function networkDuplicateWarnings(networks: OfficeWifiNetwork[]): string[] {
  const warnings: string[] = [];
  const seenSsid = new Set<string>();
  const seenBssid = new Set<string>();
  const seenIp = new Set<string>();
  for (const n of networks) {
    if (!n.active) continue;
    for (const s of splitList(n.ssid)) {
      const key = s.toLowerCase();
      if (seenSsid.has(key)) warnings.push(`Duplicate SSID "${s}" across networks in this office`);
      else seenSsid.add(key);
    }
    for (const b of splitList(n.wifi_bssids)) {
      const key = b.toLowerCase();
      if (seenBssid.has(key)) warnings.push(`Duplicate BSSID "${b}" across networks in this office`);
      else seenBssid.add(key);
    }
    for (const ip of splitList(n.public_ip_cidrs)) {
      if (seenIp.has(ip)) warnings.push(`Duplicate public IP/CIDR "${ip}" across networks in this office`);
      else seenIp.add(ip);
    }
  }
  return warnings;
}

function looksLikeIp(value: string): boolean {
  return Boolean(value) && value !== 'unknown' && !value.startsWith('unavailable');
}

async function fetchPublicIp(url: string): Promise<string | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const j = (await r.json()) as { ip?: string };
    return j.ip || null;
  } catch {
    return null;
  }
}

/** Prefer IPv4; also capture IPv6 when the browser/network exposes it (api6 / api64). */
async function probeDeviceWifi(): Promise<{
  publicIp: string;
  publicIps: string[];
  ssid: string;
  bssid: string;
}> {
  const [v4, v6, dual] = await Promise.all([
    fetchPublicIp('https://api.ipify.org?format=json'),
    fetchPublicIp('https://api6.ipify.org?format=json'),
    fetchPublicIp('https://api64.ipify.org?format=json'),
  ]);
  const publicIps = [...new Set([v4, v6, dual].filter((ip): ip is string => Boolean(ip)))];
  const publicIp = v4 || dual || v6 || 'unavailable (network)';
  let ssid = '';
  let bssid = '';
  try {
    const { registerPlugin } = await import('@capacitor/core');
    const probe = registerPlugin<{
      probeNetwork?: () => Promise<{ ssid?: string; bssid?: string }>;
    }>('AttendancePing');
    if (typeof probe.probeNetwork === 'function') {
      const n = await probe.probeNetwork();
      if (n?.ssid) ssid = n.ssid;
      if (n?.bssid) bssid = n.bssid;
    }
  } catch {
    /* web / plugin missing */
  }
  return { publicIp, publicIps, ssid, bssid };
}

export default function OfficeLocationSettings() {
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [assignments, setAssignments] = useState<ManagerSiteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [activeTab, setActiveTab] = useState<OfficeTab>('create');
  const [assignOfficeId, setAssignOfficeId] = useState('');
  const [assignKey, setAssignKey] = useState(0);
  const [wifiNetworksByOffice, setWifiNetworksByOffice] = useState<Record<string, OfficeWifiNetwork[]>>({});
  const [wifiProbe, setWifiProbe] = useState('');
  const [wifiProbing, setWifiProbing] = useState(false);
  const [wifiNetworks, setWifiNetworks] = useState<OfficeWifiNetwork[]>([]);
  const [wifiWarnings, setWifiWarnings] = useState<string[]>([]);
  const [form, setForm] = useState({
    id: '' as string | null,
    name: '',
    address: '',
    latitude: '',
    longitude: '',
    radius_meters: '150',
    active: true,
    detection_mode: 'gps_or_wifi' as 'gps_only' | 'wifi_only' | 'gps_or_wifi',
    default_timezone: '',
    default_display_timezones: '',
  });

  const showMsg = useCallback((text: string) => {
    setMsg(text);
    if (text && !isAlertError(text)) {
      setTimeout(() => setMsg(''), 6000);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [officesRes, sitesRes] = await Promise.all([
      supabase.rpc('get_office_locations'),
      supabase.rpc('get_manager_work_sites'),
    ]);
    if (officesRes.error) showMsg(officesRes.error.message);
    else {
      const list = (officesRes.data || []) as OfficeLocation[];
      setOffices(list);
      const netMap: Record<string, OfficeWifiNetwork[]> = {};
      await Promise.all(
        list.map(async (o) => {
          const { data } = await supabase.rpc('list_office_wifi_networks', { p_office_id: o.id });
          const rows = (data || []) as Array<{
            id: string;
            label: string;
            ssids: string[] | null;
            wifi_bssids: string[] | null;
            public_ip_cidrs: string[] | null;
            active: boolean;
          }>;
          netMap[o.id] = rows.map((r) => ({
            id: r.id,
            label: r.label,
            ssid: (r.ssids || []).join(', '),
            wifi_bssids: (r.wifi_bssids || []).join(', '),
            public_ip_cidrs: (r.public_ip_cidrs || []).join(', '),
            active: r.active,
          }));
        }),
      );
      setWifiNetworksByOffice(netMap);
    }
    if (!sitesRes.error) setAssignments((sitesRes.data || []) as ManagerSiteRow[]);
    setLoading(false);
  }, [showMsg]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const channel = supabase
      .channel('office-settings-live')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'office_locations' },
        () => {
          void load();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load]);

  const resetForm = () => {
    setForm({
      id: null,
      name: '',
      address: '',
      latitude: '',
      longitude: '',
      radius_meters: '150',
      active: true,
      detection_mode: 'gps_or_wifi',
      default_timezone: '',
      default_display_timezones: '',
    });
    setWifiNetworks([]);
    setWifiWarnings([]);
    setWifiProbe('');
  };

  const updateWifiNetwork = (index: number, patch: Partial<OfficeWifiNetwork>) => {
    setWifiNetworks((rows) => {
      const next = rows.map((row, i) => (i === index ? { ...row, ...patch } : row));
      setWifiWarnings(networkDuplicateWarnings(next));
      return next;
    });
  };

  const addWifiNetwork = () => {
    setWifiNetworks((rows) => {
      const next = [...rows, emptyWifiNetwork(rows.length === 0 ? 'Main Wi-Fi' : '')];
      setWifiWarnings(networkDuplicateWarnings(next));
      return next;
    });
  };

  const removeWifiNetwork = (index: number) => {
    const row = wifiNetworks[index];
    if (!confirm(`Delete Wi-Fi network "${row?.label || 'Untitled'}"?`)) return;
    setWifiNetworks((rows) => {
      const next = rows.filter((_, i) => i !== index);
      setWifiWarnings(networkDuplicateWarnings(next));
      return next;
    });
  };

  const useCurrentWifiOnRow = async (index: number) => {
    setWifiProbing(true);
    try {
      const probed = await probeDeviceWifi();
      const ipsToAdd = probed.publicIps.length
        ? probed.publicIps
        : looksLikeIp(probed.publicIp)
          ? [probed.publicIp]
          : [];
      setWifiNetworks((rows) => {
        const next = [...rows];
        while (next.length <= index) next.push(emptyWifiNetwork());
        const cur = next[index] || emptyWifiNetwork();
        next[index] = {
          ...cur,
          label: cur.label || (index === 0 ? 'Main Wi-Fi' : `Wi-Fi ${index + 1}`),
          ssid: probed.ssid || cur.ssid,
          wifi_bssids: probed.bssid
            ? [...new Set([...splitList(cur.wifi_bssids), probed.bssid])].join(', ')
            : cur.wifi_bssids,
          public_ip_cidrs: ipsToAdd.length
            ? [...new Set([...splitList(cur.public_ip_cidrs), ...ipsToAdd])].join(', ')
            : cur.public_ip_cidrs,
        };
        setWifiWarnings(networkDuplicateWarnings(next));
        return next;
      });
      const ipLabel = ipsToAdd.length ? ipsToAdd.join(', ') : probed.publicIp;
      const hasV6 = ipsToAdd.some((ip) => ip.includes(':'));
      setWifiProbe(
        `Filled from this device — IP${ipsToAdd.length > 1 ? 's' : ''}: ${ipLabel}${
          hasV6 ? ' (includes IPv6)' : ''
        }. BSSID: ${probed.bssid || 'n/a'}. SSID: ${probed.ssid || 'n/a'}.`,
      );
    } finally {
      setWifiProbing(false);
    }
  };

  const testOfficeWifi = async () => {
    setWifiProbing(true);
    setWifiProbe('');
    try {
      const probed = await probeDeviceWifi();
      if (!form.id) {
        // Client-side match against draft networks
        const candidateIps = probed.publicIps.length
          ? probed.publicIps
          : looksLikeIp(probed.publicIp)
            ? [probed.publicIp]
            : [];
        let matchedLabel: string | null = null;
        for (const n of wifiNetworks) {
          if (!n.active) continue;
          const ips = splitList(n.public_ip_cidrs);
          // Draft test: exact IP only; full CIDR matching runs server-side after save
          if (!candidateIps.some((ip) => ips.includes(ip))) continue;
          const bssids = splitList(n.wifi_bssids).map((b) => b.toLowerCase());
          const ssids = splitList(n.ssid);
          const ssidOk =
            ssids.length === 0 ||
            (Boolean(probed.ssid) &&
              ssids.some((s) => s.toLowerCase() === probed.ssid.toLowerCase()));
          if (bssids.length) {
            // Prefer BSSID when the device can read it; otherwise same IP + SSID still matches
            // (browsers / some OS builds often omit BSSID).
            if (probed.bssid && bssids.includes(probed.bssid.toLowerCase())) {
              matchedLabel = n.label || 'Untitled';
              break;
            }
            if (!probed.bssid && ssidOk) {
              matchedLabel = n.label || 'Untitled';
              break;
            }
          } else if (ssidOk) {
            matchedLabel = n.label || 'Untitled';
            break;
          }
        }
        const ipShown = candidateIps.length ? candidateIps.join(', ') : probed.publicIp;
        setWifiProbe(
          matchedLabel
            ? `Matched network: ${matchedLabel} (draft). IP: ${ipShown}. BSSID: ${probed.bssid || 'n/a'}.`
            : `No network matched (draft). IP: ${ipShown}. BSSID: ${probed.bssid || 'n/a'}. SSID: ${probed.ssid || 'n/a'}.`,
        );
        return;
      }
      const testIp =
        probed.publicIps.find((ip) => !ip.includes(':')) ||
        probed.publicIps[0] ||
        (looksLikeIp(probed.publicIp) ? probed.publicIp : null);
      const { data, error } = await supabase.rpc('test_office_wifi_match', {
        p_office_id: form.id,
        p_client_ip: testIp,
        p_ssid: probed.ssid || null,
        p_bssid: probed.bssid || null,
      });
      if (error) {
        setWifiProbe(error.message);
        return;
      }
      const row = data as { message?: string; client_ip?: string; bssid?: string; ssid?: string };
      const ipShown = row.client_ip || (probed.publicIps.length ? probed.publicIps.join(', ') : probed.publicIp);
      setWifiProbe(
        `${row.message || 'No network matched'}. IP: ${ipShown}. BSSID: ${row.bssid || probed.bssid || 'n/a'}. SSID: ${row.ssid || probed.ssid || 'n/a'}.`,
      );
    } finally {
      setWifiProbing(false);
    }
  };

  const editOffice = async (o: OfficeLocation) => {
    setForm({
      id: o.id,
      name: o.name,
      address: o.address || '',
      latitude: String(o.latitude),
      longitude: String(o.longitude),
      radius_meters: String(o.radius_meters),
      active: o.active,
      detection_mode: o.detection_mode || 'gps_or_wifi',
      default_timezone: o.default_timezone || '',
      default_display_timezones: (o.default_display_timezones || []).join(', '),
    });
    const { data, error } = await supabase.rpc('list_office_wifi_networks', { p_office_id: o.id });
    if (error) {
      // Fallback to legacy flat columns if RPC not deployed yet
      if ((o.wifi_ssids?.length || o.wifi_bssids?.length || o.public_ip_cidrs?.length)) {
        setWifiNetworks([
          {
            id: null,
            label: 'Main Wi-Fi',
            ssid: (o.wifi_ssids || []).join(', '),
            wifi_bssids: (o.wifi_bssids || []).join(', '),
            public_ip_cidrs: (o.public_ip_cidrs || []).join(', '),
            active: true,
          },
        ]);
      } else {
        setWifiNetworks([]);
      }
    } else {
      const rows = (data || []) as Array<{
        id: string;
        label: string;
        ssids: string[] | null;
        wifi_bssids: string[] | null;
        public_ip_cidrs: string[] | null;
        active: boolean;
      }>;
      setWifiNetworks(
        rows.map((r) => ({
          id: r.id,
          label: r.label,
          ssid: (r.ssids || []).join(', '),
          wifi_bssids: (r.wifi_bssids || []).join(', '),
          public_ip_cidrs: (r.public_ip_cidrs || []).join(', '),
          active: r.active,
        })),
      );
    }
    setWifiWarnings([]);
    setActiveTab('create');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const setCoords = (lat: string, lng: string, _accuracy?: number | null) => {
    setForm((f) => ({ ...f, latitude: lat, longitude: lng }));
    showMsg('Current location captured — this exact spot will be the office check-in center when you save.');
  };

  const startAssign = (officeId: string) => {
    setAssignOfficeId(officeId);
    setAssignKey((k) => k + 1);
    setActiveTab('assign');
    setTimeout(() => {
      document.getElementById('assign-manager-location')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  };

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) {
      showMsg('Office name is required.');
      return;
    }
    if (!form.latitude || !form.longitude) {
      showMsg('Please capture live GPS first or enter latitude and longitude.');
      return;
    }
    for (const n of wifiNetworks) {
      const hasAny =
        n.label.trim() || splitList(n.ssid).length || splitList(n.wifi_bssids).length || splitList(n.public_ip_cidrs).length;
      if (!hasAny) continue;
      if (!n.label.trim()) {
        showMsg('Each Wi-Fi network needs a label.');
        return;
      }
      if (!splitList(n.public_ip_cidrs).length) {
        showMsg(`Network "${n.label}" needs at least one public IP / CIDR (SSID alone is not enough).`);
        return;
      }
    }
    const dupes = networkDuplicateWarnings(wifiNetworks);
    setWifiWarnings(dupes);

    setSaving(true);
    setMsg('');
    const savedName = form.name.trim();
    const wasNew = !form.id;
    const { data: officeId, error } = await supabase.rpc('upsert_office_location', {
      p_id: form.id || null,
      p_name: form.name.trim(),
      p_address: form.address.trim() || null,
      p_latitude: parseFloat(form.latitude),
      p_longitude: parseFloat(form.longitude),
      p_radius_meters: parseInt(form.radius_meters, 10) || 150,
      p_active: form.active,
      p_wifi_ssids: [],
      p_wifi_bssids: [],
      p_public_ip_cidrs: [],
      p_detection_mode: 'gps_or_wifi',
    });
    if (error) {
      setSaving(false);
      showMsg(error.message);
      return;
    }
    const resolvedId = (officeId as string) || form.id;
    if (resolvedId) {
      const payload = wifiNetworks
        .filter(
          (n) =>
            n.label.trim() ||
            splitList(n.ssid).length ||
            splitList(n.wifi_bssids).length ||
            splitList(n.public_ip_cidrs).length,
        )
        .map((n, i) => ({
          id: n.id || null,
          label: n.label.trim() || `Wi-Fi ${i + 1}`,
          ssid: splitList(n.ssid)[0] || null,
          ssids: splitList(n.ssid),
          wifi_bssids: splitList(n.wifi_bssids),
          public_ip_cidrs: splitList(n.public_ip_cidrs),
          active: n.active,
        }));
      const { data: netRes, error: netErr } = await supabase.rpc('replace_office_wifi_networks', {
        p_office_id: resolvedId,
        p_networks: payload,
      });
      if (netErr) {
        setSaving(false);
        showMsg(netErr.message);
        return;
      }
      const warnings = ((netRes as { warnings?: string[] })?.warnings || dupes) as string[];
      if (warnings.length) setWifiWarnings(warnings);
    }
    setSaving(false);
    const { data: refreshed } = await supabase.rpc('get_office_locations');
    const list = (refreshed || []) as OfficeLocation[];
    const match =
      list.find((o) => (resolvedId ? o.id === resolvedId : o.name === savedName)) ||
      list.find((o) => o.name === savedName);
    if (match && (form.default_timezone || form.default_display_timezones)) {
      await supabase.rpc('update_office_default_timezones', {
        p_office_id: match.id,
        p_default_timezone: form.default_timezone || null,
        p_default_display_timezones: splitList(form.default_display_timezones),
      });
    }
    const warns = (wifiWarnings.length ? wifiWarnings : dupes) as string[];
    const warnNote = warns.length
      ? ` Save succeeded. Note: ${warns.join('; ')} (not an error — multiple APs may share one public IP).`
      : '';
    showMsg(
      wasNew
        ? `"${savedName}" saved. Assigned people use this office pin and radius.${warnNote}`
        : `"${savedName}" updated. Assigned people now use this office pin and radius.${warnNote}`,
    );
    resetForm();
    await load();
    if (wasNew && match) startAssign(match.id);
  };

  const remove = async (id: string, name: string) => {
    if (!confirm(`Delete office zone "${name}"? Managers assigned to it may lose their GPS attendance area.`)) return;
    const { error } = await supabase.rpc('delete_office_location', { p_id: id });
    if (error) showMsg(error.message);
    else {
      showMsg(`"${name}" deleted.`);
      void load();
    }
  };

  const activeOffices = offices.filter((o) => o.active);
  const assignedManagerCount = assignments.length;

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
              Define geofenced office locations, Wi-Fi networks, and automatic check-in. The same settings appear on web,
              the desktop app, and the mobile app.
            </p>
          </div>
        </div>

        <div className="admin-office-stats">
          <div className="admin-office-stat">
            <Building2 size={16} />
            <span className="admin-office-stat__label">Active zones</span>
            <strong>{activeOffices.length}</strong>
          </div>
          <div className="admin-office-stat">
            <MapPin size={16} />
            <span className="admin-office-stat__label">Total offices</span>
            <strong>{offices.length}</strong>
          </div>
          <div className="admin-office-stat">
            <UserCheck size={16} />
            <span className="admin-office-stat__label">Managers assigned</span>
            <strong>{assignedManagerCount}</strong>
          </div>
          <div className="admin-office-stat">
            <Radio size={16} />
            <span className="admin-office-stat__label">GPS check-in</span>
            <strong className="admin-office-stat__value--sm">Enabled</strong>
          </div>
        </div>
      </header>

      <div className="admin-office-steps">
        <span className={`admin-office-step ${activeTab === 'create' ? 'admin-office-step--active' : ''}`}>
          1 · Capture &amp; save zone
        </span>
        <span className={`admin-office-step ${activeTab === 'assign' ? 'admin-office-step--active' : ''}`}>
          2 · Assign people
        </span>
        <span className={`admin-office-step ${activeTab === 'offices' ? 'admin-office-step--active' : ''}`}>
          3 · Manage offices
        </span>
      </div>

      <div className="admin-office-tabs tab-bar tab-bar--inline-mobile">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'create' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('create')}
        >
          <Navigation size={16} /> Create zone
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'assign' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('assign')}
        >
          <UserCheck size={16} /> Assign people
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'offices' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('offices')}
        >
          <MapPin size={16} /> All offices ({offices.length})
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

      {activeTab === 'create' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <Navigation size={18} /> {form.id ? 'Edit office zone' : 'Create office zone'}
          </h3>
          <p>Stand at the office entrance, capture live GPS, fine-tune on the map, then save to Supabase.</p>

          <div className="admin-office-form-section">
            <p className="admin-office-form-section__title">Step 1 · Stand at office &amp; capture live GPS</p>
            <p className="admin-office-form-help">
              The location where you stand becomes the center of the check-in zone. Saving updates everyone already
              assigned to this office.
            </p>
            <LiveGpsCapture latitude={form.latitude} longitude={form.longitude} onCapture={setCoords} />
          </div>

          <div className="admin-office-form-section">
            <p className="admin-office-form-section__title">Step 2 · Map &amp; radius</p>
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
            <p className="admin-office-form-section__title">Step 3 · Office details</p>
            <form onSubmit={save} className="attendance-form-grid attendance-form-grid--wide">
              <div className="form-group">
                <label htmlFor="office-name">Office name *</label>
                <input
                  id="office-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Karachi HQ"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-address">Address (optional)</label>
                <input
                  id="office-address"
                  value={form.address}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                  placeholder="Street, city, country"
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-lat">Latitude *</label>
                <input
                  id="office-lat"
                  type="number"
                  step="any"
                  value={form.latitude}
                  onChange={(e) => setForm({ ...form, latitude: e.target.value })}
                  placeholder="From live GPS"
                  required
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-lng">Longitude *</label>
                <input
                  id="office-lng"
                  type="number"
                  step="any"
                  value={form.longitude}
                  onChange={(e) => setForm({ ...form, longitude: e.target.value })}
                  placeholder="From live GPS"
                  required
                />
              </div>
              <div className="form-group admin-office-span-full">
                <label htmlFor="office-detect">Detection</label>
                <p id="office-detect" className="admin-office-item__meta">
                  Check-in uses both: the public IP must match an active office Wi-Fi, and a GPS reading
                  (accuracy 100 m or better) must be inside this radius. GPS only and Wi-Fi only are not used.
                </p>
              </div>

              <div className="form-group admin-office-span-full admin-office-wifi-block">
                <div className="admin-office-wifi-block__head">
                  <label>Office Wi-Fi networks</label>
                  <div className="admin-office-wifi-block__actions">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={wifiProbing} onClick={() => void testOfficeWifi()}>
                      {wifiProbing ? 'Testing…' : 'Test office Wi-Fi'}
                    </button>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={addWifiNetwork}>
                      <Plus size={14} /> Add Wi-Fi network
                    </button>
                  </div>
                </div>
                <p className="admin-office-wifi-hint">
                  A device matches if it is on <strong>any active</strong> network. Public IP is required (IPv4 and/or
                  IPv6, or a CIDR like <code>2001:db8::/32</code>). When BSSIDs are listed, the device must also match
                  one of them.
                </p>
                {wifiProbe && <p className="admin-office-wifi-probe" role="status">{wifiProbe}</p>}
                {wifiWarnings.length > 0 && (
                  <div className="admin-office-alert admin-office-alert--note admin-office-alert--tight" role="status">
                    <Info size={16} />
                    <span>{wifiWarnings.join(' · ')}</span>
                  </div>
                )}
                {wifiNetworks.length === 0 ? (
                  <div className="admin-office-wifi-empty">
                    <Wifi size={32} strokeWidth={1.25} />
                    <h4>No Wi-Fi networks yet</h4>
                    <p>
                      Add Main floor, Guest, or Conference room networks so automatic attendance can match office Wi-Fi.
                      On phone or desktop, use <strong>Use current Wi-Fi</strong> after adding a row.
                    </p>
                    <button type="button" className="btn btn-primary btn-sm" onClick={addWifiNetwork}>
                      <Plus size={14} /> Add first network
                    </button>
                  </div>
                ) : (
                  <div className="admin-office-wifi-list">
                    {wifiNetworks.map((n, index) => (
                      <article key={n.id || `new-${index}`} className="admin-office-wifi-row">
                        <div className="admin-office-wifi-row__head">
                          <strong>{n.label.trim() || `Network ${index + 1}`}</strong>
                          <label className="admin-office-wifi-row__active">
                            <input
                              type="checkbox"
                              checked={n.active}
                              onChange={(e) => updateWifiNetwork(index, { active: e.target.checked })}
                            />
                            Active
                          </label>
                        </div>
                        <div className="attendance-form-grid attendance-form-grid--wide">
                          <div className="form-group">
                            <label>Label</label>
                            <input
                              value={n.label}
                              onChange={(e) => updateWifiNetwork(index, { label: e.target.value })}
                              placeholder="Main floor"
                            />
                          </div>
                          <div className="form-group">
                            <label>Wi-Fi name (SSID)</label>
                            <input
                              value={n.ssid}
                              onChange={(e) => updateWifiNetwork(index, { ssid: e.target.value })}
                              placeholder="OfficeWiFi"
                            />
                          </div>
                          <div className="form-group admin-office-span-full">
                            <label>Router IDs (BSSIDs)</label>
                            <input
                              value={n.wifi_bssids}
                              onChange={(e) => updateWifiNetwork(index, { wifi_bssids: e.target.value })}
                              placeholder="aa:bb:cc:dd:ee:ff, 11:22:33:44:55:66"
                            />
                          </div>
                          <div className="form-group admin-office-span-full">
                            <label>Public IP(s) / CIDR (IPv4 or IPv6)</label>
                            <input
                              value={n.public_ip_cidrs}
                              onChange={(e) => updateWifiNetwork(index, { public_ip_cidrs: e.target.value })}
                              placeholder="203.0.113.10, 2001:db8::1, or 203.0.113.0/24"
                              required={Boolean(n.label.trim() || n.ssid.trim() || n.wifi_bssids.trim())}
                            />
                          </div>
                        </div>
                        <div className="admin-office-wifi-row__footer">
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            disabled={wifiProbing}
                            onClick={() => void useCurrentWifiOnRow(index)}
                          >
                            <Wifi size={14} /> Use current Wi-Fi
                          </button>
                          <button
                            type="button"
                            className="btn btn-danger btn-sm"
                            onClick={() => removeWifiNetwork(index)}
                          >
                            <Trash2 size={14} /> Delete
                          </button>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
              <div className="form-group admin-office-span-full">
                <label>Default shift time zone (pre-fill when creating shifts)</label>
                <TimeZonePicker
                  value={form.default_timezone}
                  onChange={(tz) => setForm({ ...form, default_timezone: tz })}
                />
              </div>
              <div className="form-group admin-office-span-full">
                <label>Default extra display zones (IANA ids, comma-separated)</label>
                <input
                  value={form.default_display_timezones}
                  onChange={(e) => setForm({ ...form, default_display_timezones: e.target.value })}
                  placeholder="Asia/Karachi, Asia/Dubai"
                />
              </div>
              <div className="form-group">
                <label htmlFor="office-radius">Check-in radius (meters)</label>
                <input
                  id="office-radius"
                  type="number"
                  min={30}
                  max={2000}
                  value={form.radius_meters}
                  onChange={(e) => setForm({ ...form, radius_meters: e.target.value })}
                />
              </div>
              <div className="form-group admin-office-checkbox-end">
                <label>
                  <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} />
                  Active zone
                </label>
              </div>
              <div className="admin-office-form-actions">
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : form.id ? (
                    'Update office zone'
                  ) : (
                    <>
                      <Plus size={16} /> Save office zone
                    </>
                  )}
                </button>
                {form.id && (
                  <button type="button" className="btn btn-secondary" onClick={resetForm}>
                    Cancel edit
                  </button>
                )}
              </div>
            </form>
          </div>
        </section>
      )}

      {activeTab === 'assign' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <UserCheck size={18} /> Assign office location
          </h3>
          <p>
            Assign a zone to every employee at once, to any individual, or to a manager so their team inherits it.
          </p>
          <div className="admin-office-info">
            <Info size={16} />
            <span>Create at least one active office under <strong>Create zone</strong> before assigning people.</span>
          </div>
          <AssignManagerLocationPanel
            key={assignKey}
            initialOfficeId={assignOfficeId}
            embedded
            onAssigned={() => void load()}
          />
        </section>
      )}

      {activeTab === 'offices' && (
        <section className="admin-office-card glass-panel">
          <h3>
            <MapPin size={18} /> Saved office zones
          </h3>
          <p>All geofenced locations stored in Supabase. Edit coordinates, assign people, or remove unused zones.</p>

          {offices.length === 0 ? (
            <div className="admin-office-empty">
              <MapPin size={40} strokeWidth={1.25} />
              <h4>No office zones yet</h4>
              <p>Go to <strong>Create zone</strong>, capture live GPS at your office, and save your first location.</p>
            </div>
          ) : (
            <div className="admin-office-grid">
              {offices.map((o) => {
                const assigned = assignments.filter((a) => a.site_name === o.name || a.latitude === o.latitude);
                return (
                  <article
                    key={o.id}
                    className={`admin-office-item glass-panel ${o.active ? '' : 'admin-office-item--inactive'}`}
                  >
                    <div className="admin-office-item__head">
                      <h4>{o.name}</h4>
                      <span className={`admin-office-item__badge ${o.active ? '' : 'admin-office-item__badge--inactive'}`}>
                        {o.active ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    {o.address && <p className="admin-office-item__meta">{o.address}</p>}
                    <div className="admin-office-item__coords">
                      {o.latitude.toFixed(5)}, {o.longitude.toFixed(5)} · {o.radius_meters}m radius
                      {' · '}
                      Wi-Fi and GPS
                    </div>
                    <p className="admin-office-item__meta">
                      <Wifi size={12} className="admin-office-item__meta-icon" />
                      {(() => {
                        const nets = (wifiNetworksByOffice[o.id] || []).filter((n) => n.active);
                        if (nets.length === 0) return 'No active Wi-Fi networks';
                        return `${nets.length} Wi-Fi network${nets.length === 1 ? '' : 's'}: ${nets.map((n) => n.label).join(', ')}`;
                      })()}
                    </p>
                    <p className="admin-office-item__meta">
                      <Users size={12} className="admin-office-item__meta-icon" />
                      {assigned.length > 0
                        ? `${assigned.length} manager${assigned.length !== 1 ? 's' : ''} (team zone)`
                        : 'No manager team zone yet'}
                    </p>
                    <div className="admin-office-item__actions">
                      {o.active && (
                        <button type="button" className="btn btn-primary btn-sm" onClick={() => startAssign(o.id)}>
                          <UserCheck size={14} /> Assign
                        </button>
                      )}
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => editOffice(o)}>
                        Edit
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger btn-sm"
                        onClick={() => void remove(o.id, o.name)}
                        aria-label={`Delete ${o.name}`}
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      <section className="admin-office-auto-attendance">
        <AutoAttendanceSettings mode="admin" embedded />
      </section>
    </div>
  );
}
