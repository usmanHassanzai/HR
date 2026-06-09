import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi, calculateHealthScore } from '../utils/kpiHelpers';
import TaskList from './TaskList';
import KpiSubmissionForm from './KpiSubmissionForm';
import { PlusCircle, RefreshCw, BarChart2 } from 'lucide-react';

interface EmployeeDashboardProps {
  profile: Profile;
  readOnlyUser?: Profile | null; // For manager view-only mode
  onBackToLeaderboard?: () => void;
}

export default function EmployeeDashboard({ profile, readOnlyUser, onBackToLeaderboard }: EmployeeDashboardProps) {
  const activeUser = readOnlyUser || profile;
  const isReadOnly = !!readOnlyUser;

  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [showSubmissionForm, setShowSubmissionForm] = useState(false);

  const fetchKpis = async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('kpis')
        .select('*')
        .eq('user_id', activeUser.id)
        .order('created_at', { ascending: true });

      if (error) {
        console.error('Error fetching KPIs:', error);
      } else {
        setKpis(data || []);
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKpis();

    // Subscribe to KPI changes for this user
    const subscription = supabase
      .channel(`public:kpis:user=${activeUser.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'kpis',
        },
        () => {
          fetchKpis();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(subscription);
    };
  }, [activeUser.id]);

  const healthScore = calculateHealthScore(kpis);

  const getHealthStatusText = (score: number) => {
    if (score >= 80) return 'Excellent Health';
    if (score >= 50) return 'Needs Improvement';
    return 'Critical Attention Required';
  };

  const getHealthStatusColor = (score: number) => {
    if (score >= 80) return 'var(--color-success)';
    if (score >= 50) return 'var(--color-warning)';
    return 'var(--color-danger)';
  };

  const getCardStatusClass = (status: string) => {
    return status.replace('_', '-');
  };

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Read-Only Banner for Managers */}
      {isReadOnly && (
        <div 
          className="glass-panel" 
          style={{ 
            display: 'flex', 
            justifyContent: 'space-between', 
            alignItems: 'center', 
            padding: '1rem 1.5rem', 
            borderColor: 'var(--color-warning)',
            background: 'rgba(230, 150, 0, 0.05)'
          }}
        >
          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--color-warning)', fontWeight: 700, textTransform: 'uppercase' }}>Manager View Mode</span>
            <h3 style={{ fontSize: '1.1rem', margin: 0 }}>Viewing Dashboard for: <strong>{activeUser.full_name}</strong></h3>
          </div>
          <button className="btn btn-secondary" onClick={onBackToLeaderboard}>
            Back to Leaderboard
          </button>
        </div>
      )}

      {/* Health Dial Dashboard overview card */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
        <div className="glass-panel" style={{ display: 'flex', alignItems: 'center', gap: '2rem', borderLeft: `5px solid ${getHealthStatusColor(healthScore)}` }}>
          {/* Radial score circle */}
          <div style={{ 
            width: '90px', 
            height: '90px', 
            borderRadius: '50%', 
            border: `5px solid ${getHealthStatusColor(healthScore)}`,
            boxShadow: `0 0 15px ${getHealthStatusColor(healthScore)}50`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0
          }}>
            <span style={{ fontSize: '1.8rem', fontWeight: 800, fontFamily: 'var(--font-display)', color: 'var(--text-primary)' }}>
              {healthScore}%
            </span>
          </div>

          <div>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Overall Performance index</span>
            <h2 style={{ fontSize: '1.5rem', margin: '2px 0 4px', fontFamily: 'var(--font-display)' }}>{getHealthStatusText(healthScore)}</h2>
            <p style={{ fontSize: '0.85rem' }}>Weighted average performance calculated across {kpis.length} key metric cards.</p>
          </div>
        </div>

        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span>On Track KPIs</span>
            <strong style={{ color: 'var(--color-success)' }}>{kpis.filter(k => k.status === 'on_track').length} / {kpis.length}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span>At Risk KPIs</span>
            <strong style={{ color: 'var(--color-warning)' }}>{kpis.filter(k => k.status === 'at_risk').length} / {kpis.length}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span>Off Track KPIs</span>
            <strong style={{ color: 'var(--color-danger)' }}>{kpis.filter(k => k.status === 'off_track').length} / {kpis.length}</strong>
          </div>
        </div>
      </div>

      {/* KPI Cards and Action Panel */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: '1.5rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <BarChart2 size={22} className="text-secondary" /> KPI Cards List
        </h3>
        
        <div style={{ display: 'flex', gap: '0.75rem' }}>
          <button className="btn btn-secondary" style={{ padding: '0.65rem' }} onClick={fetchKpis} title="Reload Data">
            <RefreshCw size={16} />
          </button>
          {!isReadOnly && (
            <button className="btn btn-primary" onClick={() => setShowSubmissionForm(true)}>
              <PlusCircle size={16} /> Submit New Score
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem 0' }}>
          <RefreshCw size={36} className="animate-spin" style={{ animation: 'spin 1.5s linear infinite', color: 'var(--accent-primary)' }} />
        </div>
      ) : (
        <div className="dashboard-grid" style={{ marginTop: '0' }}>
          {kpis.map((kpi) => {
            const statusClass = getCardStatusClass(kpi.status);
            return (
              <div key={kpi.id} className={`glass-panel kpi-card ${statusClass}`}>
                
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 600, textTransform: 'uppercase' }}>
                    {kpi.category || 'General'}
                  </span>
                  <span className={`badge badge-${statusClass}`} style={{ fontSize: '0.65rem' }}>
                    {kpi.status.replace('_', ' ')}
                  </span>
                </div>

                <h4 style={{ fontSize: '1.15rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
                  {kpi.name}
                </h4>

                {kpi.description && (
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1.25rem', height: '2.5rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {kpi.description}
                  </p>
                )}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '0.5rem' }}>
                  <div>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Current / Target</span>
                    <div style={{ fontSize: '1.4rem', fontWeight: 700 }}>
                      {kpi.current_value} <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', fontWeight: 400 }}>/ {kpi.target_value}</span>
                    </div>
                  </div>
                  
                  <div style={{ fontSize: '0.65rem', color: 'var(--text-muted)', textAlign: 'right' }}>
                    <div>Weight: {kpi.weight}x</div>
                    <div style={{ marginTop: '2px' }}>
                      Updated {new Date(kpi.updated_at).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                    </div>
                  </div>
                </div>

              </div>
            );
          })}
        </div>
      )}

      {/* Tasks Panel */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.5rem' }}>
        <TaskList userId={activeUser.id} />
        
        {/* KPI Legend Card */}
        <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', margin: 0 }}>
            KPI Status Rules Legend
          </h3>
          <p style={{ fontSize: '0.85rem' }}>Individual statuses are automatically calculated by comparing current metrics against targets according to optimization directions:</p>
          
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem' }}>
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <span className="badge badge-on-track" style={{ width: '90px', justifyContent: 'center', flexShrink: 0 }}>ON TRACK</span>
              <span>Metric meets target or exceeds expectations. (within 100% of target)</span>
            </li>
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <span className="badge badge-at-risk" style={{ width: '90px', justifyContent: 'center', flexShrink: 0 }}>AT RISK</span>
              <span>Metric falls slightly below target, within boundary (+/- 15% range). Flagged for attention.</span>
            </li>
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <span className="badge badge-off-track" style={{ width: '90px', justifyContent: 'center', flexShrink: 0 }}>OFF TRACK</span>
              <span>Metric deviates critically (+/- 15% or worse) from target. Triggers auto-notifications.</span>
            </li>
          </ul>
        </div>
      </section>

      {/* KPI Submission Form Modal */}
      {showSubmissionForm && (
        <KpiSubmissionForm 
          kpis={kpis}
          userId={activeUser.id}
          onClose={() => setShowSubmissionForm(false)}
          onSuccess={fetchKpis}
        />
      )}

    </div>
  );
}
