import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi, calculateHealthScore } from '../utils/kpiHelpers';
import TaskList from './TaskList';
import { RefreshCw, BarChart2, Sparkles, Trophy, KeyRound, CheckCircle2 } from 'lucide-react';
import ExportButton from './ExportButton';
import RewardsTab from './RewardsTab';
import ChangePasswordModal from './ChangePasswordModal';
import { emailKpiCompleted, emailKpiOverdue } from '../utils/kpiEmail';
import DashboardTabNav from './DashboardTabNav';

interface EmployeeDashboardProps {
  profile: Profile;
  readOnlyUser?: Profile | null; // For manager view-only mode
  onBackToLeaderboard?: () => void;
  hideChangePassword?: boolean; // Manager dashboard already shows it in the parent tab bar
}

export default function EmployeeDashboard({ profile, readOnlyUser, onBackToLeaderboard, hideChangePassword }: EmployeeDashboardProps) {
  const activeUser = readOnlyUser || profile;
  const isReadOnly = !!readOnlyUser;

  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [persistedHealthScore, setPersistedHealthScore] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'kpis' | 'rewards'>('kpis');
  const [showChangePassword, setShowChangePassword] = useState(false);

  const [completingId, setCompletingId] = useState<string | null>(null);

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

      const { data: userData } = await supabase
        .from('users')
        .select('health_score')
        .eq('id', activeUser.id)
        .single();

      if (userData?.health_score != null) {
        setPersistedHealthScore(Number(userData.health_score));
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchKpis();
    if (!isReadOnly) {
      supabase.rpc('check_overdue_kpis').then(({ data }) => {
        (data || []).forEach((row: any) => {
          if (row.emp_email) emailKpiOverdue(row.emp_email, row.emp_name, row.department, row.end_date, row.redo_count);
        });
      });
    }

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

  const healthScore = persistedHealthScore ?? calculateHealthScore(kpis);

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

  const handleCompleteKpi = async (kpiId: string) => {
    setCompletingId(kpiId);
    try {
      const { data, error } = await supabase.rpc('complete_kpi_employee', { p_kpi_id: kpiId });
      if (error) throw error;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.manager_email) {
        await emailKpiCompleted(row.manager_email, row.manager_name, activeUser.full_name, row.department);
      }
      fetchKpis();
    } catch (err: any) {
      alert(err.message || 'Could not mark complete.');
    } finally {
      setCompletingId(null);
    }
  };

  const fmtDate = (d?: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString() : '—';

  const getCardStatusClass = (status: string) => {
    return status.replace('_', '-');
  };

  return (
    <div className={`animate-fade-in ${!isReadOnly && !hideChangePassword ? 'dashboard-with-mobile-nav' : ''}`} style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {/* Read-Only Banner for Managers */}
      {isReadOnly && (
        <div 
          className="glass-panel mobile-banner-row" 
          style={{ 
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

      {/* Tab switcher */}
      {!isReadOnly && (
        <DashboardTabNav
          activeTab={activeTab}
          onTabChange={(id) => setActiveTab(id as typeof activeTab)}
          mobilePlacement={hideChangePassword ? 'inline' : 'bottom'}
          tabs={[
            { id: 'kpis', label: 'My KPIs', mobileLabel: 'KPIs', icon: <BarChart2 size={15} /> },
            { id: 'rewards', label: 'Rewards & Points', mobileLabel: 'Rewards', icon: <Trophy size={15} /> },
          ]}
          actions={
            hideChangePassword
              ? []
              : [
                  {
                    id: 'password',
                    label: 'Change Password',
                    mobileLabel: 'Password',
                    icon: <KeyRound size={15} />,
                    onClick: () => setShowChangePassword(true),
                  },
                ]
          }
        />
      )}

      {!hideChangePassword && showChangePassword && (
        <ChangePasswordModal onClose={() => setShowChangePassword(false)} />
      )}

      {activeTab === 'rewards' && !isReadOnly ? (
        <RewardsTab userId={activeUser.id} viewerRole={profile.role === 'manager' ? 'manager' : 'employee'} />
      ) : null}

      {activeTab !== 'rewards' && (
      <>

      {/* Health Dial Dashboard overview card */}
      <div className="responsive-grid-2">
        <div className="glass-panel health-overview-card" style={{ borderLeft: `5px solid ${getHealthStatusColor(healthScore)}` }}>
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
            <p style={{ fontSize: '0.85rem' }}>Based on {kpis.length} assigned KPI tasks — complete before each deadline.</p>
          </div>
        </div>

        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: '0.5rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            <span>Completed</span>
            <strong style={{ color: 'var(--accent-primary)' }}>{kpis.filter(k => k.completion_status === 'completed').length} / {kpis.length}</strong>
          </div>
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
      <div className="section-header-row">
        <h3 style={{ fontSize: '1.5rem', fontFamily: 'var(--font-display)', display: 'flex', alignItems: 'center', gap: '0.5rem', margin: 0 }}>
          <BarChart2 size={22} className="text-secondary" /> KPI Cards List
        </h3>
        
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <ExportButton kpis={kpis} userName={activeUser.full_name} />
          <button className="btn btn-secondary" style={{ padding: '0.65rem' }} onClick={fetchKpis} title="Reload Data">
            <RefreshCw size={16} />
          </button>
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
                    {kpi.department || kpi.category || 'General'}
                  </span>
                  <span className={`badge badge-${kpi.completion_status === 'completed' ? 'on-track' : statusClass}`} style={{ fontSize: '0.65rem' }}>
                    {kpi.completion_status === 'completed' ? 'completed' : kpi.status.replace('_', ' ')}
                  </span>
                </div>

                <h4 style={{ fontSize: '1.15rem', fontWeight: 600, marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
                  {kpi.name}
                </h4>

                {kpi.ai_narrative ? (
                  <p style={{
                    fontSize: '0.75rem',
                    color: 'var(--accent-primary)',
                    marginBottom: '1rem',
                    display: 'flex',
                    gap: '0.35rem',
                    alignItems: 'flex-start',
                    lineHeight: 1.4
                  }}>
                    <Sparkles size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <span>{kpi.ai_narrative}</span>
                  </p>
                ) : kpi.description ? (
                  <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '1.25rem', height: '2.5rem', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {kpi.description}
                  </p>
                ) : null}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '0.75rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <div>
                    <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>Start → End</span>
                    <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>{fmtDate(kpi.start_date)} → {fmtDate(kpi.end_date)}</div>
                    {(kpi.redo_count ?? 0) > 0 && (
                      <span style={{ fontSize: '0.7rem', color: 'var(--color-warning)' }}>Missed deadlines: {kpi.redo_count}/3</span>
                    )}
                  </div>
                  {!isReadOnly && kpi.completion_status !== 'completed' && (
                    <button
                      className="btn btn-primary btn-sm"
                      disabled={completingId === kpi.id}
                      onClick={() => handleCompleteKpi(kpi.id)}
                    >
                      <CheckCircle2 size={14} /> {completingId === kpi.id ? 'Saving…' : 'Mark Complete'}
                    </button>
                  )}
                </div>

              </div>
            );
          })}
        </div>
      )}

      {/* Tasks Panel */}
      <section className="responsive-grid-wide">
        <TaskList userId={activeUser.id} />
        
        {/* KPI Legend Card */}
        <div className="glass-panel" style={{ padding: '1.5rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem', margin: 0 }}>
            KPI Status Rules Legend
          </h3>
          <p style={{ fontSize: '0.85rem' }}>KPIs are assigned by your manager with start/end dates. Complete before the deadline — 3 missed deadlines deduct 300 points.</p>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: '0.75rem', fontSize: '0.85rem' }}>
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <span className="badge badge-on-track" style={{ width: '90px', justifyContent: 'center', flexShrink: 0 }}>ON TRACK</span>
              <span>KPI completed on time.</span>
            </li>
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <span className="badge badge-at-risk" style={{ width: '90px', justifyContent: 'center', flexShrink: 0 }}>AT RISK</span>
              <span>In progress — deadline approaching.</span>
            </li>
            <li style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
              <span className="badge badge-off-track" style={{ width: '90px', justifyContent: 'center', flexShrink: 0 }}>OFF TRACK</span>
              <span>Past end date without completion — manager notified.</span>
            </li>
          </ul>
        </div>
      </section>

      </> // end KPI tab content
      )}

    </div>
  );
}
