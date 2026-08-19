import { useState, useEffect, lazy, Suspense } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import Leaderboard from './Leaderboard';
import EmployeeDashboard from './EmployeeDashboard';
import { Users, BarChart3, ShieldAlert, KeyRound, Trophy, Settings, CalendarCheck, Radio, ClipboardList } from 'lucide-react';
import ChangePasswordModal from './ChangePasswordModal';
import RewardsPointsCard from './RewardsPointsCard';
import TeamPointsBoard from './TeamPointsBoard';
import DashboardTabNav from './DashboardTabNav';
import TabFallback from './TabFallback';
import '../styles/manager-mobile.css';

const ManagerPersonalPanel = lazy(() => import('./ManagerPersonalPanel'));
const ManagerKpiConfig = lazy(() => import('./ManagerKpiConfig'));
const DailyWorkReportPanel = lazy(() => import('./DailyWorkReportPanel'));
const ManagerRewardsPanel = lazy(() => import('./ManagerRewardsPanel'));
const AttendanceLeavePanel = lazy(() => import('./AttendanceLeavePanel'));
const AdminLiveTracking = lazy(() => import('./AdminLiveTracking'));

interface ManagerDashboardProps {
  profile: Profile;
}

export default function ManagerDashboard({ profile }: ManagerDashboardProps) {
  const [selectedEmployee, setSelectedEmployee] = useState<Profile | null>(null);
  const [activeTab, setActiveTab] = useState<'team' | 'kpis' | 'rewards' | 'personal' | 'attendance' | 'tracking' | 'dailyReport'>('team');
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
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${profile.id}` },
        fetchAlerts,
      )
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
    <div className="dashboard-with-mobile-nav mgr-dash">
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

      <DashboardTabNav
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as typeof activeTab)}
        tabs={[
          { id: 'team', label: 'Team Performance', mobileLabel: 'Team', icon: <Users size={16} /> },
          { id: 'kpis', label: 'KPI Tasks', mobileLabel: 'KPIs', icon: <Settings size={16} /> },
          { id: 'rewards', label: 'Team Rewards', mobileLabel: 'Rewards', icon: <Trophy size={16} /> },
          { id: 'attendance', label: 'Attendance & Leave', mobileLabel: 'Leave', icon: <CalendarCheck size={16} /> },
          { id: 'dailyReport', label: 'Daily Report', mobileLabel: 'Daily', icon: <ClipboardList size={16} /> },
          { id: 'tracking', label: 'Live Tracking', mobileLabel: 'GPS', icon: <Radio size={16} /> },
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
        <Suspense fallback={<TabFallback />}>
        {activeTab === 'team' ? (
          <div className="mgr-dash__team">
            <RewardsPointsCard
              userId={profile.id}
              title="Your rewards points"
              onViewRewards={() => setActiveTab('personal')}
            />
            <TeamPointsBoard
              title="Your points & team"
              description="Your balance plus direct reports and department teammates. Complete your own KPI tasks and track team points here."
            />
            <div className="dash-insight-grid">
              <div className="glass-panel dash-insight-card dash-insight-card--accent">
                <span className="dash-eyebrow">Direct reports</span>
                <h3>Team Overview</h3>
                <p>View rankings and assign KPI tasks to employees on <strong>your team</strong> (direct reports).</p>
              </div>

              <div className="glass-panel dash-insight-card dash-insight-card--warning">
                <span className="dash-eyebrow">System alert status</span>
                <h3 style={{ color: alertCount > 0 ? 'var(--color-warning)' : 'var(--color-success)' }}>
                  <ShieldAlert size={24} /> {alertCount > 0 ? `${alertCount} Alert${alertCount > 1 ? 's' : ''} Active` : 'All Clear'}
                </h3>
                <p>
                  {alertCount > 0
                    ? 'Off Track and escalation alerts require your attention in the notification menu.'
                    : 'No active Off Track or escalation alerts for your team.'}
                </p>
              </div>
            </div>

            <Leaderboard managerId={profile.id} onSelectEmployee={handleSelectEmployee} />
          </div>
        ) : activeTab === 'kpis' ? (
          <ManagerKpiConfig assignerId={profile.id} managerDepartmentId={profile.department_id} />
        ) : activeTab === 'rewards' ? (
          <ManagerRewardsPanel managerId={profile.id} onGoToPersonal={() => setActiveTab('personal')} />
        ) : activeTab === 'attendance' ? (
          <AttendanceLeavePanel profile={profile} mode="manager" />
        ) : activeTab === 'dailyReport' ? (
          <DailyWorkReportPanel profile={profile} />
        ) : activeTab === 'tracking' ? (
          <AdminLiveTracking mode="manager" profile={profile} />
        ) : (
          <ManagerPersonalPanel profile={profile} />
        )}
        </Suspense>
      </div>
    </div>
  );
}
