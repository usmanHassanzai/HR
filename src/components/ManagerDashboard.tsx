import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import Leaderboard from './Leaderboard';
import EmployeeDashboard from './EmployeeDashboard';
import ManagerKpiConfig from './ManagerKpiConfig';
import { Users, BarChart3, ShieldAlert, KeyRound, Trophy, Settings, CalendarCheck } from 'lucide-react';
import ChangePasswordModal from './ChangePasswordModal';
import ManagerRewardsPanel from './ManagerRewardsPanel';
import AttendanceLeavePanel from './AttendanceLeavePanel';
import DashboardTabNav from './DashboardTabNav';

interface ManagerDashboardProps {
  profile: Profile;
}

export default function ManagerDashboard({ profile }: ManagerDashboardProps) {
  const [selectedEmployee, setSelectedEmployee] = useState<Profile | null>(null);
  const [activeTab, setActiveTab] = useState<'team' | 'kpis' | 'rewards' | 'personal' | 'attendance'>('team');
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
    <div className="animate-fade-in dashboard-with-mobile-nav">
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

      <DashboardTabNav
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as typeof activeTab)}
        tabs={[
          { id: 'team', label: 'Team Performance', mobileLabel: 'Team', icon: <Users size={16} /> },
          { id: 'kpis', label: 'Assign Task', mobileLabel: 'Tasks', icon: <Settings size={16} /> },
          { id: 'rewards', label: 'Team Rewards', mobileLabel: 'Rewards', icon: <Trophy size={16} /> },
          { id: 'attendance', label: 'Attendance & Leave', mobileLabel: 'Leave', icon: <CalendarCheck size={16} /> },
          { id: 'personal', label: 'My KPIs & Points', mobileLabel: 'My KPIs', icon: <BarChart3 size={16} /> },
        ]}
        actions={[
          {
            id: 'password',
            label: 'Change Password',
            mobileLabel: 'Password',
            icon: <KeyRound size={16} />,
            onClick: () => setShowChangePassword(true),
          },
        ]}
      />

      <div className="dashboard-tab-content">
        {activeTab === 'team' ? (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '2rem' }}>
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

            <Leaderboard managerId={profile.id} onSelectEmployee={handleSelectEmployee} />
          </div>
        ) : activeTab === 'kpis' ? (
          <ManagerKpiConfig managerId={profile.id} />
        ) : activeTab === 'rewards' ? (
          <ManagerRewardsPanel managerId={profile.id} onGoToPersonal={() => setActiveTab('personal')} />
        ) : activeTab === 'attendance' ? (
          <AttendanceLeavePanel profile={profile} mode="manager" />
        ) : (
          <EmployeeDashboard profile={profile} hideChangePassword />
        )}
      </div>
    </div>
  );
}
