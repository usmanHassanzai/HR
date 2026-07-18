import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Building2,
  ChevronDown,
  Loader2,
  Plus,
  Trash2,
  CheckCircle2,
  AlertCircle,
  Scale,
  Layers,
  Sparkles,
} from 'lucide-react';
import '../styles/attendance.css';
import '../styles/departments.css';
import { supabase } from '../lib/supabase';
import { Department, formatWeightPct, sumWeights, weightsValid } from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import DepartmentKpiIndicatorsEditor from './DepartmentKpiIndicatorsEditor';
import KpiBoardReferencePanel from './KpiBoardReferencePanel';

function isToastError(message: string): boolean {
  return /failed|error|must|cannot|reassign|could not find|not found|already exists|enter a|exception|only company admin/i.test(
    message,
  );
}

export default function DepartmentWeightagesPanel({ managerMode = false }: { managerMode?: boolean }) {
  const [rows, setRows] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const [newName, setNewName] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showMessage = useCallback((text: string) => {
    setMsg(text);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    if (text && !isToastError(text)) {
      msgTimer.current = setTimeout(() => setMsg(''), 5000);
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg('');
    const { data, error } = await supabase.rpc('get_departments');
    if (error) {
      showMessage(error.message);
      setRows([]);
    } else {
      setRows((data as Department[]) || []);
    }
    setLoading(false);
  }, [showMessage]);

  useEffect(() => {
    void load();
    return () => {
      if (msgTimer.current) clearTimeout(msgTimer.current);
    };
  }, [load]);

  useSupabaseRealtime(
    'departments-sync',
    [{ table: 'departments' }, { table: 'department_kpi_indicators' }],
    () => { void load(); },
  );

  const total = sumWeights(rows);
  const valid = weightsValid(rows);
  const totalIndicators = rows.reduce((n, r) => n + (r.indicator_count ?? 0), 0);
  const equalShare = rows.length > 0 ? formatWeightPct(rows[0].org_weight_pct) : '—';

  const addDepartment = async () => {
    const name = newName.trim();
    if (!name) {
      showMessage('Enter a department name.');
      return;
    }
    if (rows.some((r) => r.name.toLowerCase() === name.toLowerCase())) {
      showMessage('A department with this name already exists.');
      return;
    }

    setAdding(true);
    setMsg('');
    const { data, error } = await supabase.rpc('create_department_admin', { p_name: name });
    setAdding(false);
    if (error) {
      showMessage(error.message);
      return;
    }
    setNewName('');
    showMessage(`"${name}" added. Org weight split equally across ${rows.length + 1} departments (100%).`);
    await load();
    if (data) {
      setTimeout(() => {
        document.getElementById(`dept-card-${data}`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }, 200);
    }
  };

  const removeRow = async (row: Department) => {
    if (
      !confirm(
        `Permanently delete "${row.name}"?\n\nThis removes the department and its KPI board from the database. Remaining departments will automatically share 100% equally. Reassign any users in this department under Users first.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg('');
    const { error } = await supabase.rpc('delete_department_admin', { p_department_id: row.id });
    setBusy(false);
    if (error) showMessage(error.message);
    else {
      showMessage(`"${row.name}" permanently deleted. Remaining departments rebalanced equally.`);
      await load();
    }
  };

  if (loading) {
    return (
      <div className="dept-page-loading">
        <Loader2 size={32} className="spin-icon" />
        <span>Loading departments…</span>
      </div>
    );
  }

  return (
    <div className="dept-weight-page">
      {!managerMode && (
        <header className="dept-page-header glass-panel">
          <div className="dept-page-header__main">
            <div className="dept-page-header__icon">
              <Building2 size={22} />
            </div>
            <div>
              <h2 className="dept-page-header__title">Departments</h2>
              <p className="dept-page-header__subtitle">
                Each department automatically receives an equal share of organization performance (100% total).
                Add or remove departments anytime — weights rebalance instantly.
              </p>
            </div>
          </div>

          <div className="dept-page-stats">
            <div className="dept-stat">
              <Layers size={16} />
              <span className="dept-stat__label">Departments</span>
              <strong>{rows.length}</strong>
            </div>
            <div className="dept-stat" data-valid={valid || rows.length === 0}>
              <Scale size={16} />
              <span className="dept-stat__label">Org allocation</span>
              <strong>{rows.length ? formatWeightPct(total) : '100%'}</strong>
            </div>
            <div className="dept-stat">
              <Sparkles size={16} />
              <span className="dept-stat__label">Equal share each</span>
              <strong>{rows.length ? equalShare : '100%'}</strong>
            </div>
            <div className="dept-stat">
              <CheckCircle2 size={16} />
              <span className="dept-stat__label">KPI metrics</span>
              <strong>{totalIndicators}</strong>
            </div>
          </div>
        </header>
      )}

      {msg && (
        <div
          className={`dept-alert ${isToastError(msg) ? 'dept-alert--error' : 'dept-alert--success'}`}
          role="alert"
        >
          {isToastError(msg) ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          <span>{msg}</span>
          <button type="button" className="dept-alert__dismiss" onClick={() => setMsg('')} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {!managerMode && (
        <section className="dept-add-card glass-panel" aria-label="Add department">
          <h3>Add department</h3>
          <p>
            New departments get default KPI metrics and an equal org weight. No manual percentage setup required.
          </p>
          <div className="dept-add-card__row">
            <input
              type="text"
              placeholder="e.g. Finance, Sales & Marketing…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), void addDepartment())}
              disabled={adding || busy}
              aria-label="Department name"
            />
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void addDepartment()}
              disabled={adding || busy || !newName.trim()}
            >
              {adding ? <Loader2 size={16} className="spin-icon" /> : <Plus size={16} />}
              Add department
            </button>
          </div>
        </section>
      )}

      <div className="attendance-card dept-list-card">
        <div className="dept-list-card__head">
          <div>
            <h3 className="attendance-card__title">
              <Building2 size={18} /> {managerMode ? 'Your department' : 'Organization structure'}
            </h3>
            <p className="attendance-card__subtitle">
              Org weight is managed automatically. Customize KPI metrics inside each department card below.
            </p>
          </div>
        </div>

        {!managerMode && rows.length > 0 && (
          <>
            <div className="dept-allocation-bar" aria-label="Organization weight allocation">
              {rows.map((r) => (
                <div
                  key={r.id}
                  className="dept-allocation-bar__segment"
                  style={{ flex: Number(r.org_weight_pct) || 1 }}
                  title={`${r.name}: ${formatWeightPct(r.org_weight_pct)}`}
                >
                  <span>{r.name}</span>
                  <strong>{formatWeightPct(r.org_weight_pct)}</strong>
                </div>
              ))}
            </div>
            <div className="dept-weight-total dept-weight-total--auto" data-valid={valid}>
              <span>{rows.length} department{rows.length !== 1 ? 's' : ''} · equal auto-split</span>
              <strong>{formatWeightPct(total)}</strong>
            </div>
          </>
        )}

        {!managerMode && (
          <div className="dept-weight-info">
            <Sparkles size={16} />
            <span>
              Deleting a department permanently removes it from the database and redistributes 100% equally among
              remaining departments. Reassign users under <strong>Users</strong> before deleting.
            </span>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="dept-empty-state">
            <Building2 size={40} strokeWidth={1.25} />
            <h4>No departments yet</h4>
            <p>Add your first department above. It will receive 100% org weight automatically.</p>
          </div>
        ) : (
          <div className="dept-cards-grid">
            {rows.map((r) => (
              <article key={r.id} id={`dept-card-${r.id}`} className="dept-card glass-panel">
                <div className="dept-card__head">
                  <div className="dept-card__identity">
                    <span className="dept-card__badge">
                      <CheckCircle2 size={12} /> Active
                    </span>
                    <h4>{r.name}</h4>
                    <span className="dept-card__meta">
                      Org share <strong>{formatWeightPct(r.org_weight_pct)}</strong> (auto)
                      {(r.indicator_count ?? 0) > 0 && ` · ${r.indicator_count} KPI${(r.indicator_count ?? 0) !== 1 ? 's' : ''}`}
                    </span>
                  </div>

                  <div className="dept-card__actions">
                    {!managerMode && (
                      <>
                        <span className="dept-org-badge">{formatWeightPct(r.org_weight_pct)}</span>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm dept-delete-btn"
                          onClick={() => void removeRow(r)}
                          disabled={busy || adding}
                          title={`Delete ${r.name}`}
                        >
                          <Trash2 size={14} />
                          <span>Delete</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
                <DepartmentKpiIndicatorsEditor departmentId={r.id} departmentName={r.name} defaultOpen={rows.length <= 2} />
              </article>
            ))}
          </div>
        )}
      </div>

      {!managerMode && (
        <section className="dept-templates-section">
          <button
            type="button"
            className="dept-templates-toggle"
            onClick={() => setShowTemplates((v) => !v)}
            aria-expanded={showTemplates}
          >
            <span>KPI board templates (reference)</span>
            <ChevronDown size={18} className={showTemplates ? 'dept-templates-toggle__chev--open' : ''} />
          </button>
          {showTemplates && (
            <div className="dept-templates-body">
              <p className="dept-templates-hint">
                Example KPI layouts by function. Live departments use the default 4-metric board unless customized.
              </p>
              <KpiBoardReferencePanel />
            </div>
          )}
        </section>
      )}
    </div>
  );
}
