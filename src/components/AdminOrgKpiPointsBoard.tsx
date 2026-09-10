import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Loader2,
  RefreshCw,
  Search,
  Trophy,
  Users,
  Eye,
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import { Kpi } from '../utils/kpiHelpers';
import { tierColorForScore } from '../utils/rewardsTiers';
import { karachiYearMonth } from '../utils/kpiCategories';
import { kpisForPeriod, type KpiPeriodMode } from '../utils/kpiScoreHelpers';
import KpiScopedTasksList from './KpiScopedTasksList';
import KpiScoreboardSummary, { type KpiScoreboardPeriodState } from './KpiScoreboardSummary';
import { fetchRewardsSummary, type RewardsSummary } from '../utils/rewardsHelpers';
import '../styles/admin-kpi-points.css';
import '../styles/employee-kpis.css';

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
  weight_assigned: number;
  weight_achieved: number;
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
      weight_assigned: Number(r.weight_assigned) || 0,
      weight_achieved: Number(r.weight_achieved) || 0,
      total_earned: earned,
      used_points: used,
      balance: earned - used,
      this_month_points: r.this_month_points == null ? 0 : Number(r.this_month_points),
      this_month_score: r.this_month_score == null ? null : Number(r.this_month_score),
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
  thisMonthScore: number | null;
  rewardBalance: number;
  rewardEarned: number;
  rewardUsed: number;
  onClose: () => void;
}

