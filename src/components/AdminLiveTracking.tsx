import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { formatClockTime } from '../utils/geoAttendance';
import {
  MapPin,
  Loader2,
  Radio,
  RefreshCw,
  AlertCircle,
  Building2,
  Users,
  Navigation,
  Search,
  LayoutGrid,
  Table2,
  Info,
} from 'lucide-react';
import '../styles/attendance.css';
import '../styles/admin-tracking.css';

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
import { Department } from '../utils/departmentHelpers';

interface AdminLiveTrackingProps {
  mode?: 'admin' | 'manager';
  profile?: Profile;
}

interface EnrichedRow extends TeamTrackingRow {
  department_id: string | null;
  department_name: string | null;
}

type StatusFilter = 'all' | 'at_site' | 'away' | 'offline' | 'no_site';
type ViewMode = 'department' | 'table';

function trackingStatus(row: TeamTrackingRow): { label: string; className: string; key: StatusFilter } {
  if (!row.site_id) return { label: 'No work site', className: 'geo-status--muted', key: 'no_site' };
  if (!row.tracking_enabled) return { label: 'Tracking off', className: 'geo-status--muted', key: 'no_site' };
  if (!row.last_ping_at) return { label: 'Waiting for GPS', className: 'geo-status--pending', key: 'offline' };
  const ageMs = Date.now() - new Date(row.last_ping_at).getTime();
  if (ageMs > 10 * 60 * 1000) return { label: 'Offline', className: 'geo-status--away', key: 'offline' };
  if (row.inside_site) return { label: 'At work site', className: 'geo-status--in', key: 'at_site' };
  return { label: 'Away from site', className: 'geo-status--away', key: 'away' };
}

function lastSeenLabel(iso: string | null): string {
  if (!iso) return '—';
  const diff = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diff < 60) return 'Just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

function matchesStatusFilter(row: TeamTrackingRow, filter: StatusFilter): boolean {
  if (filter === 'all') return true;
  return trackingStatus(row).key === filter;
}

