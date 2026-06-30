import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { formatClockTime } from '../utils/geoAttendance';
import AssignManagerLocationPanel from './AssignManagerLocationPanel';
import { MapPin, Loader2, Radio, RefreshCw } from 'lucide-react';

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
  const [managerSiteCount, setManagerSiteCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [msg, setMsg] = useState('');

  const myTeamSite = mode === 'manager'
    ? rows.find((r) => r.user_id === profile.id) ?? rows[0]
    : null;

  const loadTracking = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);
    const [trackRes, sitesRes] = await Promise.all([
      supabase.rpc('get_team_location_tracking'),
      mode === 'admin' ? supabase.rpc('get_manager_work_sites') : Promise.resolve({ data: [], error: null }),
    ]);
    if (trackRes.error) setMsg(trackRes.error.message);
    else setRows((trackRes.data || []) as TeamTrackingRow[]);
    if (mode === 'admin') setManagerSiteCount((sitesRes.data || []).length);
    if (!silent) setLoading(false);
    else setRefreshing(false);
  }, [mode]);

  useEffect(() => { loadTracking(); }, [loadTracking]);

  useEffect(() => {
    const interval = window.setInterval(() => loadTracking(true), 30000);
    return () => window.clearInterval(interval);
  }, [loadTracking]);

  const teamRows = mode === 'manager'
    ? rows.filter((r) => r.user_id !== profile.id)
    : rows.filter((r) => r.role === 'employee');

  const atSiteCount = teamRows.filter((r) => r.inside_site && r.last_ping_at).length;

  return (
    <div className="attendance-page animate-fade-in">
      {msg && (
        <div className={`rewards-toast ${msg.includes('fail') || msg.includes('Not') ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="attendance-admin-header">
        <h3>{mode === 'admin' ? 'Live employee tracking' : 'Team live tracking'}</h3>
        <p>
          {mode === 'admin'
            ? 'Assign offices to managers under the Office GPS tab, then monitor attendance here in real time.'
            : 'Monitor your team in real time. All employees use the work location assigned to you by admin.'}
        </p>
      </div>

      {mode === 'admin' && (
        <AssignManagerLocationPanel onAssigned={() => loadTracking(true)} />
      )}

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
              </p>
            </>
          ) : (
            <p className="attendance-empty">No work location assigned yet. Ask your admin to assign an office to you under Office GPS → Step 2.</p>
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
            <span className="geo-clock-stat__label">Managers assigned</span>
            <strong>{managerSiteCount}</strong>
          </div>
        )}
      </div>

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
                      {mode === 'admin' && <td>{row.manager_name || '—'}</td>}
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
                          <span className="geo-tracking-table__sub">Manager not assigned</span>
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
