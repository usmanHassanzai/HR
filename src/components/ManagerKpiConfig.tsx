import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase';
import { Profile, Kpi } from '../utils/kpiHelpers';
import { Plus, Loader2, Trash2 } from 'lucide-react';
import { emailKpiAssigned } from '../utils/kpiEmail';

interface ManagerKpiConfigProps {
  managerId: string;
}

export default function ManagerKpiConfig({ managerId }: ManagerKpiConfigProps) {
  const [reports, setReports] = useState<Profile[]>([]);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [userKpis, setUserKpis] = useState<Kpi[]>([]);
  const [loading, setLoading] = useState(true);
  const [kpiLoading, setKpiLoading] = useState(false);
  const [formLoading, setFormLoading] = useState(false);
  const [error, setError] = useState('');

  const [department, setDepartment] = useState('');
  const [description, setDescription] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      const { data } = await supabase.rpc('get_direct_reports', { p_manager_id: managerId });
      setReports((data as Profile[]) || []);
      setLoading(false);
    })();
  }, [managerId]);

  const fetchKpis = async (userId: string) => {
    if (!userId) { setUserKpis([]); return; }
    setKpiLoading(true);
    const { data } = await supabase.from('kpis').select('*').eq('user_id', userId).order('created_at', { ascending: false });
    setUserKpis(data || []);
    setKpiLoading(false);
  };

  useEffect(() => { fetchKpis(selectedUserId); }, [selectedUserId]);

  const handleAssign = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (!selectedUserId || !department || !startDate || !endDate) {
      setError('Employee, department, start date and end date are required.');
      return;
    }
    if (endDate < startDate) {
      setError('End date must be on or after start date.');
      return;
    }

    setFormLoading(true);
    try {
      const { data, error: rpcErr } = await supabase.rpc('assign_kpi_manager', {
        p_employee_id: selectedUserId,
        p_department: department.trim(),
        p_description: description.trim() || null,
        p_start_date: startDate,
        p_end_date: endDate,
      });

      if (rpcErr) throw rpcErr;

      const row = Array.isArray(data) ? data[0] : data;
      if (row?.employee_email) {
        await emailKpiAssigned(row.employee_email, row.employee_name, department, endDate, description);
      }

      setDepartment('');
      setDescription('');
      setStartDate('');
      setEndDate('');
      fetchKpis(selectedUserId);
    } catch (err: any) {
      setError(err.message || 'Failed to assign KPI.');
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
        <h3 style={{ fontSize: '1.25rem', fontFamily: 'var(--font-display)', marginBottom: '1rem' }}>Team KPI Assignments</h3>
        <select value={selectedUserId} onChange={(e) => setSelectedUserId(e.target.value)} style={{ marginBottom: '1rem' }}>
          <option value="">— Select employee —</option>
          {reports.map((r) => <option key={r.id} value={r.id}>{r.full_name}</option>)}
        </select>

        {!selectedUserId ? (
          <p style={{ color: 'var(--text-muted)', textAlign: 'center', padding: '2rem' }}>Select a team member to view their KPIs.</p>
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
                    <span className={`badge badge-${(k.completion_status === 'completed' ? 'on-track' : k.status.replace('_', '-'))}`} style={{ marginLeft: '0.5rem', fontSize: '0.65rem' }}>
                      {k.completion_status === 'completed' ? 'completed' : k.status.replace('_', ' ')}
                    </span>
                    {k.description && <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginTop: '0.35rem' }}>{k.description}</p>}
                    <p style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.35rem' }}>
                      {fmt(k.start_date)} → {fmt(k.end_date)} · Redos: {k.redo_count ?? 0}/3
                    </p>
                  </div>
                  <button className="btn btn-secondary" style={{ padding: '0.4rem', height: 'fit-content' }} onClick={() => handleDelete(k.id)} title="Remove">
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
          <Plus size={18} /> Assign KPI
        </h3>
        {error && <div style={{ background: 'var(--color-danger-bg)', color: 'var(--color-danger)', padding: '0.75rem', borderRadius: 'var(--border-radius-sm)', fontSize: '0.85rem', marginBottom: '1rem' }}>{error}</div>}
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
            <input type="text" placeholder="e.g. Recruitment" value={department} onChange={(e) => setDepartment(e.target.value)} required />
          </div>
          <div className="form-group" style={{ margin: 0 }}>
            <label>Description</label>
            <textarea rows={3} placeholder="Task details..." value={description} onChange={(e) => setDescription(e.target.value)} />
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
          <button type="submit" className="btn btn-primary" disabled={formLoading || !selectedUserId}>
            {formLoading ? <Loader2 size={16} className="spin-icon" /> : 'Assign & Notify Employee'}
          </button>
        </form>
      </div>
    </div>
  );
}
