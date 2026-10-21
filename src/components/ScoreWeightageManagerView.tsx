import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import type { Profile } from '../utils/kpiHelpers';
import {
  fetchDepartmentScoreResults,
  fetchDepartmentWeightages,
  formatPct,
  formatPoints,
  upsertDepartmentWeightage,
  weightsTotalOk,
  type DepartmentWeightageRow,
  type ScoreMonthStatus,
  type ScoreResultRow,
} from '../utils/scoreWeightage';
import { sourceLabel, SwLoading, SwMix, SwNotice, SwSection } from './scoreWeightageUi';

interface Props {
  profile: Profile;
  monthIso: string;
  status: ScoreMonthStatus;
  locked: boolean;
  onChanged: () => void;
}

export default function ScoreWeightageManagerView({
  profile,
  monthIso,
  status,
  locked,
  onChanged,
}: Props) {
  const [weight, setWeight] = useState<DepartmentWeightageRow | null>(null);
  const [individual, setIndividual] = useState(80);
  const [team, setTeam] = useState(20);
  const [rows, setRows] = useState<ScoreResultRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const canEdit = !locked && status === 'open' && Boolean(profile.department_id);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const weights = await fetchDepartmentWeightages(monthIso);
        const mine = weights.find((w) => w.department_id === profile.department_id) || null;
        if (cancelled) return;
        setWeight(mine);
        if (mine) {
          setIndividual(mine.individual_weight);
          setTeam(mine.team_weight);
        }
        if (profile.department_id) {
          const results = await fetchDepartmentScoreResults(profile.department_id, monthIso);
          if (!cancelled) setRows(results);
        } else {
          setRows([]);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load department scores');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [monthIso, profile.department_id, reloadToken]);

  const save = async () => {
    if (!profile.department_id || !canEdit) return;
    if (!weightsTotalOk(individual, team)) {
      setError('Weights must be between 0 and 100, with at most one decimal place, and total 100');
      return;
    }
    setSaving(true);
    setError('');
    setMsg('');
    try {
      await upsertDepartmentWeightage(profile.department_id, monthIso, individual, team);
      setMsg('Weightage saved.');
      setReloadToken((n) => n + 1);
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <section className="sw-card">
        <SwLoading />
      </section>
    );
  }

  const totalOk = weightsTotalOk(individual, team);
  const sourceNote = weight?.source && weight.source !== 'stored'
    ? ` Currently showing ${sourceLabel(weight.source).toLowerCase()} until you save.`
    : '';

  return (
    <>
      <SwSection
        title={`${weight?.department_name || 'My department'} mix`}
        hint={`Change the individual and team split while the month is open.${sourceNote}`}
      >
        {!profile.department_id ? (
          <SwNotice tone="info">You are not assigned to a department, so there is no mix to edit.</SwNotice>
        ) : (
          <>
            <SwMix individual={individual} team={team} large />
            <ul className="sw-legend">
              <li><i className="sw-mix__ind" /> Individual</li>
              <li><i className="sw-mix__team" /> Team</li>
            </ul>
            <div className="sw-editor">
              <label className="sw-field">
                Individual
                <input
                  className={totalOk ? 'sw-num' : 'sw-num sw-num--bad'}
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={individual}
                  disabled={!canEdit || saving}
                  aria-label="Individual weight"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setIndividual(v);
                    setTeam(Math.round((100 - v) * 10) / 10);
                  }}
                />
              </label>
              <label className="sw-field">
                Team
                <input
                  className={totalOk ? 'sw-num' : 'sw-num sw-num--bad'}
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={team}
                  disabled={!canEdit || saving}
                  aria-label="Team weight"
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setTeam(v);
                    setIndividual(Math.round((100 - v) * 10) / 10);
                  }}
                />
              </label>
              <span className={totalOk ? 'sw-total sw-total--ok' : 'sw-total sw-total--bad'}>
                Total {Number.isFinite(individual + team) ? (individual + team).toFixed(1) : '—'}
              </span>
              <button type="button" className="btn btn-primary" disabled={!canEdit || saving} onClick={() => void save()}>
                {saving ? <Loader2 className="spin-icon" size={16} /> : <Save size={16} />}
                Save mix
              </button>
            </div>
          </>
        )}
        {error && <SwNotice tone="error">{error}</SwNotice>}
        {msg && <SwNotice tone="ok">{msg}</SwNotice>}
      </SwSection>

      <SwSection title="Department scores" hint="Everyone in the department, including people with no completed tasks.">
        <div className="sw-table-wrap">
          <table className="sw-table">
            <thead>
              <tr>
                <th>Person</th>
                <th className="sw-numcol">Own KPI</th>
                <th className="sw-numcol">Team avg</th>
                <th className="sw-numcol">Own points</th>
                <th className="sw-numcol">Team points</th>
                <th className="sw-numcol">Score</th>
                <th className="sw-numcol">Bonus</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="sw-muted">No one in this department for the selected month.</td>
                </tr>
              ) : rows.map((r) => (
                <tr key={r.user_id}>
                  <td className="sw-person" data-label="Person">{r.full_name}</td>
                  <td className="sw-numcol" data-label="Own KPI">{formatPct(r.individual_kpi_pct)}</td>
                  <td className="sw-numcol" data-label="Team avg">{formatPct(r.team_avg_kpi_pct)}</td>
                  <td className="sw-numcol" data-label="Own points">{formatPoints(r.individual_points)}</td>
                  <td className="sw-numcol" data-label="Team points">{formatPoints(r.team_points)}</td>
                  <td className="sw-numcol sw-score-cell" data-label="Score">{formatPoints(r.score)}</td>
                  <td className="sw-numcol" data-label="Bonus">
                    <span className={Number(r.bonus_pct) > 0 ? 'sw-badge sw-badge--score' : 'sw-badge sw-badge--zero'}>
                      {formatPct(r.bonus_pct)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SwSection>
    </>
  );
}
