import { useState, useEffect, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
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
} from 'lucide-react';
import { tierColorForScore } from '../utils/rewardsTiers';
import '../styles/admin-rewards.css';

interface CatalogItem {
  id: string;
  name: string;
  description: string;
  icon: string;
  point_cost: number;
  active: boolean;
}

interface MonthlyRow {
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
  status: string;
  redeemed_at: string;
  users?: { full_name: string; role: string; is_demo?: boolean };
  rewards_catalog?: { name: string; icon: string };
}

function isAlertError(message: string): boolean {
  return /^error|failed|cannot|must/i.test(message);
}

export default function AdminRewards() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [orgUserCount, setOrgUserCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'monthly' | 'redemptions' | 'catalog'>('monthly');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', icon: '🎁', point_cost: 1000 });

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

    const [catRes, ledgerRes, redemRes] = await Promise.all([
      supabase.from('rewards_catalog').select('*').order('point_cost'),
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
    ]);

    if (catRes.data) setCatalog(catRes.data);

    if (ledgerRes.data) {
      setMonthly(
        ledgerRes.data
          .filter((r: { users?: { is_demo?: boolean } }) => !r.users?.is_demo)
          .map((r: { users?: { full_name?: string; role?: string }; kpi_score: number; points_earned: number; month: string }) => ({
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
      setForm({ name: item.name, description: item.description, icon: item.icon, point_cost: item.point_cost });
    } else {
      setEditId('new');
      setForm({ name: '', description: '', icon: '🎁', point_cost: 1000 });
    }
  };

  const saveItem = async () => {
    if (!form.name.trim()) {
      showMsg('Error: Reward name is required.');
      return;
    }
    setMsg('');
    const { error } =
      editId === 'new'
        ? await supabase.from('rewards_catalog').insert({ ...form })
        : await supabase.from('rewards_catalog').update({ ...form }).eq('id', editId);
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

  if (loading) {
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
              Manage your company reward catalog, run monthly KPI bonuses, and fulfill redemptions. Only your
              organization&apos;s employees are shown — demo sandbox accounts are hidden.
            </p>
          </div>
        </div>

        <div className="admin-rewards-stats">
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

      {activeTab === 'monthly' && (
        <section className="admin-rewards-card glass-panel">
          <div className="admin-rewards-card__head">
            <div>
              <h3><Star size={18} /> Monthly points engine</h3>
              <p>Automatic tiered bonuses from KPI scores. Points never expire.</p>
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
              <p>Add employees under <strong>Users</strong>, then run the monthly job to award points.</p>
            </div>
          ) : monthly.length === 0 ? (
            <div className="admin-rewards-empty">
              <Star size={40} strokeWidth={1.25} />
              <h4>No monthly data yet</h4>
              <p>Click <strong>Run now</strong> to calculate this month&apos;s bonuses, or wait for the scheduled job.</p>
            </div>
          ) : (
            <div className="admin-rewards-table-wrap">
              <table className="admin-rewards-table">
                <thead>
                  <tr>
                    <th>Employee</th>
                    <th>Role</th>
                    <th>Month</th>
                    <th>KPI score</th>
                    <th>Points</th>
                  </tr>
                </thead>
                <tbody>
                  {monthly.map((r, i) => (
                    <tr key={`${r.full_name}-${r.month}-${i}`}>
                      <td><strong>{r.full_name}</strong></td>
                      <td>
                        <span className="badge badge-on-track" style={{ fontSize: '0.6rem' }}>{r.role}</span>
                      </td>
                      <td>{new Date(r.month).toLocaleDateString(undefined, { month: 'short', year: 'numeric' })}</td>
                      <td style={{ color: tierColorForScore(r.kpi_score), fontWeight: 600 }}>{Math.round(r.kpi_score)}%</td>
                      <td style={{ fontWeight: 700, color: r.points_earned ? 'var(--color-success)' : 'var(--text-muted)' }}>
                        {r.points_earned ? `+${r.points_earned.toLocaleString()}` : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
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
                  <span className="redemption-icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                  <div className="redemption-info">
                    <strong>{r.users?.full_name}</strong>
                    <span>
                      {r.rewards_catalog?.name} · {new Date(r.redeemed_at).toLocaleDateString()}
                    </span>
                  </div>
                  <span className="redemption-pts">-{r.points_used.toLocaleString()} pts</span>
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
                      <th>Points</th>
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
                          <td>{r.rewards_catalog?.icon} {r.rewards_catalog?.name}</td>
                          <td>-{r.points_used.toLocaleString()}</td>
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
              <p>Employees redeem points for these rewards. Hide items temporarily or remove them permanently.</p>
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
              <div className="admin-rewards-catalog-form__row">
                <div className="form-group" style={{ flex: '0 0 64px', margin: 0 }}>
                  <label>Icon</label>
                  <input value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} style={{ fontSize: '1.2rem', textAlign: 'center' }} />
                </div>
                <div className="form-group" style={{ flex: 1, margin: 0, minWidth: 160 }}>
                  <label>Name</label>
                  <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Team dinner" />
                </div>
                <div className="form-group" style={{ flex: '0 0 120px', margin: 0 }}>
                  <label>Point cost</label>
                  <input type="number" min={100} step={100} value={form.point_cost} onChange={(e) => setForm({ ...form, point_cost: Number(e.target.value) })} />
                </div>
              </div>
              <div className="form-group" style={{ margin: 0 }}>
                <label>Description</label>
                <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What the employee receives" />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => void saveItem()}>Save to database</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditId(null)}>Cancel</button>
              </div>
            </div>
          )}

          {catalog.length === 0 ? (
            <div className="admin-rewards-empty">
              <Gift size={40} strokeWidth={1.25} />
              <h4>No rewards in catalog</h4>
              <p>Add your first reward so employees can redeem their points.</p>
            </div>
          ) : (
            <div className="reward-catalog-grid">
              {catalog.map((item) => (
                <div key={item.id} className={`reward-card ${item.active ? 'reward-card--unlocked' : ''}`} style={{ opacity: item.active ? 1 : 0.55 }}>
                  <div className="reward-card-icon">{item.icon}</div>
                  <h4>{item.name}</h4>
                  <p>{item.description}</p>
                  <div className="reward-card-footer">
                    <span className="reward-card-cost">{item.point_cost.toLocaleString()} pts</span>
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
