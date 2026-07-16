import { useCallback, useEffect, useState } from 'react';
import { Building2, Loader2, Plus, Save, Trash2, Info, CheckCircle } from 'lucide-react';
import '../styles/attendance.css';
import '../styles/departments.css';
import { supabase } from '../lib/supabase';
import { Department, formatWeightPct, sumWeights, weightsValid } from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import DepartmentKpiIndicatorsEditor from './DepartmentKpiIndicatorsEditor';
import KpiBoardReferencePanel from './KpiBoardReferencePanel';

interface EditableDept extends Department {
  isNew?: boolean;
}

export default function DepartmentWeightagesPanel({ managerMode = false }: { managerMode?: boolean }) {
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
        setMsg('Run: npm run departments:setup');
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

  useSupabaseRealtime(
    'departments-sync',
    [
      { table: 'departments' },
      { table: 'department_kpi_indicators' },
    ],
    load,
  );

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
    if (!confirm(`Deactivate "${row.name}"?`)) return;
    setSaving(true);
    const { error } = await supabase.rpc('deactivate_department', { p_department_id: row.id });
    setSaving(false);
    if (error) setMsg(error.message);
    else await load();
  };

  const save = async () => {
    if (!valid) {
      setMsg(`Org weightages must sum to 100% (currently ${total.toFixed(1)}%).`);
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
      setMsg('Department org weightages saved.');
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
        <div className={`rewards-toast ${/failed|error|must|Run/i.test(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      <KpiBoardReferencePanel />

      <div className="attendance-card">
        <h3 className="attendance-card__title">
          <Building2 size={18} /> Functional Departments — Open & Active
        </h3>
        <p className="attendance-card__subtitle">
          {managerMode ? (
            <>Your department KPI board is stored in <strong>Supabase</strong> and syncs instantly on every device.</>
          ) : (
            <>Each company has isolated data in Supabase. Departments use their own table + KPI indicator table — changes sync live across web and mobile.</>
          )}
        </p>

        {!managerMode && (
        <div className="dept-weight-info">
          <Info size={16} />
          <span>Org-level shares must total 100%. Each department KPI board also totals 100% per employee.</span>
        </div>
        )}

        {!managerMode && (
        <div className="dept-weight-total" data-valid={valid}>
          <span>Total org allocation</span>
          <strong>{formatWeightPct(total)}</strong>
          {!valid && <span className="dept-weight-total__warn">Must equal 100%</span>}
        </div>
        )}

        {rows.length === 0 ? (
          <div className="dept-empty-state">
            <p>{managerMode
              ? 'No department assigned to your manager account. Ask your company admin to assign you to a department in Users.'
              : 'No departments found.'}</p>
            {!managerMode && (
            <button type="button" className="btn btn-primary" onClick={() => setMsg('Run on server: npm run departments:setup')}>
              Setup departments
            </button>
            )}
          </div>
        ) : (
          <div className="dept-cards-grid">
            {rows.map((r) => (
              <div key={r.id} className="dept-card glass-panel">
                <div className="dept-card__head">
                  <div>
                    <span className="dept-card__badge"><CheckCircle size={12} /> Open</span>
                    <h4>{r.name}</h4>
                    <span className="dept-card__meta">
                      Org share: {formatWeightPct(r.org_weight_pct)}
                      {(r.indicator_count ?? 0) > 0 && ` · ${r.indicator_count} KPI metrics`}
                    </span>
                  </div>
                  <div className="dept-card__org-weight">
                    {!managerMode && (
                    <>
                    <label>Org %</label>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={r.org_weight_pct}
                      onChange={(e) => updatePct(r.id, Number(e.target.value))}
                      className="dept-weight-input"
                    />
                    </>
                    )}
                  </div>
                  {!r.isNew && !managerMode && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => void removeRow(r)} disabled={saving} title="Deactivate">
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
                {!r.isNew && (
                  <DepartmentKpiIndicatorsEditor departmentId={r.id} departmentName={r.name} defaultOpen />
                )}
              </div>
            ))}
          </div>
        )}

        {!managerMode && (
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
            <button type="button" className="btn btn-primary" disabled={saving || !valid || rows.length === 0} onClick={() => void save()}>
              {saving ? <Loader2 size={16} className="spin-icon" /> : <Save size={16} />}
              Save org weightages
            </button>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}
