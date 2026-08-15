import { useMemo, useState } from 'react';
import { Pencil, Loader2, CheckCircle, X, AlertCircle } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Profile, UserRole } from '../utils/kpiHelpers';
import { Department } from '../utils/departmentHelpers';

interface AdminEditUserModalProps {
  user: Profile;
  currentAdminId: string;
  departments: Department[];
  allUsers: Profile[];
  onClose: () => void;
  onSaved: () => void;
}

function supervisorLabel(m: Profile, departments: Department[]): string {
  const dept = departments.find((d) => d.id === m.department_id)?.name;
  if (m.role === 'admin') return `${m.full_name} — Admin`;
  if (dept) return `${m.full_name} — Manager · ${dept}`;
  return `${m.full_name} — Manager`;
}

export default function AdminEditUserModal({
  user,
  currentAdminId,
  departments,
  allUsers,
  onClose,
  onSaved,
}: AdminEditUserModalProps) {
  const [fullName, setFullName] = useState(user.full_name);
  const [role, setRole] = useState<UserRole>(user.role);
  const [departmentId, setDepartmentId] = useState(user.department_id ?? '');
  const [managerId, setManagerId] = useState(user.manager_id ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const isSelf = user.id === currentAdminId;

  const supervisors = useMemo(() => {
    const list = allUsers
      .filter((m) => (m.role === 'manager' || m.role === 'admin') && m.id !== user.id)
      .sort((a, b) => {
        if (a.role === b.role) return a.full_name.localeCompare(b.full_name);
        return a.role === 'admin' ? -1 : 1;
      });
    return list;
  }, [allUsers, user.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    const name = fullName.trim();
    if (!name) {
      setError('Full name is required.');
      return;
    }
    if (role !== 'admin' && !departmentId) {
      setError('Select a department for managers and employees.');
      return;
    }
    if (isSelf && role !== 'admin') {
      setError('You cannot remove your own admin role.');
      return;
    }

    setLoading(true);
    try {
      const { error: updateError } = await supabase.rpc('admin_update_user_account', {
        p_user_id: user.id,
        p_full_name: name,
        p_role: role,
        p_department_id: role === 'admin' ? null : departmentId || null,
        p_manager_id: role === 'admin' ? null : managerId || null,
      });
      if (updateError) throw updateError;

      setSuccess(true);
      onSaved();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to update user.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" style={{ backdropFilter: 'blur(4px)' }}>
      <div className="glass-panel modal-panel" style={{ maxWidth: 460 }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            position: 'absolute',
            top: '1rem',
            right: '1rem',
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
          }}
          aria-label="Close"
        >
          <X size={18} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.25rem' }}>
          <div
            style={{
              background: 'var(--accent-gradient)',
              width: 36,
              height: 36,
              borderRadius: 'var(--border-radius-sm)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Pencil size={16} color="white" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Edit user account</h3>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>
              Update profile for <strong>{user.email}</strong>
            </p>
          </div>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <CheckCircle size={42} style={{ color: 'var(--color-success)', marginBottom: '0.75rem' }} />
            <h4 style={{ marginBottom: '0.5rem' }}>Account updated</h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              Changes for <strong>{fullName.trim() || user.full_name}</strong> are saved.
            </p>
            <button type="button" className="btn btn-primary" onClick={onClose} style={{ width: '100%' }}>
              Done
            </button>
          </div>
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} style={{ display: 'flex', flexDirection: 'column', gap: '0.9rem' }}>
            {error && (
              <div
                style={{
                  display: 'flex',
                  gap: '0.45rem',
                  alignItems: 'flex-start',
                  color: 'var(--color-danger)',
                  fontSize: '0.85rem',
                }}
              >
                <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
                <span>{error}</span>
              </div>
            )}

            <div className="form-group" style={{ margin: 0 }}>
              <label>Email</label>
              <input className="input-field" type="email" value={user.email} disabled readOnly />
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Login email cannot be changed here. Reset password from the users list if needed.
              </span>
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label>Full name *</label>
              <input
                className="input-field"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                required
                placeholder="Full name"
              />
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label>System role *</label>
              <select
                className="input-field"
                value={role}
                onChange={(e) => {
                  const next = e.target.value as UserRole;
                  setRole(next);
                  if (next === 'admin') {
                    setDepartmentId('');
                    setManagerId('');
                  }
                }}
                disabled={isSelf}
              >
                <option value="employee">Employee</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </select>
              {isSelf && (
                <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  You cannot change your own role.
                </span>
              )}
            </div>

            {role !== 'admin' && (
              <div className="form-group" style={{ margin: 0 }}>
                <label>{role === 'manager' ? 'Department *' : 'Department *'}</label>
                <select
                  className="input-field"
                  value={departmentId}
                  onChange={(e) => setDepartmentId(e.target.value)}
                  required
                >
                  <option value="">— Select department —</option>
                  {departments.map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {(role === 'employee' || role === 'manager') && (
              <div className="form-group" style={{ margin: 0 }}>
                <label>Assign manager / admin</label>
                <select className="input-field" value={managerId} onChange={(e) => setManagerId(e.target.value)}>
                  <option value="">— None —</option>
                  {supervisors.filter((m) => m.role === 'admin').length > 0 && (
                    <optgroup label="Admins">
                      {supervisors
                        .filter((m) => m.role === 'admin')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {supervisorLabel(m, departments)}
                          </option>
                        ))}
                    </optgroup>
                  )}
                  {supervisors.filter((m) => m.role === 'manager').length > 0 && (
                    <optgroup label="Managers">
                      {supervisors
                        .filter((m) => m.role === 'manager')
                        .map((m) => (
                          <option key={m.id} value={m.id}>
                            {supervisorLabel(m, departments)}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </select>
              </div>
            )}

            <div style={{ display: 'flex', gap: '0.5rem', marginTop: '0.35rem' }}>
              <button type="button" className="btn btn-secondary" onClick={onClose} style={{ flex: 1 }} disabled={loading}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" style={{ flex: 1 }} disabled={loading}>
                {loading ? <Loader2 size={16} className="spin-icon" /> : 'Save changes'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