export default function AdminLiveTracking({ mode = 'admin', profile }: AdminLiveTrackingProps) {
  const isManagerView = mode === 'manager';
  const managerDepartmentId = profile?.department_id ?? null;

  const [rows, setRows] = useState<EnrichedRow[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [managerSiteCount, setManagerSiteCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefresh, setLastRefresh] = useState<Date | null>(null);
  const [msg, setMsg] = useState('');
  const [search, setSearch] = useState('');
  const [departmentFilter, setDepartmentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('department');

  const departmentName = useMemo(() => {
    if (!managerDepartmentId) return 'Your department';
    return departments.find((d) => d.id === managerDepartmentId)?.name || 'Your department';
  }, [departments, managerDepartmentId]);

  const loadTracking = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setRefreshing(true);

    const trackRes = await supabase.rpc('get_team_location_tracking');

    if (isManagerView) {
      const deptRes = await supabase.rpc('get_departments');
      const deptList = ((deptRes.data || []) as Department[]) || [];
      const deptName =
        deptList.find((d) => d.id === managerDepartmentId)?.name || 'Your department';

      if (trackRes.error) setMsg(trackRes.error.message);
      else {
        const enriched = ((trackRes.data || []) as TeamTrackingRow[]).map((r) => ({
          ...r,
          department_id: managerDepartmentId,
          department_name: deptName,
        }));
        setRows(enriched);
        setManagerSiteCount(
          new Set(enriched.filter((r) => r.role === 'manager' && r.site_id).map((r) => r.user_id)).size,
        );
      }

      setDepartments(deptList.filter((d) => d.id === managerDepartmentId));
      setLastRefresh(new Date());
      if (!silent) setLoading(false);
      else setRefreshing(false);
      return;
    }

    const [sitesRes, usersRes, deptRes] = await Promise.all([
      supabase.rpc('get_manager_work_sites'),
      supabase.rpc('get_all_users_admin'),
      supabase.rpc('get_departments'),
    ]);

    if (trackRes.error) setMsg(trackRes.error.message);
    else {
      const users = ((usersRes.data || []) as Profile[]).filter((u) => !u.is_demo);
      const allowedIds = new Set(users.map((u) => u.id));
      const deptList = ((deptRes.data || []) as Department[]) || [];
      const deptNameById = new Map(deptList.map((d) => [d.id, d.name]));
      const userDept = new Map(users.map((u) => [u.id, u.department_id ?? null]));

      const enriched = ((trackRes.data || []) as TeamTrackingRow[])
        .filter((r) => r.role === 'employee' && allowedIds.has(r.user_id))
        .map((r) => {
          const deptId = userDept.get(r.user_id) ?? null;
          return {
            ...r,
            department_id: deptId,
            department_name: deptId ? deptNameById.get(deptId) || 'Department' : 'Unassigned',
          };
        });

      setRows(enriched);
      setDepartments(deptList);
    }

    setManagerSiteCount((sitesRes.data || []).length);
    setLastRefresh(new Date());
    if (!silent) setLoading(false);
    else setRefreshing(false);
  }, [isManagerView, managerDepartmentId]);

  useEffect(() => {
    void loadTracking();
  }, [loadTracking]);

  useEffect(() => {
    const interval = window.setInterval(() => void loadTracking(true), 30000);
    return () => window.clearInterval(interval);
  }, [loadTracking]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (!isManagerView && departmentFilter) {
        if (departmentFilter === '__unassigned__') {
          if (r.department_id) return false;
        } else if (r.department_id !== departmentFilter) {
          return false;
        }
      }
      if (!matchesStatusFilter(r, statusFilter)) return false;
      if (q && !r.full_name.toLowerCase().includes(q) && !r.email.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, search, departmentFilter, statusFilter, isManagerView]);

  const employeeCount = isManagerView ? rows.filter((r) => r.role === 'employee').length : rows.length;

  function personSubtitle(row: EnrichedRow): string {
    if (row.role === 'manager') return 'Department manager';
    return row.manager_name ? `Mgr: ${row.manager_name}` : 'No manager';
  }

  const atSiteCount = rows.filter((r) => trackingStatus(r).key === 'at_site').length;
  const awayCount = rows.filter((r) => trackingStatus(r).key === 'away').length;
  const offlineCount = rows.filter((r) => ['offline', 'no_site'].includes(trackingStatus(r).key)).length;

  const departmentSections = useMemo(() => {
    const map = new Map<string, { name: string; rows: EnrichedRow[] }>();
    for (const r of filtered) {
      const key = r.department_id || '__unassigned__';
      const name = r.department_name || 'Unassigned';
      if (!map.has(key)) map.set(key, { name, rows: [] });
      map.get(key)!.rows.push(r);
    }
    return [...map.entries()]
      .map(([id, { name, rows: deptRows }]) => ({
        id,
        name,
        rows: deptRows.sort((a, b) => a.full_name.localeCompare(b.full_name)),
      }))
      .sort((a, b) => {
        if (a.id === '__unassigned__') return 1;
        if (b.id === '__unassigned__') return -1;
        return a.name.localeCompare(b.name);
      });
  }, [filtered]);

  const statusChips: { id: StatusFilter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'at_site', label: 'At site' },
    { id: 'away', label: 'Away' },
    { id: 'offline', label: 'Offline' },
    { id: 'no_site', label: 'No site' },
  ];

  if (loading) {
    return (
      <div className="admin-tracking-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading live tracking…</span>
      </div>
    );
  }

  if (isManagerView && !managerDepartmentId) {
    return (
      <div className="admin-tracking-page animate-fade-in">
        <div className="admin-tracking-empty">
          <Building2 size={40} strokeWidth={1.25} />
          <h4>No department assigned</h4>
          <p>Ask your company admin to assign you to a department before using live tracking.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="admin-tracking-page animate-fade-in">
      <header className="admin-tracking-header glass-panel">
        <div className="admin-tracking-header__main">
          <div className="admin-tracking-header__icon">
            <Radio size={22} />
          </div>
          <div>
            <h2 className="admin-tracking-header__title">Live tracking</h2>
            <p className="admin-tracking-header__subtitle">
              {isManagerView ? (
                <>
                  Monitor GPS check-ins for <strong>{departmentName}</strong> in real time — department managers and
                  employees only. Data refreshes automatically every 30 seconds.
                </>
              ) : (
                <>
                  Monitor employee GPS check-ins in real time. Each employee uses their manager&apos;s assigned office
                  zone. Data refreshes automatically every 30 seconds.
                </>
              )}
            </p>
          </div>
        </div>

        <div className="admin-tracking-stats">
          <div className="admin-tracking-stat">
            <Users size={16} />
            <span className="admin-tracking-stat__label">Employees</span>
            <strong>{employeeCount}</strong>
          </div>
          <div className="admin-tracking-stat admin-tracking-stat--live">
            <Navigation size={16} />
            <span className="admin-tracking-stat__label">At site now</span>
            <strong>{atSiteCount}</strong>
          </div>
          <div className="admin-tracking-stat admin-tracking-stat--away">
            <MapPin size={16} />
            <span className="admin-tracking-stat__label">Away</span>
            <strong>{awayCount}</strong>
          </div>
          <div className="admin-tracking-stat admin-tracking-stat--muted">
            <Radio size={16} />
            <span className="admin-tracking-stat__label">Offline / no site</span>
            <strong>{offlineCount}</strong>
          </div>
          <div className="admin-tracking-stat">
            <Building2 size={16} />
            <span className="admin-tracking-stat__label">Managers on GPS</span>
            <strong>{managerSiteCount}</strong>
          </div>
        </div>
      </header>

      <div className="admin-tracking-info">
        <Info size={16} />
        <span>
          {isManagerView ? (
            <>
              Showing everyone in <strong>{departmentName}</strong> only. Office GPS zones are assigned by your admin
              under <strong>Office GPS</strong>.
            </>
          ) : (
            <>
              Assign office GPS zones under the <strong>Office GPS</strong> tab first. Demo accounts are not shown here.
            </>
          )}
        </span>
      </div>

      {msg && (
        <div className="admin-tracking-alert admin-tracking-alert--error" role="alert">
          <AlertCircle size={18} />
          <span>{msg}</span>
          <button type="button" className="admin-tracking-alert__dismiss" onClick={() => setMsg('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <section className="admin-tracking-card glass-panel">
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem', marginBottom: '1rem' }}>
          <h3 style={{ margin: 0 }}>
            <Radio size={18} /> Today&apos;s live board
            <span className="admin-tracking-live-badge" style={{ marginLeft: '0.5rem' }}>
              <span className="admin-tracking-live-badge__dot" />
              Live
            </span>
          </h3>
          {lastRefresh && (
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              Updated {lastRefresh.toLocaleTimeString()}
            </span>
          )}
        </div>

        <div className="admin-tracking-toolbar">
          <div className="form-group">
            <label htmlFor="track-search">
              <Search size={12} style={{ verticalAlign: '-1px', marginRight: '0.25rem' }} />
              Search
            </label>
            <input
              id="track-search"
              type="search"
              placeholder="Employee name or email…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="form-group">
            <label htmlFor="track-dept">{isManagerView ? 'Department' : 'Department'}</label>
            {isManagerView ? (
              <input id="track-dept" type="text" value={departmentName} readOnly disabled />
            ) : (
              <select id="track-dept" value={departmentFilter} onChange={(e) => setDepartmentFilter(e.target.value)}>
                <option value="">All departments</option>
                <option value="__unassigned__">Unassigned</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div className="admin-tracking-toolbar__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void loadTracking(true)} disabled={refreshing}>
              {refreshing ? <Loader2 size={14} className="spin-icon" /> : <RefreshCw size={14} />}
              Refresh
            </button>
          </div>
        </div>

        <div className="admin-tracking-filter-chips">
          {statusChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={`admin-tracking-filter-chip ${statusFilter === chip.id ? 'admin-tracking-filter-chip--active' : ''}`}
              onClick={() => setStatusFilter(chip.id)}
            >
              {chip.label}
            </button>
          ))}
        </div>

        <div className="admin-tracking-tabs tab-bar tab-bar--inline-mobile" style={{ marginBottom: '1rem' }}>
          <button
            type="button"
            className={`tab-btn ${viewMode === 'department' ? 'tab-btn--active' : ''}`}
            onClick={() => setViewMode('department')}
          >
            <LayoutGrid size={16} /> By department
          </button>
          <button
            type="button"
            className={`tab-btn ${viewMode === 'table' ? 'tab-btn--active' : ''}`}
            onClick={() => setViewMode('table')}
          >
            <Table2 size={16} /> Table view
          </button>
        </div>

        {filtered.length === 0 ? (
          <div className="admin-tracking-empty">
            <Users size={40} strokeWidth={1.25} />
            <h4>No employees match</h4>
            <p>
              {rows.length === 0
                ? isManagerView
                  ? `No managers or employees in ${departmentName} yet.`
                  : 'Add employees under Users and assign managers to office GPS zones.'
                : 'Try changing filters or search.'}
            </p>
          </div>
        ) : viewMode === 'department' ? (
          departmentSections.map((section) => {
            const sectionAtSite = section.rows.filter((r) => trackingStatus(r).key === 'at_site').length;
            return (
              <div key={section.id} className="admin-tracking-dept-section">
                <div className="admin-tracking-dept-section__head">
                  <h4>
                    <Building2 size={15} />
                    {section.name}
                  </h4>
                  <span className="admin-tracking-dept-section__meta">
                    {section.rows.length} member{section.rows.length !== 1 ? 's' : ''} · {sectionAtSite} at site
                  </span>
                </div>
                <div className="admin-tracking-employee-grid">
                  {section.rows.map((row) => {
                    const status = trackingStatus(row);
                    return (
                      <article key={row.user_id} className="admin-tracking-employee-card">
                        <div className="admin-tracking-employee-card__head">
                          <div>
                            <strong>{row.full_name}</strong>
                            <div className="admin-tracking-employee-card__role">{personSubtitle(row)}</div>
                          </div>
                          <span className={`geo-status-badge ${status.className}`}>{status.label}</span>
                        </div>
                        <div className="admin-tracking-employee-card__row">
                          <span>Work site</span>
                          <span>{row.site_name || '—'}</span>
                        </div>
                        <div className="admin-tracking-employee-card__row">
                          <span>Last seen</span>
                          <span>{lastSeenLabel(row.last_ping_at)}</span>
                        </div>
                        <div className="admin-tracking-employee-card__row">
                          <span>Clock in</span>
                          <span>
                            {formatClockTime(row.clock_in_at)}
                            {row.attendance_source === 'geo' && row.clock_in_at && (
                              <span className="geo-clock-stat__tag">GPS</span>
                            )}
                          </span>
                        </div>
                        <div className="admin-tracking-employee-card__row">
                          <span>Clock out</span>
                          <span>{formatClockTime(row.clock_out_at)}</span>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </div>
            );
          })
        ) : (
          <div className="admin-tracking-table-wrap">
            <table className="admin-tracking-table">
              <thead>
                <tr>
                  <th>Employee</th>
                  <th>Department</th>
                  {isManagerView && <th>Role</th>}
                  <th>Manager</th>
                  <th>Work site</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th>Clock in</th>
                  <th>Clock out</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => {
                  const status = trackingStatus(row);
                  return (
                    <tr key={row.user_id}>
                      <td>
                        <strong>{row.full_name}</strong>
                        <span className="geo-tracking-table__sub">{row.email}</span>
                      </td>
                      <td>{row.department_name}</td>
                      {isManagerView && <td style={{ textTransform: 'capitalize' }}>{row.role}</td>}
                      <td>{isManagerView && row.role === 'manager' ? '—' : row.manager_name || '—'}</td>
                      <td>
                        {row.site_name || '—'}
                        {row.distance_meters != null && row.last_ping_at && (
                          <span className="geo-tracking-table__sub">{Math.round(row.distance_meters)}m from center</span>
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
      </section>
    </div>
  );
}
