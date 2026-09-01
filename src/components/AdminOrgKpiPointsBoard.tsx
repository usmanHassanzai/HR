import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  Search,
  Trophy,
  Users,
  Eye,
  Check,
  X,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import { Kpi } from '../utils/kpiHelpers';
import { tierColorForScore } from '../utils/rewardsTiers';
import { kpiCategoryMeta } from '../utils/kpiCategories';
import { isKpiLateCompletion, kpiAssignedScore, kpiScoreContribution } from '../utils/kpiScoreHelpers';
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
  kpi_period_start: string | null;
  kpi_period_end: string | null;
}

type RoleFilter = 'all' | 'manager' | 'employee' | 'admin';

interface AdminOrgKpiPointsBoardProps {
  /** Admin sees every department; manager is limited to their department. */
  variant?: 'admin' | 'manager';
  /** Used to keep a manager inside their own department/team. */
  managerProfile?: { id: string; department_id?: string | null };
  initialSearch?: string;
}

function roleLabel(role: string): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  if (role === 'hr') return 'HR';
  return 'Employee';
}

function healthClass(score: number): string {
  if (score >= 90) return 'admin-kpi-points__health--good';
  if (score >= 70) return 'admin-kpi-points__health--mid';
  return 'admin-kpi-points__health--low';
}

function normalizeRows(data: unknown): OrgKpiPointsRow[] {
  return ((data as OrgKpiPointsRow[]) || []).map((r) => {
    const kpiPts = Number(r.kpi_points) || 0;
    const earned = Number(r.total_earned) || 0;
    const used = Number(r.used_points) || 0;
    return {
      ...r,
      health_score: Number(r.health_score) || 0,
      total_kpis: Number(r.total_kpis) || 0,
      completed_kpis: Number(r.completed_kpis) || 0,
      pending_kpis: Number(r.pending_kpis) || 0,
      kpi_points: kpiPts,
      total_earned: earned,
      used_points: used,
      balance: earned - used,
      this_month_points: r.this_month_points == null ? 0 : Number(r.this_month_points),
      this_month_score: r.this_month_score == null ? Number(r.health_score) || 0 : Number(r.this_month_score),
      kpi_period_start: r.kpi_period_start || null,
      kpi_period_end: r.kpi_period_end || null,
    };
  });
}

