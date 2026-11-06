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
import { karachiYearMonth } from '../utils/kpiCategories';
import { employeeKpiBoardBreakdown, kpisForPeriod, MONTH_OPTIONS, type KpiPeriodMode } from '../utils/kpiScoreHelpers';
import { monthStartIso } from '../utils/scoreWeightage';
import { ownMonthScoreHidden } from '../utils/weightageReveal';
import KpiScopedTasksList from './KpiScopedTasksList';
import KpiScoreboardSummary, { type KpiScoreboardPeriodState } from './KpiScoreboardSummary';
import { formatWeightagePct } from '../utils/monthWeightageBalance';
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
  /** Reward spend: available after monthly gift redeem */
  month_available?: number | null;
  month_used?: number;
  month_banked?: number;
  month_earned?: number | null;
}

type RoleFilter = 'all' | 'manager' | 'employee' | 'admin';

interface AdminOrgKpiPointsBoardProps {
  /** Admin sees every department; manager is limited to their department. */
  variant?: 'admin' | 'manager';
  /** Used to keep a manager inside their own department/team. */
  managerProfile?: { id: string; department_id?: string | null };
  initialSearch?: string;
  /** Hide the outer title card when embedded under Rewards tabs. */
  embedded?: boolean;
  /** Employee, manager, and HR do not see this month's scores until the last day. */
  concealUntilMonthEnd?: boolean;
}

function roleLabel(role: string): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  if (role === 'hr') return 'HR';
  return 'Employee';
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

interface OrgUserMonthModalProps {
  userId: string;
  fullName: string;
  role: string;
  initialMonth: number;
  initialYear: number;
  concealUntilMonthEnd?: boolean;
  onClose: () => void;
}

