import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { PlatformCompanyRow, PlatformNotification, isPlatformOwner } from '../utils/companyHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import Login from './Login';
import {
  Shield, Building2, Bell, CheckCircle, XCircle, Loader2, LogOut, Users, Clock, Trash2,
} from 'lucide-react';

interface PlatformOwnerPortalProps {
  onExit?: () => void;
}

export default function PlatformOwnerPortal({ onExit }: PlatformOwnerPortalProps) {
  const [session, setSession] = useState<{ user: { id: string } } | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [companies, setCompanies] = useState<PlatformCompanyRow[]>([]);
  const [notifications, setNotifications] = useState<PlatformNotification[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [msg, setMsg] = useState('');

  const loadProfile = async (userId: string) => {
    const { data, error } = await supabase.from('users').select('*').eq('id', userId).single();
    if (error || !data || !isPlatformOwner(data)) {
      setProfile(null);
      return false;
    }
    setProfile(data);
    return true;
  };

  const loadData = async () => {
    const [co, no] = await Promise.all([
      supabase.rpc('platform_get_companies'),
      supabase.rpc('platform_get_notifications'),
    ]);
    if (!co.error) setCompanies((co.data || []) as PlatformCompanyRow[]);
    if (!no.error) setNotifications((no.data || []) as PlatformNotification[]);
  };

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session: s } }) => {
      setSession(s);
      if (s?.user) {
        const ok = await loadProfile(s.user.id);
        if (ok) await loadData();
      }
      setLoading(false);
    });
  }, []);

  useSupabaseRealtime(
    'platform-companies-sync',
    [{ table: 'companies' }, { table: 'platform_owner_notifications' }],
    () => { void loadData(); },
    Boolean(session && profile),
  );

  const handleLogin = async (s: { user: { id: string } }) => {
    setLoading(true);
    setSession(s);
    const ok = await loadProfile(s.user.id);
    if (!ok) {
      await supabase.auth.signOut();
      setSession(null);
      setMsg('This console is only for the platform owner (Samiya Kayani).');
    } else {
      await loadData();
      setMsg('');
    }
    setLoading(false);
  };

  const handleLogout = async () => {
    await supabase.auth.signOut();
    setSession(null);
    setProfile(null);
    setCompanies([]);
    setNotifications([]);
  };

  const approve = async (id: string) => {
    setActionLoading(id);
    const { error } = await supabase.rpc('platform_approve_company', { p_company_id: id });
    if (error) setMsg(error.message);
    else {
      setMsg('Company approved.');
      await loadData();
    }
    setActionLoading(null);
  };

  const reject = async (id: string) => {
    const reason = prompt('Optional reason for rejection:') || undefined;
    setActionLoading(id);
    const { error } = await supabase.rpc('platform_reject_company', { p_company_id: id, p_reason: reason ?? null });
    if (error) setMsg(error.message);
    else {
      setMsg('Company rejected.');
      await loadData();
    }
    setActionLoading(null);
  };

  const removeCompany = async (c: PlatformCompanyRow) => {
    const label = c.name || c.contact_email || 'this company';
    if (!confirm(`Permanently delete "${label}"?\n\nThis removes all users, KPIs, departments, and data for this company. This cannot be undone.`)) {
      return;
    }
    setActionLoading(c.id);
    setMsg('');
    const { error } = await supabase.rpc('platform_delete_company', { p_company_id: c.id });
    if (error) setMsg(error.message);
    else {
      setMsg(`Company "${label}" deleted.`);
      await loadData();
    }
    setActionLoading(null);
  };

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Loader2 className="animate-spin" size={32} />
      </div>
    );
  }

  if (!session || !profile) {
    return (
      <div className="platform-portal">
        <div className="platform-portal__header">
          <Shield size={24} />
          <span>Scorr Platform Console</span>
        </div>
        <p className="platform-portal__subtitle">
          Owner access only — Samiya Kayani. Separate from company login.
        </p>
        {msg && <p style={{ color: 'var(--color-danger)', textAlign: 'center', marginBottom: '1rem' }}>{msg}</p>}
        <div style={{ maxWidth: 400, margin: '0 auto' }}>
          <Login onLoginSuccess={handleLogin} title="Platform Owner Sign In" showDemoShortcuts={false} embedded />
        </div>
        {onExit && (
          <p style={{ textAlign: 'center', marginTop: '2rem' }}>
            <a href="/" style={{ color: 'var(--text-muted)', fontSize: '0.9rem' }}>← Back to Scorr website</a>
          </p>
        )}
      </div>
    );
  }

  const pending = companies.filter((c) => c.status === 'pending');
  const active = companies.filter((c) => c.status === 'active');
  const rejected = companies.filter((c) => c.status === 'rejected');
  const suspended = companies.filter((c) => c.status === 'suspended');
  const unread = notifications.filter((n) => !n.read);

  return (
    <div className="platform-portal">
      <header className="platform-portal__header platform-portal__header--bar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <Shield size={22} />
          <div>
            <strong>Scorr Platform Console</strong>
            <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{profile.full_name || profile.email}</div>
          </div>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={handleLogout}>
          <LogOut size={14} /> Sign out
        </button>
      </header>

      {msg && (
        <div className="glass-panel" style={{ padding: '0.75rem 1rem', marginBottom: '1rem', color: 'var(--color-success)' }}>
          {msg}
        </div>
      )}

      <div className="platform-portal__stats">
        <div className="glass-panel platform-stat">
          <Building2 size={20} style={{ color: 'var(--accent-primary)' }} />
          <div><strong>{companies.length}</strong><span>Total registered</span></div>
        </div>
        <div className="glass-panel platform-stat">
          <Clock size={20} style={{ color: 'var(--color-warning)' }} />
          <div><strong>{pending.length}</strong><span>Pending approval</span></div>
        </div>
        <div className="glass-panel platform-stat">
          <CheckCircle size={20} style={{ color: 'var(--color-success)' }} />
          <div><strong>{active.length}</strong><span>Active</span></div>
        </div>
        <div className="glass-panel platform-stat">
          <Bell size={20} style={{ color: 'var(--color-danger)' }} />
          <div><strong>{unread.length}</strong><span>Unread alerts</span></div>
        </div>
      </div>

      {unread.length > 0 && (
        <section className="glass-panel" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
            <Bell size={18} /> Registration notifications
          </h3>
          {unread.map((n) => (
            <div key={n.id} style={{ padding: '0.75rem 0', borderBottom: '1px solid var(--border-subtle)' }}>
              <strong>{n.title}</strong>
              <p style={{ margin: '0.25rem 0 0', color: 'var(--text-secondary)', fontSize: '0.9rem' }}>{n.message}</p>
            </div>
          ))}
        </section>
      )}

      <section className="glass-panel" style={{ padding: '1.25rem', marginBottom: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>Pending companies</h3>
        {pending.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No pending registrations.</p>
        ) : (
          pending.map((c) => (
            <div key={c.id} className="platform-company-row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '1rem' }}>
                <div>
                  <strong>{c.name}</strong>
                  <span className={`status-pill status-pill--${c.status}`} style={{ marginLeft: '0.5rem' }}>{c.status}</span>
                  <div className="platform-reg-detail">
                    <div><strong>Contact:</strong> {c.contact_name}{c.job_title ? ` · ${c.job_title}` : ''}</div>
                    <div><strong>Email:</strong> {c.contact_email}{c.contact_phone ? ` · ${c.contact_phone}` : ''}</div>
                    <div><strong>Plan:</strong> {c.subscription_plan || 'trial'}{c.industry ? ` · ${c.industry}` : ''}{c.employee_count ? ` · ${c.employee_count} employees` : ''}</div>
                    {(c.city || c.country) && <div><strong>Location:</strong> {[c.city, c.country].filter(Boolean).join(', ')}</div>}
                    {c.website && <div><strong>Website:</strong> {c.website}</div>}
                    {c.registration_notes && <div><strong>Notes:</strong> {c.registration_notes}</div>}
                    <div style={{ color: 'var(--text-muted)' }}>Registered {new Date(c.created_at).toLocaleString()}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', alignSelf: 'flex-start', flexWrap: 'wrap' }}>
                  <button type="button" className="btn btn-primary btn-sm" disabled={actionLoading === c.id} onClick={() => approve(c.id)}>
                    {actionLoading === c.id ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                    Approve
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" disabled={actionLoading === c.id} onClick={() => reject(c.id)}>
                    <XCircle size={14} /> Reject
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm platform-btn-delete"
                    disabled={actionLoading === c.id}
                    onClick={() => removeCompany(c)}
                    title="Delete company permanently"
                  >
                    <Trash2 size={14} /> Delete
                  </button>
                </div>
              </div>
            </div>
          ))
        )}
      </section>

      <section className="glass-panel" style={{ padding: '1.25rem' }}>
        <h3 style={{ marginBottom: '0.35rem' }}>All registered companies ({companies.length})</h3>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '1rem' }}>
          Every company registration appears here — pending, active, rejected, and suspended.
          Demo sandbox accounts are not companies and are not listed.
          {(rejected.length > 0 || suspended.length > 0) && (
            <> · {rejected.length} rejected · {suspended.length} suspended</>
          )}
        </p>
        {companies.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No company registrations yet.</p>
        ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Company</th>
                <th>Registered</th>
                <th>Plan</th>
                <th>Phone</th>
                <th>Status</th>
                <th>Owner</th>
                <th>Users</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((c) => (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong><br /><span style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{c.contact_email}</span></td>
                  <td style={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{new Date(c.created_at).toLocaleDateString()}</td>
                  <td>{c.subscription_plan || '—'}</td>
                  <td>{c.contact_phone || '—'}</td>
                  <td><span className={`status-pill status-pill--${c.status}`}>{c.status}</span></td>
                  <td>{c.owner_name || '—'}<br /><span style={{ fontSize: '0.8rem' }}>{c.owner_email}</span></td>
                  <td><Users size={14} style={{ verticalAlign: 'middle' }} /> {c.user_count}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '0.35rem', flexWrap: 'wrap' }}>
                      {c.status === 'pending' && (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" disabled={actionLoading === c.id} onClick={() => approve(c.id)} title="Approve">
                            <CheckCircle size={14} />
                          </button>
                          <button type="button" className="btn btn-secondary btn-sm" disabled={actionLoading === c.id} onClick={() => reject(c.id)} title="Reject">
                            <XCircle size={14} />
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm platform-btn-delete"
                        disabled={actionLoading === c.id}
                        onClick={() => removeCompany(c)}
                        title="Delete company"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>
    </div>
  );
}
