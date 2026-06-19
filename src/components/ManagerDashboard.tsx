import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import Leaderboard from './Leaderboard';
import EmployeeDashboard from './EmployeeDashboard';
import ManagerKpiConfig from './ManagerKpiConfig';
import { Users, BarChart3, ShieldAlert, KeyRound, Trophy, Settings } from 'lucide-react';
import ChangePasswordModal from './ChangePasswordModal';
import ManagerRewardsPanel from './ManagerRewardsPanel';

interface ManagerDashboardProps {
  profile: Profile;
}

export default function ManagerDashboard({ profile }: ManagerDashboardProps) {
  const [selectedEmployee, setSelectedEmployee] = useState<Profile | null>(null);
  const [activeTab, setActiveTab] = useState<'team' | 'kpis' | 'rewards' | 'personal'>('team');
  const [alertCount, setAlertCount] = useState(0);
  const [showChangePassword, setShowChangePassword] = useState(false);

  useEffect(() => {
    const fetchAlerts = async () => {
      await supabase.rpc('check_overdue_kpis');
      const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', profile.id)
        .in('type', ['alert', 'escalation'])
        .eq('is_read', false);

      setAlertCount(count || 0);
    };

    fetchAlerts();

    const subscription = supabase
      .channel(`manager-alerts:${profile.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'notifications' }, fetchAlerts)
      .subscribe();

    return () => { supabase.removeChannel(subscription); };
  }, [profile.id]);

  const handleSelectEmployee = (employeeProfile: Profile) => {
    setSelectedEmployee(employeeProfile);
  };

  const handleBackToLeaderboard = () => {
    setSelectedEmployee(null);
  };

  // If a manager clicks to drill down into an employee profile, load the EmployeeDashboard in Read-only view
  if (selectedEmployee) {
    return (
      <EmployeeDashboard 
        profile={profile} 
        readOnlyUser={selectedEmployee} 
        onBackToLeaderboard={handleBackToLeaderboard}
      />
    );
  }

  return (
    <div className="animate-fade-in" style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

      <div className="tab-bar">
        <button className={`tab-btn ${activeTab === 'team' ? 'tab-btn--active' : ''}`} onClick={() => setActiveTab('team')}>
          <Users size={16} /> Team Performance
        </button>
        <button className={`tab-btn ${activeTab === 'kpis' ? 'tab-btn--active' : ''}`} onClick={() => setActiveTab('kpis')}>
          <Settings size={16} /> KPI Config
        </button>
        <button className={`tab-btn ${activeTab === 'rewards' ? 'tab-btn--active' : ''}`} onClick={() => setActiveTab('rewards')}>
          <Trophy size={16} /> Team Rewards
        </button>
        <button className={`tab-btn ${activeTab === 'personal' ? 'tab-btn--active' : ''}`} onClick={() => setActiveTab('personal')}>
          <BarChart3 size={16} /> My KPIs & Points
        </button>
        <button className="tab-btn tab-btn--utility" onClick={() => setShowChangePassword(true)}>
          <KeyRound size={16} /> Change Password
        </button>
      </div>

      {activeTab === 'team' ? (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
          {/* Quick Metrics Panel */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem' }}>
            <div className="glass-panel" style={{ borderLeft: '4px solid var(--accent-primary)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Direct Reports</span>
              <h3 style={{ fontSize: '1.8rem', fontFamily: 'var(--font-display)', margin: 0 }}>Team Overview</h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>View rankings and performance metrics for employees in your organization.</p>
            </div>
            
            <div className="glass-panel" style={{ borderLeft: '4px solid var(--color-warning)', display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase' }}>System Alert Status</span>
              <h3 style={{ fontSize: '1.8rem', fontFamily: 'var(--font-display)', margin: 0, color: alertCount > 0 ? 'var(--color-warning)' : 'var(--color-success)', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <ShieldAlert size={24} /> {alertCount > 0 ? `${alertCount} Alert${alertCount > 1 ? 's' : ''} Active` : 'All Clear'}
              </h3>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {alertCount > 0
                  ? 'Off Track and escalation alerts require your attention in the notification menu.'
                  : 'No active Off Track or escalation alerts for your team.'}
              </p>
            </div>
          </div>

          {/* Leaderboard Table showing team ranking */}
          <Leaderboard managerId={profile.id} onSelectEmployee={handleSelectEmployee} />
        </div>
      ) : activeTab === 'kpis' ? (
        <ManagerKpiConfig managerId={profile.id} />
      ) : activeTab === 'rewards' ? (
        <ManagerRewardsPanel managerId={profile.id} onGoToPersonal={() => setActiveTab('personal')} />
      ) : (
        <EmployeeDashboard profile={profile} hideChangePassword />
      )}
    </div>
  );
}
