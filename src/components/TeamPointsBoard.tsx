import { useCallback, useEffect, useState } from 'react';
import { Loader2, Star, Trophy, Users } from 'lucide-react';
import { fetchTeamPointsBoard, type TeamPointsBoardRow } from '../utils/rewardsHelpers';
import { REWARD_CATALOG_COST } from '../utils/rewardsTiers';

interface TeamPointsBoardProps {
  /** Bump to refetch after completing a KPI task. */
  refreshKey?: number | string;
  title?: string;
  description?: string;
}

function roleLabel(role: string): string {
  if (role === 'admin') return 'Admin';
  if (role === 'manager') return 'Manager';
  return 'Employee';
}

export default function TeamPointsBoard({
  refreshKey = 0,
  title = 'Team points',
  description = 'Your points and your teammates’ balances. Complete KPI tasks to improve your monthly score and earn points.',
}: TeamPointsBoardProps) {
  const [rows, setRows] = useState<TeamPointsBoardRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await fetchTeamPointsBoard());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (loading) {
    return (
      <div className="glass-panel dash-team-points dash-team-points--loading">
        <Loader2 size={22} className="spin-icon" />
      </div>
    );
  }

  const selfRow = rows.find((r) => r.is_self);
  const others = rows.filter((r) => !r.is_self);

  return (
    <div className="glass-panel dash-team-points">
      <div className="dash-team-points__head">
        <h3>
          <Users size={18} /> {title}
        </h3>
        <span className="dash-team-points__count">
          {rows.length} member{rows.length !== 1 ? 's' : ''}
        </span>
      </div>
      <p className="dash-team-points__desc">{description}</p>

      {selfRow && (
        <div className="dash-team-points__self">
          <div className="dash-team-points__self-head">
            <Trophy size={16} />
            <strong>Your points</strong>
          </div>
          <div className="dash-team-points__metrics dash-team-points__metrics--self">
            <div>
              <strong className="dash-team-points__balance">{selfRow.balance.toLocaleString()}</strong>
              <span>Balance</span>
            </div>
            <div>
              <strong>{selfRow.total_earned.toLocaleString()}</strong>
              <span>Earned</span>
            </div>
            <div>
              <strong>
                {selfRow.this_month_points != null ? `+${selfRow.this_month_points}` : '—'}
              </strong>
              <span>This month</span>
            </div>
            <div>
              <strong>
                {selfRow.this_month_score != null ? `${Math.round(selfRow.this_month_score)}%` : '—'}
              </strong>
              <span>KPI score</span>
            </div>
          </div>
          {selfRow.balance >= REWARD_CATALOG_COST && (
            <span className="dash-team-points__badge">
              <Star size={12} /> Ready to redeem
            </span>
          )}
        </div>
      )}

      {others.length === 0 ? (
        <p className="dash-team-points__empty">
          No teammates to show yet. When people share your manager or department, their points appear here.
        </p>
      ) : (
        <div className="dash-team-points__list">
          {others.map((member, index) => (
            <div
              key={member.user_id}
              className={`dash-team-points__row ${index === 0 && member.balance > 0 ? 'dash-team-points__row--top' : ''}`}
            >
              <div className="dash-team-points__identity">
                <span className="dash-team-points__rank">{index + 1}</span>
                <div>
                  <strong>{member.full_name}</strong>
                  <span>
                    {roleLabel(member.role)}
                    {member.department_name ? ` · ${member.department_name}` : ''}
                  </span>
                </div>
              </div>
              <div className="dash-team-points__metrics">
                <div>
                  <strong className="dash-team-points__balance">{member.balance.toLocaleString()}</strong>
                  <span>Balance</span>
                </div>
                <div>
                  <strong>
                    {member.this_month_points != null ? `+${member.this_month_points}` : '—'}
                  </strong>
                  <span>This month</span>
                </div>
                <div>
                  <strong>{member.total_earned.toLocaleString()}</strong>
                  <span>Earned</span>
                </div>
              </div>
              {member.balance >= REWARD_CATALOG_COST && (
                <span className="dash-team-points__badge">
                  <Star size={12} /> Can redeem
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
