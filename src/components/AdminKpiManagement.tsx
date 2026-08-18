import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, Building2, Loader2, Target } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Department, formatWeightPct, sumIndicatorWeights } from '../utils/departmentHelpers';
import { KPI_WEIGHT_CAP } from '../utils/kpiWeightHelpers';
import DepartmentKpiIndicatorsEditor from './DepartmentKpiIndicatorsEditor';
import '../styles/departments.css';
import '../styles/assign-tasks.css';

export default function AdminKpiManagement() {
  const [departments, setDepartments] = useState<Department[]>([]);
  const [departmentId, setDepartmentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [templateTotal, setTemplateTotal] = useState(0);
  const [kpiCount, setKpiCount] = useState(0);

  const selectedDept = departments.find((d) => d.id === departmentId);

  const loadDepartments = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    const { data } = await supabase.rpc('get_departments');
    const list = ((data as Department[]) || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    setDepartments(list);
    setDepartmentId((prev) => prev || list[0]?.id || '');
    if (!silent) setLoading(false);
  }, []);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  useEffect(() => {
    if (!departmentId) {
      setTemplateTotal(0);
      setKpiCount(0);
      return;
    }
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('get_department_kpi_indicators', { p_department_id: departmentId });
      if (cancelled) return;
      const rows = (data as { weight_pct: number }[]) || [];
      setKpiCount(rows.length);
      setTemplateTotal(sumIndicatorWeights(rows));
    })();
    return () => { cancelled = true; };
  }, [departmentId]);

  if (loading && departments.length === 0) {
    return (
      <div className="assign-task-page-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading KPI templates…</span>
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
            <h2 className="assign-task-header__title">KPI Management</h2>
            <p className="assign-task-header__subtitle">
              Department KPI libraries can include any number of KPIs. Their combined template weight can exceed {KPI_WEIGHT_CAP}%.
              The {KPI_WEIGHT_CAP}% limit applies only to one employee&apos;s assigned KPIs.
            </p>
          </div>
        </div>
      </header>

      {departments.length === 0 ? (
        <div className="assign-task-info">
          <AlertCircle size={16} />
          <span>Create departments under <strong>Departments</strong> before adding KPI templates.</span>
        </div>
      ) : (
        <section className="assign-task-card glass-panel">
          <div className="form-group">
            <label htmlFor="kpi-mgmt-dept">Filter by department</label>
            <select
              id="kpi-mgmt-dept"
              value={departmentId}
              onChange={(e) => setDepartmentId(e.target.value)}
            >
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          </div>

          {selectedDept && kpiCount > 0 && (
            <div className="kpi-template-status kpi-template-status--ok">
              <Building2 size={18} />
              <div>
                <strong>KPI library</strong>
                <p>Total KPI Template Weight: {formatWeightPct(templateTotal)} · {kpiCount} KPI{kpiCount !== 1 ? 's' : ''}.</p>
                <p>This total is not capped. The 100% rule applies only when assigning to an employee.</p>
              </div>
            </div>
          )}

          {departmentId && (
            <DepartmentKpiIndicatorsEditor
              key={departmentId}
              departmentId={departmentId}
              departmentName={selectedDept?.name || 'Department'}
              defaultOpen
              onTotalsChange={(total, count) => {
                setTemplateTotal(total);
                setKpiCount(count);
              }}
            />
          )}
        </section>
      )}
    </div>
  );
}
