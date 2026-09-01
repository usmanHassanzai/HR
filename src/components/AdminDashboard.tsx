import { useState, useEffect, useMemo, useCallback, lazy, Suspense } from 'react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Users, Loader2, AlertCircle, CheckCircle, Download, FileSpreadsheet, FileText, BarChart3, Trophy, CalendarCheck, MapPin, Radio, Building2, Settings, Shield, ClipboardList, Coins } from 'lucide-react';
import '../styles/admin-dashboard.css';
import AdminResetPasswordModal from './AdminResetPasswordModal';
import AdminEditUserModal from './AdminEditUserModal';
import AdminSidebarNav, { getAdminNavMeta, findAdminNavIcon, type AdminNavGroup } from './AdminSidebarNav';
import AdminHamburgerButton from './AdminHamburgerButton';
import { isDemoProfile } from '../utils/demoMode';
import { Department } from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import { usePlatformOwnerAccess } from '../utils/usePlatformOwnerAccess';
import AdminDailyReportAlert from './AdminDailyReportAlert';
import { markNotificationsRead } from '../utils/notificationHelpers';
import TabFallback from './TabFallback';
import AdminSimpleWorkspace from './AdminSimpleWorkspace';
import AdminUsersPage from './AdminUsersPage';

const AdminDailyWorkReports = lazy(() => import('./AdminDailyWorkReports'));
const Analytics = lazy(() => import('./Analytics'));
const BrandingSettings = lazy(() => import('./BrandingSettings'));
const AdminRewards = lazy(() => import('./AdminRewards'));
const AdminOrgKpiPointsBoard = lazy(() => import('./AdminOrgKpiPointsBoard'));
const AttendanceLeavePanel = lazy(() => import('./AttendanceLeavePanel'));
const OfficeLocationSettings = lazy(() => import('./OfficeLocationSettings'));
const AdminLiveTracking = lazy(() => import('./AdminLiveTracking'));
const DepartmentsAdminPanel = lazy(() => import('./DepartmentsAdminPanel'));
const ManagerKpiConfig = lazy(() => import('./ManagerKpiConfig'));
const PlatformCompaniesConsole = lazy(() => import('./PlatformCompaniesConsole'));

interface AdminDashboardProps {
  profile: Profile;
  organizationName?: string | null;
}

