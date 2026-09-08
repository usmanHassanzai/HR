import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, Loader2, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi, kpiProgressBadge } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { hydrateKpiLastEdits } from '../utils/kpiAssignmentEdits';
import { isDemoProfile } from '../utils/demoMode';
import {
  kpiOverlapsRange,
  validateDateRange,
} from '../utils/adminKpiDateRange';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import {
  formatKpiScore,
  kpiScoreContribution,
  isKpiPastDeadline,
  kpiManagerScorePct,
} from '../utils/kpiScoreHelpers';
import KpiAssignmentDetails from './KpiAssignmentDetails';
import KpiViewedBadge from './KpiViewedBadge';
import EditAssignedKpiModal from './EditAssignedKpiModal';
import '../styles/admin-simple.css';

interface AdminSimpleWorkspaceProps {
  profile: Profile;
  people: Profile[];
  departments: Department[];
  loading?: boolean;
  lockedPerson?: Profile | null;
  onBackToList?: () => void;
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function roleLabel(role: Profile['role']): string {
  if (role === 'manager') return 'Manager';
  if (role === 'admin') return 'Admin';
  if (role === 'hr') return 'HR';
  return 'Employee';
}

function fmtDate(d?: string | null): string {
  if (!d) return '—';
  return new Date(`${d.slice(0, 10)}T00:00:00`).toLocaleDateString();
}

export default function AdminSimpleWorkspace({
  profile,
  people,
  departments,
  loading,
  lockedPerson = null,
  onBackToList,
}: AdminSimpleWorkspaceProps) {
  const [selected, setSelected] = useState<Profile | null>(lockedPerson);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (lockedPerson) setSelected(lockedPerson);
  }, [lockedPerson]);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [appliedFrom, setAppliedFrom] = useState('');
  const [appliedTo, setAppliedTo] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [editing, setEditing] = useState<Kpi | null>(null);
  const [kpiTick, setKpiTick] = useState(0);

  const deptName = (id?: string | null) => departments.find((d) => d.id === id)?.name || '';

  const roster = useMemo(() => {
    const allowDemo = isDemoProfile(profile);
    const q = query.trim().toLowerCase();
    return people
      .filter((p) => p.role === 'employee' || p.role === 'manager')
      .filter((p) => allowDemo || !p.is_demo)
      .filter((p) => {
        if (!q) return true;
        const dept = deptName(p.department_id).toLowerCase();
        return p.full_name.toLowerCase().includes(q) || roleLabel(p.role).toLowerCase().includes(q) || dept.includes(q);
      })
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [people, departments, profile, query]);

  useEffect(() => {
    if (!selected) {
      setKpis([]);
      return;
    }
    let cancelled = false;
    setKpiLoading(true);
    void (async () => {
      const { data, error } = await supabase
        .from('kpis')
        .select('*')
        .eq('user_id', selected.id)
        .order('created_at', { ascending: true });
      if (cancelled) return;
      if (error) {
        setKpis([]);
      } else {
        setKpis(await hydrateKpiLastEdits((data as Kpi[]) || []));
      }
      setKpiLoading(false);
    })();
    return () => { cancelled = true; };
  }, [selected?.id, kpiTick]);

  const openPerson = (person: Profile) => {
    setDraftFrom('');
    setDraftTo('');
    setAppliedFrom('');
    setAppliedTo('');
    setRangeError('');
    setSelected(person);
  };

  const applyRange = () => {
    if (!draftFrom && !draftTo) {
      setRangeError('');
      setAppliedFrom('');
      setAppliedTo('');
      return;
    }
    const err = validateDateRange(draftFrom, draftTo);
    if (err) {
      setRangeError(err);
      return;
    }
    setRangeError('');
    setAppliedFrom(draftFrom);
    setAppliedTo(draftTo);
  };

  const visibleKpis = kpis.filter((k) => {
    if (!appliedFrom && !appliedTo) return true;
    return kpiOverlapsRange(k, appliedFrom || '1970-01-01', appliedTo || '9999-12-31');
  });

  if (selected) {
    return (
      <div className="admin-simple">
        <button
          type="button"
          className="btn btn-secondary btn-sm admin-simple__back"
          onClick={() => {
            setSelected(null);
            onBackToList?.();
          }}
        >
          <ArrowLeft size={16} /> All employees
        </button>

        <div className="admin-simple__person">
          <span className="admin-simple__avatar" aria-hidden>{initials(selected.full_name)}</span>
          <div>
            <h2>{selected.full_name}</h2>
            <span className="admin-simple__meta">
              {[roleLabel(selected.role), deptName(selected.department_id)].filter(Boolean).join(' · ')}
            </span>
          </div>
        </div>

        <form
          className="admin-simple__filter"
          onSubmit={(e) => {
            e.preventDefault();
            applyRange();
          }}
        >
          <label>
            From
            <input type="date" value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} />
          </label>
          <label>
            To
            <input type="date" value={draftTo} onChange={(e) => setDraftTo(e.target.value)} />
          </label>
          <button type="submit" className="btn btn-primary btn-sm">Apply</button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => {
              setDraftFrom('');
              setDraftTo('');
              setAppliedFrom('');
              setAppliedTo('');
              setRangeError('');
            }}
          >
            All tasks
          </button>
          {rangeError && <p className="admin-simple__filter-error">{rangeError}</p>}
        </form>

        <p className="admin-simple__range-note">
          {!appliedFrom && !appliedTo
            ? `All assigned tasks · ${kpis.length}`
            : `Tasks from ${fmtDate(appliedFrom)} to ${fmtDate(appliedTo)}`}
        </p>

        {kpiLoading ? (
          <div className="admin-simple__loading"><Loader2 className="spin-icon" size={28} /></div>
        ) : visibleKpis.length === 0 ? (
          <div className="admin-simple__empty">No assigned tasks{appliedFrom || appliedTo ? ' in this date range' : ''}.</div>
        ) : (
          <div className="admin-simple__tasks dashboard-grid">
            {visibleKpis.map((kpi) => {
              const badge = kpiProgressBadge(kpi);
              const contribution = kpiScoreContribution(kpi);
              return (
                <article key={kpi.id} className={`glass-panel kpi-card kpi-card--${badge.light}`}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', marginBottom: '0.5rem' }}>
                    <span className="kpi-dept">{kpi.department || kpi.category || 'General'}</span>
                    <span className={`kpi-traffic kpi-traffic--${badge.light}`}>{badge.label}</span>
                  </div>
                  <h4>{kpi.name}</h4>
                  <span className="dept-weight-badge">{formatKpiWeight(kpi.weight)} weight</span>
                  <KpiViewedBadge kpi={kpi} />
                  <KpiAssignmentDetails kpi={kpi} />
                  <p className="kpi-score-line">
                    Weight {formatKpiWeight(kpi.weight)}
                    {kpiManagerScorePct(kpi) == null
                      ? ' · Not complete yet'
                      : ` · ${formatKpiScore(contribution)} pts`}
                  </p>
                  <div className="kpi-dates">{fmtDate(kpi.start_date)} → {fmtDate(kpi.end_date)}</div>
                  {isKpiPastDeadline(kpi) && (
                    <span style={{ display: 'block', fontSize: '0.75rem', color: 'var(--color-warning)', marginTop: '0.35rem' }}>
                      Past deadline
                    </span>
                  )}
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    style={{ marginTop: '0.75rem' }}
                    onClick={() => setEditing(kpi)}
                  >
                    <Pencil size={14} /> Edit
                  </button>
                </article>
              );
            })}
          </div>
        )}
        {editing && (
          <EditAssignedKpiModal
            kpi={editing}
            siblingKpis={kpis}
            employeeName={selected.full_name}
            employeeEmail={selected.email}
            onClose={() => setEditing(null)}
            onSaved={() => {
              setEditing(null);
              setKpiTick((n) => n + 1);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="admin-simple">
      <header className="admin-simple__head">
        <h2>Assigned tasks</h2>
        <p>Open anyone to review their KPIs. Edit records your name and the exact time.</p>
      </header>
      <input
        className="admin-simple__search"
        type="search"
        placeholder="Search name or department"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search employees"
      />
      {loading ? (
        <div className="admin-simple__loading"><Loader2 className="spin-icon" size={28} /></div>
      ) : roster.length === 0 ? (
        <div className="admin-simple__empty">No employees to show.</div>
      ) : (
        <ul className="admin-simple__list">
          {roster.map((person) => {
            const dept = deptName(person.department_id);
            return (
              <li key={person.id}>
                <button type="button" className="admin-simple__row" onClick={() => openPerson(person)}>
                  <span className="admin-simple__avatar" aria-hidden>{initials(person.full_name)}</span>
                  <span>
                    <strong className="admin-simple__name">{person.full_name}</strong>
                    <span className="admin-simple__meta">
                      {[roleLabel(person.role), dept].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
