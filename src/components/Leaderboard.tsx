import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi, getHealthTrend } from '../utils/kpiHelpers';
import {
  calculateOverallKpiScore,
  employeeKpiScoreSummary,
  formatKpiScore,
  performanceRatingColor,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { Trophy, ArrowRight, Loader2, Sparkles, AlertCircle, TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface LeaderboardProps {
  managerId: string;
  onSelectEmployee?: (profile: Profile) => void;
}

interface RankedEmployee {
  profile: Profile;
  kpis: Kpi[];
  healthScore: number;
  onTrackCount: number;
  atRiskCount: number;
  offTrackCount: number;
}

export default function Leaderboard({ managerId, onSelectEmployee }: LeaderboardProps) {
  const [rankings, setRankings] = useState<RankedEmployee[]>([]);
  const [loading, setLoading] = useState(true);

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
        setLoading(false);
        return;
      }

      const reportIds = reports.map((r) => r.id);

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
        const healthScore = calculateOverallKpiScore(empKpis);
        
        const onTrackCount = empKpis.filter(k => k.status === 'on_track').length;
        const atRiskCount = empKpis.filter(k => k.status === 'at_risk').length;
        const offTrackCount = empKpis.filter(k => k.status === 'off_track').length;

        return {
          profile: emp,
          kpis: empKpis,
          healthScore,
          onTrackCount,
          atRiskCount,
          offTrackCount
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
    fetchTeamData();

    // Subscribe to KPI changes to update leaderboard in real-time
    const subscription = supabase
      .channel(`public:leaderboard:${managerId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kpis',
        },
        () => {
          fetchTeamData({ silent: true });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [managerId]);

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
    <div className="glass-panel" style={{ padding: '1.5rem', animation: 'fadeIn 0.5s ease-out forwards' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
        <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
          <Trophy size={20} style={{ color: 'hsl(45, 90%, 50%)' }} /> Team Leaderboard
        </h3>
        <span className="badge badge-on-track" style={{ fontSize: '0.7rem' }}>
          <Sparkles size={10} style={{ marginRight: '4px' }} /> Real-time
        </span>
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
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', wordBreak: 'break-word' }}>{rank.profile.email}</span>
                  
                  <div className="leaderboard-status-row">
                    <span style={{ color: 'var(--color-success)', fontWeight: 600 }}>{rank.onTrackCount} On Track</span>
                    <span style={{ color: 'var(--text-muted)' }}>&bull;</span>
                    <span>{formatKpiWeight(employeeKpiScoreSummary(rank.kpis).totalWeight)}</span>
                    <span style={{ color: 'var(--text-muted)' }}>&bull;</span>
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
                      {formatKpiScore(rank.healthScore)}%
                    </strong>
                    <span style={{ fontSize: '0.7rem', color: performanceRatingColor(employeeKpiScoreSummary(rank.kpis).performanceRating) }}>
                      {employeeKpiScoreSummary(rank.kpis).performanceRating}
                    </span>
                    {(() => {
                      const trend = getHealthTrend(
                        rank.profile.health_score != null ? Number(rank.profile.health_score) : undefined,
                        rank.profile.previous_health_score != null ? Number(rank.profile.previous_health_score) : undefined
                      );
                      if (trend === 'up') return <TrendingUp size={16} style={{ color: 'var(--color-success)' }} />;
                      if (trend === 'down') return <TrendingDown size={16} style={{ color: 'var(--color-danger)' }} />;
                      return <Minus size={14} style={{ color: 'var(--text-muted)' }} />;
                    })()}
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
