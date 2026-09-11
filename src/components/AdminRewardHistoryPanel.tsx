import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  History,
  Loader2,
  Search,
  Gift,
  Package,
  ArrowLeft,
  X,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import RewardCatalogIcon from './RewardCatalogIcon';

type HistoryPerson = Pick<Profile, 'id' | 'full_name' | 'email' | 'role' | 'is_demo'>;

interface HistoryRow {
  id: string;
  kind: 'catalog' | 'kpi';
  rewardName: string;
  icon?: string | null;
  status: string;
  detail?: string | null;
  weightage?: number | null;
  at: string;
}

export interface RewardGiftHistoryPanelProps {
  /** admin: company-wide; manager: direct reports only */
  scope?: 'admin' | 'manager';
  managerId?: string;
}

function statusLabel(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'issued' || s === 'fulfilled') return 'Fulfilled';
  if (s === 'pending_fulfillment') return 'Pending';
  if (!s) return 'Pending';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function statusTone(status: string): string {
  const s = (status || '').toLowerCase();
  if (s === 'issued' || s === 'fulfilled') return 'fulfilled';
  if (s === 'approved') return 'approved';
  if (s === 'dismissed') return 'dismissed';
  return 'pending';
}

function roleLabel(role: string | undefined): string {
  if (role === 'manager') return 'Manager';
  if (role === 'hr') return 'HR';
  if (role === 'admin') return 'Admin';
  return 'Employee';
}

function initials(name: string | undefined): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
}

function formatHistoryDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function AdminRewardHistoryPanel({
  scope = 'admin',
  managerId,
}: RewardGiftHistoryPanelProps) {
  const [people, setPeople] = useState<HistoryPerson[]>([]);
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loadingPeople, setLoadingPeople] = useState(true);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [error, setError] = useState('');

  const isManagerScope = scope === 'manager';

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingPeople(true);
      setSelectedId(null);

      if (isManagerScope) {
        if (!managerId) {
          setError('Manager is required');
          setPeople([]);
          setLoadingPeople(false);
          return;
        }
        const { data, error: err } = await supabase.rpc('get_direct_reports', {
          p_manager_id: managerId,
        });
        if (cancelled) return;
        if (err) {
          setError(err.message);
          setPeople([]);
        } else {
          const list = ((data as Profile[]) || [])
            .filter((u) => !u.is_demo)
            .map((u) => ({
              id: u.id,
              full_name: u.full_name,
              email: u.email,
              role: u.role,
              is_demo: u.is_demo,
            }))
            .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
          setPeople(list);
          setError('');
        }
        setLoadingPeople(false);
        return;
      }

      const { data, error: err } = await supabase.rpc('get_all_users_admin');
      if (cancelled) return;
      if (err) {
        setError(err.message);
        setPeople([]);
      } else {
        const list = ((data as Profile[]) || [])
          .filter((u) => !u.is_demo && (u.role === 'employee' || u.role === 'manager'))
          .map((u) => ({
            id: u.id,
            full_name: u.full_name,
            email: u.email,
            role: u.role,
            is_demo: u.is_demo,
          }))
          .sort((a, b) => (a.full_name || '').localeCompare(b.full_name || ''));
        setPeople(list);
        setError('');
      }
      setLoadingPeople(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [isManagerScope, managerId]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter(
      (p) =>
        (p.full_name || '').toLowerCase().includes(q) ||
        (p.email || '').toLowerCase().includes(q),
    );
  }, [people, query]);

  const selected = useMemo(
    () => people.find((p) => p.id === selectedId) ?? null,
    [people, selectedId],
  );

  const loadHistory = useCallback(async (userId: string) => {
    setLoadingHistory(true);
    setError('');
    const [catalogRes, kpiRes] = await Promise.all([
      supabase
        .from('reward_redemptions')
        .select('id, status, redeemed_at, weightage_at_claim, rewards_catalog(name, icon)')
        .eq('employee_id', userId)
        .order('redeemed_at', { ascending: false }),
      supabase
        .from('kpi_award_qualifications')
        .select('id, reward_name, detail, status, created_at, decided_at, latest_score, period_end')
        .eq('employee_id', userId)
        .order('created_at', { ascending: false }),
    ]);

    if (catalogRes.error || kpiRes.error) {
      setError(catalogRes.error?.message || kpiRes.error?.message || 'Failed to load history');
      setRows([]);
      setLoadingHistory(false);
      return;
    }

    const catalogRows: HistoryRow[] = (catalogRes.data || []).map((r: {
      id: string;
      status: string;
      redeemed_at: string;
      weightage_at_claim?: number | null;
      rewards_catalog?: { name?: string; icon?: string } | { name?: string; icon?: string }[] | null;
    }) => {
      const cat = Array.isArray(r.rewards_catalog) ? r.rewards_catalog[0] : r.rewards_catalog;
      return {
        id: `catalog-${r.id}`,
        kind: 'catalog' as const,
        rewardName: cat?.name || 'Catalog reward',
        icon: cat?.icon ?? '🎁',
        status: r.status,
        weightage: r.weightage_at_claim != null ? Number(r.weightage_at_claim) : null,
        at: r.redeemed_at,
      };
    });

    const kpiRows: HistoryRow[] = (kpiRes.data || []).map((r: {
      id: string;
      reward_name: string;
      detail?: string | null;
      status: string;
      created_at: string;
      decided_at?: string | null;
      latest_score?: number | null;
      period_end?: string | null;
    }) => ({
      id: `kpi-${r.id}`,
      kind: 'kpi' as const,
      rewardName: r.reward_name,
      icon: null,
      status: r.status,
      detail: r.detail,
      weightage: r.latest_score != null ? Number(r.latest_score) : null,
      at: r.decided_at || r.created_at,
    }));

    const merged = [...catalogRows, ...kpiRows].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
    setRows(merged);
    setLoadingHistory(false);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setRows([]);
      return;
    }
    void loadHistory(selectedId);
  }, [selectedId, loadHistory]);

  const clearSelection = () => setSelectedId(null);

  if (loadingPeople) {
    return (
      <div className="rgh-loading" role="status">
        <Loader2 size={26} className="spin-icon" />
        <span>Loading people…</span>
      </div>
    );
  }

  return (
    <section
      className={`rgh ${isManagerScope ? 'rgh--manager' : 'rgh--admin glass-panel'}${
        selectedId ? ' rgh--has-selection' : ''
      }`}
    >
      <header className="rgh__header">
        <div className="rgh__header-icon" aria-hidden>
          <History size={20} />
        </div>
        <div className="rgh__header-copy">
          <div className="rgh__title-row">
            <h3>{isManagerScope ? 'Team gift history' : 'Gift history'}</h3>
            <span className="rgh__count">{people.length}</span>
          </div>
          <p>
            {isManagerScope
              ? 'Look up anyone on your team and review every gift they claimed.'
              : 'Look up any employee or manager and review their full redemption record.'}
          </p>
        </div>
      </header>

      {error && (
        <div className="rgh__alert" role="alert">
          <span>{error}</span>
          <button type="button" className="rgh__alert-dismiss" onClick={() => setError('')} aria-label="Dismiss">
            <X size={14} />
          </button>
        </div>
      )}

      <div className="rgh__shell">
        <aside className="rgh__aside" aria-label={isManagerScope ? 'Team members' : 'People'}>
          <label className="rgh__search">
            <Search size={16} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name or email…"
              autoComplete="off"
              enterKeyHint="search"
            />
            {query ? (
              <button
                type="button"
                className="rgh__search-clear"
                onClick={() => setQuery('')}
                aria-label="Clear search"
              >
                <X size={14} />
              </button>
            ) : null}
          </label>

          <div className="rgh__people" role="listbox" aria-label="Matching people">
            {matches.length === 0 ? (
              <div className="rgh__empty rgh__empty--compact">
                <p>{isManagerScope ? 'No team members match.' : 'No people match that search.'}</p>
              </div>
            ) : (
              matches.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={selectedId === p.id}
                  className={`rgh__person${selectedId === p.id ? ' is-active' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <span className="rgh__avatar" aria-hidden>
                    {initials(p.full_name)}
                  </span>
                  <span className="rgh__person-meta">
                    <strong>{p.full_name}</strong>
                    <span className="rgh__person-sub">
                      <span className="rgh__role-chip">{roleLabel(p.role)}</span>
                      {p.email ? <span className="rgh__email">{p.email}</span> : null}
                    </span>
                  </span>
                </button>
              ))
            )}
          </div>
        </aside>

        <div className="rgh__detail" aria-live="polite">
          {!selected ? (
            <div className="rgh__empty">
              <div className="rgh__empty-icon" aria-hidden>
                <Search size={28} strokeWidth={1.5} />
              </div>
              <h4>Select a person</h4>
              <p>
                {isManagerScope
                  ? 'Choose someone from your team to open their gift timeline.'
                  : 'Search, then select a person to open their gift timeline.'}
              </p>
            </div>
          ) : loadingHistory ? (
            <div className="rgh-loading rgh-loading--inset" role="status">
              <Loader2 size={24} className="spin-icon" />
              <span>Loading history…</span>
            </div>
          ) : (
            <>
              <div className="rgh__detail-toolbar">
                <button type="button" className="rgh__back" onClick={clearSelection}>
                  <ArrowLeft size={16} />
                  Back
                </button>
              </div>

              <header className="rgh__profile">
                <span className="rgh__avatar rgh__avatar--lg" aria-hidden>
                  {initials(selected.full_name)}
                </span>
                <div className="rgh__profile-text">
                  <h4>{selected.full_name}</h4>
                  <p>
                    <span className="rgh__role-chip">{roleLabel(selected.role)}</span>
                    {selected.email ? <span className="rgh__email">{selected.email}</span> : null}
                  </p>
                  <p className="rgh__profile-count">
                    {rows.length === 0
                      ? 'No gifts recorded'
                      : `${rows.length} gift${rows.length === 1 ? '' : 's'} on record`}
                  </p>
                </div>
              </header>

              {rows.length === 0 ? (
                <div className="rgh__empty rgh__empty--inset">
                  <div className="rgh__empty-icon" aria-hidden>
                    <Gift size={28} strokeWidth={1.5} />
                  </div>
                  <h4>No gifts yet</h4>
                  <p>No catalog redemptions or KPI awards have been claimed by this person.</p>
                </div>
              ) : (
                <ol className="rgh__timeline">
                  {rows.map((r) => (
                    <li key={r.id} className="rgh__event">
                      <div className={`rgh__event-icon rgh__event-icon--${r.kind}`} aria-hidden>
                        {r.kind === 'catalog' ? (
                          <RewardCatalogIcon icon={r.icon ?? '🎁'} size={20} />
                        ) : (
                          <Gift size={18} />
                        )}
                      </div>
                      <div className="rgh__event-body">
                        <div className="rgh__event-top">
                          <strong className="rgh__event-title">{r.rewardName}</strong>
                          <span className={`rgh__status rgh__status--${statusTone(r.status)}`}>
                            {statusLabel(r.status)}
                          </span>
                        </div>
                        <div className="rgh__event-meta">
                          <span className={`rgh__kind rgh__kind--${r.kind}`}>
                            {r.kind === 'catalog' ? (
                              <>
                                <Package size={12} /> Catalog
                              </>
                            ) : (
                              <>
                                <Gift size={12} /> KPI award
                              </>
                            )}
                          </span>
                          {r.weightage != null && !Number.isNaN(r.weightage) ? (
                            <span>{r.weightage}% weightage</span>
                          ) : null}
                          <time dateTime={r.at}>{formatHistoryDate(r.at)}</time>
                        </div>
                        {r.detail ? <p className="rgh__event-detail">{r.detail}</p> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
