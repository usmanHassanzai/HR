import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi } from '../utils/kpiHelpers';
import {
  employeeKpiScoreSummary,
  formatKpiScore,
  performanceRatingColor,
  thisMonthKpiScore,
} from '../utils/kpiScoreHelpers';
import { Trophy, ArrowRight, Loader2, AlertCircle } from 'lucide-react';

interface LeaderboardProps {
  managerId: string;
  onSelectEmployee?: (profile: Profile) => void;
}

interface RankedEmployee {
  profile: Profile;
  kpis: Kpi[];
  healthScore: number;
}

export default function Leaderboard({ managerId, onSelectEmployee }: LeaderboardProps) {
  const [rankings, setRankings] = useState<RankedEmployee[]>([]);
  const [loading, setLoading] = useState(true);
  const [teamIds, setTeamIds] = useState<string[]>([]);

  const fetchTeamData = async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      // 1. Fetch direct reports
      const { data: reportsData, error: reportsError } = await supabase
        .rpc('get_direct_reports', { p_manager_id: managerId });

      if (reportsError) {
        console.error('Error fetching direct reports:', reportsError);
        setLoading(false);
        return;
      }

      const reports = (reportsData || []) as Profile[];

      if (reports.length === 0) {
        setRankings([]);
        setTeamIds([]);
        setLoading(false);
        return;
      }

      const reportIds = reports.map((r) => r.id);
      setTeamIds(reportIds);

      // 2. Fetch all KPIs for these reports
      const { data: kpis, error: kpisError } = await supabase
        .from('kpis')
        .select('*')
        .in('user_id', reportIds);

      if (kpisError) {
        console.error('Error fetching team KPIs:', kpisError);
        setLoading(false);
        return;
      }

      // 3. Process and rank
      const list: RankedEmployee[] = reports.map((emp) => {
        const empKpis = ((kpis || []) as Kpi[]).filter((k) => k.user_id === emp.id);
        const healthScore = thisMonthKpiScore(empKpis);
        
        return {
          profile: emp,
          kpis: empKpis,
          healthScore,
        };
      });

      // Sort by health score descending
      list.sort((a, b) => b.healthScore - a.healthScore);
      setRankings(list);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void fetchTeamData();
  }, [managerId]);

  useEffect(() => {
    if (teamIds.length === 0) return;
    let debounce: number | null = null;
    const filter = `user_id=in.(${teamIds.join(',')})`;
    const subscription = supabase
      .channel(`public:leaderboard:${managerId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kpis',
          filter,
        },
        () => {
          if (debounce != null) window.clearTimeout(debounce);
          debounce = window.setTimeout(() => {
            debounce = null;
            void fetchTeamData({ silent: true });
          }, 900);
        },
      )
      .subscribe();

    return () => {
      if (debounce != null) window.clearTimeout(debounce);
      supabase.removeChannel(subscription);
    };
  }, [managerId, teamIds.join(',')]);

  if (loading && rankings.length === 0) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', padding: '3rem 0' }}>
        <Loader2 size={32} className="animate-spin" style={{ animation: 'spin 1s linear infinite', color: 'var(--accent-primary)' }} />
      </div>
    );
  }

  const getRankBadgeColor = (index: number) => {
    switch (index) {
      case 0: return 'hsl(45, 90%, 50%)'; // Gold
      case 1: return 'hsl(0, 0%, 75%)';   // Silver
      case 2: return 'hsl(30, 60%, 45%)';  // Bronze
      default: return 'var(--text-muted)';
    }
  };

  return (
    <div className="glass-panel emp-dir__board">
      <div className="emp-dir__board-head">
        <h3>
          <Trophy size={18} /> Team
        </h3>
      </div>

      {rankings.length === 0 ? (
        <div style={{ padding: '3rem 1rem', textAlign: 'center', color: 'var(--text-muted)' }}>
          <AlertCircle size={24} style={{ display: 'block', margin: '0 auto 0.5rem', color: 'var(--text-muted)' }} />
          No team members report to you.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {rankings.map((rank, index) => (
            <div 
              key={rank.profile.id}
              onClick={() => onSelectEmployee && onSelectEmployee(rank.profile)}
              className={`leaderboard-item ${onSelectEmployee ? 'leaderboard-item--clickable' : ''}`}
            >
              <div className="leaderboard-item-main">
                <span style={{ 
                  fontFamily: 'var(--font-display)', 
                  fontWeight: 800, 
                  fontSize: '1.1rem',
                  color: getRankBadgeColor(index),
                  width: '24px',
                  textAlign: 'center',
                  flexShrink: 0,
                }}>
                  #{index + 1}
                </span>
                
                <div style={{ minWidth: 0 }}>
                  <strong style={{ display: 'block', fontSize: '0.95rem' }}>{rank.profile.full_name}</strong>
                  <div className="leaderboard-status-row">
                    <span>{rank.kpis.length} KPI{rank.kpis.length !== 1 ? 's' : ''}</span>
                  </div>
                </div>
              </div>

              <div className="leaderboard-item-score">
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', display: 'block', textTransform: 'uppercase' }}>Overall KPI Score</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', justifyContent: 'flex-end' }}>
                    <strong style={{ 
                      fontSize: '1.25rem', 
                      fontFamily: 'var(--font-display)', 
                      color: performanceRatingColor(employeeKpiScoreSummary(rank.kpis).performanceRating)
                    }}>
                      {formatKpiScore(rank.healthScore)}
                    </strong>
                    <span style={{ fontSize: '0.7rem', color: performanceRatingColor(employeeKpiScoreSummary(rank.kpis).performanceRating) }}>
                      {employeeKpiScoreSummary(rank.kpis).performanceRating}
                    </span>
                  </div>
                </div>

                {onSelectEmployee && (
                  <ArrowRight size={16} style={{ color: 'var(--text-muted)', opacity: 0.6 }} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
