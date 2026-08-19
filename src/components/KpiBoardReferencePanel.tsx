import { useCallback, useEffect, useState } from 'react';
import { Loader2, Pencil } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Department, FUNCTIONAL_DEPARTMENTS } from '../utils/departmentHelpers';
import DepartmentKpiIndicatorsEditor from './DepartmentKpiIndicatorsEditor';

/**
 * Live department-wise monthly KPI board — every registered department,
 * with editable KPI names and weights. Library totals may exceed 100%.
 */
export default function KpiBoardReferencePanel({ allowEdit = true }: { allowEdit?: boolean }) {
  const [depts, setDepts] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [boardTick, setBoardTick] = useState(0);

  const load = useCallback(async () => {
    setError('');
    const { data, error: err } = await supabase.rpc('get_departments');
    if (err) {
      setError(err.message);
      setDepts([]);
    } else {
      setDepts((data as Department[]) || []);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const applyTemplate = async (departmentId: string, slug: string) => {
    const tpl = FUNCTIONAL_DEPARTMENTS.find((d) => d.slug === slug);
    if (!tpl) return;
    const { error: err } = await supabase.rpc('save_department_kpi_indicators', {
      p_department_id: departmentId,
      p_indicators: tpl.indicators.map((ind, i) => ({
        id: null,
        name: ind.name,
        description: ind.description,
        weight_pct: ind.weight_pct,
        sort_order: i + 1,
      })),
    });
    if (err) setError(err.message);
    else {
      setBoardTick((n) => n + 1);
      await load();
    }
  };

  return (
    <div className="kpi-board-reference">
      <div className="kpi-board-reference__intro">
        <h3>Department-wise monthly KPI board</h3>
        <p>
          Every department in your company is listed here. Add as many KPI metrics as you need.
          Each KPI has its own weight (1–100%). The department library total can exceed 100%.
          The 100% limit applies only when those KPIs are assigned to one employee. Changes save automatically.
        </p>
        <div className="kpi-board-reference__formula">
          <strong>Score formula:</strong> Employee Score % × KPI Weight = Weighted Score. Overall KPI Score is the sum of weighted scores.
        </div>
        <div className="kpi-board-reference__legend">
          <span className="kpi-traffic kpi-traffic--green">Green — on track</span>
          <span className="kpi-traffic kpi-traffic--yellow">Yellow — at risk</span>
          <span className="kpi-traffic kpi-traffic--red">Red — off track</span>
          {allowEdit && (
            <span className="kpi-board-reference__edit-hint">
              <Pencil size={12} /> Weights are editable
            </span>
          )}
        </div>
      </div>

      {error && <p className="kpi-board-reference__error">{error}</p>}

      {loading ? (
        <div className="dept-page-loading" style={{ minHeight: 120 }}>
          <Loader2 size={28} className="spin-icon" />
          <span>Loading all departments…</span>
        </div>
      ) : depts.length === 0 ? (
        <p className="kpi-board-reference__empty">No departments yet. Add them above, then add KPI metrics here.</p>
      ) : (
        <div className="kpi-board-reference__departments kpi-board-reference__departments--live">
          {depts.map((dept, idx) => (
            <section key={dept.id} className="kpi-board-reference__dept kpi-board-reference__dept--live">
              <h4>
                <span>
                  {idx + 1}. {dept.name}
                </span>
                <span className="kpi-board-reference__dept-total">Library total can exceed 100%</span>
              </h4>
              {allowEdit && (
                <div className="kpi-board-reference__templates">
                  <span>Apply example layout:</span>
                  {FUNCTIONAL_DEPARTMENTS.map((tpl) => (
                    <button
                      key={tpl.slug}
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => void applyTemplate(dept.id, tpl.slug)}
                    >
                      {tpl.name}
                    </button>
                  ))}
                </div>
              )}
              <DepartmentKpiIndicatorsEditor
                key={`${dept.id}-${boardTick}`}
                departmentId={dept.id}
                departmentName={dept.name}
                defaultOpen
                allowEdit={allowEdit}
              />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
