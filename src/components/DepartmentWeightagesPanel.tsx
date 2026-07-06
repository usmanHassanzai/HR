import { useCallback, useEffect, useState } from 'react';
import { Building2, Loader2, Plus, Save, Trash2, Info } from 'lucide-react';
import '../styles/attendance.css';
import '../styles/departments.css';
import { supabase } from '../lib/supabase';
import { Department, formatWeightPct, sumWeights, weightsValid } from '../utils/departmentHelpers';

interface EditableDept extends Department {
  isNew?: boolean;
}

export default function DepartmentWeightagesPanel() {
  const [rows, setRows] = useState<EditableDept[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [newName, setNewName] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    const { data, error } = await supabase.rpc('get_departments');
    if (error) {
      if (/does not exist|departments/i.test(error.message)) {
        setMsg('Run migration: node scripts/department-weightages-migration.mjs');
      } else {
        setMsg(error.message);
      }
      setRows([]);
    } else {
      setRows((data as Department[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => { void load(); }, [load]);

  const total = sumWeights(rows);
  const valid = weightsValid(rows);

  const updatePct = (id: string, pct: number) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, org_weight_pct: pct } : r)));
  };

  const distributeEvenly = () => {
    if (rows.length === 0) return;
    const each = Math.round((100 / rows.length) * 100) / 100;
    let remainder = 100;
    setRows((prev) =>
      prev.map((r, i) => {
        const pct = i === prev.length - 1 ? remainder : each;
        remainder -= pct;
        return { ...r, org_weight_pct: pct };
      }),
    );
  };

  const addDepartment = () => {
    const name = newName.trim();
    if (!name) return;
    if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      setMsg('Department already exists.');
      return;
    }
    setRows((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        name,
        slug: name.toLowerCase().replace(/\s+/g, '-'),
        org_weight_pct: 0,
        active: true,
        isNew: true,
      },
    ]);
    setNewName('');
  };

  const removeRow = async (row: EditableDept) => {
    if (row.isNew) {
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      return;
    }
    if (!confirm(`Remove "${row.name}" from active departments?`)) return;
    setSaving(true);
    const { error } = await supabase.rpc('deactivate_department', { p_department_id: row.id });
    setSaving(false);
    if (error) setMsg(error.message);
    else await load();
  };

  const save = async () => {
    if (!valid) {
      setMsg(`Weightages must sum to 100% (currently ${total.toFixed(1)}%).`);
      return;
    }
    setSaving(true);
    setMsg('');
    const payload = rows.map((r) => ({
      id: r.isNew ? null : r.id,
      name: r.name,
      weight_pct: Number(r.org_weight_pct),
    }));
    const { error } = await supabase.rpc('save_department_weightages', { p_weights: payload });
    setSaving(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Department weightages saved. KPI weights recalculated automatically.');
      await load();
    }
  };

  if (loading) {
    return (
      <div className="rewards-loading">
        <Loader2 size={28} className="spin-icon" />
      </div>
    );
  }

  return (
    <div className="dept-weight-page">
      {msg && (
        <div className={`rewards-toast ${/failed|error|must|Run migration/i.test(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <div className="attendance-card">
        <h3 className="attendance-card__title">
          <Building2 size={18} /> Department KPI weightages
        </h3>
        <p className="attendance-card__subtitle">
          Manage departments and their default share of KPI scoring (must total <strong>100%</strong>).
          When assigning tasks, admin and manager set the <strong>exact KPI weight</strong> per employee — suggested values use these department shares and task duration.
        </p>

        <div className="dept-weight-info">
          <Info size={16} />
          <span>
            Auto formula: KPI weight = department % × (task days ÷ total days in that department for the employee)
          </span>
        </div>

        <div className="dept-weight-total" data-valid={valid}>
          <span>Total allocation</span>
          <strong>{formatWeightPct(total)}</strong>
          {!valid && <span className="dept-weight-total__warn">Must equal 100%</span>}
        </div>

        <div className="dept-weight-table-wrap">
          <table className="attendance-history-table dept-weight-table">
            <thead>
              <tr>
                <th>Department</th>
                <th>Weight %</th>
                <th>Active KPIs</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={r.org_weight_pct}
                      onChange={(e) => updatePct(r.id, Number(e.target.value))}
                      className="dept-weight-input"
                    />
                  </td>
                  <td>{r.active_kpi_count ?? 0}</td>
                  <td>
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void removeRow(r)} disabled={saving}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="dept-weight-actions">
          <div className="dept-weight-add">
            <input
              type="text"
              placeholder="Add department name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addDepartment())}
            />
            <button type="button" className="btn btn-secondary" onClick={addDepartment}>
              <Plus size={16} /> Add
            </button>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            <button type="button" className="btn btn-secondary" onClick={distributeEvenly}>Split evenly</button>
            <button type="button" className="btn btn-primary" disabled={saving || !valid} onClick={() => void save()}>
              {saving ? <Loader2 size={16} className="spin-icon" /> : <Save size={16} />}
              Save weightages
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
