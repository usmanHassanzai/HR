import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { fetchMfaRecoveryStatus } from '../utils/mfaRecovery';

/** Banner when unused backup codes are running low. */
export default function BackupCodesLowBanner({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchMfaRecoveryStatus().then((st) => {
      if (cancelled || !st) return;
      if (st.low_codes) setRemaining(st.remaining_codes);
    });
    return () => { cancelled = true; };
  }, []);

  if (remaining == null) return null;

  return (
    <div
      role="status"
      style={{
        display: 'flex',
        gap: '0.65rem',
        alignItems: 'flex-start',
        marginBottom: '1rem',
        padding: '0.85rem 1rem',
        borderRadius: 12,
        border: '1px solid color-mix(in srgb, var(--color-warning) 45%, transparent)',
        background: 'color-mix(in srgb, var(--color-warning) 12%, transparent)',
      }}
    >
      <AlertTriangle size={18} style={{ flexShrink: 0, marginTop: 2, color: 'var(--color-warning)' }} />
      <div style={{ flex: 1, fontSize: '0.88rem', lineHeight: 1.45 }}>
        <strong>You have {remaining} backup code{remaining === 1 ? '' : 's'} left.</strong>
        {' '}
        Regenerate now from Settings → Account security to avoid lockout.
        {onOpenSettings && (
          <>
            {' '}
            <button type="button" className="btn btn-secondary" style={{ padding: '0.2rem 0.55rem', fontSize: '0.8rem' }} onClick={onOpenSettings}>
              Open settings
            </button>
          </>
        )}
      </div>
    </div>
  );
}
