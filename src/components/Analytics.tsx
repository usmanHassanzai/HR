import { useCallback, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  Kpi,
  Profile,
  displayRoleLabel,
  isKpiPaused,
  kpiPauseLabel,
  kpiWorkStage,
} from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import {
  calculateOverallKpiScore,
  employeePerformancePoints,
  formatKpiScore,
  isKpiLateCompletion,
  kpiAssignedScore,
  kpiScoreContribution,
  performanceRatingColor,
  performanceRatingForScore,
  roundKpiScore,
} from '../utils/kpiScoreHelpers';
import { formatKpiWeight } from '../utils/kpiWeightHelpers';
import {
  AttendanceRecord,
  ATTENDANCE_STATUS_LABEL,
  attendanceStatusBadgeClass,
} from '../utils/attendanceHelpers';
import { DailyWorkReport, formatReportDate } from '../utils/dailyWorkReportHelpers';
import {
  categoryAttainment,
} from '../utils/analyticsHelpers';
import {
  Activity,
  AlertCircle,
  BarChart3,
  Building2,
  CalendarCheck,
  CheckCircle2,
  Clock,
  FileText,
  Layers,
  Loader2,
  MapPin,
  PauseCircle,
  RefreshCw,
  Target,
  User,
  UserCheck,
  Users,
  LogIn,
  LogOut,
  RotateCcw,
} from 'lucide-react';
import '../styles/admin-analytics.css';

interface AnalyticsProps {
  /** Scope analytics to a specific user (optional) */
  userId?: string;
  initialUserId?: string;
  initialDeptId?: string;
  title?: string;
  subtitle?: string;
}

function attainmentBarClass(pct: number): string {
  if (pct >= 100) return 'admin-analytics-bar-fill--success';
  if (pct >= 80) return 'admin-analytics-bar-fill--warning';
  return 'admin-analytics-bar-fill--danger';
}

function roleBadgeClass(role: Profile['role']): string {
  if (role === 'admin') return 'admin-role-badge admin-role-badge--admin';
  if (role === 'manager') return 'admin-role-badge admin-role-badge--manager';
  if (role === 'hr') return 'admin-role-badge admin-role-badge--hr';
  return 'admin-role-badge admin-role-badge--employee';
}

function initials(name: string): string {
  const p = name.trim().split(/\s+/);
  if (!p.length || !p[0]) return '?';
  if (p.length === 1) return p[0].slice(0, 2).toUpperCase();
  return (p[0][0] + p[p.length - 1][0]).toUpperCase();
}