function OrgUserMonthModal({
  userId,
  fullName,
  role,
  healthScore,
  thisMonthPoints,
  thisMonthScore,
  rewardBalance,
  rewardEarned,
  rewardUsed,
  onClose,
}: OrgUserMonthModalProps) {
  const initialYm = useMemo(() => karachiYearMonth(), []);
  const [allKpis, setAllKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<KpiScoreboardPeriodState>({
    mode: 'month',
    month: initialYm.monthIndex,
    year: initialYm.year,
  });
  const [rewardsSummary, setRewardsSummary] = useState<RewardsSummary | null>(null);

  useEffect(() => {
    let isMounted = true;
    async function loadTasks() {
      setLoading(true);
      setError(null);
      try {
        const [kpiRes, rewards] = await Promise.all([
          supabase.from('kpis').select('*').eq('user_id', userId).order('end_date', { ascending: false }),
          fetchRewardsSummary(userId).catch(() => null),
        ]);
        if (kpiRes.error) throw kpiRes.error;
        if (isMounted) {
          setAllKpis((kpiRes.data || []) as Kpi[]);
          setRewardsSummary(
            rewards || {
              balance: rewardBalance,
              totalEarned: rewardEarned,
              usedPoints: rewardUsed,
              thisMonthPoints,
              thisMonthScore,
              pointsToNextReward: 0,
              progressPct: 0,
              canRedeem: rewardBalance >= 1000,
            },
          );
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
  }, [userId, rewardBalance, rewardEarned, rewardUsed, thisMonthPoints, thisMonthScore]);

  const scopedKpis = useMemo(
    () => kpisForPeriod(allKpis, period.mode as KpiPeriodMode, period.year, period.month),
    [allKpis, period],
  );
  const completedKpis = scopedKpis.filter((k) => k.completion_status === 'completed');
  const openKpis = scopedKpis.filter((k) => k.completion_status !== 'completed');
  const monthDisplay = new Date(period.year, period.month, 1).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
  });
  const scopeLabel = period.mode === 'overall'
    ? 'all assigned KPIs'
    : period.mode === 'year'
      ? String(period.year)
      : monthDisplay;

  return (
    <div className="user-hub-overlay" onClick={onClose}>
      <div className="user-hub-dialog org-user-month-modal" style={{ maxWidth: '920px' }} onClick={(e) => e.stopPropagation()}>
        <div className="user-hub-topbar">
          <button type="button" className="user-hub-back" onClick={onClose}>
            <ArrowLeft size={18} />
            Back
          </button>
          <button type="button" className="scorr-dialog-close" onClick={onClose} aria-label="Close dialog" title="Close">
            ×
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
              <p className="user-hub-hero__email user-hub-hero__email--scores">
                Overall score: <strong style={{ color: tierColorForScore(healthScore) }}>{Number(healthScore).toFixed(2)}</strong>
                {thisMonthScore != null && (
                  <>
                    {' '}· Month score: <strong style={{ color: tierColorForScore(thisMonthScore) }}>{Number(thisMonthScore).toFixed(2)}</strong>
                  </>
                )}
                {' '}· Month bonus: <strong style={{ color: 'var(--color-success)' }}>+{Number(thisMonthPoints ?? 0).toLocaleString()} pts</strong>
              </p>
              <ul className="user-hub-hero__score-stack" aria-label="Score summary">
                <li>
                  <span>Overall score</span>
                  <strong style={{ color: tierColorForScore(healthScore) }}>{Number(healthScore).toFixed(2)}</strong>
                </li>
                {thisMonthScore != null && (
                  <li>
                    <span>Month score</span>
                    <strong style={{ color: tierColorForScore(thisMonthScore) }}>{Number(thisMonthScore).toFixed(2)}</strong>
                  </li>
                )}
                <li>
                  <span>Month bonus</span>
                  <strong style={{ color: 'var(--color-success)' }}>+{Number(thisMonthPoints ?? 0).toLocaleString()} pts</strong>
                </li>
              </ul>
            </div>
          </div>
        </header>

        <div className="user-hub-body">
          {loading ? (
            <div className="admin-rewards-loading" style={{ padding: '2rem 1rem' }}>
              <Loader2 size={24} className="spin-icon" />
              <span>Loading scoreboard…</span>
            </div>
          ) : error ? (
            <div className="admin-rewards-alert admin-rewards-alert--error">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          ) : (
            <>
              <KpiScoreboardSummary
                kpis={allKpis}
                rewardsSummary={rewardsSummary}
                compact
                title={`${fullName}'s KPI scoreboard`}
                period={period}
                onPeriodChange={setPeriod}
              />

              <div className="kpi-scope-tasks__head">
                <h4 className="user-hub-section-title" style={{ margin: 0 }}>
                  Tasks in scope · {scopeLabel} ({scopedKpis.length})
                </h4>
                <div className="kpi-scope-tasks__counts">
                  <span className="is-done">✓ {completedKpis.length} Completed</span>
                  {openKpis.length > 0 && (
                    <span className="is-open">· {openKpis.length} In Progress / Open</span>
                  )}
                </div>
              </div>

              {scopedKpis.length === 0 ? (
                <div className="admin-rewards-empty" style={{ padding: '2rem 1rem' }}>
                  <CheckCircle2 size={36} strokeWidth={1.25} />
                  <h4>No tasks in this period</h4>
                  <p>Switch Overall / Month / Year above to change the scope for {fullName}.</p>
                </div>
              ) : (
                <KpiScopedTasksList kpis={scopedKpis} />
              )}
            </>
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
  const [companyId, setCompanyId] = useState<string | null>(null);

  useEffect(() => {
    if (initialSearch) setSearch(initialSearch);
  }, [initialSearch]);

  useEffect(() => {
    let cancelled = false;
    void supabase.auth.getUser().then(async ({ data }) => {
      const uid = data.user?.id;
      if (!uid) return;
      const { data: me } = await supabase.from('users').select('company_id').eq('id', uid).maybeSingle();
      if (!cancelled) setCompanyId((me as { company_id?: string | null } | null)?.company_id ?? null);
    });
    return () => { cancelled = true; };
  }, []);

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
    companyId
      ? [
          { table: 'users', filter: `company_id=eq.${companyId}` },
          { table: 'departments', filter: `company_id=eq.${companyId}` },
          { table: 'kpis' },
          { table: 'points_ledger' },
          { table: 'reward_redemptions' },
        ]
      : [],
    () => { void load({ silent: true }); },
    Boolean(companyId),
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
            <h2 className="admin-kpi-points__title">KPI &amp; Rewards</h2>
            <p className="admin-kpi-points__subtitle">
              Per-person weightage (0–100%), KPI score (points index), performance points, and reward balance.
              Monthly reward bands use the same score thresholds: 90+ → 1,000 · 80–89 → 500 · 70–79 → 250 · below 70 → 0.
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
          thisMonthScore={selectedRow.this_month_score}
          rewardBalance={selectedRow.balance}
          rewardEarned={selectedRow.total_earned}
          rewardUsed={selectedRow.used_points}
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
    <>
      <div className="admin-kpi-points__scroll">
        <table className="admin-kpi-points__table admin-kpi-points__table--clickable">
          <thead>
            <tr>
              <th>Person</th>
              <th>Role</th>
              <th title="Weight assigned across all KPIs (0–100%)">Weightage</th>
              <th title="All-time score (points awarded ÷ weight assigned × 100)">Score</th>
              <th>Performance pts</th>
              <th>KPI tasks</th>
              <th>Period</th>
              <th title="Score for KPIs overlapping the current month only">Month score</th>
              <th>Reward earned</th>
              <th>Reward balance</th>
              <th>History</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const start = formatKpiDate(r.kpi_period_start);
              const end = formatKpiDate(r.kpi_period_end);
              const periodLabel = start && end && start !== end
                ? `${start} – ${end}`
                : (start || end || currentMonthLabel());
              const weightAssigned = Number(r.weight_assigned) || 0;
              const weightAchieved = Number(r.weight_achieved) || 0;
              return (
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
                    <div className="admin-kpi-points__month-score">
                      <strong>{weightAssigned.toFixed(weightAssigned % 1 === 0 ? 0 : 2)}%</strong>
                      <span className="admin-kpi-points__month-reward">
                        {weightAchieved.toFixed(weightAchieved % 1 === 0 ? 0 : 2)}% achieved
                      </span>
                    </div>
                  </td>
                  <td>
                    <strong className={`admin-kpi-points__health ${healthClass(r.health_score)}`}>
                      {Number(r.health_score).toFixed(2)}
                    </strong>
                  </td>
                  <td>
                    <strong className="admin-kpi-points__kpi-pts">{r.kpi_points.toLocaleString()}</strong>
                  </td>
                  <td>
                    <span className="admin-kpi-points__tasks">{r.completed_kpis}/{r.total_kpis}</span>
                    {r.pending_kpis > 0 && (
                      <span className="admin-kpi-points__pending"> · {r.pending_kpis} open</span>
                    )}
                  </td>
                  <td>
                    <span className="admin-kpi-points__month-dates">{periodLabel}</span>
                  </td>
                  <td>
                    <div className="admin-kpi-points__month-score">
                      {r.this_month_score != null ? (
                        <strong className={`admin-kpi-points__health ${healthClass(Number(r.this_month_score))}`}>
                          {Number(r.this_month_score).toFixed(2)}
                        </strong>
                      ) : (
                        <span className="admin-kpi-points__muted">—</span>
                      )}
                      <span className="admin-kpi-points__month-reward">
                        +{Number(r.this_month_points ?? 0).toLocaleString()} reward pts
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
                      className="btn btn-secondary btn-sm admin-kpi-points__history-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectRow(r);
                      }}
                    >
                      <Eye size={13} /> Tasks
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="admin-kpi-points__mobile-cards" aria-label="People list">
        {rows.map((r) => {
          const start = formatKpiDate(r.kpi_period_start);
          const end = formatKpiDate(r.kpi_period_end);
          const periodLabel = start && end && start !== end
            ? `${start} – ${end}`
            : (start || end || currentMonthLabel());
          const weightAssigned = Number(r.weight_assigned) || 0;
          const weightAchieved = Number(r.weight_achieved) || 0;
          return (
            <article
              key={`card-${r.user_id}`}
              className="admin-kpi-points__mobile-card"
              onClick={() => onSelectRow(r)}
            >
              <header className="admin-kpi-points__mobile-card-head">
                <div className="admin-kpi-points__person">
                  <strong>{r.full_name}</strong>
                  <span>{r.email}</span>
                </div>
                <span className={`admin-kpi-points__role admin-kpi-points__role--${r.role}`}>
                  {roleLabel(r.role)}
                </span>
              </header>
              <dl className="admin-kpi-points__mobile-card-grid">
                <div>
                  <dt>Weightage</dt>
                  <dd>
                    {weightAssigned.toFixed(weightAssigned % 1 === 0 ? 0 : 2)}%
                    <span> · {weightAchieved.toFixed(weightAchieved % 1 === 0 ? 0 : 2)}% achieved</span>
                  </dd>
                </div>
                <div>
                  <dt>Score</dt>
                  <dd className={healthClass(r.health_score)}>{Number(r.health_score).toFixed(2)}</dd>
                </div>
                <div>
                  <dt>Performance pts</dt>
                  <dd>{r.kpi_points.toLocaleString()}</dd>
                </div>
                <div>
                  <dt>KPI tasks</dt>
                  <dd>
                    {r.completed_kpis}/{r.total_kpis}
                    {r.pending_kpis > 0 ? ` · ${r.pending_kpis} open` : ''}
                  </dd>
                </div>
                <div>
                  <dt>Month score</dt>
                  <dd>
                    {r.this_month_score != null ? Number(r.this_month_score).toFixed(2) : '—'}
                    <span> · +{Number(r.this_month_points ?? 0).toLocaleString()} pts</span>
                  </dd>
                </div>
                <div>
                  <dt>Reward balance</dt>
                  <dd>{r.balance.toLocaleString()}</dd>
                </div>
                <div className="admin-kpi-points__mobile-card-period">
                  <dt>Period</dt>
                  <dd>{periodLabel}</dd>
                </div>
              </dl>
              <button
                type="button"
                className="btn btn-secondary btn-sm admin-kpi-points__history-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectRow(r);
                }}
              >
                <Eye size={13} /> View tasks
              </button>
            </article>
          );
        })}
      </div>
    </>
  );
}
