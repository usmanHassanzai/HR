import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Profile } from '../utils/kpiHelpers';
import { karachiYearMonth } from '../utils/kpiCategories';
import {
  fetchScoreMonthStatus,
  formatScoreMonthLabel,
  monthStartIso,
  type ScoreMonthStatus,
  type ScoreMonthStatusRow,
} from '../utils/scoreWeightage';
import ScoreWeightageEmployeeView from './ScoreWeightageEmployeeView';
import ScoreWeightageManagerView from './ScoreWeightageManagerView';
import ScoreWeightageHrView from './ScoreWeightageHrView';
import ScoreWeightageAdminView from './ScoreWeightageAdminView';
import { SwNotice } from './scoreWeightageUi';

interface ScoreWeightagePanelProps {
  profile: Profile;
}

function statusLabel(status: ScoreMonthStatus): string {
  if (status === 'approved') return 'Approved';
  if (status === 'closed') return 'Closed';
  return 'Open';
}

function statusCopy(status: ScoreMonthStatus, role: string): string {
  if (status === 'approved') return 'This month is approved. Scores and bonus % stay as they were at approval.';
  if (status === 'closed') {
    return role === 'admin'
      ? 'HR has closed this month. Review the scores, then approve to lock them.'
      : 'The mix is locked. Scores still update until an admin approves the month.';
  }
  if (role === 'hr') return 'Set each department’s mix, then close the month when it is ready for approval.';
  if (role === 'manager') return 'You can adjust your own department while this month stays open.';
  if (role === 'employee') return 'Your score updates as completed tasks are counted for this month.';
  return 'HR sets the mix and closes the month. You approve it when the scores look right.';
}

export default function ScoreWeightagePanel({ profile }: ScoreWeightagePanelProps) {
  const initial = useMemo(() => karachiYearMonth(), []);
  const [year, setYear] = useState(initial.year);
  const [monthIndex, setMonthIndex] = useState(initial.monthIndex);
  const monthIso = monthStartIso(year, monthIndex);
  const [statusRow, setStatusRow] = useState<ScoreMonthStatusRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const row = await fetchScoreMonthStatus(monthIso);
      setStatusRow(row);
    } catch (e) {
      setStatusRow(null);
      setError(e instanceof Error ? e.message : 'Could not load month status');
    } finally {
      setLoading(false);
    }
  }, [monthIso]);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus, reloadToken]);

  const status = statusRow?.status ?? 'open';
  const locked = status === 'approved';
  const yearOptions = useMemo(() => {
    const y = initial.year;
    return [y - 1, y, y + 1];
  }, [initial.year]);

  const onChanged = () => setReloadToken((n) => n + 1);

  const roleView = (() => {
    if (profile.role === 'employee') {
      return <ScoreWeightageEmployeeView monthIso={monthIso} status={status} />;
    }
    if (profile.role === 'manager') {
      return (
        <ScoreWeightageManagerView
          profile={profile}
          monthIso={monthIso}
          status={status}
          locked={locked}
          onChanged={onChanged}
        />
      );
    }
    if (profile.role === 'hr') {
      return (
        <ScoreWeightageHrView
          monthIso={monthIso}
          status={status}
          locked={locked}
          onChanged={onChanged}
        />
      );
    }
    return (
      <ScoreWeightageAdminView
        monthIso={monthIso}
        status={status}
        onChanged={onChanged}
      />
    );
  })();

  return (
    <div className="sw">
      <header className="sw-card sw-hero">
        <div className="sw-toolbar">
          <div>
            <p className="sw-kicker">Score weightage</p>
            <h2>{formatScoreMonthLabel(monthIso)}</h2>
            <p className="sw-lead">
              Each person’s score combines their own KPI result with the department average. Bonus is shown as a percentage only.
            </p>
          </div>
          <div className="sw-controls">
            <label className="sw-field">
              Month
              <select
                value={monthIndex}
                onChange={(e) => setMonthIndex(Number(e.target.value))}
                aria-label="Score month"
              >
                {Array.from({ length: 12 }, (_, i) => (
                  <option key={i} value={i}>
                    {new Date(2000, i, 1).toLocaleDateString('en-GB', { month: 'long' })}
                  </option>
                ))}
              </select>
            </label>
            <label className="sw-field">
              Year
              <select
                value={year}
                onChange={(e) => setYear(Number(e.target.value))}
                aria-label="Score year"
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </label>
            <button type="button" className="btn btn-secondary sw-icon-btn" onClick={() => onChanged()} title="Reload" aria-label="Reload">
              <RefreshCw size={16} />
            </button>
          </div>
        </div>
        <div className="sw-status-row">
          <span className={`sw-badge sw-badge--${status}`}>{statusLabel(status)}</span>
          <p className="sw-status-copy">{loading ? 'Loading this month…' : statusCopy(status, profile.role)}</p>
        </div>
        {error && <SwNotice tone="error">{error}</SwNotice>}
      </header>

      {roleView}
    </div>
  );
}
