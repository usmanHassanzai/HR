import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi } from '../utils/kpiHelpers';
import {
  Gift,
  Plus,
  Trash2,
  Edit2,
  Loader2,
  CheckCircle2,
  Trophy,
  Star,
  PlayCircle,
  AlertCircle,
  Info,
  Coins,
  Clock,
  Package,
  Users,
  Eye,
  Search,
  Target,
  ChevronRight,
  ArrowLeft,
  Upload,
} from 'lucide-react';
import { tierColorForScore } from '../utils/rewardsTiers';
import AdminOrgKpiPointsBoard, { type OrgKpiPointsRow } from './AdminOrgKpiPointsBoard';
import AdminKpiAwardsPanel from './AdminKpiAwardsPanel';
import KpiScopedTasksList from './KpiScopedTasksList';
import KpiScoreboardSummary from './KpiScoreboardSummary';
import RewardCatalogIcon from './RewardCatalogIcon';
import { fetchRewardsSummary, type RewardsSummary } from '../utils/rewardsHelpers';
import { fileToRewardIconDataUrl, REWARD_EMOJI_PRESETS } from '../utils/rewardIconHelpers';
import '../styles/admin-rewards.css';
import '../styles/employee-kpis.css';

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  point_cost: number;
  weightage_required: number;
  active: boolean;
}

interface MonthlyRow {
  employee_id: string;
  full_name: string;
  role: string;
  kpi_score: number;
  points_earned: number;
  month: string;
}

interface Redemption {
  id: string;
  employee_id: string;
  points_used: number;
  weightage_at_claim?: number | null;
  status: string;
  redeemed_at: string;
  users?: { full_name: string; role: string; is_demo?: boolean };
  rewards_catalog?: { name: string; icon: string };
}

interface PersonPointsSummary {
  employee_id: string;
  full_name: string;
  role: string;
  email: string;
  department_name: string | null;
  health_score: number;
  kpi_points: number;
  weight_assigned: number;
  weight_achieved: number;
  total_earned: number;
  used_points: number;
  balance: number;
  completed_kpis: number;
  total_kpis: number;
  pending_kpis: number;
  this_month_points: number;
  this_month_score: number;
  months: MonthlyRow[];
}

function monthBounds(month: string): { start: string; end: string; label: string } {
  const monthObj = new Date(month);
  if (Number.isNaN(monthObj.getTime())) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth() + 1;
    const start = `${y}-${String(m).padStart(2, '0')}-01`;
    const lastDay = new Date(y, m, 0).getDate();
    const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    return { start, end, label: now.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) };
  }
  const y = monthObj.getFullYear();
  const m = monthObj.getMonth() + 1;
  const start = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const end = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return {
    start,
    end,
    label: monthObj.toLocaleDateString(undefined, { month: 'long', year: 'numeric' }),
  };
}

