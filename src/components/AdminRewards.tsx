import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Gift, Plus, Trash2, Edit2, Loader2, CheckCircle, Trophy, Star, PlayCircle } from 'lucide-react';
import RewardsWorkflowBanner from './RewardsWorkflowBanner';

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
  users?: { full_name: string; role: string };
  rewards_catalog?: { name: string; icon: string };
}

export default function AdminRewards() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [monthly, setMonthly] = useState<MonthlyRow[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', icon: '🎁', point_cost: 1000 });

  useEffect(() => { fetchAll(); }, []);

  const fetchAll = async () => {
    setLoading(true);
    const [catRes, ledgerRes, redemRes] = await Promise.all([
      supabase.from('rewards_catalog').select('*').order('point_cost'),
      supabase.from('points_ledger').select('*, users(full_name, role)').order('month', { ascending: false }).limit(60),
      supabase.from('reward_redemptions').select('*, users(full_name, role), rewards_catalog(name, icon)').order('redeemed_at', { ascending: false }).limit(40),
    ]);
    if (catRes.data) setCatalog(catRes.data);
    if (ledgerRes.data) {
      setMonthly(ledgerRes.data.map((r: any) => ({
        full_name: r.users?.full_name ?? 'Unknown',
        role: r.users?.role ?? '',
        kpi_score: r.kpi_score,
        points_earned: r.points_earned,
        month: r.month,
      })));
    }
    if (redemRes.data) setRedemptions(redemRes.data);
    setLoading(false);
  };

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
    if (!form.name.trim()) return;
    setMsg('');
    const { error } = editId === 'new'
      ? await supabase.from('rewards_catalog').insert({ ...form })
      : await supabase.from('rewards_catalog').update({ ...form }).eq('id', editId);
    if (error) { setMsg('Error: ' + error.message); return; }
    setEditId(null);
    fetchAll();
  };

  const deleteItem = async (id: string) => {
    if (!confirm('Remove this reward from the catalog?')) return;
    await supabase.from('rewards_catalog').delete().eq('id', id);
    fetchAll();
  };

  const toggleActive = async (item: CatalogItem) => {
    await supabase.from('rewards_catalog').update({ active: !item.active }).eq('id', item.id);
    fetchAll();
  };

  const updateStatus = async (id: string, status: string) => {
    setMsg('');
    const { error } = await supabase.from('reward_redemptions').update({ status }).eq('id', id);
    if (error) setMsg('Error: ' + error.message);
    else {
      setMsg(status === 'fulfilled' ? '✅ Marked as fulfilled.' : '✅ Status updated.');
      fetchAll();
    }
  };

  const runMonthlyJob = async () => {
    setRunning(true);
    setMsg('');
    const { data, error } = await supabase.rpc('calculate_monthly_points');
    if (error) {
      setMsg('Error: ' + error.message);
    } else {
      const awarded = (data as any[]).filter((r) => r.points > 0).length;
      setMsg(`✅ Monthly job complete — ${awarded} employee(s) & manager(s) awarded 500 pts.`);
      fetchAll();
    }
    setRunning(false);
  };

  const pending = redemptions.filter((r) => r.status !== 'fulfilled');

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  return (
    <div className="rewards-page animate-fade-in">
      <RewardsWorkflowBanner variant="admin" />

      {msg && (
        <div className={`rewards-toast ${msg.startsWith('Error') ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="rewards-stats-grid">
        <div className="stat-card stat-card--accent">
          <Gift size={20} />
          <div>
            <div className="stat-card-value">{catalog.filter((c) => c.active).length}</div>
            <div className="stat-card-label">Active Rewards</div>
          </div>
        </div>
        <div className="stat-card stat-card--warning">
          <Trophy size={20} />
          <div>
            <div className="stat-card-value">{pending.length}</div>
            <div className="stat-card-label">Open Redemptions</div>
          </div>
        </div>
        <div className="stat-card stat-card--gold">
          <Star size={20} />
          <div>
            <div className="stat-card-value">{monthly.filter((m) => m.points_earned > 0).length}</div>
            <div className="stat-card-label">Bonuses This Period</div>
          </div>
        </div>
      </div>

      {/* Monthly job */}
      <div className="glass-panel rewards-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
          <div>
            <h3 className="rewards-section-title" style={{ marginBottom: '0.25rem' }}>
              <Star size={20} /> Monthly Points Engine
            </h3>
            <p className="rewards-section-desc" style={{ margin: 0 }}>
              Auto-awards +500 pts to every employee &amp; manager with KPI score ≥ 90%. Runs on the last day of each month.
            </p>
          </div>
          <button className="btn btn-primary btn-sm" onClick={runMonthlyJob} disabled={running}>
            {running ? <Loader2 size={14} className="spin-icon" /> : <PlayCircle size={14} />}
            Run Now
          </button>
        </div>
        {monthly.length === 0 ? (
          <div className="rewards-empty">No monthly data yet. Click Run Now or wait for end-of-month schedule.</div>
        ) : (
          <div className="team-points-table-wrap">
            <table className="team-points-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Role</th>
                  <th>Month</th>
                  <th>KPI</th>
                  <th>Points</th>
                </tr>
              </thead>
              <tbody>
                {monthly.map((r, i) => (
                  <tr key={i}>
                    <td><strong>{r.full_name}</strong></td>
                    <td><span className="badge badge-on-track" style={{ fontSize: '0.6rem' }}>{r.role}</span></td>
                    <td>{new Date(r.month).toLocaleDateString('default', { month: 'short', year: 'numeric' })}</td>
                    <td style={{ color: r.kpi_score >= 90 ? 'var(--color-success)' : 'var(--text-secondary)' }}>{Math.round(r.kpi_score)}%</td>
                    <td style={{ fontWeight: 700, color: r.points_earned ? 'var(--color-success)' : 'var(--text-muted)' }}>
                      {r.points_earned ? `+${r.points_earned}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Org-wide redemption queue (admin override) */}
      <div className="glass-panel rewards-section">
        <h3 className="rewards-section-title">
          <Trophy size={20} /> Org-Wide Redemption Queue
          <span className="rewards-badge">{pending.length} open</span>
        </h3>
        <p className="rewards-section-desc">
          Managers approve &amp; fulfill their direct reports first. Use this queue to override or handle escalations org-wide.
        </p>
        {pending.length === 0 ? (
          <div className="rewards-empty">All redemptions fulfilled — nothing pending.</div>
        ) : (
          <div className="redemption-list">
            {pending.map((r) => (
              <div key={r.id} className={`redemption-row redemption-row--${r.status}`}>
                <span className="redemption-icon">{r.rewards_catalog?.icon ?? '🎁'}</span>
                <div className="redemption-info">
                  <strong>{r.users?.full_name}</strong>
                  <span>{r.rewards_catalog?.name} · {new Date(r.redeemed_at).toLocaleDateString()}</span>
                </div>
                <span className="redemption-pts">-{r.points_used} pts</span>
                <div className="redemption-actions">
                  {r.status === 'pending' && (
                    <button className="btn btn-secondary btn-sm" onClick={() => updateStatus(r.id, 'approved')}>Approve</button>
                  )}
                  <button className="btn btn-primary btn-sm" onClick={() => updateStatus(r.id, 'fulfilled')}>
                    <CheckCircle size={12} /> Fulfil
                  </button>
                  <span className={`redemption-status redemption-status--${r.status}`}>{r.status}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Catalog */}
      <div className="glass-panel rewards-section">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <h3 className="rewards-section-title" style={{ margin: 0 }}>
            <Gift size={20} /> Reward Catalog
          </h3>
          <button className="btn btn-primary btn-sm" onClick={() => startEdit()}>
            <Plus size={14} /> Add Reward
          </button>
        </div>

        {editId && (
          <div style={{ padding: '1rem', border: '1px solid var(--border-hover)', borderRadius: 'var(--border-radius-sm)', marginBottom: '1rem', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
              <div className="form-group" style={{ flex: '0 0 60px', margin: 0 }}>
                <label>Icon</label>
                <input value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} style={{ fontSize: '1.2rem', textAlign: 'center' }} />
              </div>
              <div className="form-group" style={{ flex: 1, margin: 0, minWidth: 150 }}>
                <label>Name</label>
                <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Reward name" />
              </div>
              <div className="form-group" style={{ flex: '0 0 110px', margin: 0 }}>
                <label>Point Cost</label>
                <input type="number" min={100} step={100} value={form.point_cost} onChange={(e) => setForm({ ...form, point_cost: Number(e.target.value) })} />
              </div>
            </div>
            <div className="form-group" style={{ margin: 0 }}>
              <label>Description</label>
              <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="Short description" />
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button className="btn btn-primary btn-sm" onClick={saveItem}>Save</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setEditId(null)}>Cancel</button>
            </div>
          </div>
        )}

        <div className="reward-catalog-grid">
          {catalog.map((item) => (
            <div key={item.id} className={`reward-card ${item.active ? 'reward-card--unlocked' : ''}`} style={{ opacity: item.active ? 1 : 0.55 }}>
              <div className="reward-card-icon">{item.icon}</div>
              <h4>{item.name}</h4>
              <p>{item.description}</p>
              <div className="reward-card-footer">
                <span className="reward-card-cost">{item.point_cost.toLocaleString()} pts</span>
                <div style={{ display: 'flex', gap: '0.3rem' }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => toggleActive(item)}>{item.active ? 'Hide' : 'Show'}</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => startEdit(item)}><Edit2 size={12} /></button>
                  <button className="btn btn-secondary btn-sm" style={{ color: 'var(--color-danger)' }} onClick={() => deleteItem(item.id)}><Trash2 size={12} /></button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