function formatKpiDate(value: string | null): string | null {
  if (!value) return null;
  const d = new Date(`${value.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function currentMonthLabel(): string {
  return new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
}

interface OrgUserMonthModalProps {
  userId: string;
  fullName: string;
  role: string;
  healthScore: number;
  thisMonthPoints: number | null;
  onClose: () => void;
}

function OrgUserMonthModal({
  userId,
  fullName,
  role,
  healthScore,
  thisMonthPoints,
  onClose,
}: OrgUserMonthModalProps) {
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const now = new Date();
  const monthDisplay = now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const y = now.getFullYear();
  const m = now.getMonth() + 1;
  const monthStart = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const monthEnd = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  useEffect(() => {
    let isMounted = true;
    async function loadTasks() {
      setLoading(true);
      setError(null);
      try {
        const { data, error: kpiErr } = await supabase
          .from('kpis')
          .select('*')
          .eq('user_id', userId)
          .order('end_date', { ascending: false });

        if (kpiErr) throw kpiErr;

        if (isMounted) {
          const allUserKpis = (data || []) as Kpi[];
          const monthKpis = allUserKpis.filter((k) => {
            const completedDate = (k.completed_at || k.updated_at || '').slice(0, 10);
            const endDate = (k.end_date || '').slice(0, 10);
            const startDate = (k.start_date || k.created_at || '').slice(0, 10);

            if (k.completion_status === 'completed' && completedDate >= monthStart && completedDate <= monthEnd) {
              return true;
            }
            if (endDate >= monthStart && endDate <= monthEnd) {
              return true;
            }
            return startDate <= monthEnd && (endDate ? endDate >= monthStart : true);
          });
          setKpis(monthKpis);
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load task history');
        }
      } finally {
        if (isMounted) {
          setLoading(false);
        }
      }
    }

    void loadTasks();
    return () => {
      isMounted = false;
    };
  }, [userId, monthStart, monthEnd]);

  const completedKpis = kpis.filter((k) => k.completion_status === 'completed');
  const openKpis = kpis.filter((k) => k.completion_status !== 'completed');

  return (
    <div className="user-hub-overlay" onClick={onClose}>
      <div className="user-hub-dialog org-user-month-modal" style={{ maxWidth: '840px' }} onClick={(e) => e.stopPropagation()}>
        <div className="user-hub-topbar">
          <button type="button" className="user-hub-back" onClick={onClose}>
            <ArrowLeft size={18} />
            Back
          </button>
          <button type="button" className="user-hub-close" onClick={onClose} aria-label="Close dialog">
            <X size={20} />
          </button>
        </div>

        <header className="user-hub-hero">
          <div className="user-hub-hero__info">
            <div className={`admin-user-card__avatar admin-user-card__avatar--${role}`}>
              {fullName.slice(0, 2).toUpperCase()}
            </div>
            <div className="user-hub-hero__text">
              <div className="user-hub-hero__title-row">
                <h2>{fullName}</h2>
                <span className={`admin-role-badge admin-role-badge--${role}`}>
                  {role.toUpperCase()}
                </span>
              </div>
              <p className="user-hub-hero__email">
                Current Month (<strong>{monthDisplay}</strong>) · KPI Score: <strong style={{ color: tierColorForScore(healthScore) }}>{Number(healthScore).toFixed(2)}%</strong> · Bonus: <strong style={{ color: 'var(--color-success)' }}>+{Number(thisMonthPoints ?? 0).toLocaleString()} pts</strong>
              </p>
            </div>
          </div>
        </header>

        <div className="user-hub-body">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem' }}>
            <h4 className="user-hub-section-title" style={{ margin: 0 }}>
              Completed &amp; Assigned Tasks for {monthDisplay} ({kpis.length} total)
            </h4>
            <div style={{ display: 'flex', gap: '0.6rem', fontSize: '0.8rem' }}>
              <span style={{ color: 'var(--color-success)', fontWeight: 700 }}>
                ✓ {completedKpis.length} Completed
              </span>
              {openKpis.length > 0 && (
                <span style={{ color: 'var(--text-muted)', fontWeight: 600 }}>
                  · {openKpis.length} In Progress / Open
                </span>
              )}
            </div>
          </div>

          {loading ? (
            <div className="admin-rewards-loading" style={{ padding: '2rem 1rem' }}>
              <Loader2 size={24} className="spin-icon" />
              <span>Loading tasks for {monthDisplay}…</span>
            </div>
          ) : error ? (
            <div className="admin-rewards-alert admin-rewards-alert--error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          ) : kpis.length === 0 ? (
            <div className="admin-rewards-empty" style={{ padding: '2rem 1rem' }}>
              <CheckCircle2 size={36} strokeWidth={1.25} />
              <h4>No tasks found for this month</h4>
              <p>No KPI tasks were logged or completed for {fullName} in {monthDisplay}.</p>
            </div>
          ) : (
            <div className="admin-rewards-table-wrap">
              <table className="admin-rewards-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Task / KPI Name</th>
                    <th>Category</th>
                    <th>Weight</th>
                    <th>Score</th>
                    <th>Points Awarded</th>
                    <th>Status &amp; Completion</th>
                  </tr>
                </thead>
                <tbody>
                  {kpis.map((kpi) => {
                    const isDone = kpi.completion_status === 'completed';
                    const isLate = isKpiLateCompletion(kpi);
                    const awarded = kpiScoreContribution(kpi);
                    const cat = kpiCategoryMeta(kpi.kpi_category);
                    const completedDateStr = kpi.completed_at || (isDone ? kpi.updated_at : null);

                    return (
                      <tr key={kpi.id}>
                        <td>
                          <strong>{kpi.name}</strong>
                          {kpi.description && (
                            <p style={{ margin: '0.2rem 0 0', fontSize: '0.75rem', color: 'var(--text-muted)', maxWidth: '280px' }}>
                              {kpi.description}
                            </p>
                          )}
                        </td>
                        <td>
                          <span style={{ fontSize: '0.74rem', color: 'var(--text-secondary)' }}>
                            {cat.label}
                          </span>
                        </td>
                        <td style={{ fontWeight: 600 }}>{kpi.weight || 0}%</td>
                        <td style={{ fontWeight: 600 }}>{kpiAssignedScore(kpi)} pts</td>
                        <td>
                          <strong style={{ color: isDone ? (isLate ? '#d97706' : 'var(--color-success)') : 'var(--text-muted)' }}>
                            {isDone ? `${awarded} pts` : '0 pts (open)'}
                          </strong>
                          {isDone && isLate && (
                            <span style={{ display: 'block', fontSize: '0.68rem', color: '#d97706' }}>
                              (50% late deduction)
                            </span>
                          )}
                        </td>
                        <td>
                          {isDone ? (
                            <div>
                              <span className="badge badge-on-track" style={{ fontSize: '0.68rem', fontWeight: 700 }}>
                                <Check size={11} style={{ display: 'inline', verticalAlign: '-1px', marginRight: '2px' }} /> Completed
                              </span>
                              {completedDateStr && (
                                <span style={{ display: 'block', fontSize: '0.72rem', color: 'var(--text-muted)', marginTop: '0.15rem' }}>
                                  {new Date(completedDateStr).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                              In progress
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function AdminOrgKpiPointsBoard({
  variant = 'admin',
  managerProfile,
  initialSearch = '',
}: AdminOrgKpiPointsBoardProps) {
  const isManagerView = variant === 'manager';
  const [rows, setRows] = useState<OrgKpiPointsRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(initialSearch || '');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [selectedRow, setSelectedRow] = useState<OrgKpiPointsRow | null>(null);

  useEffect(() => {
    if (initialSearch) setSearch(initialSearch);
  }, [initialSearch]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) {
      setLoading(true);
      setError('');
    }
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
    () => { void load({ silent: true }); },
  );

  const scopedRows = useMemo(() => {
    if (!isManagerView) return rows;
    return rows.filter((r) => r.role !== 'admin' || r.user_id === managerProfile?.id);
  }, [isManagerView, managerProfile, rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return scopedRows.filter((r) => {
      if (roleFilter !== 'all' && r.role !== roleFilter) return false;
      if (!q) return true;
      return (
        r.full_name.toLowerCase().includes(q) ||
        r.email.toLowerCase().includes(q) ||
        (r.department_name || '').toLowerCase().includes(q) ||
        roleLabel(r.role).toLowerCase().includes(q)
      );
    });
  }, [scopedRows, search, roleFilter]);

  if (loading && rows.length === 0) {
    return (
      <div className="admin-kpi-points-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading each person&apos;s scores…</span>
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
            <h2 className="admin-kpi-points__title">Each person&apos;s scores</h2>
            <p className="admin-kpi-points__subtitle">
              KPI score, performance points, and reward points are listed per person — not as a team or department total. Reward points come from monthly score bands (90%→1000, 80%→500, 70%→250, below 70%→0).
            </p>
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
            placeholder="Search people…"
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
            {!isManagerView && <option value="admin">Admins</option>}
          </select>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void load()} title="Refresh">
            <RefreshCw size={14} className={loading ? 'spin-icon' : undefined} />
            Refresh
          </button>
        </div>
      </div>

      <section className="admin-kpi-points__dept glass-panel">
        <header className="admin-kpi-points__dept-head">
          <div>
            <h3>
              <Users size={16} /> People
            </h3>
            <p>
              {filtered.length} person{filtered.length !== 1 ? 's' : ''}
            </p>
          </div>
        </header>
        {filtered.length === 0 ? (
          <p className="admin-kpi-points__empty">No people match your filters.</p>
        ) : (
          <PeopleTable rows={filtered} onSelectRow={(row) => setSelectedRow(row)} />
        )}
      </section>

      {selectedRow && (
        <OrgUserMonthModal
          userId={selectedRow.user_id}
          fullName={selectedRow.full_name}
          role={selectedRow.role}
          healthScore={selectedRow.health_score}
          thisMonthPoints={selectedRow.this_month_points}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  );
}

function PeopleTable({
  rows,
  onSelectRow,
}: {
  rows: OrgKpiPointsRow[];
  onSelectRow: (row: OrgKpiPointsRow) => void;
}) {
  return (
    <div className="admin-kpi-points__scroll">
      <table className="admin-kpi-points__table admin-kpi-points__table--clickable">
        <thead>
          <tr>
            <th>Person</th>
            <th>Role</th>
            <th>KPI score</th>
            <th>Performance pts</th>
            <th>KPI tasks</th>
            <th>This month</th>
            <th>Reward earned</th>
            <th>Reward balance</th>
            <th>History</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.user_id}
              className="admin-kpi-points__row--clickable"
              onClick={() => onSelectRow(r)}
              title={`Click to view ${r.full_name}'s completed tasks for this month`}
            >
              <td>
                <button
                  type="button"
                  className="admin-kpi-points__member-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectRow(r);
                  }}
                >
                  <div className="admin-kpi-points__person">
                    <strong>{r.full_name}</strong>
                    <span>{r.email}</span>
                  </div>
                </button>
              </td>
              <td>
                <span className={`admin-kpi-points__role admin-kpi-points__role--${r.role}`}>
                  {roleLabel(r.role)}
                </span>
              </td>
              <td>
                <strong className={`admin-kpi-points__health ${healthClass(r.health_score)}`}>
                  {Number(r.health_score).toFixed(2)}%
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
                <div className="admin-kpi-points__month">
                  <span className="admin-kpi-points__month-dates">
                    {(() => {
                      const start = formatKpiDate(r.kpi_period_start);
                      const end = formatKpiDate(r.kpi_period_end);
                      if (start && end && start !== end) return `${start} – ${end}`;
                      if (start || end) return start || end;
                      return currentMonthLabel();
                    })()}
                  </span>
                  <span className="admin-kpi-points__month-pts">
                    +{Number(r.this_month_points ?? 0).toLocaleString()} reward pts
                    {r.this_month_score != null && (
                      <span> · {Number(r.this_month_score).toFixed(2)}%</span>
                    )}
                  </span>
                </div>
              </td>
              <td>{r.total_earned.toLocaleString()}</td>
              <td>
                <strong>{r.balance.toLocaleString()}</strong>
              </td>
              <td>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectRow(r);
                  }}
                  style={{ padding: '0.28rem 0.6rem', fontSize: '0.76rem', gap: '0.3rem' }}
                >
                  <Eye size={13} /> Tasks
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
