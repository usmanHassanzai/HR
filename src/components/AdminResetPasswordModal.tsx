import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { KeyRound, Eye, EyeOff, Loader2, CheckCircle, X } from 'lucide-react';

interface AdminResetPasswordModalProps {
  userId: string;
  userName: string;
  onClose: () => void;
}

export default function AdminResetPasswordModal({ userId, userName, onClose }: AdminResetPasswordModalProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }

    setLoading(true);
    try {
      const { error: rpcErr } = await supabase.rpc('reset_user_password_admin', {
        p_user_id: userId,
        p_new_password: password,
      });
      if (rpcErr) throw rpcErr;
      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Failed to reset password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" style={{ backdropFilter: 'blur(4px)' }}>
      <div className="glass-panel modal-panel" style={{ maxWidth: 400 }}>
        <button onClick={onClose} style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={18} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.5rem' }}>
          <div style={{ background: 'var(--accent-gradient)', width: 36, height: 36, borderRadius: 'var(--border-radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <KeyRound size={16} color="white" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.05rem' }}>Reset Password</h3>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>Setting new password for <strong>{userName}</strong></p>
          </div>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <CheckCircle size={42} style={{ color: 'var(--color-success)', marginBottom: '0.75rem' }} />
            <h4 style={{ marginBottom: '0.5rem' }}>Password Reset!</h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>
              <strong>{userName}</strong>'s password has been updated. Share the new password with them securely.
            </p>
            <button className="btn btn-primary" onClick={onClose} style={{ width: '100%' }}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ margin: 0 }}>
              <label>New Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={show ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  required
                  style={{ paddingRight: '2.5rem', width: '100%' }}
                />
                <button type="button" onClick={() => setShow(!show)}
                  style={{ position: 'absolute', right: '0.7rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  {show ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            <div className="form-group" style={{ margin: 0 }}>
              <label>Confirm New Password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat new password"
                required
                style={{ borderColor: confirm && confirm !== password ? 'var(--color-danger)' : '' }}
              />
              {confirm && confirm !== password && (
                <span style={{ fontSize: '0.72rem', color: 'var(--color-danger)', marginTop: '0.2rem', display: 'block' }}>Passwords do not match</span>
              )}
            </div>

            {error && (
              <div style={{ padding: '0.65rem 0.85rem', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', borderRadius: 'var(--border-radius-sm)', fontSize: '0.82rem' }}>
                {error}
              </div>
            )}

            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%' }}>
              {loading ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Resetting...</> : 'Reset Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
