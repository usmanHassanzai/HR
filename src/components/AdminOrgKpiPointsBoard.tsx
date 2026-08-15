import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Building2,
  Loader2,
  RefreshCw,
  Search,
  Trophy,
  Users,
  UserCheck,
  User,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import '../styles/admin-kpi-points.css';

export interface OrgKpiPointsRow {
  user_id: string;
  full_name: string;
  email: string;
  role: string;
  department_id: string | null;
  department_name: string | null;
  health_score: number;
  total_kpis: number;
  completed_kpis: number;
  pending_kpis: number;
  kpi_points: number;
  total_earned: number;
  used_points: number;
  balance: number;
  this_month_points: number | null;
  this_month_score: number | null;
}

type RoleFilter = 'all' | 'manager' | 'employee' | 'admin';
type ViewMode = 'people' | 'departments';

function roleLabel(role: string): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  return 'Employee';
}

function healthClass(score: number): string {
  if (score >= 80) return 'admin-kpi-points__health--good';
  if (score >= 50) return 'admin-kpi-points__health--mid';
  return 'admin-kpi-points__health--low';
}

function normalizeRows(data: unknown): OrgKpiPointsRow[] {
  return ((data as OrgKpiPointsRow[]) || []).map((r) => ({
    ...r,
    health_score: Number(r.health_score) || 0,
    total_kpis: Number(r.total_kpis) || 0,
    completed_kpis: Number(r.completed_kpis) || 0,
    pending_kpis: Number(r.pending_kpis) || 0,
    kpi_points: Number(r.kpi_points) || 0,
    total_earned: Number(r.total_earned) || 0,
    used_points: Number(r.used_points) || 0,
    balance: Number(r.balance) || 0,
    this_month_points: r.this_month_points == null ? null : Number(r.this_month_points),
    this_month_score: r.this_month_score == null ? null : Number(r.this_month_score),
  }));
}

