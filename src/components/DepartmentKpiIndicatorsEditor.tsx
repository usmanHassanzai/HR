import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle, Cloud, Loader2, Plus, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  DepartmentKpiIndicator,
  formatWeightPct,
  indicatorWeightsValid,
  sumIndicatorWeights,
} from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import { useDebouncedEffect } from '../utils/useDebouncedEffect';

interface DepartmentKpiIndicatorsEditorProps {
  departmentId: string;
  departmentName: string;
  defaultOpen?: boolean;
  allowEdit?: boolean;
}

type EditableIndicator = DepartmentKpiIndicator & { isNew?: boolean };

export default function DepartmentKpiIndicatorsEditor({
  departmentId,
  departmentName,
  defaultOpen = true,
  allowEdit = true,
}: DepartmentKpiIndicatorsEditorProps) {
  const [rows, setRows] = useState<EditableIndicator[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [msg, setMsg] = useState('');
  const [dirty, setDirty] = useState(false);
  const skipLoadSave = useRef(false);

  const load = useCallback(async () => {
    skipLoadSave.current = true;
    setLoading(true);
    setMsg('');
    const { data, error } = await supabase.rpc('get_department_kpi_indicators', { p_department_id: departmentId });
    if (error) {
      setMsg(error.message);
      setRows([]);
    } else {
      setRows((data as DepartmentKpiIndicator[]) || []);
      setDirty(false);
    }
    setLoading(false);
    skipLoadSave.current = false;
  }, [departmentId]);

  useEffect(() => { void load(); }, [load]);

  useSupabaseRealtime(
    `dept-kpis-${departmentId}`,
    [{ table: 'department_kpi_indicators', filter: `department_id=eq.${departmentId}` }],
    () => { if (!dirty) void load(); },
  );

  const total = sumIndicatorWeights(rows);
  const valid = indicatorWeightsValid(rows) && rows.every((r) => r.name.trim());

  const updateRow = (id: string, patch: Partial<EditableIndicator>) => {
    setDirty(true);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const addRow = () => {
    setDirty(true);
    const n = rows.length + 1;
    setRows((prev) => [
      ...prev,
      {
        id: `new-${Date.now()}`,
        department_id: departmentId,
        name: '',
        description: '',
        weight_pct: Math.max(0, 100 - sumIndicatorWeights(prev)),
        sort_order: n,
        isNew: true,
      },
    ]);
  };

  const removeRow = (id: string) => {
    setDirty(true);
    setRows((prev) => prev.filter((r) => r.id !== id));
  };

  const loadTemplate = async () => {
    setSeeding(true);
    setMsg('');
    const { error } = await supabase.rpc('seed_default_department_kpis', { p_department_id: departmentId });
    setSeeding(false);
    if (error) setMsg(error.message);
    else await load();
  };

  const save = useCallback(async (auto = false) => {
    if (!valid || rows.length === 0) {
      if (!auto) setMsg(`Each KPI needs a name and weights must sum to 100% (currently ${total.toFixed(1)}%).`);
      return;
    }
    setSaving(true);
    if (!auto) setMsg('');
    const { error } = await supabase.rpc('save_department_kpi_indicators', {
      p_department_id: departmentId,
      p_indicators: rows.map((r, i) => ({
        id: r.isNew || r.id.startsWith('new-') ? null : r.id,
        name: r.name.trim(),
        description: r.description?.trim() || null,
        weight_pct: Number(r.weight_pct),
        sort_order: i + 1,
      })),
    });
    setSaving(false);
    if (error) {
      setMsg(error.message);
    } else {
      setDirty(false);
      setMsg(auto ? 'Saved to database' : 'KPI board saved.');
      await load();
    }
  }, [departmentId, rows, valid, total]);

  useDebouncedEffect(
    () => {
      if (skipLoadSave.current || !dirty || !valid || rows.length === 0 || !allowEdit) return;
      void save(true);
    },
    [rows, dirty, valid, allowEdit, save],
    1200,
    allowEdit,
  );

  if (!defaultOpen) return null;

  return (
    <div className="dept-indicators dept-indicators--open">
      <div className="dept-indicators__header">
        <span className="dept-indicators__status">
          <CheckCircle size={14} /> {departmentName} · {rows.length} KPIs
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem' }}>
          {allowEdit && (
            <span className="dept-indicators__autosave" style={{ fontSize: '0.78rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              {saving ? <><Loader2 size={12} className="spin-icon" /> Saving…</> : dirty ? 'Unsaved changes…' : <><Cloud size={12} /> Synced</>}
            </span>
          )}
          <strong className={valid ? 'dept-indicators__total--ok' : 'dept-indicators__total--warn'}>
            {loading ? '…' : formatWeightPct(total)}
          </strong>
        </div>
      </div>

      {msg && (
        <div className={`rewards-toast ${/error|must|failed|not authorized/i.test(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      {loading ? (
        <div className="dept-indicators__loading"><Loader2 size={18} className="spin-icon" /></div>
      ) : rows.length === 0 ? (
        <div className="dept-indicators__empty">
          <p>No KPI metrics yet for {departmentName}. Changes save automatically to Supabase.</p>
          {allowEdit && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem' }}>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void loadTemplate()} disabled={seeding}>
                {seeding ? <Loader2 size={14} className="spin-icon" /> : null}
                Load default template
              </button>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
                <Plus size={14} /> Add KPI metric
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <table className="attendance-history-table dept-indicators-table">
            <thead>
              <tr>
                <th>KPI Metric</th>
                <th>Description</th>
                <th>Weight %</th>
                {allowEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    {allowEdit ? (
                      <input
                        type="text"
                        value={r.name}
                        onChange={(e) => updateRow(r.id, { name: e.target.value })}
                        placeholder="KPI name"
                        className="input-field"
                        style={{ minWidth: '140px' }}
                      />
                    ) : (
                      <strong>{r.name}</strong>
                    )}
                  </td>
                  <td className="dept-indicators__desc-cell">
                    {allowEdit ? (
                      <input
                        type="text"
                        value={r.description ?? ''}
                        onChange={(e) => updateRow(r.id, { description: e.target.value })}
                        placeholder="Description"
                        className="input-field"
                      />
                    ) : (
                      r.description
                    )}
                  </td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={r.weight_pct}
                      onChange={(e) => updateRow(r.id, { weight_pct: Number(e.target.value) })}
                      className="dept-weight-input"
                      disabled={!allowEdit}
                    />
                  </td>
                  {allowEdit && (
                    <td>
                      <button type="button" className="btn btn-secondary btn-sm" onClick={() => removeRow(r.id)} title="Remove KPI">
                        <Trash2 size={14} />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          {allowEdit && (
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.75rem', alignItems: 'center' }}>
              <button type="button" className="btn btn-secondary btn-sm" onClick={addRow}>
                <Plus size={14} /> Add KPI metric
              </button>
              <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                Edits auto-save to the database — no manual sync needed.
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
