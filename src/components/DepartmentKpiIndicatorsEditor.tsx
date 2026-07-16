import { useCallback, useEffect, useState } from 'react';
import { CheckCircle, Loader2, Save } from 'lucide-react';
import { supabase } from '../lib/supabase';
import {
  DepartmentKpiIndicator,
  formatWeightPct,
  indicatorWeightsValid,
  sumIndicatorWeights,
} from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';

interface DepartmentKpiIndicatorsEditorProps {
  departmentId: string;
  departmentName: string;
  /** Always show KPI board expanded (default: true) */
  defaultOpen?: boolean;
}

export default function DepartmentKpiIndicatorsEditor({
  departmentId,
  departmentName,
  defaultOpen = true,
}: DepartmentKpiIndicatorsEditorProps) {
  const [rows, setRows] = useState<DepartmentKpiIndicator[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    const { data, error } = await supabase.rpc('get_department_kpi_indicators', { p_department_id: departmentId });
    if (error) {
      setMsg(error.message);
      setRows([]);
    } else {
      setRows((data as DepartmentKpiIndicator[]) || []);
    }
    setLoading(false);
  }, [departmentId]);

  useEffect(() => { void load(); }, [load]);

  useSupabaseRealtime(
    `dept-kpis-${departmentId}`,
    [{ table: 'department_kpi_indicators', filter: `department_id=eq.${departmentId}` }],
    load,
  );

  const total = sumIndicatorWeights(rows);
  const valid = indicatorWeightsValid(rows);

  const updatePct = (id: string, pct: number) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, weight_pct: pct } : r)));
  };

  const save = async () => {
    if (!valid) {
      setMsg(`KPI weightages must sum to 100% (currently ${total.toFixed(1)}%).`);
      return;
    }
    setSaving(true);
    setMsg('');
    const { error } = await supabase.rpc('save_department_kpi_indicators', {
      p_department_id: departmentId,
      p_indicators: rows.map((r) => ({
        id: r.id,
        name: r.name,
        description: r.description,
        weight_pct: Number(r.weight_pct),
      })),
    });
    setSaving(false);
    if (error) setMsg(error.message);
    else {
      setMsg('Saved.');
      await load();
    }
  };

  if (!defaultOpen) return null;

  return (
    <div className="dept-indicators dept-indicators--open">
      <div className="dept-indicators__header">
        <span className="dept-indicators__status"><CheckCircle size={14} /> Active · {rows.length} KPIs</span>
        <strong className={valid ? 'dept-indicators__total--ok' : 'dept-indicators__total--warn'}>
          {loading ? '…' : formatWeightPct(total)}
        </strong>
      </div>

      {msg && (
        <div className={`rewards-toast ${/error|must|failed/i.test(msg) ? 'rewards-toast--error' : 'rewards-toast--success'}`}>
          {msg}
        </div>
      )}

      {loading ? (
        <div className="dept-indicators__loading"><Loader2 size={18} className="spin-icon" /></div>
      ) : rows.length === 0 ? (
        <p className="dept-indicators__empty">
          KPI board not loaded. Run: <code>npm run departments:setup</code>
        </p>
      ) : (
        <>
          <table className="attendance-history-table dept-indicators-table">
            <thead>
              <tr>
                <th>KPI Metric</th>
                <th>Description</th>
                <th>Weight %</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td><strong>{r.name}</strong></td>
                  <td className="dept-indicators__desc-cell">{r.description}</td>
                  <td>
                    <input
                      type="number"
                      min={0}
                      max={100}
                      step={0.5}
                      value={r.weight_pct}
                      onChange={(e) => updatePct(r.id, Number(e.target.value))}
                      className="dept-weight-input"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" className="btn btn-primary btn-sm" disabled={saving || !valid} onClick={() => void save()}>
            {saving ? <Loader2 size={14} className="spin-icon" /> : <Save size={14} />}
            Save {departmentName} KPI weights
          </button>
        </>
      )}
    </div>
  );
}
