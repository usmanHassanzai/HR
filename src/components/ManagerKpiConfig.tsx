import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';
import '../styles/departments.css';
import { Plus, Loader2, Trash2, Sparkles } from 'lucide-react';
import { emailKpiAssigned } from '../utils/kpiEmail';

interface ManagerKpiConfigProps {
  assignerId: string;
  isAdmin?: boolean;
}

function suggestKpiWeight(
  deptPct: number,
  startDate: string,
  endDate: string,
  sameDeptKpis: Kpi[],
): number {
  const days = Math.max(1, Math.ceil((new Date(endDate).getTime() - new Date(startDate).getTime()) / 86400000) + 1);
  let totalDays = days;
  for (const k of sameDeptKpis) {
    if (k.start_date && k.end_date) {
      totalDays += Math.max(1, Math.ceil((new Date(k.end_date).getTime() - new Date(k.start_date).getTime()) / 86400000) + 1);
    }
  }
  const w = (deptPct / 100) * 10 * (days / totalDays);
  return Math.max(0.25, Math.min(10, Math.round(w * 100) / 100));
}

export default function ManagerKpiConfig({ assignerId, isAdmin = false }: ManagerKpiConfigProps) {
  const [reports, setReports] = useState<Profile[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userKpis, setUserKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState('');
  const [weightTouched, setWeightTouched] = useState(false);

  const [departmentId, setDepartmentId] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [weight, setWeight] = useState('1');

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

  const fetchKpis = async (userId: string) => {
    if (!userId) { setUserKpis([]); return; }
    setKpiLoading(true);
    const { data } = await supabase.from('kpis').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    setUserKpis(data || []);
    setKpiLoading(false);
  };

  useEffect(() => { fetchKpis(selectedUserId); }, [selectedUserId]);

  const selectedDept = departments.find((d) => d.id === departmentId);

  const suggestedWeight = useMemo(() => {
    if (!selectedDept || !startDate || !endDate || endDate < startDate) return null;
    const sameDeptKpis = userKpis.filter(
      (k) => k.completion_status === 'pending' && (k.department_id === departmentId || k.department === selectedDept.name),
    );
    return suggestKpiWeight(
      Number(selectedDept.org_weight_pct),
      startDate,
      endDate,
      sameDeptKpis,
    );
  }, [selectedDept, startDate, endDate, userKpis, departmentId]);

  useEffect(() => {
    if (suggestedWeight != null && !weightTouched) {
      setWeight(String(suggestedWeight));
    }
  }, [suggestedWeight, weightTouched]);

  const applySuggestedWeight = () => {
    if (suggestedWeight != null) {
      setWeight(String(suggestedWeight));
      setWeightTouched(false);
    }
  };

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

    const weightNum = Number(weight);
    if (!Number.isFinite(weightNum) || weightNum < 0.25 || weightNum > 10) {
      setError('KPI weight must be between 0.25 and 10.');
      return;
    }

    const deptName = selectedDept?.name || departmentId;

    setFormLoading(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('assign_kpi_manager', {
        p_employee_id: selectedUserId,
        p_department: deptName,
        p_description: description.trim() || null,
        p_start_date: startDate,
        p_end_date: endDate,
        p_weight: weightNum,
      });

      if (rpcErr) throw rpcErr;

      const row = Array.isArray(data) ? data[0] : data;
      if (row?.employee_email) {
        await emailKpiAssigned(row.employee_email, row.employee_name, deptName, endDate, description);
      }

      setDescription('');
      setStartDate('');
      setEndDate('');
      setWeightTouched(false);
      fetchKpis(selectedUserId);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to assign task.');
    } finally {
      setFormLoading(false);
    }
  };

  const handleDelete = async (kpiId: string) => {
    if (!confirm('Remove this KPI assignment?')) return;
    await supabase.from('kpis').delete().eq('id', kpiId);
    fetchKpis(selectedUserId);
  };

  const fmt = (d?: string | null) => d ? new Date(d + 'T00:00:00').toLocaleDateString() : '—';

  if (loading) {
    return <div style={{ display: 'flex', justifyContent: 'center', padding: '3rem' }}><Loader2 className="spin-icon" /></div>;
  }

  return (
    <div className="responsive-grid-wide" style={{ gap: '2rem' }}>
      <div className="glass-panel">
        <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>
          {isAdmin ? 'All Employee Tasks' : 'Team Tasks'}
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', maxHeight: '480px', overflowY: 'auto' }}>
            {userKpis.map((k) => (
              <div key={k.id} style={{ padding: '1rem', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem' }}>
                  <div>
                    <strong>{k.department || k.name}</strong>
                    <span className="dept-weight-badge">Weight {k.weight}</span>
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
        )}
      </div>

      <div className="glass-panel" style={{ height: 'fit-content' }}>
        <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Plus size={18} /> Assign Task
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
            <select
              value={departmentId}
              onChange={(e) => { setDepartmentId(e.target.value); setWeightTouched(false); }}
              required
            >
              <option value="">— Select department —</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.org_weight_pct}% dept share)
                </option>
              ))}
            </select>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Description</label>
            <textarea rows={3} placeholder="Task details..." value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div style={{ display: 'flex', gap: '1rem' }}>
            <div className="form-group" style={{ margin: 0, flex: 1 }}>
              <label>Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => { setStartDate(e.target.value); setWeightTouched(false); }}
                required
              />
            </div>
            <div className="form-group" style={{ margin: 0, flex: 1 }}>
              <label>End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => { setEndDate(e.target.value); setWeightTouched(false); }}
                required
              />
            </div>
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>KPI Weight (you decide)</label>
            <div className="dept-weight-assign-row">
              <input
                type="number"
                min={0.25}
                max={10}
                step={0.25}
                value={weight}
                onChange={(e) => { setWeight(e.target.value); setWeightTouched(true); }}
                required
                className="dept-weight-assign-input"
              />
              {suggestedWeight != null && (
                <button type="button" className="btn btn-secondary btn-sm" onClick={applySuggestedWeight} title="Use suggested weight">
                  <Sparkles size={14} /> Use suggested ({suggestedWeight})
                </button>
              )}
            </div>
            <p className="dept-weight-hint">
              Set how important this task is (0.25–10). Suggested value uses department share and task duration — adjust as needed.
            </p>
          </div>
          <button type="submit" className="btn btn-primary" disabled={formLoading || !selectedUserId || departments.length === 0}>
            {formLoading ? <Loader2 size={16} className="spin-icon" /> : 'Assign & Notify Employee'}
          </button>
        </form>
      </div>
    </div>
  );
}
