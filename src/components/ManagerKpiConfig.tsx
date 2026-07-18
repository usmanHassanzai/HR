import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi } from '../utils/kpiHelpers';
import { Department, DepartmentKpiIndicator, sumIndicatorWeights, indicatorWeightsValid } from '../utils/departmentHelpers';
import '../styles/departments.css';
import '../styles/assign-tasks.css';
import '../styles/manager-kpi-tasks.css';
import { Plus, Loader2, Trash2, ClipboardList, UserPlus, ListChecks, Target, Users, Building2, Calendar, AlertCircle, CheckCircle2, Info, Search, RefreshCw } from 'lucide-react';
import { emailKpiAssigned } from '../utils/kpiEmail';
import EmployeeKpiBoardSummary from './EmployeeKpiBoardSummary';
import DepartmentKpiIndicatorsEditor from './DepartmentKpiIndicatorsEditor';
import KpiIndicatorSelector from './KpiIndicatorSelector';
import { formatKpiWeight, sumEmployeeKpiWeights, selectedIndicatorsWeightSum, employeeKpiWeightsOverCap, KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import EmployeeKpiWeightMeter from './EmployeeKpiWeightMeter';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import { buildDepartmentAssignmentSections, buildAdminDepartmentOverview, filterAssignmentSections } from '../utils/assignTaskHelpers';
import DepartmentAssignmentsOverview from './DepartmentAssignmentsOverview';

function isAssignAlertError(message: string): boolean {
  return /failed|error|must|required|cannot|not found|select at least|no departments|no kpi/i.test(message);
}

interface ManagerKpiConfigProps {
  assignerId: string;
  isAdmin?: boolean;
  /** Manager's department — assigned by admin only */
  managerDepartmentId?: string | null;
}

export default function ManagerKpiConfig({ assignerId, isAdmin = false, managerDepartmentId }: ManagerKpiConfigProps) {
  const [reports, setReports] = useState<Profile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [indicators, setIndicators] = useState<DepartmentKpiIndicator[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userKpis, setUserKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [indicatorsLoading, setIndicatorsLoading] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState('');
  const [managerTab, setManagerTab] = useState<'create' | 'assign' | 'assignments'>('create');
  const [adminTab, setAdminTab] = useState<'assign' | 'overview'>('overview');
  const [overviewDeptFilter, setOverviewDeptFilter] = useState('all');
  const [overviewSearch, setOverviewSearch] = useState('');
  const [overviewRefreshing, setOverviewRefreshing] = useState(false);

  const [departmentId, setDepartmentId] = useState('');
  const [assignNotes, setAssignNotes] = useState('');
  const [assignStartDate, setAssignStartDate] = useState('');
  const [assignEndDate, setAssignEndDate] = useState('');
  const [assignSuccess, setAssignSuccess] = useState('');
  const [selectedIndicatorIds, setSelectedIndicatorIds] = useState<string[]>([]);
  const [teamKpisByUser, setTeamKpisByUser] = useState<Record<string, Kpi[]>>({});

  const fetchIndicators = async (deptId: string) => {
    if (!deptId) { setIndicators([]); return; }
    setIndicatorsLoading(true);
    const { data, error: indErr } = await supabase.rpc('get_department_kpi_indicators', { p_department_id: deptId });
    if (!indErr) setIndicators((data as DepartmentKpiIndicator[]) || []);
    else setIndicators([]);
    setIndicatorsLoading(false);
  };

  const fetchTeamKpis = async (team: Profile[]) => {
    if (!team.length) { setTeamKpisByUser({}); return; }
    const ids = team.map((r) => r.id);
    const { data } = await supabase.from('kpis').select('*').in('user_id', ids).order('created_at', { ascending: false });
    const grouped: Record<string, Kpi[]> = {};
    for (const id of ids) grouped[id] = [];
    for (const k of (data as Kpi[]) || []) {
      if (grouped[k.user_id]) grouped[k.user_id].push(k);
    }
    setTeamKpisByUser(grouped);
  };
  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: reps }, deptResult] = await Promise.all([
        isAdmin
          ? supabase.rpc('get_all_users_admin')
          : supabase.rpc('get_direct_reports', { p_manager_id: assignerId }),
        isAdmin
          ? supabase.rpc('get_departments')
          : managerDepartmentId
            ? supabase.rpc('get_department_kpi_indicators', { p_department_id: managerDepartmentId })
            : Promise.resolve({ data: null, error: null }),
      ]);
      const list = ((reps as Profile[]) || []).filter((u) => u.role === 'employee');
      setReports(list);
      if (isAdmin) {
        const deptList = (deptResult.data as Department[]) || [];
        setDepartments(deptList);
        if (deptList[0] && !departmentId) setDepartmentId(deptList[0].id);
      } else if (managerDepartmentId) {
        setDepartmentId(managerDepartmentId);
        const { data: mgrDepts } = await supabase.rpc('get_departments');
        const dept = ((mgrDepts as Department[]) || []).find((d) => d.id === managerDepartmentId);
        if (dept) {
          setDepartments([dept]);
        } else {
          const inds = (deptResult.data as DepartmentKpiIndicator[]) || [];
          setDepartments([{
            id: managerDepartmentId,
            name: inds[0]?.department_name || 'Your Department',
            slug: '',
            org_weight_pct: 0,
            active: true,
          }]);
        }
      } else {
        setDepartments([]);
        setDepartmentId('');
      }
      setLoading(false);
      if (list.length) void fetchTeamKpis(list);
    })();
  }, [assignerId, isAdmin, managerDepartmentId]);

  useEffect(() => {
    void fetchIndicators(departmentId);
  }, [departmentId]);

  useEffect(() => {
    if (indicators.length > 0) {
      setSelectedIndicatorIds((prev) => {
        const valid = prev.filter((id) => indicators.some((i) => i.id === id));
        return valid.length > 0 ? valid : indicators.map((i) => i.id);
      });
    } else {
      setSelectedIndicatorIds([]);
    }
  }, [indicators]);

  useEffect(() => {
    if (!isAdmin && (managerTab === 'assign' || managerTab === 'assignments') && departmentId) {
      void fetchIndicators(departmentId);
    }
    if (!isAdmin && managerTab === 'assignments' && reports.length) {
      void fetchTeamKpis(reports);
    }
  }, [isAdmin, managerTab, departmentId, reports]);

  const fetchKpis = async (userId: string) => {
    if (!userId) { setUserKpis([]); return; }
    setKpiLoading(true);
    const { data } = await supabase.from('kpis').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    setUserKpis(data || []);
    setKpiLoading(false);
  };

  useEffect(() => { fetchKpis(selectedUserId); }, [selectedUserId]);

  useSupabaseRealtime(
    `kpi-assign-${assignerId}`,
    [{ table: 'kpis' }, { table: 'users' }, { table: 'departments' }, { table: 'department_kpi_indicators' }],
    () => {
      void (async () => {
        const [{ data: reps }, deptResult] = await Promise.all([
          isAdmin
            ? supabase.rpc('get_all_users_admin')
            : supabase.rpc('get_direct_reports', { p_manager_id: assignerId }),
          isAdmin
            ? supabase.rpc('get_departments')
            : managerDepartmentId
              ? supabase.rpc('get_department_kpi_indicators', { p_department_id: managerDepartmentId })
              : Promise.resolve({ data: null, error: null }),
        ]);
        setReports(((reps as Profile[]) || []).filter((u) => u.role === 'employee'));
        const teamList = ((reps as Profile[]) || []).filter((u) => u.role === 'employee');
        if (teamList.length) void fetchTeamKpis(teamList);
        if (isAdmin) {
          setDepartments((deptResult.data as Department[]) || []);
        } else if (managerDepartmentId) {
          const inds = (deptResult.data as DepartmentKpiIndicator[]) || [];
          if (inds[0]?.department_name) {
            setDepartments([{
              id: managerDepartmentId,
              name: inds[0].department_name,
              slug: '',
              org_weight_pct: 0,
              active: true,
            }]);
          }
        }
        if (selectedUserId) fetchKpis(selectedUserId);
        if (departmentId) void fetchIndicators(departmentId);
      })();
    },
  );

  const selectedDept = departments.find((d) => d.id === departmentId);

  const toggleIndicator = (id: string) => {
    setSelectedIndicatorIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectAllIndicators = () => setSelectedIndicatorIds(indicators.map((i) => i.id));
  const clearAllIndicators = () => setSelectedIndicatorIds([]);

  const selectedIndicators = indicators.filter((i) => selectedIndicatorIds.includes(i.id));

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setAssignSuccess('');
    if (!selectedUserId || !departmentId || !assignStartDate || !assignEndDate) {
      setError('Team member, start date and end date are required.');
      return;
    }
    if (assignEndDate < assignStartDate) {
      setError('End date must be on or after start date.');
      return;
    }
    if (indicators.length === 0) {
      setError('Create KPIs first under the Create KPIs tab.');
      return;
    }
    if (selectedIndicatorIds.length === 0) {
      setError('Select at least one KPI to assign.');
      return;
    }
    if (employeeKpiWeightsOverCap(userKpis)) {
      setError(`This employee's KPI weights exceed ${KPI_WEIGHT_CAP}%. Remove or complete tasks before assigning more.`);
      return;
    }
    if (!indicatorWeightsValid(selectedIndicators)) {
      setError(`Selected KPI template weights must sum to ${KPI_WEIGHT_CAP}% (currently ${sumIndicatorWeights(selectedIndicators).toFixed(1)}%). Fix under Create KPIs.`);
      return;
    }

    setFormLoading(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('assign_department_kpi_board', {
        p_employee_id: selectedUserId,
        p_department_id: departmentId,
        p_start_date: assignStartDate,
        p_end_date: assignEndDate,
        p_notes: assignNotes.trim() || null,
        p_indicator_ids: selectedIndicatorIds,
      });

      if (rpcErr) throw rpcErr;

      const row = Array.isArray(data) ? data[0] : data;
      if (row?.employee_email) {
        await emailKpiAssigned(
          row.employee_email,
          row.employee_name,
          row.department_name || selectedDept?.name || 'Department',
          assignEndDate,
          `${row.kpi_count} KPI tasks assigned`,
        );
      }

      const empName = reports.find((r) => r.id === selectedUserId)?.full_name || 'Employee';
      const kpiNames = selectedIndicators.map((i) => i.name).join(', ');
      setAssignSuccess(`Assigned ${row?.kpi_count ?? selectedIndicatorIds.length} KPI task(s) to ${empName} (${KPI_WEIGHT_CAP}% board): ${kpiNames}`);

      setAssignNotes('');
      setAssignStartDate('');
      setAssignEndDate('');
      fetchKpis(selectedUserId);
      void fetchTeamKpis(reports);
      setManagerTab('assignments');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to assign KPI tasks.');
    } finally {
      setFormLoading(false);
    }
  };

  const handleAssignAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setAssignSuccess('');
    if (!selectedUserId || !departmentId || !assignStartDate || !assignEndDate) {
      setError('Employee, department, start date and end date are required.');
      return;
    }
    if (assignEndDate < assignStartDate) {
      setError('End date must be on or after start date.');
      return;
    }
    if (indicators.length === 0) {
      setError('This department has no KPI indicators configured.');
      return;
    }
    if (selectedIndicatorIds.length === 0) {
      setError('Select at least one KPI to assign.');
      return;
    }
    if (employeeKpiWeightsOverCap(userKpis)) {
      setError(`This employee's KPI weights exceed ${KPI_WEIGHT_CAP}%. Remove or complete tasks before assigning more.`);
      return;
    }
    if (!indicatorWeightsValid(selectedIndicators)) {
      setError(`Selected KPI template weights must sum to ${KPI_WEIGHT_CAP}%. Fix department KPI template first.`);
      return;
    }

    setFormLoading(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('assign_department_kpi_board', {
        p_employee_id: selectedUserId,
        p_department_id: departmentId,
        p_start_date: assignStartDate,
        p_end_date: assignEndDate,
        p_notes: assignNotes.trim() || null,
        p_indicator_ids: selectedIndicatorIds,
      });

      if (rpcErr) throw rpcErr;

      const row = Array.isArray(data) ? data[0] : data;
      if (row?.employee_email) {
        await emailKpiAssigned(
          row.employee_email,
          row.employee_name,
          row.department_name || selectedDept?.name || 'Department',
          assignEndDate,
          `${row.kpi_count} KPI metrics assigned`,
        );
      }

      const empName = reports.find((r) => r.id === selectedUserId)?.full_name || 'Employee';
      const kpiNames = selectedIndicators.map((i) => i.name).join(', ');
      setAssignSuccess(`Assigned ${row?.kpi_count ?? selectedIndicatorIds.length} KPI task(s) to ${empName} (${KPI_WEIGHT_CAP}% board): ${kpiNames}`);

      setAssignNotes('');
      setAssignStartDate('');
      setAssignEndDate('');
      fetchKpis(selectedUserId);
      void fetchTeamKpis(reports);
      setAdminTab('overview');
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to assign KPI board.');
    } finally {
      setFormLoading(false);
    }
  };

  const handleDelete = async (kpiId: string) => {
    if (!confirm('Remove this KPI assignment?')) return;
    await supabase.from('kpis').delete().eq('id', kpiId);
    if (selectedUserId) {
      await supabase.rpc('rebalance_employee_kpi_weights', { p_user_id: selectedUserId });
    }
    fetchKpis(selectedUserId);
    void fetchTeamKpis(reports);
  };

  const fmt = (d?: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString() : '—';

  const assignmentRows = reports.flatMap((r) =>
    (teamKpisByUser[r.id] || []).map((k) => ({ employee: r, kpi: k })),
  );

  const adminAssignmentSections = buildAdminDepartmentOverview(reports, teamKpisByUser, departments);
  const managerAssignmentSections = buildDepartmentAssignmentSections(assignmentRows, departments);

  const filteredAdminSections = filterAssignmentSections(adminAssignmentSections, {
    departmentId: overviewDeptFilter,
    search: overviewSearch,
  });

  const refreshOverview = async () => {
    setOverviewRefreshing(true);
    await fetchTeamKpis(reports);
    setOverviewRefreshing(false);
  };

  const totalAssignments = Object.values(teamKpisByUser).reduce((n, arr) => n + arr.length, 0);
  const pendingAssignments = assignmentRows.filter(({ kpi }) => kpi.completion_status !== 'completed').length;
  const selectedEmployee = reports.find((r) => r.id === selectedUserId);
  const alertMessage = error || assignSuccess;

  if (loading) {
    return (
      <div className="assign-task-page-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading task assignment…</span>
      </div>
    );
  }

  if (!isAdmin) {
    const deptIndicatorTotal = sumIndicatorWeights(indicators);
    const selectedWeightTotal = selectedIndicatorsWeightSum(indicators, selectedIndicatorIds);
    const managerPending = assignmentRows.filter(({ kpi }) => kpi.completion_status !== 'completed').length;

    return (
      <div className="mgr-kpi-page">
        <header className="mgr-kpi-header glass-panel">
          <div className="mgr-kpi-header__main">
            <div className="mgr-kpi-header__icon">
              <Target size={22} />
            </div>
            <div>
              <h2 className="mgr-kpi-header__title">KPI Tasks — {selectedDept?.name || 'Your Department'}</h2>
              <p className="mgr-kpi-header__subtitle">
                Create department KPIs, assign tasks to your team, and track assignments. Each employee's active KPI board is capped at <strong>{KPI_WEIGHT_CAP}%</strong> total weight.
              </p>
            </div>
          </div>
          <div className="mgr-kpi-stats">
            <div className="mgr-kpi-stat mgr-kpi-stat--accent">
              <span className="mgr-kpi-stat__label">Team members</span>
              <strong>{reports.length}</strong>
            </div>
            <div className="mgr-kpi-stat">
              <span className="mgr-kpi-stat__label">Active tasks</span>
              <strong>{managerPending}</strong>
            </div>
            <div className="mgr-kpi-stat">
              <span className="mgr-kpi-stat__label">Dept KPIs</span>
              <strong>{indicators.length}</strong>
            </div>
            <div className="mgr-kpi-stat">
              <span className="mgr-kpi-stat__label">Template total</span>
              <strong>{deptIndicatorTotal.toFixed(0)}%</strong>
            </div>
          </div>
        </header>

        <div className="mgr-kpi-tabs tab-bar tab-bar--inline-mobile">
          <button
            type="button"
            className={`tab-btn ${managerTab === 'create' ? 'tab-btn--active' : ''}`}
            onClick={() => { setManagerTab('create'); setError(''); setAssignSuccess(''); }}
          >
            <ClipboardList size={16} /> Create KPIs
          </button>
          <button
            type="button"
            className={`tab-btn ${managerTab === 'assign' ? 'tab-btn--active' : ''}`}
            onClick={() => { setManagerTab('assign'); setError(''); setAssignSuccess(''); }}
          >
            <UserPlus size={16} /> Assign Tasks
          </button>
          <button
            type="button"
            className={`tab-btn ${managerTab === 'assignments' ? 'tab-btn--active' : ''}`}
            onClick={() => { setManagerTab('assignments'); setError(''); void fetchTeamKpis(reports); }}
          >
            <ListChecks size={16} /> Assignments ({totalAssignments})
          </button>
        </div>

        {(error || assignSuccess) && (
          <div
            className={`assign-task-alert ${error ? 'assign-task-alert--error' : 'assign-task-alert--success'}`}
            role="alert"
          >
            {error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
            <span>{error || assignSuccess}</span>
            <button
              type="button"
              className="assign-task-alert__dismiss"
              onClick={() => { setError(''); setAssignSuccess(''); }}
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}

        {managerTab === 'create' ? (
          <section className="mgr-kpi-card">
            <h3><ClipboardList size={18} /> Department KPI template</h3>
            <p>
              Define KPI metrics for your department. Weights must sum to <strong>{KPI_WEIGHT_CAP}%</strong>.
              When ready, go to <strong>Assign Tasks</strong> to give them to your team.
            </p>
            {!managerDepartmentId ? (
              <div className="assign-task-info">
                <AlertCircle size={16} />
                <span>No department assigned yet. Ask your company admin to assign you to a department in Users.</span>
              </div>
            ) : (
              <DepartmentKpiIndicatorsEditor
                departmentId={departmentId}
                departmentName={selectedDept?.name || 'Department'}
              />
            )}
          </section>
        ) : managerTab === 'assignments' ? (
          <section className="mgr-kpi-card">
            <h3><ListChecks size={18} /> Team assignments</h3>
            <p>Tasks grouped by department and team member. Each employee's pending weights total {KPI_WEIGHT_CAP}%.</p>
            {reports.length === 0 ? (
              <div className="mgr-kpi-empty">
                <Users size={40} strokeWidth={1.25} />
                <h4>No team members</h4>
                <p>No employees on your team yet.</p>
              </div>
            ) : assignmentRows.length === 0 ? (
              <div className="mgr-kpi-empty">
                <Target size={40} strokeWidth={1.25} />
                <h4>No assignments yet</h4>
                <p>Use <strong>Assign Tasks</strong> to assign KPIs to your team.</p>
              </div>
            ) : (
              <DepartmentAssignmentsOverview
                sections={managerAssignmentSections}
                onDelete={(id) => void handleDelete(id)}
                fmt={fmt}
              />
            )}
          </section>
        ) : (
          <div className="mgr-kpi-grid">
            <section className="mgr-kpi-card">
              <h3><Users size={18} /> Employee preview</h3>
              <p>Review current tasks and weight budget before assigning new KPIs.</p>

              <div className="form-group">
                <label htmlFor="mgr-preview-employee">Team member</label>
                <select
                  id="mgr-preview-employee"
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                >
                  <option value="">— Select team member —</option>
                  {reports.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
                </select>
              </div>

              {reports.length === 0 ? (
                <div className="mgr-kpi-empty">
                  <Users size={36} strokeWidth={1.25} />
                  <p>No employees on your team yet.</p>
                </div>
              ) : !selectedUserId ? (
                <div className="mgr-kpi-empty">
                  <Target size={36} strokeWidth={1.25} />
                  <p>Select a team member to preview their KPI board.</p>
                </div>
              ) : kpiLoading ? (
                <div className="dash-loading"><Loader2 className="spin-icon" /></div>
              ) : (
                <>
                  <EmployeeKpiWeightMeter kpis={userKpis} label="Current weight budget" />
                  {userKpis.length > 0 && (
                    <EmployeeKpiBoardSummary kpis={userKpis} employeeName={selectedEmployee?.full_name} />
                  )}
                  {userKpis.length === 0 ? (
                    <div className="mgr-kpi-empty" style={{ padding: '1.5rem 0' }}>
                      <p>No KPI tasks assigned yet.</p>
                    </div>
                  ) : (
                    <div className="mgr-kpi-kpi-list">
                      {userKpis.map((k) => (
                        <article key={k.id} className="mgr-kpi-kpi-item">
                          <div className="mgr-kpi-kpi-item__head">
                            <div>
                              <strong>{k.name}</strong>
                              <span className={`badge badge-${k.completion_status === 'completed' ? 'on-track' : k.status.replace('_', '-')}`} style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
                                {k.completion_status === 'completed' ? 'completed' : k.status.replace('_', ' ')}
                              </span>
                              <span className="dept-weight-badge" style={{ marginLeft: '0.35rem' }}>{formatKpiWeight(k.weight)}</span>
                            </div>
                            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleDelete(k.id)} title="Remove">
                              <Trash2 size={14} />
                            </button>
                          </div>
                          {k.description && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>{k.description}</p>}
                          <div className="mgr-kpi-kpi-item__meta">{fmt(k.start_date)} → {fmt(k.end_date)}</div>
                        </article>
                      ))}
                    </div>
                  )}
                </>
              )}
            </section>

            <section className="mgr-kpi-card">
              <h3><Plus size={18} /> Assign KPI tasks</h3>
              <p>Pick KPIs and dates. Re-assigning replaces pending tasks for this department, then rebalances to {KPI_WEIGHT_CAP}%.</p>

              {!managerDepartmentId && (
                <div className="assign-task-info">
                  <AlertCircle size={16} />
                  <span>No department assigned yet. Ask your admin to assign your department.</span>
                </div>
              )}
              {managerDepartmentId && indicators.length === 0 && !indicatorsLoading && (
                <div className="assign-task-info">
                  <AlertCircle size={16} />
                  <span>No KPIs created yet. Go to <strong>Create KPIs</strong> first.</span>
                </div>
              )}
              {selectedUserId && userKpis.length > 0 && (
                <EmployeeKpiWeightMeter kpis={userKpis} compact label="Before assign" />
              )}

              <form onSubmit={handleAssign} className="mgr-kpi-form">
                <div className="form-group">
                  <label htmlFor="mgr-assign-employee">Team member</label>
                  <select
                    id="mgr-assign-employee"
                    value={selectedUserId}
                    onChange={(e) => setSelectedUserId(e.target.value)}
                    required
                  >
                    <option value="">— Select team member —</option>
                    {reports.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
                  </select>
                </div>

                <KpiIndicatorSelector
                  indicators={indicators}
                  selectedIds={selectedIndicatorIds}
                  onToggle={toggleIndicator}
                  onSelectAll={selectAllIndicators}
                  onClearAll={clearAllIndicators}
                  loading={indicatorsLoading}
                />

                {selectedIndicatorIds.length > 0 && (
                  <div className="mgr-kpi-assign-note">
                    <Info size={16} />
                    <span>
                      Selected template weight: <strong>{selectedWeightTotal.toFixed(1)}%</strong>.
                      {' '}After assign, all pending KPIs for this employee are rebalanced to exactly <strong>{KPI_WEIGHT_CAP}%</strong>.
                    </span>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="mgr-assign-notes">Notes (optional)</label>
                  <textarea
                    id="mgr-assign-notes"
                    rows={2}
                    placeholder="Instructions for this assignment…"
                    value={assignNotes}
                    onChange={(e) => setAssignNotes(e.target.value)}
                  />
                </div>

                <div className="mgr-kpi-form__dates">
                  <div className="form-group">
                    <label htmlFor="mgr-assign-start"><Calendar size={14} /> Start date</label>
                    <input
                      id="mgr-assign-start"
                      type="date"
                      value={assignStartDate}
                      onChange={(e) => setAssignStartDate(e.target.value)}
                      required
                    />
                  </div>
                  <div className="form-group">
                    <label htmlFor="mgr-assign-end">End date</label>
                    <input
                      id="mgr-assign-end"
                      type="date"
                      value={assignEndDate}
                      onChange={(e) => setAssignEndDate(e.target.value)}
                      required
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={
                    formLoading ||
                    !selectedUserId ||
                    !departmentId ||
                    indicators.length === 0 ||
                    selectedIndicatorIds.length === 0 ||
                    !indicatorWeightsValid(indicators) ||
                    (selectedUserId ? employeeKpiWeightsOverCap(userKpis) : false)
                  }
                >
                  {formLoading ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : (
                    <>
                      <Target size={16} />
                      Assign {selectedIndicatorIds.length} task{selectedIndicatorIds.length !== 1 ? 's' : ''} ({KPI_WEIGHT_CAP}% cap)
                    </>
                  )}
                </button>
              </form>
            </section>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="assign-task-page">
      <header className="assign-task-header glass-panel">
        <div className="assign-task-header__main">
          <div className="assign-task-header__icon">
            <Target size={22} />
          </div>
          <div>
            <h2 className="assign-task-header__title">Assign Tasks</h2>
            <p className="assign-task-header__subtitle">
              Assign department KPI tasks to employees with deadlines. Assignments save to Supabase and sync instantly
              on every device. Configure department KPI boards under the <strong>Departments</strong> tab.
            </p>
          </div>
        </div>

        <div className="assign-task-stats">
          <div className="assign-task-stat">
            <Users size={16} />
            <span className="assign-task-stat__label">Employees</span>
            <strong>{reports.length}</strong>
          </div>
          <div className="assign-task-stat">
            <Building2 size={16} />
            <span className="assign-task-stat__label">Departments</span>
            <strong>{departments.length}</strong>
          </div>
          <div className="assign-task-stat">
            <ListChecks size={16} />
            <span className="assign-task-stat__label">Active tasks</span>
            <strong>{pendingAssignments}</strong>
          </div>
          <div className="assign-task-stat">
            <ClipboardList size={16} />
            <span className="assign-task-stat__label">Total assigned</span>
            <strong>{totalAssignments}</strong>
          </div>
        </div>
      </header>

      <div className="assign-task-tabs tab-bar tab-bar--inline-mobile">
        <button
          type="button"
          className={`tab-btn ${adminTab === 'overview' ? 'tab-btn--active' : ''}`}
          onClick={() => { setAdminTab('overview'); setError(''); void fetchTeamKpis(reports); }}
        >
          <ListChecks size={16} /> By department ({totalAssignments})
        </button>
        <button
          type="button"
          className={`tab-btn ${adminTab === 'assign' ? 'tab-btn--active' : ''}`}
          onClick={() => { setAdminTab('assign'); setError(''); setAssignSuccess(''); }}
        >
          <UserPlus size={16} /> New assignment
        </button>
      </div>

      {alertMessage && (
        <div
          className={`assign-task-alert ${isAssignAlertError(alertMessage) ? 'assign-task-alert--error' : 'assign-task-alert--success'}`}
          role="alert"
        >
          {isAssignAlertError(alertMessage) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{alertMessage}</span>
          <button
            type="button"
            className="assign-task-alert__dismiss"
            onClick={() => { setError(''); setAssignSuccess(''); }}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      )}

      {adminTab === 'overview' ? (
        <section className="assign-task-card glass-panel assign-task-overview">
          <div className="assign-task-overview__head">
            <div>
              <h3><ListChecks size={18} /> All assignments by department</h3>
              <p>
                Every department with employees and their KPI tasks. Expand a department to review,
                remove assignments, or switch to <strong>New assignment</strong> to add more.
              </p>
            </div>
          </div>

          <div className="assign-task-overview-toolbar">
            <div className="assign-task-overview-toolbar__search form-group">
              <Search size={16} className="assign-task-overview-toolbar__search-icon" />
              <input
                type="search"
                className="form-input"
                placeholder="Search department, employee, or task…"
                value={overviewSearch}
                onChange={(e) => setOverviewSearch(e.target.value)}
              />
            </div>
            <div className="form-group" style={{ margin: 0, minWidth: 160, flex: '0 1 180px' }}>
              <label className="form-label" style={{ fontSize: '0.72rem' }}>Department</label>
              <select
                className="form-input"
                value={overviewDeptFilter}
                onChange={(e) => setOverviewDeptFilter(e.target.value)}
              >
                <option value="all">All departments</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
                {adminAssignmentSections.some((s) => s.deptId === '__unassigned__') && (
                  <option value="__unassigned__">Unassigned</option>
                )}
              </select>
            </div>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => void refreshOverview()}
              disabled={overviewRefreshing}
            >
              <RefreshCw size={14} className={overviewRefreshing ? 'spin-icon' : ''} />
              Refresh
            </button>
          </div>

          {departments.length === 0 ? (
            <div className="assign-task-empty">
              <Building2 size={40} strokeWidth={1.25} />
              <h4>No departments yet</h4>
              <p>Add departments under the <strong>Departments</strong> tab before assigning tasks.</p>
            </div>
          ) : reports.length === 0 ? (
            <div className="assign-task-empty">
              <Users size={40} strokeWidth={1.25} />
              <h4>No employees yet</h4>
              <p>Create employee accounts under the <strong>Users</strong> tab, then return here to assign KPI tasks.</p>
            </div>
          ) : filteredAdminSections.length === 0 ? (
            <div className="assign-task-empty">
              <Target size={40} strokeWidth={1.25} />
              <h4>No matches</h4>
              <p>Try a different search or department filter.</p>
            </div>
          ) : (
            <DepartmentAssignmentsOverview
              sections={filteredAdminSections}
              onDelete={(id) => void handleDelete(id)}
              fmt={fmt}
              showEmptyEmployees
              defaultExpanded
            />
          )}
        </section>
      ) : (
        <>
          {departments.length === 0 && (
            <div className="assign-task-info">
              <Info size={16} />
              <span>No departments yet. Add departments under the <strong>Departments</strong> tab before assigning tasks.</span>
            </div>
          )}

          <div className="assign-task-grid">
            <section className="assign-task-card glass-panel">
              <h3><Users size={18} /> Employee preview</h3>
              <p>Select an employee to review their current KPI board before assigning new tasks.</p>

              <div className="form-group" style={{ margin: 0 }}>
                <label htmlFor="admin-preview-employee">Employee</label>
                <select
                  id="admin-preview-employee"
                  value={selectedUserId}
                  onChange={(e) => setSelectedUserId(e.target.value)}
                >
                  <option value="">— Select employee —</option>
                  {reports.map((r) => (
                    <option key={r.id} value={r.id}>{r.full_name}</option>
                  ))}
                </select>
              </div>

              {reports.length === 0 ? (
                <div className="assign-task-empty" style={{ marginTop: '1rem' }}>
                  <Users size={36} strokeWidth={1.25} />
                  <h4>No employees</h4>
                  <p>Add employees under <strong>Users</strong> first.</p>
                </div>
              ) : !selectedUserId ? (
                <div className="assign-task-empty" style={{ marginTop: '1rem' }}>
                  <Target size={36} strokeWidth={1.25} />
                  <p>Select an employee to preview their assigned tasks.</p>
                </div>
              ) : kpiLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: '2rem' }}>
                  <Loader2 className="spin-icon" />
                </div>
              ) : userKpis.length === 0 ? (
                <div className="assign-task-empty" style={{ marginTop: '1rem' }}>
                  <ClipboardList size={36} strokeWidth={1.25} />
                  <h4>No tasks yet</h4>
                  <p>{selectedEmployee?.full_name} has no KPI tasks. Use the form to assign their first board.</p>
                </div>
              ) : (
                <>
                  <EmployeeKpiBoardSummary kpis={userKpis} employeeName={selectedEmployee?.full_name} />
                  <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '0.75rem 0' }}>
                    Board total: <strong>{formatKpiWeight(sumEmployeeKpiWeights(userKpis))}</strong> (each employee has a separate 100% board)
                  </p>
                  <div className="assign-task-kpi-list">
                    {userKpis.map((k) => (
                      <article key={k.id} className="assign-task-kpi-item">
                        <div className="assign-task-kpi-item__head">
                          <div>
                            <span className="kpi-dept">{k.department || 'General'}</span>
                            <strong style={{ display: 'block', marginTop: '0.2rem' }}>{k.name}</strong>
                            <span className="dept-weight-badge">{formatKpiWeight(k.weight)}</span>
                            <span className={`badge badge-${k.completion_status === 'completed' ? 'on-track' : k.status.replace('_', '-')}`} style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
                              {k.completion_status === 'completed' ? 'completed' : k.status.replace('_', ' ')}
                            </span>
                          </div>
                          <button type="button" className="btn btn-secondary btn-sm" onClick={() => void handleDelete(k.id)} title="Remove">
                            <Trash2 size={14} />
                          </button>
                        </div>
                        {k.description && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', margin: '0.35rem 0 0' }}>{k.description}</p>}
                        <div className="assign-task-kpi-item__meta">
                          {fmt(k.start_date)} → {fmt(k.end_date)} · Redos: {k.redo_count ?? 0}/3
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>

            <section className="assign-task-card glass-panel">
              <h3><Plus size={18} /> New assignment</h3>
              <p>Pick an employee, department, and KPI tasks. The employee is notified by email when assigned.</p>

              <form onSubmit={handleAssignAdmin} className="assign-task-form">
                <div className="assign-task-form__section">
                  <p className="assign-task-form__section-title">1 · Who &amp; where</p>
                  <div className="form-group" style={{ margin: 0 }}>
                    <label htmlFor="admin-assign-employee">Employee</label>
                    <select
                      id="admin-assign-employee"
                      value={selectedUserId}
                      onChange={(e) => setSelectedUserId(e.target.value)}
                      required
                    >
                      <option value="">— Select employee —</option>
                      {reports.map((r) => (
                        <option key={r.id} value={r.id}>{r.full_name}</option>
                      ))}
                    </select>
                  </div>
                  <div className="form-group" style={{ margin: '0.75rem 0 0' }}>
                    <label htmlFor="admin-assign-dept">Department</label>
                    <select
                      id="admin-assign-dept"
                      value={departmentId}
                      onChange={(e) => setDepartmentId(e.target.value)}
                      required
                      disabled={departments.length === 0}
                    >
                      <option value="">— Select department —</option>
                      {departments.map((d) => (
                        <option key={d.id} value={d.id}>
                          {d.name} · {d.org_weight_pct}% org · {d.indicator_count ?? 0} KPI{d.indicator_count !== 1 ? 's' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                  {selectedDept && (
                    <div className="assign-task-dept-preview">
                      <strong>{selectedDept.name}</strong> — org weight {selectedDept.org_weight_pct}%.
                      {indicatorsLoading ? ' Loading KPIs…' : ` ${indicators.length} KPI metric${indicators.length !== 1 ? 's' : ''} available.`}
                    </div>
                  )}
                </div>

                <div className="assign-task-form__section">
                  <p className="assign-task-form__section-title">2 · KPI tasks</p>
                  <KpiIndicatorSelector
                    indicators={indicators}
                    selectedIds={selectedIndicatorIds}
                    onToggle={toggleIndicator}
                    onSelectAll={selectAllIndicators}
                    onClearAll={clearAllIndicators}
                    loading={indicatorsLoading}
                    emptyHint="This department has no KPI metrics. Add them under the Departments tab first."
                  />
                </div>

                <div className="assign-task-form__section">
                  <p className="assign-task-form__section-title">3 · Schedule &amp; notes</p>
                  <div className="assign-task-form__dates">
                    <div className="form-group" style={{ margin: 0 }}>
                      <label htmlFor="admin-assign-start"><Calendar size={14} style={{ verticalAlign: '-2px', marginRight: '0.25rem' }} />Start date</label>
                      <input
                        id="admin-assign-start"
                        type="date"
                        value={assignStartDate}
                        onChange={(e) => setAssignStartDate(e.target.value)}
                        required
                      />
                    </div>
                    <div className="form-group" style={{ margin: 0 }}>
                      <label htmlFor="admin-assign-end">End date</label>
                      <input
                        id="admin-assign-end"
                        type="date"
                        value={assignEndDate}
                        onChange={(e) => setAssignEndDate(e.target.value)}
                        required
                      />
                    </div>
                  </div>
                  <div className="form-group" style={{ margin: '0.75rem 0 0' }}>
                    <label htmlFor="admin-assign-notes">Notes (optional)</label>
                    <textarea
                      id="admin-assign-notes"
                      rows={3}
                      placeholder="Instructions or context for this assignment…"
                      value={assignNotes}
                      onChange={(e) => setAssignNotes(e.target.value)}
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={formLoading || !selectedUserId || !departmentId || indicators.length === 0 || selectedIndicatorIds.length === 0}
                >
                  {formLoading ? (
                    <Loader2 size={16} className="spin-icon" />
                  ) : (
                    <>
                      <Target size={16} />
                      Assign {selectedIndicatorIds.length} task{selectedIndicatorIds.length !== 1 ? 's' : ''} &amp; notify employee
                    </>
                  )}
                </button>
              </form>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
