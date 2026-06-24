import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi, calculateHealthScore } from '../utils/kpiHelpers';
import TaskList from './TaskList';
import { RefreshCw, BarChart2, Sparkles, Trophy, KeyRound, CheckCircle2, CalendarCheck } from 'lucide-react';
import ExportButton from './ExportButton';
import RewardsTab from './RewardsTab';
import AttendanceLeavePanel from './AttendanceLeavePanel';
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
  const [activeTab, setActiveTab] = useState<'kpis' | 'rewards' | 'attendance'>('kpis');
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
        <div className="glass-panel dash-view-banner mobile-banner-row">
          <div>
            <span className="dash-eyebrow" style={{ color: 'var(--color-warning)' }}>Manager View Mode</span>
            <h3>Viewing Dashboard for: <strong>{activeUser.full_name}</strong></h3>
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
            { id: 'attendance', label: 'Attendance & Leave', mobileLabel: 'Leave', icon: <CalendarCheck size={15} /> },
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

      {activeTab === 'attendance' && !isReadOnly ? (
        <AttendanceLeavePanel profile={profile} mode={profile.role === 'manager' ? 'manager' : 'employee'} />
      ) : null}

      {activeTab === 'kpis' && (
      <>

      {/* Health overview */}
      <div className="dash-hero-grid">
        <div
          className="glass-panel dash-health-card"
          style={{ borderLeftColor: getHealthStatusColor(healthScore) }}
        >
          <div
            className="dash-health-ring"
            style={{
              borderColor: getHealthStatusColor(healthScore),
              boxShadow: `0 0 20px color-mix(in srgb, ${getHealthStatusColor(healthScore)} 35%, transparent)`,
            }}
          >
            <span className="dash-health-ring__value">{healthScore}%</span>
          </div>
          <div>
            <span className="dash-eyebrow">Overall performance index</span>
            <h2>{getHealthStatusText(healthScore)}</h2>
            <p>Based on {kpis.length} assigned KPI tasks — complete before each deadline.</p>
          </div>
        </div>

        <div className="glass-panel dash-metrics-panel">
          <div className="dash-metric-row">
            <span>Completed</span>
            <strong style={{ color: 'var(--accent-primary)' }}>{kpis.filter(k => k.completion_status === 'completed').length} / {kpis.length}</strong>
          </div>
          <div className="dash-metric-row">
            <span>On Track KPIs</span>
            <strong style={{ color: 'var(--color-success)' }}>{kpis.filter(k => k.status === 'on_track').length} / {kpis.length}</strong>
          </div>
          <div className="dash-metric-row">
            <span>At Risk KPIs</span>
            <strong style={{ color: 'var(--color-warning)' }}>{kpis.filter(k => k.status === 'at_risk').length} / {kpis.length}</strong>
          </div>
          <div className="dash-metric-row">
            <span>Off Track KPIs</span>
            <strong style={{ color: 'var(--color-danger)' }}>{kpis.filter(k => k.status === 'off_track').length} / {kpis.length}</strong>
          </div>
        </div>
      </div>

      <div className="dash-section-head">
        <h3><BarChart2 size={22} /> My KPI tasks</h3>
        
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <ExportButton kpis={kpis} userName={activeUser.full_name} />
          <button className="btn btn-secondary" style={{ padding: '0.65rem' }} onClick={fetchKpis} title="Reload Data">
            <RefreshCw size={16} />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="dash-loading">
          <RefreshCw size={36} className="animate-spin" style={{ animation: 'spin 1.5s linear infinite' }} />
        </div>
      ) : (
        <div className="dashboard-grid" style={{ marginTop: '0' }}>
          {kpis.map((kpi) => {
            const statusClass = getCardStatusClass(kpi.status);
            return (
              <div key={kpi.id} className={`glass-panel kpi-card ${statusClass}`}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '0.75rem' }}>
                  <span className="kpi-dept">{kpi.department || kpi.category || 'General'}</span>
                  <span className={`badge badge-${kpi.completion_status === 'completed' ? 'on-track' : statusClass}`} style={{ fontSize: '0.65rem' }}>
                    {kpi.completion_status === 'completed' ? 'completed' : kpi.status.replace('_', ' ')}
                  </span>
                </div>

                <h4>{kpi.name}</h4>

                {kpi.ai_narrative ? (
                  <p className="kpi-ai-note" style={{ marginBottom: '1rem' }}>
                    <Sparkles size={12} style={{ flexShrink: 0, marginTop: '2px' }} />
                    <span>{kpi.ai_narrative}</span>
                  </p>
                ) : kpi.description ? (
                  <p className="kpi-desc" style={{ marginBottom: '1.25rem' }}>{kpi.description}</p>
                ) : null}

                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: '0.75rem', flexWrap: 'wrap', gap: '0.75rem' }}>
                  <div>
                    <span className="kpi-date-label">Start → End</span>
                    <div className="kpi-dates">{fmtDate(kpi.start_date)} → {fmtDate(kpi.end_date)}</div>
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
        <div className="glass-panel dash-info-panel">
          <h3 className="dash-panel-title">KPI status guide</h3>
          <p className="dash-panel-desc">KPIs are assigned by your manager with start/end dates. Complete before the deadline — 3 missed deadlines deduct 300 points.</p>
          <ul>
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
