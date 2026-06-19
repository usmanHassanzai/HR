import { useState } from 'react';
import { supabase } from '../lib/supabase';
import { Lock, Eye, EyeOff, Loader2, CheckCircle, X } from 'lucide-react';

interface ChangePasswordModalProps {
  onClose: () => void;
}

export default function ChangePasswordModal({ onClose }: ChangePasswordModalProps) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showCurrent, setShowCurrent] = useState(false);
  const [showNext, setShowNext] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  const strength = (pw: string) => {
    let s = 0;
    if (pw.length >= 8) s++;
    if (/[A-Z]/.test(pw)) s++;
    if (/[0-9]/.test(pw)) s++;
    if (/[^a-zA-Z0-9]/.test(pw)) s++;
    return s;
  };

  const strengthLabel = ['', 'Weak', 'Fair', 'Good', 'Strong'];
  const strengthColor = ['', 'var(--color-danger)', 'var(--color-warning)', 'var(--accent-secondary)', 'var(--color-success)'];
  const s = strength(next);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 6) { setError('New password must be at least 6 characters.'); return; }
    if (next !== confirm) { setError('Passwords do not match.'); return; }

    setLoading(true);
    try {
      // Re-authenticate to verify current password before changing
      const { data: { user } } = await supabase.auth.getUser();
      if (!user?.email) throw new Error('No authenticated user.');

      const { error: signInErr } = await supabase.auth.signInWithPassword({
        email: user.email,
        password: current,
      });
      if (signInErr) { setError('Current password is incorrect.'); return; }

      // Update password
      const { error: updateErr } = await supabase.auth.updateUser({ password: next });
      if (updateErr) throw updateErr;

      setSuccess(true);
    } catch (err: any) {
      setError(err.message || 'Failed to update password.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" style={{ backdropFilter: 'blur(4px)' }}>
      <div className="glass-panel modal-panel">
        {/* Close */}
        <button onClick={onClose} style={{ position: 'absolute', top: '1rem', right: '1rem', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
          <X size={18} />
        </button>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', marginBottom: '1.5rem' }}>
          <div style={{ background: 'var(--accent-gradient)', width: 36, height: 36, borderRadius: 'var(--border-radius-sm)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <Lock size={16} color="white" />
          </div>
          <div>
            <h3 style={{ margin: 0, fontSize: '1.1rem' }}>Change Password</h3>
            <p style={{ margin: 0, fontSize: '0.78rem', color: 'var(--text-muted)' }}>Update your account password</p>
          </div>
        </div>

        {success ? (
          <div style={{ textAlign: 'center', padding: '1rem 0' }}>
            <CheckCircle size={42} style={{ color: 'var(--color-success)', marginBottom: '0.75rem' }} />
            <h4 style={{ marginBottom: '0.5rem' }}>Password Updated!</h4>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '1.25rem' }}>Your new password is active immediately.</p>
            <button className="btn btn-primary" onClick={onClose} style={{ width: '100%' }}>Done</button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            {/* Current password */}
            <div className="form-group" style={{ margin: 0 }}>
              <label>Current Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showCurrent ? 'text' : 'password'}
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                  placeholder="Enter current password"
                  required
                  style={{ paddingRight: '2.5rem', width: '100%' }}
                />
                <button type="button" onClick={() => setShowCurrent(!showCurrent)}
                  style={{ position: 'absolute', right: '0.7rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  {showCurrent ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {/* New password */}
            <div className="form-group" style={{ margin: 0 }}>
              <label>New Password</label>
              <div style={{ position: 'relative' }}>
                <input
                  type={showNext ? 'text' : 'password'}
                  value={next}
                  onChange={(e) => setNext(e.target.value)}
                  placeholder="Min 6 characters"
                  required
                  style={{ paddingRight: '2.5rem', width: '100%' }}
                />
                <button type="button" onClick={() => setShowNext(!showNext)}
                  style={{ position: 'absolute', right: '0.7rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer' }}>
                  {showNext ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {/* Strength bar */}
              {next && (
                <div style={{ marginTop: '0.4rem' }}>
                  <div style={{ height: 4, borderRadius: 9999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${s * 25}%`, background: strengthColor[s], borderRadius: 9999, transition: 'width 0.3s, background 0.3s' }} />
                  </div>
                  <span style={{ fontSize: '0.7rem', color: strengthColor[s] }}>{strengthLabel[s]}</span>
                </div>
              )}
            </div>

            {/* Confirm */}
            <div className="form-group" style={{ margin: 0 }}>
              <label>Confirm New Password</label>
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Repeat new password"
                required
                style={{ borderColor: confirm && confirm !== next ? 'var(--color-danger)' : '' }}
              />
              {confirm && confirm !== next && (
                <span style={{ fontSize: '0.72rem', color: 'var(--color-danger)', marginTop: '0.2rem', display: 'block' }}>Passwords do not match</span>
              )}
            </div>

            {error && (
              <div style={{ padding: '0.65rem 0.85rem', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', borderRadius: 'var(--border-radius-sm)', fontSize: '0.82rem' }}>
                {error}
              </div>
            )}

            <button className="btn btn-primary" type="submit" disabled={loading} style={{ width: '100%', marginTop: '0.25rem' }}>
              {loading ? <><Loader2 size={15} style={{ animation: 'spin 1s linear infinite' }} /> Updating...</> : 'Update Password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