export default function AdminOrgKpiPointsBoard() {
  const [rows, setRows] = useState<OrgKpiPointsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [deptFilter, setDeptFilter] = useState<string>('all');
  const [viewMode, setViewMode] = useState<ViewMode>('people');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    const { data, error: err } = await supabase.rpc('get_org_kpi_points_board');
    if (err) {
      setError(err.message);
      setRows([]);
    } else {
      setRows(normalizeRows(data));
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useSupabaseRealtime(
    'admin-org-kpi-points',
    [
      { table: 'users' },
      { table: 'kpis' },
      { table: 'points_ledger' },
      { table: 'reward_redemptions' },
      { table: 'departments' },
    ],
    () => { void load(); },
  );

  const departments = useMemo(() => {
    const map = new Map<string, string>();
    for (const r of rows) {
      if (r.department_id && r.department_name) map.set(r.department_id, r.department_name);
    }
    return Array.from(map.entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (roleFilter !== 'all' && r.role !== roleFilter) return false;
      if (deptFilter !== 'all') {
        if (deptFilter === '__none__') {
          if (r.department_id) return false;
        } else if (r.department_id !== deptFilter) return false;
      }
      if (!q) return true;
      return (
        r.full_name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        (r.department_name || '').toLowerCase().includes(q) ||
        roleLabel(r.role).toLowerCase().includes(q)
      );
    });
  }, [rows, search, roleFilter, deptFilter]);

  const stats = useMemo(() => {
    const managers = rows.filter((r) => r.role === 'manager').length;
    const employees = rows.filter((r) => r.role === 'employee').length;
    const avgHealth =
      rows.length === 0
        ? 0
        : Math.round(rows.reduce((s, r) => s + r.health_score, 0) / rows.length);
    const totalBalance = rows.reduce((s, r) => s + r.balance, 0);
    const totalEarned = rows.reduce((s, r) => s + r.total_earned, 0);
    const totalKpiPoints = Math.round(rows.reduce((s, r) => s + r.kpi_points, 0) * 100) / 100;
    return { managers, employees, avgHealth, totalBalance, totalEarned, totalKpiPoints, depts: departments.length };
  }, [rows, departments.length]);

  const deptGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        id: string;
        name: string;
        members: OrgKpiPointsRow[];
        avgHealth: number;
        totalBalance: number;
        totalEarned: number;
        totalKpiPoints: number;
      }
    >();

    for (const r of filtered) {
      const id = r.department_id || '__none__';
      const name = r.department_name || 'Unassigned';
      if (!groups.has(id)) {
        groups.set(id, {
          id,
          name,
          members: [],
          avgHealth: 0,
          totalBalance: 0,
          totalEarned: 0,
          totalKpiPoints: 0,
        });
      }
      groups.get(id)!.members.push(r);
    }

    return Array.from(groups.values())
      .map((g) => {
        const n = g.members.length || 1;
        return {
          ...g,
          avgHealth: Math.round(g.members.reduce((s, m) => s + m.health_score, 0) / n),
          totalBalance: g.members.reduce((s, m) => s + m.balance, 0),
          totalEarned: g.members.reduce((s, m) => s + m.total_earned, 0),
          totalKpiPoints: Math.round(g.members.reduce((s, m) => s + m.kpi_points, 0) * 100) / 100,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [filtered]);

  if (loading && rows.length === 0) {
    return (
      <div className="admin-kpi-points-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading organization KPI points…</span>
      </div>
    );
  }

  return (
    <div className="admin-kpi-points">
      <header className="admin-kpi-points__header glass-panel">
        <div className="admin-kpi-points__header-main">
          <div className="admin-kpi-points__header-icon">
            <Trophy size={22} />
          </div>
          <div>
            <h2 className="admin-kpi-points__title">Organization KPI points</h2>
            <p className="admin-kpi-points__subtitle">
              Watch KPI achievement and rewards points for every department, manager, and employee.
            </p>
          </div>
        </div>
        <div className="admin-kpi-points__stats">
          <div className="admin-kpi-points__stat">
            <Building2 size={14} />
            <div>
              <strong>{stats.depts}</strong>
              <span>Departments</span>
            </div>
          </div>
          <div className="admin-kpi-points__stat">
            <UserCheck size={14} />
            <div>
              <strong>{stats.managers}</strong>
              <span>Managers</span>
            </div>
          </div>
          <div className="admin-kpi-points__stat">
            <User size={14} />
            <div>
              <strong>{stats.employees}</strong>
              <span>Employees</span>
            </div>
          </div>
          <div className="admin-kpi-points__stat admin-kpi-points__stat--accent">
            <Trophy size={14} />
            <div>
              <strong>{stats.totalKpiPoints.toLocaleString()}</strong>
              <span>Total KPI pts</span>
            </div>
          </div>
          <div className="admin-kpi-points__stat">
            <UserCheck size={14} />
            <div>
              <strong>{stats.avgHealth}%</strong>
              <span>Avg KPI</span>
            </div>
          </div>
          <div className="admin-kpi-points__stat">
            <Users size={14} />
            <div>
              <strong>{stats.totalBalance.toLocaleString()}</strong>
              <span>Points balance</span>
            </div>
          </div>
        </div>
      </header>

      {error && (
        <div className="admin-kpi-points__error" role="alert">
          {error}
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}

      <div className="admin-kpi-points__toolbar glass-panel">
        <label className="admin-kpi-points__search">
          <Search size={16} />
          <input
            type="search"
            placeholder="Search name, email, department…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search people"
          />
        </label>

        <div className="admin-kpi-points__filters">
          <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value as RoleFilter)} aria-label="Filter by role">
            <option value="all">All roles</option>
            <option value="manager">Managers</option>
            <option value="employee">Employees</option>
            <option value="admin">Admins</option>
          </select>
          <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Filter by department">
            <option value="all">All departments</option>
            <option value="__none__">Unassigned</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <div className="admin-kpi-points__view-toggle" role="group" aria-label="View mode">
            <button
              type="button"
              className={viewMode === 'people' ? 'is-active' : ''}
              onClick={() => setViewMode('people')}
            >
              People
            </button>
            <button
              type="button"
              className={viewMode === 'departments' ? 'is-active' : ''}
              onClick={() => setViewMode('departments')}
            >
              By department
            </button>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} title="Refresh">
            <RefreshCw size={14} className={loading ? 'spin-icon' : undefined} />
            Refresh
          </button>
        </div>
      </div>

      {viewMode === 'departments' ? (
        <div className="admin-kpi-points__dept-list">
          {deptGroups.length === 0 ? (
            <p className="admin-kpi-points__empty">No people match your filters.</p>
          ) : (
            deptGroups.map((g) => (
              <section key={g.id} className="admin-kpi-points__dept glass-panel">
                <header className="admin-kpi-points__dept-head">
                  <div>
                    <h3>
                      <Building2 size={16} /> {g.name}
                    </h3>
                    <p>
                      {g.members.length} member{g.members.length !== 1 ? 's' : ''} · Avg KPI{' '}
                      <strong className={healthClass(g.avgHealth)}>{g.avgHealth}%</strong>
                    </p>
                  </div>
                  <div className="admin-kpi-points__dept-totals">
                    <span>
                      KPI pts <strong>{g.totalKpiPoints.toLocaleString()}</strong>
                    </span>
                    <span>
                      Balance <strong>{g.totalBalance.toLocaleString()}</strong>
                    </span>
                    <span>
                      Earned <strong>{g.totalEarned.toLocaleString()}</strong>
                    </span>
                  </div>
                </header>
                <PeopleTable rows={g.members} />
              </section>
            ))
          )}
        </div>
      ) : (
        <div className="admin-kpi-points__table-wrap glass-panel">
          {filtered.length === 0 ? (
            <p className="admin-kpi-points__empty">No people match your filters.</p>
          ) : (
            <PeopleTable rows={filtered} showDepartment />
          )}
        </div>
      )}
    </div>
  );
}

