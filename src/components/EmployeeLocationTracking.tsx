import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { OfficeLocation, formatClockTime, requestCurrentPosition } from '../utils/geoAttendance';
import {
  MapPin, Loader2, Radio, Navigation, Trash2, UserPlus, RefreshCw, Users,
} from 'lucide-react';

interface EmployeeLocationTrackingProps {
  profile: Profile;
  mode: 'manager' | 'admin';
}

export interface TeamTrackingRow {
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  manager_id: string | null;
  manager_name: string | null;
  site_id: string | null;
  site_name: string | null;
  site_address: string | null;
  site_latitude: number | null;
  site_longitude: number | null;
  site_radius_meters: number | null;
  tracking_enabled: boolean;
  last_ping_at: string | null;
  last_latitude: number | null;
  last_longitude: number | null;
  inside_site: boolean;
  distance_meters: number | null;
  clock_in_at: string | null;
  clock_out_at: string | null;
  attendance_status: string | null;
  attendance_source: string | null;
}

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

function trackingStatus(row: TeamTrackingRow): { label: string; className: string } {
  if (!row.site_id) return { label: 'No team site', className: 'geo-status--muted' };
  if (!row.tracking_enabled) return { label: 'Tracking off', className: 'geo-status--muted' };
  if (!row.last_ping_at) return { label: 'Waiting for location', className: 'geo-status--pending' };
  const ageMs = Date.now() - new Date(row.last_ping_at).getTime();
  if (ageMs > 10 * 60 * 1000) return { label: 'Offline', className: 'geo-status--away' };
  if (row.inside_site) return { label: 'At work site', className: 'geo-status--in' };
  return { label: 'Away from site', className: 'geo-status--away' };
}

