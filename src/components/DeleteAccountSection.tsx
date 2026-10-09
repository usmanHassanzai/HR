import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Trash2 } from 'lucide-react';
import { supabase } from '../lib/supabase';
import PasswordField from './PasswordField';

export type AccountDeletionInfo = {
  user_id: string;
  email?: string | null;
  full_name?: string | null;
  role?: string | null;
  is_demo?: boolean;
  is_platform_owner?: boolean;
  company_id?: string | null;
  company_name?: string | null;
  company_slug?: string | null;
  is_company_owner?: boolean;
  member_count?: number;
  other_members?: number;
  is_walfia_default?: boolean;
};

type DeleteAccountSectionProps = {
  /** Called after successful deletion (sign-out + redirect handled by parent if provided). */
  onDeleted?: () => void;
  /** Compact layout for embedding on the public /delete-account page. */
  embedded?: boolean;
};

async function invokeDeleteAccount(body: Record<string, unknown>) {
  const { data, error: invokeErr } = await supabase.functions.invoke('delete_account', { body });
  if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
    throw new Error(String((data as { error: string }).error));
  }
  if (invokeErr) {
    const ctx = invokeErr as { context?: Response; message?: string };
    try {
      const parsed = ctx.context ? await ctx.context.json() : null;
      if (parsed?.error) throw new Error(String(parsed.error));
    } catch (e) {
      if (e instanceof Error && e.message !== invokeErr.message) throw e;
    }
    throw new Error(invokeErr.message || 'Request failed.');
  }
  return data as { ok?: boolean; info?: AccountDeletionInfo; result?: unknown };
}

