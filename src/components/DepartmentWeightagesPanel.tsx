import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
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
import {
  Department,
  clampDeptOrgWeight,
  formatWeightPct,
} from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import DepartmentKpiIndicatorsEditor from './DepartmentKpiIndicatorsEditor';
import KpiBoardReferencePanel from './KpiBoardReferencePanel';

function isToastError(message: string): boolean {
  return /failed|error|must|cannot|reassign|could not find|not found|already exists|enter a|exception|only company admin/i.test(
    message,
  );
}

function safeWeight(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

class DeptPanelErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Departments panel crashed', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="dept-alert dept-alert--error" role="alert">
          <AlertCircle size={18} />
          <span>Departments could not be displayed. {this.state.error.message}</span>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => this.setState({ error: null })}>
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function DepartmentWeightagesPanelInner({ managerMode = false }: { managerMode?: boolean }) {
  const [rows, setRows] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [msg, setMsg] = useState('');
  const [newName, setNewName] = useState('');
  const [showTemplates, setShowTemplates] = useState(false);
  const [orgDraft, setOrgDraft] = useState<Record<string, number>>({});
  const [savingOrg, setSavingOrg] = useState(false);
  const [weightMode, setWeightMode] = useState<'manual' | 'full'>('full');
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showMessage = useCallback((text: string) => {
    setMsg(text);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    if (text && !isToastError(text)) {
      msgTimer.current = setTimeout(() => setMsg(''), 5000);
    }
  }, []);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    if (!opts?.silent) setMsg('');
    try {
      const { data, error } = await supabase.rpc('get_departments');
      if (error) {
        showMessage(error.message);
        setRows([]);
        setOrgDraft({});
        return;
      }
      const list = Array.isArray(data) ? (data as Department[]) : [];
      setRows(list);
      setOrgDraft(Object.fromEntries(list.map((d) => [d.id, safeWeight(d.org_weight_pct)])));
      const allFull =
        list.length > 0 && list.every((d) => Math.abs(safeWeight(d.org_weight_pct) - 100) <= 0.05);
      setWeightMode(allFull ? 'full' : 'manual');
    } catch (err) {
      showMessage(err instanceof Error ? err.message : 'Could not load departments.');
      setRows([]);
      setOrgDraft({});
    } finally {
      setLoading(false);
    }
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
    () => { void load({ silent: true }); },
  );

  const totalIndicators = rows.reduce((n, r) => n + (r.indicator_count ?? 0), 0);
  const orgDraftRows = rows.map((r) => ({ ...r, org_weight_pct: safeWeight(orgDraft[r.id] ?? r.org_weight_pct) }));
  const orgDirty = rows.some((r) => Number(orgDraft[r.id] ?? r.org_weight_pct) !== Number(r.org_weight_pct));
  const orgInvalid = orgDraftRows.some((r) => {
    const w = Number(r.org_weight_pct);
    return !Number.isFinite(w) || w < 0 || w > 100.05;
  });
  const allAt100 =
    orgDraftRows.length > 0 &&
    orgDraftRows.every((r) => Math.abs(Number(r.org_weight_pct) - 100) <= 0.05);
  const at100Count = orgDraftRows.filter((r) => Math.abs(Number(r.org_weight_pct) - 100) <= 0.05).length;

  const persistOrgWeights = async (items: { id: string; org_weight_pct: number }[], successMsg: string) => {
    setSavingOrg(true);
    const { error } = await supabase.rpc('save_department_org_weights', {
      p_items: items,
    });
    setSavingOrg(false);
    if (error) showMessage(error.message);
    else {
      showMessage(successMsg);
      await load({ silent: true });
    }
  };

  const saveOrgWeights = async () => {
    if (orgInvalid) {
      showMessage('Each department weight must be between 0 and 100%.');
      return;
    }
    await persistOrgWeights(
      orgDraftRows.map((r) => ({ id: r.id, org_weight_pct: Number(r.org_weight_pct) })),
      'Department organization weightages saved.',
    );
  };

  const setDeptWeight = (id: string, raw: number) => {
    const next = clampDeptOrgWeight(raw);
    setOrgDraft((prev) => {
      const draft = { ...prev, [id]: next };
      const allFull = rows.every((r) => Math.abs(Number(draft[r.id] ?? r.org_weight_pct) - 100) <= 0.05);
      setWeightMode(allFull ? 'full' : 'manual');
      return draft;
    });
  };

  const setAllTo100 = async () => {
    if (rows.length === 0) return;
    const next = Object.fromEntries(rows.map((r) => [r.id, 100]));
    const alreadyFull = rows.every(
      (r) =>
        Math.abs(Number(r.org_weight_pct) - 100) <= 0.05 &&
        Math.abs(Number(orgDraft[r.id] ?? r.org_weight_pct) - 100) <= 0.05,
    );
    setOrgDraft(next);
    setWeightMode('full');
    if (alreadyFull) {
      showMessage('Every department is already at 100%.');
      return;
    }
    await persistOrgWeights(
      rows.map((r) => ({ id: r.id, org_weight_pct: 100 })),
      `Set all ${rows.length} departments to 100%.`,
    );
  };

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
    showMessage(`"${name}" added with 100% organization weight.`);
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
        `Permanently delete "${row.name}"?\n\nThis removes the department and its KPI board from the database. Other departments keep their weightages. Reassign any users in this department under Users first.`,
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
      showMessage(`"${row.name}" permanently deleted.`);
      await load();
    }
  };

  if (loading && rows.length === 0) {
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
                Each department defaults to 100% organization weight. You can still assign weights manually.
                Below, edit each department’s monthly KPI board and KPI weightages.
              </p>
            </div>
          </div>

          <div className="dept-page-stats">
            <div className="dept-stat">
              <Layers size={16} />
              <span className="dept-stat__label">Departments</span>
              <strong>{rows.length}</strong>
            </div>
            <div className="dept-stat" data-valid={allAt100 || rows.length === 0}>
              <Scale size={16} />
              <span className="dept-stat__label">At 100%</span>
              <strong>{rows.length ? `${at100Count}/${rows.length}` : '—'}</strong>
            </div>
            <div className="dept-stat" data-valid={true}>
              <Sparkles size={16} />
              <span className="dept-stat__label">Default</span>
              <strong>100%</strong>
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
            New departments get 100% organization weight and a default 4-metric KPI board. You can change weightage manually below.
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

      {!managerMode && rows.length > 0 && (
        <section className="dept-org-editor glass-panel" aria-label="Organization weightage">
          <div className="dept-org-editor__head">
            <div>
              <h3>Organization weightage</h3>
              <p>
                Every department starts at 100%. Use Set all to 100%, or Assign manually to enter a custom weight
                (0–100%) for each department.
              </p>
            </div>
            <div className="dept-org-editor__modes" role="group" aria-label="Weightage mode">
              <button
                type="button"
                className={`dept-org-editor__mode${weightMode === 'manual' ? ' dept-org-editor__mode--active' : ''}`}
                onClick={() => setWeightMode('manual')}
                disabled={savingOrg || busy}
              >
                <Layers size={15} />
                Assign manually
              </button>
              <button
                type="button"
                className={`dept-org-editor__mode${weightMode === 'full' ? ' dept-org-editor__mode--active' : ''}`}
                onClick={() => void setAllTo100()}
                disabled={savingOrg || busy}
              >
                {savingOrg && weightMode === 'full' ? <Loader2 size={15} className="spin-icon" /> : <Scale size={15} />}
                Set all to 100%
              </button>
            </div>
          </div>

          <div
            className="dept-org-editor__meter"
            data-valid={allAt100 && !orgInvalid}
            data-over={orgInvalid}
          >
            <div className="dept-org-editor__meter-track" aria-hidden="true">
              <div
                className="dept-org-editor__meter-fill"
                style={{
                  width: `${rows.length ? Math.min(100, Math.round((at100Count / rows.length) * 100)) : 0}%`,
                }}
              />
            </div>
            <div className="dept-org-editor__meter-meta">
              <strong>
                {at100Count}
                <span> / {rows.length} at 100%</span>
              </strong>
              <span>
                {orgInvalid
                  ? 'Each weight must be between 0 and 100%'
                  : orgDirty
                    ? 'Ready to save'
                    : allAt100
                      ? 'Saved — each department is 100%'
                      : 'Manual weights saved'}
              </span>
            </div>
          </div>

          <ul className="dept-org-editor__list">
            {orgDraftRows.map((r) => (
              <li key={r.id} className="dept-org-editor__row">
                <div className="dept-org-editor__name">
                  <strong>{r.name}</strong>
                  <span>Max 100%</span>
                </div>
                <label className="dept-org-editor__input">
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step={0.5}
                    inputMode="decimal"
                    value={safeWeight(orgDraft[r.id] ?? r.org_weight_pct)}
                    onChange={(e) => setDeptWeight(r.id, e.target.value === '' ? 0 : Number(e.target.value))}
                    disabled={busy || savingOrg}
                    aria-label={`${r.name} organization weight percent`}
                  />
                  <span>%</span>
                </label>
              </li>
            ))}
          </ul>

          <div className="dept-org-editor__footer">
            <p>
              {orgInvalid
                ? 'Fix any weight outside 0–100% before saving.'
                : allAt100
                  ? 'Every department contributes 100%. Edit any box to assign a custom weight.'
                  : 'Manual weights are per department (each 0–100%). New departments still start at 100%.'}
            </p>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void saveOrgWeights()}
              disabled={savingOrg || busy || orgInvalid || !orgDirty}
            >
              {savingOrg && weightMode === 'manual' ? <Loader2 size={16} className="spin-icon" /> : null}
              Save weightage
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
              Open a department to edit its monthly KPI board. Organization weightage is set above.
            </p>
          </div>
        </div>

        {!managerMode && (
          <div className="dept-weight-info">
            <Sparkles size={16} />
            <span>
              Deleting a department permanently removes it from the database. Other departments keep their
              weightages. Reassign users under <strong>Users</strong> before deleting.
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
                      {(r.indicator_count ?? 0) > 0
                        ? `${r.indicator_count} KPI${(r.indicator_count ?? 0) !== 1 ? 's' : ''}`
                        : 'No KPIs yet'}
                    </span>
                  </div>

                  <div className="dept-card__actions">
                    <span className="dept-org-badge" title="Organization weightage">
                      {formatWeightPct(safeWeight(orgDraft[r.id] ?? r.org_weight_pct))}
                    </span>
                    {!managerMode && (
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
                    )}
                  </div>
                </div>
                <DepartmentKpiIndicatorsEditor
                  departmentId={r.id}
                  departmentName={r.name}
                  defaultOpen={false}
                  allowEdit
                />
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
            <span>Department-wise monthly KPI board (all departments)</span>
            <ChevronDown size={18} className={showTemplates ? 'dept-templates-toggle__chev--open' : ''} />
          </button>
          {showTemplates && (
            <div className="dept-templates-body">
              <p className="dept-templates-hint">
                All registered departments are listed. Edit KPI libraries on each board — you can add as many KPIs as you need. The 100% cap applies only when assigning to an employee.
                You can also apply a Finance / Sales / HR / Operations example layout.
              </p>
              <KpiBoardReferencePanel allowEdit />
            </div>
          )}
        </section>
      )}
    </div>
  );
}

export default function DepartmentWeightagesPanel(props: { managerMode?: boolean }) {
  return (
    <DeptPanelErrorBoundary>
      <DepartmentWeightagesPanelInner {...props} />
    </DeptPanelErrorBoundary>
  );
}