export default function AdminDashboard({ profile, organizationName }: AdminDashboardProps) {
  const { isOwner: platformOwner, checking: platformOwnerChecking } = usePlatformOwnerAccess(profile);
  const [users, setUsers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'users' | 'kpis' | 'export' | 'analytics' | 'settings' | 'rewards' | 'kpiPoints' | 'attendance' | 'office' | 'tracking' | 'departments' | 'companies' | 'dailyReports'>('users');
  const [departments, setDepartments] = useState<Department[]>([]);
  const [resetPasswordUser, setResetPasswordUser] = useState<{ id: string; name: string } | null>(null);
  const [editUser, setEditUser] = useState<Profile | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [dailyReportUnread, setDailyReportUnread] = useState(0);
  const [viewTasksUser, setViewTasksUser] = useState<Profile | null>(null);
  const [kpiNavState, setKpiNavState] = useState<{ desk?: 'assign' | 'library' | 'board'; userId?: string; deptId?: string } | null>(null);
  const [reportsNavState, setReportsNavState] = useState<{ search?: string; deptId?: string } | null>(null);
  const [attendanceNavState, setAttendanceNavState] = useState<{ adminTab?: 'leave' | 'remote' | 'shifts' | 'history'; userId?: string } | null>(null);
  const [analyticsNavState, setAnalyticsNavState] = useState<{ userId?: string; deptId?: string } | null>(null);

  const markDailyReportNotificationsRead = useCallback(async () => {
    const { data } = await supabase
      .from('notifications')
      .select('id, title')
      .eq('user_id', profile.id)
      .eq('is_read', false)
      .limit(80);
    const ids = (data || [])
      .filter((n) => (n.title || '').toLowerCase().includes('daily report'))
      .map((n) => n.id);
    if (!ids.length) {
      setDailyReportUnread(0);
      return;
    }
    await markNotificationsRead(ids);
    setDailyReportUnread(0);
  }, [profile.id]);

  const handleAdminTabChange = (id: string) => {
    const next = id === 'branding' ? 'settings' : id;
    setActiveTab(next as typeof activeTab);
    setNavOpen(false);
    setViewTasksUser(null);
    if (id === 'dailyReports') void markDailyReportNotificationsRead();
  };

  const handleAssignTaskForPerson = useCallback((u: Profile) => {
    setKpiNavState({ desk: 'assign', userId: u.id, deptId: u.department_id || undefined });
    setViewTasksUser(null);
    setActiveTab('kpis');
    setNavOpen(false);
  }, []);

  const handleViewDepartment = useCallback((_deptId?: string | null) => {
    setViewTasksUser(null);
    setActiveTab('departments');
    setNavOpen(false);
  }, []);

  const handleViewAttendanceForPerson = useCallback((u: Profile) => {
    setAttendanceNavState({ adminTab: 'history', userId: u.id });
    setViewTasksUser(null);
    setActiveTab('attendance');
    setNavOpen(false);
  }, []);

  const handleViewRewardsForPerson = useCallback((_u: Profile) => {
    setViewTasksUser(null);
    setActiveTab('rewards');
    setNavOpen(false);
  }, []);

  const handleViewDailyReportsForPerson = useCallback((u: Profile) => {
    setReportsNavState({ search: u.full_name, deptId: u.department_id || undefined });
    setViewTasksUser(null);
    setActiveTab('dailyReports');
    setNavOpen(false);
    void markDailyReportNotificationsRead();
  }, [markDailyReportNotificationsRead]);

  const handleViewAnalyticsForPerson = useCallback((u: Profile) => {
    setAnalyticsNavState({ userId: u.id, deptId: u.department_id || undefined });
    setViewTasksUser(null);
    setActiveTab('analytics');
    setNavOpen(false);
  }, []);

  useEffect(() => {
    const openTab = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      if (detail?.tab === 'dailyReports') {
        setActiveTab('dailyReports');
        setNavOpen(false);
        void markDailyReportNotificationsRead();
      } else if (detail?.tab) {
        const next = detail.tab === 'branding' ? 'settings' : detail.tab;
        setActiveTab(next as typeof activeTab);
        setNavOpen(false);
      }
    };
    window.addEventListener('scorr-open-admin-tab', openTab);
    return () => window.removeEventListener('scorr-open-admin-tab', openTab);
  }, [markDailyReportNotificationsRead]);

  const onDailyReportUnreadChange = useCallback((count: number) => {
    setDailyReportUnread(count);
  }, []);

  const fetchData = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [{ data: allUsers, error: usersError }, { data: depts }] = await Promise.all([
        supabase.rpc('get_all_users_admin'),
        supabase.rpc('get_departments'),
      ]);

      if (usersError) console.error('Error fetching users:', usersError);
      else {
        const usersList = (allUsers || []) as Profile[];
        setUsers(usersList);
      }
      setDepartments((depts as Department[]) || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (platformOwnerChecking) return;
    void fetchData();
  }, [platformOwnerChecking, fetchData]);

  useSupabaseRealtime(
    'admin-users-sync',
    profile.company_id
      ? [
          { table: 'users', filter: `company_id=eq.${profile.company_id}` },
          { table: 'departments', filter: `company_id=eq.${profile.company_id}` },
        ]
      : [{ table: 'users' }, { table: 'departments' }],
    () => { void fetchData({ silent: true }); },
    !platformOwnerChecking,
  );

  const handleExport = async (format: 'csv' | 'excel' | 'pdf', period: 'quarterly' | 'monthly' = 'quarterly') => {
    setExportLoading(true);
    setExportMsg('');
    try {
      const {
        fetchMonthlyReportData,
        fetchQuarterlyReportData,
        exportToCsv,
        exportToExcel,
        exportToPdf,
      } = await import('../utils/exportReport');
      const data = period === 'monthly' ? await fetchMonthlyReportData() : await fetchQuarterlyReportData();
      if (format === 'csv') exportToCsv(data);
      else if (format === 'excel') await exportToExcel(data);
      else await exportToPdf(data);
      setExportMsg(`${period === 'monthly' ? 'Monthly' : 'Quarterly'} report exported as ${format.toUpperCase()}.`);
    } catch (err: any) {
      setExportMsg(err.message || 'Export failed.');
    } finally {
      setExportLoading(false);
    }
  };

  const managerCount = users.filter((u) => u.role === 'manager').length;
  const employeeCount = users.filter((u) => u.role === 'employee').length;

  const orgAdminTabs = useMemo(
    () => [
      { id: 'users', label: 'People', icon: <Users size={18} />, description: 'People, roles, and logins' },
      { id: 'kpis', label: 'Assign Task', icon: <ClipboardList size={18} />, description: 'KPIs assigned to one person' },
      { id: 'dailyReports', label: 'Daily Reports', icon: <FileText size={18} />, description: 'Staff daily work logs', badge: dailyReportUnread },
      { id: 'kpiPoints', label: 'KPI & Rewards', icon: <Coins size={18} />, description: "Each person's score and points" },
      { id: 'analytics', label: 'Analytics', icon: <BarChart3 size={18} />, description: 'Trends & attainment' },
      { id: 'attendance', label: 'Attendance', icon: <CalendarCheck size={18} />, description: 'Leave & approvals' },
      { id: 'office', label: 'Office GPS', icon: <MapPin size={18} />, description: 'Geofence & check-ins' },
      { id: 'tracking', label: 'Live Tracking', icon: <Radio size={18} />, description: 'Field team locations' },
      { id: 'departments', label: 'Departments', icon: <Building2 size={18} />, description: 'Org structure only' },
      { id: 'rewards', label: 'Rewards', icon: <Trophy size={18} />, description: 'Points & redemptions' },
      { id: 'export', label: 'Export', icon: <Download size={18} />, description: 'Monthly & quarterly exports' },
      { id: 'settings', label: 'Settings', icon: <Settings size={18} />, description: 'Logo and company theme' },
    ],
    [dailyReportUnread],
  );

  const navGroups: AdminNavGroup[] = useMemo(() => {
    const groups: AdminNavGroup[] = [];
    if (platformOwner) {
      groups.push({
        label: 'Platform',
        items: [{
          id: 'companies',
          label: 'Registered Companies',
          icon: <Shield size={18} />,
          description: 'Approve new sign-ups',
        }],
      });
    }
    groups.push({
      label: 'Menu',
      items: orgAdminTabs,
    });
    return groups;
  }, [platformOwner, orgAdminTabs]);

  const pageMeta = getAdminNavMeta(activeTab);
  const pageIcon = findAdminNavIcon(navGroups, activeTab);

  if (platformOwnerChecking) {
    return (
      <div className="admin-dashboard-loading">
        <Loader2 className="animate-spin" size={28} />
        <span>Loading admin console…</span>
      </div>
    );
  }

  return (
    <div className="admin-shell">

      <AdminDailyReportAlert
        userId={profile.id}
        onOpenReports={() => handleAdminTabChange('dailyReports')}
        onUnreadChange={onDailyReportUnreadChange}
      />

      {resetPasswordUser && (
        <AdminResetPasswordModal
          userId={resetPasswordUser.id}
          userName={resetPasswordUser.name}
          onClose={() => setResetPasswordUser(null)}
        />
      )}

      {editUser && !isDemoProfile(profile) && (
        <AdminEditUserModal
          user={editUser}
          currentAdminId={profile.id}
          departments={departments}
          allUsers={users}
          onClose={() => setEditUser(null)}
          onSaved={() => { void fetchData({ silent: true }); }}
        />
      )}

      <AdminSidebarNav
        groups={navGroups}
        activeTab={activeTab}
        onTabChange={handleAdminTabChange}
        navOpen={navOpen}
        onNavOpenChange={setNavOpen}
        platformOwner={platformOwner}
        organizationName={organizationName}
        stats={{ users: users.length, departments: departments.length, managers: managerCount }}
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
          <AdminHamburgerButton open={navOpen} onClick={() => setNavOpen(!navOpen)} />
          <div className="admin-shell__page-head">
            {pageIcon && (
              <div className="admin-shell__page-icon">{pageIcon}</div>
            )}
            <div>
              <p className="admin-shell__page-eyebrow">Admin console</p>
              <h1 className="admin-shell__page-title">{pageMeta.label}</h1>
              <p className="admin-shell__page-desc">{pageMeta.description}</p>
            </div>
          </div>
          <div className="admin-shell__topbar-stats">
            <div className="admin-shell__stat-pill admin-shell__stat-pill--accent">
              <Users size={14} />
              <div>
                <strong>{users.length}</strong>
                <span>Users</span>
              </div>
            </div>
            <div className="admin-shell__stat-pill">
              <Building2 size={14} />
              <div>
                <strong>{departments.length}</strong>
                <span>Depts</span>
              </div>
            </div>
            <div className="admin-shell__stat-pill">
              <Users size={14} />
              <div>
                <strong>{employeeCount}</strong>
                <span>Staff</span>
              </div>
            </div>
          </div>
        </header>

        <div className="admin-shell__mobile-stats" aria-label="Organization stats">
          <div>
            <strong>{users.length}</strong>
            <span>Users</span>
          </div>
          <div>
            <strong>{departments.length}</strong>
            <span>Depts</span>
          </div>
          <div>
            <strong>{managerCount}</strong>
            <span>Managers</span>
          </div>
          <div>
            <strong>{employeeCount}</strong>
            <span>Staff</span>
          </div>
        </div>

        <div className="admin-shell__content">
          <div className="admin-shell__panel">
      <Suspense fallback={<TabFallback />}>
      {activeTab === 'companies' && platformOwner ? (
        <PlatformCompaniesConsole profile={profile} embedded />
      ) : activeTab === 'export' ? (
        <div className="admin-reports-page">
          {exportMsg && (
            <div className={`admin-dashboard__alert ${exportMsg.includes('failed') ? 'admin-dashboard__alert--error' : 'admin-dashboard__alert--success'}`}>
              {exportMsg.includes('failed') ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
              <span>{exportMsg}</span>
            </div>
          )}

          <div className="admin-reports-grid">
            <div className="admin-report-card">
              <div className="admin-report-card__icon">
                <FileSpreadsheet size={18} />
              </div>
              <h4>Monthly report</h4>
              <p>KPI snapshot, submission log, and AI insights for the <strong>current calendar month</strong>.</p>
              <div className="admin-report-card__actions">
                <button className="btn btn-primary" onClick={() => handleExport('excel', 'monthly')} disabled={exportLoading}>
                  {exportLoading ? <Loader2 size={15} className="spin-icon" /> : <FileSpreadsheet size={15} />}
                  Excel
                </button>
                <button className="btn btn-secondary" onClick={() => handleExport('pdf', 'monthly')} disabled={exportLoading}>
                  <FileText size={15} /> PDF
                </button>
                <button className="btn btn-secondary" onClick={() => handleExport('csv', 'monthly')} disabled={exportLoading}>
                  <Download size={15} /> CSV
                </button>
              </div>
            </div>

            <div className="admin-report-card admin-report-card--quarterly">
              <div className="admin-report-card__icon">
                <BarChart3 size={18} />
              </div>
              <h4>Quarterly report</h4>
              <p>Full organizational KPI report with AI insights, suggested targets, and submission history for the <strong>current quarter</strong>.</p>
              <div className="admin-report-card__actions">
                <button className="btn btn-primary" onClick={() => handleExport('excel', 'quarterly')} disabled={exportLoading}>
                  {exportLoading ? <Loader2 size={15} className="spin-icon" /> : <FileSpreadsheet size={15} />}
                  Excel
                </button>
                <button className="btn btn-secondary" onClick={() => handleExport('pdf', 'quarterly')} disabled={exportLoading}>
                  <FileText size={15} /> PDF
                </button>
                <button className="btn btn-secondary" onClick={() => handleExport('csv', 'quarterly')} disabled={exportLoading}>
                  <Download size={15} /> CSV
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : activeTab === 'kpiPoints' ? (
        <AdminOrgKpiPointsBoard />
      ) : activeTab === 'analytics' ? (
        <Analytics
          title="Individual Performance & Activity Analytics"
          subtitle="Select a department and teammate to inspect their KPI scores, task execution, attendance history, and daily work reports."
          initialUserId={analyticsNavState?.userId}
          initialDeptId={analyticsNavState?.deptId}
        />
      ) : activeTab === 'settings' ? (
        <div className="app-settings-stack">
          <details className="app-settings-block" open>
            <summary>Branding</summary>
            <BrandingSettings isDemo={isDemoProfile(profile)} />
          </details>
        </div>
      ) : activeTab === 'rewards' ? (
        <AdminRewards />
      ) : activeTab === 'attendance' ? (
        <AttendanceLeavePanel
          profile={profile}
          mode="admin"
          initialAdminTab={attendanceNavState?.adminTab}
          initialUserId={attendanceNavState?.userId}
        />
      ) : activeTab === 'dailyReports' ? (
        <AdminDailyWorkReports
          initialSearch={reportsNavState?.search}
          initialDeptId={reportsNavState?.deptId}
        />
      ) : activeTab === 'office' ? (
        <OfficeLocationSettings />
      ) : activeTab === 'tracking' ? (
        <AdminLiveTracking />
      ) : activeTab === 'departments' ? (
        <DepartmentsAdminPanel />
      ) : activeTab === 'kpis' ? (
        <ManagerKpiConfig
          assignerId={profile.id}
          isAdmin
          hideChrome
          initialDesk={kpiNavState?.desk}
          initialUserId={kpiNavState?.userId}
          initialDeptId={kpiNavState?.deptId}
        />
      ) : viewTasksUser ? (
        <AdminSimpleWorkspace
          profile={profile}
          people={users}
          departments={departments}
          lockedPerson={viewTasksUser}
          onBackToList={() => setViewTasksUser(null)}
        />
      ) : (
        <AdminUsersPage
          profile={profile}
          users={users}
          departments={departments}
          loading={loading}
          onRefresh={fetchData}
          onEditUser={setEditUser}
          onResetPassword={setResetPasswordUser}
          onViewTasks={setViewTasksUser}
          onAssignTask={handleAssignTaskForPerson}
          onViewDepartment={handleViewDepartment}
          onViewAttendance={handleViewAttendanceForPerson}
          onViewRewards={handleViewRewardsForPerson}
          onViewDailyReports={handleViewDailyReportsForPerson}
          onViewAnalytics={handleViewAnalyticsForPerson}
        />
      )}
      </Suspense>

          </div>
        </div>
      </div>
    </div>
  );
}
