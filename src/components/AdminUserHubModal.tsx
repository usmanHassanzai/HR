import { useEffect, useState } from 'react';
import {
  AlertCircle,
  BarChart3,
  Building2,
  CalendarCheck,
  CheckCircle2,
  Coins,
  FileText,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Mail,
  MapPin,
  Pencil,
  PlusCircle,
  ShieldOff,
  Target,
  Trash2,
  Trophy,
  User,
  ArrowLeft,
} from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  Profile,
  Kpi,
  displayRoleLabel,
} from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { formatKpiScore, kpiScoreContribution } from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import { isDemoProfile } from '../utils/demoMode';
import '../styles/admin-dashboard.css';

interface AdminUserHubModalProps {
  user: Profile;
  currentUser: Profile;
  departments: Department[];
  allUsers: Profile[];
  onClose: () => void;
  onEditUser: (user: Profile) => void;
  onResetPassword: (user: { id: string; name: string }) => void;
  onResetMfa?: (user: Profile) => Promise<void>;
  onEmailPassword?: (user: Profile) => Promise<void>;
  onDeleteUser?: (user: Profile) => Promise<void>;
  onNavigateToKpis: (user: Profile) => void;
  onNavigateToAssignTask: (user: Profile) => void;
  onNavigateToDepartment: (deptId?: string | null) => void;
  onNavigateToAttendance: (user: Profile) => void;
  onNavigateToRewards: (user: Profile) => void;
  onNavigateToDailyReports: (user: Profile) => void;
  onNavigateToAnalytics?: (user: Profile) => void;
}

interface UserLiveStats {
  kpis: Kpi[];
  kpisLoading: boolean;
  todayAttendance: {
    status: string;
    clock_in_at: string | null;
    clock_out_at: string | null;
  } | null;
  attendanceLoading: boolean;
  latestReportDate: string | null;
  reportsLoading: boolean;
  rewardPoints: number;
}

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? '')
      .join('') || '?'
  );
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