function PeopleTable({
  rows,
  showDepartment = false,
}: {
  rows: OrgKpiPointsRow[];
  showDepartment?: boolean;
}) {
  return (
    <div className="admin-kpi-points__scroll">
      <table className="admin-kpi-points__table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            {showDepartment && <th>Department</th>}
            <th>KPI score</th>
            <th>KPI points</th>
            <th>KPI tasks</th>
            <th>This month</th>
            <th>Earned</th>
            <th>Balance</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.user_id}>
              <td>
                <div className="admin-kpi-points__person">
                  <strong>{r.full_name}</strong>
                  <span>{r.email}</span>
                </div>
              </td>
              <td>
                <span className={`admin-kpi-points__role admin-kpi-points__role--${r.role}`}>
                  {roleLabel(r.role)}
                </span>
              </td>
              {showDepartment && <td>{r.department_name || '—'}</td>}
              <td>
                <strong className={`admin-kpi-points__health ${healthClass(r.health_score)}`}>
                  {Math.round(r.health_score)}%
                </strong>
              </td>
              <td>
                <strong className="admin-kpi-points__kpi-pts">{r.kpi_points.toLocaleString()}</strong>
              </td>
              <td>
                {r.completed_kpis}/{r.total_kpis}
                {r.pending_kpis > 0 && (
                  <span className="admin-kpi-points__pending"> · {r.pending_kpis} open</span>
                )}
              </td>
              <td>
                {r.this_month_points != null ? (
                  <>
                    +{r.this_month_points}
                    {r.this_month_score != null && (
                      <span className="admin-kpi-points__muted"> ({Math.round(r.this_month_score)}%)</span>
                    )}
                  </>
                ) : (
                  '—'
                )}
              </td>
              <td>{r.total_earned.toLocaleString()}</td>
              <td>
                <strong>{r.balance.toLocaleString()}</strong>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
