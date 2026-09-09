import { useEffect, useMemo, useState } from 'react';
import { supabase, supabaseSignup } from '../lib/supabase';
import { Profile, UserRole, displayRoleLabel, roleNeedsDepartment } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { isDemoProfile } from '../utils/demoMode';
import { resetAuthenticatorForUser } from '../utils/mfaHelpers';
import AdminEmailPasswordsPanel from './AdminEmailPasswordsPanel';
import AdminUserHubModal from './AdminUserHubModal';
import PasswordField from './PasswordField';
import {
  AlertCircle,
  BarChart3,
  Building2,
  CalendarCheck,
  CheckCircle,
  ChevronDown,
  Eye,
  FileText,
  KeyRound,
  Loader2,
  Mail,
  MoreHorizontal,
  Pencil,
  PlusCircle,
  Search,
  ShieldOff,
  Target,
  Trash2,
  Trophy,
  UserPlus,
  Users,
} from 'lucide-react';
import '../styles/admin-dashboard.css';

type RoleFilter = 'all' | UserRole;

const ADD_USER_DRAFT_KEY = 'scorr-add-user-draft';

type AddUserDraft = {
  email: string;
  password: string;
  fullName: string;
  role: UserRole;
  managerId: string;
  departmentId: string;
  jobTitle: string;
};

const EMPTY_DRAFT: AddUserDraft = {
  email: '',
  password: '',
  fullName: '',
  role: 'employee',
  managerId: '',
  departmentId: '',
  jobTitle: '',
};

function readDraft(): AddUserDraft {
  try {
    const raw = localStorage.getItem(ADD_USER_DRAFT_KEY) || sessionStorage.getItem(ADD_USER_DRAFT_KEY);
    if (!raw) return EMPTY_DRAFT;
    return { ...EMPTY_DRAFT, ...JSON.parse(raw) };
  } catch {
    return EMPTY_DRAFT;
  }
}

function writeDraft(draft: AddUserDraft) {
  try {
    const payload = JSON.stringify({ ...draft, password: '' });
    localStorage.setItem(ADD_USER_DRAFT_KEY, payload);
    sessionStorage.setItem(ADD_USER_DRAFT_KEY, payload);
  } catch {
    /* ignore */
  }
}