function lastSeenLabel(iso: string | null): string {
  if (!iso) return '—';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

export default function EmployeeLocationTracking({ profile, mode }: EmployeeLocationTrackingProps) {
  const [rows, setRows] = useState<TeamTrackingRow[]>([]);
  const [managerSites, setManagerSites] = useState<ManagerSiteRow[]>([]);
  const [managers, setManagers] = useState<Profile[]>([]);
  const [offices, setOffices] = useState<OfficeLocation[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState('');

  const [assignManagerId, setAssignManagerId] = useState('');
  const [officeId, setOfficeId] = useState('');
  const [siteName, setSiteName] = useState('');
  const [siteAddress, setSiteAddress] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [radius, setRadius] = useState('150');
  const [trackingEnabled, setTrackingEnabled] = useState(true);

  const myTeamSite = mode === 'manager'
    ? rows.find((r) => r.user_id === profile.id) ?? rows[0]
    : null;

  const loadManagers = useCallback(async () => {
    if (mode !== 'admin') return;
    const { data } = await supabase.rpc('get_all_users_admin');
    setManagers(((data || []) as Profile[]).filter((u) => u.role === 'manager'));
  }, [mode]);

  const loadManagerSites = useCallback(async () => {
    if (mode !== 'admin') return;
    const { data, error } = await supabase.rpc('get_manager_work_sites');
    if (error) setMsg(error.message);
    else setManagerSites((data || []) as ManagerSiteRow[]);
  }, [mode]);

  const loadTracking = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    const { data, error } = await supabase.rpc('get_team_location_tracking');
    if (error) setMsg(error.message);
    else setRows((data || []) as TeamTrackingRow[]);
    if (!silent) setLoading(false);
    else setRefreshing(false);
  }, []);

  const loadOffices = useCallback(async () => {
    const { data } = await supabase.rpc('get_office_locations');
    setOffices((data || []) as OfficeLocation[]);
  }, []);

  useEffect(() => {
    loadManagers();
    loadManagerSites();
    loadOffices();
    loadTracking();
  }, [loadManagers, loadManagerSites, loadOffices, loadTracking]);

  useEffect(() => {
    const interval = window.setInterval(() => loadTracking(true), 30000);
    return () => window.clearInterval(interval);
  }, [loadTracking]);

  useEffect(() => {
    if (!officeId) return;
    const office = offices.find((o) => o.id === officeId);
    if (!office) return;
    setSiteName(office.name);
    setSiteAddress(office.address || '');
    setLatitude(String(office.latitude));
    setLongitude(String(office.longitude));
    setRadius(String(office.radius_meters));
  }, [officeId, offices]);

  const editManagerSite = (site: ManagerSiteRow) => {
    setAssignManagerId(site.manager_id);
    setSiteName(site.site_name);
    setSiteAddress(site.site_address || '');
    setLatitude(String(site.latitude));
    setLongitude(String(site.longitude));
    setRadius(String(site.radius_meters));
    setTrackingEnabled(site.tracking_enabled);
    setOfficeId('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const useMyLocation = async () => {
    try {
      const pos = await requestCurrentPosition();
      setLatitude(pos.coords.latitude.toFixed(6));
      setLongitude(pos.coords.longitude.toFixed(6));
      setOfficeId('');
      setMsg('Current GPS captured.');
    } catch (e: unknown) {
      setMsg(e instanceof Error ? e.message : 'Could not get location');
    }
  };

  const saveAssignment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!assignManagerId || !siteName.trim() || !latitude || !longitude) {
      setMsg('Select a manager and provide site name + GPS coordinates.');
      return;
    }
    setSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('assign_manager_work_site', {
      p_manager_id: assignManagerId,
      p_office_location_id: officeId || null,
      p_name: siteName.trim(),
      p_address: siteAddress.trim() || null,
      p_latitude: parseFloat(latitude),
      p_longitude: parseFloat(longitude),
      p_radius_meters: parseInt(radius, 10) || 150,
      p_tracking_enabled: trackingEnabled,
    });
    setSaving(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Team location saved. All employees under this manager will use the same GPS zone.');
      loadManagerSites();
      loadTracking(true);
    }
  };

  const removeAssignment = async (managerId: string) => {
    if (!confirm('Remove work location for this manager and their whole team?')) return;
    const { error } = await supabase.rpc('remove_manager_work_site', { p_manager_id: managerId });
    if (error) setMsg(error.message);
    else {
      loadManagerSites();
      loadTracking(true);
    }
  };

  const teamRows = mode === 'manager'
    ? rows.filter((r) => r.user_id !== profile.id)
    : rows.filter((r) => r.role === 'employee');

  const atSiteCount = teamRows.filter((r) => r.inside_site && r.last_ping_at).length;

  return (
    <div className="attendance-page animate-fade-in">
      {msg && (
        <div className={`rewards-toast ${msg.includes('fail') || msg.includes('required') || msg.includes('Not') || msg.includes('Only') ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="attendance-admin-header">
        <h3>{mode === 'admin' ? 'Manager team locations' : 'Team live tracking'}</h3>
        <p>
          {mode === 'admin'
            ? 'Assign one GPS work zone per manager. Every employee under that manager automatically shares the same location for attendance tracking.'
            : 'Monitor your team in real time. All employees use the work location assigned to you by admin.'}
        </p>
      </div>

      {mode === 'manager' && (
        <div className="attendance-card geo-attendance-panel">
          <h3 className="attendance-card__title"><MapPin size={18} /> Your team work site</h3>
          {myTeamSite?.site_name ? (
            <>
              <p className="attendance-card__subtitle" style={{ marginBottom: '0.75rem' }}>
                <strong>{myTeamSite.site_name}</strong>
                {myTeamSite.site_address && <> · {myTeamSite.site_address}</>}
              </p>
              <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
                {myTeamSite.site_latitude?.toFixed(5)}, {myTeamSite.site_longitude?.toFixed(5)} · {myTeamSite.site_radius_meters}m radius
                {!myTeamSite.tracking_enabled && ' · Tracking disabled'}
              </p>
            </>
          ) : (
            <p className="attendance-empty">No work location assigned yet. Ask your admin to set a GPS zone for your team.</p>
          )}
        </div>
      )}

      <div className="geo-tracking-stats">
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">Team members</span>
          <strong>{teamRows.length}</strong>
        </div>
        <div className="geo-clock-stat">
          <span className="geo-clock-stat__label">At site now</span>
          <strong>{atSiteCount}</strong>
        </div>
        {mode === 'admin' && (
          <div className="geo-clock-stat">
            <span className="geo-clock-stat__label">Managers configured</span>
            <strong>{managerSites.length}</strong>
          </div>
        )}
      </div>

      {mode === 'admin' && (
        <>
          <div className="attendance-card">
            <h3 className="attendance-card__title"><UserPlus size={18} /> Assign location to manager</h3>
            <p className="attendance-card__subtitle">
              One location per manager — all their employees inherit it automatically.
            </p>

            <form onSubmit={saveAssignment} className="attendance-form-grid attendance-form-grid--wide">
              <div className="form-group">
                <label>Manager</label>
                <select value={assignManagerId} onChange={(e) => setAssignManagerId(e.target.value)} required>
                  <option value="">— Select manager —</option>
                  {managers.map((m) => (
                    <option key={m.id} value={m.id}>{m.full_name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Use office zone (optional)</label>
                <select value={officeId} onChange={(e) => setOfficeId(e.target.value)}>
                  <option value="">— Custom coordinates —</option>
                  {offices.filter((o) => o.active).map((o) => (
                    <option key={o.id} value={o.id}>{o.name}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label>Site name</label>
                <input value={siteName} onChange={(e) => setSiteName(e.target.value)} placeholder="e.g. Bahria Town Office" required />
              </div>
              <div className="form-group">
                <label>Address (optional)</label>
                <input value={siteAddress} onChange={(e) => setSiteAddress(e.target.value)} placeholder="Building, city" />
              </div>
              <div className="form-group">
                <label>Latitude</label>
                <input type="number" step="any" value={latitude} onChange={(e) => { setLatitude(e.target.value); setOfficeId(''); }} required />
              </div>
              <div className="form-group">
                <label>Longitude</label>
                <input type="number" step="any" value={longitude} onChange={(e) => { setLongitude(e.target.value); setOfficeId(''); }} required />
              </div>
              <div className="form-group">
                <label>Radius (meters)</label>
                <input type="number" min={30} max={2000} value={radius} onChange={(e) => setRadius(e.target.value)} />
              </div>
              <div className="form-group" style={{ display: 'flex', alignItems: 'flex-end', gap: '0.75rem', flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary" onClick={useMyLocation}>
                  <Navigation size={16} /> Use my GPS
                </button>
                <label className="geo-toggle-row" style={{ margin: 0 }}>
                  <input type="checkbox" checked={trackingEnabled} onChange={(e) => setTrackingEnabled(e.target.checked)} />
                  <span>Enable tracking</span>
                </label>
              </div>
              <div>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving ? <Loader2 size={16} className="spin-icon" /> : <><MapPin size={16} /> Save team location</>}
                </button>
              </div>
            </form>
          </div>

          <div className="attendance-card">
            <h3 className="attendance-card__title"><Users size={18} /> Manager locations ({managerSites.length})</h3>
            {managerSites.length === 0 ? (
              <p className="attendance-empty">No manager locations yet. Assign one above.</p>
            ) : (
              <div className="attendance-approval-list">
                {managerSites.map((site) => (
                  <div key={site.site_id} className="attendance-approval-item" style={{ borderLeftColor: 'var(--accent-primary)' }}>
                    <div className="attendance-approval-item__main">
                      <span className="attendance-approval-item__name">
                        {site.manager_name}
                        <span className="attendance-role-tag">{site.team_count} employees</span>
                      </span>
                      <span className="attendance-approval-item__meta">
                        {site.site_name} · {site.latitude.toFixed(5)}, {site.longitude.toFixed(5)} · {site.radius_meters}m
                      </span>
                      {site.site_address && <span className="attendance-approval-item__reason">{site.site_address}</span>}
                    </div>
                    <div className="attendance-approval-item__actions">
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => editManagerSite(site)}>Edit</button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeAssignment(site.manager_id)} style={{ color: 'var(--color-danger)' }}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div className="attendance-card">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '1rem' }}>
          <h3 className="attendance-card__title" style={{ margin: 0 }}>
            <Radio size={18} /> Live tracking — today
          </h3>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => loadTracking(true)} disabled={refreshing}>
            {refreshing ? <Loader2 size={14} className="spin-icon" /> : <RefreshCw size={14} />}
            Refresh
          </button>
        </div>
        <p className="attendance-card__subtitle">
          Updates every 30 seconds. Employees must enable location on their device while the app is open.
        </p>

        {loading ? (
          <div className="dash-loading"><Loader2 size={28} className="spin-icon" /></div>
        ) : teamRows.length === 0 ? (
          <p className="attendance-empty">No team members to track yet.</p>
        ) : (
          <div className="team-points-table-wrap">
            <table className="attendance-history-table geo-tracking-table">
              <thead>
                <tr>
                  <th>{mode === 'admin' ? 'Employee' : 'Team member'}</th>
                  {mode === 'admin' && <th>Manager</th>}
                  <th>Team site</th>
                  <th>Live status</th>
                  <th>Last seen</th>
                  <th>Clock in</th>
                  <th>Clock out</th>
                </tr>
              </thead>
              <tbody>
                {teamRows.map((row) => {
                  const status = trackingStatus(row);
                  return (
                    <tr key={row.user_id}>
                      <td>
                        <strong>{row.full_name}</strong>
                        <span className="geo-tracking-table__sub">{row.role}</span>
                      </td>
                      {mode === 'admin' && (
                        <td>{row.manager_name || '—'}</td>
                      )}
                      <td>
                        {row.site_name ? (
                          <>
                            {row.site_name}
                            {row.distance_meters != null && row.last_ping_at && (
                              <span className="geo-tracking-table__sub">
                                {Math.round(row.distance_meters)}m from center
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="geo-tracking-table__sub">Manager has no site</span>
                        )}
                      </td>
                      <td>
                        <span className={`geo-status-badge ${status.className}`}>{status.label}</span>
                      </td>
                      <td>{lastSeenLabel(row.last_ping_at)}</td>
                      <td>
                        {formatClockTime(row.clock_in_at)}
                        {row.attendance_source === 'geo' && row.clock_in_at && (
                          <span className="geo-clock-stat__tag">GPS</span>
                        )}
                      </td>
                      <td>{formatClockTime(row.clock_out_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