function formatMinutesDuration(minutes?: number | null): string {
  if (minutes == null || minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

function formatTimeOnly(iso?: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

type NoteEventKind = 'in' | 'out' | 'reenter' | 'other';

function noteEventKind(text: string): NoteEventKind {
  const lower = text.toLowerCase();
  if (lower.includes('re-enter')) return 'reenter';
  if (lower.includes('clock-in') || lower.includes('clock in')) return 'in';
  if (lower.includes('clock-out') || lower.includes('clock out')) return 'out';
  return 'other';
}

function NoteEventIcon({ kind }: { kind: NoteEventKind }) {
  const size = 12;
  if (kind === 'in') return <LogIn size={size} aria-hidden />;
  if (kind === 'out') return <LogOut size={size} aria-hidden />;
  if (kind === 'reenter') return <RotateCcw size={size} aria-hidden />;
  return <MapPin size={size} aria-hidden />;
}

function AttendanceNotesCell({ notes }: { notes?: string | null }) {
  const trimmed = notes?.trim();
  if (!trimmed) {
    return <span className="analytics-notes analytics-notes--empty">—</span>;
  }

  const events = trimmed.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  const previewCount = 2;
  const preview = events.slice(0, previewCount);
  const overflow = events.slice(previewCount);

  return (
    <div className="analytics-notes">
      <div className="analytics-notes__events">
        {preview.map((event, i) => {
          const kind = noteEventKind(event);
          return (
            <span
              key={`${i}-${event.slice(0, 24)}`}
              className={`analytics-notes__chip analytics-notes__chip--${kind}`}
              title={event}
            >
              <NoteEventIcon kind={kind} />
              <span className="analytics-notes__chip-text">{event}</span>
            </span>
          );
        })}
      </div>
      {overflow.length > 0 && (
        <details className="analytics-notes__more">
          <summary>{overflow.length} more event{overflow.length !== 1 ? 's' : ''}</summary>
          <ul className="analytics-notes__list">
            {overflow.map((event, i) => {
              const kind = noteEventKind(event);
              return (
                <li key={`${i}-${event.slice(0, 24)}`}>
                  <span className={`analytics-notes__chip analytics-notes__chip--${kind}`} title={event}>
                    <NoteEventIcon kind={kind} />
                    <span className="analytics-notes__chip-text">{event}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </details>
      )}
    </div>
  );
}

export default function Analytics({
  userId,
  initialUserId,
  initialDeptId,
  title = 'Individual Performance & Activity Analytics',
  subtitle = 'Select a department and teammate to inspect their KPI scores, task execution, attendance history, and daily work reports.',
}: AnalyticsProps) {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [allUsers, setAllUsers] = useState<Profile[]>([]);
  const [loadingBase, setLoadingBase] = useState(true);

  const [selectedDeptId, setSelectedDeptId] = useState<string>(initialDeptId || 'all');
  const [selectedUserId, setSelectedUserId] = useState<string>(userId || initialUserId || '');

  const [kpis, setKpis] = useState<Kpi[]>([]);
  const [attendance, setAttendance] = useState<AttendanceRecord[]>([]);
  const [dailyReports, setDailyReports] = useState<DailyWorkReport[]>([]);

  const [loadingUser, setLoadingUser] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const [activeSubTab, setActiveSubTab] = useState<'kpis' | 'attendance' | 'reports'>('kpis');

  // Load initial departments and users
  const loadBase = useCallback(async () => {
    setLoadingBase(true);
    setError('');
    try {
      const [deptRes, usersRes] = await Promise.all([
        supabase.from('departments').select('*').order('name'),
        supabase.from('users').select('*').order('full_name'),
      ]);

      if (deptRes.error) throw deptRes.error;
      if (usersRes.error) throw usersRes.error;

      const validDepts = (deptRes.data || []) as Department[];
      const validUsers = ((usersRes.data || []) as Profile[]).filter((u) => !u.is_demo);

      setDepartments(validDepts);
      setAllUsers(validUsers);

      // Resolve initial selection
      let targetUser = validUsers.find((u) => u.id === (userId || initialUserId));
      if (!targetUser && validUsers.length > 0) {
        if (initialDeptId && initialDeptId !== 'all') {
          targetUser = validUsers.find((u) => u.department_id === initialDeptId) || validUsers[0];
        } else {
          targetUser = validUsers[0];
        }
      }

      if (targetUser) {
        setSelectedUserId(targetUser.id);
        if (targetUser.department_id && (!initialDeptId || initialDeptId === 'all')) {
          setSelectedDeptId(targetUser.department_id);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load organization directory');
    } finally {
      setLoadingBase(false);
    }
  }, [userId, initialUserId, initialDeptId]);

  useEffect(() => {
    void loadBase();
  }, [loadBase]);

  // Filter users by selected department
  const filteredUsers = useMemo(() => {
    return allUsers.filter((u) => {
      if (selectedDeptId !== 'all' && u.department_id !== selectedDeptId) return false;
      return true;
    });
  }, [allUsers, selectedDeptId]);

  // Handle department filter change
  const handleDepartmentChange = (deptId: string) => {
    setSelectedDeptId(deptId);
    const matching = allUsers.filter((u) => deptId === 'all' || u.department_id === deptId);
    if (matching.length > 0 && !matching.some((u) => u.id === selectedUserId)) {
      setSelectedUserId(matching[0].id);
    }
  };

  // Selected user profile object
  const selectedUser = useMemo(() => {
    return allUsers.find((u) => u.id === selectedUserId) || null;
  }, [allUsers, selectedUserId]);

  // Fetch individual details for selected user
  const loadUserData = useCallback(async (uid: string, silent = false) => {
    if (!uid) return;
    if (!silent) setLoadingUser(true);
    else setRefreshing(true);
    setError('');

    try {
      const [kpiRes, attRes, repRes] = await Promise.all([
        supabase.from('kpis').select('*').eq('user_id', uid).order('created_at', { ascending: false }),
        supabase.from('attendance_records').select('*').eq('user_id', uid).order('attendance_date', { ascending: false }).limit(60),
        supabase.from('daily_work_reports').select('*').eq('user_id', uid).order('report_date', { ascending: false }).limit(30),
      ]);

      if (kpiRes.error) throw kpiRes.error;

      const userKpis = (kpiRes.data || []) as Kpi[];
      setKpis(userKpis);
      setAttendance((attRes.data || []) as AttendanceRecord[]);
      setDailyReports((repRes.data || []) as DailyWorkReport[]);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to fetch user analytics');
    } finally {
      if (!silent) setLoadingUser(false);
      else setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (selectedUserId) {
      void loadUserData(selectedUserId);
    }
  }, [selectedUserId, loadUserData]);

  // KPI Calculations
  const overallScore = useMemo(() => calculateOverallKpiScore(kpis), [kpis]);
  const perfRating = useMemo(() => performanceRatingForScore(overallScore), [overallScore]);
  const perfColor = useMemo(() => performanceRatingColor(perfRating), [perfRating]);
  const perfPoints = useMemo(() => employeePerformancePoints(kpis), [kpis]);

  const totalAssignedWeight = useMemo(() => {
    return roundKpiScore(kpis.reduce((sum, k) => sum + Number(k.weight || 0), 0));
  }, [kpis]);

  const totalAssignedScore = useMemo(() => {
    return roundKpiScore(kpis.reduce((sum, k) => sum + kpiAssignedScore(k), 0));
  }, [kpis]);

  const completedKpis = useMemo(() => kpis.filter((k) => k.completion_status === 'completed'), [kpis]);
  const onTimeKpis = useMemo(() => completedKpis.filter((k) => !isKpiLateCompletion(k)), [completedKpis]);
  const lateKpis = useMemo(() => completedKpis.filter((k) => isKpiLateCompletion(k)), [completedKpis]);
  const pausedKpis = useMemo(() => kpis.filter((k) => isKpiPaused(k)), [kpis]);
  const inProgressKpis = useMemo(() => kpis.filter((k) => kpiWorkStage(k) === 'in_progress' && !isKpiPaused(k)), [kpis]);
  const notStartedKpis = useMemo(() => kpis.filter((k) => kpiWorkStage(k) === 'not_started'), [kpis]);

  const cats = useMemo(() => categoryAttainment(kpis), [kpis]);

  // Trend & Forecast for selected KPI
  // Attendance Calculations
  const attendanceStats = useMemo(() => {
    const total = attendance.length;
    const present = attendance.filter((a) => a.status === 'present').length;
    const late = attendance.filter((a) => a.status === 'late').length;
    const halfDay = attendance.filter((a) => a.status === 'half_day').length;
    const absent = attendance.filter((a) => a.status === 'absent').length;

    const totalMinutes = attendance.reduce((sum, a) => sum + (Number(a.work_minutes) || 0), 0);
    const activeDays = present + late + halfDay;
    const avgMinutes = activeDays > 0 ? Math.round(totalMinutes / activeDays) : 0;
    const rate = total > 0 ? Math.round(((present + late + halfDay * 0.5) / total) * 100) : 100;
    const onTimeRate = activeDays > 0 ? Math.round((present / activeDays) * 100) : 100;

    return {
      total,
      present,
      late,
      halfDay,
      absent,
      totalHours: (totalMinutes / 60).toFixed(1),
      avgMinutes,
      rate,
      onTimeRate,
    };
  }, [attendance]);

  // Supervisor & Dept for selected user
  const userDept = useMemo(() => {
    return departments.find((d) => d.id === selectedUser?.department_id);
  }, [departments, selectedUser]);

  const userSupervisor = useMemo(() => {
    return allUsers.find((u) => u.id === selectedUser?.manager_id);
  }, [allUsers, selectedUser]);

  if (loadingBase) {
    return (
      <div className="admin-analytics-loading">
        <Loader2 className="animate-spin" size={32} style={{ color: 'var(--accent-primary)' }} />
        <span>Loading analytics workspace…</span>
      </div>
    );
  }

  return (
    <div className="admin-analytics-page animate-fade-in">
      {/* ── Main Header ── */}
      <header className="admin-analytics-header glass-panel">
        <div className="admin-analytics-header__main">
          <div className="admin-analytics-header__icon">
            <BarChart3 size={24} />
          </div>
          <div>
            <h2 className="admin-analytics-header__title">{title}</h2>
            <p className="admin-analytics-header__subtitle">{subtitle}</p>
          </div>
        </div>

        {/* ── Department & Person Selection Toolbar ── */}
        <div className="analytics-picker-bar">
          <div className="analytics-picker-field">
            <label htmlFor="analytics-dept-select">
              <Building2 size={14} /> Department
            </label>
            <select
              id="analytics-dept-select"
              className="form-input"
              value={selectedDeptId}
              onChange={(e) => handleDepartmentChange(e.target.value)}
            >
              <option value="all">All Departments ({allUsers.length} staff)</option>
              {departments.map((d) => {
                const count = allUsers.filter((u) => u.department_id === d.id).length;
                return (
                  <option key={d.id} value={d.id}>
                    {d.name} ({count} {count === 1 ? 'member' : 'members'})
                  </option>
                );
              })}
            </select>
          </div>

          <div className="analytics-picker-field analytics-picker-field--user">
            <label htmlFor="analytics-user-select">
              <User size={14} /> Teammate / Person
            </label>
            <select
              id="analytics-user-select"
              className="form-input"
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              disabled={filteredUsers.length === 0}
            >
              {filteredUsers.length === 0 ? (
                <option value="">No people in this department</option>
              ) : (
                filteredUsers.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} — {displayRoleLabel(u.role)}
                  </option>
                ))
              )}
            </select>
          </div>

          <div className="analytics-picker-actions">
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void loadUserData(selectedUserId, true)}
              disabled={refreshing || !selectedUserId}
              title="Refresh individual metrics"
            >
              <RefreshCw size={14} className={refreshing ? 'animate-spin' : ''} />
              Refresh
            </button>
          </div>
        </div>
      </header>

      {error && (
        <div className="admin-analytics-alert" role="alert">
          <AlertCircle size={18} />
          <span>{error}</span>
        </div>
      )}

      {!selectedUser ? (
        <div className="admin-analytics-empty glass-panel">
          <Users size={40} />
          <h3>Select a teammate above to view individual analytics</h3>
          <p>Pick any department or employee from the selector to view their KPI, task, and attendance records.</p>
        </div>
      ) : loadingUser ? (
        <div className="admin-analytics-loading glass-panel">
          <Loader2 className="animate-spin" size={32} style={{ color: 'var(--accent-primary)' }} />
          <span>Gathering full analytics for {selectedUser.full_name}…</span>
        </div>
      ) : (
        <>
          {/* ── Individual Profile Hero Banner ── */}
          <section className="analytics-user-hero glass-panel">
            <div className="analytics-user-hero__info">
              <div className="analytics-user-hero__avatar" aria-hidden>
                {initials(selectedUser.full_name)}
              </div>
              <div className="analytics-user-hero__meta">
                <div className="analytics-user-hero__title-row">
                  <h3>{selectedUser.full_name}</h3>
                  <span className={roleBadgeClass(selectedUser.role)}>
                    {displayRoleLabel(selectedUser.role)}
                  </span>
                </div>
                <p className="analytics-user-hero__email">{selectedUser.email}</p>
                <div className="analytics-user-hero__tags">
                  <span className="analytics-user-tag">
                    <Building2 size={13} /> {userDept ? userDept.name : 'Unassigned Dept'}
                  </span>
                  {userSupervisor && (
                    <span className="analytics-user-tag">
                      <UserCheck size={13} /> Supervisor: {userSupervisor.full_name}
                    </span>
                  )}
                  <span className="analytics-user-tag">
                    <MapPin size={13} /> {selectedUser.work_mode === 'remote' ? 'Remote' : selectedUser.work_mode === 'hybrid' ? 'Hybrid' : 'In-Office'}
                  </span>
                </div>
              </div>
            </div>

            <div className="analytics-user-hero__score-box" style={{ borderColor: perfColor }}>
              <span className="analytics-user-hero__score-label">Overall KPI Score</span>
              <div className="analytics-user-hero__score-num" style={{ color: perfColor }}>
                {formatKpiScore(overallScore)}%
              </div>
              <span className="analytics-user-hero__score-rating" style={{ color: perfColor }}>
                {perfRating}
              </span>
            </div>
          </section>

          {/* ── Key Performance & Activity Summary Grid ── */}
          <div className="admin-analytics-grid">
            <section className="glass-panel admin-analytics-card">
              <p className="admin-analytics-card__eyebrow">Task Execution</p>
              <div className="admin-analytics-card__value-row">
                <span className="admin-analytics-card__value">{completedKpis.length} / {kpis.length}</span>
                <span className="admin-analytics-pill admin-analytics-pill--success">
                  {kpis.length > 0 ? Math.round((completedKpis.length / kpis.length) * 100) : 0}% done
                </span>
              </div>
              <p className="admin-analytics-card__hint">
                {onTimeKpis.length} on time · {lateKpis.length} late completion {pausedKpis.length > 0 ? `· ${pausedKpis.length} paused` : ''}
              </p>
            </section>

            <section className="glass-panel admin-analytics-card">
              <p className="admin-analytics-card__eyebrow">Score vs Weight</p>
              <div className="admin-analytics-card__value-row">
                <span className="admin-analytics-card__value">{formatKpiScore(perfPoints)} pts</span>
                {totalAssignedScore > totalAssignedWeight && (
                  <span className="admin-analytics-pill admin-analytics-pill--accent" title="Score exceeds assigned weight">
                    +{formatKpiScore(totalAssignedScore - totalAssignedWeight)} bonus
                  </span>
                )}
              </div>
              <p className="admin-analytics-card__hint">
                Target weight: {formatKpiWeight(totalAssignedWeight)} · Assigned score: {formatKpiScore(totalAssignedScore)}
              </p>
            </section>

            <section className="glass-panel admin-analytics-card">
              <p className="admin-analytics-card__eyebrow">Attendance Rate</p>
              <div className="admin-analytics-card__value-row">
                <span className="admin-analytics-card__value">{attendanceStats.rate}%</span>
                <span className="admin-analytics-pill admin-analytics-pill--success">
                  {attendanceStats.present} present
                </span>
              </div>
              <p className="admin-analytics-card__hint">
                {attendanceStats.late} late arrivals · {attendanceStats.totalHours} hrs worked total
              </p>
            </section>

            <section className="glass-panel admin-analytics-card">
              <p className="admin-analytics-card__eyebrow">Daily Work Reports</p>
              <div className="admin-analytics-card__value-row">
                <span className="admin-analytics-card__value">{dailyReports.length}</span>
                <span className="admin-analytics-pill">Submitted</span>
              </div>
              <p className="admin-analytics-card__hint">
                {dailyReports.length > 0
                  ? `Latest report: ${formatReportDate(dailyReports[0].report_date)}`
                  : 'No daily reports logged yet'}
              </p>
            </section>
          </div>

          {/* ── Sub-Section Tabs (KPIs, Attendance, Daily Reports) ── */}
          <div className="analytics-subnav tab-bar tab-bar--inline-mobile" role="tablist">
            <button
              type="button"
              className={`tab-btn ${activeSubTab === 'kpis' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveSubTab('kpis')}
            >
              <Target size={16} /> KPIs & Assigned Tasks ({kpis.length})
            </button>
            <button
              type="button"
              className={`tab-btn ${activeSubTab === 'attendance' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveSubTab('attendance')}
            >
              <CalendarCheck size={16} /> Attendance Records ({attendance.length})
            </button>
            <button
              type="button"
              className={`tab-btn ${activeSubTab === 'reports' ? 'tab-btn--active' : ''}`}
              onClick={() => setActiveSubTab('reports')}
            >
              <FileText size={16} /> Daily Work Reports ({dailyReports.length})
            </button>
          </div>

          {/* ── TAB 1: KPIs & Assigned Tasks ── */}
          {activeSubTab === 'kpis' && (
            <div className="analytics-tab-pane animate-fade-in">
              {/* Status Breakdown & Category Attainment Row */}
              <div className="admin-analytics-two-col">
                <section className="glass-panel admin-analytics-section">
                  <div className="admin-analytics-section__head">
                    <div>
                      <h3 className="admin-analytics-section__title">
                        <Activity size={17} style={{ color: 'var(--accent-primary)' }} />
                        Task Status Distribution
                      </h3>
                      <p className="admin-analytics-section__hint">
                        Execution velocity for tasks assigned to {selectedUser.full_name}.
                      </p>
                    </div>
                  </div>

                  <div className="analytics-status-grid">
                    <div className="analytics-status-box analytics-status-box--done">
                      <span>Completed On Time</span>
                      <strong>{onTimeKpis.length}</strong>
                      <small>Full Score Points</small>
                    </div>
                    <div className="analytics-status-box analytics-status-box--late">
                      <span>Completed Late</span>
                      <strong>{lateKpis.length}</strong>
                      <small>Half Points (After Due)</small>
                    </div>
                    <div className="analytics-status-box analytics-status-box--progress">
                      <span>In Progress</span>
                      <strong>{inProgressKpis.length}</strong>
                      <small>Work Ongoing</small>
                    </div>
                    {pausedKpis.length > 0 && (
                      <div className="analytics-status-box analytics-status-box--paused">
                        <span>Paused</span>
                        <strong>{pausedKpis.length}</strong>
                        <small>Urgent Task Active</small>
                      </div>
                    )}
                    <div className="analytics-status-box analytics-status-box--notstarted">
                      <span>Not Started</span>
                      <strong>{notStartedKpis.length}</strong>
                      <small>Unopened</small>
                    </div>
                  </div>
                </section>

                <section className="glass-panel admin-analytics-section">
                  <div className="admin-analytics-section__head">
                    <div>
                      <h3 className="admin-analytics-section__title">
                        <Layers size={17} />
                        Attainment by Category
                      </h3>
                      <p className="admin-analytics-section__hint">Performance attainment grouped by KPI nature.</p>
                    </div>
                  </div>
                  {cats.length > 0 ? (
                    <div className="admin-analytics-bars">
                      {cats.map((c) => (
                        <div key={c.category} className="admin-analytics-bar-row">
                          <div className="admin-analytics-bar-row__head">
                            <span className="admin-analytics-bar-row__label">{c.category}</span>
                            <span className="admin-analytics-bar-row__pct">{c.attainment}%</span>
                          </div>
                          <div className="admin-analytics-bar-track">
                            <div
                              className={`admin-analytics-bar-fill ${attainmentBarClass(c.attainment)}`}
                              style={{ width: `${Math.min(100, c.attainment)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="admin-analytics-empty" style={{ padding: '2rem 1rem' }}>
                      <Layers size={32} />
                      <p>No category data available yet.</p>
                    </div>
                  )}
                </section>
              </div>

              {/* Comprehensive List of Assigned KPIs */}
              <section className="glass-panel admin-analytics-section">
                <div className="admin-analytics-section__head">
                  <div>
                    <h3 className="admin-analytics-section__title">
                      <Target size={17} />
                      Assigned KPIs & Task Ledger
                    </h3>
                    <p className="admin-analytics-section__hint">
                      Individual scores, weights, due dates, and completion points.
                    </p>
                  </div>
                </div>

                {kpis.length === 0 ? (
                  <div className="admin-analytics-empty">
                    <Target size={36} />
                    <p>No KPIs or tasks assigned to {selectedUser.full_name} yet.</p>
                  </div>
                ) : (
                  <div className="admin-users-table-wrap">
                    <table className="admin-users-table analytics-table">
                      <thead>
                        <tr>
                          <th>KPI / Task Name</th>
                          <th>Category</th>
                          <th>Weight</th>
                          <th>Assigned Score</th>
                          <th>Points Awarded</th>
                          <th>Dates</th>
                          <th>Status / Progress</th>
                        </tr>
                      </thead>
                      <tbody>
                        {kpis.map((k) => {
                          const assignedScore = kpiAssignedScore(k);
                          const awarded = kpiScoreContribution(k);
                          const isDone = k.completion_status === 'completed';
                          const isLate = isKpiLateCompletion(k);
                          const paused = isKpiPaused(k);
                          const pauseLabel = kpiPauseLabel(k);

                          return (
                            <tr key={k.id}>
                              <td>
                                <strong className="analytics-kpi-name">{k.name}</strong>
                                {k.description && <p className="analytics-kpi-desc">{k.description}</p>}
                              </td>
                              <td>
                                <span className="analytics-tag">{k.kpi_category ? k.kpi_category.replace(/_/g, ' ') : 'General'}</span>
                              </td>
                              <td>
                                <strong>{formatKpiWeight(k.weight)}</strong>
                              </td>
                              <td>
                                <span>{formatKpiScore(assignedScore)} pts</span>
                              </td>
                              <td>
                                {isDone ? (
                                  <strong className={isLate ? 'text-warning' : 'text-success'}>
                                    {formatKpiScore(awarded)} pts {isLate ? '(Half - Late)' : '(Full)'}
                                  </strong>
                                ) : (
                                  <span className="text-muted">0.00 pts (Open)</span>
                                )}
                              </td>
                              <td>
                                <span className="analytics-date-range">
                                  {k.start_date || '—'} → {k.end_date || '—'}
                                </span>
                              </td>
                              <td>
                                {paused ? (
                                  <span className="admin-role-badge admin-role-badge--manager" title={pauseLabel}>
                                    <PauseCircle size={12} /> Paused
                                  </span>
                                ) : isDone ? (
                                  <span className="admin-role-badge admin-role-badge--admin">
                                    <CheckCircle2 size={12} /> Complete
                                  </span>
                                ) : k.employee_progress === 'started' ? (
                                  <span className="admin-role-badge admin-role-badge--employee">
                                    <Clock size={12} /> In Progress
                                  </span>
                                ) : (
                                  <span className="admin-role-badge">Not Started</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ── TAB 2: Attendance & Timesheet ── */}
          {activeSubTab === 'attendance' && (
            <div className="analytics-tab-pane animate-fade-in">
              {/* Attendance Highlights Grid */}
              <div className="admin-analytics-grid">
                <section className="glass-panel admin-analytics-card">
                  <p className="admin-analytics-card__eyebrow">Present Days</p>
                  <div className="admin-analytics-card__value-row">
                    <span className="admin-analytics-card__value">{attendanceStats.present}</span>
                    <span className="admin-analytics-pill admin-analytics-pill--success">
                      {attendanceStats.onTimeRate}% on-time
                    </span>
                  </div>
                  <p className="admin-analytics-card__hint">
                    {attendanceStats.late} late clock-ins logged
                  </p>
                </section>

                <section className="glass-panel admin-analytics-card">
                  <p className="admin-analytics-card__eyebrow">Absences & Leaves</p>
                  <div className="admin-analytics-card__value-row">
                    <span className="admin-analytics-card__value">{attendanceStats.absent}</span>
                    <span className="admin-analytics-pill admin-analytics-pill--danger">Absences</span>
                  </div>
                  <p className="admin-analytics-card__hint">
                    {attendanceStats.halfDay} half-days recorded
                  </p>
                </section>

                <section className="glass-panel admin-analytics-card">
                  <p className="admin-analytics-card__eyebrow">Total Hours Logged</p>
                  <div className="admin-analytics-card__value-row">
                    <span className="admin-analytics-card__value">{attendanceStats.totalHours} hrs</span>
                  </div>
                  <p className="admin-analytics-card__hint">
                    Avg {formatMinutesDuration(attendanceStats.avgMinutes)} per active shift
                  </p>
                </section>
              </div>

              {/* Attendance Log Table */}
              <section className="glass-panel admin-analytics-section">
                <div className="admin-analytics-section__head">
                  <div>
                    <h3 className="admin-analytics-section__title">
                      <CalendarCheck size={17} />
                      Attendance & Shift Timesheet Log
                    </h3>
                    <p className="admin-analytics-section__hint">
                      Recent attendance sessions and geofenced check-ins for {selectedUser.full_name}.
                    </p>
                  </div>
                </div>

                {attendance.length === 0 ? (
                  <div className="admin-analytics-empty">
                    <CalendarCheck size={36} />
                    <p>No attendance records logged for this person yet.</p>
                  </div>
                ) : (
                  <div className="admin-users-table-wrap">
                    <table className="admin-users-table analytics-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Status</th>
                          <th>Clock In</th>
                          <th>Clock Out</th>
                          <th>Duration</th>
                          <th>Check-in Source</th>
                          <th className="analytics-table__notes-col">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {attendance.map((rec) => (
                          <tr key={rec.id}>
                            <td>
                              <strong>{formatReportDate(rec.attendance_date)}</strong>
                            </td>
                            <td>
                              <span className={`badge ${attendanceStatusBadgeClass(rec.status)}`}>
                                {ATTENDANCE_STATUS_LABEL[rec.status] || rec.status}
                              </span>
                            </td>
                            <td>{formatTimeOnly(rec.clock_in_at)}</td>
                            <td>{formatTimeOnly(rec.clock_out_at)}</td>
                            <td>{formatMinutesDuration(rec.work_minutes)}</td>
                            <td>
                              <span className="analytics-tag">{rec.attendance_source || 'Geofence / Office'}</span>
                            </td>
                            <td className="analytics-table__notes-col">
                              <AttendanceNotesCell notes={rec.notes} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ── TAB 3: Daily Work Reports ── */}
          {activeSubTab === 'reports' && (
            <div className="analytics-tab-pane animate-fade-in">
              <section className="glass-panel admin-analytics-section">
                <div className="admin-analytics-section__head">
                  <div>
                    <h3 className="admin-analytics-section__title">
                      <FileText size={17} />
                      Daily Work Reports Log
                    </h3>
                    <p className="admin-analytics-section__hint">
                      Submitted end-of-day summaries by {selectedUser.full_name}.
                    </p>
                  </div>
                </div>

                {dailyReports.length === 0 ? (
                  <div className="admin-analytics-empty">
                    <FileText size={36} />
                    <p>No daily work reports submitted by this person yet.</p>
                  </div>
                ) : (
                  <div className="analytics-reports-stack">
                    {dailyReports.map((rep) => (
                      <article key={rep.id} className="analytics-report-card">
                        <header className="analytics-report-card__header">
                          <div className="analytics-report-card__title">
                            <FileText size={15} />
                            <strong>{formatReportDate(rep.report_date)}</strong>
                          </div>
                          <span className="analytics-report-card__time">
                            Submitted: {new Date(rep.submitted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        </header>
                        <div className="analytics-report-card__content">
                          <p>{rep.content}</p>
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </div>
  );
}
