import { useEffect, useState } from 'react';
import { Loader2, Star, Users } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { fetchTeamRewardsSummaries, TeamMemberRewards } from '../utils/rewardsHelpers';
import { Profile } from '../utils/kpiHelpers';

interface TeamEmployeePointsPanelProps {
  managerId: string;
  onSelectEmployee?: (profile: Profile) => void;
}

export default function TeamEmployeePointsPanel({ managerId, onSelectEmployee }: TeamEmployeePointsPanelProps) {
  const [team, setTeam] = useState<TeamMemberRewards[]>([]);
  const [profiles, setProfiles] = useState<Map<string, Profile>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data: reports } = await supabase.rpc('get_direct_reports', { p_manager_id: managerId });
        const profileMap = new Map<string, Profile>();
        for (const report of (reports as Profile[]) || []) {
          profileMap.set(report.id, report);
        }
        const data = await fetchTeamRewardsSummaries(managerId);
        if (!cancelled) {
          setProfiles(profileMap);
          setTeam(data);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [managerId]);

  if (loading) {
    return (
      <div className="glass-panel dash-team-points dash-team-points--loading">
        <Loader2 size={22} className="spin-icon" />
      </div>
    );
  }

  return (
    <div className="glass-panel dash-team-points">
      <div className="dash-team-points__head">
        <h3><Users size={18} /> Team rewards points</h3>
        <span className="dash-team-points__count">{team.length} employee{team.length !== 1 ? 's' : ''}</span>
      </div>
      <p className="dash-team-points__desc">Points balance for each of your direct reports.</p>

      {team.length === 0 ? (
        <p className="dash-team-points__empty">No direct reports assigned yet.</p>
      ) : (
        <div className="dash-team-points__list">
          {team.map((member, index) => (
            <div key={member.id} className={`dash-team-points__row ${index === 0 && member.summary.balance > 0 ? 'dash-team-points__row--top' : ''}`}>
              <div className="dash-team-points__identity">
                <span className="dash-team-points__rank">{index + 1}</span>
                <div>
                  <strong>{member.full_name}</strong>
                  <span>{member.email}</span>
                </div>
              </div>
              <div className="dash-team-points__metrics">
                <div>
                  <strong className="dash-team-points__balance">{member.summary.balance.toLocaleString()}</strong>
                  <span>Balance</span>
                </div>
                <div>
                  <strong>{member.summary.thisMonthPoints != null ? `+${member.summary.thisMonthPoints}` : '—'}</strong>
                  <span>This month</span>
                </div>
                <div>
                  <strong>{member.summary.totalEarned.toLocaleString()}</strong>
                  <span>Earned</span>
                </div>
              </div>
              {member.summary.canRedeem && (
                <span className="dash-team-points__badge"><Star size={12} /> Can redeem</span>
              )}
              {onSelectEmployee && profiles.has(member.id) && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => onSelectEmployee(profiles.get(member.id)!)}
                >
                  View
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
