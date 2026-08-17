import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { supabase, supabaseSignup } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Users, UserPlus, Trash2, Loader2, AlertCircle, CheckCircle, Download, FileSpreadsheet, FileText, BarChart3, Palette, Trophy, KeyRound, CalendarCheck, MapPin, Radio, Building2, Settings, Shield, Search, ClipboardList, Coins, Pencil, Mail } from 'lucide-react';
import AdminDailyWorkReports from './AdminDailyWorkReports';
import '../styles/admin-dashboard.css';
import { fetchQuarterlyReportData, fetchMonthlyReportData, exportToCsv, exportToExcel, exportToPdf } from '../utils/exportReport';
import Analytics from './Analytics';
import BrandingSettings from './BrandingSettings';
import AdminRewards from './AdminRewards';
import AdminEmailPasswordsPanel from './AdminEmailPasswordsPanel';
import AdminOrgKpiPointsBoard from './AdminOrgKpiPointsBoard';
import AttendanceLeavePanel from './AttendanceLeavePanel';
import AdminResetPasswordModal from './AdminResetPasswordModal';
import AdminEditUserModal from './AdminEditUserModal';
import OfficeLocationSettings from './OfficeLocationSettings';
import AdminLiveTracking from './AdminLiveTracking';
import DepartmentWeightagesPanel from './DepartmentWeightagesPanel';
import ManagerKpiConfig from './ManagerKpiConfig';
import AdminSidebarNav, { getAdminNavMeta, findAdminNavIcon, type AdminNavGroup } from './AdminSidebarNav';
import AdminHamburgerButton from './AdminHamburgerButton';
import { isDemoProfile } from '../utils/demoMode';
import { Department } from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import { usePlatformOwnerAccess } from '../utils/usePlatformOwnerAccess';
import PlatformCompaniesConsole from './PlatformCompaniesConsole';
import AdminDailyReportAlert from './AdminDailyReportAlert';
import { markNotificationsRead } from '../utils/notificationHelpers';

interface AdminDashboardProps {
  profile: Profile;
  organizationName?: string | null;
}

const ADD_USER_DRAFT_KEY = 'scorr-add-user-draft';

type AddUserDraft = {
  email: string;
  password: string;
  fullName: string;
  role: 'employee' | 'manager' | 'admin';
  managerId: string;
  departmentId: string;
};

const EMPTY_ADD_USER_DRAFT: AddUserDraft = {
  email: '',
  password: '',
  fullName: '',
  role: 'employee',
  managerId: '',
  departmentId: '',
};

function readAddUserDraft(): AddUserDraft {
  try {
    const raw = localStorage.getItem(ADD_USER_DRAFT_KEY) || sessionStorage.getItem(ADD_USER_DRAFT_KEY);
    if (!raw) return EMPTY_ADD_USER_DRAFT;
    return { ...EMPTY_ADD_USER_DRAFT, ...JSON.parse(raw) };
  } catch {
    return EMPTY_ADD_USER_DRAFT;
  }
}

function writeAddUserDraft(draft: AddUserDraft) {
  try {
    const payload = JSON.stringify(draft);
    localStorage.setItem(ADD_USER_DRAFT_KEY, payload);
    sessionStorage.setItem(ADD_USER_DRAFT_KEY, payload);
  } catch {
    /* ignore */
  }
}