export default function DeleteAccountSection({ onDeleted, embedded }: DeleteAccountSectionProps) {
  const [info, setInfo] = useState<AccountDeletionInfo | null>(null);
  const [loadingInfo, setLoadingInfo] = useState(true);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmText, setConfirmText] = useState('');
  const [deleteCompany, setDeleteCompany] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const loadInfo = useCallback(async () => {
    setLoadingInfo(true);
    setError('');
    try {
      const res = await invokeDeleteAccount({ action: 'preview' });
      setInfo(res.info ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load account details.');
      setInfo(null);
    } finally {
      setLoadingInfo(false);
    }
  }, []);

  useEffect(() => {
    void loadInfo();
  }, [loadInfo]);

  const blocked =
    Boolean(info?.is_platform_owner) ||
    Boolean(info?.is_demo) ||
    (Boolean(info?.is_company_owner) && Boolean(info?.is_walfia_default) && (info?.other_members ?? 0) > 0);

  const ownerNeedsCompanyWipe =
    Boolean(info?.is_company_owner) && (info?.other_members ?? 0) > 0;

  const canSubmit =
    !blocked &&
    password.length > 0 &&
    confirmText.trim().toUpperCase() === 'DELETE' &&
    (!ownerNeedsCompanyWipe || deleteCompany);

  const handleDelete = async () => {
    setBusy(true);
    setError('');
    try {
      await invokeDeleteAccount({
        action: 'delete',
        password,
        confirmText,
        deleteCompany: ownerNeedsCompanyWipe ? true : deleteCompany || (info?.is_company_owner && (info?.other_members ?? 0) === 0),
      });
      try {
        await supabase.auth.signOut();
      } catch {
        /* session may already be invalid */
      }
      if (onDeleted) {
        onDeleted();
      } else {
        window.location.assign('/');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete account.');
    } finally {
      setBusy(false);
    }
  };

  if (loadingInfo) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: '1rem' }}>
        <Loader2 className="spin-icon" size={22} />
      </div>
    );
  }

  return (
    <div
      className="app-settings-block"
      style={{
        marginTop: embedded ? 0 : '1.25rem',
        marginBottom: embedded ? 0 : '1rem',
        borderColor: 'color-mix(in srgb, var(--color-danger) 35%, var(--border-color))',
        background: 'color-mix(in srgb, var(--color-danger) 6%, transparent)',
      }}
    >
      <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.45rem', margin: '0 0 0.5rem', color: 'var(--color-danger)' }}>
        <Trash2 size={18} /> Delete my account
      </h3>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: 'var(--text-secondary)', lineHeight: 1.45 }}>
        Permanently deletes your Scorr login and personal data (attendance, KPIs, rewards activity tied to you).
        This cannot be undone.
      </p>

      {info?.is_company_owner && (
        <div
          style={{
            display: 'flex',
            gap: '0.55rem',
            padding: '0.75rem 0.85rem',
            marginBottom: '0.85rem',
            borderRadius: 'var(--border-radius-sm)',
            background: 'var(--color-danger-bg)',
            color: 'var(--color-danger)',
            fontSize: '0.82rem',
            lineHeight: 1.45,
          }}
        >
          <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2 }} />
          <div>
            <strong>You are the owner of {info.company_name || 'this company'}.</strong>
            {(info.other_members ?? 0) > 0 ? (
              <p style={{ margin: '0.35rem 0 0' }}>
                Deleting only your login will leave the company without an owner and is blocked while{' '}
                <strong>{info.other_members}</strong> other member{(info.other_members ?? 0) === 1 ? '' : 's'} remain.
                Either transfer ownership to another admin first, or confirm deleting the{' '}
                <strong>entire company</strong> — including all employees, attendance, KPIs, and rewards data.
              </p>
            ) : (
              <p style={{ margin: '0.35rem 0 0' }}>
                You are the only member. Deleting your account will also permanently remove the company
                {' '}({info.company_name}) and its data.
              </p>
            )}
          </div>
        </div>
      )}

      {blocked && (
        <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', margin: '0 0 0.75rem' }}>
          {info?.is_platform_owner
            ? 'Platform owner accounts cannot be self-deleted.'
            : info?.is_demo
              ? 'Demo sandbox accounts cannot be deleted here.'
              : 'This organization cannot be wiped from Settings. Contact support.'}
        </p>
      )}

      {!open ? (
        <button
          type="button"
          className="btn btn-secondary"
          style={{ color: 'var(--color-danger)', borderColor: 'color-mix(in srgb, var(--color-danger) 40%, var(--border-color))' }}
          disabled={blocked}
          onClick={() => setOpen(true)}
        >
          <Trash2 size={16} /> Continue to delete…
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {ownerNeedsCompanyWipe && (
            <label style={{ display: 'flex', gap: '0.55rem', alignItems: 'flex-start', fontSize: '0.85rem', lineHeight: 1.45 }}>
              <input
                type="checkbox"
                checked={deleteCompany}
                onChange={(e) => setDeleteCompany(e.target.checked)}
                style={{ marginTop: 3 }}
              />
              <span>
                I understand this will <strong>permanently delete {info?.company_name || 'the company'}</strong> and
                all employee accounts and data in it.
              </span>
            </label>
          )}

          <div>
            <label className="form-label">Type DELETE to confirm</label>
            <input
              className="form-input"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div>
            <label className="form-label">Account password</label>
            <PasswordField
              className="form-input"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div style={{ padding: '0.65rem 0.85rem', background: 'var(--color-danger-bg)', color: 'var(--color-danger)', borderRadius: 'var(--border-radius-sm)', fontSize: '0.82rem' }}>
              {error}
            </div>
          )}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.55rem' }}>
            <button
              type="button"
              className="btn btn-danger"
              disabled={busy || !canSubmit}
              onClick={() => void handleDelete()}
            >
              {busy ? <Loader2 size={16} className="spin-icon" /> : <Trash2 size={16} />}
              {ownerNeedsCompanyWipe ? 'Delete company & my account' : 'Permanently delete my account'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={busy}
              onClick={() => {
                setOpen(false);
                setPassword('');
                setConfirmText('');
                setDeleteCompany(false);
                setError('');
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
