import { useEffect, useState } from 'react';
import { Download, Loader2, Lock, LockOpen, Save } from 'lucide-react';
import ScoreWeightageAuditLog from './ScoreWeightageAuditLog';
import {
  closeScoreMonth,
  reopenScoreMonth,
  downloadBonusCsv,
  fetchDepartmentWeightages,
  fetchOrgBonusList,
  formatPct,
  formatPoints,
  upsertDepartmentWeightage,
  weightsTotalOk,
  type DepartmentWeightageRow,
  type OrgBonusRow,
  type ScoreMonthStatus,
} from '../utils/scoreWeightage';
import { sourceLabel, SwLoading, SwMix, SwNotice, SwSection } from './scoreWeightageUi';

interface Props {
  monthIso: string;
  status: ScoreMonthStatus;
  locked: boolean;
  onChanged: () => void;
}

export default function ScoreWeightageHrView({ monthIso, status, locked, onChanged }: Props) {
  const [weights, setWeights] = useState<DepartmentWeightageRow[]>([]);
  const [drafts, setDrafts] = useState<Record<string, { individual: number; team: number }>>({});
  const [bonusRows, setBonusRows] = useState<OrgBonusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [reopening, setReopening] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    setLoading(true);
    setError('');
    try {
      const [w, bonus] = await Promise.all([
        fetchDepartmentWeightages(monthIso),
        fetchOrgBonusList(monthIso),
      ]);
      setWeights(w);
      setDrafts(
        Object.fromEntries(
          w.map((row) => [row.department_id, { individual: row.individual_weight, team: row.team_weight }]),
        ),
      );
      setBonusRows(bonus);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load score weightage');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [monthIso]);

  const saveDept = async (departmentId: string) => {
    const draft = drafts[departmentId];
    if (!draft || locked) return;
    if (!weightsTotalOk(draft.individual, draft.team)) {
      setError('Weights must be between 0 and 100, with at most one decimal place, and total 100');
      return;
    }
    setBusyId(departmentId);
    setError('');
    setMsg('');
    try {
      await upsertDepartmentWeightage(departmentId, monthIso, draft.individual, draft.team);
      setMsg('Weightage saved.');
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setBusyId(null);
    }
  };

  const reopenMonth = async () => {
    if (status !== 'closed') return;
    setReopening(true);
    setError('');
    setMsg('');
    try {
      await reopenScoreMonth(monthIso);
      setMsg('Month reopened.');
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Reopen failed');
    } finally {
      setReopening(false);
    }
  };

  const closeMonth = async () => {
    if (locked || status === 'closed' || status === 'approved') return;
    setClosing(true);
    setError('');
    setMsg('');
    try {
      await closeScoreMonth(monthIso);
      setMsg('Month closed. Admin can now approve.');
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Close failed');
    } finally {
      setClosing(false);
    }
  };

  if (loading) {
    return (
      <section className="sw-card">
        <SwLoading />
      </section>
    );
  }

  const editing = !locked && status === 'open';

  return (
    <>
      <SwSection
        title="Department mix"
        hint="Each row must total 100, using numbers from 0 to 100 with at most one decimal. Close the month when HR is finished, or reopen it before approval."
        actions={(
          <>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={status !== 'closed' || reopening}
              onClick={() => void reopenMonth()}
            >
              {reopening ? <Loader2 className="spin-icon" size={16} /> : <LockOpen size={16} />}
              Reopen
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!editing || closing}
              onClick={() => void closeMonth()}
            >
              {closing ? <Loader2 className="spin-icon" size={16} /> : <Lock size={16} />}
              Close month
            </button>
          </>
        )}
      >
        {error && <SwNotice tone="error">{error}</SwNotice>}
        {msg && <SwNotice tone="ok">{msg}</SwNotice>}
        <div className="sw-table-wrap">
          <table className="sw-table">
            <thead>
              <tr>
                <th>Department</th>
                <th className="sw-numcol">Individual</th>
                <th className="sw-numcol">Team</th>
                <th>Source</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {weights.length === 0 ? (
                <tr>
                  <td colSpan={5} className="sw-muted">No active departments.</td>
                </tr>
              ) : weights.map((w) => {
                const draft = drafts[w.department_id] || { individual: w.individual_weight, team: w.team_weight };
                const ok = weightsTotalOk(draft.individual, draft.team);
                return (
                  <tr key={w.department_id}>
                    <td className="sw-span" data-label="Department">
                      <div className="sw-dept">
                        <strong>{w.department_name}</strong>
                        <SwMix individual={draft.individual} team={draft.team} />
                      </div>
                    </td>
                    <td className="sw-numcol" data-label="Individual">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={draft.individual}
                        disabled={!editing}
                        aria-label={`${w.department_name} individual weight`}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setDrafts((prev) => ({
                            ...prev,
                            [w.department_id]: { individual: v, team: Math.round((100 - v) * 10) / 10 },
                          }));
                        }}
                        className={ok ? 'sw-num' : 'sw-num sw-num--bad'}
                      />
                    </td>
                    <td className="sw-numcol" data-label="Team">
                      <input
                        type="number"
                        min={0}
                        max={100}
                        step={0.1}
                        value={draft.team}
                        disabled={!editing}
                        aria-label={`${w.department_name} team weight`}
                        onChange={(e) => {
                          const v = Number(e.target.value);
                          setDrafts((prev) => ({
                            ...prev,
                            [w.department_id]: { individual: Math.round((100 - v) * 10) / 10, team: v },
                          }));
                        }}
                        className={ok ? 'sw-num' : 'sw-num sw-num--bad'}
                      />
                    </td>
                    <td data-label="Source"><span className="sw-badge">{sourceLabel(w.source)}</span></td>
                    <td data-label="Save">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={!editing || !ok || busyId === w.department_id}
                        onClick={() => void saveDept(w.department_id)}
                      >
                        {busyId === w.department_id ? <Loader2 className="spin-icon" size={14} /> : <Save size={14} />}
                        Save
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </SwSection>

      <BonusTable rows={bonusRows} monthIso={monthIso} empty="No employees to list for this month." />
      <ScoreWeightageAuditLog monthIso={monthIso} />
    </>
  );
}

function BonusTable({ rows, monthIso, empty }: { rows: OrgBonusRow[]; monthIso: string; empty: string }) {
  return (
    <SwSection
      title="Scores and bonus"
      hint="Bonus is a percentage of the score. It is not a salary amount."
      actions={(
        <button
          type="button"
          className="btn btn-secondary"
          disabled={rows.length === 0}
          onClick={() => downloadBonusCsv(rows, monthIso)}
        >
          <Download size={16} /> Export CSV
        </button>
      )}
    >
      <div className="sw-table-wrap">
        <table className="sw-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Department</th>
              <th className="sw-numcol">Own points</th>
              <th className="sw-numcol">Team points</th>
              <th className="sw-numcol">Score</th>
              <th className="sw-numcol">Bonus</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="sw-muted">{empty}</td>
              </tr>
            ) : rows.map((r) => (
              <tr key={r.user_id}>
                <td className="sw-person" data-label="Person">{r.full_name}</td>
                <td data-label="Department">{r.department_name}</td>
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
  );
}
