import { useCallback, useEffect, useMemo, useState } from 'react';
import { History, Loader2, Search, UserRound, Gift, Package } from 'lucide-react';
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

function roleLabel(role: string | undefined): string {
  if (role === 'manager') return 'Manager';
  if (role === 'hr') return 'HR';
  if (role === 'admin') return 'Admin';
  return 'Employee';
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

  const emptyPeopleCopy = isManagerScope
    ? 'No team members match that search.'
    : 'No employees or managers match that search.';

  const introCopy = isManagerScope
    ? 'Search your team to see each employee’s catalog redemptions and KPI gifts — pending, approved, and fulfilled.'
    : 'Search any employee or manager to see every catalog redemption and KPI gift they claimed — including pending, approved, and fulfilled.';

  if (loadingPeople) {
    return (
      <div className="admin-rewards-loading">
        <Loader2 size={28} className="spin-icon" />
        <span>Loading people…</span>
      </div>
    );
  }

  return (
    <section
      className={
        isManagerScope
          ? 'mgr-rewards-card admin-reward-history'
          : 'admin-rewards-card glass-panel admin-reward-history'
      }
    >
      <div className={isManagerScope ? undefined : 'admin-rewards-card__head'}>
        <div>
          <h3>
            <History size={18} /> {isManagerScope ? 'Team gift history' : 'Gift history'}
          </h3>
          <p>{introCopy}</p>
        </div>
      </div>

      {error && (
        <div
          className={
            isManagerScope
              ? 'mgr-rewards-alert mgr-rewards-alert--error'
              : 'admin-rewards-alert admin-rewards-alert--error'
          }
          role="alert"
        >
          {error}
        </div>
      )}

      <label className="admin-reward-history__search">
        <Search size={16} aria-hidden />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name or email…"
          autoComplete="off"
        />
      </label>

      <div className="admin-reward-history__layout">
        <div className="admin-reward-history__people" role="listbox" aria-label="People">
          {matches.length === 0 ? (
            <p className="admin-rewards-empty" style={{ padding: '1rem' }}>
              {emptyPeopleCopy}
            </p>
          ) : (
            matches.map((p) => (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={selectedId === p.id}
                className={`admin-reward-history__person${selectedId === p.id ? ' is-active' : ''}`}
                onClick={() => setSelectedId(p.id)}
              >
                <span className="admin-reward-history__avatar" aria-hidden>
                  <UserRound size={16} />
                </span>
                <span className="admin-reward-history__person-text">
                  <strong>{p.full_name}</strong>
                  <span>
                    {roleLabel(p.role)}
                    {p.email ? ` · ${p.email}` : ''}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>

        <div className="admin-reward-history__detail">
          {!selected ? (
            <div className="admin-rewards-empty" style={{ padding: '2rem 1rem' }}>
              <Search size={36} strokeWidth={1.25} />
              <h4>Select a person</h4>
              <p>
                {isManagerScope
                  ? 'Pick someone on your team to open their gift history.'
                  : 'Type a name to find someone, then open their full gift history.'}
              </p>
            </div>
          ) : loadingHistory ? (
            <div className="admin-rewards-loading" style={{ padding: '2rem' }}>
              <Loader2 size={24} className="spin-icon" />
              <span>Loading history…</span>
            </div>
          ) : (
            <>
              <header className="admin-reward-history__detail-head">
                <div>
                  <h4>{selected.full_name}</h4>
                  <p>
                    {roleLabel(selected.role)}
                    {selected.email ? ` · ${selected.email}` : ''}
                    {' · '}
                    {rows.length} gift{rows.length === 1 ? '' : 's'}
                  </p>
                </div>
              </header>

              {rows.length === 0 ? (
                <div className="admin-rewards-empty" style={{ padding: '1.5rem 1rem' }}>
                  <Gift size={36} strokeWidth={1.25} />
                  <h4>No gifts yet</h4>
                  <p>This person has not redeemed a catalog reward or claimed a KPI gift.</p>
                </div>
              ) : (
                <div className={isManagerScope ? 'mgr-rewards-table-wrap' : 'admin-rewards-table-wrap'}>
                  <table className={isManagerScope ? 'mgr-rewards-table' : 'admin-rewards-table'}>
                    <thead>
                      <tr>
                        <th>Gift</th>
                        <th>Type</th>
                        <th>Weightage</th>
                        <th>Status</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <span className="admin-reward-history__gift">
                              {r.kind === 'catalog' ? (
                                <RewardCatalogIcon icon={r.icon ?? '🎁'} size={18} />
                              ) : (
                                <Gift size={16} />
                              )}
                              <span>
                                <strong>{r.rewardName}</strong>
                                {r.detail ? (
                                  <span className="admin-reward-history__detail-line">{r.detail}</span>
                                ) : null}
                              </span>
                            </span>
                          </td>
                          <td>
                            <span className={`admin-reward-history__type admin-reward-history__type--${r.kind}`}>
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
                          </td>
                          <td>
                            {r.weightage != null && !Number.isNaN(r.weightage)
                              ? `${r.weightage}%`
                              : '—'}
                          </td>
                          <td>
                            <span
                              className={
                                isManagerScope
                                  ? `mgr-rewards-status mgr-rewards-status--${
                                      r.status === 'issued' ? 'fulfilled' : r.status || 'pending'
                                    }`
                                  : `redemption-status redemption-status--${
                                      r.status === 'issued' ? 'fulfilled' : r.status || 'pending'
                                    }`
                              }
                            >
                              {statusLabel(r.status)}
                            </span>
                          </td>
                          <td>
                            {new Date(r.at).toLocaleDateString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
