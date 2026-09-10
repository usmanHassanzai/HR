import { useState, useEffect, useMemo, lazy, Suspense } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { runOverdueKpiCheckOnce } from '../utils/overdueKpiCheck';
import Leaderboard from './Leaderboard';
import EmployeeDashboard from './EmployeeDashboard';
import { Users, KeyRound, Trophy, Settings, CalendarCheck, ClipboardList, BarChart2, FileText } from 'lucide-react';
import ChangePasswordModal from './ChangePasswordModal';
import AdminSidebarNav, { findAdminNavIcon, type AdminNavGroup } from './AdminSidebarNav';
import AdminHamburgerButton from './AdminHamburgerButton';
import TabFallback from './TabFallback';
import KpiWorkspace from './KpiWorkspace';
import '../styles/admin-dashboard.css';
import '../styles/manager-mobile.css';

const AdminOrgKpiPointsBoard = lazy(() => import('./AdminOrgKpiPointsBoard'));
const ManagerPersonalPanel = lazy(() => import('./ManagerPersonalPanel'));
const ManagerKpiConfig = lazy(() => import('./ManagerKpiConfig'));
const DailyWorkReportPanel = lazy(() => import('./DailyWorkReportPanel'));
const ManagerRewardsPanel = lazy(() => import('./ManagerRewardsPanel'));
const AttendanceLeavePanel = lazy(() => import('./AttendanceLeavePanel'));
const AdminLiveTracking = lazy(() => import('./AdminLiveTracking'));
const AccountSecurityPanel = lazy(() => import('./AccountSecurityPanel'));
const BackupCodesLowBanner = lazy(() => import('./BackupCodesLowBanner'));

type ManagerTab = 'mine' | 'employees' | 'kpis' | 'attendance' | 'rewards' | 'dailyReport' | 'settings';

interface ManagerDashboardProps {
  profile: Profile;
  organizationName?: string | null;
}

function getManagerNavMeta(id: string): { label: string; description: string } {
  const map: Record<string, { label: string; description: string }> = {
    mine: { label: 'My KPIs', description: 'Tasks assigned to you.' },
    employees: { label: 'People', description: 'People who report to you.' },
    kpis: { label: 'Assign Task', description: 'Create and assign KPIs.' },
    attendance: { label: 'Attendance', description: 'Team leave and check-in.' },
    rewards: { label: 'Rewards', description: 'Company gifts for you and your team.' },
    dailyReport: { label: 'Daily report', description: 'Submit and review your daily work log.' },
    settings: { label: 'Settings', description: 'Password and account security.' },
  };
  return map[id] ?? { label: 'Manager', description: 'Team and personal workspace.' };
}

