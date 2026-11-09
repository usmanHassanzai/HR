import { useEffect, useState } from 'react';
import {
  fetchMyScoreWeightage,
  formatPct,
  formatPoints,
  type MyScoreWeightage,
  type ScoreMonthStatus,
} from '../utils/scoreWeightage';
import { sourceLabel, SwLoading, SwMix, SwNotice } from './scoreWeightageUi';

interface Props {
  monthIso: string;
  status: ScoreMonthStatus;
}

export default function ScoreWeightageEmployeeView({ monthIso, status }: Props) {
  const [row, setRow] = useState<MyScoreWeightage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void fetchMyScoreWeightage(monthIso)
      .then((data) => {
        if (!cancelled) setRow(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load your score');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [monthIso]);

  if (loading) {
    return (
      <section className="sw-card">
        <SwLoading />
      </section>
    );
  }
  if (error) {
    return (
      <section className="sw-card">
        <SwNotice tone="error">{error}</SwNotice>
      </section>
    );
  }
  if (!row) return null;

  const missing = row.score == null && row.individual_weight == null;
  const weightNote = row.weight_source && row.weight_source !== 'stored'
    ? sourceLabel(row.weight_source)
    : null;

  return (
    <section className="sw-card">
      <header className="sw-card__head">
        <div>
          <p className="sw-kicker">My score</p>
          <h3>{row.department_name || 'No department assigned'}</h3>
          <p>
            {weightNote ? `Weights: ${weightNote}. ` : ''}
            Individual points and team points are each rounded to one decimal, then added. Bonus % comes from that score.
          </p>
        </div>
      </header>

      {missing ? (
        <SwNotice tone="info">
          {status === 'approved'
            ? 'This approved month has no saved score for you.'
            : 'Your score will appear here once you are in an active department.'}
        </SwNotice>
      ) : (
        <>
          <div className="sw-scoreboard">
            <div className="sw-score-main">
              <span>Score</span>
              <strong>{formatPoints(row.score)}</strong>
            </div>
            <div className="sw-bonus-main">
              <span>Bonus</span>
              <strong>{formatPct(row.bonus_pct)}</strong>
            </div>
          </div>

          {row.individual_weight != null && row.team_weight != null && (
            <>
              <SwMix individual={row.individual_weight} team={row.team_weight} large />
              <ul className="sw-legend">
                <li><i className="sw-mix__ind" /> Individual {formatPoints(row.individual_weight)}</li>
                <li><i className="sw-mix__team" /> Team {formatPoints(row.team_weight)}</li>
              </ul>
            </>
          )}

          <div className="sw-split">
            <article className="sw-metric">
              <span>Individual</span>
              <strong>{formatPoints(row.individual_points)}</strong>
              <em>KPI {formatPct(row.individual_kpi_pct)}</em>
            </article>
            <article className="sw-metric">
              <span>Team</span>
              <strong>{formatPoints(row.team_points)}</strong>
              <em>Department average {formatPct(row.team_avg_kpi_pct)}</em>
            </article>
          </div>
          <p className="sw-sum">
            <b>{formatPoints(row.individual_points)}</b>
            <span>+</span>
            <b>{formatPoints(row.team_points)}</b>
            <span>=</span>
            <span className="sw-sum__eq">{formatPoints(row.score)}</span>
          </p>
        </>
      )}
    </section>
  );
}