function filterKpisForMonth(allKpis: Kpi[], monthStart: string, monthEnd: string): Kpi[] {
  return allKpis.filter((k) => {
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
}

function TaskHistoryTable({ kpis, monthLabel }: { kpis: Kpi[]; monthLabel: string }) {
  const completedKpis = kpis.filter((k) => k.completion_status === 'completed');
  const openKpis = kpis.filter((k) => k.completion_status !== 'completed');

  if (kpis.length === 0) {
    return (
      <div className="admin-rewards-empty" style={{ padding: '1.5rem 1rem' }}>
        <CheckCircle2 size={32} strokeWidth={1.25} />
        <h4>No tasks for {monthLabel}</h4>
        <p>No KPI tasks were assigned or completed in this period.</p>
      </div>
    );
  }

  return (
    <>
      <div className="person-points-detail__task-meta">
        <span className="person-points-detail__task-stat person-points-detail__task-stat--done">
          ✓ {completedKpis.length} completed
        </span>
        {openKpis.length > 0 && (
          <span className="person-points-detail__task-stat">
            {openKpis.length} in progress / open
          </span>
        )}
      </div>
      <KpiScopedTasksList kpis={kpis} />
    </>
  );
}

function PersonPointsDetailModal({
  person,
  initialMonth,
  onClose,
}: {
  person: PersonPointsSummary;
  initialMonth?: string;
  onClose: () => void;
}) {
  const defaultMonth = initialMonth || person.months[0]?.month || new Date().toISOString().slice(0, 10);
  const [selectedMonth, setSelectedMonth] = useState(defaultMonth);
  const [allKpis, setAllKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [rewardsSummary, setRewardsSummary] = useState<RewardsSummary | null>(null);

  const { start: monthStart, end: monthEnd, label: monthDisplay } = monthBounds(selectedMonth);
  const monthKpis = useMemo(
    () => filterKpisForMonth(allKpis, monthStart, monthEnd),
    [allKpis, monthStart, monthEnd],
  );

  const selectedLedger = person.months.find((m) => m.month.slice(0, 7) === selectedMonth.slice(0, 7));
  const displayScore = selectedLedger?.kpi_score ?? person.this_month_score;
  const displayBonus = selectedLedger?.points_earned ?? person.this_month_points;

  useEffect(() => {
    let isMounted = true;
    async function loadTasks() {
      setLoading(true);
      setError(null);
      try {
        const [kpiRes, rewards] = await Promise.all([
          supabase.from('kpis').select('*').eq('user_id', person.employee_id).order('end_date', { ascending: false }),
          fetchRewardsSummary(person.employee_id).catch(() => null),
        ]);
        if (kpiRes.error) throw kpiRes.error;
        if (isMounted) {
          setAllKpis((kpiRes.data || []) as Kpi[]);
          setRewardsSummary(
            rewards || {
              balance: person.balance,
              totalEarned: person.total_earned,
              usedPoints: person.used_points,
              thisMonthPoints: person.this_month_points,
              thisMonthScore: person.this_month_score,
              pointsToNextReward: 0,
              progressPct: 0,
              canRedeem: person.balance >= 1000,
            },
          );
        }
      } catch (err) {
        if (isMounted) {
          setError(err instanceof Error ? err.message : 'Failed to load task history');
        }
      } finally {
        if (isMounted) setLoading(false);
      }
    }
    void loadTasks();
    return () => { isMounted = false; };
  }, [person.employee_id]);

  return (
    <div className="user-hub-overlay" onClick={onClose}>
      <div className="user-hub-dialog person-points-detail" onClick={(e) => e.stopPropagation()}>
        <div className="user-hub-topbar">
          <button type="button" className="user-hub-back" onClick={onClose}>
            <ArrowLeft size={18} />
            Back
          </button>
        </div>

        <header className="user-hub-hero">
          <div className="user-hub-hero__info">
            <div className={`admin-user-card__avatar admin-user-card__avatar--${person.role}`}>
              {person.full_name.slice(0, 2).toUpperCase()}
            </div>
            <div className="user-hub-hero__text">
              <div className="user-hub-hero__title-row">
                <h2>{person.full_name}</h2>
                <span className={`admin-role-badge admin-role-badge--${person.role}`}>
                  {person.role.toUpperCase()}
                </span>
              </div>
              <p className="user-hub-hero__email">{person.email}</p>
              <div className="user-hub-hero__tags">
                {person.department_name && (
                  <span className="user-hub-tag">{person.department_name}</span>
                )}
              </div>
            </div>
          </div>
        </header>

        <div className="user-hub-body">
          {allKpis.length > 0 && (
            <div style={{ marginBottom: '1.25rem' }}>
              <KpiScoreboardSummary
                kpis={allKpis}
                rewardsSummary={rewardsSummary}
                compact
                title={`${person.full_name}'s KPI scoreboard`}
              />
            </div>
          )}

          <div className="person-points-detail__metrics">
            <div className="person-points-detail__metric">
              <span>Weightage</span>
              <strong>
                {(person.weight_assigned || 0).toFixed((person.weight_assigned || 0) % 1 === 0 ? 0 : 2)}%
              </strong>
            </div>
            <div className="person-points-detail__metric">
              <span>KPI score</span>
              <strong style={{ color: tierColorForScore(displayScore) }}>{Math.round(displayScore)}</strong>
            </div>
            <div className="person-points-detail__metric">
              <span>Performance pts</span>
              <strong>{person.kpi_points.toLocaleString()}</strong>
            </div>
            <div className="person-points-detail__metric">
              <span>Month bonus</span>
              <strong style={{ color: 'var(--color-success)' }}>+{displayBonus.toLocaleString()}</strong>
            </div>
            <div className="person-points-detail__metric">
              <span>Total earned</span>
              <strong>{person.total_earned.toLocaleString()}</strong>
            </div>
            <div className="person-points-detail__metric">
              <span>Balance</span>
              <strong>{person.balance.toLocaleString()}</strong>
            </div>
            <div className="person-points-detail__metric">
              <span>Tasks</span>
              <strong>{person.completed_kpis}/{person.total_kpis}</strong>
            </div>
          </div>

          {person.months.length > 0 && (
            <section className="person-points-detail__section">
              <h4 className="user-hub-section-title">Monthly bonus history</h4>
              <div className="admin-rewards-table-wrap">
                <table className="admin-rewards-table">
                  <thead>
                    <tr>
                      <th>Month</th>
                      <th>KPI score</th>
                      <th>Reward points</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {person.months.map((m) => (
                      <tr
                        key={m.month}
                        className={`admin-rewards-row--clickable${selectedMonth.slice(0, 7) === m.month.slice(0, 7) ? ' person-points-detail__month--active' : ''}`}
                        onClick={() => setSelectedMonth(m.month)}
                      >
                        <td><strong>{new Date(m.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}</strong></td>
                        <td style={{ color: tierColorForScore(m.kpi_score), fontWeight: 700 }}>{Math.round(m.kpi_score)}</td>
                        <td style={{ color: 'var(--color-success)', fontWeight: 700 }}>+{m.points_earned.toLocaleString()}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-secondary btn-sm"
                            onClick={(e) => { e.stopPropagation(); setSelectedMonth(m.month); }}
                          >
                            View tasks
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section className="person-points-detail__section">
            <div className="person-points-detail__section-head">
              <h4 className="user-hub-section-title">Task history — {monthDisplay}</h4>
              {person.months.length > 1 && (
                <select
                  className="person-points-detail__month-select"
                  value={selectedMonth.slice(0, 10)}
                  onChange={(e) => setSelectedMonth(e.target.value)}
                >
                  {person.months.map((m) => (
                    <option key={m.month} value={m.month.slice(0, 10)}>
                      {new Date(m.month).toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
                    </option>
                  ))}
                </select>
              )}
            </div>

            {loading ? (
              <div className="admin-rewards-loading" style={{ padding: '2rem 1rem' }}>
                <Loader2 size={24} className="spin-icon" />
                <span>Loading tasks…</span>
              </div>
            ) : error ? (
              <div className="admin-rewards-alert admin-rewards-alert--error">
                <AlertCircle size={16} />
                <span>{error}</span>
              </div>
            ) : (
              <TaskHistoryTable kpis={monthKpis} monthLabel={monthDisplay} />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

function isAlertError(message: string): boolean {
  return /^error|failed|cannot|must/i.test(message);
}

export default function AdminRewards() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [orgUserCount, setOrgUserCount] = useState(0);
  const [orgKpiPointsTotal, setOrgKpiPointsTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'board' | 'monthly' | 'redemptions' | 'catalog' | 'awards'>('board');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', icon: '🎁', weightage_required: 80 });
  const [iconUploading, setIconUploading] = useState(false);
  const [boardRows, setBoardRows] = useState<OrgKpiPointsRow[]>([]);
  const [selectedPerson, setSelectedPerson] = useState<PersonPointsSummary | null>(null);
  const [selectedPersonMonth, setSelectedPersonMonth] = useState<string | undefined>();
  const [monthlySearch, setMonthlySearch] = useState('');

  const showMsg = useCallback((text: string) => {
    setMsg(text);
    if (text && !isAlertError(text)) {
      setTimeout(() => setMsg(''), 5000);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    const { data: companyUsers, error: usersErr } = await supabase.rpc('get_all_users_admin');
    if (usersErr) {
      showMsg(`Error: ${usersErr.message}`);
      setLoading(false);
      return;
    }

    const orgUsers = ((companyUsers as Profile[]) || []).filter((u) => !u.is_demo);
    const allowedIds = orgUsers.map((u) => u.id);
    setOrgUserCount(allowedIds.length);

    const [catRes, ledgerRes, redemRes, boardRes] = await Promise.all([
      supabase.from('rewards_catalog').select('*').order('weightage_required'),
      allowedIds.length
        ? supabase
            .from('points_ledger')
            .select('*, users(full_name, role, is_demo)')
            .in('employee_id', allowedIds)
            .order('month', { ascending: false })
            .limit(80)
        : Promise.resolve({ data: [], error: null }),
      allowedIds.length
        ? supabase
            .from('reward_redemptions')
            .select('*, users(full_name, role, is_demo), rewards_catalog(name, icon)')
            .in('employee_id', allowedIds)
            .order('redeemed_at', { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [], error: null }),
      supabase.rpc('get_org_kpi_points_board'),
    ]);

    if (boardRes.data) {
      const rows = ((boardRes.data as OrgKpiPointsRow[]) || []).map((r) => ({
        ...r,
        health_score: Number(r.health_score) || 0,
        kpi_points: Number(r.kpi_points) || 0,
        weight_assigned: Number(r.weight_assigned) || 0,
        weight_achieved: Number(r.weight_achieved) || 0,
        total_earned: Number(r.total_earned) || 0,
        used_points: Number(r.used_points) || 0,
        balance: (Number(r.total_earned) || 0) - (Number(r.used_points) || 0),
        completed_kpis: Number(r.completed_kpis) || 0,
        total_kpis: Number(r.total_kpis) || 0,
        pending_kpis: Number(r.pending_kpis) || 0,
        this_month_points: r.this_month_points == null ? 0 : Number(r.this_month_points),
        this_month_score: r.this_month_score == null ? 0 : Number(r.this_month_score),
      }));
      setBoardRows(rows);
      const total = rows.reduce((s, r) => s + (Number(r.kpi_points) || 0), 0);
      setOrgKpiPointsTotal(Math.round(total * 100) / 100);
    } else {
      setBoardRows([]);
      setOrgKpiPointsTotal(0);
    }

    if (catRes.data) {
      setCatalog(
        (catRes.data as CatalogItem[]).map((item) => ({
          ...item,
          weightage_required: Number(item.weightage_required ?? (
            item.point_cost >= 1000 ? 90 : item.point_cost >= 500 ? 80 : item.point_cost >= 250 ? 70 : 80
          )),
          point_cost: Number(item.point_cost) || 0,
        })),
      );
    }

    if (ledgerRes.data) {
      setMonthly(
        ledgerRes.data
          .filter((r: { users?: { is_demo?: boolean } }) => !r.users?.is_demo)
          .map((r: { employee_id: string; users?: { full_name?: string; role?: string }; kpi_score: number; points_earned: number; month: string }) => ({
            employee_id: r.employee_id,
            full_name: r.users?.full_name ?? 'Unknown',
            role: r.users?.role ?? '',
            kpi_score: r.kpi_score,
            points_earned: r.points_earned,
            month: r.month,
          })),
      );
    } else {
      setMonthly([]);
    }

    if (redemRes.data) {
      setRedemptions(redemRes.data.filter((r: Redemption) => !r.users?.is_demo));
    } else {
      setRedemptions([]);
    }

    setLoading(false);
  }, [showMsg]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const startEdit = (item?: CatalogItem) => {
    if (item) {
      setEditId(item.id);
      setForm({
        name: item.name,
        description: item.description,
        icon: item.icon,
        weightage_required: Number(item.weightage_required) || 80,
      });
    } else {
      setEditId('new');
      setForm({ name: '', description: '', icon: '🎁', weightage_required: 80 });
    }
  };

  const handleIconUpload = async (file: File | null) => {
    if (!file) return;
    setIconUploading(true);
    try {
      const dataUrl = await fileToRewardIconDataUrl(file);
      setForm((prev) => ({ ...prev, icon: dataUrl }));
    } catch (err) {
      showMsg(`Error: ${err instanceof Error ? err.message : 'Could not upload image.'}`);
    } finally {
      setIconUploading(false);
    }
  };

  const saveItem = async () => {
    if (!form.name.trim()) {
      showMsg('Error: Reward name is required.');
      return;
    }
    const weightage = Number(form.weightage_required);
    if (!Number.isFinite(weightage) || weightage < 0 || weightage > 100) {
      showMsg('Error: Weightage required must be between 0 and 100.');
      return;
    }
    setMsg('');
    const payload = {
      name: form.name.trim(),
      description: form.description,
      icon: form.icon,
      weightage_required: weightage,
      // Keep legacy column in sync for older reports (not used for redeem).
      point_cost: Math.max(100, Math.round(weightage) * 10),
    };
    const { error } =
      editId === 'new'
        ? await supabase.from('rewards_catalog').insert({ ...payload })
        : await supabase.from('rewards_catalog').update({ ...payload }).eq('id', editId);
    if (error) {
      showMsg(`Error: ${error.message}`);
      return;
    }
    setEditId(null);
    showMsg('Reward catalog updated.');
    void fetchAll();
  };

  const deleteItem = async (id: string) => {
    if (!confirm('Remove this reward from the catalog permanently?')) return;
    await supabase.from('rewards_catalog').delete().eq('id', id);
    showMsg('Reward removed from catalog.');
    void fetchAll();
  };

  const toggleActive = async (item: CatalogItem) => {
    await supabase.from('rewards_catalog').update({ active: !item.active }).eq('id', item.id);
    void fetchAll();
  };

  const updateStatus = async (id: string, status: string) => {
    setMsg('');
    const { error } = await supabase.from('reward_redemptions').update({ status }).eq('id', id);
    if (error) showMsg(`Error: ${error.message}`);
    else {
      showMsg(status === 'fulfilled' ? 'Redemption marked as fulfilled.' : 'Redemption status updated.');
      void fetchAll();
    }
  };

  const runMonthlyJob = async () => {
    setRunning(true);
    setMsg('');
    const { data, error } = await supabase.rpc('calculate_monthly_points');
    if (error) {
      showMsg(`Error: ${error.message}`);
    } else {
      const awarded = ((data as { points?: number }[]) || []).filter((r) => (r.points ?? 0) > 0).length;
      showMsg(`Monthly job complete — ${awarded} team member(s) received tiered bonuses. Demo accounts excluded.`);
      void fetchAll();
    }
    setRunning(false);
  };

  const pending = redemptions.filter((r) => r.status !== 'fulfilled');
  const activeCatalog = catalog.filter((c) => c.active).length;
  const bonusesThisPeriod = monthly.filter((m) => m.points_earned > 0).length;
  const totalPointsIssued = monthly.reduce((s, m) => s + m.points_earned, 0);

  const personSummaries = useMemo(() => {
    const byPerson = new Map<string, PersonPointsSummary>();

    for (const row of boardRows) {
      if (row.role === 'admin') continue;
      byPerson.set(row.user_id, {
        employee_id: row.user_id,
        full_name: row.full_name,
        role: row.role,
        email: row.email,
        department_name: row.department_name,
        health_score: row.health_score,
        kpi_points: row.kpi_points,
        weight_assigned: row.weight_assigned ?? 0,
        weight_achieved: row.weight_achieved ?? 0,
        total_earned: row.total_earned,
        used_points: row.used_points,
        balance: row.balance,
        completed_kpis: row.completed_kpis,
        total_kpis: row.total_kpis,
        pending_kpis: row.pending_kpis,
        this_month_points: row.this_month_points ?? 0,
        this_month_score: row.this_month_score ?? 0,
        months: [],
      });
    }

    for (const m of monthly) {
      const existing = byPerson.get(m.employee_id);
      if (existing) {
        existing.months.push(m);
      }
    }

    for (const p of byPerson.values()) {
      p.months.sort((a, b) => b.month.localeCompare(a.month));
    }

    return Array.from(byPerson.values()).sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [boardRows, monthly]);

  const filteredPersons = useMemo(() => {
    const q = monthlySearch.trim().toLowerCase();
    if (!q) return personSummaries;
    return personSummaries.filter(
      (p) =>
        p.full_name.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q) ||
        (p.department_name || '').toLowerCase().includes(q) ||
        p.role.toLowerCase().includes(q),
    );
  }, [personSummaries, monthlySearch]);

  const openPersonDetail = (person: PersonPointsSummary, month?: string) => {
    setSelectedPersonMonth(month);
    setSelectedPerson(person);
  };

  if (loading && catalog.length === 0) {
    return (
      <div className="admin-rewards-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading rewards…</span>
      </div>
    );
  }

  return (
    <div className="admin-rewards-page animate-fade-in">
      <header className="admin-rewards-header glass-panel">
        <div className="admin-rewards-header__main">
          <div className="admin-rewards-header__icon">
            <Trophy size={22} />
          </div>
          <div>
            <h2 className="admin-rewards-header__title">Rewards &amp; Points</h2>
            <p className="admin-rewards-header__subtitle">
              Automatic KPI gifts, weightage-based catalog rewards, monthly score bands for analytics, and redemptions.
            </p>
          </div>
        </div>

        <div className="admin-rewards-stats">
          <div className="admin-rewards-stat admin-rewards-stat--accent">
            <Trophy size={16} />
            <span className="admin-rewards-stat__label">Performance pts</span>
            <strong>{orgKpiPointsTotal.toLocaleString()}</strong>
          </div>
          <div className="admin-rewards-stat">
            <Gift size={16} />
            <span className="admin-rewards-stat__label">Active rewards</span>
            <strong>{activeCatalog}</strong>
          </div>
          <div className="admin-rewards-stat">
            <Clock size={16} />
            <span className="admin-rewards-stat__label">Open redemptions</span>
            <strong>{pending.length}</strong>
          </div>
          <div className="admin-rewards-stat">
            <Star size={16} />
            <span className="admin-rewards-stat__label">Bonuses awarded</span>
            <strong>{bonusesThisPeriod}</strong>
          </div>
          <div className="admin-rewards-stat">
            <Coins size={16} />
            <span className="admin-rewards-stat__label">Points issued</span>
            <strong>{totalPointsIssued.toLocaleString()}</strong>
          </div>
        </div>
      </header>

      <div className="admin-rewards-tabs tab-bar tab-bar--inline-mobile">
        <button
          type="button"
          className={`tab-btn ${activeTab === 'awards' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('awards')}
        >
          <Gift size={16} /> KPI awards
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'board' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('board')}
        >
          <Users size={16} /> Team points
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'monthly' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('monthly')}
        >
          <Star size={16} /> Monthly points
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'redemptions' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('redemptions')}
        >
          <Trophy size={16} /> Redemptions
          {pending.length > 0 && <span className="admin-rewards-count-badge">{pending.length}</span>}
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'catalog' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('catalog')}
        >
          <Package size={16} /> Catalog
        </button>
      </div>

      {msg && (
        <div
          className={`admin-rewards-alert ${isAlertError(msg) ? 'admin-rewards-alert--error' : 'admin-rewards-alert--success'}`}
          role="alert"
        >
          {isAlertError(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{msg}</span>
          <button type="button" className="admin-rewards-alert__dismiss" onClick={() => setMsg('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {activeTab === 'awards' && <AdminKpiAwardsPanel />}

      {activeTab === 'board' && <AdminOrgKpiPointsBoard />}

      {activeTab === 'monthly' && (
        <section className="admin-rewards-card glass-panel">
          <div className="admin-rewards-card__head">
            <div>
              <h3><Star size={18} /> Monthly points — person by person</h3>
              <p>Each employee and manager is listed individually. Click any person to see their full points breakdown, monthly bonus history, and completed tasks.</p>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void runMonthlyJob()} disabled={running || orgUserCount === 0}>
              {running ? <Loader2 size={14} className="spin-icon" /> : <PlayCircle size={14} />}
              Run now
            </button>
          </div>

          <div className="admin-rewards-tier-hint">
            <strong>Tier rules:</strong> KPI score ≥90% → 1,000 pts · 80–89% → 500 · 70–79% → 250 · below 70% → 0.
            Applies to {orgUserCount} company employee{orgUserCount !== 1 ? 's' : ''}/manager{orgUserCount !== 1 ? 's' : ''} (demo excluded).
          </div>

          {orgUserCount === 0 ? (
            <div className="admin-rewards-empty">
              <Users size={40} strokeWidth={1.25} />
              <h4>No company employees yet</h4>
              <p>Add employees under <strong>People</strong>, then run the monthly job to award points.</p>
            </div>
          ) : personSummaries.length === 0 ? (
            <div className="admin-rewards-empty">
              <Star size={40} strokeWidth={1.25} />
              <h4>No people data yet</h4>
              <p>Click <strong>Run now</strong> to calculate this month&apos;s bonuses, or wait for the scheduled job.</p>
            </div>
          ) : (
            <>
              <div className="person-points-toolbar">
                <label className="person-points-toolbar__search">
                  <Search size={16} />
                  <input
                    type="search"
                    placeholder="Search by name, email, department, or role…"
                    value={monthlySearch}
                    onChange={(e) => setMonthlySearch(e.target.value)}
                  />
                </label>
                <span className="person-points-toolbar__count">
                  {filteredPersons.length} person{filteredPersons.length !== 1 ? 's' : ''}
                </span>
              </div>

              {filteredPersons.length === 0 ? (
                <p className="person-points-empty">No people match your search.</p>
              ) : (
                <div className="person-points-grid">
                  {filteredPersons.map((person) => {
                    const latest = person.months[0];
                    const score = latest?.kpi_score ?? person.this_month_score;
                    const bonus = latest?.points_earned ?? person.this_month_points;
                    const monthLabel = latest
                      ? new Date(latest.month).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
                      : 'Current month';

                    return (
                      <button
                        key={person.employee_id}
                        type="button"
                        className="person-points-card"
                        onClick={() => openPersonDetail(person, latest?.month)}
                      >
                        <div className="person-points-card__top">
                          <div className={`admin-user-card__avatar admin-user-card__avatar--${person.role}`}>
                            {person.full_name.slice(0, 2).toUpperCase()}
                          </div>
                          <div className="person-points-card__identity">
                            <strong>{person.full_name}</strong>
                            <span>{person.email}</span>
                            <div className="person-points-card__tags">
                              <span className={`admin-role-badge admin-role-badge--${person.role}`}>
                                {person.role}
                              </span>
                              {person.department_name && (
                                <span className="person-points-card__dept">{person.department_name}</span>
                              )}
                            </div>
                          </div>
                          <ChevronRight size={18} className="person-points-card__arrow" />
                        </div>

                        <div className="person-points-card__stats">
                          <div className="person-points-card__stat">
                            <span>Weightage</span>
                            <strong>
                              {(person.weight_assigned || 0).toFixed((person.weight_assigned || 0) % 1 === 0 ? 0 : 2)}%
                            </strong>
                          </div>
                          <div className="person-points-card__stat">
                            <span>{monthLabel} KPI</span>
                            <strong style={{ color: tierColorForScore(score) }}>{Math.round(score)}</strong>
                          </div>
                          <div className="person-points-card__stat">
                            <span>Month bonus</span>
                            <strong style={{ color: bonus ? 'var(--color-success)' : 'var(--text-muted)' }}>
                              +{bonus.toLocaleString()}
                            </strong>
                          </div>
                          <div className="person-points-card__stat">
                            <span>Balance</span>
                            <strong>{person.balance.toLocaleString()}</strong>
                          </div>
                        </div>

                        <div className="person-points-card__footer">
                          <span><Target size={13} /> {person.completed_kpis}/{person.total_kpis} tasks done</span>
                          <span className="person-points-card__cta">
                            <Eye size={13} /> View full details
                          </span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {selectedPerson && (
        <PersonPointsDetailModal
          person={selectedPerson}
          initialMonth={selectedPersonMonth}
          onClose={() => {
            setSelectedPerson(null);
            setSelectedPersonMonth(undefined);
          }}
        />
      )}

      {activeTab === 'redemptions' && (
        <section className="admin-rewards-card glass-panel">
          <h3>
            <Trophy size={18} /> Redemption queue
            {pending.length > 0 && <span className="admin-rewards-count-badge">{pending.length} open</span>}
          </h3>
          <p>Managers fulfill their team first. Use this queue for org-wide approval and fulfillment.</p>

          <div className="admin-rewards-info" style={{ marginBottom: '1rem' }}>
            <Info size={16} />
            <span>Only redemptions from your company employees are listed. Demo sandbox redemptions are not shown.</span>
          </div>

          {pending.length === 0 ? (
            <div className="admin-rewards-empty">
              <CheckCircle2 size={40} strokeWidth={1.25} />
              <h4>All caught up</h4>
              <p>No pending redemptions — everything has been fulfilled.</p>
            </div>
          ) : (
            <div className="admin-rewards-redemption-list">
              {pending.map((r) => (
                <div key={r.id} className={`redemption-row redemption-row--${r.status}`}>
                  <span className="redemption-icon">
                    <RewardCatalogIcon icon={r.rewards_catalog?.icon ?? '🎁'} size={22} />
                  </span>
                  <div className="redemption-info">
                    <strong>{r.users?.full_name}</strong>
                    <span>
                      {r.rewards_catalog?.name} · {new Date(r.redeemed_at).toLocaleDateString()}
                    </span>
                  </div>
                  <span className="redemption-pts">
                    {r.weightage_at_claim != null
                      ? `${Number(r.weightage_at_claim)}% weightage`
                      : r.points_used > 0
                        ? `-${r.points_used.toLocaleString()} pts`
                        : 'Catalog'}
                  </span>
                  <div className="redemption-actions">
                    {r.status === 'pending' && (
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void updateStatus(r.id, 'approved')}>
                        Approve
                      </button>
                    )}
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => void updateStatus(r.id, 'fulfilled')}>
                      <CheckCircle2 size={12} /> Fulfil
                    </button>
                    <span className={`redemption-status redemption-status--${r.status}`}>{r.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}

          {redemptions.filter((r) => r.status === 'fulfilled').length > 0 && (
            <>
              <h4 style={{ margin: '1.25rem 0 0.65rem', fontSize: '0.85rem', color: 'var(--text-muted)' }}>Recently fulfilled</h4>
              <div className="admin-rewards-table-wrap">
                <table className="admin-rewards-table">
                  <thead>
                    <tr>
                      <th>Employee</th>
                      <th>Reward</th>
                      <th>At claim</th>
                      <th>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {redemptions
                      .filter((r) => r.status === 'fulfilled')
                      .slice(0, 10)
                      .map((r) => (
                        <tr key={r.id}>
                          <td><strong>{r.users?.full_name}</strong></td>
                          <td>
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem' }}>
                              <RewardCatalogIcon icon={r.rewards_catalog?.icon} size={18} />
                              {r.rewards_catalog?.name}
                            </span>
                          </td>
                          <td>
                            {r.weightage_at_claim != null
                              ? `${Number(r.weightage_at_claim)}%`
                              : r.points_used > 0
                                ? `-${r.points_used.toLocaleString()}`
                                : '—'}
                          </td>
                          <td>{new Date(r.redeemed_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}

      {activeTab === 'catalog' && (
        <section className="admin-rewards-card glass-panel">
          <div className="admin-rewards-card__head">
            <div>
              <h3><Gift size={18} /> Reward catalog</h3>
              <p>Staff redeem these when their this-month weightage meets the requirement. Hide items temporarily or remove them permanently.</p>
            </div>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => startEdit()}>
              <Plus size={14} /> Add reward
            </button>
          </div>

          {editId && (
            <div className="admin-rewards-catalog-form">
              <p className="assign-task-form__section-title" style={{ margin: 0 }}>
                {editId === 'new' ? 'New reward' : 'Edit reward'}
              </p>
              <div className="admin-rewards-catalog-form__icon-block">
                <div className="admin-rewards-catalog-form__preview" aria-hidden>
                  <RewardCatalogIcon icon={form.icon} size={40} />
                </div>
                <div className="admin-rewards-catalog-form__icon-controls">
                  <label className="admin-rewards-catalog-form__upload btn btn-secondary btn-sm">
                    {iconUploading ? <Loader2 size={14} className="spin-icon" /> : <Upload size={14} />}
                    {iconUploading ? 'Uploading…' : 'Upload image'}
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,image/gif"
                      hidden
                      disabled={iconUploading}
                      onChange={(e) => {
                        const file = e.target.files?.[0] || null;
                        e.target.value = '';
                        void handleIconUpload(file);
                      }}
                    />
                  </label>
                  <p className="admin-rewards-catalog-form__hint">
                    PNG, JPG, or WebP. Or pick an emoji below.
                  </p>
                  <div className="admin-rewards-catalog-form__emoji-row" role="group" aria-label="Emoji icons">
                    {REWARD_EMOJI_PRESETS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className={`admin-rewards-catalog-form__emoji${form.icon === emoji ? ' is-on' : ''}`}
                        onClick={() => setForm({ ...form, icon: emoji })}
                        title={`Use ${emoji}`}
                      >
                        {emoji}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="admin-rewards-catalog-form__row">
                <div className="form-group" style={{ flex: 1, margin: 0, minWidth: 160 }}>
                  <label>Name</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Team dinner" />
                </div>
                <div className="form-group" style={{ flex: '0 0 140px', margin: 0 }}>
                  <label>Weightage required %</label>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={1}
                    value={form.weightage_required}
                    onChange={(e) => setForm({ ...form, weightage_required: Number(e.target.value) })}
                  />
                </div>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Description</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the employee receives" />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveItem()} disabled={iconUploading}>
                  Save to database
                </button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditId(null)}>Cancel</button>
              </div>
            </div>
          )}

          {catalog.length === 0 ? (
            <div className="admin-rewards-empty">
              <Gift size={40} strokeWidth={1.25} />
              <h4>No rewards in catalog</h4>
              <p>Add your first reward so staff can redeem with weightage.</p>
            </div>
          ) : (
            <div className="reward-catalog-grid">
              {catalog.map((item) => (
                <div key={item.id} className={`reward-card ${item.active ? 'reward-card--unlocked' : ''}`} style={{ opacity: item.active ? 1 : 0.55 }}>
                  <div className="reward-card-icon">
                    <RewardCatalogIcon icon={item.icon} size={36} />
                  </div>
                  <h4>{item.name}</h4>
                  <p>{item.description}</p>
                  <div className="reward-card-footer">
                    <span className="reward-card-cost">
                      {Number(item.weightage_required) || 0}% weightage
                    </span>
                    <div style={{ display: 'flex', gap: '0.3rem', flexWrap: 'wrap' }}>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void toggleActive(item)}>
                        {item.active ? 'Hide' : 'Show'}
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => startEdit(item)} aria-label="Edit">
                        <Edit2 size={12} />
                      </button>
                      <button type="button" className="btn btn-secondary btn-sm" style={{ color: 'var(--color-danger)' }} onClick={() => void deleteItem(item.id)} aria-label="Delete">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