function clearDraft() {
  try {
    localStorage.removeItem(ADD_USER_DRAFT_KEY);
    sessionStorage.removeItem(ADD_USER_DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

function initials(name: string): string {
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
  if (role === 'hr') return 'admin-role-badge admin-role-badge--hr';
  return 'admin-role-badge admin-role-badge--employee';
}

function avatarClass(role: Profile['role']): string {
  const base = 'admin-user-card__avatar';
  if (role === 'admin') return `${base} admin-user-card__avatar--admin`;
  if (role === 'manager') return `${base} admin-user-card__avatar--manager`;
  if (role === 'hr') return `${base} admin-user-card__avatar--hr`;
  return base;
}

interface AdminUsersPageProps {
  profile: Profile;
  users: Profile[];
  departments: Department[];
  loading: boolean;
  onRefresh: (opts?: { silent?: boolean }) => void;
  onEditUser: (user: Profile) => void;
  onResetPassword: (user: { id: string; name: string }) => void;
  onViewTasks: (user: Profile) => void;
  onAssignTask?: (user: Profile) => void;
  onViewDepartment?: (deptId?: string | null) => void;
  onViewAttendance?: (user: Profile) => void;
  onViewRewards?: (user: Profile) => void;
  onViewDailyReports?: (user: Profile) => void;
  onViewAnalytics?: (user: Profile) => void;
}

export default function AdminUsersPage({
  profile,
  users,
  departments,
  loading,
  onRefresh,
  onEditUser,
  onResetPassword,
  onViewTasks,
  onAssignTask,
  onViewDepartment,
  onViewAttendance,
  onViewRewards,
  onViewDailyReports,
  onViewAnalytics,
}: AdminUsersPageProps) {
  const demo = isDemoProfile(profile);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<RoleFilter>('all');
  const [deptFilter, setDeptFilter] = useState('all');
  const [addOpen, setAddOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [selectedUserForHub, setSelectedUserForHub] = useState<Profile | null>(null);

  const [email, setEmail] = useState(() => readDraft().email);
  const [password, setPassword] = useState(() => readDraft().password);
  const [fullName, setFullName] = useState(() => readDraft().fullName);
  const [role, setRole] = useState<UserRole>(() => readDraft().role);
  const [managerId, setManagerId] = useState(() => readDraft().managerId);
  const [departmentId, setDepartmentId] = useState(() => readDraft().departmentId);
  const [jobTitle, setJobTitle] = useState(() => readDraft().jobTitle);
  const [sendLoginEmail, setSendLoginEmail] = useState(true);
  const [formLoading, setFormLoading] = useState(false);
  const [formMsg, setFormMsg] = useState({ type: '', text: '' });
  const [emailingUserId, setEmailingUserId] = useState<string | null>(null);
  const [resettingMfaId, setResettingMfaId] = useState<string | null>(null);
  const [mfaResetRequests, setMfaResetRequests] = useState<{
    id: string;
    user_id: string;
    requester_name: string | null;
    requester_email: string | null;
    requester_role: string | null;
    created_at: string;
  }[]>([]);
  const [quickEdit, setQuickEdit] = useState<{ userId: string; field: 'role' | 'department' | 'reports' } | null>(null);
  const [quickSaving, setQuickSaving] = useState(false);
  const [quickError, setQuickError] = useState('');
  const [pendingRole, setPendingRole] = useState<UserRole | null>(null);

  const loadMfaResetRequests = async () => {
    if (demo || profile.role !== 'admin') {
      setMfaResetRequests([]);
      return;
    }
    const { data } = await supabase
      .from('mfa_reset_requests')
      .select('id, user_id, requester_name, requester_email, requester_role, created_at')
      .is('resolved_at', null)
      .order('created_at', { ascending: false });
    setMfaResetRequests(data || []);
  };

  useEffect(() => {
    writeDraft({ email, password, fullName, role, managerId, departmentId, jobTitle });
  }, [email, password, fullName, role, managerId, departmentId, jobTitle]);

  useEffect(() => {
    void loadMfaResetRequests();
  }, [demo, profile.role, users.length]);

  useEffect(() => {
    if (!menuId && !quickEdit) return;
    const close = () => {
      setMenuId(null);
      setQuickEdit(null);
      setQuickError('');
      setPendingRole(null);
    };
    window.addEventListener('click', close);
    return () => window.removeEventListener('click', close);
  }, [menuId, quickEdit]);

  useEffect(() => {
    if (!addOpen && !menuId && !quickEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (quickEdit) {
        setQuickEdit(null);
        setQuickError('');
        setPendingRole(null);
      } else if (menuId) setMenuId(null);
      else setAddOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [addOpen, menuId, quickEdit]);

  useEffect(() => {
    if (!addOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [addOpen]);

  const deptName = (id: string | null | undefined) =>
    departments.find((d) => d.id === id)?.name ?? '—';

  const supervisorOptionLabel = (m: Profile) => {
    const roleLabel = m.role === 'admin' ? 'Admin' : 'Manager';
    const dept = m.role === 'manager' && m.department_id ? deptName(m.department_id) : '';
    if (dept && dept !== '—') return `${m.full_name} — ${roleLabel} · ${dept}`;
    return `${m.full_name} — ${roleLabel}`;
  };

  const counts = useMemo(
    () => ({
      all: users.length,
      admin: users.filter((u) => u.role === 'admin').length,
      hr: users.filter((u) => u.role === 'hr').length,
      manager: users.filter((u) => u.role === 'manager').length,
      employee: users.filter((u) => u.role === 'employee').length,
    }),
    [users],
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return users.filter((u) => {
      if (roleFilter !== 'all' && u.role !== roleFilter) return false;
      if (deptFilter !== 'all' && u.department_id !== deptFilter) return false;
      if (!q) return true;
      return (
        u.full_name.toLowerCase().includes(q) ||
        u.email.toLowerCase().includes(q) ||
        deptName(u.department_id).toLowerCase().includes(q)
      );
    }).sort((a, b) => a.full_name.localeCompare(b.full_name));
  }, [users, search, roleFilter, deptFilter, departments]);

  const supervisorsForForm = users
    .filter((m) => {
      if (m.role === 'admin') return true;
      if (m.role !== 'manager') return false;
      if (!departmentId) return true;
      return m.department_id === departmentId;
    })
    .sort((a, b) => {
      if (a.role === b.role) return a.full_name.localeCompare(b.full_name);
      return a.role === 'admin' ? -1 : 1;
    });

  const reportsTo = (u: Profile) => {
    if (!u.manager_id) return 'Unassigned';
    const mgr = users.find((m) => m.id === u.manager_id);
    return mgr ? mgr.full_name : 'Unassigned';
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (demo) {
      setFormMsg({ type: 'error', text: 'Demo admin cannot create production users.' });
      return;
    }
    if (!email || !password || !fullName) {
      setFormMsg({ type: 'error', text: 'Name, email, and password are required.' });
      return;
    }
    if (roleNeedsDepartment(role) && !departmentId) {
      setFormMsg({ type: 'error', text: 'Select a department. Employees and managers cannot be created without one.' });
      return;
    }

    setFormLoading(true);
    setFormMsg({ type: '', text: '' });

    try {
      const { data: signupData, error: signupError } = await supabaseSignup.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName,
            role,
            company_id: profile.company_id ?? undefined,
            department_id: roleNeedsDepartment(role) ? departmentId : undefined,
            manager_id: roleNeedsDepartment(role) && managerId ? managerId : undefined,
            job_title: roleNeedsDepartment(role) && jobTitle.trim() ? jobTitle.trim() : undefined,
          },
        },
      });

      if (signupError) {
        setFormMsg({ type: 'error', text: signupError.message });
        setFormLoading(false);
        return;
      }

      if (signupData.user) {
        const updates: { manager_id?: string; department_id?: string; job_title?: string | null } = {};
        if (managerId && roleNeedsDepartment(role)) updates.manager_id = managerId;
        if (roleNeedsDepartment(role) && departmentId) updates.department_id = departmentId;
        if (roleNeedsDepartment(role)) updates.job_title = jobTitle.trim() || null;
        if (Object.keys(updates).length > 0) {
          const { error: updateError } = await supabase.from('users').update(updates).eq('id', signupData.user.id);
          if (updateError) {
            setFormMsg({ type: 'error', text: `Account created but profile update failed: ${updateError.message}` });
            await supabaseSignup.auth.signOut();
            setFormLoading(false);
            return;
          }
        }

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
              departmentName: roleNeedsDepartment(role) ? deptName(departmentId) : undefined,
            });
            emailNote = ' Login details were emailed.';
          } catch (mailErr) {
            emailNote = ` Account created, but email failed: ${mailErr instanceof Error ? mailErr.message : 'unknown error'}.`;
          }
        }

        setFormMsg({ type: 'success', text: `${fullName} is registered.${emailNote}` });
        setEmail('');
        setPassword('');
        setFullName('');
        setRole('employee');
        setManagerId('');
        setDepartmentId('');
        setJobTitle('');
        clearDraft();
        onRefresh();
      }
    } catch (err: unknown) {
      setFormMsg({ type: 'error', text: err instanceof Error ? err.message : 'Could not create the account.' });
    } finally {
      setFormLoading(false);
    }
  };

  const handleEmailPassword = async (user: Profile) => {
    if (demo) return;
    if (!user.email?.trim()) {
      alert('This person has no email address.');
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
        departmentName: roleNeedsDepartment(user.role) ? deptName(user.department_id) : undefined,
      });
      alert(`Password emailed to ${user.full_name}.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to email password.');
    } finally {
      setEmailingUserId(null);
    }
  };

  const handleDeleteUser = async (user: Profile) => {
    if (user.id === profile.id) {
      alert('You cannot delete your own administrator account.');
      return;
    }
    if (
      !confirm(
        `Delete ${user.full_name}? Their login, KPIs, and related records will be permanently removed.`,
      )
    ) {
      return;
    }
    const { error } = await supabase.rpc('delete_user_admin', { p_user_id: user.id });
    if (error) alert(error.message);
    else onRefresh();
  };

  const handleResetAuthenticator = async (user: Profile) => {
    setMenuId(null);
    if (
      !confirm(
        `Reset authenticator for ${user.full_name}? Their current authenticator app will stop working. They must sign in again and scan a new QR code.`,
      )
    ) {
      return;
    }
    setResettingMfaId(user.id);
    try {
      await resetAuthenticatorForUser(user.id);
      await loadMfaResetRequests();
      alert(`Authenticator reset for ${user.full_name}. Ask them to sign in and scan the new QR code.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Could not reset authenticator.');
    } finally {
      setResettingMfaId(null);
    }
  };

  const handleResetFromRequest = async (userId: string) => {
    const person = users.find((u) => u.id === userId);
    if (!person) {
      alert('That person is not in your People list. Refresh and try again.');
      return;
    }
    await handleResetAuthenticator(person);
  };

  const chips: { id: RoleFilter; label: string; count: number }[] = [
    { id: 'all', label: 'Everyone', count: counts.all },
    { id: 'admin', label: 'Admin', count: counts.admin },
    { id: 'hr', label: 'HR', count: counts.hr },
    { id: 'manager', label: 'Manager', count: counts.manager },
    { id: 'employee', label: 'Employee', count: counts.employee },
  ];

  const rowActions = (u: Profile) => (
    <div className="people-actions" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className="people-actions__btn people-actions__btn--primary"
        title={`View full profile and complete activity for ${u.full_name}`}
        onClick={() => setSelectedUserForHub(u)}
      >
        <Eye size={14} /> Profile & Hub
      </button>
      {!demo && (
        <button
          type="button"
          className="people-actions__btn"
          title={`Edit role, department, and reports-to for ${u.full_name}`}
          onClick={() => {
            setMenuId(null);
            onEditUser(u);
          }}
        >
          <Pencil size={14} /> Edit
        </button>
      )}
      <button
        type="button"
        className="people-actions__btn people-actions__btn--hide-sm"
        title={`Assign a new task to ${u.full_name}`}
        onClick={() => (onAssignTask ? onAssignTask(u) : onViewTasks(u))}
      >
        <PlusCircle size={14} /> Assign
      </button>
      <div className="people-actions__more">
        <button
          type="button"
          className="people-actions__btn people-actions__btn--icon"
          aria-label={`More actions for ${u.full_name}`}
          aria-expanded={menuId === u.id}
          aria-haspopup="menu"
          onClick={(e) => {
            e.stopPropagation();
            setMenuId((id) => (id === u.id ? null : u.id));
          }}
        >
          <MoreHorizontal size={16} />
        </button>
        {menuId === u.id && (
          <div className="people-actions__menu" role="menu">
            <button type="button" onClick={() => setSelectedUserForHub(u)}>
              <Eye size={14} /> Open full profile page
            </button>
            {!demo && (
              <button
                type="button"
                onClick={() => {
                  setMenuId(null);
                  onEditUser(u);
                }}
              >
                <Pencil size={14} /> Edit role, department & reports to
              </button>
            )}
            <button type="button" onClick={() => onViewTasks(u)}>
              <Target size={14} /> View assigned KPIs & tasks
            </button>
            <button type="button" onClick={() => (onAssignTask ? onAssignTask(u) : onViewTasks(u))}>
              <PlusCircle size={14} /> Assign new task
            </button>
            {onViewAttendance && (
              <button type="button" onClick={() => onViewAttendance(u)}>
                <CalendarCheck size={14} /> Attendance records
              </button>
            )}
            {onViewDailyReports && (
              <button type="button" onClick={() => onViewDailyReports(u)}>
                <FileText size={14} /> Daily work reports
              </button>
            )}
            {onViewAnalytics && (
              <button type="button" onClick={() => onViewAnalytics(u)}>
                <BarChart3 size={14} /> Detailed performance analytics
              </button>
            )}
            {onViewRewards && (
              <button type="button" onClick={() => onViewRewards(u)}>
                <Trophy size={14} /> Rewards & points
              </button>
            )}
            {onViewDepartment && u.department_id && (
              <button type="button" onClick={() => onViewDepartment(u.department_id)}>
                <Building2 size={14} /> Department details
              </button>
            )}
            <button type="button" onClick={() => onResetPassword({ id: u.id, name: u.full_name })}>
              <KeyRound size={14} /> Reset password
            </button>
            {!demo && (
              <button
                type="button"
                disabled={resettingMfaId === u.id}
                onClick={() => void handleResetAuthenticator(u)}
              >
                {resettingMfaId === u.id ? <Loader2 size={14} className="spin-icon" /> : <ShieldOff size={14} />}
                Reset authenticator
              </button>
            )}
            {!demo && (
              <button
                type="button"
                disabled={emailingUserId === u.id || !u.email}
                onClick={() => void handleEmailPassword(u)}
              >
                {emailingUserId === u.id ? <Loader2 size={14} className="spin-icon" /> : <Mail size={14} />}
                Email new password
              </button>
            )}
            <button
              type="button"
              className="people-actions__danger"
              disabled={u.id === profile.id}
              onClick={() => void handleDeleteUser(u)}
            >
              <Trash2 size={14} /> Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );

  const openQuickEdit = (
    u: Profile,
    field: 'role' | 'department' | 'reports',
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    if (demo) return;
    setMenuId(null);
    setQuickError('');
    setPendingRole(null);
    if (field === 'department' && !roleNeedsDepartment(u.role)) {
      setQuickEdit({ userId: u.id, field });
      setQuickError('Department applies to employees and managers only.');
      return;
    }
    if (field === 'reports' && !roleNeedsDepartment(u.role)) {
      setQuickEdit({ userId: u.id, field });
      setQuickError('Reports to applies to employees and managers only.');
      return;
    }
    setQuickEdit((prev) =>
      prev?.userId === u.id && prev.field === field ? null : { userId: u.id, field },
    );
  };

  const reportToOptions = useMemo(
    () =>
      users
        .filter((m) => m.role === 'admin' || m.role === 'manager')
        .sort((a, b) => {
          if (a.role === b.role) return a.full_name.localeCompare(b.full_name);
          return a.role === 'admin' ? -1 : 1;
        }),
    [users],
  );

  const saveAccountFields = async (
    u: Profile,
    next: { role: UserRole; departmentId: string | null; managerId: string | null },
  ) => {
    setQuickSaving(true);
    setQuickError('');
    try {
      const needsDept = roleNeedsDepartment(next.role);
      if (needsDept && !next.departmentId) {
        setQuickError('Select a department.');
        setQuickEdit({ userId: u.id, field: 'department' });
        setQuickSaving(false);
        return false;
      }
      const { error } = await supabase.rpc('admin_update_user_account', {
        p_user_id: u.id,
        p_full_name: u.full_name,
        p_role: next.role,
        p_department_id: needsDept ? next.departmentId : null,
        p_manager_id: needsDept ? next.managerId : null,
      });
      if (error) throw error;
      setQuickEdit(null);
      setPendingRole(null);
      onRefresh({ silent: true });
      return true;
    } catch (err: unknown) {
      setQuickError(err instanceof Error ? err.message : 'Could not save.');
      return false;
    } finally {
      setQuickSaving(false);
    }
  };

  const applyQuickRole = async (u: Profile, nextRole: UserRole) => {
    if (u.id === profile.id && nextRole !== 'admin') {
      setQuickError('You cannot remove your own admin role.');
      return;
    }
    if (nextRole === u.role) {
      setQuickEdit(null);
      return;
    }
    if (roleNeedsDepartment(nextRole) && !u.department_id) {
      setPendingRole(nextRole);
      setQuickError('Pick a department for this role.');
      setQuickEdit({ userId: u.id, field: 'department' });
      return;
    }
    await saveAccountFields(u, {
      role: nextRole,
      departmentId: roleNeedsDepartment(nextRole) ? u.department_id ?? null : null,
      managerId: roleNeedsDepartment(nextRole) ? u.manager_id ?? null : null,
    });
  };

  const applyQuickDepartment = async (u: Profile, nextDeptId: string) => {
    const nextRole = pendingRole ?? u.role;
    if (!roleNeedsDepartment(nextRole)) {
      setQuickError('Department applies to employees and managers only.');
      return;
    }
    const keepManager =
      !!u.manager_id &&
      reportToOptions.some((m) => {
        if (m.id !== u.manager_id) return false;
        if (m.role === 'admin') return true;
        return m.department_id === nextDeptId;
      });
    await saveAccountFields(u, {
      role: nextRole,
      departmentId: nextDeptId,
      managerId: keepManager ? u.manager_id ?? null : null,
    });
  };

  const applyQuickReportsTo = async (u: Profile, nextManagerId: string | null) => {
    if (!roleNeedsDepartment(u.role)) {
      setQuickError('Reports to applies to employees and managers only.');
      return;
    }
    await saveAccountFields(u, {
      role: u.role,
      departmentId: u.department_id ?? null,
      managerId: nextManagerId,
    });
  };

  const quickMenu = (u: Profile) => {
    if (!quickEdit || quickEdit.userId !== u.id) return null;
    const field = quickEdit.field;
    return (
      <div
        className="people-quick-menu"
        role="listbox"
        onClick={(e) => e.stopPropagation()}
      >
        {quickError && <p className="people-quick-menu__error">{quickError}</p>}
        {quickSaving && (
          <p className="people-quick-menu__status">
            <Loader2 size={14} className="spin-icon" /> Saving…
          </p>
        )}
        {field === 'role' && (
          <>
            {([
              ['employee', 'Employee'],
              ['manager', 'Manager'],
              ['admin', 'Admin'],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="option"
                aria-selected={u.role === value}
                className={u.role === value ? 'is-active' : undefined}
                disabled={quickSaving || (u.id === profile.id && value !== 'admin')}
                onClick={() => void applyQuickRole(u, value)}
              >
                {label}
              </button>
            ))}
          </>
        )}
        {field === 'department' && (
          <>
            {departments.length === 0 ? (
              <p className="people-quick-menu__empty">No departments yet.</p>
            ) : (
              departments.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  role="option"
                  aria-selected={u.department_id === d.id}
                  className={u.department_id === d.id && !pendingRole ? 'is-active' : undefined}
                  disabled={quickSaving || (!roleNeedsDepartment(pendingRole ?? u.role))}
                  onClick={() => void applyQuickDepartment(u, d.id)}
                >
                  {d.name}
                </button>
              ))
            )}
          </>
        )}
        {field === 'reports' && (
          <>
            <button
              type="button"
              role="option"
              aria-selected={!u.manager_id}
              className={!u.manager_id ? 'is-active' : undefined}
              disabled={quickSaving}
              onClick={() => void applyQuickReportsTo(u, null)}
            >
              Unassigned
            </button>
            {reportToOptions
              .filter((m) => m.id !== u.id)
              .map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="option"
                  aria-selected={u.manager_id === m.id}
                  className={u.manager_id === m.id ? 'is-active' : undefined}
                  disabled={quickSaving}
                  onClick={() => void applyQuickReportsTo(u, m.id)}
                >
                  {supervisorOptionLabel(m)}
                </button>
              ))}
            {reportToOptions.filter((m) => m.id !== u.id).length === 0 && (
              <p className="people-quick-menu__empty">No managers or admins yet.</p>
            )}
          </>
        )}
      </div>
    );
  };

  return (
    <div className="people-page">
      <div className="people-page__intro">
        <p>Add teammates, set their role and department, and keep logins in one place.</p>
        {!demo ? (
          <button type="button" className="btn btn-primary people-page__add" onClick={() => { setAddOpen(true); setFormMsg({ type: '', text: '' }); }}>
            <UserPlus size={16} /> Add person
          </button>
        ) : null}
      </div>

      <div className="people-chips" role="tablist" aria-label="Filter by role">
        {chips.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`people-chip${roleFilter === c.id ? ' people-chip--active' : ''}`}
            role="tab"
            aria-selected={roleFilter === c.id}
            onClick={() => setRoleFilter(c.id)}
          >
            <span>{c.label}</span>
            <strong>{c.count}</strong>
          </button>
        ))}
      </div>

      {!demo && mfaResetRequests.length > 0 && (
        <div
          className="login-error-banner"
          role="status"
          style={{
            marginBottom: '1rem',
            background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
            borderColor: 'color-mix(in srgb, var(--accent-primary) 35%, transparent)',
            color: 'inherit',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.65rem' }}>
            <ShieldOff size={18} style={{ flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1 }}>
              <strong>Authenticator reset requested</strong>
              <ul style={{ margin: '0.5rem 0 0', paddingLeft: '1.1rem', lineHeight: 1.45 }}>
                {mfaResetRequests.map((req) => (
                  <li key={req.id} style={{ marginBottom: '0.45rem' }}>
                    <span>
                      {req.requester_name || 'Someone'}
                      {req.requester_role ? ` (${displayRoleLabel(req.requester_role as UserRole)})` : ''}
                      {req.requester_email ? ` · ${req.requester_email}` : ''}
                    </span>
                    {' '}
                    <button
                      type="button"
                      className="btn btn-primary"
                      style={{ marginLeft: '0.35rem', padding: '0.25rem 0.65rem', fontSize: '0.8rem' }}
                      disabled={resettingMfaId === req.user_id}
                      onClick={() => void handleResetFromRequest(req.user_id)}
                    >
                      {resettingMfaId === req.user_id ? 'Resetting…' : 'Reset authenticator'}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      <section className="people-panel">
        <div className="people-toolbar">
          <div className="people-search">
            <Search size={16} />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search by name, email, or department"
              aria-label="Search people"
            />
          </div>
          <label className="people-filter">
            <span>Department</span>
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)}>
              <option value="all">All departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </label>
        </div>

        {loading && users.length === 0 ? (
          <div className="people-empty">
            <Loader2 className="spin-icon" size={28} />
            <p>Loading people…</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="people-empty">
            <Users size={36} strokeWidth={1.4} />
            <h3>{users.length === 0 ? 'No one here yet' : 'No matches'}</h3>
            <p>
              {users.length === 0
                ? 'Add the first person so they can sign in and start work.'
                : 'Try another search or clear the role and department filters.'}
            </p>
            {users.length === 0 && !demo && (
              <button type="button" className="btn btn-primary" onClick={() => setAddOpen(true)}>
                <UserPlus size={16} /> Add person
              </button>
            )}
            {users.length > 0 && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => { setSearch(''); setRoleFilter('all'); setDeptFilter('all'); }}
              >
                Clear filters
              </button>
            )}
          </div>
        ) : (
          <>
            <p className="people-count">{filtered.length} {filtered.length === 1 ? 'person' : 'people'}</p>
            <div className="admin-users-table-wrap people-table-wrap">
              <table className="admin-users-table people-table">
                <thead>
                  <tr>
                    <th>Person</th>
                    <th>Role</th>
                    <th>Department</th>
                    <th>Reports to</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((u) => (
                    <tr
                      key={u.id}
                      className="people-row people-row--interactive"
                      onClick={() => setSelectedUserForHub(u)}
                      title={`Click to view ${u.full_name}'s full profile & related modules`}
                    >
                      <td>
                        <button
                          type="button"
                          className="admin-users-table__member-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedUserForHub(u);
                          }}
                          title={`View ${u.full_name}'s profile & activity hub`}
                        >
                          <div className={avatarClass(u.role)} aria-hidden>{initials(u.full_name)}</div>
                          <div className="admin-users-table__member-meta">
                            <strong>
                              {u.full_name}
                              {u.id === profile.id && <span className="people-you">You</span>}
                            </strong>
                            <span>{u.email}</span>
                            {u.job_title?.trim() ? (
                              <span className="people-job-title">{u.job_title.trim()}</span>
                            ) : null}
                          </div>
                        </button>
                      </td>
                      <td>
                        {!demo ? (
                          <div className="people-quick">
                            <button
                              type="button"
                              className="people-cell-edit"
                              aria-expanded={quickEdit?.userId === u.id && quickEdit.field === 'role'}
                              onClick={(e) => openQuickEdit(u, 'role', e)}
                              title={`Change role for ${u.full_name}`}
                            >
                              <span className={roleBadgeClass(u.role)}>{displayRoleLabel(u.role)}</span>
                              <Pencil size={12} aria-hidden />
                            </button>
                            {quickEdit?.userId === u.id && quickEdit.field === 'role' && quickMenu(u)}
                          </div>
                        ) : (
                          <span className={roleBadgeClass(u.role)}>{displayRoleLabel(u.role)}</span>
                        )}
                      </td>
                      <td>
                        {roleNeedsDepartment(u.role) ? (
                          !demo ? (
                            <div className="people-quick">
                              <button
                                type="button"
                                className="people-cell-edit"
                                aria-expanded={quickEdit?.userId === u.id && quickEdit.field === 'department'}
                                onClick={(e) => openQuickEdit(u, 'department', e)}
                                title={`Change department for ${u.full_name}`}
                              >
                                <span className="people-muted">{deptName(u.department_id)}</span>
                                <Pencil size={12} aria-hidden />
                              </button>
                              {quickEdit?.userId === u.id && quickEdit.field === 'department' && quickMenu(u)}
                            </div>
                          ) : (
                            <span className="people-muted">{deptName(u.department_id)}</span>
                          )
                        ) : (
                          <span className="people-muted">—</span>
                        )}
                      </td>
                      <td>
                        {roleNeedsDepartment(u.role) ? (
                          !demo ? (
                            <div className="people-quick">
                              <button
                                type="button"
                                className="people-cell-edit"
                                aria-expanded={quickEdit?.userId === u.id && quickEdit.field === 'reports'}
                                onClick={(e) => openQuickEdit(u, 'reports', e)}
                                title={`Change reports-to for ${u.full_name}`}
                              >
                                <span className="people-muted">{reportsTo(u)}</span>
                                <Pencil size={12} aria-hidden />
                              </button>
                              {quickEdit?.userId === u.id && quickEdit.field === 'reports' && quickMenu(u)}
                            </div>
                          ) : (
                            <span className="people-muted">{reportsTo(u)}</span>
                          )
                        ) : (
                          <span className="people-muted">—</span>
                        )}
                      </td>
                      <td>{rowActions(u)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="admin-users-mobile-list people-cards">
              {filtered.map((u) => {
                const isQuickEditing = quickEdit?.userId === u.id;
                return (
                <article
                  key={u.id}
                  className={`people-card people-card--interactive${isQuickEditing ? ' people-card--editing' : ''}`}
                  onClick={() => setSelectedUserForHub(u)}
                  title={`Click to view ${u.full_name}'s full profile & related modules`}
                >
                  <div className="people-card__top">
                    <button
                      type="button"
                      className="people-card__top-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedUserForHub(u);
                      }}
                    >
                      <div className={avatarClass(u.role)} aria-hidden>{initials(u.full_name)}</div>
                      <div className="people-card__identity">
                        <strong className="people-card__name">
                          {u.full_name}
                          {u.id === profile.id && <span className="people-you">You</span>}
                        </strong>
                        <span className="people-card__email">{u.email}</span>
                        {u.job_title?.trim() ? (
                          <span className="people-job-title">{u.job_title.trim()}</span>
                        ) : null}
                      </div>
                    </button>
                    <div className="people-card__fields" onClick={(e) => e.stopPropagation()}>
                      <div className="people-card__meta">
                        {!demo ? (
                          <>
                            <div className={`people-quick${quickEdit?.userId === u.id && quickEdit.field === 'role' ? ' people-quick--open' : ''}`}>
                              <button
                                type="button"
                                className="people-cell-edit"
                                aria-expanded={quickEdit?.userId === u.id && quickEdit.field === 'role'}
                                onClick={(e) => openQuickEdit(u, 'role', e)}
                                title="Change role"
                              >
                                <span className={roleBadgeClass(u.role)}>{displayRoleLabel(u.role)}</span>
                                <Pencil size={12} aria-hidden />
                              </button>
                              {quickEdit?.userId === u.id && quickEdit.field === 'role' && quickMenu(u)}
                            </div>
                            {roleNeedsDepartment(u.role) ? (
                              <div className={`people-quick${quickEdit?.userId === u.id && quickEdit.field === 'department' ? ' people-quick--open' : ''}`}>
                                <button
                                  type="button"
                                  className="people-cell-edit"
                                  aria-expanded={quickEdit?.userId === u.id && quickEdit.field === 'department'}
                                  onClick={(e) => openQuickEdit(u, 'department', e)}
                                  title="Change department"
                                >
                                  <span className="people-muted">{deptName(u.department_id)}</span>
                                  <Pencil size={12} aria-hidden />
                                </button>
                                {quickEdit?.userId === u.id && quickEdit.field === 'department' && quickMenu(u)}
                              </div>
                            ) : (
                              <span className="people-muted">—</span>
                            )}
                          </>
                        ) : (
                          <>
                            <span className={roleBadgeClass(u.role)}>{displayRoleLabel(u.role)}</span>
                            <span className="people-muted">
                              {roleNeedsDepartment(u.role) ? deptName(u.department_id) : '—'}
                            </span>
                          </>
                        )}
                      </div>
                      {roleNeedsDepartment(u.role) ? (
                        !demo ? (
                          <div className={`people-quick people-quick--block${quickEdit?.userId === u.id && quickEdit.field === 'reports' ? ' people-quick--open' : ''}`}>
                            <button
                              type="button"
                              className="people-cell-edit people-cell-edit--block"
                              aria-expanded={quickEdit?.userId === u.id && quickEdit.field === 'reports'}
                              onClick={(e) => openQuickEdit(u, 'reports', e)}
                              title="Change reports to"
                            >
                              <span className="people-muted">Reports to {reportsTo(u)}</span>
                              <Pencil size={12} aria-hidden />
                            </button>
                            {quickEdit?.userId === u.id && quickEdit.field === 'reports' && quickMenu(u)}
                          </div>
                        ) : (
                          <p className="people-muted people-card__reports-static">Reports to {reportsTo(u)}</p>
                        )
                      ) : (
                        <p className="people-muted people-card__reports-static">—</p>
                      )}
                    </div>
                  </div>
                  {rowActions(u)}
                </article>
                );
              })}
            </div>
          </>
        )}
      </section>

      {!demo && (
        <details className="people-tools">
          <summary>
            <ChevronDown size={16} /> Tools — email new passwords to everyone
          </summary>
          <AdminEmailPasswordsPanel users={users} departments={departments} />
        </details>
      )}

      {addOpen && (
        <>
          <div className="people-drawer__backdrop" onClick={() => setAddOpen(false)} />
          <aside className="people-drawer" role="dialog" aria-labelledby="add-person-title">
            <header className="people-drawer__head">
              <div>
                <h3 id="add-person-title">Add person</h3>
                <p>They can sign in as soon as you save. Optional: email their password automatically.</p>
              </div>
              <button type="button" className="scorr-dialog-close" onClick={() => setAddOpen(false)} aria-label="Close" title="Close">
                ×
              </button>
            </header>

            {demo ? (
              <p className="people-drawer__hint">Demo admin cannot add production accounts.</p>
            ) : (
              <form onSubmit={handleCreateUser} className="people-drawer__form">
                {formMsg.text && (
                  <div className={`admin-dashboard__alert ${formMsg.type === 'success' ? 'admin-dashboard__alert--success' : 'admin-dashboard__alert--error'}`}>
                    {formMsg.type === 'success' ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                    <span>{formMsg.text}</span>
                  </div>
                )}
                <div className="form-group">
                  <label htmlFor="add-name">Full name</label>
                  <input id="add-name" className="form-input" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="e.g. Ayesha Khan" required autoFocus />
                </div>
                <div className="form-group">
                  <label htmlFor="add-email">Work email</label>
                  <input id="add-email" className="form-input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" required />
                </div>
                <div className="form-group">
                  <label htmlFor="add-password">Temporary password</label>
                  <PasswordField id="add-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 6 characters" required minLength={6} />
                </div>
                <div className="form-group">
                  <label htmlFor="add-role">Role</label>
                  <select
                    id="add-role"
                    className="form-input"
                    value={role}
                    onChange={(e) => {
                      setRole(e.target.value as UserRole);
                      setManagerId('');
                    }}
                  >
                    <option value="employee">Employee — KPIs, attendance, rewards</option>
                    <option value="manager">Manager — team tasks and approvals</option>
                    <option value="hr">HR — company-wide shifts and awards</option>
                    <option value="admin">Admin — full company settings</option>
                  </select>
                </div>
                {roleNeedsDepartment(role) && (
                  <div className="form-group">
                    <label htmlFor="add-job-title">
                      {role === 'manager' ? 'Manager type / job title' : 'Employee type / job title'}
                    </label>
                    <input
                      id="add-job-title"
                      className="form-input"
                      value={jobTitle}
                      onChange={(e) => setJobTitle(e.target.value)}
                      placeholder={role === 'manager' ? 'e.g. Sales Manager, Engineering Lead' : 'e.g. Software Engineer, Accountant'}
                    />
                    <span className="people-drawer__field-hint">What kind of {role === 'manager' ? 'manager' : 'employee'} this person is.</span>
                  </div>
                )}
                {roleNeedsDepartment(role) && (
                  <div className="form-group">
                    <label htmlFor="add-dept">Department</label>
                    <select id="add-dept" className="form-input" value={departmentId} onChange={(e) => { setDepartmentId(e.target.value); setManagerId(''); }} required>
                      <option value="">Select department</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>{d.name}</option>
                      ))}
                    </select>
                  </div>
                )}
                {roleNeedsDepartment(role) && (
                  <div className="form-group">
                    <label htmlFor="add-mgr">Reports to (optional)</label>
                    <select id="add-mgr" className="form-input" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                      <option value="">Not assigned yet</option>
                      {supervisorsForForm.filter((m) => m.role === 'admin').length > 0 && (
                        <optgroup label="Admins">
                          {supervisorsForForm.filter((m) => m.role === 'admin').map((m) => (
                            <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                          ))}
                        </optgroup>
                      )}
                      {supervisorsForForm.filter((m) => m.role === 'manager').length > 0 && (
                        <optgroup label="Managers">
                          {supervisorsForForm.filter((m) => m.role === 'manager').map((m) => (
                            <option key={m.id} value={m.id}>{supervisorOptionLabel(m)}</option>
                          ))}
                        </optgroup>
                      )}
                    </select>
                  </div>
                )}
                <label className="admin-add-user-form__check">
                  <input type="checkbox" checked={sendLoginEmail} onChange={(e) => setSendLoginEmail(e.target.checked)} />
                  <span>Email login details to this person</span>
                </label>
                <div className="people-drawer__footer">
                  <button type="button" className="btn btn-secondary" onClick={() => setAddOpen(false)}>Cancel</button>
                  <button type="submit" className="btn btn-primary" disabled={formLoading}>
                    {formLoading ? <Loader2 size={16} className="spin-icon" /> : <UserPlus size={16} />}
                    Save person
                  </button>
                </div>
              </form>
            )}
          </aside>
        </>
      )}

      {selectedUserForHub && (
        <AdminUserHubModal
          user={selectedUserForHub}
          currentUser={profile}
          departments={departments}
          allUsers={users}
          onClose={() => setSelectedUserForHub(null)}
          onEditUser={(u) => {
            setSelectedUserForHub(null);
            onEditUser(u);
          }}
          onResetPassword={(u) => {
            setSelectedUserForHub(null);
            onResetPassword(u);
          }}
          onResetMfa={handleResetAuthenticator}
          onEmailPassword={handleEmailPassword}
          onDeleteUser={handleDeleteUser}
          onNavigateToKpis={(u) => {
            setSelectedUserForHub(null);
            onViewTasks(u);
          }}
          onNavigateToAssignTask={(u) => {
            setSelectedUserForHub(null);
            if (onAssignTask) onAssignTask(u);
            else onViewTasks(u);
          }}
          onNavigateToDepartment={(deptId) => {
            setSelectedUserForHub(null);
            onViewDepartment?.(deptId);
          }}
          onNavigateToAttendance={(u) => {
            setSelectedUserForHub(null);
            onViewAttendance?.(u);
          }}
          onNavigateToRewards={(u) => {
            setSelectedUserForHub(null);
            onViewRewards?.(u);
          }}
          onNavigateToDailyReports={(u) => {
            setSelectedUserForHub(null);
            onViewDailyReports?.(u);
          }}
          onNavigateToAnalytics={(u) => {
            setSelectedUserForHub(null);
            onViewAnalytics?.(u);
          }}
        />
      )}
    </div>
  );
}
