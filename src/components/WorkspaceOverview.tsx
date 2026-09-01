import { useEffect, useMemo, useState } from 'react';
import { AlertCircle, Building2, CalendarCheck, CheckCircle2, Clock3, Inbox, Target, UserCheck, UserCog, Users, UserX, X } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import { localYmd } from '../utils/geoAttendance';
import { isKpiPastDeadline } from '../utils/kpiScoreHelpers';
import MyShiftCard from './MyShiftCard';

type HomeVariant = 'admin' | 'manager' | 'employee';

interface WorkspaceOverviewProps {
  variant: HomeVariant;
  profile: Profile;
  people?: Profile[];
  departments?: Department[];
  unreadReports?: number;
  onOpen: (tab: string) => void;
}

interface KpiLite {
  id: string;
  name: string;
  status: string;
  completion_status?: 'pending' | 'completed' | null;
  end_date: string | null;
  user_id: string;
}

interface LeaveLite {
  id: string;
  start_date: string;
  end_date: string;
}

interface AttLite {
  id: string;
  user_id: string;
  status: string;
  clock_in_at?: string | null;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

function roleLabel(role: Profile['role']): string {
  if (role === 'manager') return 'Manager';
  if (role === 'admin') return 'Admin';
  if (role === 'hr') return 'HR';
  return 'Employee';
}

export default function WorkspaceOverview({
  variant,
  profile,
  people = [],
  departments = [],
  unreadReports = 0,
  onOpen,
}: WorkspaceOverviewProps) {
  const today = localYmd();
  const [kpis, setKpis] = useState<KpiLite[]>([]);
  const [leaves, setLeaves] = useState<LeaveLite[]>([]);
  const [attendance, setAttendance] = useState<AttLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [showDepartments, setShowDepartments] = useState(false);
  const [rosterKind, setRosterKind] = useState<null | 'present' | 'absent'>(null);
  const [openDeptId, setOpenDeptId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoading(true);
      let kpiQuery = supabase
        .from('kpis')
        .select('id, name, status, completion_status, end_date, user_id');
      if (variant === 'employee') kpiQuery = kpiQuery.eq('user_id', profile.id);
      kpiQuery = kpiQuery.limit(400);

      let leaveQuery = supabase
        .from('leave_requests')
        .select('id, start_date, end_date')
        .eq('status', 'pending');
      if (variant === 'employee') leaveQuery = leaveQuery.eq('user_id', profile.id);
      leaveQuery = leaveQuery.limit(30);

      let attQuery = supabase
        .from('attendance_records')
        .select('id, user_id, status, clock_in_at')
        .eq('attendance_date', today);
      if (variant === 'employee') attQuery = attQuery.eq('user_id', profile.id);
      attQuery = attQuery.limit(400);

      const [kpiRes, leaveRes, attRes] = await Promise.all([kpiQuery, leaveQuery, attQuery]);
      if (cancelled) return;
      setKpis((kpiRes.data || []) as KpiLite[]);
      setLeaves((leaveRes.data || []) as LeaveLite[]);
      setAttendance((attRes.data || []) as AttLite[]);
      setLoading(false);
    };
    void load();
    return () => { cancelled = true; };
  }, [profile.id, today, variant]);

  const completed = kpis.filter((k) => k.completion_status === 'completed').length;
  const openKpis = kpis.filter((k) => k.completion_status !== 'completed');
  const overdue = openKpis.filter((k) => isKpiPastDeadline({
    end_date: k.end_date,
    completion_status: k.completion_status === 'completed' ? 'completed' : 'pending',
  })).length;
  const todayByUser = new Map<string, AttLite>();
  for (const row of attendance) {
    const prev = todayByUser.get(row.user_id);
    if (!prev || (prev.status === 'absent' && row.status !== 'absent')) {
      todayByUser.set(row.user_id, row);
    }
  }
  const todayRows = [...todayByUser.values()];
  const staff = people.filter((p) => !p.is_demo && (p.role === 'employee' || p.role === 'manager'));
  const presentPeople = staff.filter((p) => {
    const row = todayByUser.get(p.id);
    return Boolean(row && row.status !== 'absent');
  });
  const absentPeople = staff.filter((p) => todayByUser.get(p.id)?.status === 'absent');
  const presentToday = presentPeople.length;
  const absentToday = absentPeople.length;
  const onSite = todayRows.filter((a) => a.status !== 'absent' && a.clock_in_at).length;
  const employeeTotal = staff.filter((p) => p.role === 'employee').length;
  const managerTotal = staff.filter((p) => p.role === 'manager').length;
  const myToday = attendance[0];

  const groupByDepartment = (list: Profile[]) => {
    const groups = departments
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        id: d.id,
        name: d.name,
        people: list.filter((p) => p.department_id === d.id).sort((a, b) => a.full_name.localeCompare(b.full_name)),
      }))
      .filter((g) => g.people.length > 0);
    const unassigned = list.filter((p) => !p.department_id || !departments.some((d) => d.id === p.department_id));
    if (unassigned.length) {
      groups.push({
        id: '__unassigned__',
        name: 'Unassigned',
        people: unassigned.sort((a, b) => a.full_name.localeCompare(b.full_name)),
      });
    }
    return groups;
  };

  const rosterGroups = groupByDepartment(rosterKind === 'absent' ? absentPeople : presentPeople);

  const deptDirectory = useMemo(() => {
    return departments
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((d) => ({
        id: d.id,
        name: d.name,
        people: people
          .filter((p) => !p.is_demo && p.department_id === d.id)
          .sort((a, b) => a.full_name.localeCompare(b.full_name)),
      }));
  }, [departments, people]);

  const deptRows = useMemo(() => {
    return deptDirectory
      .filter((d) => d.people.length > 0)
      .map((d) => ({ id: d.id, name: d.name, count: d.people.length }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 6);
  }, [deptDirectory]);
  const deptMax = Math.max(1, ...deptRows.map((d) => d.count));

  const dueSoon = openKpis
    .slice()
    .sort((a, b) => (a.end_date || '9999').localeCompare(b.end_date || '9999'))
    .slice(0, 5);

  const attention: { id: string; title: string; detail: string; tab: string }[] = [];
  if (leaves.length) {
    attention.push({
      id: 'leave',
      title: variant === 'employee' ? 'Leave request pending' : `${leaves.length} leave request${leaves.length === 1 ? '' : 's'} waiting`,
      detail: 'Review or track time-off in Attendance.',
      tab: 'attendance',
    });
  }
  if (overdue) {
    attention.push({
      id: 'overdue',
      title: `${overdue} overdue KPI${overdue === 1 ? '' : 's'}`,
      detail: 'Past deadline and still open.',
      tab: 'kpis',
    });
  }
  if (variant !== 'employee' && unreadReports > 0) {
    attention.push({
      id: 'reports',
      title: `${unreadReports} new daily report${unreadReports === 1 ? '' : 's'}`,
      detail: 'Open Settings to read today’s logs.',
      tab: 'settings',
    });
  }
  if (variant === 'employee' && !myToday) {
    attention.push({
      id: 'checkin',
      title: 'Not checked in yet',
      detail: 'Open Attendance when you are at work or requesting leave.',
      tab: 'attendance',
    });
  }

  const dateLabel = new Date().toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <div className="ws-home">
      <header className="ws-home__hero">
        <p className="ws-home__date">{dateLabel}</p>
        <h2>{greeting()}, {firstName(profile.full_name)}</h2>
        <p className="ws-home__pulse">
          {loading
            ? 'Loading today’s picture…'
            : attention.length
              ? `${attention.length} item${attention.length === 1 ? '' : 's'} need your attention.`
              : 'Nothing urgent. The workspace is running smoothly.'}
        </p>
      </header>

      {variant === 'employee' && <MyShiftCard userId={profile.id} layout="banner" />}

      <div className="ws-home__metrics">
        {variant === 'employee' ? (
          <article className="ws-metric">
            <span className="ws-metric__icon"><CalendarCheck size={18} /></span>
            <strong>{myToday ? (myToday.status === 'absent' ? 'Absent' : 'In') : '—'}</strong>
            <span>Today</span>
          </article>
        ) : (
          <>
            <button
              type="button"
              className="ws-metric ws-metric--present"
              onClick={() => {
                if (variant === 'admin') {
                  setShowDepartments(false);
                  setRosterKind('present');
                  setOpenDeptId(null);
                } else {
                  onOpen('attendance');
                }
              }}
            >
              <span className="ws-metric__icon"><UserCheck size={18} /></span>
              <strong>{presentToday}</strong>
              <span>Present today</span>
            </button>
            <button
              type="button"
              className="ws-metric ws-metric--absent"
              onClick={() => {
                if (variant === 'admin') {
                  setShowDepartments(false);
                  setRosterKind('absent');
                  setOpenDeptId(null);
                } else {
                  onOpen('attendance');
                }
              }}
            >
              <span className="ws-metric__icon"><UserX size={18} /></span>
              <strong>{absentToday}</strong>
              <span>Absent today</span>
            </button>
            {variant === 'admin' && (
              <>
                <button type="button" className="ws-metric" onClick={() => onOpen('employees')}>
                  <span className="ws-metric__icon"><Users size={18} /></span>
                  <strong>{employeeTotal}</strong>
                  <span>Total employees</span>
                </button>
                <button type="button" className="ws-metric" onClick={() => onOpen('employees')}>
                  <span className="ws-metric__icon"><UserCog size={18} /></span>
                  <strong>{managerTotal}</strong>
                  <span>Total managers</span>
                </button>
                <button type="button" className="ws-metric" onClick={() => { setRosterKind(null); setShowDepartments(true); setOpenDeptId(null); }}>
                  <span className="ws-metric__icon"><Building2 size={18} /></span>
                  <strong>{departments.length}</strong>
                  <span>Total departments</span>
                </button>
              </>
            )}
          </>
        )}
        <article className="ws-metric">
          <span className="ws-metric__icon"><Inbox size={18} /></span>
          <strong>{leaves.length}</strong>
          <span>{variant === 'employee' ? 'Pending leave' : 'Leave to review'}</span>
        </article>
        <article className="ws-metric">
          <span className="ws-metric__icon"><Target size={18} /></span>
          <strong>{openKpis.length}</strong>
          <span>{completed} completed · {overdue} overdue</span>
        </article>
        {variant === 'employee' && (
          <article className="ws-metric">
            <span className="ws-metric__icon"><Clock3 size={18} /></span>
            <strong>{onSite || (myToday ? 1 : 0)}</strong>
            <span>On-site sessions</span>
          </article>
        )}
      </div>

      <div className="ws-home__columns">
        <section className="ws-panel">
          <h3>Needs attention</h3>
          {attention.length === 0 ? (
            <div className="ws-empty">
              <CheckCircle2 size={20} />
              <p>All clear for now.</p>
            </div>
          ) : (
            <ul className="ws-attention">
              {attention.map((item) => (
                <li key={item.id}>
                  <AlertCircle size={16} />
                  <div>
                    <strong>{item.title}</strong>
                    <span>{item.detail}</span>
                  </div>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen(item.tab)}>
                    Open
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        {variant === 'admin' && deptRows.length > 0 ? (
          <section className="ws-panel">
            <h3>Headcount by department</h3>
            <ul className="ws-bars">
              {deptRows.map((d) => (
                <li key={d.id}>
                  <div className="ws-bars__meta">
                    <span>{d.name}</span>
                    <strong>{d.count}</strong>
                  </div>
                  <div className="ws-bars__track">
                    <div className="ws-bars__fill" style={{ width: `${(d.count / deptMax) * 100}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <section className="ws-panel">
            <h3>{variant === 'employee' ? 'Next KPIs' : 'Open KPI work'}</h3>
            {dueSoon.length === 0 ? (
              <div className="ws-empty">
                <Target size={20} />
                <p>No open KPI tasks.</p>
              </div>
            ) : (
              <ul className="ws-kpi-list">
                {dueSoon.map((k) => (
                  <li key={k.id}>
                    <div>
                      <strong>{k.name}</strong>
                      <span>{k.end_date ? `Due ${k.end_date}` : 'No end date'}{isKpiPastDeadline({ end_date: k.end_date, completion_status: k.completion_status === 'completed' ? 'completed' : 'pending' }) ? ' · Overdue' : ''}</span>
                    </div>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => onOpen('kpis')}>
                      View
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>

      {variant === 'admin' && rosterKind && (
        <div className="ws-dept-modal" onClick={() => setRosterKind(null)} role="presentation">
          <div
            className="ws-dept-modal__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ws-roster-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="ws-dept-modal__head">
              <div>
                <p className="ws-home__date">Today</p>
                <h3 id="ws-roster-title">{rosterKind === 'present' ? 'Present' : 'Absent'}</h3>
                <p>
                  {(rosterKind === 'present' ? presentPeople : absentPeople).filter((p) => p.role === 'employee').length} employees · {(rosterKind === 'present' ? presentPeople : absentPeople).filter((p) => p.role === 'manager').length} managers · by department
                </p>
              </div>
              <button type="button" className="ws-dept-modal__close" onClick={() => setRosterKind(null)} aria-label="Close">
                <X size={18} />
              </button>
            </header>
            {rosterGroups.length === 0 ? (
              <div className="ws-empty" style={{ padding: '2rem 1.25rem' }}>
                {rosterKind === 'present' ? <UserCheck size={20} /> : <UserX size={20} />}
                <p>No {rosterKind === 'present' ? 'present' : 'absent'} employees or managers recorded today.</p>
              </div>
            ) : (
              <ul className="ws-dept-list">
                {rosterGroups.map((dept) => (
                  <li key={dept.id} className="ws-dept-list__item is-open">
                    <div className="ws-dept-list__toggle">
                      <span>
                        <strong>{dept.name}</strong>
                        <em>{dept.people.length} {dept.people.length === 1 ? 'person' : 'people'}</em>
                      </span>
                    </div>
                    <div className="ws-dept-list__people">
                      <ul>
                        {dept.people.map((person) => (
                          <li key={person.id}>
                            <strong>{person.full_name}</strong>
                            <span>{roleLabel(person.role)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {variant === 'admin' && showDepartments && (
        <div className="ws-dept-modal" onClick={() => setShowDepartments(false)} role="presentation">
          <div
            className="ws-dept-modal__dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="ws-dept-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="ws-dept-modal__head">
              <div>
                <p className="ws-home__date">Organization</p>
                <h3 id="ws-dept-title">Departments</h3>
                <p>{departments.length} department{departments.length === 1 ? '' : 's'} · click one to see people inside</p>
              </div>
              <button type="button" className="ws-dept-modal__close" onClick={() => setShowDepartments(false)} aria-label="Close">
                <X size={18} />
              </button>
            </header>
            {deptDirectory.length === 0 ? (
              <div className="ws-empty" style={{ padding: '2rem 1.25rem' }}>
                <Building2 size={20} />
                <p>No departments yet. Add them under Settings.</p>
              </div>
            ) : (
              <ul className="ws-dept-list">
                {deptDirectory.map((dept) => {
                  const open = openDeptId === dept.id;
                  return (
                    <li key={dept.id} className={open ? 'ws-dept-list__item is-open' : 'ws-dept-list__item'}>
                      <button
                        type="button"
                        className="ws-dept-list__toggle"
                        onClick={() => setOpenDeptId(open ? null : dept.id)}
                      >
                        <span>
                          <strong>{dept.name}</strong>
                          <em>{dept.people.length} {dept.people.length === 1 ? 'person' : 'people'}</em>
                        </span>
                        <span>{open ? 'Hide' : 'View'}</span>
                      </button>
                      {open && (
                        <div className="ws-dept-list__people">
                          {dept.people.length === 0 ? (
                            <p>No one assigned to this department yet.</p>
                          ) : (
                            <ul>
                              {dept.people.map((person) => (
                                <li key={person.id}>
                                  <strong>{person.full_name}</strong>
                                  <span>{roleLabel(person.role)}</span>
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
