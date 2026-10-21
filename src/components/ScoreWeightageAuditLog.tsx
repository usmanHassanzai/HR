import { useEffect, useState } from 'react';
import { fetchScoreWeightageLog, type ScoreWeightageLogRow } from '../utils/scoreWeightage';
import { SwLoading, SwNotice, SwSection } from './scoreWeightageUi';

function pair(individual: number | null, team: number | null): string {
  if (individual == null || team == null) return '—';
  return `${individual} / ${team}`;
}

function oldText(row: ScoreWeightageLogRow): string {
  if (row.old_status || row.new_status) return row.old_status || '—';
  return pair(row.old_individual, row.old_team);
}

function newText(row: ScoreWeightageLogRow): string {
  if (row.old_status || row.new_status) return row.new_status || '—';
  return pair(row.new_individual, row.new_team);
}

function whenLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}

export default function ScoreWeightageAuditLog({ monthIso }: { monthIso: string }) {
  const [rows, setRows] = useState<ScoreWeightageLogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError('');
    void fetchScoreWeightageLog(monthIso)
      .then((data) => {
        if (!cancelled) setRows(data);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load the audit log');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [monthIso]);

  return (
    <SwSection
      title="Activity"
      hint="Weight changes show the old and new mix. Close, reopen, and approve show the month status."
    >
      {loading ? <SwLoading /> : error ? <SwNotice tone="error">{error}</SwNotice> : (
        <div className="sw-table-wrap">
          <table className="sw-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>Role</th>
                <th>Department</th>
                <th className="sw-numcol">From</th>
                <th className="sw-numcol">To</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6} className="sw-muted">No changes recorded for this month.</td>
                </tr>
              ) : rows.map((r) => (
                <tr key={r.id}>
                  <td data-label="When">{whenLabel(r.changed_at)}</td>
                  <td className="sw-person" data-label="Who">{r.changed_by_name || '—'}</td>
                  <td data-label="Role"><span className="sw-badge">{r.changed_by_role || '—'}</span></td>
                  <td data-label="Department">{r.department_name || 'Whole month'}</td>
                  <td className="sw-numcol" data-label="From">{oldText(r)}</td>
                  <td className="sw-numcol" data-label="To"><strong>{newText(r)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SwSection>
  );
}
