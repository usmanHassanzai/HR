import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi } from '../utils/kpiHelpers';
import { Department, DepartmentKpiIndicator } from '../utils/departmentHelpers';
import '../styles/departments.css';
import { Plus, Loader2, Trash2 } from 'lucide-react';
import { emailKpiAssigned } from '../utils/kpiEmail';
import DepartmentKpiBoardPreview from './DepartmentKpiBoardPreview';
import EmployeeKpiBoardSummary from './EmployeeKpiBoardSummary';
import KpiBoardReferencePanel from './KpiBoardReferencePanel';
import { formatKpiWeight, sumEmployeeKpiWeights } from '../utils/kpiWeightHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';

interface ManagerKpiConfigProps {
  assignerId: string;
  isAdmin?: boolean;
}

export default function ManagerKpiConfig({ assignerId, isAdmin = false }: ManagerKpiConfigProps) {
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

  const [departmentId, setDepartmentId] = useState('');
  const [notes, setNotes] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const [{ data: reps }, { data: depts }] = await Promise.all([
        isAdmin
          ? supabase.rpc('get_all_users_admin')
          : supabase.rpc('get_direct_reports', { p_manager_id: assignerId }),
        supabase.rpc('get_departments'),
      ]);
      const list = ((reps as Profile[]) || []).filter((u) => u.role === 'employee');
      setReports(list);
      const deptList = (depts as Department[]) || [];
      setDepartments(deptList);
      if (deptList[0] && !departmentId) setDepartmentId(deptList[0].id);
      setLoading(false);
    })();
  }, [assignerId, isAdmin, departmentId]);

  useEffect(() => {
    if (!departmentId) {
      setIndicators([]);
      return;
    }
    (async () => {
      setIndicatorsLoading(true);
      const { data, error: indErr } = await supabase.rpc('get_department_kpi_indicators', {
        p_department_id: departmentId,
      });
      if (!indErr) setIndicators((data as DepartmentKpiIndicator[]) || []);
      else setIndicators([]);
      setIndicatorsLoading(false);
    })();
  }, [departmentId]);

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
    [{ table: 'kpis' }, { table: 'users' }, { table: 'departments' }],
    () => {
      void (async () => {
        const [{ data: reps }, { data: depts }] = await Promise.all([
          isAdmin
            ? supabase.rpc('get_all_users_admin')
            : supabase.rpc('get_direct_reports', { p_manager_id: assignerId }),
          supabase.rpc('get_departments'),
        ]);
        setReports(((reps as Profile[]) || []).filter((u) => u.role === 'employee'));
        setDepartments((depts as Department[]) || []);
        if (selectedUserId) fetchKpis(selectedUserId);
      })();
    },
  );

  const selectedDept = departments.find((d) => d.id === departmentId);

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!selectedUserId || !departmentId || !startDate || !endDate) {
      setError('Employee, department, start date and end date are required.');
      return;
    }
    if (endDate < startDate) {
      setError('End date must be on or after start date.');
      return;
    }
    if (indicators.length === 0) {
      setError('This department has no KPI indicators configured.');
      return;
    }

    setFormLoading(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('assign_department_kpi_board', {
        p_employee_id: selectedUserId,
        p_department_id: departmentId,
        p_start_date: startDate,
        p_end_date: endDate,
        p_notes: notes.trim() || null,
      });

      if (rpcErr) throw rpcErr;

      const row = Array.isArray(data) ? data[0] : data;
      if (row?.employee_email) {
        await emailKpiAssigned(
          row.employee_email,
          row.employee_name,
          row.department_name || selectedDept?.name || 'Department',
          endDate,
          `${row.kpi_count} KPI metrics assigned`,
        );
      }

      setNotes('');
      setStartDate('');
      setEndDate('');
      fetchKpis(selectedUserId);
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
  };

  const fmt = (d?: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString() : '—';

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><Loader2 className="spin-icon" /></div>;
  }

  return (
    <div className="responsive-grid-wide" style={{ gap: '2rem' }}>
      <KpiBoardReferencePanel />
      <div className="responsive-grid-wide" style={{ gap: '2rem', gridColumn: '1 / -1' }}>
      <div className="glass-panel">
        <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>
          {isAdmin ? 'All Employee KPIs' : 'Team KPIs'}
        </h3>
        <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} style={{ marginBottom: '1rem' }}>
          <option value="">— Select employee —</option>
          {reports.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </select>

        {!selectedUserId ? (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>Select an employee to view their KPIs.</p>
        ) : kpiLoading ? (
          <Loader2 className="spin-icon" />
        ) : userKpis.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>No KPIs assigned yet.</p>
        ) : (
          <>
            <EmployeeKpiBoardSummary kpis={userKpis} employeeName={reports.find((r) => r.id === selectedUserId)?.full_name} />
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginBottom: '0.75rem' }}>
              Employee KPI total: <strong>{formatKpiWeight(sumEmployeeKpiWeights(userKpis))}</strong> (each employee has their own separate 100% board)
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '480px', overflowY: 'auto' }}>
            {userKpis.map((k) => (
              <div key={k.id} style={{ padding: '1rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <div>
                    <span className="kpi-dept">{k.department || 'General'}</span>
                    <strong style={{ display: 'block', marginTop: '0.25rem' }}>{k.name}</strong>
                    <span className="dept-weight-badge">{formatKpiWeight(k.weight)}</span>
                    <span className={`badge badge-${(k.completion_status === 'completed' ? 'on-track' : k.status.replace('_', '-'))}`} style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
                      {k.completion_status === 'completed' ? 'completed' : k.status.replace('_', ' ')}
                    </span>
                    {k.description && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>{k.description}</p>}
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
                      {fmt(k.start_date)} → {fmt(k.end_date)} · Redos: {k.redo_count ?? 0}/3
                    </p>
                  </div>
                  <button type="button" className="btn btn-secondary" style={{ padding: '0.4rem', height: 'fit-content' }} onClick={() => handleDelete(k.id)} title="Remove">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
            </div>
          </>
        )}
      </div>

      <div className="glass-panel" style={{ height: 'fit-content' }}>
        <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={18} /> Assign Department KPI Board
        </h3>
        {error && <div style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)', padding: '0.75rem', borderRadius: 'var(--border-radius-sm)', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</div>}
        {departments.length === 0 && (
          <p style={{ fontSize: '0.85rem', color: 'var(--color-warning)', marginBottom: '1rem' }}>
            No departments configured. Add departments under the Departments tab first.
          </p>
        )}
        <form onSubmit={handleAssign} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Employee Name</label>
            <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} required>
              <option value="">— Select employee —</option>
              {reports.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Department</label>
            {isAdmin ? (
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} required>
              <option value="">— Select department —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} — {d.org_weight_pct}% org · {(d as Department & { indicator_count?: number }).indicator_count ?? '?'} KPIs · Open
                </option>
              ))}
            </select>
            ) : (
            <>
              <input type="text" className="input-field" value={selectedDept?.name || 'Your department'} readOnly disabled style={{ opacity: 0.85 }} />
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>
                Managers can only assign KPIs from their own department.
              </p>
            </>
            )}
          </div>

          <DepartmentKpiBoardPreview
            departmentName={selectedDept?.name || 'Department'}
            indicators={indicators}
            loading={indicatorsLoading}
          />

          <div className="form-group" style={{ margin: 0 }}>
            <label>Notes (optional)</label>
            <textarea rows={2} placeholder="Additional context for this assignment…" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <div className="form-group" style={{ margin: 0, flex: 1 }}>
              <label>Start Date</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} required />
            </div>
            <div className="form-group" style={{ margin: 0, flex: 1 }}>
              <label>End Date</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} required />
            </div>
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={formLoading || !selectedUserId || !departmentId || indicators.length === 0}
          >
            {formLoading ? <Loader2 size={16} className="spin-icon" /> : `Assign ${indicators.length} KPIs & Notify Employee`}
          </button>
        </form>
      </div>
      </div>
    </div>
  );
}