export default function AdminUserHubModal({
  user,
  currentUser,
  departments,
  allUsers,
  onClose,
  onEditUser,
  onResetPassword,
  onResetMfa,
  onEmailPassword,
  onDeleteUser,
  onNavigateToKpis,
  onNavigateToAssignTask,
  onNavigateToDepartment,
  onNavigateToAttendance,
  onNavigateToRewards,
  onNavigateToDailyReports,
  onNavigateToAnalytics,
}: AdminUserHubModalProps) {
  const demo = isDemoProfile(currentUser);
  const isSelf = user.id === currentUser.id;
  const dept = departments.find((d) => d.id === user.department_id);
  const manager = allUsers.find((m) => m.id === user.manager_id);

  const [stats, setStats] = useState<UserLiveStats>({
    kpis: [],
    kpisLoading: true,
    todayAttendance: null,
    attendanceLoading: true,
    latestReportDate: null,
    reportsLoading: true,
    rewardPoints: 0,
  });

  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [actionMsg, setActionMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      // 1. Fetch KPIs
      try {
        const { data: kpiData } = await supabase
          .from('kpis')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false });

        if (!cancelled && kpiData) {
          const kpis = kpiData as Kpi[];
          const totalPoints = kpis.reduce((sum, k) => sum + kpiScoreContribution(k), 0);
          setStats((prev) => ({
            ...prev,
            kpis,
            kpisLoading: false,
            rewardPoints: totalPoints,
          }));
        } else if (!cancelled) {
          setStats((prev) => ({ ...prev, kpisLoading: false }));
        }
      } catch {
        if (!cancelled) setStats((prev) => ({ ...prev, kpisLoading: false }));
      }

      // 2. Fetch Attendance (today/latest)
      try {
        const todayStr = new Date().toISOString().slice(0, 10);
        const { data: attData } = await supabase
          .from('attendance_records')
          .select('status, clock_in_at, clock_out_at, attendance_date')
          .eq('user_id', user.id)
          .order('attendance_date', { ascending: false })
          .limit(1);

        if (!cancelled && attData && attData.length > 0) {
          const rec = attData[0];
          setStats((prev) => ({
            ...prev,
            todayAttendance: {
              status: rec.attendance_date === todayStr ? rec.status : 'Not marked today',
              clock_in_at: rec.attendance_date === todayStr ? rec.clock_in_at : null,
              clock_out_at: rec.attendance_date === todayStr ? rec.clock_out_at : null,
            },
            attendanceLoading: false,
          }));
        } else if (!cancelled) {
          setStats((prev) => ({
            ...prev,
            todayAttendance: { status: 'Not marked today', clock_in_at: null, clock_out_at: null },
            attendanceLoading: false,
          }));
        }
      } catch {
        if (!cancelled) setStats((prev) => ({ ...prev, attendanceLoading: false }));
      }

      // 3. Fetch Daily Reports
      try {
        const { data: repData } = await supabase
          .from('daily_work_reports')
          .select('report_date')
          .eq('user_id', user.id)
          .order('report_date', { ascending: false })
          .limit(1);

        if (!cancelled) {
          setStats((prev) => ({
            ...prev,
            latestReportDate: repData && repData.length > 0 ? repData[0].report_date : null,
            reportsLoading: false,
          }));
        }
      } catch {
        if (!cancelled) setStats((prev) => ({ ...prev, reportsLoading: false }));
      }
    }

    void loadData();
    return () => {
      cancelled = true;
    };
  }, [user.id]);

  const activeKpis = stats.kpis.filter((k) => k.completion_status !== 'completed');
  const completedKpis = stats.kpis.filter((k) => k.completion_status === 'completed');
  const pausedKpis = stats.kpis.filter((k) => k.paused_at && k.completion_status !== 'completed');
  const totalWeight = stats.kpis.reduce((sum, k) => sum + (Number(k.weight) || 0), 0);

  const handleResetMfa = async () => {
    if (!onResetMfa) return;
    setActionBusy('mfa');
    setActionMsg(null);
    try {
      await onResetMfa(user);
      setActionMsg({ type: 'success', text: 'Authenticator reset successfully.' });
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to reset authenticator.' });
    } finally {
      setActionBusy(null);
    }
  };

  const handleEmailPassword = async () => {
    if (!onEmailPassword) return;
    setActionBusy('email');
    setActionMsg(null);
    try {
      await onEmailPassword(user);
      setActionMsg({ type: 'success', text: 'New login password sent via email.' });
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to email password.' });
    } finally {
      setActionBusy(null);
    }
  };

  const handleDelete = async () => {
    if (!onDeleteUser) return;
    if (isSelf) return;
    if (!confirm(`Permanently delete ${user.full_name}? This cannot be undone.`)) return;
    setActionBusy('delete');
    setActionMsg(null);
    try {
      await onDeleteUser(user);
      onClose();
    } catch (e) {
      setActionMsg({ type: 'error', text: e instanceof Error ? e.message : 'Failed to delete user.' });
      setActionBusy(null);
    }
  };

  const workModeLabel =
    user.work_mode === 'remote'
      ? 'Remote'
      : user.work_mode === 'hybrid'
        ? 'Hybrid'
        : 'Office (GPS)';

  return (
    <div className="user-hub-overlay user-hub-overlay--page">
      <div className="user-hub-dialog user-hub-dialog--page" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`${user.full_name} profile hub`}>
        <div className="user-hub-topbar">
          <button type="button" className="user-hub-back" onClick={onClose}>
            <ArrowLeft size={18} />
            Back to People
          </button>
        </div>

        {/* Header Hero */}
        <header className="user-hub-hero">
          <div className="user-hub-hero__info">
            <div className={avatarClass(user.role)} aria-hidden>
              {initials(user.full_name)}
            </div>
            <div className="user-hub-hero__text">
              <div className="user-hub-hero__title-row">
                <h2>{user.full_name}</h2>
                <span className={roleBadgeClass(user.role)}>{displayRoleLabel(user.role)}</span>
                {isSelf && <span className="people-you">You</span>}
              </div>
              <p className="user-hub-hero__email">{user.email}</p>
              <div className="user-hub-hero__tags">
                {user.job_title?.trim() ? (
                  <span className="user-hub-tag">
                    <User size={13} /> {user.job_title.trim()}
                  </span>
                ) : null}
                <span className="user-hub-tag">
                  <Building2 size={13} /> {dept ? dept.name : 'No Department'}
                </span>
                <span className="user-hub-tag">
                  <MapPin size={13} /> {workModeLabel}
                </span>
                {manager && (
                  <span className="user-hub-tag">
                    <User size={13} /> Supervisor: {manager.full_name}
                  </span>
                )}
              </div>
            </div>
          </div>
        </header>

        {actionMsg && (
          <div className={`user-hub-alert user-hub-alert--${actionMsg.type}`}>
            {actionMsg.type === 'success' ? <CheckCircle2 size={16} /> : <AlertCircle size={16} />}
            <span>{actionMsg.text}</span>
          </div>
        )}

        {/* Relatable Hub Grid */}
        <div className="user-hub-body">
          <h3 className="user-hub-section-title">Related Modules & Operations</h3>
          <div className="user-hub-grid">
            {/* 1. KPIs & Performance */}
            <div className="user-hub-card">
              <div className="user-hub-card__head">
                <div className="user-hub-card__icon user-hub-card__icon--kpi">
                  <Target size={18} />
                </div>
                <div>
                  <h4>KPIs & Performance</h4>
                  <p>Attainment & Score</p>
                </div>
              </div>
              <div className="user-hub-card__content">
                {stats.kpisLoading ? (
                  <div className="user-hub-card__loading">
                    <Loader2 size={16} className="spin-icon" /> Loading KPIs…
                  </div>
                ) : (
                  <div className="user-hub-card__metrics">
                    <div className="user-hub-metric">
                      <span>Assigned Tasks</span>
                      <strong>{stats.kpis.length}</strong>
                    </div>
                    <div className="user-hub-metric">
                      <span>Completed</span>
                      <strong className="text-success">{completedKpis.length}</strong>
                    </div>
                    <div className="user-hub-metric">
                      <span>Performance Pts</span>
                      <strong>{formatKpiScore(stats.rewardPoints)}</strong>
                    </div>
                    {pausedKpis.length > 0 && (
                      <div className="user-hub-metric">
                        <span>Paused</span>
                        <strong className="text-warning">{pausedKpis.length}</strong>
                      </div>
                    )}
                  </div>
                )}
              </div>
              <div className="user-hub-card__actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    onClose();
                    onNavigateToKpis(user);
                  }}
                >
                  <LayoutDashboard size={14} /> Open KPI Board
                </button>
                {onNavigateToAnalytics && (
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => {
                      onClose();
                      onNavigateToAnalytics(user);
                    }}
                  >
                    <BarChart3 size={14} /> View Analytics
                  </button>
                )}
              </div>
            </div>

            {/* 2. Assign Task */}
            <div className="user-hub-card">
              <div className="user-hub-card__head">
                <div className="user-hub-card__icon user-hub-card__icon--assign">
                  <PlusCircle size={18} />
                </div>
                <div>
                  <h4>Assign Task</h4>
                  <p>Allocate KPIs & Work</p>
                </div>
              </div>
              <div className="user-hub-card__content">
                <p className="user-hub-card__desc">
                  Quickly assign a new KPI or urgent task to <strong>{user.full_name}</strong> with custom weight, due date, and score points.
                </p>
                <div className="user-hub-card__pills">
                  <span className="user-hub-pill">
                    Active Tasks: <strong>{activeKpis.length}</strong>
                  </span>
                  <span className="user-hub-pill">
                    Weight Budget: <strong>{formatKpiWeight(Math.min(100, totalWeight))}</strong>
                  </span>
                </div>
              </div>
              <div className="user-hub-card__actions">
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={() => {
                    onClose();
                    onNavigateToAssignTask(user);
                  }}
                >
                  <PlusCircle size={14} /> Assign New Task
                </button>
              </div>
            </div>

            {/* 3. Department */}
            <div className="user-hub-card">
              <div className="user-hub-card__head">
                <div className="user-hub-card__icon user-hub-card__icon--dept">
                  <Building2 size={18} />
                </div>
                <div>
                  <h4>Department</h4>
                  <p>Team & Org Unit</p>
                </div>
              </div>
              <div className="user-hub-card__content">
                <div className="user-hub-dept-box">
                  <strong>{dept ? dept.name : 'Unassigned'}</strong>
                  <span>{dept ? `${allUsers.filter((u) => u.department_id === dept.id).length} members in department` : 'Assign this person to a department'}</span>
                </div>
              </div>
              <div className="user-hub-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    onClose();
                    onNavigateToDepartment(user.department_id);
                  }}
                >
                  <Building2 size={14} /> View Departments
                </button>
              </div>
            </div>

            {/* 4. Attendance */}
            <div className="user-hub-card">
              <div className="user-hub-card__head">
                <div className="user-hub-card__icon user-hub-card__icon--att">
                  <CalendarCheck size={18} />
                </div>
                <div>
                  <h4>Attendance</h4>
                  <p>Check-in & Timesheet</p>
                </div>
              </div>
              <div className="user-hub-card__content">
                {stats.attendanceLoading ? (
                  <div className="user-hub-card__loading">
                    <Loader2 size={16} className="spin-icon" /> Checking attendance…
                  </div>
                ) : (
                  <div className="user-hub-card__desc-stack">
                    <div className="user-hub-metric-row">
                      <span>Today Status:</span>
                      <strong>{stats.todayAttendance?.status || 'Not marked'}</strong>
                    </div>
                    {stats.todayAttendance?.clock_in_at && (
                      <div className="user-hub-metric-row">
                        <span>Clocked In:</span>
                        <em>{new Date(stats.todayAttendance.clock_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</em>
                      </div>
                    )}
                    <div className="user-hub-metric-row">
                      <span>Work Mode:</span>
                      <span>{workModeLabel}</span>
                    </div>
                  </div>
                )}
              </div>
              <div className="user-hub-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    onClose();
                    onNavigateToAttendance(user);
                  }}
                >
                  <CalendarCheck size={14} /> View Attendance
                </button>
              </div>
            </div>

            {/* 5. Rewards */}
            <div className="user-hub-card">
              <div className="user-hub-card__head">
                <div className="user-hub-card__icon user-hub-card__icon--rewards">
                  <Trophy size={18} />
                </div>
                <div>
                  <h4>Rewards</h4>
                  <p>Points & Awards</p>
                </div>
              </div>
              <div className="user-hub-card__content">
                <div className="user-hub-metric-row">
                  <span>Earned Points:</span>
                  <strong>{formatKpiScore(stats.rewardPoints)} pts</strong>
                </div>
                <div className="user-hub-metric-row">
                  <span>Completed Tasks:</span>
                  <span>{completedKpis.length} tasks</span>
                </div>
              </div>
              <div className="user-hub-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    onClose();
                    onNavigateToRewards(user);
                  }}
                >
                  <Coins size={14} /> View Rewards
                </button>
              </div>
            </div>

            {/* 6. Daily Reports */}
            <div className="user-hub-card">
              <div className="user-hub-card__head">
                <div className="user-hub-card__icon user-hub-card__icon--reports">
                  <FileText size={18} />
                </div>
                <div>
                  <h4>Daily Reports</h4>
                  <p>Daily Submissions</p>
                </div>
              </div>
              <div className="user-hub-card__content">
                {stats.reportsLoading ? (
                  <div className="user-hub-card__loading">
                    <Loader2 size={16} className="spin-icon" /> Checking reports…
                  </div>
                ) : (
                  <div className="user-hub-metric-row">
                    <span>Latest Submission:</span>
                    <strong>{stats.latestReportDate || 'No reports yet'}</strong>
                  </div>
                )}
              </div>
              <div className="user-hub-card__actions">
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    onClose();
                    onNavigateToDailyReports(user);
                  }}
                >
                  <FileText size={14} /> View Daily Reports
                </button>
              </div>
            </div>
          </div>

          {/* Account Admin Management Footer */}
          <div className="user-hub-admin-section">
            <h4>Account Settings & Credentials</h4>
            <div className="user-hub-admin-actions">
              {!demo && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    onClose();
                    onEditUser(user);
                  }}
                >
                  <Pencil size={14} /> Edit Profile & Role
                </button>
              )}
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  onClose();
                  onResetPassword({ id: user.id, name: user.full_name });
                }}
              >
                <KeyRound size={14} /> Reset Password
              </button>
              {!demo && onResetMfa && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={actionBusy === 'mfa'}
                  onClick={() => void handleResetMfa()}
                >
                  {actionBusy === 'mfa' ? <Loader2 size={14} className="spin-icon" /> : <ShieldOff size={14} />}
                  Reset Authenticator
                </button>
              )}
              {!demo && onEmailPassword && user.email && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={actionBusy === 'email'}
                  onClick={() => void handleEmailPassword()}
                >
                  {actionBusy === 'email' ? <Loader2 size={14} className="spin-icon" /> : <Mail size={14} />}
                  Email New Password
                </button>
              )}
              {!demo && onDeleteUser && !isSelf && (
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={actionBusy === 'delete'}
                  onClick={() => void handleDelete()}
                >
                  {actionBusy === 'delete' ? <Loader2 size={14} className="spin-icon" /> : <Trash2 size={14} />}
                  Delete User
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
