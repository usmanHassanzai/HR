import { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { PlatformCompanyRow, PlatformNotification } from '../utils/companyHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import {
  Shield,
  Building2,
  Bell,
  CheckCircle,
  XCircle,
  Loader2,
  LogOut,
  Users,
  Clock,
  Trash2,
  Search,
  RefreshCw,
  Inbox,
  List,
  X,
  Mail,
  Phone,
} from 'lucide-react';

type PlatformTab = 'pending' | 'approved' | 'all' | 'notifications';
type AlertKind = 'success' | 'error';

interface PlatformCompaniesConsoleProps {
  profile: Profile;
  /** When true, hides standalone top bar (used inside AdminDashboard). */
  embedded?: boolean;
  onLogout?: () => void;
}

function formatDate(iso: string, withTime = false) {
  const d = new Date(iso);
  return withTime ? d.toLocaleString() : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function StatusBadge({ status }: { status: PlatformCompanyRow['status'] }) {
  return <span className={`platform-status platform-status--${status}`}>{status}</span>;
}

function matchesSearch(c: PlatformCompanyRow, q: string) {
  if (!q.trim()) return true;
  const hay = [
    c.name,
    c.contact_email,
    c.contact_name,
    c.owner_email,
    c.owner_name,
    c.industry,
    c.city,
    c.country,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q.trim().toLowerCase());
}

function CompanyDetails({ c }: { c: PlatformCompanyRow }) {
  return (
    <dl className="platform-detail-grid">
      <div>
        <dt>Contact</dt>
        <dd>{c.contact_name || '—'}{c.job_title ? ` · ${c.job_title}` : ''}</dd>
      </div>
      <div>
        <dt>Email</dt>
        <dd>{c.contact_email}</dd>
      </div>
      {c.contact_phone && (
        <div>
          <dt>Phone</dt>
          <dd>{c.contact_phone}</dd>
        </div>
      )}
      <div>
        <dt>Plan</dt>
        <dd>{c.subscription_plan || 'trial'}</dd>
      </div>
      {c.industry && (
        <div>
          <dt>Industry</dt>
          <dd>{c.industry}</dd>
        </div>
      )}
      {c.employee_count && (
        <div>
          <dt>Team size</dt>
          <dd>{c.employee_count}</dd>
        </div>
      )}
      {(c.city || c.country) && (
        <div>
          <dt>Location</dt>
          <dd>{[c.address_line, c.city, c.country].filter(Boolean).join(', ')}</dd>
        </div>
      )}
      {c.website && (
        <div>
          <dt>Website</dt>
          <dd>{c.website}</dd>
        </div>
      )}
      {c.owner_email && (
        <div>
          <dt>Account owner</dt>
          <dd>{c.owner_name || '—'} · {c.owner_email}</dd>
        </div>
      )}
      <div>
        <dt>Users</dt>
        <dd>{c.user_count}</dd>
      </div>
      <div>
        <dt>Registered</dt>
        <dd>{formatDate(c.created_at, true)}</dd>
      </div>
      {c.approved_at && (
        <div>
          <dt>Approved</dt>
          <dd>{formatDate(c.approved_at, true)}</dd>
        </div>
      )}
      {c.registration_notes && (
        <div className="platform-detail-grid__full">
          <dt>Notes</dt>
          <dd>{c.registration_notes}</dd>
        </div>
      )}
    </dl>
  );
}

function PendingCard({
  c,
  busy,
  onApprove,
  onReject,
  onDelete,
}: {
  c: PlatformCompanyRow;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onDelete: () => void;
}) {
  return (
    <article className="platform-pending-card">
      <div className="platform-pending-card__top">
        <div>
          <h4 className="platform-pending-card__name">
            {c.name}
            <StatusBadge status={c.status} />
          </h4>
          <p className="platform-pending-card__meta">
            <Mail size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
            {c.contact_email}
            {c.contact_phone && (
              <>
                {' · '}
                <Phone size={12} style={{ verticalAlign: 'middle', marginRight: 2 }} />
                {c.contact_phone}
              </>
            )}
          </p>
        </div>
        <div className="platform-pending-card__actions">
          <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onApprove}>
            {busy ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
            Approve
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={onReject}>
            <XCircle size={14} /> Reject
          </button>
          <button type="button" className="btn btn-secondary btn-sm platform-btn-delete" disabled={busy} onClick={onDelete}>
            <Trash2 size={14} /> Delete
          </button>
        </div>
      </div>
      <CompanyDetails c={c} />
    </article>
  );
}

export default function PlatformCompaniesConsole({ profile, embedded = false, onLogout }: PlatformCompaniesConsoleProps) {
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [companies, setCompanies] = useState<PlatformCompanyRow[]>([]);
  const [notifications, setNotifications] = useState<PlatformNotification[]>([]);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [alert, setAlert] = useState<{ kind: AlertKind; text: string } | null>(null);
  const [tab, setTab] = useState<PlatformTab>('pending');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | PlatformCompanyRow['status']>('all');
  const [rejectTarget, setRejectTarget] = useState<PlatformCompanyRow | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const loadData = useCallback(async () => {
    const [co, no] = await Promise.all([
      supabase.rpc('platform_get_companies'),
      supabase.rpc('platform_get_notifications'),
    ]);
    if (co.error) {
      setAlert({ kind: 'error', text: co.error.message });
    } else {
      setCompanies((co.data || []) as PlatformCompanyRow[]);
    }
    if (!no.error) setNotifications((no.data || []) as PlatformNotification[]);
  }, []);

  useEffect(() => {
    void loadData().finally(() => setLoading(false));
  }, [loadData]);

  useSupabaseRealtime(
    'platform-companies-sync',
    [{ table: 'companies' }, { table: 'platform_owner_notifications' }],
    () => { void loadData(); },
    true,
  );

  const refresh = async () => {
    setRefreshing(true);
    await loadData();
    setRefreshing(false);
  };

  const approve = async (id: string) => {
    setActionLoading(id);
    setAlert(null);
    const { error } = await supabase.rpc('platform_approve_company', { p_company_id: id });
    if (error) setAlert({ kind: 'error', text: error.message });
    else {
      setAlert({ kind: 'success', text: 'Company approved. The admin can now sign in and use Scorr.' });
      await loadData();
      setTab('approved');
    }
    setActionLoading(null);
  };

  const confirmReject = async () => {
    if (!rejectTarget) return;
    const id = rejectTarget.id;
    setActionLoading(id);
    setAlert(null);
    const { error } = await supabase.rpc('platform_reject_company', {
      p_company_id: id,
      p_reason: rejectReason.trim() || null,
    });
    if (error) setAlert({ kind: 'error', text: error.message });
    else {
      setAlert({ kind: 'success', text: `Registration for "${rejectTarget.name}" was rejected.` });
      await loadData();
    }
    setRejectTarget(null);
    setRejectReason('');
    setActionLoading(null);
  };

  const removeCompany = async (c: PlatformCompanyRow) => {
    const label = c.name || c.contact_email || 'this company';
    if (
      !confirm(
        `Permanently delete "${label}"?\n\nThis removes all users, KPIs, departments, and data for this company. This cannot be undone.`,
      )
    ) {
      return;
    }
    setActionLoading(c.id);
    setAlert(null);
    const { error } = await supabase.rpc('platform_delete_company', { p_company_id: c.id });
    if (error) setAlert({ kind: 'error', text: error.message });
    else {
      setAlert({ kind: 'success', text: `Company "${label}" was permanently deleted.` });
      await loadData();
    }
    setActionLoading(null);
  };

  const markNotificationRead = async (n: PlatformNotification) => {
    if (n.read) return;
    await supabase.rpc('platform_mark_notification_read', { p_notification_id: n.id });
    setNotifications((prev) => prev.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
    if (n.company_id) {
      const co = companies.find((c) => c.id === n.company_id);
      if (co?.status === 'pending') setTab('pending');
    }
  };

  const pending = useMemo(() => companies.filter((c) => c.status === 'pending'), [companies]);
  const approved = useMemo(() => companies.filter((c) => c.status === 'active'), [companies]);
  const unread = useMemo(() => notifications.filter((n) => !n.read), [notifications]);

  const filteredCompanies = useMemo(() => {
    let list = companies;
    if (tab === 'pending') list = pending;
    else if (tab === 'approved') list = approved;
    if (statusFilter !== 'all') list = list.filter((c) => c.status === statusFilter);
    return list.filter((c) => matchesSearch(c, search));
  }, [companies, pending, approved, tab, statusFilter, search]);

  if (loading) {
    return (
      <div className="platform-loading" style={{ minHeight: embedded ? '40vh' : undefined }}>
        <Loader2 className="animate-spin" size={32} style={{ color: 'var(--accent-primary)' }} />
        Loading registered companies…
      </div>
    );
  }

  const renderTable = (rows: PlatformCompanyRow[], showApproveReject = false) => (
    <div className="platform-table-wrap">
      <table className="platform-table">
        <thead>
          <tr>
            <th>Company</th>
            <th>Registered</th>
            <th>Plan</th>
            <th>Industry</th>
            <th>Status</th>
            <th>Owner</th>
            <th>Users</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id}>
              <td>
                <span className="platform-table__company">{c.name}</span>
                <span className="platform-table__sub">{c.contact_email}</span>
                {c.contact_phone && <span className="platform-table__sub">{c.contact_phone}</span>}
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>{formatDate(c.created_at)}</td>
              <td>{c.subscription_plan || 'trial'}</td>
              <td>{c.industry || '—'}</td>
              <td><StatusBadge status={c.status} /></td>
              <td>
                {c.owner_name || '—'}
                {c.owner_email && <span className="platform-table__sub">{c.owner_email}</span>}
              </td>
              <td>
                <Users size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                {c.user_count}
              </td>
              <td>
                <div className="platform-table__actions">
                  {showApproveReject && c.status === 'pending' && (
                    <>
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        disabled={actionLoading === c.id}
                        onClick={() => approve(c.id)}
                        title="Approve"
                      >
                        <CheckCircle size={14} />
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        disabled={actionLoading === c.id}
                        onClick={() => setRejectTarget(c)}
                        title="Reject"
                      >
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
  );

  return (
    <div className={`platform-page ${embedded ? 'platform-page--embedded' : ''}`}>
      {!embedded && (
        <header className="platform-topbar">
          <div className="platform-topbar__brand">
            <div className="platform-topbar__icon">
              <Shield size={20} />
            </div>
            <div>
              <p className="platform-topbar__title">Scorr Platform Console</p>
              <p className="platform-topbar__owner">{profile.full_name || 'Samiya Kayani'} · Platform owner</p>
            </div>
          </div>
          <div className="platform-topbar__actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
            {onLogout && (
              <button type="button" className="btn btn-secondary btn-sm" onClick={onLogout}>
                <LogOut size={14} /> Sign out
              </button>
            )}
          </div>
        </header>
      )}

      <section className="glass-panel platform-header">
        <div className="platform-header__main">
          <div className="platform-header__icon">
            <Building2 size={22} />
          </div>
          <div style={{ flex: 1 }}>
            <h1 className="platform-header__title">Registered Companies</h1>
            <p className="platform-header__subtitle">
              Review pending registrations, manage approved organizations, and monitor platform activity.
              Organization admins never see other companies — this is platform owner only.
            </p>
          </div>
          {embedded && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void refresh()} disabled={refreshing}>
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          )}
        </div>
        <div className="platform-stats">
          <div className="platform-stat">
            <span className="platform-stat__label">Total registered</span>
            <strong>{companies.length}</strong>
          </div>
          <div className="platform-stat platform-stat--pending">
            <span className="platform-stat__label">Pending approval</span>
            <strong>{pending.length}</strong>
          </div>
          <div className="platform-stat platform-stat--active">
            <span className="platform-stat__label">Approved & active</span>
            <strong>{approved.length}</strong>
          </div>
          <div className="platform-stat platform-stat--alert">
            <span className="platform-stat__label">Unread alerts</span>
            <strong>{unread.length}</strong>
          </div>
        </div>
      </section>

      {alert && (
        <div className={`platform-alert platform-alert--${alert.kind}`}>
          <span>{alert.text}</span>
          <button type="button" className="platform-alert__dismiss" onClick={() => setAlert(null)} aria-label="Dismiss">
            <X size={16} />
          </button>
        </div>
      )}

      <nav className="platform-tabs" aria-label="Platform sections">
        <button
          type="button"
          className={`platform-tab ${tab === 'pending' ? 'platform-tab--active' : ''}`}
          onClick={() => { setTab('pending'); setStatusFilter('all'); }}
        >
          <Clock size={15} />
          Pending
          {pending.length > 0 && (
            <span className="platform-tab__badge platform-tab__badge--warn">{pending.length}</span>
          )}
        </button>
        <button
          type="button"
          className={`platform-tab ${tab === 'approved' ? 'platform-tab--active' : ''}`}
          onClick={() => { setTab('approved'); setStatusFilter('all'); }}
        >
          <CheckCircle size={15} />
          Approved
          {approved.length > 0 && <span className="platform-tab__badge">{approved.length}</span>}
        </button>
        <button
          type="button"
          className={`platform-tab ${tab === 'all' ? 'platform-tab--active' : ''}`}
          onClick={() => setTab('all')}
        >
          <List size={15} />
          All companies
        </button>
        <button
          type="button"
          className={`platform-tab ${tab === 'notifications' ? 'platform-tab--active' : ''}`}
          onClick={() => setTab('notifications')}
        >
          <Bell size={15} />
          Notifications
          {unread.length > 0 && (
            <span className="platform-tab__badge platform-tab__badge--warn">{unread.length}</span>
          )}
        </button>
      </nav>

      {tab !== 'notifications' && (
        <div className="platform-toolbar">
          <div className="platform-toolbar__search form-group">
            <Search size={16} className="platform-toolbar__search-icon" />
            <input
              type="search"
              className="form-input"
              placeholder="Search company, email, owner, industry…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          {tab === 'all' && (
            <div className="form-group" style={{ minWidth: 140, flex: '0 1 160px' }}>
              <label className="form-label" style={{ fontSize: '0.72rem' }}>Status</label>
              <select
                className="form-input"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              >
                <option value="all">All statuses</option>
                <option value="pending">Pending</option>
                <option value="active">Active</option>
                <option value="rejected">Rejected</option>
                <option value="suspended">Suspended</option>
              </select>
            </div>
          )}
        </div>
      )}

      {tab === 'pending' && (
        <section className="glass-panel platform-panel">
          <div className="platform-panel__head">
            <div>
              <h2 className="platform-panel__title">Pending approvals</h2>
              <p className="platform-panel__hint">
                New company registrations waiting for your review. Approve to activate their Scorr workspace.
              </p>
            </div>
          </div>
          {filteredCompanies.length === 0 ? (
            <div className="platform-empty">
              <Inbox size={36} className="platform-empty__icon" />
              <p>{search ? 'No pending companies match your search.' : 'No pending registrations — all caught up.'}</p>
            </div>
          ) : (
            <div className="platform-pending-list">
              {filteredCompanies.map((c) => (
                <PendingCard
                  key={c.id}
                  c={c}
                  busy={actionLoading === c.id}
                  onApprove={() => approve(c.id)}
                  onReject={() => setRejectTarget(c)}
                  onDelete={() => removeCompany(c)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'approved' && (
        <section className="glass-panel platform-panel">
          <div className="platform-panel__head">
            <div>
              <h2 className="platform-panel__title">Approved companies</h2>
              <p className="platform-panel__hint">
                Active organizations with full access to their Scorr admin dashboard.
              </p>
            </div>
          </div>
          {filteredCompanies.length === 0 ? (
            <div className="platform-empty">
              <CheckCircle size={36} className="platform-empty__icon" />
              <p>{search ? 'No approved companies match your search.' : 'No approved companies yet.'}</p>
            </div>
          ) : (
            renderTable(filteredCompanies)
          )}
        </section>
      )}

      {tab === 'all' && (
        <section className="glass-panel platform-panel">
          <div className="platform-panel__head">
            <div>
              <h2 className="platform-panel__title">All registered companies ({filteredCompanies.length})</h2>
              <p className="platform-panel__hint">
                Complete registry — pending, active, rejected, and suspended. Demo sandboxes are not listed.
              </p>
            </div>
          </div>
          {filteredCompanies.length === 0 ? (
            <div className="platform-empty">
              <Building2 size={36} className="platform-empty__icon" />
              <p>{search || statusFilter !== 'all' ? 'No companies match your filters.' : 'No company registrations yet.'}</p>
            </div>
          ) : (
            renderTable(filteredCompanies, true)
          )}
        </section>
      )}

      {tab === 'notifications' && (
        <section className="glass-panel platform-panel">
          <div className="platform-panel__head">
            <div>
              <h2 className="platform-panel__title">Platform notifications</h2>
              <p className="platform-panel__hint">
                Registration alerts and system events. Click an item to mark it as read.
              </p>
            </div>
          </div>
          {notifications.length === 0 ? (
            <div className="platform-empty">
              <Bell size={36} className="platform-empty__icon" />
              <p>No notifications yet.</p>
            </div>
          ) : (
            <div className="platform-notif-list">
              {notifications.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  className={`platform-notif ${!n.read ? 'platform-notif--unread' : ''}`}
                  onClick={() => void markNotificationRead(n)}
                >
                  <Bell size={18} className="platform-notif__icon" />
                  <div>
                    <p className="platform-notif__title">{n.title}</p>
                    <p className="platform-notif__message">{n.message}</p>
                    <p className="platform-notif__time">{formatDate(n.created_at, true)}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {rejectTarget && (
        <div className="platform-modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reject-modal-title">
          <div className="glass-panel platform-modal">
            <h3 id="reject-modal-title" className="platform-modal__title">
              Reject registration
            </h3>
            <p className="platform-modal__hint">
              Reject <strong>{rejectTarget.name}</strong>? Optionally add a reason — the company admin will see their account as rejected.
            </p>
            <div className="form-group">
              <label className="form-label" htmlFor="reject-reason">Reason (optional)</label>
              <textarea
                id="reject-reason"
                className="form-input"
                rows={3}
                placeholder="e.g. Incomplete business information"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
              />
            </div>
            <div className="platform-modal__actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => { setRejectTarget(null); setRejectReason(''); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-secondary btn-sm platform-btn-delete"
                disabled={actionLoading === rejectTarget.id}
                onClick={() => void confirmReject()}
              >
                {actionLoading === rejectTarget.id ? <Loader2 size={14} className="animate-spin" /> : <XCircle size={14} />}
                Reject company
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