function clearAddUserDraft() {
  try {
    localStorage.removeItem(ADD_USER_DRAFT_KEY);
    sessionStorage.removeItem(ADD_USER_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

function userInitials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

function roleBadgeClass(role: Profile['role']): string {
  if (role === 'admin') return 'admin-role-badge admin-role-badge--admin';
  if (role === 'manager') return 'admin-role-badge admin-role-badge--manager';
  return 'admin-role-badge admin-role-badge--employee';
}

function avatarClass(role: Profile['role']): string {
  const base = 'admin-user-card__avatar';
  if (role === 'admin') return `${base} admin-user-card__avatar--admin`;
  if (role === 'manager') return `${base} admin-user-card__avatar--manager`;
  return base;
}

export default function AdminDashboard({ profile, organizationName }: AdminDashboardProps) {
  const { isOwner: platformOwner, checking: platformOwnerChecking } = usePlatformOwnerAccess(profile);
  const [users, setUsers] = useState<Profile[]>([]);
  const [managers, setManagers] = useState<Profile[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'users' | 'kpis' | 'export' | 'analytics' | 'branding' | 'rewards' | 'kpiPoints' | 'attendance' | 'office' | 'tracking' | 'departments' | 'companies' | 'dailyReports'>('users');

  // User Form States (restored if the admin switches apps mid-entry)
  const [email, setEmail] = useState(() => readAddUserDraft().email);
  const [password, setPassword] = useState(() => readAddUserDraft().password);
  const [fullName, setFullName] = useState(() => readAddUserDraft().fullName);
  const [role, setRole] = useState<'employee' | 'manager' | 'admin'>(() => readAddUserDraft().role);
  const [managerId, setManagerId] = useState(() => readAddUserDraft().managerId);
  const [departmentId, setDepartmentId] = useState(() => readAddUserDraft().departmentId);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [userFormLoading, setUserFormLoading] = useState(false);
  const [userFormMsg, setUserFormMsg] = useState({ type: '', text: '' });

  // Password reset / edit user modals
  const [resetPasswordUser, setResetPasswordUser] = useState<{ id: string; name: string } | null>(null);
  const [editUser, setEditUser] = useState<Profile | null>(null);
  const [sendLoginEmail, setSendLoginEmail] = useState(true);
  const [emailingUserId, setEmailingUserId] = useState<string | null>(null);

  // Export states
  const [exportLoading, setExportLoading] = useState(false);
  const [exportMsg, setExportMsg] = useState('');

  // User directory filters
  const [userSearch, setUserSearch] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState<'all' | 'admin' | 'manager' | 'employee'>('all');
  const [userDeptFilter, setUserDeptFilter] = useState('all');

  const [navOpen, setNavOpen] = useState(false);
  const [dailyReportUnread, setDailyReportUnread] = useState(0);

  useEffect(() => {
    writeAddUserDraft({ email, password, fullName, role, managerId, departmentId });
  }, [email, password, fullName, role, managerId, departmentId]);

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
    setActiveTab(id as typeof activeTab);
    setNavOpen(false);
    if (id === 'dailyReports') void markDailyReportNotificationsRead();
  };

  useEffect(() => {
    const openTab = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string }>).detail;
      if (detail?.tab === 'dailyReports') {
        setActiveTab('dailyReports');
        setNavOpen(false);
        void markDailyReportNotificationsRead();
      } else if (detail?.tab) {
        setActiveTab(detail.tab as typeof activeTab);
        setNavOpen(false);
      }
    };
    window.addEventListener('scorr-open-admin-tab', openTab);
    return () => window.removeEventListener('scorr-open-admin-tab', openTab);
  }, [markDailyReportNotificationsRead]);

  const onDailyReportUnreadChange = useCallback((count: number) => {
    setDailyReportUnread(count);
  }, []);

  const fetchData = async (opts?: { silent?: boolean }) => {
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
        setManagers(usersList.filter((u) => u.role === 'manager' || u.role === 'admin'));
      }
      setDepartments((depts as Department[]) || []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (platformOwnerChecking) return;
    void fetchData();
  }, [platformOwnerChecking]);

  useSupabaseRealtime(
    'admin-users-sync',
    [{ table: 'users' }, { table: 'departments' }],
    () => { void fetchData({ silent: true }); },
    !platformOwnerChecking,
  );

  const handleExport = async (format: 'csv' | 'excel' | 'pdf', period: 'quarterly' | 'monthly' = 'quarterly') => {
    setExportLoading(true);
    setExportMsg('');
    try {
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

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isDemoProfile(profile)) {
      setUserFormMsg({ type: 'error', text: 'Demo admin cannot create production users. Sign in with a real admin account.' });
      return;
    }
    if (!email || !password || !fullName) {
      setUserFormMsg({ type: 'error', text: 'All fields are required.' });
      return;
    }
    if (role !== 'admin' && !departmentId) {
      setUserFormMsg({ type: 'error', text: 'Select a department for managers and employees.' });
      return;
    }

    setUserFormLoading(true);
    setUserFormMsg({ type: '', text: '' });

    try {
      // 1. Create the auth user via a non-persisting client so the admin's
      //    own session is never replaced (signUp would otherwise log the
      //    admin in as the new user). The handle_new_user trigger syncs the
      //    public.users profile (full_name + role) automatically.
      const { data: signupData, error: signupError } = await supabaseSignup.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            role: role,
            company_id: profile.company_id ?? undefined,
            department_id: role !== 'admin' ? departmentId : undefined,
            manager_id: (role === 'employee' || role === 'manager') && managerId ? managerId : undefined,
          }
        }
      });

      if (signupError) {
        setUserFormMsg({ type: 'error', text: signupError.message });
        setUserFormLoading(false);
        return;
      }

      if (signupData.user) {
        const updates: { manager_id?: string; department_id?: string } = {};
        if (managerId && (role === 'employee' || role === 'manager')) updates.manager_id = managerId;
        if (role !== 'admin' && departmentId) updates.department_id = departmentId;
        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await supabase
            .from('users')
            .update(updates)
            .eq('id', signupData.user.id);
          if (updateError) {
            setUserFormMsg({ type: 'error', text: `User created but profile update failed: ${updateError.message}` });
            await supabaseSignup.auth.signOut();
            setUserFormLoading(false);
            return;
          }
        }

        // Clear the throwaway signup client's in-memory session.
        await supabaseSignup.auth.signOut();

        let emailNote = '';
        if (sendLoginEmail) {
          try {
            const { emailLoginCredentials } = await import('../utils/credentialEmail');
            await emailLoginCredentials({
              to: email.trim(),
              fullName: fullName.trim(),
              password,
              role,
              departmentName: role !== 'admin' ? deptName(departmentId) : undefined,
            });
            emailNote = ' Login details emailed via Scorr.';
          } catch (mailErr) {
            emailNote = ` Account created, but email failed: ${mailErr instanceof Error ? mailErr.message : 'unknown error'}.`;
          }
        }

        setUserFormMsg({ type: 'success', text: `Successfully registered ${fullName}.${emailNote}` });
        setEmail('');
        setPassword('');
        setFullName('');
        setRole('employee');
        setManagerId('');
        setDepartmentId('');
        clearAddUserDraft();
        
        // Refresh users list
        fetchData();
      }
    } catch (err: any) {
      setUserFormMsg({ type: 'error', text: err.message || 'An error occurred.' });
    } finally {
      setUserFormLoading(false);
    }
  };

  const handleUpdateUserDepartment = async (userId: string, newDeptId: string) => {
    if (isDemoProfile(profile)) return;
    const { error } = await supabase
      .from('users')
      .update({ department_id: newDeptId || null })
      .eq('id', userId);
    if (error) alert(`Error: ${error.message}`);
    else fetchData();
  };

  const handleUpdateUserManager = async (userId: string, newManagerId: string) => {
    if (isDemoProfile(profile)) return;
    const { error } = await supabase
      .from('users')
      .update({ manager_id: newManagerId || null })
      .eq('id', userId);
    if (error) alert(`Error: ${error.message}`);
    else fetchData();
  };

  const deptName = (id: string | null | undefined) =>
    departments.find((d) => d.id === id)?.name ?? '—';

  /** Label shown in assign-manager dropdowns: name + Admin/Manager designation. */
  const supervisorOptionLabel = (m: Profile) => {
    const roleLabel = m.role === 'admin' ? 'Admin' : 'Manager';
    const dept = m.role === 'manager' && m.department_id ? deptName(m.department_id) : '';
    if (dept && dept !== '—') return `${m.full_name} — ${roleLabel} · ${dept}`;
    return `${m.full_name} — ${roleLabel}`;
  };

  /** Admins + managers that can supervise an employee or manager. */
  const assignableSupervisors = (member: Profile) => {
    const list = users
      .filter((m) => (m.role === 'manager' || m.role === 'admin') && m.id !== member.id)
      .sort((a, b) => a.full_name.localeCompare(b.full_name));
    const admins = list.filter((m) => m.role === 'admin');
    const sameDept = list.filter(
      (m) => m.role === 'manager' && member.department_id && m.department_id === member.department_id,
    );
    const otherManagers = list.filter(
      (m) => m.role === 'manager' && (!member.department_id || m.department_id !== member.department_id),
    );
    return {
      admins,
      sameDept,
      otherManagers,
      all: [...admins, ...sameDept, ...otherManagers],
    };
  };

  const handleEmailPassword = async (user: Profile) => {
    if (isDemoProfile(profile)) return;
    if (!user.email?.trim()) {
      alert('This user has no email address.');
      return;
    }
    const ok = window.confirm(
      `Email a new temporary password to ${user.full_name} (${user.email})?\n\nTheir current password will stop working.`,
    );
    if (!ok) return;

    setEmailingUserId(user.id);
    try {
      const { resetAndEmailLoginCredentials } = await import('../utils/credentialEmail');
      await resetAndEmailLoginCredentials({
        userId: user.id,
        email: user.email,
        fullName: user.full_name,
        role: user.role,
        departmentName: user.role !== 'admin' ? deptName(user.department_id) : undefined,
      });
      alert(`Password emailed to ${user.full_name}.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to email password.');
    } finally {
      setEmailingUserId(null);
    }
  };

  const handleDeleteUser = async (userId: string) => {
    if (userId === profile.id) {
      alert("Cannot delete your own administrator profile.");
      return;
    }

    if (!confirm("Are you sure you want to permanently delete this user? Their login account and all associated KPIs, tasks, and submissions will be permanently removed.")) {
      return;
    }

    try {
      // Deletes the auth.users record server-side (SECURITY DEFINER), which
      // cascades to public.users and all related tables.
      const { error } = await supabase.rpc('delete_user_admin', { p_user_id: userId });

      if (error) {
        alert(`Error: ${error.message}`);
      } else {
        fetchData();
      }
    } catch (err: any) {
      alert(err.message);
    }
  };

  const supervisorsForForm = managers
    .filter((m) => m.role === 'admin' || m.role === 'manager')
    .sort((a, b) => {
      if (a.role === b.role) return a.full_name.localeCompare(b.full_name);
      return a.role === 'admin' ? -1 : 1;
    });

  const managerCount = users.filter((u) => u.role === 'manager').length;
  const employeeCount = users.filter((u) => u.role === 'employee').length;

  const filteredUsers = useMemo(() => {
    const q = userSearch.trim().toLowerCase();
    return users.filter((u) => {
      if (userRoleFilter !== 'all' && u.role !== userRoleFilter) return false;
      if (userDeptFilter !== 'all' && u.department_id !== userDeptFilter) return false;
      if (!q) return true;
      return (
        u.full_name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        deptName(u.department_id).toLowerCase().includes(q)
      );
    });
  }, [users, userSearch, userRoleFilter, userDeptFilter, departments]);

  const orgAdminTabs = [
    { id: 'users', label: 'Users', icon: <Users size={18} />, description: 'Accounts, roles & access' },
    { id: 'departments', label: 'Departments', icon: <Building2 size={18} />, description: 'Structure & weightages' },
    { id: 'kpiPoints', label: 'KPI Points', icon: <Coins size={18} />, description: 'Every dept, manager & employee' },
    { id: 'branding', label: 'Branding', icon: <Palette size={18} />, description: 'Logo & company theme' },
    { id: 'kpis', label: 'Assign Task', icon: <Settings size={18} />, description: 'KPI assignments by dept' },
    { id: 'export', label: 'Reports', icon: <Download size={18} />, description: 'Monthly & quarterly exports' },
    { id: 'analytics', label: 'Analytics', icon: <BarChart3 size={18} />, description: 'Trends & attainment' },
    { id: 'rewards', label: 'Rewards', icon: <Trophy size={18} />, description: 'Points & redemptions' },
    { id: 'attendance', label: 'Attendance', icon: <CalendarCheck size={18} />, description: 'Leave & approvals' },
    { id: 'dailyReports', label: 'Daily Reports', icon: <ClipboardList size={18} />, description: 'Staff daily work logs', badge: dailyReportUnread },
    { id: 'tracking', label: 'Live Tracking', icon: <Radio size={18} />, description: 'Field team locations' },
    { id: 'office', label: 'Office GPS', icon: <MapPin size={18} />, description: 'Geofence & check-ins' },
  ];

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
    groups.push(
      {
        label: 'Organization',
        items: orgAdminTabs.filter((t) => ['users', 'departments', 'kpiPoints', 'branding'].includes(t.id)),
      },
      {
        label: 'Performance',
        items: orgAdminTabs.filter((t) => ['kpis', 'analytics', 'export', 'rewards'].includes(t.id)),
      },
      {
        label: 'Workforce',
        items: orgAdminTabs.filter((t) => ['attendance', 'dailyReports', 'tracking', 'office'].includes(t.id)),
      },
    );
    return groups;
  }, [platformOwner, dailyReportUnread]);

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
    <div className="admin-shell animate-fade-in">

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
          title="Analytics"
          subtitle="Organization-wide KPI health, trends, forecasts, and attainment by category and department."
        />
      ) : activeTab === 'branding' ? (
        <BrandingSettings isDemo={isDemoProfile(profile)} />
      ) : activeTab === 'rewards' ? (
        <AdminRewards />
      ) : activeTab === 'attendance' ? (
        <AttendanceLeavePanel profile={profile} mode="admin" />
      ) : activeTab === 'dailyReports' ? (
        <AdminDailyWorkReports />
      ) : activeTab === 'office' ? (
        <OfficeLocationSettings />
      ) : activeTab === 'tracking' ? (
        <AdminLiveTracking />
      ) : activeTab === 'departments' ? (
        <DepartmentWeightagesPanel />
      ) : activeTab === 'kpis' ? (
        <ManagerKpiConfig assignerId={profile.id} isAdmin />
      ) : (
        <div className="admin-users-page">
          {!isDemoProfile(profile) && (
            <AdminEmailPasswordsPanel
              users={users}
              departments={departments}
            />
          )}
        <div className="admin-users-layout">
          <div className="admin-users-panel">
            <div className="admin-users-panel__head">
              <div>
                <h3><Users size={18} /> User directory</h3>
                <p>{filteredUsers.length} of {users.length} users shown</p>
              </div>
            </div>

            <div className="admin-users-toolbar">
              <div className="admin-users-toolbar__search form-group">
                <Search size={16} className="admin-users-toolbar__search-icon" />
                <input
                  type="search"
                  className="form-input"
                  placeholder="Search name, email, or department…"
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: '0.72rem' }}>Role</label>
                <select
                  className="form-input"
                  value={userRoleFilter}
                  onChange={(e) => setUserRoleFilter(e.target.value as typeof userRoleFilter)}
                >
                  <option value="all">All roles</option>
                  <option value="admin">Admin</option>
                  <option value="manager">Manager</option>
                  <option value="employee">Employee</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label" style={{ fontSize: '0.72rem' }}>Department</label>
                <select
                  className="form-input"
                  value={userDeptFilter}
                  onChange={(e) => setUserDeptFilter(e.target.value)}
                >
                  <option value="all">All departments</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>{d.name}</option>
                  ))}
                </select>
              </div>
            </div>

            {loading ? (
              <div className="dash-loading">
                <Loader2 className="animate-spin spin-icon" />
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="admin-users-empty">
                {users.length === 0 ? 'No users yet. Add your first team member using the form.' : 'No users match your filters.'}
              </div>
            ) : (
              <>
                <div className="admin-users-table-wrap">
                  <table className="admin-users-table">
                    <thead>
                      <tr>
                        <th>Member</th>
                        <th>Role</th>
                        <th>Department</th>
                        <th>Manager / Admin</th>
                        <th aria-label="Actions" />
                      </tr>
                    </thead>
                    <tbody>
                      {filteredUsers.map((u) => {
                        const mgrChoices = assignableSupervisors(u);
                        const canAssignSupervisor = (u.role === 'employee' || u.role === 'manager') && !isDemoProfile(profile);
                        return (
                          <tr key={u.id}>
                            <td>
                              <div className="admin-users-table__member">
                                <div className={avatarClass(u.role)} aria-hidden>
                                  {userInitials(u.full_name)}
                                </div>
                                <div>
                                  <strong>{u.full_name}</strong>
                                  <span>{u.email}</span>
                                </div>
                              </div>
                            </td>
                            <td><span className={roleBadgeClass(u.role)}>{u.role}</span></td>
                            <td>
                              {(u.role === 'manager' || u.role === 'employee') && !isDemoProfile(profile) ? (
                                <select
                                  className="admin-user-card__dept-select"
                                  value={u.department_id ?? ''}
                                  onChange={(e) => handleUpdateUserDepartment(u.id, e.target.value)}
                                >
                                  <option value="">— None —</option>
                                  {departments.map((d) => (
                                    <option key={d.id} value={d.id}>{d.name}</option>
                                  ))}
                                </select>
                              ) : (
                                <span className="admin-user-card__meta-item">{deptName(u.department_id)}</span>
                              )}
                            </td>
                            <td>
                              {canAssignSupervisor ? (
                                <select
                                  className="admin-user-card__dept-select admin-user-card__mgr-select"
                                  value={u.manager_id ?? ''}
                                  onChange={(e) => handleUpdateUserManager(u.id, e.target.value)}
                                  aria-label={`Assign manager for ${u.full_name}`}
                                >
                                  <option value="">— Unassigned —</option>
                                  {mgrChoices.admins.length > 0 && (
                                    <optgroup label="Admins">
                                      {mgrChoices.admins.map((m) => (
                                        <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {mgrChoices.sameDept.length > 0 && (
                                    <optgroup label="Managers · same department">
                                      {mgrChoices.sameDept.map((m) => (
                                        <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {mgrChoices.otherManagers.length > 0 && (
                                    <optgroup label={mgrChoices.sameDept.length ? 'Managers · other departments' : 'Managers'}>
                                      {mgrChoices.otherManagers.map((m) => (
                                        <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                </select>
                              ) : (
                                <span className="admin-user-card__meta-item">
                                  {u.role === 'admin'
                                    ? '—'
                                    : (() => {
                                        const mgr = users.find((m) => m.id === u.manager_id);
                                        return mgr ? supervisorOptionLabel(mgr) : '—';
                                      })()}
                                </span>
                              )}
                            </td>
                            <td>
                              <div className="admin-user-card__actions">
                                {!isDemoProfile(profile) && (
                                  <button
                                    className="btn btn-secondary"
                                    onClick={() => setEditUser(u)}
                                    title="Edit user account"
                                  >
                                    <Pencil size={14} />
                                  </button>
                                )}
                                {!isDemoProfile(profile) && (
                                  <button
                                    className="btn btn-secondary"
                                    onClick={() => void handleEmailPassword(u)}
                                    title="Email new password"
                                    disabled={emailingUserId === u.id || !u.email}
                                  >
                                    {emailingUserId === u.id ? <Loader2 size={14} className="spin-icon" /> : <Mail size={14} />}
                                  </button>
                                )}
                                <button
                                  className="btn btn-secondary"
                                  onClick={() => setResetPasswordUser({ id: u.id, name: u.full_name })}
                                  title="Reset password"
                                >
                                  <KeyRound size={14} />
                                </button>
                                <button
                                  className="btn btn-secondary btn--danger"
                                  onClick={() => handleDeleteUser(u.id)}
                                  title="Delete user"
                                  disabled={u.id === profile.id}
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="admin-users-mobile-list">
                  {filteredUsers.map((u) => {
                    const mgrChoices = assignableSupervisors(u);
                    const canAssignSupervisor = (u.role === 'employee' || u.role === 'manager') && !isDemoProfile(profile);
                    const assigned = users.find((m) => m.id === u.manager_id);
                    return (
                      <div key={u.id} className="admin-user-card">
                        <div className="admin-user-card__top">
                          <div className={avatarClass(u.role)} aria-hidden>
                            {userInitials(u.full_name)}
                          </div>
                          <div className="admin-user-card__body">
                            <strong className="admin-user-card__name">{u.full_name}</strong>
                            <span className="admin-user-card__email">{u.email}</span>
                            <div className="admin-user-card__meta">
                              <span className={roleBadgeClass(u.role)}>{u.role}</span>
                              {canAssignSupervisor ? (
                                <select
                                  className="admin-user-card__dept-select admin-user-card__mgr-select"
                                  value={u.manager_id ?? ''}
                                  onChange={(e) => handleUpdateUserManager(u.id, e.target.value)}
                                  aria-label={`Assign manager for ${u.full_name}`}
                                >
                                  <option value="">Manager: Unassigned</option>
                                  {mgrChoices.admins.length > 0 && (
                                    <optgroup label="Admins">
                                      {mgrChoices.admins.map((m) => (
                                        <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {mgrChoices.sameDept.length > 0 && (
                                    <optgroup label="Managers · same department">
                                      {mgrChoices.sameDept.map((m) => (
                                        <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                  {mgrChoices.otherManagers.length > 0 && (
                                    <optgroup label={mgrChoices.sameDept.length ? 'Managers · other departments' : 'Managers'}>
                                      {mgrChoices.otherManagers.map((m) => (
                                        <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                                      ))}
                                    </optgroup>
                                  )}
                                </select>
                              ) : assigned ? (
                                <span className="admin-user-card__meta-item">
                                  Reports to {supervisorOptionLabel(assigned)}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        </div>
                        <div className="admin-user-card__actions">
                          {!isDemoProfile(profile) && (
                            <button
                              className="btn btn-secondary"
                              onClick={() => setEditUser(u)}
                              title="Edit user account"
                            >
                              <Pencil size={14} />
                            </button>
                          )}
                          {!isDemoProfile(profile) && (
                            <button
                              className="btn btn-secondary"
                              onClick={() => void handleEmailPassword(u)}
                              title="Email new password"
                              disabled={emailingUserId === u.id || !u.email}
                            >
                              {emailingUserId === u.id ? <Loader2 size={14} className="spin-icon" /> : <Mail size={14} />}
                            </button>
                          )}
                          <button
                            className="btn btn-secondary"
                            onClick={() => setResetPasswordUser({ id: u.id, name: u.full_name })}
                            title="Reset password"
                          >
                            <KeyRound size={14} />
                          </button>
                          <button
                            className="btn btn-secondary btn--danger"
                            onClick={() => handleDeleteUser(u.id)}
                            title="Delete user"
                            disabled={u.id === profile.id}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <div className="admin-add-user-panel">
            {isDemoProfile(profile) ? (
              <>
                <div className="admin-add-user-panel__head">
                  <UserPlus size={18} />
                  <h3>Production user setup</h3>
                </div>
                <p className="admin-add-user-panel__desc">
                  Demo admin can only manage the 3 sandbox accounts shown in the directory. To add real employees, sign in with your production admin account.
                </p>
              </>
            ) : (
              <>
                <div className="admin-add-user-panel__head">
                  <UserPlus size={18} />
                  <h3>Add new user</h3>
                </div>
                <p className="admin-add-user-panel__desc">
                  Create login credentials and assign role, department, and reporting manager.
                </p>

                {userFormMsg.text && (
                  <div className={`admin-dashboard__alert ${userFormMsg.type === 'success' ? 'admin-dashboard__alert--success' : 'admin-dashboard__alert--error'}`} style={{ marginBottom: '1rem' }}>
                    {userFormMsg.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                    <span>{userFormMsg.text}</span>
                  </div>
                )}

                <form onSubmit={handleCreateUser} className="admin-add-user-form">
                  <div className="form-group">
                    <label>Full name</label>
                    <input
                      type="text"
                      placeholder="e.g. John Doe"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Email address</label>
                    <input
                      type="email"
                      placeholder="name@company.com"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>Password</label>
                    <input
                      type="password"
                      placeholder="Min 6 characters"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                    />
                  </div>

                  <div className="form-group">
                    <label>System role</label>
                    <select value={role} onChange={(e) => {
                      setRole(e.target.value as 'employee' | 'manager' | 'admin');
                      setManagerId('');
                    }}>
                      <option value="employee">Employee</option>
                      <option value="manager">Manager</option>
                      <option value="admin">Admin</option>
                    </select>
                  </div>

                  {role !== 'admin' && (
                    <div className="form-group">
                      <label>{role === 'manager' ? 'Assign department to manager *' : 'Department *'}</label>
                      <select value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setManagerId(''); }} required>
                        <option value="">— Select department —</option>
                        {departments.map((d) => (
                          <option key={d.id} value={d.id}>{d.name}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {(role === 'employee' || role === 'manager') && (
                    <div className="form-group">
                      <label>Assign manager / admin</label>
                      <select value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                        <option value="">— None —</option>
                        {supervisorsForForm.filter((m) => m.role === 'admin').length > 0 && (
                          <optgroup label="Admins">
                            {supervisorsForForm
                              .filter((m) => m.role === 'admin')
                              .map((m) => (
                                <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                              ))}
                          </optgroup>
                        )}
                        {supervisorsForForm.filter((m) => m.role === 'manager').length > 0 && (
                          <optgroup label="Managers">
                            {supervisorsForForm
                              .filter((m) => m.role === 'manager')
                              .map((m) => (
                                <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                              ))}
                          </optgroup>
                        )}
                      </select>
                    </div>
                  )}

                  <label className="admin-add-user-form__check">
                    <input
                      type="checkbox"
                      checked={sendLoginEmail}
                      onChange={(e) => setSendLoginEmail(e.target.checked)}
                    />
                    <span>Email login &amp; password to this user via Scorr</span>
                  </label>

                  <button type="submit" className="btn btn-primary" style={{ width: '100%', marginTop: '0.25rem' }} disabled={userFormLoading}>
                    {userFormLoading ? <Loader2 size={16} className="spin-icon" /> : 'Register user'}
                  </button>
                </form>
              </>
            )}
          </div>
        </div>
        </div>
      )}

          </div>
        </div>
      </div>
    </div>
  );
}
