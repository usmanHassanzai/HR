import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Loader2 } from 'lucide-react';
import ScoreWeightageAuditLog from './ScoreWeightageAuditLog';
import {
  ADMIN_MAY_EDIT_SCORE_WEIGHTAGE,
  approveScoreMonth,
  downloadBonusCsv,
  fetchDepartmentWeightages,
  fetchOrgBonusList,
  formatPct,
  formatPoints,
  type DepartmentWeightageRow,
  type OrgBonusRow,
  type ScoreMonthStatus,
} from '../utils/scoreWeightage';
import { sourceLabel, SwLoading, SwMix, SwNotice, SwSection } from './scoreWeightageUi';

interface Props {
  monthIso: string;
  status: ScoreMonthStatus;
  onChanged: () => void;
}

/** Admin approves a closed month. Weightage stays read-only while ADMIN_MAY_EDIT_SCORE_WEIGHTAGE is false. */
export default function ScoreWeightageAdminView({ monthIso, status, onChanged }: Props) {
  const [weights, setWeights] = useState<DepartmentWeightageRow[]>([]);
  const [bonusRows, setBonusRows] = useState<OrgBonusRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [approving, setApproving] = useState(false);
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
      setBonusRows(bonus);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load score data');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [monthIso]);

  const approve = async () => {
    if (status !== 'closed') return;
    setApproving(true);
    setError('');
    setMsg('');
    try {
      await approveScoreMonth(monthIso);
      setMsg('Month approved and locked.');
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Approve failed');
    } finally {
      setApproving(false);
    }
  };

  if (loading) {
    return (
      <section className="sw-card">
        <SwLoading />
      </section>
    );
  }

  return (
    <>
      <SwSection
        title="Department mix"
        hint="Read only. HR sets the mix and closes the month. Approving locks every score for that month."
        actions={(
          <button
            type="button"
            className="btn btn-primary"
            disabled={status !== 'closed' || approving}
            onClick={() => void approve()}
          >
            {approving ? <Loader2 className="spin-icon" size={16} /> : <CheckCircle2 size={16} />}
            Approve month
          </button>
        )}
      >
        {error && <SwNotice tone="error">{error}</SwNotice>}
        {msg && <SwNotice tone="ok">{msg}</SwNotice>}
        {status === 'open' && (
          <SwNotice tone="info">Waiting for HR to close this month before you can approve it.</SwNotice>
        )}
        {status === 'approved' && (
          <SwNotice tone="ok">Approved. These scores stay fixed even if tasks change later.</SwNotice>
        )}
        {ADMIN_MAY_EDIT_SCORE_WEIGHTAGE ? (
          <SwNotice tone="info">Weightage editing is switched on in code, but this screen stays read-only until that editor is added.</SwNotice>
        ) : null}
        <div className="sw-table-wrap">
          <table className="sw-table">
            <thead>
              <tr>
                <th>Department</th>
                <th className="sw-numcol">Individual</th>
                <th className="sw-numcol">Team</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {weights.length === 0 ? (
                <tr>
                  <td colSpan={4} className="sw-muted">No active departments.</td>
                </tr>
              ) : weights.map((w) => (
                <tr key={w.department_id}>
                  <td className="sw-span" data-label="Department">
                    <div className="sw-dept">
                      <strong>{w.department_name}</strong>
                      <SwMix individual={w.individual_weight} team={w.team_weight} />
                    </div>
                  </td>
                  <td className="sw-numcol" data-label="Individual">{formatPoints(w.individual_weight)}</td>
                  <td className="sw-numcol" data-label="Team">{formatPoints(w.team_weight)}</td>
                  <td data-label="Source"><span className="sw-badge">{sourceLabel(w.source)}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </SwSection>

      <SwSection
        title="Scores and bonus"
        hint="Bonus is a percentage of the score. It is not a salary amount."
        actions={(
          <button
            type="button"
            className="btn btn-secondary"
            disabled={bonusRows.length === 0}
            onClick={() => downloadBonusCsv(bonusRows, monthIso)}
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
              {bonusRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="sw-muted">No scores to list for this month.</td>
                </tr>
              ) : bonusRows.map((r) => (
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

      <ScoreWeightageAuditLog monthIso={monthIso} />
    </>
  );
}
