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
  AlertCircle,
  Info,
  Clock,
  Package,
  Users,
  Upload,
  History,
} from 'lucide-react';
import AdminOrgKpiPointsBoard from './AdminOrgKpiPointsBoard';
import AdminKpiAwardsPanel from './AdminKpiAwardsPanel';
import AdminRewardHistoryPanel from './AdminRewardHistoryPanel';
import RewardCatalogIcon from './RewardCatalogIcon';
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

function isAlertError(message: string): boolean {
  return /^error|failed|cannot|must/i.test(message);
}

export default function AdminRewards() {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [redemptions, setRedemptions] = useState<Redemption[]>([]);
  const [orgUserCount, setOrgUserCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const [activeTab, setActiveTab] = useState<'board' | 'redemptions' | 'catalog' | 'awards' | 'history'>('awards');
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', description: '', icon: '🎁', weightage_required: 80 });
  const [iconUploading, setIconUploading] = useState(false);

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

    const [catRes, redemRes] = await Promise.all([
      supabase.from('rewards_catalog').select('*').order('weightage_required'),
      allowedIds.length
        ? supabase
            .from('reward_redemptions')
            .select('*, users(full_name, role, is_demo), rewards_catalog(name, icon)')
            .in('employee_id', allowedIds)
            .order('redeemed_at', { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [], error: null }),
    ]);

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
    const { error } = await supabase.rpc('set_catalog_redemption_status', {
      p_id: id,
      p_status: status,
    });
    if (error) showMsg(`Error: ${error.message}`);
    else {
      showMsg(
        status === 'fulfilled'
          ? 'Redemption fulfilled — gift weightage deducted from this month.'
          : 'Redemption status updated.',
      );
      void fetchAll();
    }
  };

  const pending = redemptions.filter((r) => r.status !== 'fulfilled');
  const activeCatalog = catalog.filter((c) => c.active).length;

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
            <h2 className="admin-rewards-header__title">Rewards</h2>
            <p className="admin-rewards-header__subtitle">
              One monthly gift per person (dinner or catalog). Movie and surprise can be redeemed in the same month as a monthly gift. Only monthly gifts deduct available weightage when fulfilled.
            </p>
          </div>
        </div>

        <div className="admin-rewards-stats">
          <div className="admin-rewards-stat">
            <Gift size={16} />
            <span className="admin-rewards-stat__label">Active catalog</span>
            <strong>{activeCatalog}</strong>
          </div>
          <div className="admin-rewards-stat">
            <Clock size={16} />
            <span className="admin-rewards-stat__label">Open redemptions</span>
            <strong>{pending.length}</strong>
          </div>
          <div className="admin-rewards-stat admin-rewards-stat--accent">
            <Users size={16} />
            <span className="admin-rewards-stat__label">People</span>
            <strong>{orgUserCount.toLocaleString()}</strong>
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
          className={`tab-btn ${activeTab === 'history' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          <History size={16} /> History
        </button>
        <button
          type="button"
          className={`tab-btn ${activeTab === 'board' ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab('board')}
        >
          <Users size={16} /> People
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

      {activeTab === 'history' && <AdminRewardHistoryPanel />}

      {activeTab === 'board' && <AdminOrgKpiPointsBoard embedded />}

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