export default function ManagerDashboard({ profile, organizationName }: ManagerDashboardProps) {
  const [selectedEmployee, setSelectedEmployee] = useState<Profile | null>(null);
  const [activeTab, setActiveTab] = useState<ManagerTab>('kpis');
  const [alertCount, setAlertCount] = useState(0);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    const fetchAlerts = async () => {
      runOverdueKpiCheckOnce();
      const { count } = await supabase
        .from('notifications')
        .select('*', { count: 'exact', head: true })
        .eq('user_id', profile.id)
        .in('type', ['alert', 'escalation'])
        .eq('is_read', false);

      setAlertCount(count || 0);
    };

    void fetchAlerts();

    const subscription = supabase
      .channel(`manager-alerts:${profile.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'notifications', filter: `user_id=eq.${profile.id}` },
        () => { void fetchAlerts(); },
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

  const navGroups = useMemo<AdminNavGroup[]>(() => [
    {
      label: 'Menu',
      items: [
        { id: 'employees', label: 'People', icon: <Users size={16} />, badge: alertCount },
        { id: 'kpis', label: 'Assign Task', icon: <ClipboardList size={16} /> },
        { id: 'mine', label: 'My KPIs', icon: <BarChart2 size={16} /> },
        { id: 'attendance', label: 'Attendance', icon: <CalendarCheck size={16} /> },
        { id: 'rewards', label: 'Rewards', icon: <Trophy size={16} /> },
        { id: 'dailyReport', label: 'Daily report', icon: <FileText size={16} /> },
        { id: 'settings', label: 'Settings', icon: <Settings size={16} /> },
      ],
    },
  ], [alertCount]);

  const pageMeta = getManagerNavMeta(activeTab);
  const pageIcon = findAdminNavIcon(navGroups, activeTab);

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
    <div className="admin-shell mgr-dash">
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}

      <AdminSidebarNav
        groups={navGroups}
        activeTab={activeTab}
        onTabChange={(id) => setActiveTab(id as ManagerTab)}
        navOpen={navOpen}
        onNavOpenChange={setNavOpen}
        organizationName={organizationName}
        brandTitle={organizationName?.trim() || 'Scorr'}
        brandSubtitle="Manager workspace"
        ariaLabel="Manager navigation"
        sidebarId="manager-sidebar"
      />

      {navOpen && (
        <div
          className="admin-shell__backdrop admin-shell__backdrop--visible"
          onClick={() => setNavOpen(false)}
          aria-hidden={false}
        />
      )}

      <div className="admin-shell__main">
        <header className="admin-shell__topbar">
          <AdminHamburgerButton
            open={navOpen}
            onClick={() => setNavOpen(!navOpen)}
            controlsId="manager-sidebar"
          />
          <div className="admin-shell__page-head">
            {pageIcon && (
              <div className="admin-shell__page-icon">{pageIcon}</div>
            )}
            <div>
              <p className="admin-shell__page-eyebrow">Manager console</p>
              <h1 className="admin-shell__page-title">{pageMeta.label}</h1>
              <p className="admin-shell__page-desc">{pageMeta.description}</p>
            </div>
          </div>
        </header>

        <div className="admin-shell__content">
          <div className="admin-shell__panel">
        <Suspense fallback={<TabFallback />}>
        {activeTab === 'mine' ? (
          <ManagerPersonalPanel profile={profile} />
        ) : activeTab === 'employees' ? (
          <Leaderboard managerId={profile.id} onSelectEmployee={handleSelectEmployee} />
        ) : activeTab === 'kpis' ? (
          <KpiWorkspace
            panes={[
              { id: 'tasks', label: 'Tasks', hint: 'Create a KPI, then assign it to someone in your department.', content: <ManagerKpiConfig assignerId={profile.id} managerDepartmentId={profile.department_id} hideChrome /> },
              { id: 'points', label: 'People', hint: 'Weightage and KPI scores for each person.', content: <AdminOrgKpiPointsBoard variant="manager" managerProfile={profile} /> },
            ]}
          />
        ) : activeTab === 'rewards' ? (
          <ManagerRewardsPanel managerId={profile.id} />
        ) : activeTab === 'attendance' ? (
          <div className="app-page-stack">
            <AttendanceLeavePanel profile={profile} mode="manager" />
            <details className="app-settings-block">
              <summary>Live tracking</summary>
              <AdminLiveTracking mode="manager" profile={profile} />
            </details>
          </div>
        ) : activeTab === 'dailyReport' ? (
          <DailyWorkReportPanel profile={profile} />
        ) : (
          <div className="app-settings-stack">
            <BackupCodesLowBanner onOpenSettings={() => setActiveTab('settings')} />
            <div className="app-settings-block">
              <button type="button" className="btn btn-secondary" onClick={() => setShowChangePassword(true)}>
                <KeyRound size={16} /> Change password
              </button>
            </div>
            <details className="app-settings-block" open>
              <summary>Account security (2FA recovery)</summary>
              <AccountSecurityPanel fullName={profile.full_name} />
            </details>
          </div>
        )}
        </Suspense>
          </div>
        </div>
      </div>
    </div>
  );
}
