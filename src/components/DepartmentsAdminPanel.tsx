import { useEffect, useState } from 'react';
import { Building2, Loader2, Plus, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Department } from '../utils/departmentHelpers';
import { useSupabaseRealtime } from '../utils/useSupabaseRealtime';
import '../styles/departments.css';

export default function DepartmentsAdminPanel() {
  const [rows, setRows] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [msg, setMsg] = useState('');

  const load = async () => {
    const { data, error } = await supabase.rpc('get_departments');
    if (error) setMsg(error.message);
    else setRows((data as Department[]) || []);
    setLoading(false);
  };

  useEffect(() => {
    void load();
  }, []);

  useSupabaseRealtime('departments-admin', [{ table: 'departments' }], () => {
    void load();
  });

  const addDepartment = async () => {
    const name = newName.trim();
    if (!name) {
      setMsg('Enter a department name.');
      return;
    }
    setAdding(true);
    setMsg('');
    const { error } = await supabase.rpc('create_department_admin', { p_name: name });
    setAdding(false);
    if (error) {
      setMsg(error.message);
      return;
    }
    setNewName('');
    setMsg(`"${name}" added.`);
    await load();
  };

  const removeRow = async (row: Department) => {
    if (
      !confirm(
        `Delete "${row.name}"?\n\nReassign people in this department under Users first. Individual KPIs are not deleted.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setMsg('');
    const { error } = await supabase.rpc('delete_department_admin', { p_department_id: row.id });
    setBusy(false);
    if (error) setMsg(error.message);
    else {
      setMsg(`"${row.name}" deleted.`);
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
      <header className="dept-page-header glass-panel">
        <div className="dept-page-header__main">
          <div className="dept-page-header__icon">
            <Building2 size={22} />
          </div>
          <div>
            <h2 className="dept-page-header__title">Departments</h2>
            <p className="dept-page-header__subtitle">
              Organization structure only. KPIs and scores belong to each person, not to a department.
            </p>
          </div>
        </div>
      </header>

      {msg && <p className="dept-page-msg">{msg}</p>}

      <div className="dept-add-row glass-panel">
        <input
          className="form-input"
          placeholder="New department name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void addDepartment();
          }}
        />
        <button type="button" className="btn btn-primary" disabled={adding} onClick={() => void addDepartment()}>
          {adding ? <Loader2 size={16} className="spin-icon" /> : <Plus size={16} />}
          Add
        </button>
      </div>

      <ul className="dept-simple-list">
        {rows.map((row) => (
          <li key={row.id} className="dept-simple-list__item glass-panel">
            <div>
              <strong>{row.name}</strong>
              <span>{row.active_kpi_count ?? 0} open individual KPIs tagged to people in this group</span>
            </div>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => void removeRow(row)}>
              <Trash2 size={14} /> Delete
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