function OrgUserMonthModal({
  userId,
  fullName,
  role,
  initialMonth,
  initialYear,
  concealUntilMonthEnd = false,
  onClose,
}: OrgUserMonthModalProps) {
  const [allKpis, setAllKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<KpiScoreboardPeriodState>({
    mode: 'month',
    month: initialMonth,
    year: initialYear,
  });

  useEffect(() => {
    let isMounted = true;
    async function loadTasks() {
      setLoading(true);
      setError(null);
      try {
        const kpiRes = await supabase.from('kpis').select('*').eq('user_id', userId).order('end_date', { ascending: false });
        if (kpiRes.error) throw kpiRes.error;
        if (isMounted) {
          setAllKpis((kpiRes.data || []) as Kpi[]);
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
  }, [userId]);

  const scopedKpis = useMemo(
    () => (period.mode === 'overall'
      ? allKpis
      : kpisForPeriod(allKpis, period.mode as KpiPeriodMode, period.year, period.month)),
    [allKpis, period],
  );
  const periodBoard = useMemo(
    () => employeeKpiBoardBreakdown(scopedKpis),
    [scopedKpis],
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
                {scopeLabel} weightage:{' '}
                <strong style={{ color: 'var(--color-success)' }}>
                  {formatWeightagePct(periodBoard.weightAchieved)}
                </strong>
                {' '}· {periodBoard.weightAssigned.toFixed(periodBoard.weightAssigned % 1 === 0 ? 0 : 1)}% assigned
              </p>
              <ul className="user-hub-hero__score-stack" aria-label="Weightage summary">
                <li>
                  <span>Earned</span>
                  <strong style={{ color: 'var(--color-success)' }}>
                    {formatWeightagePct(periodBoard.weightAchieved)}
                  </strong>
                </li>
                <li>
                  <span>Tasks</span>
                  <strong>{periodBoard.completed}/{periodBoard.kpiCount}</strong>
                </li>
              </ul>
            </div>
          </div>
        </header>

        <div className="user-hub-body">
          {loading ? (
            <div className="admin-rewards-loading" style={{ padding: '2rem 1rem' }}>
              <Loader2 size={24} className="spin-icon" />
              <span>Loading weightage…</span>
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
                userId={userId}
                compact
                title={`${fullName}'s KPI weightage`}
                deferAchievedUntilMonthEnd={concealUntilMonthEnd}
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
  embedded = false,
  concealUntilMonthEnd = false,
}: AdminOrgKpiPointsBoardProps) {
  const isManagerView = variant === 'manager';
  const now = useMemo(() => karachiYearMonth(), []);
  const [rows, setRows] = useState<OrgKpiPointsRow[]>([]);
  const [kpisByUser, setKpisByUser] = useState<Record<string, Kpi[]>>({});
  const [usedByUser, setUsedByUser] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState(initialSearch || '');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [filterMonth, setFilterMonth] = useState(now.monthIndex);
  const [filterYear, setFilterYear] = useState(now.year);
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
      setKpisByUser({});
    } else {
      const base = normalizeRows(data);
      setRows(base);
      const ids = base.map((r) => r.user_id).filter(Boolean);
      if (ids.length === 0) {
        setKpisByUser({});
      } else {
        const kpiRes = await supabase.from('kpis').select('*').in('user_id', ids);
        if (kpiRes.error) {
          setError(kpiRes.error.message);
          setKpisByUser({});
        } else {
          const grouped: Record<string, Kpi[]> = {};
          for (const kpi of (kpiRes.data || []) as Kpi[]) {
            const id = kpi.user_id;
            if (!grouped[id]) grouped[id] = [];
            grouped[id].push(kpi);
          }
          setKpisByUser(grouped);
        }
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const scoresHidden = concealUntilMonthEnd && ownMonthScoreHidden(monthStartIso(filterYear, filterMonth));

  const monthLabel = useMemo(
    () => new Date(filterYear, filterMonth, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }),
    [filterYear, filterMonth],
  );

  const yearOptions = useMemo(() => {
    const years = new Set<number>([now.year, filterYear]);
    for (const list of Object.values(kpisByUser)) {
      for (const kpi of list) {
        const raw = kpi.start_date || kpi.created_at;
        const year = Number(String(raw || '').slice(0, 4));
        if (year >= 2000 && year <= 2100) years.add(year);
      }
    }
    return [...years].sort((a, b) => b - a);
  }, [kpisByUser, now.year, filterYear]);

  useEffect(() => {
    const ids = rows.map((r) => r.user_id).filter(Boolean);
    if (ids.length === 0) {
      setUsedByUser({});
      return;
    }
    let cancelled = false;
    void (async () => {
      const { data, error: ledgerError } = await supabase
        .from('reward_weightage_ledger')
        .select('employee_id, amount')
        .in('employee_id', ids)
        .eq('month', monthStartIso(filterYear, filterMonth));
      if (cancelled) return;
      if (ledgerError) {
        setUsedByUser({});
        return;
      }
      const used: Record<string, number> = {};
      for (const entry of data || []) {
        const id = String(entry.employee_id || '');
        if (!id) continue;
        used[id] = (used[id] || 0) + (Number(entry.amount) || 0);
      }
      setUsedByUser(used);
    })();
    return () => {
      cancelled = true;
    };
  }, [rows, filterYear, filterMonth]);

  useSupabaseRealtime(
    'admin-org-kpi-points',
    companyId
      ? [
          { table: 'users', filter: `company_id=eq.${companyId}` },
          { table: 'departments', filter: `company_id=eq.${companyId}` },
          { table: 'kpis' },
          { table: 'points_ledger' },
          { table: 'reward_redemptions' },
          { table: 'kpi_award_qualifications' },
          { table: 'reward_weightage_ledger' },
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
    }).map((r) => {
      const monthKpis = kpisForPeriod(kpisByUser[r.user_id] || [], 'month', filterYear, filterMonth);
      const board = employeeKpiBoardBreakdown(monthKpis);
      const used = usedByUser[r.user_id] || 0;
      const earned = board.weightAchieved;
      return {
        ...r,
        weight_assigned: board.weightAssigned,
        weight_achieved: earned,
        total_kpis: board.kpiCount,
        completed_kpis: board.completed,
        pending_kpis: board.pending,
        month_earned: earned,
        month_available: Math.max(0, earned - used),
        month_used: used,
      };
    });
  }, [scopedRows, search, roleFilter, kpisByUser, usedByUser, filterYear, filterMonth]);

  if (loading && rows.length === 0) {
    return (
      <div className="admin-kpi-points-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading each person&apos;s weightage…</span>
      </div>
    );
  }

  return (
    <div className={`admin-kpi-points${embedded ? ' admin-kpi-points--embedded' : ''}`}>
      {!embedded && (
        <header className="admin-kpi-points__header glass-panel">
          <div className="admin-kpi-points__header-main">
            <div className="admin-kpi-points__header-icon">
              <Trophy size={22} />
            </div>
            <div>
              <h2 className="admin-kpi-points__title">KPI &amp; Rewards</h2>
              <p className="admin-kpi-points__subtitle">
                {monthLabel} only. Switch the month to see another month by itself.
              </p>
            </div>
          </div>
        </header>
      )}

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
          <select
            value={filterMonth}
            onChange={(e) => setFilterMonth(Number(e.target.value))}
            aria-label="Month"
          >
            {MONTH_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>{m.label}</option>
            ))}
          </select>
          <select
            value={filterYear}
            onChange={(e) => setFilterYear(Number(e.target.value))}
            aria-label="Year"
          >
            {yearOptions.map((year) => (
              <option key={year} value={year}>{year}</option>
            ))}
          </select>
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
              {filtered.length} person{filtered.length !== 1 ? 's' : ''} · {monthLabel}
            </p>
          </div>
        </header>
        {filtered.length === 0 ? (
          <p className="admin-kpi-points__empty">No people match your filters.</p>
        ) : (
          <PeopleTable
            rows={filtered}
            monthLabel={monthLabel}
            scoresHidden={scoresHidden}
            onSelectRow={(row) => setSelectedRow(row)}
          />
        )}
      </section>

      {selectedRow && (
        <OrgUserMonthModal
          userId={selectedRow.user_id}
          fullName={selectedRow.full_name}
          role={selectedRow.role}
          initialMonth={filterMonth}
          initialYear={filterYear}
          concealUntilMonthEnd={concealUntilMonthEnd}
          onClose={() => setSelectedRow(null)}
        />
      )}
    </div>
  );
}

function PeopleTable({
  rows,
  monthLabel,
  scoresHidden = false,
  onSelectRow,
}: {
  rows: OrgKpiPointsRow[];
  monthLabel: string;
  scoresHidden?: boolean;
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
              <th title="Weightage earned from this month's tasks">Earned</th>
              <th>KPI tasks</th>
              <th>Month</th>
              <th title="This month's earned weightage minus gifts">Current</th>
              <th title="Weightage used on monthly gifts">Used</th>
              <th>History</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const weightAssigned = Number(r.weight_assigned) || 0;
              const earned = Number(r.month_earned ?? r.weight_achieved) || 0;
              const current = r.month_available != null ? Number(r.month_available) : earned;
              const used = Number(r.month_used) || 0;
              return (
                <tr
                  key={r.user_id}
                  className="admin-kpi-points__row--clickable"
                  onClick={() => onSelectRow(r)}
                  title={`Click to view ${r.full_name}'s weightage and tasks`}
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
                      <strong>{scoresHidden ? 'Last day' : formatWeightagePct(earned)}</strong>
                      <span className="admin-kpi-points__month-reward">
                        {scoresHidden ? 'Hidden until month end' : `${weightAssigned.toFixed(weightAssigned % 1 === 0 ? 0 : 1)}% assigned`}
                      </span>
                    </div>
                  </td>
                  <td>
                    <span className="admin-kpi-points__kpi-count">
                      {r.completed_kpis}/{r.total_kpis}
                    </span>
                  </td>
                  <td>
                    <span className="admin-kpi-points__period">{monthLabel}</span>
                  </td>
                  <td>
                    <strong style={{ color: scoresHidden || (current <= 0 && used > 0) ? 'var(--text-muted)' : 'var(--color-success)' }}>
                      {scoresHidden ? 'Last day' : formatWeightagePct(current)}
                    </strong>
                  </td>
                  <td>
                    <strong style={{ color: !scoresHidden && used > 0 ? 'var(--color-warning)' : 'var(--text-muted)' }}>
                      {scoresHidden ? 'Last day' : formatWeightagePct(used)}
                    </strong>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelectRow(r);
                      }}
                    >
                      <Eye size={14} /> View
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
          const earned = Number(r.month_earned ?? r.weight_achieved) || 0;
          const current = r.month_available != null ? Number(r.month_available) : earned;
          const used = Number(r.month_used) || 0;
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
                  <dt>Earned</dt>
                  <dd>{scoresHidden ? 'Last day' : formatWeightagePct(earned)}</dd>
                </div>
                <div>
                  <dt>Current</dt>
                  <dd style={{ color: scoresHidden || (current <= 0 && used > 0) ? 'var(--text-muted)' : 'var(--color-success)' }}>
                    {scoresHidden ? 'Last day' : formatWeightagePct(current)}
                  </dd>
                </div>
                <div>
                  <dt>Used</dt>
                  <dd style={{ color: !scoresHidden && used > 0 ? 'var(--color-warning)' : undefined }}>
                    {scoresHidden ? 'Last day' : formatWeightagePct(used)}
                  </dd>
                </div>
                <div>
                  <dt>KPI tasks</dt>
                  <dd>
                    {r.completed_kpis}/{r.total_kpis}
                    {r.pending_kpis > 0 ? ` · ${r.pending_kpis} open` : ''}
                  </dd>
                </div>
                <div className="admin-kpi-points__mobile-card-period">
                  <dt>Period</dt>
                  <dd>{monthLabel}</dd>
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
